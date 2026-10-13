/**
 * Configuration Manager for Eagle Serve
 * Holds every server setting, validates it, and persists it to config.json
 * in the plugin's data folder (alongside the htpasswd file, certificates,
 * the downloaded rclone binary and the PID file).
 */

const ConfigManager = (() => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    const DEFAULT_CONFIG = {
        autoStart: true,
        // 'library' serves the library currently open in Eagle, 'custom' serves storagePath
        storageMode: 'library',
        storagePath: '',
        // In library mode, serve the library as /<Name>.library/ instead of at the root
        libraryNameInUrl: true,
        // In library mode, also answer at /item/<ID> and /thumbnail/<ID> through the item link gateway
        itemLinksEnabled: false,
        port: 41599,
        // 127.0.0.1 is always bound; these add the LAN and Tailscale addresses
        bindLan: false,
        bindTailscale: false,
        extraHosts: [],
        httpsEnabled: false,
        certPath: '',
        keyPath: '',
        authEnabled: false,
        accessRestrictionEnabled: false,
        allowedClients: ['self'],
        dirCacheTime: '5s',
        // Eagle does not expect its library to change underneath it, so writing is opt-in
        readOnly: true,
        followSymlinks: true,
        // Empty = find rclone automatically
        rclonePath: ''
    };

    const DATA_DIR_NAME = 'eagle-serve';
    // Marks an export file as ours, and lets a later format tell itself apart
    const EXPORT_APP = 'eagle-serve';
    const EXPORT_FORMAT = 1;
    const DURATION = /^(\d+(\.\d+)?(ms|s|m|h))+$/;

    function defaultDataDir() {
        if (process.platform === 'win32') {
            return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), DATA_DIR_NAME);
        }
        if (process.platform === 'darwin') {
            return path.join(os.homedir(), 'Library', 'Application Support', DATA_DIR_NAME);
        }
        return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), DATA_DIR_NAME);
    }

    function toList(value, fallback) {
        if (Array.isArray(value)) {
            return value.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
        }
        if (typeof value === 'string') {
            return value.split(/[,\n]/).map(v => v.trim()).filter(Boolean);
        }
        return [...fallback];
    }

    function unique(list) {
        return [...new Set(list)];
    }

    /**
     * Returns a complete, valid configuration built from untrusted input.
     * @param {Partial<typeof DEFAULT_CONFIG>} input
     * @returns {typeof DEFAULT_CONFIG}
     */
    function sanitize(input) {
        const raw = { ...DEFAULT_CONFIG, ...(input || {}) };
        const config = {};

        config.autoStart = Boolean(raw.autoStart);
        config.storageMode = raw.storageMode === 'custom' ? 'custom' : 'library';
        config.storagePath = typeof raw.storagePath === 'string' ? raw.storagePath.trim() : '';
        config.libraryNameInUrl = Boolean(raw.libraryNameInUrl);
        config.itemLinksEnabled = Boolean(raw.itemLinksEnabled);

        const port = parseInt(raw.port, 10);
        config.port = (isNaN(port) || port < 1 || port > 65535) ? DEFAULT_CONFIG.port : port;

        config.bindLan = Boolean(raw.bindLan);
        config.bindTailscale = Boolean(raw.bindTailscale);

        // 127.0.0.1 is always bound, and rclone crashes when given both it and localhost
        config.extraHosts = unique(toList(raw.extraHosts, DEFAULT_CONFIG.extraHosts))
            .filter(host => !['localhost', '127.0.0.1'].includes(host.toLowerCase()));

        config.httpsEnabled = Boolean(raw.httpsEnabled);
        config.certPath = typeof raw.certPath === 'string' ? raw.certPath.trim() : '';
        config.keyPath = typeof raw.keyPath === 'string' ? raw.keyPath.trim() : '';

        config.authEnabled = Boolean(raw.authEnabled);

        config.accessRestrictionEnabled = Boolean(raw.accessRestrictionEnabled);
        config.allowedClients = unique(toList(raw.allowedClients, DEFAULT_CONFIG.allowedClients));
        if (config.allowedClients.length === 0) {
            config.allowedClients = ['self'];
        }

        // A bare number means seconds, as in webdav-server-kit
        let cacheTime = String(raw.dirCacheTime === undefined || raw.dirCacheTime === null ? '' : raw.dirCacheTime).trim();
        if (/^\d+$/.test(cacheTime)) cacheTime += 's';
        config.dirCacheTime = DURATION.test(cacheTime) ? cacheTime : DEFAULT_CONFIG.dirCacheTime;

        config.readOnly = Boolean(raw.readOnly);
        config.followSymlinks = Boolean(raw.followSymlinks);
        config.rclonePath = typeof raw.rclonePath === 'string' ? raw.rclonePath.trim() : '';

        return config;
    }

    return {
        DEFAULT_CONFIG,
        sanitize,
        defaultDataDir,

        _listeners: [],
        _currentConfig: null,
        _dataDir: null,

        /**
         * Folder holding config.json and everything else the plugin writes.
         * @returns {string}
         */
        getDataDir() {
            return this._dataDir || defaultDataDir();
        },

        /**
         * Points the manager at another data folder (used by the tests).
         * @param {string} dir
         */
        setDataDir(dir) {
            this._dataDir = dir;
            this._currentConfig = null;
        },

        getConfigPath() { return path.join(this.getDataDir(), 'config.json'); },
        getHtpasswdPath() { return path.join(this.getDataDir(), 'htpasswd'); },
        getCertsDir() { return path.join(this.getDataDir(), 'certs'); },
        getBinDir() { return path.join(this.getDataDir(), 'bin'); },
        getPidPath() { return path.join(this.getDataDir(), 'server.pid'); },

        /**
         * The saved settings as the text of an export file. It holds the settings
         * only: users (the htpasswd file) and certificate files are not part of it.
         * @returns {string}
         */
        exportConfig() {
            return JSON.stringify({
                app: EXPORT_APP,
                formatVersion: EXPORT_FORMAT,
                exportedAt: new Date().toISOString(),
                config: this.getConfig()
            }, null, 4) + '\n';
        },

        /**
         * Reads an export file, or a bare config.json, into a complete and valid
         * configuration. Nothing is saved; settings the file leaves out get their defaults.
         * @param {string} text
         * @returns {typeof DEFAULT_CONFIG}
         * @throws {Error} With a message for the user when the text is not Eagle Serve settings.
         */
        importConfig(text) {
            let parsed;
            try {
                parsed = JSON.parse(String(text).replace(/^\uFEFF/, ''));
            } catch {
                throw new Error('This file is not valid JSON.');
            }
            const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
            if (!isObject(parsed)) throw new Error('This file does not contain Eagle Serve settings.');
            if (parsed.app !== undefined && parsed.app !== EXPORT_APP) {
                throw new Error('This file was not exported by Eagle Serve.');
            }
            if (typeof parsed.formatVersion === 'number' && parsed.formatVersion > EXPORT_FORMAT) {
                throw new Error('This file was exported by a newer version of Eagle Serve.');
            }

            const source = isObject(parsed.config) ? parsed.config : parsed;
            const picked = {};
            for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
                const value = source[key];
                if (value === undefined) continue;

                // A value of the wrong kind means the file is not what it claims to be;
                // refuse it rather than quietly import half of it
                let usable = typeof value === typeof fallback;
                if (Array.isArray(fallback)) usable = Array.isArray(value) || typeof value === 'string';
                else if (key === 'port') usable = ['number', 'string'].includes(typeof value) && value !== '' && Number.isInteger(Number(value));
                else if (key === 'dirCacheTime') usable = typeof value === 'string' || typeof value === 'number';
                if (!usable) throw new Error(`The "${key}" setting in this file has a value Eagle Serve cannot use.`);

                picked[key] = value;
            }
            if (Object.keys(picked).length === 0) {
                throw new Error('This file does not contain any Eagle Serve settings.');
            }
            return sanitize(picked);
        },

        /**
         * Retrieves current configuration merged with defaults.
         * @returns {typeof DEFAULT_CONFIG}
         */
        getConfig() {
            if (!this._currentConfig) {
                let stored = {};
                try {
                    stored = JSON.parse(fs.readFileSync(this.getConfigPath(), 'utf8'));
                } catch (err) {
                    if (err.code !== 'ENOENT') {
                        console.error('[ConfigManager] Error loading config.json:', err);
                    }
                }
                this._currentConfig = sanitize(stored);
            }
            return { ...this._currentConfig };
        },

        /**
         * Saves configuration to config.json and notifies listeners.
         * @param {Partial<typeof DEFAULT_CONFIG>} newConfig
         * @returns {typeof DEFAULT_CONFIG}
         */
        saveConfig(newConfig) {
            const updated = sanitize({ ...this.getConfig(), ...newConfig });
            this._currentConfig = updated;

            try {
                fs.mkdirSync(this.getDataDir(), { recursive: true });
                // Write-then-rename so a crash mid-write cannot leave a truncated file
                const tmpPath = this.getConfigPath() + '.tmp';
                fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 4) + '\n');
                fs.renameSync(tmpPath, this.getConfigPath());
            } catch (err) {
                console.error('[ConfigManager] Error writing config.json:', err);
            }

            for (const listener of this._listeners) {
                try {
                    listener({ ...updated });
                } catch (err) {
                    console.error('[ConfigManager] Listener error:', err);
                }
            }

            return { ...updated };
        },

        /**
         * Register a callback when configuration updates.
         * @param {(config: typeof DEFAULT_CONFIG) => void} callback
         */
        onConfigChanged(callback) {
            if (typeof callback === 'function') {
                this._listeners.push(callback);
            }
        }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ConfigManager;
}
if (typeof window !== 'undefined') {
    window.ConfigManager = ConfigManager;
}
