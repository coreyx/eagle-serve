/**
 * Item Link Gateway for Eagle Serve
 * An HTTP(S) front door that gives every Eagle item addresses built from its
 * ID alone (/item/<ID> for the file, /thumbnail/<ID> for its thumbnail), so
 * links survive the item or the library being renamed. Requests for an item
 * are pointed at the item's current file and handed to rclone like any other;
 * everything else passes through unchanged.
 * rclone still does all the serving, sign-in included.
 */

const ItemGateway = (() => {
    const fs = require('fs');
    const http = require('http');
    const https = require('https');
    const net = require('net');
    const path = require('path');

    // Support both Electron (script tags) and Node.js (tests)
    const Filter = typeof AccessFilter !== 'undefined' ? AccessFilter : require('./access-filter.js');

    // Address prefix -> which of the item's files it stands for
    const ROUTES = { '/item': 'item', '/thumbnail': 'thumbnail' };
    // Files other plugins keep beside an item that are never the item itself
    const SIDECARS = ['metadata.json', 'extra-links.json'];
    const THUMBNAIL = /_thumbnail\.png$/i;
    const ITEM_ID = /^[A-Za-z0-9]{6,32}$/;
    // Headers that describe one connection and must not be copied onto the next
    const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'upgrade', 'expect'];

    /**
     * Picks the item ID out of a request URL.
     * Accepts /item/<ID>, /item/<ID>/<any file name> (the name is decoration
     * for people and for clients that look at extensions) and /item?id=<ID>,
     * the shape of Eagle's own item links. /thumbnail takes the same three forms.
     * @param {string} url - Request target, e.g. "/item/MV63BVOWOZLV6".
     * @returns {{ kind: 'item' | 'thumbnail', id: string } | null} The ID is '' when it is
     *          missing. Null when this is not an item address.
     */
    function parseItemRequest(url) {
        const queryStart = url.indexOf('?');
        const pathname = queryStart < 0 ? url : url.substring(0, queryStart);
        const segments = pathname.split('/');

        const kind = ROUTES['/' + segments[1]];
        if (!kind) return null;

        if (segments.length <= 2 || (segments.length === 3 && !segments[2])) {
            const query = new URLSearchParams(queryStart < 0 ? '' : url.substring(queryStart + 1));
            return { kind, id: query.get('id') || '' };
        }
        return { kind, id: segments[2] };
    }

    function isFile(filePath) {
        return fs.promises.stat(filePath).then(stats => stats.isFile(), () => false);
    }

    /**
     * Finds the file an item ID currently stands for.
     * @param {string} libraryPath - The .library folder.
     * @param {string} id - Eagle item ID.
     * @param {'item' | 'thumbnail'} [kind] - The item's own file, or the thumbnail Eagle made for it.
     *        Eagle makes no thumbnail for small images; those answer with the file itself.
     * @returns {Promise<string | null>} File name inside images/<ID>.info/, or null when there is no such item.
     */
    async function resolveItemFile(libraryPath, id, kind = 'item') {
        if (!ITEM_ID.test(id)) return null;
        const itemDir = path.join(libraryPath, 'images', `${id}.info`);

        // Eagle records the item's current name and extension here and renames its files to match
        let metadata = {};
        try {
            metadata = JSON.parse(await fs.promises.readFile(path.join(itemDir, 'metadata.json'), 'utf8')) || {};
        } catch {
            // Unreadable metadata: go by what is actually in the folder
        }

        if (metadata.name) {
            const original = metadata.ext ? `${metadata.name}.${metadata.ext}` : String(metadata.name);
            const thumbnail = `${metadata.name}_thumbnail.png`;
            if (kind === 'thumbnail' && await isFile(path.join(itemDir, thumbnail))) return thumbnail;
            if (await isFile(path.join(itemDir, original))) return original;
        }

        let entries;
        try {
            entries = await fs.promises.readdir(itemDir);
        } catch {
            return null;
        }
        const thumbnail = entries.find(name => THUMBNAIL.test(name));
        if (kind === 'thumbnail' && thumbnail) return thumbnail;

        const candidates = entries.filter(name => !SIDECARS.includes(name) && !THUMBNAIL.test(name));
        const extension = metadata.ext ? `.${String(metadata.ext).toLowerCase()}` : '';
        return candidates.find(name => extension && name.toLowerCase().endsWith(extension)) || candidates[0] || null;
    }

    function reply(res, status, message, headers = {}) {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
        res.end(message + '\n');
    }

    /**
     * Creates the gateway.
     * @param {object} options
     * @param {{ host: string, port: number }[]} options.listen - Public addresses to listen on.
     * @param {{ host: string, port: number }} options.target - The rclone backend (plain HTTP).
     * @param {{ certPath: string, keyPath: string } | null} [options.tls] - Serve HTTPS with this certificate.
     * @param {string[] | null} [options.allowedClients] - Only accept these clients; null accepts everyone.
     * @param {string} options.libraryPath - The .library folder being served.
     * @param {string} options.urlPath - Where rclone serves it: '/' or '/<Name>.library/'.
     * @param {(message: string) => void} [options.log]
     * @returns {{ start: () => Promise<void>, stop: () => Promise<void> }}
     */
    function create({ listen, target, tls = null, allowedClients = null, libraryPath, urlPath, log = () => {} }) {
        const agent = new http.Agent({ keepAlive: true });
        const dnsCache = new Map();
        const listeners = [];
        const sockets = new Set();
        let web = null;

        async function handleRequest(req, res) {
            let upstreamPath = req.url;

            const item = parseItemRequest(req.url);
            if (item) {
                const { id } = item;
                if (req.method !== 'GET' && req.method !== 'HEAD') {
                    return reply(res, 405, 'Item links are read-only.', { Allow: 'GET, HEAD' });
                }
                const fileName = await resolveItemFile(libraryPath, id, item.kind);
                if (!fileName) {
                    return reply(res, 404, 'There is no item with this ID in the library being served.');
                }
                upstreamPath = `${urlPath}images/${id}.info/${encodeURIComponent(fileName)}`;
            }

            const headers = { ...req.headers };
            for (const name of HOP_BY_HOP) delete headers[name];

            const upstream = http.request({
                host: target.host,
                port: target.port,
                method: req.method,
                path: upstreamPath,
                headers,
                agent
            }, upstreamRes => {
                const responseHeaders = { ...upstreamRes.headers };
                delete responseHeaders.connection;
                delete responseHeaders['keep-alive'];
                res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, responseHeaders);
                upstreamRes.pipe(res);
            });

            upstream.on('error', err => {
                if (res.headersSent) {
                    res.destroy();
                } else {
                    reply(res, 502, `rclone did not answer: ${err.message}`);
                }
            });
            // A client that hangs up mid-transfer should not leave rclone working for nobody
            res.on('close', () => {
                if (!res.writableEnded) upstream.destroy();
            });
            req.pipe(upstream);
        }

        function createWebServer() {
            const onRequest = (req, res) => {
                handleRequest(req, res).catch(err => {
                    log(`[Item Links] ${req.method} ${req.url} failed: ${err.message}`);
                    if (res.headersSent) res.destroy();
                    else reply(res, 500, 'Eagle Serve could not handle this request.');
                });
            };
            const server = tls
                ? https.createServer({ cert: fs.readFileSync(tls.certPath), key: fs.readFileSync(tls.keyPath) }, onRequest)
                : http.createServer(onRequest);

            // Uploads and large downloads can run for as long as they need
            server.timeout = 0;
            server.requestTimeout = 0;
            server.on('clientError', (err, socket) => socket.destroy());
            return server;
        }

        function accept(socket) {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            socket.on('error', () => {});

            const admit = () => {
                if (socket.destroyed) return;
                // Hands the connection to the HTTP(S) server as if it had accepted it itself
                web.emit('connection', socket);
                socket.resume();
            };
            if (!allowedClients) return admit();

            const ip = Filter.normalizeIp(socket.remoteAddress);
            Filter.isClientAllowed(ip, allowedClients, dnsCache).then(allowed => {
                if (allowed) return admit();
                log(`[Access Filter] Denied connection from ${ip || 'unknown address'} (not in allowed clients)`);
                socket.destroy();
            }).catch(err => {
                log(`[Access Filter] Error checking ${ip}: ${err.message}`);
                socket.destroy();
            });
        }

        function listenOn({ host, port }) {
            return new Promise((resolve, reject) => {
                // Hold incoming bytes while the client is being checked
                const listener = net.createServer({ pauseOnConnect: Boolean(allowedClients) }, accept);
                listener.once('error', reject);
                listener.listen(port, host, () => {
                    listener.removeListener('error', reject);
                    listener.on('error', err => log(`[Item Links] Listener error on ${host}:${port}: ${err.message}`));
                    listeners.push(listener);
                    resolve();
                });
            });
        }

        async function stop() {
            const closing = listeners.splice(0).map(listener => new Promise(resolve => listener.close(resolve)));
            for (const socket of sockets) socket.destroy();
            agent.destroy();
            await Promise.all(closing);
        }

        async function start() {
            try {
                web = createWebServer();
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
        parseItemRequest,
        resolveItemFile,
        create
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ItemGateway;
}
if (typeof window !== 'undefined') {
    window.ItemGateway = ItemGateway;
}
