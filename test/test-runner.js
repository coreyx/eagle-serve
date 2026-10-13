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
const ItemGateway = require('../js/gateway.js');
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
    assert.strictEqual(defaults.libraryNameInUrl, true);
    assert.strictEqual(defaults.itemLinksEnabled, false);
    assert.strictEqual(defaults.readOnly, true, 'A new install cannot change the library until asked to');
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
    // The computer name is offered once the server is reachable beyond this machine
    const named = NetworkInfo.buildUrls(['127.0.0.1', '192.168.1.5'], 41599, false,
        { addresses, hostname: 'eagle-host', names: ['Eagle-Host', 'files.example.com'] });
    assert.deepStrictEqual(named, [
        { url: 'http://127.0.0.1:41599/', label: 'This computer' },
        { url: 'http://eagle-host:41599/', label: 'Computer name' },
        { url: 'http://192.168.1.5:41599/', label: 'Local network' },
        { url: 'http://files.example.com:41599/', label: 'Custom name' }
    ]);
    assert.deepStrictEqual(NetworkInfo.buildUrls(['127.0.0.1'], 41599, false, { addresses, hostname: 'eagle-host' }),
        [{ url: 'http://127.0.0.1:41599/', label: 'This computer' }], 'No name is offered for a localhost-only server');
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

    // A mount name serves the folder one level down through the combine backend
    const mounted = { storagePath: storageDir, mountName: 'My "Best" Stuff.library', addrs: ['127.0.0.1:1'] };
    assert.strictEqual(RcloneManager.buildArgs(mounted)[2], ':combine:');
    assert.ok(!RcloneManager.buildArgs(mounted).includes(storageDir), 'The folder is passed through the environment instead');
    assert.deepStrictEqual(RcloneManager.buildEnv(mounted),
        { RCLONE_COMBINE_UPSTREAMS: `"My ""Best"" Stuff.library=${storageDir}"` });
    assert.deepStrictEqual(RcloneManager.buildEnv({ storagePath: storageDir }), {});
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

    // 6b. Test ItemGateway address parsing and ID resolution
    console.log('6b. Testing ItemGateway...');
    const original = { kind: 'item', id: 'MV63BVOWOZLV6' };
    const thumb = { kind: 'thumbnail', id: 'MV63BVOWOZLV6' };
    assert.deepStrictEqual(ItemGateway.parseItemRequest('/item/MV63BVOWOZLV6'), original);
    assert.deepStrictEqual(ItemGateway.parseItemRequest('/item/MV63BVOWOZLV6/Dalaran%20at%20sunset.png'), original);
    assert.deepStrictEqual(ItemGateway.parseItemRequest('/item/MV63BVOWOZLV6?download=1'), original);
    assert.deepStrictEqual(ItemGateway.parseItemRequest('/item?id=MV63BVOWOZLV6'), original, "Eagle's own link shape");
    assert.deepStrictEqual(ItemGateway.parseItemRequest('/item'), { kind: 'item', id: '' });
    assert.deepStrictEqual(ItemGateway.parseItemRequest('/item/'), { kind: 'item', id: '' });
    assert.deepStrictEqual(ItemGateway.parseItemRequest('/thumbnail/MV63BVOWOZLV6'), thumb);
    assert.deepStrictEqual(ItemGateway.parseItemRequest('/thumbnail/MV63BVOWOZLV6/Dalaran.png'), thumb);
    assert.deepStrictEqual(ItemGateway.parseItemRequest('/thumbnail?id=MV63BVOWOZLV6'), thumb);
    assert.deepStrictEqual(ItemGateway.parseItemRequest('/thumbnail/'), { kind: 'thumbnail', id: '' });
    assert.strictEqual(ItemGateway.parseItemRequest('/thumbnails/MV63BVOWOZLV6'), null);
    assert.strictEqual(ItemGateway.parseItemRequest('/items/MV63BVOWOZLV6'), null);
    assert.strictEqual(ItemGateway.parseItemRequest('/Main.library/images/MV63BVOWOZLV6.info/a.png'), null);
    assert.strictEqual(ItemGateway.parseItemRequest('/'), null);

    const itemId = 'MV63BVOWOZLV6';
    const itemLibrary = path.join(tempDir, 'items.library');
    const itemDir = path.join(itemLibrary, 'images', `${itemId}.info`);
    fs.mkdirSync(itemDir, { recursive: true });
    fs.writeFileSync(path.join(itemDir, 'Dalaran at sunset.png'), 'original image');
    fs.writeFileSync(path.join(itemDir, 'Dalaran at sunset_thumbnail.png'), 'thumbnail');
    fs.writeFileSync(path.join(itemDir, 'metadata.json'), JSON.stringify({ id: itemId, name: 'Dalaran at sunset', ext: 'png' }));
    // Other plugins keep their own files beside the item (Extra Links does)
    fs.writeFileSync(path.join(itemDir, 'extra-links.json'), '[]');
    assert.strictEqual(await ItemGateway.resolveItemFile(itemLibrary, itemId), 'Dalaran at sunset.png');
    assert.strictEqual(await ItemGateway.resolveItemFile(itemLibrary, itemId, 'thumbnail'), 'Dalaran at sunset_thumbnail.png');
    assert.strictEqual(await ItemGateway.resolveItemFile(itemLibrary, 'NOSUCHITEM001'), null);
    assert.strictEqual(await ItemGateway.resolveItemFile(itemLibrary, 'NOSUCHITEM001', 'thumbnail'), null);

    // Eagle makes no thumbnail for a small image; its thumbnail address answers with the image
    const smallId = 'SMALL00000001';
    const smallDir = path.join(itemLibrary, 'images', `${smallId}.info`);
    fs.mkdirSync(smallDir);
    fs.writeFileSync(path.join(smallDir, 'icon.png'), 'small image');
    fs.writeFileSync(path.join(smallDir, 'metadata.json'), JSON.stringify({ id: smallId, name: 'icon', ext: 'png' }));
    assert.strictEqual(await ItemGateway.resolveItemFile(itemLibrary, smallId, 'thumbnail'), 'icon.png');
    assert.strictEqual(await ItemGateway.resolveItemFile(itemLibrary, '..'), null, 'Only item IDs are looked up');
    assert.strictEqual(await ItemGateway.resolveItemFile(itemLibrary, `${itemId}/../${itemId}`), null);

    // Metadata that has fallen behind the folder: use the file that is really there
    fs.writeFileSync(path.join(itemDir, 'metadata.json'), JSON.stringify({ id: itemId, name: 'An older name', ext: 'png' }));
    assert.strictEqual(await ItemGateway.resolveItemFile(itemLibrary, itemId), 'Dalaran at sunset.png');
    assert.strictEqual(await ItemGateway.resolveItemFile(itemLibrary, itemId, 'thumbnail'), 'Dalaran at sunset_thumbnail.png');
    fs.writeFileSync(path.join(itemDir, 'metadata.json'), 'not json');
    assert.strictEqual(await ItemGateway.resolveItemFile(itemLibrary, itemId), 'Dalaran at sunset.png', 'Sidecar files are never taken for the item');
    assert.strictEqual(await ItemGateway.resolveItemFile(itemLibrary, itemId, 'thumbnail'), 'Dalaran at sunset_thumbnail.png');
    fs.writeFileSync(path.join(itemDir, 'metadata.json'), JSON.stringify({ id: itemId, name: 'Dalaran at sunset', ext: 'png' }));
    console.log('   ✓ ItemGateway tests passed.');

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
            port,
            readOnly: false
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

        // 8a3. This computer's own name in "Other addresses" resolves to addresses the
        // LAN and Tailscale options already bind; they must not be bound twice
        const ownName = os.hostname();
        const ownRecords = await require('dns').promises.lookup(ownName, { all: true }).catch(() => []);
        if (ownRecords.some(record => record.family === 4)) {
            state = await startWith({ bindLan: true, bindTailscale: true, extraHosts: [ownName] });
            assert.strictEqual(state.status, 'running', state.error || '');
            assert.strictEqual(new Set(state.hosts).size, state.hosts.length, 'No address is bound twice');
            assert.ok(state.hosts.every(host => net.isIP(host)), 'Names are resolved to addresses before binding');
            assert.ok(state.urls.some(entry => entry.url === `http://${ownName.toLowerCase()}:${port}/`), 'The name is listed as an address');
            assert.strictEqual((await request(`http://${ownName}:${port}/metadata.json`)).status, 200, `Reachable as ${ownName}`);
            console.log(`   ✓ Listening on the computer name ${ownName} works alongside the network options.`);
        }

        state = await startWith({ extraHosts: ['no-such-host.invalid'] });
        assert.strictEqual(state.errorCode, 'BAD_HOST', 'A name that does not resolve is reported as such');
        assert.match(state.error, /no-such-host\.invalid/);

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

        // The library sits under its own folder name, and the root lists it
        assert.strictEqual(state.urlPath, '/library/');
        assert.strictEqual((await request(`${base}/library/metadata.json`)).body, '{"folders":[]}');
        assert.strictEqual((await request(`${base}/metadata.json`)).status, 404);
        const rootListing = await request(`${base}/`, { method: 'PROPFIND', headers: { Depth: '1' } });
        assert.strictEqual(rootListing.status, 207);
        assert.ok(rootListing.body.includes('/library/'));
        assert.strictEqual((await request(`${base}/library/via-prefix.txt`, { method: 'PUT', body: 'prefixed' })).status, 201);
        assert.strictEqual(fs.readFileSync(path.join(storageDir, 'via-prefix.txt'), 'utf8'), 'prefixed');

        // Symbolic links are still followed when the library is mounted by name
        fs.writeFileSync(path.join(tempDir, 'outside.txt'), 'linked content');
        let linked = true;
        try {
            fs.symlinkSync(path.join(tempDir, 'outside.txt'), path.join(otherLibrary, 'link.txt'));
        } catch {
            linked = false; // creating symlinks needs extra rights on Windows
        }

        openLibrary = otherLibrary;
        await ServerManager.checkForChanges();
        await ServerManager.start();
        assert.strictEqual(ServerManager.getState().storagePath, otherLibrary);
        assert.strictEqual(ServerManager.getState().urlPath, '/other.library/');
        assert.strictEqual((await request(`${base}/other.library/metadata.json`)).body, '{"other":true}');
        assert.strictEqual((await request(`${base}/library/metadata.json`)).status, 404, 'The previous library no longer answers');
        if (linked) {
            assert.strictEqual((await request(`${base}/other.library/link.txt`)).body, 'linked content');
        }

        // With the option off, the library is served at the top level
        state = await startWith({ storageMode: 'library', storagePath: '', libraryNameInUrl: false });
        assert.strictEqual(state.urlPath, '/');
        assert.strictEqual((await request(`${base}/metadata.json`)).body, '{"other":true}');
        assert.strictEqual((await request(`${base}/other.library/metadata.json`)).status, 404);
        console.log('   ✓ Switching the Eagle library re-serves the new one.');

        // 8g2. Item links: an address by ID alone, with everything else passing through
        openLibrary = itemLibrary;
        const itemFile = '/items.library/images/MV63BVOWOZLV6.info/Dalaran%20at%20sunset.png';
        state = await startWith({ storageMode: 'library', storagePath: '', itemLinksEnabled: true, dirCacheTime: '1s' });
        assert.strictEqual(state.status, 'running', state.error || '');
        assert.strictEqual(state.itemLinks, true);
        assert.strictEqual(state.urlPath, '/items.library/');

        const byId = await request(`${base}/item/${itemId}`);
        assert.strictEqual(byId.status, 200);
        assert.strictEqual(byId.body, 'original image');
        assert.strictEqual(byId.headers['content-type'], 'image/png');
        assert.strictEqual((await request(`${base}/item/${itemId}/any%20name%20at%20all.png`)).body, 'original image');
        assert.strictEqual((await request(`${base}/item?id=${itemId}`)).body, 'original image');
        const headById = await request(`${base}/item/${itemId}`, { method: 'HEAD' });
        assert.strictEqual(headById.status, 200);
        assert.strictEqual(headById.headers['content-length'], '14');
        assert.strictEqual((await request(`${base}/item/NOSUCHITEM001`)).status, 404);

        // The thumbnail has its own address by ID
        assert.strictEqual((await request(`${base}/thumbnail/${itemId}`)).body, 'thumbnail');
        assert.strictEqual((await request(`${base}/thumbnail/${itemId}/any-name.png`)).body, 'thumbnail');
        assert.strictEqual((await request(`${base}/thumbnail?id=${itemId}`)).body, 'thumbnail');
        assert.strictEqual((await request(`${base}/thumbnail/SMALL00000001`)).body, 'small image', 'No thumbnail: the image itself');
        assert.strictEqual((await request(`${base}/thumbnail/NOSUCHITEM001`)).status, 404);
        assert.strictEqual((await request(`${base}/thumbnail/${itemId}`, { method: 'DELETE' })).status, 405);
        assert.strictEqual((await request(`${base}/item/..%2F..%2Fmetadata.json`)).status, 404);
        assert.strictEqual((await request(`${base}/item`)).status, 404);
        assert.strictEqual((await request(`${base}/item/${itemId}`, { method: 'PUT', body: 'x' })).status, 405);
        assert.strictEqual(fs.readFileSync(path.join(itemDir, 'Dalaran at sunset.png'), 'utf8'), 'original image');

        // The ordinary addresses and every WebDAV verb still work through the gateway
        assert.strictEqual((await request(`${base}${itemFile}`)).body, 'original image');
        assert.strictEqual((await request(`${base}/`, { method: 'PROPFIND', headers: { Depth: '1' } })).status, 207);
        const big = crypto.randomBytes(3 * 1024 * 1024).toString('hex');
        assert.strictEqual((await request(`${base}/items.library/big.txt`, { method: 'PUT', body: big })).status, 201);
        assert.strictEqual(fs.statSync(path.join(itemLibrary, 'big.txt')).size, big.length);
        assert.ok((await request(`${base}/items.library/big.txt`)).body === big, 'A 6 MB file survives the round trip');
        const ranged = await request(`${base}/items.library/big.txt`, { headers: { Range: 'bytes=1000-1999' } });
        assert.strictEqual(ranged.status, 206);
        assert.strictEqual(ranged.body, big.substring(1000, 2000));
        assert.strictEqual((await request(`${base}/items.library/moved/`, { method: 'MKCOL' })).status, 201);
        const move = await request(`${base}/items.library/big.txt`, { method: 'MOVE', headers: { Destination: `${base}/items.library/moved/big.txt` } });
        assert.strictEqual(move.status, 201);
        assert.ok(fs.existsSync(path.join(itemLibrary, 'moved', 'big.txt')));
        assert.strictEqual((await request(`${base}/items.library/moved/`, { method: 'DELETE' })).status, 204);
        assert.ok(!fs.existsSync(path.join(itemLibrary, 'moved')));

        // Renaming the item in Eagle renames its file; the ID address follows it
        fs.renameSync(path.join(itemDir, 'Dalaran at sunset.png'), path.join(itemDir, 'Heroes overlooking Dalaran.png'));
        fs.renameSync(path.join(itemDir, 'Dalaran at sunset_thumbnail.png'), path.join(itemDir, 'Heroes overlooking Dalaran_thumbnail.png'));
        fs.writeFileSync(path.join(itemDir, 'metadata.json'), JSON.stringify({ id: itemId, name: 'Heroes overlooking Dalaran', ext: 'png' }));
        await new Promise(resolve => setTimeout(resolve, 1500)); // let rclone's folder listing cache expire
        assert.strictEqual((await request(`${base}/item/${itemId}`)).body, 'original image', 'The ID address survives a rename');
        assert.strictEqual((await request(`${base}/thumbnail/${itemId}`)).body, 'thumbnail', 'So does the thumbnail address');
        assert.strictEqual((await request(`${base}${itemFile}`)).status, 404, 'The address by file name does not');
        console.log('   ✓ Item links resolve by ID, survive a rename, and pass WebDAV through.');

        // With HTTPS, sign-in and allowed devices all on, the gateway terminates TLS,
        // checks the client, and rclone still does the sign-in
        state = await startWith({
            storageMode: 'library', storagePath: '', itemLinksEnabled: true,
            httpsEnabled: true, certPath: certFiles.certPath, keyPath: certFiles.keyPath,
            authEnabled: true, accessRestrictionEnabled: true, allowedClients: ['self']
        });
        assert.strictEqual(state.status, 'running', state.error || '');
        const secureBase = `https://127.0.0.1:${port}`;
        const trusted = { ca: fs.readFileSync(certFiles.certPath) };
        assert.strictEqual((await request(`${secureBase}/item/${itemId}`, trusted)).status, 401, 'Item links ask for sign-in too');
        const signedIn = await request(`${secureBase}/item/${itemId}`, { ...trusted, ...basic('corey:correct horse') });
        assert.strictEqual(signedIn.status, 200);
        assert.strictEqual(signedIn.body, 'original image');
        assert.strictEqual((await request(`${secureBase}/items.library/metadata.json`, { ...trusted, ...basic('corey:wrong') })).status, 401);

        state = await startWith({
            storageMode: 'library', storagePath: '', itemLinksEnabled: true,
            httpsEnabled: true, certPath: certFiles.certPath, keyPath: certFiles.keyPath,
            accessRestrictionEnabled: true, allowedClients: ['203.0.113.9']
        });
        assert.strictEqual(state.status, 'running', state.error || '');
        await assert.rejects(request(`${secureBase}/item/${itemId}`, trusted), 'A client that is not allowed is dropped before TLS');

        // At the top level (no library name), item links work the same way
        state = await startWith({ storageMode: 'library', storagePath: '', itemLinksEnabled: true, libraryNameInUrl: false });
        assert.strictEqual((await request(`${base}/item/${itemId}`)).body, 'original image');
        assert.strictEqual((await request(`${base}/images/${itemId}.info/Heroes%20overlooking%20Dalaran.png`)).body, 'original image');

        // A folder that is not a library gets no item links
        state = await startWith({ itemLinksEnabled: true });
        assert.strictEqual(state.itemLinks, false);
        console.log('   ✓ Item links work with HTTPS, sign-in and allowed devices.');

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
