const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ConfigManager = require('../js/config.js');
const NetworkInfo = require('../js/network.js');
const AccessFilter = require('../js/access-filter.js');
const HtpasswdManager = require('../js/htpasswd.js');
const CertManager = require('../js/cert.js');
const RcloneManager = require('../js/rclone.js');
const ServerManager = require('../js/server.js');

// The integration tests need a real rclone. They use EAGLE_SERVE_RCLONE or an
// installed copy; EAGLE_SERVE_TEST_DOWNLOAD_RCLONE=1 downloads one when neither exists.
const RCLONE_CACHE_DIR = path.join(os.tmpdir(), 'eagle-serve-test-bin');

function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.request(url, { method: 'GET', ...options, agent: false }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(options.body);
    });
}

function getFreePort() {
    return new Promise(resolve => {
        const probe = net.createServer();
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

// Smallest possible zip holding one deflated file, for the extractor test
function makeZip(name, data) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const body = zlib.deflateRawSync(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(0, 42);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + nameBuffer.length, 12);
    end.writeUInt32LE(local.length + nameBuffer.length + body.length, 16);

    return Buffer.concat([local, nameBuffer, body, central, nameBuffer, end]);
}

async function findTestRclone() {
    const installed = process.env.EAGLE_SERVE_RCLONE || RcloneManager.find(RCLONE_CACHE_DIR);
    if (installed) return installed;
    if (process.env.EAGLE_SERVE_TEST_DOWNLOAD_RCLONE !== '1') return null;

    console.log('   … downloading rclone for the integration tests');
    const downloaded = await RcloneManager.download(RCLONE_CACHE_DIR);
    return downloaded.path;
}

async function runTests() {
    console.log('--- Running Eagle Serve Tests ---');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-serve-test-'));
    const dataDir = path.join(tempDir, 'data');
    const storageDir = path.join(tempDir, 'library');
    fs.mkdirSync(storageDir);
    ConfigManager.setDataDir(dataDir);

    // 1. Test ConfigManager
    console.log('1. Testing ConfigManager...');
    const defaults = ConfigManager.getConfig();
    assert.strictEqual(defaults.autoStart, true);
    assert.strictEqual(defaults.storageMode, 'library');
    assert.strictEqual(defaults.port, 41599);
    assert.strictEqual(defaults.bindLan, false);
    assert.strictEqual(defaults.bindTailscale, false);
    assert.deepStrictEqual(defaults.allowedClients, ['self']);
    assert.strictEqual(defaults.dirCacheTime, '5s');
    assert.strictEqual(defaults.followSymlinks, true);

    assert.strictEqual(ConfigManager.sanitize({ port: 99999 }).port, 41599, 'Out of bounds port should fall back to default');
    assert.strictEqual(ConfigManager.sanitize({ port: '8080' }).port, 8080);
    assert.strictEqual(ConfigManager.sanitize({ storageMode: 'bogus' }).storageMode, 'library');
    assert.strictEqual(ConfigManager.sanitize({ dirCacheTime: '30' }).dirCacheTime, '30s', 'Bare number means seconds');
    assert.strictEqual(ConfigManager.sanitize({ dirCacheTime: '1m30s' }).dirCacheTime, '1m30s');
    assert.strictEqual(ConfigManager.sanitize({ dirCacheTime: 'soon' }).dirCacheTime, '5s');
    assert.deepStrictEqual(ConfigManager.sanitize({ allowedClients: 'self, 192.168.1.0/24\nmacbook-air' }).allowedClients,
        ['self', '192.168.1.0/24', 'macbook-air']);
    assert.deepStrictEqual(ConfigManager.sanitize({ allowedClients: [] }).allowedClients, ['self']);
    assert.deepStrictEqual(ConfigManager.sanitize({ extraHosts: 'localhost, 127.0.0.1, myhost, myhost' }).extraHosts, ['myhost'],
        'Loopback is always bound, so it is dropped from the extra hosts');

    let notified = null;
    ConfigManager.onConfigChanged(config => { notified = config; });
    const saved = ConfigManager.saveConfig({ port: 41700, bindLan: true });
    assert.strictEqual(saved.port, 41700);
    assert.strictEqual(notified.bindLan, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(ConfigManager.getConfigPath(), 'utf8')).port, 41700);

    // A fresh load reads the file back
    ConfigManager.setDataDir(dataDir);
    assert.strictEqual(ConfigManager.getConfig().port, 41700);
    ConfigManager.saveConfig({ ...ConfigManager.DEFAULT_CONFIG });
    console.log('   ✓ ConfigManager tests passed.');

    // 2. Test NetworkInfo
    console.log('2. Testing NetworkInfo...');
    assert.strictEqual(NetworkInfo.isTailscaleIp('100.123.248.46'), true);
    assert.strictEqual(NetworkInfo.isTailscaleIp('100.63.255.255'), false);
    assert.strictEqual(NetworkInfo.isTailscaleIp('100.128.0.1'), false);
    assert.strictEqual(NetworkInfo.isPrivateIp('192.168.1.5'), true);
    assert.strictEqual(NetworkInfo.isPrivateIp('172.31.0.1'), true);
    assert.strictEqual(NetworkInfo.isPrivateIp('172.32.0.1'), false);
    assert.strictEqual(NetworkInfo.isPrivateIp('8.8.8.8'), false);

    const interfaces = {
        'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        'Wi-Fi': [
            { address: 'fe80::1', family: 'IPv6', internal: false },
            { address: '192.168.1.5', family: 'IPv4', internal: false }
        ],
        'Tailscale': [{ address: '100.123.248.46', family: 'IPv4', internal: false }],
        'vEthernet (WSL)': [{ address: '172.28.0.1', family: 'IPv4', internal: false }]
    };
    const addresses = NetworkInfo.listAddresses(interfaces);
    assert.deepStrictEqual(addresses.map(a => `${a.address}=${a.kind}`),
        ['192.168.1.5=lan', '100.123.248.46=tailscale', '172.28.0.1=other']);

    const bind = overrides => NetworkInfo.resolveBindHosts({ ...ConfigManager.DEFAULT_CONFIG, ...overrides }, addresses);
    assert.deepStrictEqual(bind({}), ['127.0.0.1'], 'Localhost only by default');
    assert.deepStrictEqual(bind({ bindLan: true }), ['127.0.0.1', '192.168.1.5']);
    assert.deepStrictEqual(bind({ bindTailscale: true }), ['127.0.0.1', '100.123.248.46']);
    assert.deepStrictEqual(bind({ bindLan: true, bindTailscale: true, extraHosts: ['172.28.0.1'] }),
        ['127.0.0.1', '192.168.1.5', '100.123.248.46', '172.28.0.1']);
    assert.deepStrictEqual(bind({ bindLan: true, extraHosts: ['0.0.0.0'] }), ['0.0.0.0'], 'The wildcard replaces everything else');
    assert.deepStrictEqual(NetworkInfo.resolveBindHosts({ bindTailscale: true, extraHosts: [] }, []), ['127.0.0.1'],
        'An address that is not present is left out');

    const urls = NetworkInfo.buildUrls(['127.0.0.1', '100.123.248.46'], 41599, true,
        { addresses, tailscaleName: 'desktop.example.ts.net' });
    assert.deepStrictEqual(urls, [
        { url: 'https://127.0.0.1:41599/', label: 'This computer' },
        { url: 'https://100.123.248.46:41599/', label: 'Tailscale' },
        { url: 'https://desktop.example.ts.net:41599/', label: 'Tailscale name' }
    ]);
    console.log('   ✓ NetworkInfo tests passed.');

    // 3. Test AccessFilter rules
    console.log('3. Testing AccessFilter...');
    assert.strictEqual(AccessFilter.normalizeIp('::ffff:192.168.1.5'), '192.168.1.5');
    assert.strictEqual(AccessFilter.normalizeIp('fe80::1%eth0'), 'fe80::1');
    assert.strictEqual(AccessFilter.isLoopback('127.0.0.1'), true);
    assert.strictEqual(AccessFilter.isLoopback('::1'), true);
    assert.strictEqual(AccessFilter.isLoopback('192.168.1.5'), false);

    const allowed = (ip, rules) => AccessFilter.isClientAllowed(ip, rules);
    assert.strictEqual(await allowed('127.0.0.1', ['self']), true);
    assert.strictEqual(await allowed('::ffff:127.0.0.1', ['self']), true);
    const ownAddress = NetworkInfo.listAddresses()[0];
    if (ownAddress) {
        assert.strictEqual(await allowed(ownAddress.address, ['self']), true, '"self" covers every local adapter address');
    }
    assert.strictEqual(await allowed('203.0.113.9', ['self']), false);
    assert.strictEqual(await allowed('::1', ['127.0.0.1']), true, 'Loopback identifiers are equivalent');
    assert.strictEqual(await allowed('127.0.0.1', ['localhost']), true);
    assert.strictEqual(await allowed('192.168.1.42', ['192.168.1.0/24']), true);
    assert.strictEqual(await allowed('192.168.2.42', ['192.168.1.0/24']), false);
    assert.strictEqual(await allowed('100.100.5.5', ['100.64.0.0/10']), true);
    assert.strictEqual(await allowed('10.0.0.7', ['10.0.0.7']), true);
    assert.strictEqual(await allowed('10.0.0.8', ['10.0.0.7']), false);
    assert.strictEqual(await allowed('fd7a:115c:a1e0::1', ['fd7a:115c:a1e0::/48']), true);
    assert.strictEqual(await allowed('fd7a:115c:a1e0::1', ['FD7A:115C:A1E0:0:0:0:0:1']), true);
    assert.strictEqual(await allowed('not-an-ip', ['self']), false);
    assert.strictEqual(await allowed('10.0.0.7', []), false);

    // Hostname rules go through DNS; seed the cache so the test needs no network
    const dnsCache = new Map([
        ['fwd:macbook-air', { expiry: Date.now() + 60000, value: Promise.resolve(new Set(['100.101.102.103'])) }],
        ['rev:100.101.102.103', { expiry: Date.now() + 60000, value: Promise.resolve(new Set()) }],
        ['rev:100.9.9.9', { expiry: Date.now() + 60000, value: Promise.resolve(new Set(['iphone-xr.example.ts.net', 'iphone-xr'])) }],
        ['fwd:iphone-xr', { expiry: Date.now() + 60000, value: Promise.resolve(new Set()) }]
    ]);
    assert.strictEqual(await AccessFilter.isClientAllowed('100.101.102.103', ['macbook-air'], dnsCache), true, 'Forward DNS match');
    assert.strictEqual(await AccessFilter.isClientAllowed('100.9.9.9', ['macbook-air', 'iphone-xr'], dnsCache), true, 'Reverse DNS match');
    dnsCache.set('rev:100.8.8.8', { expiry: Date.now() + 60000, value: Promise.resolve(new Set()) });
    assert.strictEqual(await AccessFilter.isClientAllowed('100.8.8.8', ['macbook-air', 'iphone-xr'], dnsCache), false);
    console.log('   ✓ AccessFilter tests passed.');

    // 4. Test HtpasswdManager
    console.log('4. Testing HtpasswdManager...');
    const htpasswdPath = ConfigManager.getHtpasswdPath();
    assert.deepStrictEqual(HtpasswdManager.listUsers(htpasswdPath), []);
    assert.strictEqual(HtpasswdManager.validateUsername('corey'), null);
    assert.ok(HtpasswdManager.validateUsername(''));
    assert.ok(HtpasswdManager.validateUsername('a:b'));
    assert.ok(HtpasswdManager.validateUsername('a b'));

    assert.strictEqual(await HtpasswdManager.setUser(htpasswdPath, 'corey', 'first-password', 4), false);
    assert.strictEqual(await HtpasswdManager.setUser(htpasswdPath, 'guest', 'guest-password', 4), false);
    assert.strictEqual(await HtpasswdManager.setUser(htpasswdPath, 'corey', 'correct horse', 4), true, 'Existing user is updated');
    assert.deepStrictEqual(HtpasswdManager.listUsers(htpasswdPath), ['corey', 'guest']);

    const htpasswdText = fs.readFileSync(htpasswdPath, 'utf8');
    assert.match(htpasswdText, /^corey:\$2[aby]\$04\$/m, 'Passwords are stored as bcrypt hashes');
    assert.ok(!htpasswdText.includes('correct horse'));
    assert.strictEqual(await HtpasswdManager.verifyUser(htpasswdPath, 'corey', 'correct horse'), true);
    assert.strictEqual(await HtpasswdManager.verifyUser(htpasswdPath, 'corey', 'first-password'), false);

    assert.strictEqual(HtpasswdManager.deleteUser(htpasswdPath, 'guest'), true);
    assert.strictEqual(HtpasswdManager.deleteUser(htpasswdPath, 'guest'), false);
    assert.deepStrictEqual(HtpasswdManager.listUsers(htpasswdPath), ['corey']);
    await assert.rejects(HtpasswdManager.setUser(htpasswdPath, 'bad name', 'x', 4));
    await assert.rejects(HtpasswdManager.setUser(htpasswdPath, 'corey', '', 4));
    await assert.rejects(HtpasswdManager.setUser(htpasswdPath, 'corey', 'x'.repeat(73), 4));
    console.log('   ✓ HtpasswdManager tests passed.');

    // 5. Test CertManager
    console.log('5. Testing CertManager...');
    assert.deepStrictEqual(CertManager.normalizeNames(' localhost, 127.0.0.1\n[::1], localhost ,'), ['localhost', '127.0.0.1', '::1']);
    assert.deepStrictEqual(CertManager.defaultNames(addresses, 'desktop.example.ts.net').slice(0, 3), ['localhost', '127.0.0.1', '::1']);
    assert.ok(CertManager.defaultNames(addresses, 'desktop.example.ts.net').includes('desktop.example.ts.net'));
    assert.ok(!CertManager.defaultNames(addresses).includes('172.28.0.1'), 'Virtual adapter addresses are left out');

    const certNames = ['eagle-host', 'localhost', '127.0.0.1', '::1', '192.168.1.5', 'desktop.example.ts.net'];
    // 2048 bits keeps the test quick; the plugin's default is 4096
    const certFiles = await CertManager.generateFiles(ConfigManager.getCertsDir(), { names: certNames, keyBits: 2048 });
    const x509 = new crypto.X509Certificate(fs.readFileSync(certFiles.certPath));
    assert.strictEqual(x509.subject, 'CN=eagle-host');
    assert.strictEqual(x509.issuer, 'CN=eagle-host');
    assert.strictEqual(x509.ca, true);
    assert.ok(x509.verify(x509.publicKey), 'Certificate is signed by its own key');
    assert.ok(x509.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(certFiles.keyPath))));
    assert.strictEqual(x509.checkHost('localhost'), 'localhost');
    assert.strictEqual(x509.checkHost('desktop.example.ts.net'), 'desktop.example.ts.net');
    assert.strictEqual(x509.checkHost('elsewhere.example.com'), undefined);
    assert.strictEqual(x509.checkIP('127.0.0.1'), '127.0.0.1');
    assert.strictEqual(x509.checkIP('192.168.1.5'), '192.168.1.5');
    assert.ok(x509.checkIP('::1'));
    assert.ok(x509.keyUsage === undefined || x509.keyUsage.includes('1.3.6.1.5.5.7.3.1'), 'Server authentication usage is present');
    const validDays = (new Date(x509.validTo) - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(validDays > 364 && validDays <= 365, `Valid for 365 days (got ${validDays.toFixed(2)})`);

    const inspected = CertManager.inspect(certFiles.certPath);
    assert.strictEqual(inspected.subject, 'eagle-host');
    assert.strictEqual(inspected.expired, false);
    assert.ok(inspected.names.includes('desktop.example.ts.net') && inspected.names.includes('127.0.0.1'));
    assert.strictEqual(CertManager.inspect(path.join(tempDir, 'missing.crt')), null);
    await assert.rejects(CertManager.generate({ names: [] }));
    await assert.rejects(CertManager.generate({ names: ['bad name!'] }));
    console.log('   ✓ CertManager tests passed.');

    // 6. Test RcloneManager
    console.log('6. Testing RcloneManager...');
    const args = RcloneManager.buildArgs({
        storagePath: storageDir,
        addrs: ['127.0.0.1:41599', '192.168.1.5:41599'],
        certPath: 'server.crt',
        keyPath: 'server.key',
        htpasswdPath: 'htpasswd',
        dirCacheTime: '5s',
        readOnly: true,
        followSymlinks: true
    });
    assert.deepStrictEqual(args.slice(0, 3), ['serve', 'webdav', storageDir]);
    assert.ok(args.includes('-L'));
    assert.deepStrictEqual(args.filter((arg, i) => args[i - 1] === '--addr'), ['127.0.0.1:41599', '192.168.1.5:41599']);
    assert.strictEqual(args[args.indexOf('--cert') + 1], 'server.crt');
    assert.strictEqual(args[args.indexOf('--key') + 1], 'server.key');
    assert.strictEqual(args[args.indexOf('--htpasswd') + 1], 'htpasswd');
    assert.strictEqual(args[args.indexOf('--dir-cache-time') + 1], '5s');
    assert.ok(args.includes('--read-only'));

    const plainArgs = RcloneManager.buildArgs({ storagePath: storageDir, addrs: ['127.0.0.1:1'] });
    for (const flag of ['-L', '--cert', '--htpasswd', '--read-only', '--dir-cache-time']) {
        assert.ok(!plainArgs.includes(flag), `${flag} is only passed when configured`);
    }
    assert.strictEqual(RcloneManager.formatAddr('::1', 8080), '[::1]:8080');
    assert.strictEqual(RcloneManager.archiveName('1.68.2', 'win32', 'x64'), 'rclone-v1.68.2-windows-amd64.zip');
    assert.strictEqual(RcloneManager.archiveName('1.68.2', 'darwin', 'arm64'), 'rclone-v1.68.2-osx-arm64.zip');
    assert.throws(() => RcloneManager.archiveName('1.68.2', 'sunos', 'x64'));

    const payload = crypto.randomBytes(4096);
    const zip = makeZip('rclone-v1.0.0-test/rclone.exe', payload);
    assert.ok((await RcloneManager.extractZipEntry(zip, name => name.endsWith('/rclone.exe'))).equals(payload));
    await assert.rejects(RcloneManager.extractZipEntry(zip, name => name === 'missing'));
    await assert.rejects(RcloneManager.extractZipEntry(Buffer.from('not a zip at all, just some text'), () => true));
    assert.strictEqual(await RcloneManager.isRcloneProcess(process.pid), false, 'The test process is not rclone');
    console.log('   ✓ RcloneManager tests passed.');

    // 7. Test ServerManager failure reporting (no rclone needed)
    console.log('7. Testing ServerManager start validation...');
    ServerManager.init({ getLibraryPath: async () => '' });
    ConfigManager.saveConfig({ storageMode: 'library' });
    await ServerManager.start();
    assert.strictEqual(ServerManager.getState().status, 'error');
    assert.strictEqual(ServerManager.getState().errorCode, 'NO_STORAGE');

    ConfigManager.saveConfig({ storageMode: 'custom', storagePath: path.join(tempDir, 'missing') });
    await ServerManager.restart();
    assert.strictEqual(ServerManager.getState().errorCode, 'NO_STORAGE');

    ConfigManager.saveConfig({ storagePath: storageDir, rclonePath: path.join(tempDir, 'no-such-rclone') });
    await ServerManager.restart();
    assert.strictEqual(ServerManager.getState().errorCode, 'RCLONE_MISSING');

    await ServerManager.stop();
    assert.strictEqual(ServerManager.getState().status, 'stopped');
    console.log('   ✓ ServerManager validation tests passed.');

    // 8. Integration: a real rclone serving a real folder
    const rclonePath = await findTestRclone();
    if (!rclonePath) {
        console.log('8. Skipping rclone integration tests (rclone not found; set EAGLE_SERVE_TEST_DOWNLOAD_RCLONE=1 to download it).');
    } else {
        console.log(`8. Testing the WebDAV server with ${rclonePath}...`);
        const version = await RcloneManager.getVersion(rclonePath);
        assert.match(version, /^\d+\.\d+/, 'rclone reports its version');
        console.log(`   rclone v${version}`);

        const port = await getFreePort();
        const base = `http://127.0.0.1:${port}`;
        const baseConfig = {
            ...ConfigManager.DEFAULT_CONFIG,
            storageMode: 'custom',
            storagePath: storageDir,
            rclonePath,
            port
        };
        const startWith = async overrides => {
            ConfigManager.saveConfig({ ...baseConfig, ...overrides });
            await ServerManager.restart();
            return ServerManager.getState();
        };

        // 8a. Plain HTTP on localhost: upload, download, list, delete
        // (written before the start: rclone caches directory listings for dirCacheTime)
        fs.writeFileSync(path.join(storageDir, 'metadata.json'), '{"folders":[]}');
        let state = await startWith({});
        assert.strictEqual(state.status, 'running', state.error || '');
        assert.deepStrictEqual(state.hosts, ['127.0.0.1']);
        assert.deepStrictEqual(state.urls, [{ url: `${base}/`, label: 'This computer' }]);
        assert.strictEqual(fs.readFileSync(ConfigManager.getPidPath(), 'utf8'), String(state.pid));
        assert.strictEqual(await RcloneManager.isRcloneProcess(state.pid), true);

        assert.strictEqual((await request(`${base}/hello.txt`, { method: 'PUT', body: 'hello from the test' })).status, 201);
        assert.strictEqual(fs.readFileSync(path.join(storageDir, 'hello.txt'), 'utf8'), 'hello from the test');
        assert.strictEqual((await request(`${base}/metadata.json`)).body, '{"folders":[]}');
        const listing = await request(`${base}/`, { method: 'PROPFIND', headers: { Depth: '1' } });
        assert.strictEqual(listing.status, 207);
        assert.ok(listing.body.includes('hello.txt') && listing.body.includes('metadata.json'));
        assert.strictEqual((await request(`${base}/hello.txt`, { method: 'DELETE' })).status, 204);
        assert.ok(!fs.existsSync(path.join(storageDir, 'hello.txt')));
        console.log('   ✓ HTTP upload, download, listing and delete work.');

        // 8a2. Every local network address at once (one --addr per address)
        const others = NetworkInfo.listAddresses().filter(a => a.kind !== 'other');
        if (others.length) {
            state = await startWith({ bindLan: true, bindTailscale: true });
            assert.strictEqual(state.status, 'running', state.error || '');
            assert.deepStrictEqual(state.hosts, ['127.0.0.1', ...others.filter(a => a.kind === 'lan').map(a => a.address),
                ...others.filter(a => a.kind === 'tailscale').map(a => a.address)]);
            for (const host of state.hosts) {
                assert.strictEqual((await request(`http://${host}:${port}/metadata.json`)).status, 200, `Reachable on ${host}`);
            }
            console.log(`   ✓ Listens on ${state.hosts.join(', ')} together.`);
        }

        // 8b. A second server on the same port reports the conflict
        const blocker = net.createServer().listen(0, '127.0.0.1');
        await new Promise(resolve => blocker.once('listening', resolve));
        state = await startWith({ port: blocker.address().port });
        assert.strictEqual(state.status, 'error');
        assert.match(state.error, /already in use/);
        blocker.close();
        console.log('   ✓ A busy port is reported as an error.');

        // 8c. Read-only
        state = await startWith({ readOnly: true });
        assert.strictEqual(state.status, 'running', state.error || '');
        const denied = await request(`${base}/nope.txt`, { method: 'PUT', body: 'x' });
        assert.ok(denied.status >= 400, `Read-only server rejects uploads (got ${denied.status})`);
        assert.ok(!fs.existsSync(path.join(storageDir, 'nope.txt')));
        assert.strictEqual((await request(`${base}/metadata.json`)).status, 200);
        console.log('   ✓ Read-only mode rejects writes.');

        // 8d. Authentication from the htpasswd file
        state = await startWith({ authEnabled: true });
        assert.strictEqual(state.status, 'running', state.error || '');
        assert.strictEqual((await request(`${base}/metadata.json`)).status, 401);
        const basic = credentials => ({ headers: { Authorization: 'Basic ' + Buffer.from(credentials).toString('base64') } });
        assert.strictEqual((await request(`${base}/metadata.json`, basic('corey:wrong'))).status, 401);
        assert.strictEqual((await request(`${base}/metadata.json`, basic('corey:correct horse'))).status, 200);

        // rclone picks up htpasswd changes without a restart
        await HtpasswdManager.setUser(htpasswdPath, 'guest', 'added while running', 4);
        assert.strictEqual((await request(`${base}/metadata.json`, basic('guest:added while running'))).status, 200);
        HtpasswdManager.deleteUser(htpasswdPath, 'guest');
        assert.strictEqual((await request(`${base}/metadata.json`, basic('guest:added while running'))).status, 401);
        assert.strictEqual((await request(`${base}/metadata.json`, basic('corey:correct horse'))).status, 200);
        console.log('   ✓ bcrypt htpasswd authentication works, and user changes apply live.');

        await ServerManager.stop();
        fs.renameSync(htpasswdPath, htpasswdPath + '.bak');
        state = await startWith({ authEnabled: true });
        assert.strictEqual(state.errorCode, 'NO_USERS', 'Sign-in without any user refuses to start');
        fs.renameSync(htpasswdPath + '.bak', htpasswdPath);

        // 8e. HTTPS with the generated certificate, verified against it as the CA
        state = await startWith({ httpsEnabled: true, certPath: certFiles.certPath, keyPath: certFiles.keyPath });
        assert.strictEqual(state.status, 'running', state.error || '');
        assert.strictEqual(state.urls[0].url, `https://127.0.0.1:${port}/`);
        const secure = await request(`https://127.0.0.1:${port}/metadata.json`, { ca: fs.readFileSync(certFiles.certPath) });
        assert.strictEqual(secure.status, 200);
        assert.strictEqual(secure.body, '{"folders":[]}');
        console.log('   ✓ HTTPS works with the generated self-signed certificate.');

        state = await startWith({ httpsEnabled: true, certPath: '', keyPath: '' });
        assert.strictEqual(state.errorCode, 'NO_CERT');

        // 8f. Access filter: allowed clients pass through, others are dropped
        state = await startWith({ accessRestrictionEnabled: true, allowedClients: ['self'] });
        assert.strictEqual(state.status, 'running', state.error || '');
        assert.strictEqual((await request(`${base}/metadata.json`)).body, '{"folders":[]}');
        assert.strictEqual((await request(`${base}/filtered.txt`, { method: 'PUT', body: 'through the filter' })).status, 201);
        assert.strictEqual(fs.readFileSync(path.join(storageDir, 'filtered.txt'), 'utf8'), 'through the filter');

        state = await startWith({ accessRestrictionEnabled: true, allowedClients: ['203.0.113.9'] });
        assert.strictEqual(state.status, 'running', state.error || '');
        await assert.rejects(request(`${base}/metadata.json`), 'A client that is not allowed has its connection closed');
        assert.ok(ServerManager.getLogs().some(line => line.includes('Denied connection from 127.0.0.1')));
        console.log('   ✓ The access filter forwards allowed clients and drops the rest.');

        // 8g. Library mode follows the open library
        const otherLibrary = path.join(tempDir, 'other.library');
        fs.mkdirSync(otherLibrary);
        fs.writeFileSync(path.join(otherLibrary, 'metadata.json'), '{"other":true}');
        let openLibrary = storageDir;
        ServerManager.init({ getLibraryPath: async () => openLibrary });
        state = await startWith({ storageMode: 'library', storagePath: '' });
        assert.strictEqual(state.storagePath, storageDir);
        openLibrary = otherLibrary;
        await ServerManager.checkForChanges();
        await ServerManager.start();
        assert.strictEqual(ServerManager.getState().storagePath, otherLibrary);
        assert.strictEqual((await request(`${base}/metadata.json`)).body, '{"other":true}');
        console.log('   ✓ Switching the Eagle library re-serves the new one.');

        // 8h. Stop frees the port and removes the PID file
        const servingPid = ServerManager.getState().pid;
        await ServerManager.stop();
        assert.strictEqual(ServerManager.getState().status, 'stopped');
        assert.ok(!fs.existsSync(ConfigManager.getPidPath()));
        await assert.rejects(request(`${base}/metadata.json`));
        assert.strictEqual(await RcloneManager.isRcloneProcess(servingPid), false);

        // 8i. A leftover rclone from a crashed session is cleaned up
        await startWith({});
        const orphanPid = ServerManager.getState().pid;
        ServerManager.shutdownSync();
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.strictEqual(await RcloneManager.isRcloneProcess(orphanPid), false, 'shutdownSync kills rclone');

        const { spawn } = require('child_process');
        const orphan = spawn(rclonePath, RcloneManager.buildArgs({ storagePath: storageDir, addrs: [`127.0.0.1:${port}`] }), { stdio: 'ignore' });
        fs.writeFileSync(ConfigManager.getPidPath(), String(orphan.pid));
        await new Promise(resolve => setTimeout(resolve, 1000));
        await ServerManager.cleanupStale();
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.strictEqual(await RcloneManager.isRcloneProcess(orphan.pid), false, 'cleanupStale kills the recorded rclone');
        assert.ok(!fs.existsSync(ConfigManager.getPidPath()));
        console.log('   ✓ Stop, shutdown and stale-process cleanup work.');
    }

    ServerManager.shutdownSync();
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('\n--- All Eagle Serve tests passed ---');
}

runTests().then(() => process.exit(0)).catch(err => {
    console.error('\n✗ Test failed:');
    console.error(err);
    try {
        ServerManager.shutdownSync();
    } catch {
        // Nothing left to clean up
    }
    process.exit(1);
});
