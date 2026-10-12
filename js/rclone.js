/**
 * rclone Manager for Eagle Serve
 * Locates the rclone binary (or downloads the official build), reports its
 * version and builds the "rclone serve webdav" command line.
 */

const RcloneManager = (() => {
    const crypto = require('crypto');
    const fs = require('fs');
    const https = require('https');
    const os = require('os');
    const path = require('path');
    const zlib = require('zlib');
    const { execFile } = require('child_process');

    const IS_WINDOWS = process.platform === 'win32';
    const EXE_NAME = IS_WINDOWS ? 'rclone.exe' : 'rclone';
    const DOWNLOAD_HOST = 'https://downloads.rclone.org';

    function isFile(filePath) {
        try {
            return fs.statSync(filePath).isFile();
        } catch {
            return false;
        }
    }

    function listDirs(dir) {
        try {
            return fs.readdirSync(dir, { withFileTypes: true })
                .filter(entry => entry.isDirectory())
                .map(entry => path.join(dir, entry.name));
        } catch {
            return [];
        }
    }

    /**
     * Folders worth checking besides PATH. Apps started from the Dock or Start
     * menu often get a shorter PATH than a terminal does.
     */
    function extraSearchDirs() {
        const home = os.homedir();
        if (!IS_WINDOWS) {
            return ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/snap/bin', path.join(home, 'bin'), path.join(home, '.local', 'bin')];
        }

        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        const winget = path.join(localAppData, 'Microsoft', 'WinGet');
        // winget unpacks to Packages\Rclone.Rclone_<source>\rclone-v<version>-windows-amd64\
        const wingetPackages = listDirs(path.join(winget, 'Packages'))
            .filter(dir => /rclone/i.test(path.basename(dir)))
            .flatMap(dir => [dir, ...listDirs(dir)]);

        return [
            path.join(winget, 'Links'),
            ...wingetPackages,
            path.join(home, 'scoop', 'shims'),
            path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin'),
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'rclone')
        ];
    }

    /**
     * Finds rclone: the plugin's own downloaded copy first, then PATH, then the
     * usual package manager locations.
     * @param {string} [binDir] - Folder the plugin downloads rclone into.
     * @returns {string | null}
     */
    function find(binDir) {
        const dirs = [
            ...(binDir ? [binDir] : []),
            ...(process.env.PATH || '').split(path.delimiter).filter(Boolean),
            ...extraSearchDirs()
        ];
        for (const dir of dirs) {
            const candidate = path.join(dir, EXE_NAME);
            if (isFile(candidate)) return candidate;
        }
        return null;
    }

    /**
     * @param {string} exePath
     * @returns {Promise<string | null>} e.g. "1.68.2", or null when the file is not a working rclone.
     */
    function getVersion(exePath) {
        return new Promise(resolve => {
            execFile(exePath, ['version'], { timeout: 15000, windowsHide: true }, (err, stdout) => {
                const match = !err && /rclone v(\d+\.\d+(\.\d+)?)/.exec(stdout);
                resolve(match ? match[1] : null);
            });
        });
    }

    function formatAddr(host, port) {
        return `${host.includes(':') ? `[${host}]` : host}:${port}`;
    }

    /**
     * Builds the argument list for "rclone serve webdav".
     * @param {object} options
     * @param {string} options.storagePath - Folder to serve from the WebDAV root.
     * @param {string[]} options.addrs - "host:port" addresses to listen on.
     * @param {string} [options.certPath]
     * @param {string} [options.keyPath]
     * @param {string} [options.htpasswdPath]
     * @param {string} [options.dirCacheTime]
     * @param {boolean} [options.readOnly]
     * @param {boolean} [options.followSymlinks]
     * @returns {string[]}
     */
    function buildArgs(options) {
        // No config file: the server only ever touches the local folder it is given
        const args = ['serve', 'webdav', options.storagePath, '--config', IS_WINDOWS ? 'NUL' : '/dev/null'];

        if (options.followSymlinks) args.push('-L');
        for (const addr of options.addrs) args.push('--addr', addr);
        if (options.certPath && options.keyPath) args.push('--cert', options.certPath, '--key', options.keyPath);
        if (options.htpasswdPath) args.push('--htpasswd', options.htpasswdPath);
        if (options.dirCacheTime) args.push('--dir-cache-time', options.dirCacheTime);
        if (options.readOnly) args.push('--read-only');

        return args;
    }

    // --- Stale process cleanup ------------------------------------------------

    /**
     * @param {number} pid
     * @returns {Promise<boolean>} True when the PID belongs to a running rclone.
     */
    function isRcloneProcess(pid) {
        return new Promise(resolve => {
            const done = (err, stdout) => resolve(!err && /rclone/i.test(stdout));
            if (IS_WINDOWS) {
                execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 10000, windowsHide: true }, done);
            } else {
                execFile('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 10000 }, done);
            }
        });
    }

    /**
     * Kills a previously recorded rclone process, if it is still one.
     * @param {number} pid
     * @returns {Promise<boolean>} True when a process was killed.
     */
    async function killIfRclone(pid) {
        if (!Number.isInteger(pid) || pid <= 0 || !(await isRcloneProcess(pid))) return false;
        try {
            process.kill(pid);
            return true;
        } catch {
            return false;
        }
    }

    // --- Download -------------------------------------------------------------

    function fetchBuffer(url, onProgress, redirectsLeft = 5) {
        return new Promise((resolve, reject) => {
            https.get(url, response => {
                const { statusCode, headers } = response;
                if (statusCode >= 300 && statusCode < 400 && headers.location) {
                    response.resume();
                    if (redirectsLeft === 0) return reject(new Error(`Too many redirects fetching ${url}`));
                    return resolve(fetchBuffer(new URL(headers.location, url).href, onProgress, redirectsLeft - 1));
                }
                if (statusCode !== 200) {
                    response.resume();
                    return reject(new Error(`Download failed: ${url} returned HTTP ${statusCode}`));
                }

                const total = Number(headers['content-length']) || 0;
                const chunks = [];
                let received = 0;
                response.on('data', chunk => {
                    chunks.push(chunk);
                    received += chunk.length;
                    if (onProgress && total) onProgress(received / total);
                });
                response.on('end', () => resolve(Buffer.concat(chunks)));
                response.on('error', reject);
            }).on('error', reject);
        });
    }

    /**
     * Pulls one file out of a zip archive held in memory.
     * @param {Buffer} zip
     * @param {(name: string) => boolean} matches
     * @returns {Promise<Buffer>}
     */
    function extractZipEntry(zip, matches) {
        const END_SIGNATURE = 0x06054b50;
        const CENTRAL_SIGNATURE = 0x02014b50;

        // The end-of-central-directory record sits at the tail, before an optional comment
        let end = zip.length - 22;
        while (end >= 0 && zip.readUInt32LE(end) !== END_SIGNATURE) end--;
        if (end < 0) return Promise.reject(new Error('Not a zip archive.'));

        const count = zip.readUInt16LE(end + 10);
        let offset = zip.readUInt32LE(end + 16);

        for (let i = 0; i < count; i++) {
            if (zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
            const method = zip.readUInt16LE(offset + 10);
            const compressedSize = zip.readUInt32LE(offset + 20);
            const size = zip.readUInt32LE(offset + 24);
            const nameLength = zip.readUInt16LE(offset + 28);
            const extraLength = zip.readUInt16LE(offset + 30);
            const commentLength = zip.readUInt16LE(offset + 32);
            const localOffset = zip.readUInt32LE(offset + 42);
            const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);

            if (matches(name)) {
                const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
                const data = zip.subarray(dataStart, dataStart + compressedSize);
                if (method === 0) return Promise.resolve(Buffer.from(data));
                if (method !== 8) return Promise.reject(new Error(`Unsupported zip compression method ${method}.`));

                return new Promise((resolve, reject) => {
                    zlib.inflateRaw(data, (err, result) => {
                        if (err) return reject(err);
                        if (result.length !== size) return reject(new Error(`${name} did not unpack to its recorded size.`));
                        resolve(result);
                    });
                });
            }
            offset += 46 + nameLength + extraLength + commentLength;
        }
        return Promise.reject(new Error('The file was not found in the zip archive.'));
    }

    /**
     * Name of the official release archive for a platform, e.g.
     * "rclone-v1.68.2-windows-amd64.zip".
     * @param {string} version
     * @param {string} [platform]
     * @param {string} [arch]
     * @returns {string}
     */
    function archiveName(version, platform = process.platform, arch = process.arch) {
        const osName = { win32: 'windows', darwin: 'osx', linux: 'linux' }[platform];
        const archName = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[arch];
        if (!osName || !archName) throw new Error(`There is no rclone download for ${platform} ${arch}.`);
        return `rclone-v${version}-${osName}-${archName}.zip`;
    }

    /**
     * Downloads the current official rclone release into binDir, checking it
     * against the published SHA-256 sums.
     * @param {string} binDir
     * @param {(fraction: number) => void} [onProgress]
     * @returns {Promise<{ path: string, version: string }>}
     */
    async function download(binDir, onProgress) {
        const versionText = (await fetchBuffer(`${DOWNLOAD_HOST}/version.txt`)).toString('utf8');
        const match = /v(\d+\.\d+\.\d+)/.exec(versionText);
        if (!match) throw new Error('Could not read the current rclone version from downloads.rclone.org.');
        const version = match[1];

        const archive = archiveName(version);
        const sums = (await fetchBuffer(`${DOWNLOAD_HOST}/v${version}/SHA256SUMS`)).toString('utf8');
        const sumLine = sums.split(/\r?\n/).find(line => line.trim().endsWith(archive));
        if (!sumLine) throw new Error(`No checksum is published for ${archive}.`);

        const zip = await fetchBuffer(`${DOWNLOAD_HOST}/v${version}/${archive}`, onProgress);
        const actual = crypto.createHash('sha256').update(zip).digest('hex');
        if (actual !== sumLine.trim().split(/\s+/)[0].toLowerCase()) {
            throw new Error(`The download of ${archive} is corrupt (checksum mismatch).`);
        }

        const binary = await extractZipEntry(zip, name => name.endsWith(`/${EXE_NAME}`));
        const target = path.join(binDir, EXE_NAME);
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(target + '.tmp', binary, { mode: 0o755 });
        fs.renameSync(target + '.tmp', target);

        return { path: target, version };
    }

    return {
        EXE_NAME,
        find,
        getVersion,
        formatAddr,
        buildArgs,
        isRcloneProcess,
        killIfRclone,
        extractZipEntry,
        archiveName,
        download
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = RcloneManager;
}
if (typeof window !== 'undefined') {
    window.RcloneManager = RcloneManager;
}
