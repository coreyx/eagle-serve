#!/usr/bin/env node

/**
 * Release Build Script for Eagle Serve
 *
 * 1. Stages only the runtime files into dist/eagle-serve/, copies the production
 *    dependencies from node_modules/ next to them, and turns off devTools in the
 *    staged manifest.
 * 2. Packs the staged folder into dist/eagle-serve-<version>.eagleplugin.
 *
 * An .eagleplugin file is a plain zip of the plugin folder's contents (files at
 * the archive root, deflate-compressed), which is what Eagle's own "Pack Plugin"
 * action produces. The zip is written with Node's built-in zlib so the build
 * itself needs nothing installed beyond the plugin's own dependencies.
 *
 * Usage:
 *   pnpm build
 */

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const OUT_DIR = path.join(DIST_DIR, 'eagle-serve');

// Everything the plugin needs at runtime, relative to the repo root
const RUNTIME_FILES = [
    'manifest.json',
    'index.html',
    'logo.png',
    'LICENSE',
    'css',
    'js'
];

// OS / editor leftovers that must never ship
const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(log|tmp|swp|swo)$/i;

function fail(message) {
    console.error(`✗ ${message}`);
    process.exit(1);
}

function listFiles(dir, base = dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory()
            ? listFiles(full, base)
            : [path.relative(base, full).replace(/\\/g, '/')];
    });
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function copyTree(src, dest) {
    fs.cpSync(src, dest, {
        recursive: true,
        // Real files only: Eagle's review rejects packages containing symlinks
        dereference: true,
        filter: source => !JUNK.test(path.basename(source))
    });
}

function stageFiles() {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    for (const name of RUNTIME_FILES) {
        const src = path.join(ROOT, name);
        if (!fs.existsSync(src)) fail(`Missing runtime file: ${name}`);
        copyTree(src, path.join(OUT_DIR, name));
    }
}

// Copies every package in package.json's "dependencies", and whatever those
// depend on in turn, into the staged node_modules/. nodeLinker is "hoisted" in
// pnpm-workspace.yaml, so each one is a plain folder directly under node_modules/.
function stageDependencies() {
    const staged = new Set();
    const pending = Object.keys(readJson(path.join(ROOT, 'package.json')).dependencies || {});

    while (pending.length) {
        const name = pending.shift();
        if (staged.has(name)) continue;

        const src = path.join(ROOT, 'node_modules', name);
        if (!fs.existsSync(path.join(src, 'package.json'))) {
            fail(`Dependency "${name}" is not installed. Run "pnpm install" first.`);
        }
        copyTree(src, path.join(OUT_DIR, 'node_modules', name));
        staged.add(name);

        const pkg = readJson(path.join(src, 'package.json'));
        pending.push(...Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }));
    }

    return [...staged].sort();
}

function writeReleaseManifest() {
    const manifestPath = path.join(OUT_DIR, 'manifest.json');
    const manifest = readJson(manifestPath);

    if (typeof manifest.id !== 'string' || !manifest.id.trim()) fail('manifest.json has no "id"');
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) fail('manifest.json has no "name"');
    if (typeof manifest.version !== 'string' || !manifest.version.trim()) fail('manifest.json has no "version"');

    manifest.devTools = false;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + '\n');
    return manifest;
}

// Every local file the manifest and index.html point at must exist in the staged copy
function verifyReferences(manifest) {
    const refs = [];
    if (manifest.logo) refs.push(manifest.logo);
    if (manifest.main && manifest.main.url) refs.push(manifest.main.url);

    const html = fs.readFileSync(path.join(OUT_DIR, 'index.html'), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(match[1])) refs.push(match[1]);
    }

    const missing = refs.filter(ref => !fs.existsSync(path.join(OUT_DIR, ref.replace(/^\//, ''))));
    if (missing.length) fail(`Staged copy is missing referenced files: ${missing.join(', ')}`);
}

// The staged plugin must load each dependency from its own node_modules/, not
// from one further up the tree that will not exist once it is installed
function verifyDependencies(names) {
    for (const name of names) {
        let resolved;
        try {
            resolved = require.resolve(name, { paths: [OUT_DIR] });
        } catch (err) {
            fail(`Staged copy cannot load "${name}": ${err.message}`);
        }
        if (!resolved.startsWith(OUT_DIR + path.sep)) {
            fail(`"${name}" resolves outside the staged copy (${resolved}).`);
        }
    }

    const links = listFiles(OUT_DIR).filter(file => fs.lstatSync(path.join(OUT_DIR, file)).isSymbolicLink());
    if (links.length) fail(`Staged copy contains symlinks: ${links.join(', ')}`);
}

// --- Zip writer -----------------------------------------------------------
// Mirrors the archive Eagle's "Pack Plugin" writes: forward-slash paths at the
// archive root, explicit directory entries, deflate, Unix attributes, UTC times.

function dosDateTime(date) {
    const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
    const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
    return { time, day };
}

function zipEntries(dir, files) {
    const dirs = new Set();
    for (const file of files) {
        const parts = file.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
    }

    return [...dirs, ...files].sort().map(name => {
        const full = path.join(dir, name);
        const isDir = name.endsWith('/');
        return {
            name,
            isDir,
            mtime: fs.statSync(full).mtime,
            data: isDir ? Buffer.alloc(0) : fs.readFileSync(full)
        };
    });
}

function buildZip(entries) {
    const UTF8_NAMES = 0x0800;
    const MADE_BY_UNIX = (3 << 8) | 45;
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const method = entry.isDir ? 0 : 8;
        const body = entry.isDir ? entry.data : zlib.deflateRawSync(entry.data, { level: 9 });
        const crc = entry.isDir ? 0 : zlib.crc32(entry.data);
        const { time, day } = dosDateTime(entry.mtime);
        const versionNeeded = entry.isDir ? 10 : 20;
        // Unix mode in the high word, DOS attribute (directory / archive) in the low byte
        const attrs = entry.isDir ? ((0o040755 << 16) | 0x10) >>> 0 : ((0o100666 << 16) | 0x20) >>> 0;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(versionNeeded, 4);
        local.writeUInt16LE(UTF8_NAMES, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(day, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        localParts.push(local, name, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(MADE_BY_UNIX, 4);
        central.writeUInt16LE(versionNeeded, 6);
        central.writeUInt16LE(UTF8_NAMES, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(day, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(attrs, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, name);

        offset += local.length + name.length + body.length;
    }

    const centralDir = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDir.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...localParts, centralDir, end]);
}

function packPlugin(manifest, files) {
    if (typeof zlib.crc32 !== 'function') fail('Packing needs Node.js 20.15+ or 22.2+ (zlib.crc32).');

    const packagePath = path.join(DIST_DIR, `eagle-serve-${manifest.version}.eagleplugin`);
    fs.writeFileSync(packagePath, buildZip(zipEntries(OUT_DIR, files)));
    return packagePath;
}

stageFiles();
const dependencies = stageDependencies();
const manifest = writeReleaseManifest();
verifyReferences(manifest);
verifyDependencies(dependencies);

const files = listFiles(OUT_DIR).sort();
const packagePath = packPlugin(manifest, files);

console.log(`✓ Built ${manifest.name} v${manifest.version} (${files.length} files, devTools off)`);
for (const file of files) console.log(`   ${file}`);
console.log(`\nDependencies: ${dependencies.join(', ') || 'none'}`);
console.log(`Staged:  ${OUT_DIR}`);
console.log(`Package: ${packagePath} (${fs.statSync(packagePath).size} bytes)`);
