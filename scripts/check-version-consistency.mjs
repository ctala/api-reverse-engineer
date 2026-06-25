/**
 * check-version-consistency.mjs — keeps version drift (B24) from creeping back.
 *
 * Fails if package.json version != manifest version, or if any src/*.js
 * hardcodes a `version: 'x.y.z'` literal that differs from the manifest.
 * (content.js now derives the PING version from the manifest at runtime; this
 * guard catches any future regression to a hardcoded string.)
 *
 * Usage: node scripts/check-version-consistency.mjs   (or: npm run check:version)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

let failed = false;

if (manifest.version !== pkg.version) {
  console.error(`✖ manifest.version (${manifest.version}) != package.json version (${pkg.version})`);
  failed = true;
}

const V = manifest.version;
const srcDir = path.join(REPO, 'src');
for (const f of fs.readdirSync(srcDir)) {
  if (!f.endsWith('.js')) continue;
  const txt = fs.readFileSync(path.join(srcDir, f), 'utf8');
  // Match code literals like `version: '1.4.2'` / `version="1.4.2"` — NOT
  // comments such as `(v1.3.0)`.
  for (const hit of txt.matchAll(/version['"]?\s*[:=]\s*['"](\d+\.\d+\.\d+)['"]/gi)) {
    // '0.0.0' is the conventional "unknown" placeholder (e.g. the PING
    // fallback when chrome.runtime.getManifest() is unavailable) — not drift.
    if (hit[1] !== V && hit[1] !== '0.0.0') {
      console.error(`✖ src/${f}: versión hardcodeada '${hit[1]}' != manifest '${V}'`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(`✔ versión consistente en manifest/package/src: ${V}`);
