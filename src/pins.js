// src/pins.js — cli-pins.json manifest: load, validate, derive npm deps.
// The manifest pins each spawnable command to the exact version its adapter
// markers were verified against (spec Part B). Keys are command names and
// must equal the installed bin name (vendor/node_modules/.bin/<key> for npm
// pins, vendor/bin/<key> for external pins).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PINS_PATH = path.join(REPO_ROOT, 'cli-pins.json');

export function extractVersion(s) {
  const m = String(s ?? '').match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

export function validatePins(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('cli-pins.json: top level must be an object keyed by command name');
  }
  for (const [cmd, pin] of Object.entries(obj)) {
    // Keys become bin filenames under vendor/ and are exec'd — reject
    // anything that isn't a bare command name (no separators, no dot-leading).
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cmd)) throw new Error(`cli-pins.json: key "${cmd}" must be a bare command name`);
    if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw new Error(`cli-pins.json: "${cmd}" must be an object`);
    if (!['npm', 'external'].includes(pin.source)) throw new Error(`cli-pins.json: "${cmd}".source must be "npm" or "external"`);
    if (typeof pin.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pin.version)) {
      throw new Error(`cli-pins.json: "${cmd}".version must be an exact x.y.z version`);
    }
    if (pin.source === 'npm' && typeof pin.package !== 'string') throw new Error(`cli-pins.json: "${cmd}".package is required for npm pins`);
  }
  return obj;
}

export function loadPins(filePath = DEFAULT_PINS_PATH) {
  if (!existsSync(filePath)) return {};
  let parsed;
  try { parsed = JSON.parse(readFileSync(filePath, 'utf8')); } catch (e) {
    throw new Error(`${filePath}: invalid JSON (${e.message})`);
  }
  return validatePins(parsed);
}

export function npmDepsFromPins(pins) {
  const deps = {};
  for (const pin of Object.values(pins)) if (pin.source === 'npm') deps[pin.package] = pin.version;
  return deps;
}
