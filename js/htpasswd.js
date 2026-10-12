/**
 * htpasswd Manager for Eagle Serve
 * Maintains the Apache-compatible htpasswd file rclone uses for HTTP Basic
 * Authentication. Passwords are stored as bcrypt hashes only.
 * Port of webdav-server-kit's generate_htpasswd.py.
 */

const HtpasswdManager = (() => {
    const fs = require('fs');
    const path = require('path');

    const DEFAULT_COST = 12;

    function loadBcrypt() {
        try {
            return require('bcryptjs');
        } catch (err) {
            throw new Error('The bcryptjs module is missing. Run "pnpm install" in the plugin folder.');
        }
    }

    /**
     * Reads the file, keeping comments and unknown lines so they survive a rewrite.
     * @param {string} filePath
     * @returns {{ username: string | null, line: string }[]}
     */
    function readLines(filePath) {
        let content = '';
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }

        return content.split(/\r?\n/).filter(line => line.length > 0).map(line => {
            const stripped = line.trim();
            if (stripped && !stripped.startsWith('#') && stripped.includes(':')) {
                return { username: stripped.substring(0, stripped.indexOf(':')).trim(), line: stripped };
            }
            return { username: null, line };
        });
    }

    function writeLines(filePath, lines) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        // Written in place rather than renamed over: rclone re-reads this file while
        // serving, and on Windows a file it has open cannot be replaced by a rename
        fs.writeFileSync(filePath, lines.map(entry => entry.line + '\n').join(''), { mode: 0o600 });
    }

    /**
     * @param {string} username
     * @returns {string | null} The problem with the username, or null when it is valid.
     */
    function validateUsername(username) {
        if (!username) return 'Enter a username.';
        if (username.includes(':')) return 'A username cannot contain ":".';
        if (/\s/.test(username)) return 'A username cannot contain spaces.';
        return null;
    }

    /**
     * @param {string} filePath
     * @returns {string[]} Usernames in file order.
     */
    function listUsers(filePath) {
        return readLines(filePath).filter(entry => entry.username).map(entry => entry.username);
    }

    /**
     * Adds a user or replaces an existing user's password.
     * @param {string} filePath
     * @param {string} username
     * @param {string} password
     * @param {number} [cost] - bcrypt cost factor.
     * @returns {Promise<boolean>} True when an existing user was updated.
     */
    async function setUser(filePath, username, password, cost = DEFAULT_COST) {
        const problem = validateUsername(username);
        if (problem) throw new Error(problem);
        if (!password) throw new Error('Enter a password.');
        // bcrypt only reads the first 72 bytes, so anything longer would be silently cut short
        if (Buffer.byteLength(password, 'utf8') > 72) throw new Error('A password can be at most 72 bytes long.');

        const hash = await loadBcrypt().hash(password, cost);
        const lines = readLines(filePath);
        const existing = lines.find(entry => entry.username === username);
        if (existing) {
            existing.line = `${username}:${hash}`;
        } else {
            lines.push({ username, line: `${username}:${hash}` });
        }
        writeLines(filePath, lines);
        return Boolean(existing);
    }

    /**
     * @param {string} filePath
     * @param {string} username
     * @returns {boolean} False when there was no such user.
     */
    function deleteUser(filePath, username) {
        const lines = readLines(filePath);
        if (!lines.some(entry => entry.username === username)) return false;
        writeLines(filePath, lines.filter(entry => entry.username !== username));
        return true;
    }

    /**
     * Checks a password against the stored hash.
     * @param {string} filePath
     * @param {string} username
     * @param {string} password
     * @returns {Promise<boolean>}
     */
    async function verifyUser(filePath, username, password) {
        const entry = readLines(filePath).find(line => line.username === username);
        if (!entry) return false;
        return loadBcrypt().compare(password, entry.line.substring(entry.line.indexOf(':') + 1).trim());
    }

    return {
        DEFAULT_COST,
        validateUsername,
        listUsers,
        setUser,
        deleteUser,
        verifyUser
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = HtpasswdManager;
}
if (typeof window !== 'undefined') {
    window.HtpasswdManager = HtpasswdManager;
}
