/**
 * WebDAV Server Controller for Eagle Serve
 * Runs "rclone serve webdav" as a child process for the folder being served,
 * puts the access filter in front of it when client restrictions are on, and
 * keeps the whole thing in step with the settings, the open Eagle library and
 * the machine's network addresses.
 */

const ServerManager = (() => {
    const dns = require('dns');
    const fs = require('fs');
    const net = require('net');
    const os = require('os');
    const path = require('path');
    const { spawn } = require('child_process');

    // Support both Electron (script tags) and Node.js (tests)
    const Config = typeof ConfigManager !== 'undefined' ? ConfigManager : require('./config.js');
    const Network = typeof NetworkInfo !== 'undefined' ? NetworkInfo : require('./network.js');
    const Filter = typeof AccessFilter !== 'undefined' ? AccessFilter : require('./access-filter.js');
    const Gateway = typeof ItemGateway !== 'undefined' ? ItemGateway : require('./gateway.js');
    const Rclone = typeof RcloneManager !== 'undefined' ? RcloneManager : require('./rclone.js');
    const Htpasswd = typeof HtpasswdManager !== 'undefined' ? HtpasswdManager : require('./htpasswd.js');

    const LOG_LIMIT = 500;
    const READY_TIMEOUT = 20000;
    const WATCH_INTERVAL = 10000;
    const PORT_IN_USE = /address already in use|only one usage of each socket address|EADDRINUSE/i;

    const stateListeners = [];
    const logListeners = [];
    const logs = [];

    let state = {
        // 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
        status: 'stopped',
        error: null,
        errorCode: null,
        storagePath: '',
        // Where the folder sits on the server: '/' or '/<Name>.library/'
        urlPath: '/',
        // Whether /item/<ID> and /thumbnail/<ID> addresses are being answered
        itemLinks: false,
        hosts: [],
        port: 0,
        https: false,
        urls: [],
        rclonePath: '',
        pid: null
    };

    let child = null;
    let proxy = null;
    let queue = Promise.resolve();
    // Whether the server is meant to be up, as opposed to stopped on purpose
    let wanted = false;
    let watchTimer = null;
    let tailscaleName = '';
    let getLibraryPath = async () => '';

    class ServerError extends Error {
        constructor(message, code) {
            super(message);
            this.code = code;
        }
    }

    // --- State and log --------------------------------------------------------

    function setState(patch) {
        state = { ...state, ...patch };
        for (const listener of stateListeners) {
            try {
                listener(getState());
            } catch (err) {
                console.error('[ServerManager] State listener error:', err);
            }
        }
    }

    function getState() {
        return { ...state, hosts: [...state.hosts], urls: state.urls.map(entry => ({ ...entry })) };
    }

    function pushLog(line) {
        logs.push(line);
        if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
        for (const listener of logListeners) {
            try {
                listener(line);
            } catch (err) {
                console.error('[ServerManager] Log listener error:', err);
            }
        }
    }

    // Same timestamp layout as rclone's own lines, so the log reads as one stream
    function log(message) {
        const now = new Date();
        const pad = value => String(value).padStart(2, '0');
        const stamp = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ` +
            `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        pushLog(`${stamp} ${message}`);
    }

    // --- Planning a start -----------------------------------------------------

    function isDirectory(dirPath) {
        try {
            return fs.statSync(dirPath).isDirectory();
        } catch {
            return false;
        }
    }

    async function resolveStoragePath(config) {
        if (config.storageMode === 'custom') {
            if (!config.storagePath) throw new ServerError('Choose the folder to serve.', 'NO_STORAGE');
            if (!isDirectory(config.storagePath)) {
                throw new ServerError(`The folder to serve does not exist: ${config.storagePath}`, 'NO_STORAGE');
            }
            return config.storagePath;
        }

        const libraryPath = await getLibraryPath();
        if (!libraryPath) throw new ServerError('No Eagle library is open.', 'NO_STORAGE');
        if (!isDirectory(libraryPath)) {
            throw new ServerError(`The Eagle library folder is not available: ${libraryPath}`, 'NO_STORAGE');
        }
        return libraryPath;
    }

    /**
     * The rclone binary to run: the configured one, or else the first found.
     * @param {object} [config]
     * @returns {string | null}
     */
    function findRclone(config = Config.getConfig()) {
        if (config.rclonePath) {
            return fs.existsSync(config.rclonePath) ? config.rclonePath : null;
        }
        return Rclone.find(Config.getBinDir());
    }

    function getFreePort() {
        return new Promise((resolve, reject) => {
            const probe = net.createServer();
            probe.once('error', reject);
            probe.listen(0, '127.0.0.1', () => {
                const { port } = probe.address();
                probe.close(() => resolve(port));
            });
        });
    }

    /**
     * The IP addresses to listen on. Names typed into "Other addresses" are
     * resolved here, because a name usually points at an address that the LAN or
     * Tailscale option has already added, and binding the same address twice fails.
     * @param {object} config
     * @returns {Promise<string[]>}
     */
    async function resolveHosts(config) {
        const hosts = [];
        for (const host of Network.resolveBindHosts(config)) {
            if (net.isIP(host)) {
                hosts.push(host);
                continue;
            }

            let records;
            try {
                records = await dns.promises.lookup(host, { all: true });
            } catch {
                throw new ServerError(`"${host}" under Other addresses is not a name this computer can resolve.`, 'BAD_HOST');
            }
            const ipv4 = records.filter(record => record.family === 4).map(record => record.address);
            hosts.push(...(ipv4.length ? ipv4 : records.map(record => record.address)));
        }
        return [...new Set(hosts)];
    }

    // What the address list needs to know beyond the bound IPs
    function urlInfo(config = Config.getConfig()) {
        return {
            tailscaleName,
            hostname: os.hostname().toLowerCase(),
            names: config.extraHosts.filter(host => !net.isIP(host))
        };
    }

    // Checked before rclone is launched: once something else is answering on the
    // port, "is it accepting connections yet" can no longer tell the two apart
    function assertCanListen(host, port) {
        return new Promise((resolve, reject) => {
            const probe = net.createServer();
            probe.once('error', err => {
                reject(new ServerError(
                    err.code === 'EADDRINUSE'
                        ? `Port ${port} is already in use. Choose another port or stop whatever is using it.`
                        : `Cannot listen on ${Rclone.formatAddr(host, port)}: ${err.message}`,
                    'CANNOT_LISTEN'
                ));
            });
            probe.listen(port, host, () => probe.close(() => resolve()));
        });
    }

    async function buildPlan(config) {
        const storagePath = await resolveStoragePath(config);

        const rclonePath = findRclone(config);
        if (!rclonePath) {
            throw new ServerError(
                config.rclonePath ? `rclone was not found at ${config.rclonePath}` : 'rclone is not installed.',
                'RCLONE_MISSING'
            );
        }

        const plan = { storagePath, rclonePath, port: config.port, https: config.httpsEnabled, mountName: '' };

        // Under its own folder name, an address keeps meaning the same library
        // whichever one is open in Eagle
        if (config.storageMode === 'library' && config.libraryNameInUrl) {
            plan.mountName = path.basename(storagePath);
            // "=" separates the name from the path in rclone's combine syntax
            if (!plan.mountName || plan.mountName.includes('=')) {
                throw new ServerError(
                    `The library folder name "${plan.mountName}" cannot be used in an address. Turn off "Put the library name in the address".`,
                    'BAD_LIBRARY_NAME'
                );
            }
        }

        if (config.httpsEnabled) {
            if (!config.certPath || !config.keyPath) {
                throw new ServerError('HTTPS is on but no certificate is set. Choose or generate one.', 'NO_CERT');
            }
            for (const file of [config.certPath, config.keyPath]) {
                if (!fs.existsSync(file)) throw new ServerError(`Certificate file not found: ${file}`, 'NO_CERT');
            }
            plan.certPath = config.certPath;
            plan.keyPath = config.keyPath;
        }

        if (config.authEnabled) {
            if (Htpasswd.listUsers(Config.getHtpasswdPath()).length === 0) {
                throw new ServerError('Sign-in is required but there are no users yet. Add one.', 'NO_USERS');
            }
            plan.htpasswdPath = Config.getHtpasswdPath();
        }

        plan.hosts = await resolveHosts(config);
        const publicEndpoints = plan.hosts.map(host => ({ host, port: config.port }));
        for (const endpoint of publicEndpoints) {
            await assertCanListen(endpoint.host, endpoint.port);
        }

        plan.urlPath = plan.mountName ? `/${encodeURIComponent(plan.mountName)}/` : '/';

        if (config.itemLinksEnabled && config.storageMode === 'library') {
            // The gateway owns the public ports, HTTPS and the client check;
            // rclone serves plain HTTP on a loopback port behind it
            plan.backend = { host: '127.0.0.1', port: await getFreePort() };
            plan.gateway = {
                listen: publicEndpoints,
                tls: plan.https ? { certPath: plan.certPath, keyPath: plan.keyPath } : null,
                allowedClients: config.accessRestrictionEnabled ? config.allowedClients : null,
                libraryPath: storagePath,
                urlPath: plan.urlPath
            };
        } else if (config.accessRestrictionEnabled) {
            // rclone hides on a loopback port; the access filter owns the public ones
            plan.backend = { host: '127.0.0.1', port: await getFreePort() };
            plan.filter = { listen: publicEndpoints, allowedClients: config.allowedClients };
        } else {
            plan.backend = { host: plan.hosts[0] === '0.0.0.0' ? '127.0.0.1' : plan.hosts[0], port: config.port };
        }

        plan.env = Rclone.buildEnv({ storagePath, mountName: plan.mountName });
        plan.args = Rclone.buildArgs({
            storagePath,
            mountName: plan.mountName,
            addrs: (plan.filter || plan.gateway)
                ? [Rclone.formatAddr(plan.backend.host, plan.backend.port)]
                : publicEndpoints.map(endpoint => Rclone.formatAddr(endpoint.host, endpoint.port)),
            // Behind the gateway, the gateway is the one speaking HTTPS
            certPath: plan.gateway ? '' : plan.certPath,
            keyPath: plan.gateway ? '' : plan.keyPath,
            htpasswdPath: plan.htpasswdPath,
            dirCacheTime: config.dirCacheTime,
            readOnly: config.readOnly,
            followSymlinks: config.followSymlinks
        });

        return plan;
    }

    // --- Process control ------------------------------------------------------

    function writePidFile(pid) {
        try {
            fs.mkdirSync(Config.getDataDir(), { recursive: true });
            fs.writeFileSync(Config.getPidPath(), String(pid));
        } catch (err) {
            console.error('[ServerManager] Could not write server.pid:', err);
        }
    }

    function removePidFile() {
        try {
            fs.unlinkSync(Config.getPidPath());
        } catch {
            // Already gone
        }
    }

    function collectLines(stream, onLine) {
        let pending = '';
        stream.setEncoding('utf8');
        stream.on('data', chunk => {
            const lines = (pending + chunk).split(/\r?\n/);
            pending = lines.pop();
            lines.filter(Boolean).forEach(onLine);
        });
        stream.on('end', () => {
            if (pending) onLine(pending);
        });
    }

    function spawnRclone(plan) {
        const proc = spawn(plan.rclonePath, plan.args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...plan.env }
        });
        proc.recentLines = [];
        proc.probeNoiseUntil = Infinity;
        proc.exited = new Promise(resolve => {
            proc.once('error', err => {
                proc.spawnError = err;
                resolve();
            });
            proc.once('exit', (code, signal) => {
                proc.exitInfo = { code, signal };
                resolve();
            });
        });

        const onLine = line => {
            // The readiness check connects and hangs up, which an HTTPS server logs as a failed handshake
            if (Date.now() < proc.probeNoiseUntil && /TLS handshake error from [\d.]+:\d+: EOF/.test(line)) return;
            proc.recentLines.push(line);
            if (proc.recentLines.length > 5) proc.recentLines.shift();
            pushLog(line);
        };
        collectLines(proc.stdout, onLine);
        collectLines(proc.stderr, onLine);

        return proc;
    }

    function describeExit(proc, port) {
        if (proc.spawnError) return `Could not run rclone: ${proc.spawnError.message}`;
        const lastLine = proc.recentLines[proc.recentLines.length - 1] || '';
        if (proc.recentLines.some(line => PORT_IN_USE.test(line))) {
            return `Port ${port} is already in use. Choose another port or stop whatever is using it.`;
        }
        const reason = lastLine.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /, '');
        return reason ? `rclone stopped: ${reason}` : `rclone stopped with exit code ${proc.exitInfo ? proc.exitInfo.code : 'unknown'}.`;
    }

    function canConnect(host, port) {
        return new Promise(resolve => {
            const socket = net.connect(port, host);
            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => resolve(false));
        });
    }

    async function waitUntilListening(proc, backend) {
        const deadline = Date.now() + READY_TIMEOUT;
        let exited = false;
        proc.exited.then(() => { exited = true; });

        while (Date.now() < deadline) {
            if (exited) throw new ServerError(describeExit(proc, backend.port), 'RCLONE_EXITED');
            if (await canConnect(backend.host, backend.port)) {
                // rclone logs the probe's hang-up a moment after the fact
                proc.probeNoiseUntil = Date.now() + 2000;
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        throw new ServerError('rclone did not start listening in time.', 'RCLONE_TIMEOUT');
    }

    async function killChild() {
        const proc = child;
        child = null;
        if (!proc) return;
        proc.expectedExit = true;
        if (!proc.exitInfo && !proc.spawnError) {
            try {
                proc.kill();
            } catch {
                // Already gone
            }
            await proc.exited;
        }
        removePidFile();
    }

    async function teardown() {
        if (proxy) {
            const closing = proxy;
            proxy = null;
            await closing.stop();
        }
        await killChild();
    }

    function refreshUrls() {
        if (state.status !== 'running') return;
        setState({ urls: Network.buildUrls(state.hosts, state.port, state.https, urlInfo()) });
    }

    async function startNow() {
        if (state.status === 'running' || state.status === 'starting') return;
        setState({ status: 'starting', error: null, errorCode: null, urls: [] });

        const config = Config.getConfig();
        try {
            const plan = await buildPlan(config);
            log(`Eagle Serve: starting rclone for ${plan.storagePath}`);

            const proc = spawnRclone(plan);
            child = proc;
            if (proc.pid) writePidFile(proc.pid);
            proc.exited.then(() => enqueue(async () => {
                // Only an rclone that died while it was serving is news here;
                // a failed start is reported by the catch below
                if (proc.expectedExit || child !== proc || !proc.serving) return;
                const message = describeExit(proc, plan.port);
                log(`Eagle Serve: ${message}`);
                await teardown();
                setState({ status: 'error', error: message, errorCode: 'RCLONE_EXITED', urls: [], pid: null });
            }));

            await waitUntilListening(proc, plan.backend);

            if (plan.filter) {
                proxy = Filter.createProxy({ ...plan.filter, target: plan.backend, log });
                try {
                    await proxy.start();
                } catch (err) {
                    throw new ServerError(
                        PORT_IN_USE.test(err.code || err.message)
                            ? `Port ${plan.port} is already in use. Choose another port or stop whatever is using it.`
                            : `The access filter could not listen on port ${plan.port}: ${err.message}`,
                        'FILTER_FAILED'
                    );
                }
                log(`Eagle Serve: access filter on, allowing ${plan.filter.allowedClients.join(', ')}`);
            }

            if (plan.gateway) {
                proxy = Gateway.create({ ...plan.gateway, target: plan.backend, log });
                try {
                    await proxy.start();
                } catch (err) {
                    throw new ServerError(
                        PORT_IN_USE.test(err.code || err.message)
                            ? `Port ${plan.port} is already in use. Choose another port or stop whatever is using it.`
                            : `Item links could not start: ${err.message}`,
                        'GATEWAY_FAILED'
                    );
                }
                log('Eagle Serve: item links on, items answer at /item/<ID> and /thumbnail/<ID>' +
                    (plan.gateway.allowedClients ? `; access filter on, allowing ${plan.gateway.allowedClients.join(', ')}` : ''));
            }

            proc.serving = true;
            setState({
                status: 'running',
                storagePath: plan.storagePath,
                urlPath: plan.urlPath,
                itemLinks: Boolean(plan.gateway),
                hosts: plan.hosts,
                port: plan.port,
                https: plan.https,
                urls: Network.buildUrls(plan.hosts, plan.port, plan.https, urlInfo(config)),
                rclonePath: plan.rclonePath,
                pid: proc.pid
            });
            log(`Eagle Serve: serving on ${plan.hosts.map(host => Rclone.formatAddr(host, plan.port)).join(', ')}`);

            if (config.bindTailscale) {
                Network.getTailscaleName().then(name => {
                    if (name === tailscaleName) return;
                    tailscaleName = name;
                    refreshUrls();
                });
            }
        } catch (err) {
            if (child) child.expectedExit = true;
            await teardown();
            log(`Eagle Serve: ${err.message}`);
            // Record what was attempted, so the watcher can tell when it is worth retrying
            setState({
                status: 'error',
                error: err.message,
                errorCode: err.code || 'START_FAILED',
                storagePath: '',
                hosts: await resolveHosts(config).catch(() => Network.resolveBindHosts(config)),
                urls: [],
                pid: null
            });
        }
    }

    async function stopNow() {
        if (state.status === 'stopped') return;
        const wasRunning = state.status === 'running';
        setState({ status: 'stopping' });
        await teardown();
        if (wasRunning) log('Eagle Serve: stopped');
        setState({ status: 'stopped', error: null, errorCode: null, urls: [], pid: null });
    }

    function enqueue(task) {
        queue = queue.then(task, task);
        return queue;
    }

    // --- Watching for changes that need a rebind ------------------------------

    async function checkForChanges() {
        if (!wanted || (state.status !== 'running' && state.status !== 'error')) return;

        const config = Config.getConfig();
        // A name that does not resolve right now is no reason to restart
        const hosts = await resolveHosts(config).catch(() => null);
        const hostsChanged = hosts !== null && hosts.join(',') !== state.hosts.join(',');

        // Also covers a start that failed because Eagle had no library ready yet
        let libraryChanged = false;
        if (config.storageMode === 'library' && (state.status === 'running' || state.errorCode === 'NO_STORAGE')) {
            const libraryPath = await getLibraryPath().catch(() => '');
            libraryChanged = Boolean(libraryPath) && libraryPath !== state.storagePath;
        }

        if (hostsChanged || libraryChanged) {
            log(`Eagle Serve: ${libraryChanged ? 'the Eagle library changed' : 'network addresses changed'}, restarting`);
            restart();
        }
    }

    function restart() {
        wanted = true;
        return enqueue(async () => {
            await stopNow();
            await startNow();
        });
    }

    return {
        /**
         * @param {object} options
         * @param {() => Promise<string>} options.getLibraryPath - Path of the library open in Eagle.
         */
        init(options = {}) {
            if (typeof options.getLibraryPath === 'function') getLibraryPath = options.getLibraryPath;
            if (!watchTimer) {
                watchTimer = setInterval(() => checkForChanges().catch(() => {}), WATCH_INTERVAL);
                if (watchTimer.unref) watchTimer.unref();
            }
        },

        getState,

        /** @returns {string[]} The most recent log lines, oldest first. */
        getLogs() {
            return [...logs];
        },

        findRclone,

        /** @param {(state: object) => void} callback */
        onStateChanged(callback) {
            if (typeof callback === 'function') stateListeners.push(callback);
        },

        /** @param {(line: string) => void} callback */
        onLog(callback) {
            if (typeof callback === 'function') logListeners.push(callback);
        },

        /**
         * Kills an rclone left behind by a previous session that did not shut
         * down cleanly (it would still be holding the port).
         * @returns {Promise<void>}
         */
        async cleanupStale() {
            let pid = NaN;
            try {
                pid = parseInt(fs.readFileSync(Config.getPidPath(), 'utf8'), 10);
            } catch {
                return;
            }
            if (await Rclone.killIfRclone(pid)) {
                log(`Eagle Serve: stopped a leftover rclone process (PID ${pid})`);
            }
            removePidFile();
        },

        /** Starts the server with the saved settings. Resolves once it is running or has failed. */
        start() {
            wanted = true;
            return enqueue(startNow);
        },

        stop() {
            wanted = false;
            return enqueue(stopNow);
        },

        restart,

        /** Applies changed settings: restarts only when the server is meant to be up. */
        applyConfig() {
            return wanted ? restart() : Promise.resolve();
        },

        /** Re-checks the open library and network addresses right away. */
        checkForChanges,

        /**
         * Last-moment cleanup for when the plugin window is being torn down
         * and there is no time to wait on anything.
         */
        shutdownSync() {
            wanted = false;
            if (watchTimer) {
                clearInterval(watchTimer);
                watchTimer = null;
            }
            if (proxy) {
                proxy.stop().catch(() => {});
                proxy = null;
            }
            if (child) {
                child.expectedExit = true;
                try {
                    child.kill();
                } catch {
                    // Already gone
                }
                child = null;
                removePidFile();
            }
            setState({ status: 'stopped', error: null, errorCode: null, urls: [], pid: null });
        }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ServerManager;
}
if (typeof window !== 'undefined') {
    window.ServerManager = ServerManager;
}
