/**
 * build-dist.mjs — package the unpacked extension into dist/unpacked/.
 *
 * The e2e suite loads dist/unpacked/ (not src/ loose) so it exercises EXACTLY
 * what ships — this catches manifest↔file drift (e.g. a file referenced by the
 * manifest that isn't copied). No dependencies, runs on plain node.
 *
 * Usage: node scripts/build-dist.mjs   (or: npm run build:dist)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'dist', 'unpacked');

// Everything Chrome needs to load the extension unpacked. (popup.js lives
// under src/, so the 'src' entry already covers it.)
const INCLUDE = ['manifest.json', 'popup.html', 'src', 'icons', '_locales'];

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let copied = 0;
for (const item of INCLUDE) {
  const src = path.join(REPO, item);
  if (fs.existsSync(src)) {
    copyRecursive(src, path.join(OUT, item));
    copied += 1;
  }
}

// Sanity: every file the manifest references must exist in the build.
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
const referenced = [];
if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker);
for (const cs of manifest.content_scripts || []) referenced.push(...(cs.js || []));
if (manifest.action?.default_popup) referenced.push(manifest.action.default_popup);
for (const war of manifest.web_accessible_resources || []) referenced.push(...(war.resources || []));

const missing = referenced.filter((rel) => !fs.existsSync(path.join(OUT, rel)));
if (missing.length) {
  console.error('[build:dist] ✖ manifest referencia archivos ausentes en el build:', missing);
  process.exit(1);
}

console.log(`[build:dist] ✔ ${copied} items → ${path.relative(REPO, OUT)} (manifest OK: ${referenced.length} refs)`);
