/**
 * Certificate Generator for Eagle Serve
 * Creates the self-signed certificate and private key rclone needs to serve
 * HTTPS, as PEM files. Every name and IP the server is reached by goes into the
 * Subject Alternative Names, because clients ignore the Common Name.
 * Port of webdav-server-kit's generate_cert.py, written against Node's crypto
 * module so it needs no OpenSSL install.
 */

const CertManager = (() => {
    const crypto = require('crypto');
    const fs = require('fs');
    const net = require('net');
    const os = require('os');
    const path = require('path');

    const DEFAULT_DAYS = 365;
    const DEFAULT_KEY_BITS = 4096;

    const OID = {
        commonName: '2.5.4.3',
        sha256WithRSA: '1.2.840.113549.1.1.11',
        subjectKeyIdentifier: '2.5.29.14',
        keyUsage: '2.5.29.15',
        subjectAltName: '2.5.29.17',
        basicConstraints: '2.5.29.19',
        extKeyUsage: '2.5.29.37',
        serverAuth: '1.3.6.1.5.5.7.3.1'
    };

    // --- DER encoding ---------------------------------------------------------

    function derLength(length) {
        if (length < 0x80) return Buffer.from([length]);
        const bytes = [];
        for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
        return Buffer.from([0x80 | bytes.length, ...bytes]);
    }

    function tlv(tag, ...parts) {
        const body = Buffer.concat(parts);
        return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
    }

    const sequence = (...parts) => tlv(0x30, ...parts);
    const set = (...parts) => tlv(0x31, ...parts);
    const octetString = body => tlv(0x04, body);
    const bitString = (body, unusedBits = 0) => tlv(0x03, Buffer.from([unusedBits]), body);
    const utf8String = text => tlv(0x0c, Buffer.from(text, 'utf8'));
    const booleanTrue = () => tlv(0x01, Buffer.from([0xff]));
    const nullValue = () => tlv(0x05);
    const explicit = (number, ...parts) => tlv(0xa0 | number, ...parts);

    function integer(bytes) {
        let start = 0;
        while (start < bytes.length - 1 && bytes[start] === 0) start++;
        const trimmed = bytes.subarray(start);
        // A leading zero keeps a value with the high bit set from reading as negative
        return tlv(0x02, trimmed[0] & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
    }

    function oid(dotted) {
        const parts = dotted.split('.').map(Number);
        const bytes = [parts[0] * 40 + parts[1]];
        for (const part of parts.slice(2)) {
            const chunk = [part & 0x7f];
            for (let rest = part >>> 7; rest > 0; rest >>>= 7) chunk.unshift((rest & 0x7f) | 0x80);
            bytes.push(...chunk);
        }
        return tlv(0x06, Buffer.from(bytes));
    }

    function time(date) {
        const pad = value => String(value).padStart(2, '0');
        const stamp = pad(date.getUTCMonth() + 1) + pad(date.getUTCDate()) + pad(date.getUTCHours()) +
            pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + 'Z';
        const year = date.getUTCFullYear();
        // UTCTime only reaches 2049; later dates must use GeneralizedTime
        return year < 2050
            ? tlv(0x17, Buffer.from(pad(year % 100) + stamp, 'ascii'))
            : tlv(0x18, Buffer.from(String(year) + stamp, 'ascii'));
    }

    function ipToBuffer(ip) {
        if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));

        const [head, tail] = ip.split('::');
        const headGroups = head ? head.split(':') : [];
        const tailGroups = tail ? tail.split(':') : [];
        const groups = tail === undefined
            ? headGroups
            : [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];

        const buffer = Buffer.alloc(16);
        groups.forEach((group, index) => buffer.writeUInt16BE(parseInt(group, 16), index * 2));
        return buffer;
    }

    function extension(id, critical, value) {
        return sequence(oid(id), ...(critical ? [booleanTrue()] : []), octetString(value));
    }

    // --- Certificate ----------------------------------------------------------

    /**
     * Trims, drops empties and de-duplicates a list of names, keeping order.
     * @param {string[] | string} names
     * @returns {string[]}
     */
    function normalizeNames(names) {
        const list = Array.isArray(names) ? names : String(names || '').split(/[,\n]/);
        return [...new Set(list.map(name => String(name).trim().replace(/^\[|\]$/g, '')).filter(Boolean))];
    }

    /**
     * The names a certificate for this machine should cover.
     * @param {{ address: string, kind: string }[]} addresses - From NetworkInfo.listAddresses().
     * @param {string} [tailscaleName]
     * @returns {string[]}
     */
    function defaultNames(addresses = [], tailscaleName = '') {
        return normalizeNames([
            'localhost',
            '127.0.0.1',
            '::1',
            os.hostname().toLowerCase(),
            ...addresses.filter(a => a.kind !== 'other').map(a => a.address),
            tailscaleName
        ]);
    }

    /**
     * Generates a self-signed certificate and RSA private key.
     * @param {object} options
     * @param {string[] | string} options.names - DNS names and IPs; the first one becomes the Common Name.
     * @param {number} [options.days]
     * @param {number} [options.keyBits]
     * @returns {Promise<{ certPem: string, keyPem: string, names: string[], notAfter: Date }>}
     */
    async function generate({ names, days = DEFAULT_DAYS, keyBits = DEFAULT_KEY_BITS }) {
        const allNames = normalizeNames(names);
        if (allNames.length === 0) throw new Error('Enter at least one name or IP address for the certificate.');
        const invalid = allNames.find(name => !net.isIP(name) && !/^[a-z0-9*]([a-z0-9.*-]*[a-z0-9])?$/i.test(name));
        if (invalid) throw new Error(`"${invalid}" is not a valid host name or IP address.`);

        const { publicKey, privateKey } = await new Promise((resolve, reject) => {
            crypto.generateKeyPair('rsa', { modulusLength: keyBits }, (err, pub, priv) => {
                if (err) reject(err);
                else resolve({ publicKey: pub, privateKey: priv });
            });
        });

        const publicKeyInfo = publicKey.export({ type: 'spki', format: 'der' });
        const algorithm = sequence(oid(OID.sha256WithRSA), nullValue());
        const name = sequence(set(sequence(oid(OID.commonName), utf8String(allNames[0]))));

        const notBefore = new Date(Date.now() - 60 * 60 * 1000);
        const notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

        const serial = crypto.randomBytes(16);
        serial[0] = (serial[0] & 0x7f) | 0x01;

        // GeneralName: [2] dNSName, [7] iPAddress
        const altNames = allNames.map(entry => net.isIP(entry)
            ? tlv(0x87, ipToBuffer(entry))
            : tlv(0x82, Buffer.from(entry, 'ascii')));

        const extensions = sequence(
            // CA:TRUE is what lets the certificate be installed as a trusted root on iOS and macOS
            extension(OID.basicConstraints, true, sequence(booleanTrue())),
            // digitalSignature, keyEncipherment, keyCertSign
            extension(OID.keyUsage, true, bitString(Buffer.from([0xa4]), 2)),
            extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
            extension(OID.subjectAltName, false, sequence(...altNames)),
            extension(OID.subjectKeyIdentifier, false, octetString(crypto.createHash('sha1').update(publicKeyInfo).digest()))
        );

        const tbsCertificate = sequence(
            explicit(0, integer(Buffer.from([2]))), // X.509 v3
            integer(serial),
            algorithm,
            name,                                   // issuer
            sequence(time(notBefore), time(notAfter)),
            name,                                   // subject (self-signed)
            publicKeyInfo,
            explicit(3, extensions)
        );

        const signature = crypto.sign('sha256', tbsCertificate, privateKey);
        const certificate = sequence(tbsCertificate, algorithm, bitString(signature));

        const body = certificate.toString('base64').match(/.{1,64}/g).join('\n');
        return {
            certPem: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
            keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
            names: allNames,
            notAfter
        };
    }

    /**
     * Generates a certificate and writes server.crt / server.key into a folder.
     * @param {string} dir
     * @param {Parameters<typeof generate>[0]} options
     * @returns {Promise<{ certPath: string, keyPath: string, names: string[], notAfter: Date }>}
     */
    async function generateFiles(dir, options) {
        const result = await generate(options);
        const certPath = path.join(dir, 'server.crt');
        const keyPath = path.join(dir, 'server.key');

        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(certPath, result.certPem);
        fs.writeFileSync(keyPath, result.keyPem, { mode: 0o600 });
        return { certPath, keyPath, names: result.names, notAfter: result.notAfter };
    }

    /**
     * Reads the details worth showing from a PEM certificate file.
     * @param {string} certPath
     * @returns {{ subject: string, names: string[], notAfter: Date, expired: boolean } | null}
     *          Null when the file is missing or is not a certificate.
     */
    function inspect(certPath) {
        try {
            const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
            const notAfter = new Date(cert.validTo);
            const names = (cert.subjectAltName || '').split(',')
                // Node spells the IPv6 loopback out in full
                .map(entry => entry.trim().replace(/^(DNS|IP Address):/, '').replace(/^0:0:0:0:0:0:0:1$/, '::1'))
                .filter(Boolean);
            return {
                subject: cert.subject.replace(/^CN=/, ''),
                names,
                notAfter,
                expired: notAfter.getTime() < Date.now()
            };
        } catch {
            return null;
        }
    }

    return {
        DEFAULT_DAYS,
        DEFAULT_KEY_BITS,
        normalizeNames,
        defaultNames,
        generate,
        generateFiles,
        inspect
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CertManager;
}
if (typeof window !== 'undefined') {
    window.CertManager = CertManager;
}
