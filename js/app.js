/**
 * Window Controller for Eagle Serve
 * Starts the WebDAV server along with Eagle, shows its status and addresses,
 * and binds the settings form to ConfigManager.
 */

(function () {
    const path = require('path');

    const hasEagle = typeof eagle !== 'undefined';
    const THEMES = ['LIGHT', 'LIGHTGRAY', 'GRAY', 'DARK', 'BLUE', 'PURPLE'];
    const $ = id => document.getElementById(id);

    let savedConfig = ConfigManager.getConfig();
    let libraryPath = '';
    let addresses = [];
    let tailscaleName = '';
    // A regenerated certificate keeps its file paths, so the form alone cannot tell it needs a restart
    let certReplaced = false;
    let logRenderPending = false;

    // --- Eagle helpers --------------------------------------------------------

    async function getLibraryPath() {
        if (!hasEagle || !eagle.library) return '';
        try {
            return (await eagle.library.path) || '';
        } catch {
            return '';
        }
    }

    async function pickPath(options) {
        if (!hasEagle || !eagle.dialog) return null;
        const result = await eagle.dialog.showOpenDialog(options);
        return result && !result.canceled && result.filePaths.length ? result.filePaths[0] : null;
    }

    async function pickSavePath(options) {
        if (!hasEagle || !eagle.dialog) return null;
        const result = await eagle.dialog.showSaveDialog(options);
        return result && !result.canceled && result.filePath ? result.filePath : null;
    }

    async function copyText(text) {
        if (hasEagle && eagle.clipboard && eagle.clipboard.writeText) {
            await eagle.clipboard.writeText(text);
        } else {
            await navigator.clipboard.writeText(text);
        }
    }

    function applyTheme(theme) {
        let name = String(theme || '').toUpperCase();
        if (!THEMES.includes(name)) {
            // "Auto" follows the system; ask Eagle which way it went
            const dark = !hasEagle || !eagle.app.isDarkColors || eagle.app.isDarkColors();
            name = dark ? 'GRAY' : 'LIGHT';
        }
        document.body.setAttribute('theme', name);
    }

    // --- Settings form --------------------------------------------------------

    function readForm() {
        return {
            storageMode: $('storage-custom').checked ? 'custom' : 'library',
            storagePath: $('storage-path').value,
            libraryNameInUrl: $('library-name-in-url').checked,
            itemLinksEnabled: $('item-links-enabled').checked,
            autoStart: $('auto-start').checked,
            readOnly: $('read-only').checked,
            port: $('port').value,
            bindLan: $('bind-lan').checked,
            bindTailscale: $('bind-tailscale').checked,
            extraHosts: $('extra-hosts').value,
            httpsEnabled: $('https-enabled').checked,
            certPath: $('cert-path').value,
            keyPath: $('key-path').value,
            authEnabled: $('auth-enabled').checked,
            accessRestrictionEnabled: $('access-enabled').checked,
            allowedClients: $('allowed-clients').value,
            dirCacheTime: $('dir-cache-time').value,
            followSymlinks: $('follow-symlinks').checked,
            rclonePath: $('rclone-path').value
        };
    }

    function writeForm(config) {
        $('storage-library').checked = config.storageMode !== 'custom';
        $('storage-custom').checked = config.storageMode === 'custom';
        $('storage-path').value = config.storagePath;
        $('library-name-in-url').checked = config.libraryNameInUrl;
        $('item-links-enabled').checked = config.itemLinksEnabled;
        $('auto-start').checked = config.autoStart;
        $('read-only').checked = config.readOnly;
        $('port').value = config.port;
        $('bind-lan').checked = config.bindLan;
        $('bind-tailscale').checked = config.bindTailscale;
        $('extra-hosts').value = config.extraHosts.join(', ');
        $('https-enabled').checked = config.httpsEnabled;
        $('cert-path').value = config.certPath;
        $('key-path').value = config.keyPath;
        $('auth-enabled').checked = config.authEnabled;
        $('access-enabled').checked = config.accessRestrictionEnabled;
        $('allowed-clients').value = config.allowedClients.join('\n');
        $('dir-cache-time').value = config.dirCacheTime;
        $('follow-symlinks').checked = config.followSymlinks;
        $('rclone-path').value = config.rclonePath;
    }

    function isDirty() {
        return certReplaced || JSON.stringify(ConfigManager.sanitize(readForm())) !== JSON.stringify(savedConfig);
    }

    function isValidPort(value) {
        const port = Number(value);
        return Number.isInteger(port) && port >= 1 && port <= 65535;
    }

    function toggleSection(id, on) {
        if (on) $(id).removeAttribute('data-off');
        else $(id).setAttribute('data-off', '');
    }

    function updateFormState() {
        const form = ConfigManager.sanitize(readForm());

        $('storage-custom-row').hidden = form.storageMode !== 'custom';
        $('library-name-row').hidden = form.storageMode === 'custom';
        $('item-links-row').hidden = form.storageMode === 'custom';
        toggleSection('https-fields', form.httpsEnabled);
        toggleSection('auth-fields', form.authEnabled);
        toggleSection('access-fields', form.accessRestrictionEnabled);

        const portValid = isValidPort($('port').value);
        $('port').setAttribute('aria-invalid', String(!portValid));
        $('port-error').hidden = portValid;

        // Say so when the folder is about to be open to other machines with nothing guarding it
        const shared = form.bindLan || form.bindTailscale || form.extraHosts.length > 0;
        const unguarded = shared && !form.authEnabled && !form.accessRestrictionEnabled;
        $('open-warning').hidden = !unguarded;
        $('open-warning').textContent = form.readOnly
            ? 'Anyone who can reach these addresses can open this folder. Turn on sign-in or limit the allowed devices.'
            : 'Anyone who can reach these addresses can open and change this folder. Turn on sign-in or limit the allowed devices.';
        $('auth-warning').hidden = !(shared && form.authEnabled && !form.httpsEnabled);

        const status = ServerManager.getState().status;
        $('save-bar').hidden = !isDirty();
        $('save-btn').textContent = status === 'stopped' ? 'Save' : 'Save and restart';
    }

    async function save() {
        if (!isValidPort($('port').value)) {
            $('port').focus();
            return;
        }
        savedConfig = ConfigManager.saveConfig(readForm());
        certReplaced = false;
        writeForm(savedConfig);
        updateFormState();
        renderCertInfo();
        renderRcloneInfo();
        await ServerManager.applyConfig();
    }

    function discard() {
        certReplaced = false;
        writeForm(savedConfig);
        updateFormState();
        renderCertInfo();
    }

    // --- Status ---------------------------------------------------------------

    function folderName(folderPath) {
        return path.basename(folderPath || '').replace(/\.library$/i, '');
    }

    function renderStatus(state) {
        $('status').dataset.status = state.status;

        const title = {
            running: `Serving ${folderName(state.storagePath) || 'folder'}`,
            starting: 'Starting…',
            stopping: 'Stopping…',
            stopped: 'Server is stopped',
            error: 'Server is not running'
        }[state.status];
        $('status-title').textContent = title;
        $('status-detail').textContent = state.status === 'running' ? state.storagePath : '';
        const notes = [];
        if (state.urlPath !== '/') notes.push(`Its files are under ${decodeURIComponent(state.urlPath)} at each address.`);
        if (state.itemLinks) notes.push('Every item also answers at /item/<item ID> and /thumbnail/<item ID>.');
        $('status-path').hidden = state.status !== 'running' || notes.length === 0;
        $('status-path').textContent = notes.join(' ');

        const toggle = $('toggle-btn');
        toggle.textContent = state.status === 'running' ? 'Stop server' : 'Start server';
        toggle.disabled = state.status === 'starting' || state.status === 'stopping';

        const list = $('url-list');
        list.textContent = '';
        for (const entry of state.urls) {
            const row = document.createElement('li');
            row.className = 'url-row';

            const url = document.createElement('span');
            url.className = 'url';
            url.textContent = entry.url;

            const label = document.createElement('span');
            label.className = 'url-label';
            label.textContent = entry.label;

            const copy = document.createElement('button');
            copy.type = 'button';
            copy.className = 'btn btn-small';
            copy.textContent = 'Copy';
            copy.setAttribute('aria-label', `Copy ${entry.url}`);
            copy.addEventListener('click', async () => {
                await copyText(entry.url);
                copy.textContent = 'Copied';
                setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
            });

            row.append(url, label, copy);
            list.append(row);
        }

        const rcloneMissing = state.status === 'error' && state.errorCode === 'RCLONE_MISSING' && !savedConfig.rclonePath;
        $('rclone-missing').hidden = !rcloneMissing;
        $('status-error').hidden = state.status !== 'error' || rcloneMissing;
        $('status-error').textContent = state.error || '';

        updateFormState();
    }

    function renderLibrary() {
        $('library-path').textContent = libraryPath || 'No library is open.';
        const folder = path.basename(libraryPath) || 'Name.library';
        $('library-name-hint').textContent = `Files are served under /${folder}/, so a link keeps meaning this library whichever one is open. Off serves them at the top level.`;
    }

    function renderNetwork() {
        addresses = NetworkInfo.listAddresses();
        const lan = addresses.filter(a => a.kind === 'lan').map(a => a.address);
        const tailscale = addresses.filter(a => a.kind === 'tailscale').map(a => a.address);

        $('lan-detail').textContent = lan.length ? lan.join(', ') : 'not connected';
        $('tailscale-detail').textContent = tailscale.length
            ? tailscale.join(', ') + (tailscaleName ? `  ${tailscaleName}` : '')
            : 'not running';
    }

    function renderLog() {
        if (logRenderPending || !$('log-details').open) return;
        logRenderPending = true;
        requestAnimationFrame(() => {
            logRenderPending = false;
            const output = $('log-output');
            output.textContent = ServerManager.getLogs().join('\n');
            output.scrollTop = output.scrollHeight;
        });
    }

    // --- HTTPS certificate ----------------------------------------------------

    function renderCertInfo() {
        const certPath = $('cert-path').value.trim();
        const info = $('cert-info');
        if (!certPath) {
            info.textContent = '';
            return;
        }

        const cert = CertManager.inspect(certPath);
        if (!cert) {
            info.textContent = 'This file is missing or is not a PEM certificate.';
            return;
        }
        const date = cert.notAfter.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
        const covers = cert.names.length ? `Covers ${cert.names.join(', ')}. ` : '';
        info.textContent = covers + (cert.expired ? `Expired on ${date}.` : `Expires on ${date}.`);
    }

    async function generateCertificate() {
        const button = $('cert-generate-btn');
        const message = $('cert-message');
        button.disabled = true;
        button.textContent = 'Generating…';
        message.textContent = '';

        try {
            const files = await CertManager.generateFiles(ConfigManager.getCertsDir(), { names: $('cert-names').value });
            $('cert-path').value = files.certPath;
            $('key-path').value = files.keyPath;
            certReplaced = true;
            $('cert-reveal-btn').hidden = false;
            message.textContent = 'Certificate generated. Save to start using it.';
            renderCertInfo();
            updateFormState();
        } catch (err) {
            message.textContent = err.message;
        } finally {
            button.disabled = false;
            button.textContent = 'Generate certificate';
        }
    }

    // --- Users ----------------------------------------------------------------

    function renderUsers() {
        const list = $('user-list');
        list.textContent = '';

        let users = [];
        try {
            users = HtpasswdManager.listUsers(ConfigManager.getHtpasswdPath());
        } catch (err) {
            $('user-message').textContent = err.message;
        }

        for (const username of users) {
            const row = document.createElement('li');
            row.className = 'user-row';

            const name = document.createElement('span');
            name.className = 'user-name';
            name.textContent = username;

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'btn btn-small';
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', `Remove ${username}`);
            remove.addEventListener('click', () => {
                HtpasswdManager.deleteUser(ConfigManager.getHtpasswdPath(), username);
                $('user-message').textContent = `Removed ${username}.`;
                renderUsers();
            });

            row.append(name, remove);
            list.append(row);
        }
    }

    async function addUser(event) {
        event.preventDefault();
        const button = $('user-add-btn');
        const message = $('user-message');
        const username = $('user-name').value.trim();
        const password = $('user-password').value;

        const problem = HtpasswdManager.validateUsername(username) || (password ? null : 'Enter a password.');
        if (problem) {
            message.textContent = problem;
            return;
        }

        button.disabled = true;
        button.textContent = 'Adding…';
        try {
            const updated = await HtpasswdManager.setUser(ConfigManager.getHtpasswdPath(), username, password);
            message.textContent = updated ? `Changed the password for ${username}.` : `Added ${username}.`;
            $('user-name').value = '';
            $('user-password').value = '';
            renderUsers();

            // A server that refused to start for lack of users can start now
            if (ServerManager.getState().errorCode === 'NO_USERS') ServerManager.start();
        } catch (err) {
            message.textContent = err.message;
        } finally {
            button.disabled = false;
            button.textContent = 'Add user';
        }
    }

    // --- rclone ---------------------------------------------------------------

    async function renderRcloneInfo() {
        const info = $('rclone-info');
        const rclonePath = ServerManager.findRclone(savedConfig);
        if (!rclonePath) {
            info.textContent = savedConfig.rclonePath ? 'There is no file at this path.' : 'rclone was not found on this computer.';
            return;
        }
        const version = await RcloneManager.getVersion(rclonePath);
        info.textContent = version ? `Using ${rclonePath} (v${version}).` : `${rclonePath} did not run as rclone.`;
    }

    async function downloadRclone(button) {
        const label = button.textContent;
        const buttons = [$('rclone-download-btn'), $('rclone-update-btn')];
        buttons.forEach(each => { each.disabled = true; });

        const state = ServerManager.getState();
        const wasServing = state.status === 'running' || state.status === 'starting';
        try {
            // A running rclone.exe cannot be replaced on Windows
            if (wasServing) await ServerManager.stop();

            button.textContent = 'Downloading…';
            const result = await RcloneManager.download(ConfigManager.getBinDir(), fraction => {
                button.textContent = `Downloading… ${Math.round(fraction * 100)}%`;
            });
            $('rclone-info').textContent = `Downloaded rclone v${result.version}.`;

            if (wasServing || state.errorCode === 'RCLONE_MISSING') await ServerManager.start();
        } catch (err) {
            $('status-error').hidden = false;
            $('status-error').textContent = `rclone could not be downloaded: ${err.message}`;
            if (wasServing) await ServerManager.start();
        } finally {
            button.textContent = label;
            buttons.forEach(each => { each.disabled = false; });
            renderRcloneInfo();
        }
    }

    async function locateRclone() {
        const chosen = await pickPath({ title: 'Choose the rclone program', properties: ['openFile'] });
        if (!chosen) return;
        savedConfig = ConfigManager.saveConfig({ rclonePath: chosen });
        $('rclone-path').value = chosen;
        updateFormState();
        renderRcloneInfo();
        ServerManager.start();
    }

    // --- Export and import ----------------------------------------------------

    const SETTINGS_FILTERS = [{ name: 'Eagle Serve settings', extensions: ['json'] }];

    async function exportSettings() {
        const message = $('settings-message');
        try {
            const target = await pickSavePath({
                title: 'Export Eagle Serve settings',
                defaultPath: 'eagle-serve-settings.json',
                filters: SETTINGS_FILTERS
            });
            if (!target) return;

            require('fs').writeFileSync(target, ConfigManager.exportConfig());
            // The file holds what is in effect, not what is still being edited
            message.textContent = `Exported to ${target}.` +
                (isDirty() ? ' Unsaved changes on this page were not included.' : '');
        } catch (err) {
            message.textContent = `The settings could not be exported: ${err.message}`;
        }
    }

    async function importSettings() {
        const message = $('settings-message');
        try {
            const source = await pickPath({
                title: 'Import Eagle Serve settings',
                properties: ['openFile'],
                filters: [...SETTINGS_FILTERS, { name: 'All files', extensions: ['*'] }]
            });
            if (!source) return;

            const imported = ConfigManager.importConfig(require('fs').readFileSync(source, 'utf8'));
            // Imported settings land in the form like any other edit, to be checked before they take effect
            certReplaced = false;
            writeForm(imported);
            updateFormState();
            renderCertInfo();
            message.textContent = isDirty()
                ? `Loaded ${source}. Check the settings, then save to apply them.`
                : `${source} matches the current settings.`;
        } catch (err) {
            message.textContent = `The settings could not be imported: ${err.message}`;
        }
    }

    // --- Wiring ---------------------------------------------------------------

    async function browseInto(inputId, options) {
        const chosen = await pickPath(options);
        if (!chosen) return;
        $(inputId).value = chosen;
        updateFormState();
        if (inputId === 'cert-path') renderCertInfo();
    }

    function bindEvents() {
        $('toggle-btn').addEventListener('click', () => {
            if (ServerManager.getState().status === 'running') ServerManager.stop();
            else ServerManager.start();
        });

        // Every form control feeds the unsaved-changes state
        const main = document.querySelector('.settings');
        main.addEventListener('input', event => {
            if (event.target.closest('#user-form, #cert-generator')) return;
            updateFormState();
        });
        main.addEventListener('change', event => {
            if (event.target.closest('#user-form, #cert-generator')) return;
            updateFormState();
        });

        $('save-btn').addEventListener('click', save);
        $('discard-btn').addEventListener('click', discard);

        $('storage-browse-btn').addEventListener('click', () => {
            $('storage-custom').checked = true;
            browseInto('storage-path', { title: 'Choose the folder to serve', properties: ['openDirectory'] });
        });
        $('cert-browse-btn').addEventListener('click', () => browseInto('cert-path', {
            title: 'Choose the certificate',
            properties: ['openFile'],
            filters: [{ name: 'Certificates', extensions: ['crt', 'pem', 'cer'] }, { name: 'All files', extensions: ['*'] }]
        }));
        $('key-browse-btn').addEventListener('click', () => browseInto('key-path', {
            title: 'Choose the private key',
            properties: ['openFile'],
            filters: [{ name: 'Private keys', extensions: ['key', 'pem'] }, { name: 'All files', extensions: ['*'] }]
        }));
        $('rclone-browse-btn').addEventListener('click', () => browseInto('rclone-path', {
            title: 'Choose the rclone program',
            properties: ['openFile']
        }));

        $('cert-path').addEventListener('change', renderCertInfo);
        $('cert-generator').addEventListener('toggle', () => {
            if ($('cert-generator').open && !$('cert-names').value.trim()) {
                $('cert-names').value = CertManager.defaultNames(addresses, tailscaleName).join(', ');
            }
        });
        $('cert-generate-btn').addEventListener('click', generateCertificate);
        $('cert-reveal-btn').addEventListener('click', () => {
            if (hasEagle && eagle.shell) eagle.shell.showItemInFolder($('cert-path').value);
        });

        $('user-form').addEventListener('submit', addUser);

        $('rclone-download-btn').addEventListener('click', event => downloadRclone(event.currentTarget));
        $('rclone-update-btn').addEventListener('click', event => downloadRclone(event.currentTarget));
        $('rclone-locate-btn').addEventListener('click', locateRclone);
        $('settings-export-btn').addEventListener('click', exportSettings);
        $('settings-import-btn').addEventListener('click', importSettings);
        $('data-folder-btn').addEventListener('click', () => {
            require('fs').mkdirSync(ConfigManager.getDataDir(), { recursive: true });
            if (hasEagle && eagle.shell) eagle.shell.openPath(ConfigManager.getDataDir());
        });

        $('log-details').addEventListener('toggle', renderLog);
    }

    async function refreshEnvironment() {
        renderNetwork();
        renderRcloneInfo();
        tailscaleName = await NetworkInfo.getTailscaleName();
        renderNetwork();
    }

    // The window is hidden when Eagle launches, so a failed start would otherwise go unnoticed
    function notifyIfNotRunning() {
        const state = ServerManager.getState();
        if (state.status !== 'error' || !hasEagle || !eagle.notification) return;
        Promise.resolve()
            .then(() => eagle.notification.show({
                title: 'Eagle Serve is not running',
                body: state.errorCode === 'RCLONE_MISSING'
                    ? 'rclone is not installed. Open Eagle Serve from the plugin list to download it.'
                    : state.error,
                duration: 8000
            }))
            .catch(err => console.error('[EagleServe] Notification error:', err));
    }

    async function boot() {
        try {
            if (hasEagle && eagle.app) applyTheme(await eagle.app.theme);

            libraryPath = await getLibraryPath();
            ServerManager.init({ getLibraryPath });
            ServerManager.onStateChanged(renderStatus);
            ServerManager.onLog(renderLog);

            writeForm(savedConfig);
            bindEvents();
            renderStatus(ServerManager.getState());
            renderLibrary();
            renderUsers();
            renderCertInfo();
            refreshEnvironment();

            // An rclone left over from a session that ended badly still holds the port
            await ServerManager.cleanupStale();
            if (savedConfig.autoStart) {
                await ServerManager.start();
                notifyIfNotRunning();
            }
        } catch (err) {
            console.error('[EagleServe] Startup error:', err);
        }
    }

    // Eagle Plugin Lifecycle Initialization
    if (hasEagle && eagle.onPluginCreate) {
        eagle.onPluginCreate(boot);

        if (eagle.onThemeChanged) {
            eagle.onThemeChanged(applyTheme);
        }

        if (eagle.onLibraryChanged) {
            eagle.onLibraryChanged(async newPath => {
                libraryPath = newPath || await getLibraryPath();
                renderLibrary();
                ServerManager.checkForChanges();
            });
        }

        // The window is hidden most of the time; catch up when it is opened
        if (eagle.onPluginShow) {
            eagle.onPluginShow(async () => {
                libraryPath = await getLibraryPath();
                renderLibrary();
                refreshEnvironment();
                renderLog();
            });
        }

        if (eagle.onPluginBeforeExit) {
            eagle.onPluginBeforeExit(() => ServerManager.shutdownSync());
        }
    } else {
        // Standalone browser / testing fallback
        boot();
    }

    // rclone must not outlive the plugin, however the window goes away
    window.addEventListener('beforeunload', () => ServerManager.shutdownSync());
})();
