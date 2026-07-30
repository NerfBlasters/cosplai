#!/usr/bin/env node
// scripts/pin-clis.mjs — install the pinned CLI set into vendor/ (gitignored).
// npm pins: exact-version install under vendor/node_modules. external pins
// (no public registry, e.g. agy): snapshot the host binary after verifying
// its --version matches the manifest; sha256 recorded back into the manifest
// on first pin. Exits non-zero on any mismatch. --npm-only skips externals,
// for hosts that don't have the external CLIs installed to snapshot from.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadPins, npmDepsFromPins, extractVersion, REPO_ROOT, DEFAULT_PINS_PATH } from '../src/pins.js';

const args = process.argv.slice(2);
const npmOnly = args.includes('--npm-only');
const positional = args.filter((a) => a !== '--npm-only');
if (positional.length > 1) { console.error(`unexpected arguments: ${positional.slice(1).join(' ')}`); process.exit(1); }
const pinsPath = positional[0] || DEFAULT_PINS_PATH;
const pins = loadPins(pinsPath);
if (!Object.keys(pins).length) { console.error(`no pins found at ${pinsPath}`); process.exit(1); }
const vendor = path.join(REPO_ROOT, 'vendor');
fs.mkdirSync(path.join(vendor, 'bin'), { recursive: true });

const deps = npmDepsFromPins(pins);
fs.writeFileSync(path.join(vendor, 'package.json'),
  JSON.stringify({ name: 'bridge-vendor', private: true, dependencies: deps }, null, 2));
console.log(`installing ${Object.keys(deps).length} npm pin(s) into vendor/ ...`);
try {
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: vendor, stdio: 'inherit' });
} catch {
  console.error('npm install failed — vendor/ may hold a previous pin set; fix the error above and re-run');
  process.exit(1);
}

// Persist a recorded sha immediately so an abort on a later pin can't lose it.
const saveManifest = () => fs.writeFileSync(pinsPath, `${JSON.stringify(pins, null, 2)}\n`);
for (const [cmd, pin] of Object.entries(pins)) {
  if (pin.source !== 'external') continue;
  if (npmOnly) { console.log(`external pin "${cmd}": skipped (--npm-only); provide it at vendor/bin/${cmd} at runtime`); continue; }
  const which = spawnSync('which', [cmd], { encoding: 'utf8' });
  if (which.status !== 0) { console.error(`external pin "${cmd}": not found on PATH`); process.exit(1); }
  const src = which.stdout.trim();
  const ver = spawnSync(src, ['--version'], { encoding: 'utf8', timeout: 10000 });
  const got = extractVersion(`${ver.stdout}${ver.stderr}`);
  if (got !== pin.version) {
    console.error(`external pin "${cmd}": host has ${got ?? 'unknown'}, manifest wants ${pin.version} — aborting (update the manifest or the host, then re-run)`);
    process.exit(1);
  }
  const dest = path.join(vendor, 'bin', cmd);
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  if (!pin.sha256) { pin.sha256 = sha; saveManifest(); console.log(`external pin "${cmd}": recorded sha256 ${sha.slice(0, 12)}…`); }
  else if (pin.sha256 !== sha) {
    console.error(`external pin "${cmd}": sha256 mismatch at version ${got} — binary changed under the same version; clear the manifest sha256 to re-record`);
    process.exit(1);
  }
}

// Stale bins in vendor/bin (pin removed from the manifest) would still win
// vendor-first resolution while escaping the handshake — surface them.
for (const stale of fs.readdirSync(path.join(vendor, 'bin')).filter((f) => !pins[f])) {
  console.warn(`WARNING: vendor/bin/${stale} has no manifest entry — it still shadows the host CLI; delete it if that's not intended`);
}

console.log('\npin report:');
for (const [cmd, pin] of Object.entries(pins)) {
  if (npmOnly && pin.source === 'external') { console.log(`  ${cmd.padEnd(8)} (external, skipped)`); continue; }
  const bin = pin.source === 'npm' ? path.join(vendor, 'node_modules', '.bin', cmd) : path.join(vendor, 'bin', cmd);
  const out = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 });
  const got = extractVersion(`${out.stdout ?? ''}${out.stderr ?? ''}`) ?? 'ERROR';
  const mark = got === pin.version ? 'ok' : 'MISMATCH';
  if (got !== pin.version) process.exitCode = 1;
  console.log(`  ${cmd.padEnd(8)} wanted ${pin.version.padEnd(10)} got ${String(got).padEnd(10)} ${mark}  ${bin}`);
}
