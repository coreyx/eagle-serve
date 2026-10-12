#!/usr/bin/env node

/**
 * Release Notes Extractor for Eagle Serve
 *
 * Prints the notes for one version, for use as a GitHub release body.
 * Looks for the version's section in RELEASE_NOTES.md first, then CHANGELOG.md.
 * Exits with code 1 when neither file has a section for that version.
 *
 * Usage:
 *   node scripts/release-notes.js            # version from manifest.json
 *   node scripts/release-notes.js 1.2.0
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// Each source is a file plus a test for "this line is the heading of <version>"
const SOURCES = [
    { file: 'RELEASE_NOTES.md', isHeading: (line, version) => line.startsWith(`## Release Notes: v${version}`) },
    { file: 'CHANGELOG.md', isHeading: (line, version) => line.startsWith(`## [${version}]`) }
];

function extractSection(file, isHeading, version) {
    const filePath = path.join(ROOT, file);
    if (!fs.existsSync(filePath)) return null;

    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const start = lines.findIndex(line => isHeading(line, version));
    if (start < 0) return null;

    // The section runs until the next version heading or horizontal rule
    let end = lines.findIndex((line, i) => i > start && (line.startsWith('## ') || line.trim() === '---'));
    if (end < 0) end = lines.length;

    return lines.slice(start + 1, end).join('\n').trim() || null;
}

const version = (process.argv[2] || require(path.join(ROOT, 'manifest.json')).version).replace(/^v/, '');

for (const { file, isHeading } of SOURCES) {
    const notes = extractSection(file, isHeading, version);
    if (notes) {
        console.log(notes);
        process.exit(0);
    }
}

console.error(`✗ No release notes found for v${version} in ${SOURCES.map(s => s.file).join(' or ')}`);
process.exit(1);
