/**
 * Access Filter for Eagle Serve
 * A transparent TCP proxy that sits on the public port and only forwards
 * connections from allowed clients to the rclone backend on a loopback port.
 * TLS, authentication and every WebDAV verb pass straight through.
 * Port of webdav-server-kit's access_filter.py.
 */

const AccessFilter = (() => {
    const net = require('net');
    const dns = require('dns');
    const os = require('os');

    const DNS_CACHE_TTL = 60 * 1000;

    /**
     * Normalizes an IP address (handling IPv4-mapped IPv6 addresses and zone ids).
     * @param {string} ip
     * @returns {string}
     */
    function normalizeIp(ip) {
        if (!ip) return '';
        let cleaned = String(ip).trim().toLowerCase();
        if (cleaned.startsWith('::ffff:') && net.isIPv4(cleaned.substring(7))) {
            cleaned = cleaned.substring(7);
        }
        const zone = cleaned.indexOf('%');
        return zone >= 0 ? cleaned.substring(0, zone) : cleaned;
    }

    function family(ip) {
        return net.isIPv6(ip) ? 'ipv6' : 'ipv4';
    }

    function isLoopback(ip) {
        return ip === '::1' || (net.isIPv4(ip) && ip.startsWith('127.'));
    }

    function sameAddress(a, b) {
        if (a === b) return true;
        // Compare IPv6 by value, since "::1" and "0:0:0:0:0:0:0:1" are the same address
        if (!net.isIPv6(a) || !net.isIPv6(b)) return false;
        const list = new net.BlockList();
        list.addAddress(a, 'ipv6');
        return list.check(b, 'ipv6');
    }

    function inSubnet(ip, rule) {
        const slash = rule.lastIndexOf('/');
        const prefix = normalizeIp(rule.substring(0, slash));
        const bits = Number(rule.substring(slash + 1));
        if (!net.isIP(prefix) || !Number.isInteger(bits)) return false;
        try {
            const list = new net.BlockList();
            list.addSubnet(prefix, bits, family(prefix));
            return list.check(ip, family(ip));
        } catch {
            return false;
        }
    }

    /**
     * Every address assigned to this machine, loopback included.
     * @returns {Set<string>}
     */
    function getLocalIps() {
        const ips = new Set(['127.0.0.1', '::1']);
        for (const entries of Object.values(os.networkInterfaces() || {})) {
            for (const entry of entries || []) {
                ips.add(normalizeIp(entry.address));
            }
        }
        return ips;
    }

    function cached(cache, key, lookup) {
        const hit = cache.get(key);
        if (hit && hit.expiry > Date.now()) return hit.value;

        // Cache the promise so concurrent connections share one lookup
        const value = lookup().catch(() => new Set());
        cache.set(key, { expiry: Date.now() + DNS_CACHE_TTL, value });
        return value;
    }

    function forwardLookup(hostname, cache) {
        return cached(cache, `fwd:${hostname}`, async () => {
            const records = await dns.promises.lookup(hostname, { all: true });
            return new Set(records.map(record => normalizeIp(record.address)));
        });
    }

    function reverseLookup(ip, cache) {
        return cached(cache, `rev:${ip}`, async () => {
            const names = new Set();
            for (const name of await dns.promises.reverse(ip)) {
                const lower = name.toLowerCase();
                names.add(lower);
                // Also match the short name of an FQDN ("myhost" from "myhost.local")
                if (lower.includes('.')) names.add(lower.split('.')[0]);
            }
            return names;
        });
    }

    async function matchHostname(ip, hostname, cache) {
        const resolved = await forwardLookup(hostname, cache);
        for (const address of resolved) {
            if (sameAddress(address, ip)) return true;
        }
        const names = await reverseLookup(ip, cache);
        return names.has(hostname) || names.has(hostname.split('.')[0]);
    }

    /**
     * Checks a client address against the allowed clients rules. A rule is
     * "self" (any address of this machine), an IP, a CIDR range or a hostname.
     * @param {string} clientIp
     * @param {string[]} rules
     * @param {Map<string, object>} [cache] - DNS cache shared between calls.
     * @returns {Promise<boolean>}
     */
    async function isClientAllowed(clientIp, rules, cache = new Map()) {
        const ip = normalizeIp(clientIp);
        if (!net.isIP(ip)) return false;

        const hostnames = [];
        for (const rawRule of rules || []) {
            const rule = String(rawRule || '').trim().toLowerCase();
            if (!rule) continue;

            if (rule === 'self' || rule === 'local') {
                if (isLoopback(ip) || getLocalIps().has(ip)) return true;
                continue;
            }

            // 127.0.0.1, ::1 and localhost all mean the loopback interface
            if (isLoopback(ip) && ['127.0.0.1', '::1', 'localhost', 'loopback'].includes(rule)) {
                return true;
            }

            if (rule.includes('/')) {
                if (inSubnet(ip, rule)) return true;
                continue;
            }

            if (net.isIP(rule)) {
                if (sameAddress(normalizeIp(rule), ip)) return true;
                continue;
            }

            hostnames.push(rule);
        }

        // Hostnames need DNS, so they are only consulted when nothing cheaper matched
        const matches = await Promise.all(hostnames.map(hostname => matchHostname(ip, hostname, cache)));
        return matches.includes(true);
    }

    /**
     * Creates the filtering proxy.
     * @param {object} options
     * @param {{ host: string, port: number }[]} options.listen - Public addresses to listen on.
     * @param {{ host: string, port: number }} options.target - The rclone backend.
     * @param {string[]} options.allowedClients
     * @param {(message: string) => void} [options.log]
     * @returns {{ start: () => Promise<void>, stop: () => Promise<void> }}
     */
    function createProxy({ listen, target, allowedClients, log = () => {} }) {
        const cache = new Map();
        const servers = [];
        const sockets = new Set();

        function track(socket) {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
        }

        function handleConnection(client) {
            track(client);
            client.on('error', () => {});
            const ip = normalizeIp(client.remoteAddress);

            isClientAllowed(ip, allowedClients, cache).then(allowed => {
                if (client.destroyed) return;
                if (!allowed) {
                    log(`[Access Filter] Denied connection from ${ip || 'unknown address'} (not in allowed clients)`);
                    client.destroy();
                    return;
                }

                const upstream = net.connect(target.port, target.host);
                let connected = false;
                track(upstream);
                upstream.on('connect', () => {
                    connected = true;
                    client.pipe(upstream);
                    upstream.pipe(client);
                });
                upstream.on('error', err => {
                    // Once connected, an error is just one side hanging up mid-transfer
                    if (!connected) {
                        log(`[Access Filter] Could not reach the rclone backend at ${target.host}:${target.port}: ${err.message}`);
                    }
                    client.destroy();
                });
                client.on('error', () => upstream.destroy());
                client.on('close', () => upstream.end());
                upstream.on('close', () => client.end());
            }).catch(err => {
                log(`[Access Filter] Error checking ${ip}: ${err.message}`);
                client.destroy();
            });
        }

        function listenOn({ host, port }) {
            return new Promise((resolve, reject) => {
                // Hold incoming bytes until the client has been checked
                const server = net.createServer({ pauseOnConnect: true }, handleConnection);
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.removeListener('error', reject);
                    server.on('error', err => log(`[Access Filter] Listener error on ${host}:${port}: ${err.message}`));
                    servers.push(server);
                    resolve();
                });
            });
        }

        async function stop() {
            const closing = servers.splice(0).map(server => new Promise(resolve => server.close(resolve)));
            for (const socket of sockets) socket.destroy();
            await Promise.all(closing);
        }

        async function start() {
            try {
                for (const endpoint of listen) {
                    await listenOn(endpoint);
                }
            } catch (err) {
                await stop();
                throw err;
            }
        }

        return { start, stop };
    }

    return {
        normalizeIp,
        isLoopback,
        getLocalIps,
        isClientAllowed,
        createProxy
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AccessFilter;
}
if (typeof window !== 'undefined') {
    window.AccessFilter = AccessFilter;
}
