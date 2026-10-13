/**
 * Network Discovery Module for Eagle Serve
 * Finds this machine's LAN and Tailscale addresses and turns the bind settings
 * into the list of addresses the WebDAV server listens on.
 */

const NetworkInfo = (() => {
    const os = require('os');
    const fs = require('fs');
    const { execFile } = require('child_process');

    // Virtual adapters (WSL, Hyper-V, Docker, VM hosts) are not the LAN
    const VIRTUAL_ADAPTER = /vEthernet|Hyper-V|WSL|VirtualBox|VMware|docker|^br-|^veth|^utun|^bridge|^vmnet|Loopback/i;

    function ipv4ToInt(ip) {
        const parts = String(ip).split('.');
        if (parts.length !== 4) return null;
        let value = 0;
        for (const part of parts) {
            if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
            value = value * 256 + Number(part);
        }
        return value;
    }

    function inRange(ip, base, bits) {
        const value = ipv4ToInt(ip);
        if (value === null) return false;
        const size = Math.pow(2, 32 - bits);
        return Math.floor(value / size) === Math.floor(ipv4ToInt(base) / size);
    }

    /**
     * Tailscale hands out addresses from the CGNAT range 100.64.0.0/10.
     * @param {string} ip
     * @returns {boolean}
     */
    function isTailscaleIp(ip) {
        return inRange(ip, '100.64.0.0', 10);
    }

    function isPrivateIp(ip) {
        return inRange(ip, '10.0.0.0', 8) || inRange(ip, '172.16.0.0', 12) || inRange(ip, '192.168.0.0', 16);
    }

    /**
     * Lists this machine's non-loopback IPv4 addresses with what they are.
     * @param {ReturnType<typeof os.networkInterfaces>} [interfaces]
     * @returns {{ name: string, address: string, kind: 'lan' | 'tailscale' | 'other' }[]}
     */
    function listAddresses(interfaces = os.networkInterfaces()) {
        const result = [];
        for (const [name, entries] of Object.entries(interfaces || {})) {
            for (const entry of entries || []) {
                // family is 'IPv4' on most Node versions and 4 on a few
                if (entry.internal || (entry.family !== 'IPv4' && entry.family !== 4)) continue;

                let kind = 'other';
                if (isTailscaleIp(entry.address) || /tailscale/i.test(name)) {
                    kind = 'tailscale';
                } else if (isPrivateIp(entry.address) && !VIRTUAL_ADAPTER.test(name)) {
                    kind = 'lan';
                }
                result.push({ name, address: entry.address, kind });
            }
        }
        return result;
    }

    /**
     * Resolves the bind settings to the addresses to listen on right now.
     * An address that is configured but not currently present (Tailscale down,
     * Wi-Fi off) is simply left out; the server rebinds when it shows up.
     * @param {object} config
     * @param {ReturnType<typeof listAddresses>} [addresses]
     * @returns {string[]}
     */
    function resolveBindHosts(config, addresses = listAddresses()) {
        const extra = Array.isArray(config.extraHosts) ? config.extraHosts : [];

        // The wildcard already covers every interface, and rclone cannot bind
        // it alongside a specific address on the same port
        if (extra.includes('0.0.0.0')) return ['0.0.0.0'];

        const hosts = ['127.0.0.1'];
        if (config.bindLan) {
            hosts.push(...addresses.filter(a => a.kind === 'lan').map(a => a.address));
        }
        if (config.bindTailscale) {
            hosts.push(...addresses.filter(a => a.kind === 'tailscale').map(a => a.address));
        }
        hosts.push(...extra);
        return [...new Set(hosts)];
    }

    /**
     * Builds the URLs to show for a set of bound addresses.
     * @param {string[]} hosts
     * @param {number} port
     * @param {boolean} https
     * @param {object} [info]
     * @param {ReturnType<typeof listAddresses>} [info.addresses]
     * @param {string} [info.tailscaleName] - MagicDNS name of this computer.
     * @param {string} [info.hostname] - This computer's name.
     * @param {string[]} [info.names] - Other names the user asked to listen on.
     * @returns {{ url: string, label: string }[]}
     */
    function buildUrls(hosts, port, https, info = {}) {
        const addresses = info.addresses || listAddresses();
        const scheme = https ? 'https' : 'http';
        const urlFor = host => `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}/`;
        const urls = [];
        const add = (host, label) => {
            const url = urlFor(host);
            if (!urls.some(entry => entry.url === url)) urls.push({ url, label });
        };

        const expanded = hosts.includes('0.0.0.0')
            ? ['127.0.0.1', ...addresses.filter(a => a.kind !== 'other').map(a => a.address)]
            : hosts;
        const shared = expanded.some(host => host !== '127.0.0.1');

        for (const host of expanded) {
            const known = addresses.find(a => a.address === host);
            let label = 'Custom address';
            if (host === '127.0.0.1') label = 'This computer';
            else if (known && known.kind === 'tailscale') label = 'Tailscale';
            else if (known && known.kind === 'lan') label = 'Local network';
            add(host, label);

            // Other devices find this computer by name on whichever network they share with it
            if (host === '127.0.0.1' && shared && info.hostname) {
                add(info.hostname, 'Computer name');
            }
            if (known && known.kind === 'tailscale' && info.tailscaleName) {
                add(info.tailscaleName, 'Tailscale name');
            }
        }

        for (const name of info.names || []) add(name.toLowerCase(), 'Custom name');
        return urls;
    }

    function tailscaleBinary() {
        const candidates = process.platform === 'win32'
            ? [`${process.env.ProgramFiles || 'C:\\Program Files'}\\Tailscale\\tailscale.exe`]
            : ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale'];
        return candidates.find(candidate => fs.existsSync(candidate)) || 'tailscale';
    }

    /**
     * Asks the Tailscale client for this machine's MagicDNS name
     * (e.g. "desktop.tailnet-name.ts.net"). Resolves to '' when Tailscale is
     * not installed, not running, or has MagicDNS turned off.
     * @returns {Promise<string>}
     */
    function getTailscaleName() {
        return new Promise(resolve => {
            execFile(tailscaleBinary(), ['status', '--json', '--peers=false'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
                if (err) return resolve('');
                try {
                    const name = (JSON.parse(stdout).Self || {}).DNSName || '';
                    resolve(name.replace(/\.$/, ''));
                } catch {
                    resolve('');
                }
            });
        });
    }

    return {
        ipv4ToInt,
        isTailscaleIp,
        isPrivateIp,
        listAddresses,
        resolveBindHosts,
        buildUrls,
        getTailscaleName
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = NetworkInfo;
}
if (typeof window !== 'undefined') {
    window.NetworkInfo = NetworkInfo;
}
