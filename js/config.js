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
