# Agnostic Identity + CLI Version Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe the repo as an agnostic CLI-to-API bridge (Part A of the spec) and decouple the CLI versions the bridge spawns from the host's autoupdating installs via a committed pin manifest + vendored installs + boot-time version handshake (Part B), with Docker packaging as a stretch (Part C).

**Architecture:** Part A is docs/rename only (plus one boot-banner string). Part B adds `src/pins.js` (manifest load/validate + helpers), `scripts/pin-clis.mjs` (vendored installs), vendor-first command resolution inside `loadConfig`, per-profile `envSet` for autoupdate suppression applied at both spawn sites (`Session`, `headlessClaudeRunner`), and `src/versionCheck.js` (boot `--version` handshake, warn or strict-fail). Spec: `docs/superpowers/specs/2026-07-24-agnostic-identity-and-version-pinning-design.md`.

**Tech Stack:** Node >=20 ESM, `node:test`, node-pty, no new runtime dependencies (only `node:fs`, `node:path`, `node:child_process`, `node:crypto`).

## Global Constraints

- Never pipe the test suite: always `node --test > /tmp/suite.out 2>&1`, then read the file. Kill leaked PTYs with `pgrep -f '[f]ake-repl'` (bracket trick). Never run concurrent suites.
- Offline suite must stay at ≥206 passing with **zero live-CLI usage**; live CLIs are touched only in Task 9 (live acceptance) and Task 3 (`gh` ops).
- No new npm runtime dependencies. `vendor/` is gitignored, never committed.
- Commit messages: repo conventional style (`docs:`, `feat:`, `test:`); **no Claude/model co-author attribution** (user rule).
- Manifest key == binary name in `vendor/node_modules/.bin/` (npm pins) or `vendor/bin/` (external pins).
- Env override (`PROFILE_<NAME>_COMMAND`, and legacy `CLAUDE_CMD` for claude/generic) always defeats vendor resolution — an operator's explicit command is used verbatim.
- Baseline before starting: `master` clean at `e484f0f`, suite green.

---

### Task 0: Branch

- [ ] **Step 0.1:** `git checkout -b feat/agnostic-identity-and-pinning` from `master` @ `e484f0f`. Confirm clean: `git status --short` → only this plan file if not yet committed.
- [ ] **Step 0.2:** Commit this plan: `git add docs/superpowers/plans/2026-07-24-agnostic-identity-and-pinning.md && git commit -m "docs: Phase 3 implementation plan"`
- [ ] **Step 0.3:** Baseline suite: `node --test > /tmp/suite-baseline.out 2>&1; tail -3 /tmp/suite-baseline.out` → expect `pass 206` / `fail 0`.

---

### Task 1: Part A1 — delete the XDR doc, port its hardening list

**Files:**
- Delete: `docs/integration/defender-xdr-threat-hunting.md` (and the now-empty `docs/integration/`)
- Modify: `docs/ARCHITECTURE.md` (security bullet ~line 83-86; testing section ~line 88-94)
- Modify: `docs/README.md` (XDR entry, lines 8-11)

**Interfaces:** none (docs only). Later tasks rely on: no `docs/integration/` dir.

- [ ] **Step 1.1:** `git rm docs/integration/defender-xdr-threat-hunting.md` (dir disappears with its only file).
- [ ] **Step 1.2:** In `docs/ARCHITECTURE.md`, replace the final security bullet ("The token grants full interactive control ... see the [Defender XDR integration doc] §8 ...") with the ported, genericized hardening list:

```markdown
- The token grants full interactive control of the spawned CLIs (which can run
  tools / execute code). Single-operator/localhost by design. Before exposing
  the bridge beyond one operator (any team console or shared deployment), add
  — outside the bridge:
  - real per-user authN/Z (SSO/OIDC) in front; never hand the raw bridge
    token/port to multiple users' browsers;
  - per-user isolation — separate sessions per user at least; for true
    isolation, a separate bridge process per user with that user's own CLI
    login;
  - TLS termination + network policy (it binds loopback; front it with an
    authenticating reverse proxy on an internal network/VPN);
  - secrets management for the bridge token(s);
  - audit logging of who drove which session and what prompts ran;
  - host hardening — the host runs CLIs with tool/exec access; treat it as
    sensitive and egress-controlled.
```

- [ ] **Step 1.3:** In `docs/ARCHITECTURE.md` testing section, replace "`node --test`, 109 tests." with "`node --test` runs the full offline suite." (kills the rotting literal).
- [ ] **Step 1.4:** In `docs/README.md`, delete the 4-line XDR entry (`- **[integration/defender-xdr-threat-hunting.md]...Start here for the intended use.**`).
- [ ] **Step 1.5:** Verify: `grep -riE 'xdr|defender|threat.hunt' docs/README.md docs/ARCHITECTURE.md docs/API.md` → no output; `ls docs/integration` → No such file.
- [ ] **Step 1.6:** Commit: `git add -A docs && git commit -m "docs: remove XDR integration doc; port its hardening list generically"`

---

### Task 2: Part A2 — README rewrite, package.json name, boot banner

**Files:**
- Modify: `README.md` (title line 1, intro 1-10, Documentation 11-27, Why-PTY 28-37, plus a full-file sweep)
- Modify: `package.json` (`name`)
- Modify: `src/server.js:19` (banner string)

**Interfaces:** Produces the identity copy every later doc task builds on. No code interfaces.

- [ ] **Step 2.1:** Replace README title + intro (lines 1-10) with:

```markdown
# pty-web-bridge

A local Node service that owns real PTY-backed **interactive** AI-CLI sessions
(`claude`, `codex`, `copilot`, `antigravity` — or any REPL via the `generic`
profile) and exposes each session three ways at once: a browser `xterm.js`
terminal over WebSocket so a human can watch and type live, a token-gated
HTTP + SSE API so a program can drive the *same* session, and an
OpenAI/Anthropic-compatible **cloud-API facade**, so any OpenAI or Anthropic
SDK client can drive a subscription-authenticated CLI as if it were a hosted
API. All interfaces attach to the same underlying sessions, so a script can
drive a flow while a human watches it happen in the browser.
```

- [ ] **Step 2.2:** In the Documentation section, replace the 6-line XDR entry with a building-block paragraph (keep the other doc links):

```markdown
Use it **standalone** (browser terminal + `curl`) or as a **building block**:
the facade speaks the OpenAI and Anthropic wire protocols, so anything that
can talk to those APIs — SDKs, agent frameworks, existing tooling — can sit
on top of the bridge without knowing it exists.
```

- [ ] **Step 2.3:** Rewrite the "Why PTY / interactive `claude` ..." section header to "Why PTY / interactive CLIs (not the vendors' SDKs)" and generalize the body: every supported CLI authenticates via a subscription login (`claude` Max/Pro OAuth, `codex` ChatGPT login, `copilot` gh keyring, `agy` Google account) that the vendors' API SDKs cannot use; driving the real interactive REPL over a PTY is the only way to automate a session on those subscriptions. Keep the honest framing; keep `claude`-specific detail as an example, not the subject.
- [ ] **Step 2.4:** Add a support-tier table right after the intro's Documentation section:

```markdown
## Support tiers

| Tier | Profiles | What you get |
|---|---|---|
| First-class | `claude`, `codex`, `claude-headless` | Live-verified adapters, full response extraction (`claude-headless`: byte-exact output + real usage) |
| Best-effort | `copilot`, `antigravity` | Reliable state detection; alt-screen UIs make response extraction best-effort |
| Bring-your-own | `generic` | Any REPL; quiescence-based readiness only |
```

- [ ] **Step 2.5:** Full-file identity sweep of README.md: replace remaining "interactive-claude-bridge" / claude-only identity phrasing (`grep -n 'interactive-claude\|Interactive Claude' README.md`); update the Quick-start banner echo to match Step 2.7; leave technical `claude`-profile content (trust-dialog section, env-scrub table, etc.) intact — it's profile documentation, not identity.
- [ ] **Step 2.6:** `package.json`: `"name": "pty-web-bridge"`.
- [ ] **Step 2.7:** `src/server.js:19`: `console.log('pty-web-bridge listening.');`
- [ ] **Step 2.8:** Run suite: `node --test > /tmp/suite.out 2>&1; tail -3 /tmp/suite.out` → 206 pass (banner is not asserted anywhere; this catches accidents).
- [ ] **Step 2.9:** Verify: `grep -riE 'xdr|defender|threat.hunt|interactive-claude' README.md package.json src/ public/` → no output.
- [ ] **Step 2.10:** Commit: `git add README.md package.json src/server.js && git commit -m "docs: reframe README as agnostic CLI-to-API bridge; rename package to pty-web-bridge"`

---

### Task 3: Part A3 — GitHub repo rename

**Files:** none (GitHub + git remote ops).

- [ ] **Step 3.1:** `gh repo rename pty-web-bridge --repo NerfBlasters/interactive-claude-bridge --yes`
- [ ] **Step 3.2:** `git remote set-url origin git@github.com:NerfBlasters/pty-web-bridge.git` (match existing remote protocol — check `git remote -v` first and keep https if that's what's there).
- [ ] **Step 3.3:** Verify: `git fetch origin` succeeds; `gh repo view NerfBlasters/pty-web-bridge --json name` returns the new name. Old PR URLs redirect (GitHub behavior; spot-check PR #2's URL with `gh pr view 2 --json title`).

---

### Task 4: Part B1/B2 — pin manifest, `src/pins.js`, pin script

**Files:**
- Create: `cli-pins.json`, `src/pins.js`, `scripts/pin-clis.mjs`
- Modify: `.gitignore` (add `vendor/`), `package.json` (add `"pin"` script)
- Test: `test/pins.test.js`

**Interfaces:**
- Produces: `loadPins(filePath?) -> {[cmd]: {source, version, package?, sha256?}}` (missing file → `{}`, invalid → throw); `validatePins(obj)`; `npmDepsFromPins(pins) -> {pkgName: version}`; `extractVersion(str) -> 'x.y.z' | null`; `REPO_ROOT`, `DEFAULT_PINS_PATH` constants — all from `src/pins.js`. Tasks 5/7 consume `extractVersion` and `loadPins`.

- [ ] **Step 4.1: Write failing tests** in `test/pins.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPins, validatePins, npmDepsFromPins, extractVersion } from '../src/pins.js';

test('extractVersion pulls the first x.y.z token', () => {
  assert.equal(extractVersion('2.1.219 (Claude Code)'), '2.1.219');
  assert.equal(extractVersion('codex-cli 0.134.0\n'), '0.134.0');
  assert.equal(extractVersion('no version here'), null);
  assert.equal(extractVersion(null), null);
});

test('loadPins: missing file returns empty object', () => {
  assert.deepEqual(loadPins(path.join(tmpdir(), 'nope-does-not-exist.json')), {});
});

test('loadPins: invalid JSON throws with file context', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pins-'));
  const f = path.join(dir, 'cli-pins.json');
  writeFileSync(f, '{nope');
  assert.throws(() => loadPins(f), /invalid JSON/);
});

test('validatePins rejects bad source, bad version, missing npm package', () => {
  assert.throws(() => validatePins({ x: { source: 'brew', version: '1.0.0' } }), /source/);
  assert.throws(() => validatePins({ x: { source: 'npm', package: 'p', version: '1.0' } }), /version/);
  assert.throws(() => validatePins({ x: { source: 'npm', version: '1.0.0' } }), /package/);
  assert.throws(() => validatePins([]), /object/);
});

test('validatePins accepts the shipped manifest shape; npmDepsFromPins maps npm entries only', () => {
  const pins = validatePins({
    claude: { source: 'npm', package: '@anthropic-ai/claude-code', version: '2.1.219' },
    agy: { source: 'external', version: '1.1.6' },
  });
  assert.deepEqual(npmDepsFromPins(pins), { '@anthropic-ai/claude-code': '2.1.219' });
});
```

- [ ] **Step 4.2:** `node --test test/pins.test.js > /tmp/t.out 2>&1; tail -5 /tmp/t.out` → FAIL (module not found).
- [ ] **Step 4.3: Implement `src/pins.js`:**

```js
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
```

- [ ] **Step 4.4:** `node --test test/pins.test.js > /tmp/t.out 2>&1; tail -5 /tmp/t.out` → PASS.
- [ ] **Step 4.5: Create `cli-pins.json`** (claude pinned at the host's current 2.1.219 pending Task 9's live gate — contingency there):

```json
{
  "claude": { "source": "npm", "package": "@anthropic-ai/claude-code", "version": "2.1.219" },
  "codex": { "source": "npm", "package": "@openai/codex", "version": "0.134.0" },
  "copilot": { "source": "npm", "package": "@github/copilot", "version": "1.0.74" },
  "agy": { "source": "external", "version": "1.1.6" }
}
```

- [ ] **Step 4.6: Create `scripts/pin-clis.mjs`** (thin orchestration over `src/pins.js`; `--npm-only` skips external pins for container builds):

```js
#!/usr/bin/env node
// scripts/pin-clis.mjs — install the pinned CLI set into vendor/ (gitignored).
// npm pins: exact-version install under vendor/node_modules. external pins
// (no public registry, e.g. agy): snapshot the host binary after verifying
// its --version matches the manifest; sha256 recorded back into the manifest
// on first pin. Exits non-zero on any mismatch. --npm-only skips externals.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadPins, npmDepsFromPins, extractVersion, REPO_ROOT, DEFAULT_PINS_PATH } from '../src/pins.js';

const npmOnly = process.argv.includes('--npm-only');
const pinsPath = process.argv.find((a) => a.endsWith('.json')) || DEFAULT_PINS_PATH;
const pins = loadPins(pinsPath);
if (!Object.keys(pins).length) { console.error(`no pins found at ${pinsPath}`); process.exit(1); }
const vendor = path.join(REPO_ROOT, 'vendor');
fs.mkdirSync(path.join(vendor, 'bin'), { recursive: true });

const deps = npmDepsFromPins(pins);
fs.writeFileSync(path.join(vendor, 'package.json'),
  JSON.stringify({ name: 'bridge-vendor', private: true, dependencies: deps }, null, 2));
console.log(`installing ${Object.keys(deps).length} npm pin(s) into vendor/ ...`);
execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: vendor, stdio: 'inherit' });

let manifestDirty = false;
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
  if (!pin.sha256) { pin.sha256 = sha; manifestDirty = true; console.log(`external pin "${cmd}": recorded sha256 ${sha.slice(0, 12)}…`); }
  else if (pin.sha256 !== sha) {
    console.error(`external pin "${cmd}": sha256 mismatch at version ${got} — binary changed under the same version; clear the manifest sha256 to re-record`);
    process.exit(1);
  }
}
if (manifestDirty) fs.writeFileSync(pinsPath, `${JSON.stringify(pins, null, 2)}\n`);

console.log('\npin report:');
for (const [cmd, pin] of Object.entries(pins)) {
  const bin = pin.source === 'npm' ? path.join(vendor, 'node_modules', '.bin', cmd) : path.join(vendor, 'bin', cmd);
  if (npmOnly && pin.source === 'external') { console.log(`  ${cmd.padEnd(8)} (external, skipped)`); continue; }
  const out = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 });
  const got = extractVersion(`${out.stdout ?? ''}${out.stderr ?? ''}`) ?? 'ERROR';
  const mark = got === pin.version ? 'ok' : 'MISMATCH';
  if (got !== pin.version) process.exitCode = 1;
  console.log(`  ${cmd.padEnd(8)} wanted ${pin.version.padEnd(10)} got ${String(got).padEnd(10)} ${mark}  ${bin}`);
}
```

- [ ] **Step 4.7:** `.gitignore`: add `vendor/` line. `package.json` scripts: `"pin": "node scripts/pin-clis.mjs"`.
- [ ] **Step 4.8:** Full suite (`node --test > /tmp/suite.out 2>&1; tail -3`) → 206 + 5 new = expect `pass 211`, fail 0. (Pin script's npm-install path is exercised for real in Task 9, not CI.)
- [ ] **Step 4.9:** Commit: `git add src/pins.js scripts/pin-clis.mjs cli-pins.json test/pins.test.js .gitignore package.json && git commit -m "feat: cli-pins.json manifest + pin script (vendored pinned CLI installs)"`

---

### Task 5: Part B3 — vendor-first command resolution in `loadConfig`

**Files:**
- Modify: `src/config.js` (imports; profile loop after the `P('COMMAND')` override; returned config)
- Test: `test/config.test.js` (append)

**Interfaces:**
- Consumes: nothing from Task 4 (vendor resolution is directory-existence-based, manifest-independent).
- Produces: `loadConfig(env, { vendorDir } = {})` second opts param; each profile gains `baseCommand` (pre-resolution command name — Task 7's handshake keys `cli-pins.json` lookups on it); config gains `strictVersions: boolean`. Existing profile fields unchanged.

- [ ] **Step 5.1: Write failing tests** (append to `test/config.test.js`):

```js
// ---- vendor-first resolution + strict flag (Phase 3: version pinning) ----
import { mkdtempSync, mkdirSync, writeFileSync as wf } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function fakeVendor(bins) {           // bins: {'node_modules/.bin/claude': true, ...}
  const dir = mkdtempSync(path.join(tmpdir(), 'vendor-'));
  for (const rel of Object.keys(bins)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    wf(p, '#!/bin/sh\necho stub\n', { mode: 0o755 });
  }
  return dir;
}

test('vendor: command resolves to vendored bin when present', () => {
  const vendorDir = fakeVendor({ 'node_modules/.bin/claude': true, 'bin/agy': true });
  const c = loadConfig({}, { vendorDir });
  assert.equal(c.profiles.claude.command, path.join(vendorDir, 'node_modules', '.bin', 'claude'));
  assert.equal(c.profiles.claude.baseCommand, 'claude');
  assert.equal(c.profiles.antigravity.command, path.join(vendorDir, 'bin', 'agy'));
  assert.equal(c.profiles.codex.command, 'codex');            // not vendored -> PATH fallback
  assert.equal(c.profiles.codex.baseCommand, 'codex');
});

test('vendor: claude-headless shares the vendored claude bin', () => {
  const vendorDir = fakeVendor({ 'node_modules/.bin/claude': true });
  const c = loadConfig({}, { vendorDir });
  assert.equal(c.profiles['claude-headless'].command, path.join(vendorDir, 'node_modules', '.bin', 'claude'));
});

test('vendor: PROFILE_<NAME>_COMMAND override defeats vendor resolution', () => {
  const vendorDir = fakeVendor({ 'node_modules/.bin/claude': true });
  const c = loadConfig({ PROFILE_CLAUDE_COMMAND: '/opt/other/claude' }, { vendorDir });
  assert.equal(c.profiles.claude.command, '/opt/other/claude');
  assert.equal(c.profiles.claude.baseCommand, '/opt/other/claude');
});

test('vendor: legacy CLAUDE_CMD override defeats vendor resolution', () => {
  const vendorDir = fakeVendor({ 'node_modules/.bin/claude': true });
  const c = loadConfig({ CLAUDE_CMD: 'my-claude' }, { vendorDir });
  assert.equal(c.profiles.claude.command, 'my-claude');
});

test('vendor: BRIDGE_USE_HOST_CLIS=1 skips vendor resolution', () => {
  const vendorDir = fakeVendor({ 'node_modules/.bin/claude': true });
  const c = loadConfig({ BRIDGE_USE_HOST_CLIS: '1' }, { vendorDir });
  assert.equal(c.profiles.claude.command, 'claude');
});

test('vendor: absent vendor dir leaves commands untouched (today\'s behavior)', () => {
  const c = loadConfig({}, { vendorDir: path.join(tmpdir(), 'no-such-vendor-dir') });
  assert.equal(c.profiles.claude.command, 'claude');
  assert.equal(c.profiles.claude.baseCommand, 'claude');
});

test('strictVersions flag defaults false, BRIDGE_STRICT_VERSIONS=1 enables', () => {
  assert.equal(loadConfig({}).strictVersions, false);
  assert.equal(loadConfig({ BRIDGE_STRICT_VERSIONS: '1' }).strictVersions, true);
});
```

Note: `test/config.test.js` already imports `test`/`assert`; only add the fs/os/path imports if not present (top of file check).

- [ ] **Step 5.2:** Run: `node --test test/config.test.js > /tmp/t.out 2>&1; tail -5 /tmp/t.out` → FAIL.
- [ ] **Step 5.3: Implement in `src/config.js`:** add imports (`existsSync` from `node:fs`, `path`, `fileURLToPath`) and a module-level `const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');`. Change the signature to `export function loadConfig(env = process.env, { vendorDir = path.join(REPO_ROOT, 'vendor') } = {})`. In the profile loop, right after the `if (P('COMMAND') != null) command = P('COMMAND');` / `ARGS` block, insert:

```js
    // Vendor-first resolution (spec B3): a pinned bin under vendor/ wins over
    // host PATH, but an operator's explicit command (per-profile env override
    // or legacy CLAUDE_CMD) is always used verbatim. BRIDGE_USE_HOST_CLIS=1
    // is the escape hatch back to host binaries.
    const explicit = P('COMMAND') != null
      || (name === 'claude' && !!env.CLAUDE_CMD)
      || (name === 'generic' && env.ADAPTER === 'generic' && !!env.CLAUDE_CMD);
    const baseCommand = command;
    if (!explicit && command && !command.includes('/') && !flag(env.BRIDGE_USE_HOST_CLIS, false)) {
      for (const cand of [path.join(vendorDir, 'node_modules', '.bin', command), path.join(vendorDir, 'bin', command)]) {
        if (existsSync(cand)) { command = cand; break; }
      }
    }
```

and add `baseCommand,` to the frozen profile object. Add `strictVersions: flag(env.BRIDGE_STRICT_VERSIONS, false),` to the returned top-level config.

- [ ] **Step 5.4:** Run `test/config.test.js` → PASS; then full suite → expect `pass 219` (211 + 8), fail 0.
- [ ] **Step 5.5:** Commit: `git add src/config.js test/config.test.js && git commit -m "feat: vendor-first command resolution + BRIDGE_STRICT_VERSIONS flag"`

---

### Task 6: Part B4 — autoupdate suppression via per-profile `envSet`

**Files:**
- Modify: `src/config.js` (BUILTIN_PROFILES claude/claude-headless; profile resolver), `src/session.js` (constructor), `src/facade/headlessClaudeRunner.js` (env build), the `new Session(` call site in `src/sessionManager.js` (find with `grep -n 'new Session(' src/`)
- Test: `test/config.test.js`, `test/session.test.js` (append)

**Interfaces:**
- Produces: every profile has frozen `envSet: {[VAR]: value}` (empty for most); `Session` constructor accepts `envSet` and applies it to the child env AFTER `envScrub`; headless runner applies `profile.envSet` the same way.

- [ ] **Step 6.1: Investigate switches** (5 min, no live turns): `codex --help 2>&1 | grep -iA2 update`, `copilot --help 2>&1 | grep -iA2 update`, `agy --help 2>&1 | grep -iA2 update`. If a CLI documents a no-self-update env var or flag, add it to that profile's `envSet`/`args` with a comment naming where it's documented; if not, leave `envSet` empty for it — the adapters' recognized-dialog handling (codex "Skip until next version") stays the backstop. Record findings as a comment on BUILTIN_PROFILES.
- [ ] **Step 6.2: Failing tests.** In `test/config.test.js`:

```js
test('envSet: claude profiles disable the autoupdater; others empty; frozen', () => {
  const c = loadConfig({});
  assert.deepEqual(c.profiles.claude.envSet, { DISABLE_AUTOUPDATER: '1' });
  assert.deepEqual(c.profiles['claude-headless'].envSet, { DISABLE_AUTOUPDATER: '1' });
  assert.deepEqual(c.profiles.generic.envSet, {});
  assert.throws(() => { c.profiles.claude.envSet.X = '1'; });
});
```

In `test/session.test.js` (match its existing bash-spawning style):

```js
test('envSet lands in the child env after scrub', async () => {
  const s = new Session({
    command: 'bash', args: ['-c', 'echo "AU=$DISABLE_AUTOUPDATER"'],
    cwd: process.cwd(), envScrub: [], envSet: { DISABLE_AUTOUPDATER: '1' },
  });
  await new Promise((r) => s.once('exit', r));
  assert.match(s.scrollback(), /AU=1/);
});
```

- [ ] **Step 6.3:** Run both files → FAIL. Implement: in `config.js` BUILTIN_PROFILES add `envSet: { DISABLE_AUTOUPDATER: '1' }` to `claude` and `claude-headless` (Claude Code's documented autoupdater kill-switch env var); resolver adds `envSet: Object.freeze({ ...(base.envSet || {}) }),` to the frozen profile. In `session.js`: constructor destructures `envSet = {}` and after the scrub loop adds `Object.assign(childEnv, envSet);`. In `sessionManager.js`, pass `envSet: profile.envSet` at the `new Session(` site. In `headlessClaudeRunner.js`, after the scrub loop: `Object.assign(env, profile.envSet || {});`.
- [ ] **Step 6.4:** Run both test files → PASS; full suite → expect `pass 221`, fail 0.
- [ ] **Step 6.5:** Commit: `git add src/config.js src/session.js src/sessionManager.js src/facade/headlessClaudeRunner.js test/config.test.js test/session.test.js && git commit -m "feat: per-profile envSet; disable claude autoupdater in spawned children"`

---

### Task 7: Part B5 — boot version handshake

**Files:**
- Create: `src/versionCheck.js`
- Modify: `src/server.js` (boot sequence)
- Test: `test/versionCheck.test.js`

**Interfaces:**
- Consumes: `extractVersion`, `loadPins` from `src/pins.js` (Task 4); `profile.baseCommand` (Task 5); `config.strictVersions` (Task 5).
- Produces: `checkVersions(profiles, pins, {exec, log}) -> Promise<{results, mismatches}>` where results items are `{command, path, wanted, got, ok, profiles}`; `applyStrict(report)` throws on mismatches. `exec(cmdPath) -> Promise<{err, out}>` is injectable for tests.

- [ ] **Step 7.1: Failing tests** in `test/versionCheck.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVersions, applyStrict } from '../src/versionCheck.js';

const profiles = {
  claude: { name: 'claude', command: '/v/claude', baseCommand: 'claude' },
  'claude-headless': { name: 'claude-headless', command: '/v/claude', baseCommand: 'claude' },
  codex: { name: 'codex', command: 'codex', baseCommand: 'codex' },
  generic: { name: 'generic', command: null, baseCommand: null },
};
const pins = {
  claude: { source: 'npm', package: 'x', version: '2.1.219' },
  codex: { source: 'npm', package: 'y', version: '0.134.0' },
};
const silent = { log: () => {}, warn: () => {} };

test('handshake: match ok, mismatch flagged, one exec per shared binary', async () => {
  const calls = [];
  const exec = async (p) => { calls.push(p); return { err: null, out: p === '/v/claude' ? '2.1.219 (Claude Code)' : 'codex-cli 0.999.0' }; };
  const r = await checkVersions(profiles, pins, { exec, log: silent });
  assert.equal(calls.length, 2);                       // claude counted once despite two profiles
  assert.equal(r.results.find((x) => x.command === 'claude').ok, true);
  assert.deepEqual(r.results.find((x) => x.command === 'claude').profiles.sort(), ['claude', 'claude-headless']);
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0].command, 'codex');
  assert.equal(r.mismatches[0].got, '0.999.0');
});

test('handshake: exec failure tolerated -> mismatch with got=null', async () => {
  const exec = async () => ({ err: new Error('ENOENT'), out: '' });
  const r = await checkVersions(profiles, pins, { exec, log: silent });
  assert.ok(r.mismatches.every((m) => m.got === null));
});

test('handshake: commands without a pin are skipped', async () => {
  const r = await checkVersions(profiles, { }, { exec: async () => { throw new Error('must not exec'); }, log: silent });
  assert.deepEqual(r.results, []);
});

test('applyStrict throws listing every mismatch; passes on clean report', () => {
  assert.throws(() => applyStrict({ mismatches: [{ command: 'codex', wanted: '0.134.0', got: '0.999.0', path: 'codex' }] }),
    /codex: wanted 0\.134\.0, got 0\.999\.0/);
  applyStrict({ mismatches: [] });                     // no throw
});
```

- [ ] **Step 7.2:** Run → FAIL. **Implement `src/versionCheck.js`:**

```js
// src/versionCheck.js — boot-time handshake between the binaries the bridge
// will spawn and the versions the adapters were verified against
// (cli-pins.json). Warn-only by default; BRIDGE_STRICT_VERSIONS=1 makes a
// mismatch fatal at boot (server.js). Never blocks boot on exec failure.
import { execFile } from 'node:child_process';

function execVersion(cmdPath) {
  return new Promise((resolve) => {
    execFile(cmdPath, ['--version'], { timeout: 5000 }, (err, stdout, stderr) => {
      resolve({ err, out: `${stdout || ''}${stderr || ''}` });
    });
  });
}

import { extractVersion } from './pins.js';

export async function checkVersions(profiles, pins, { exec = execVersion, log = console } = {}) {
  const byCommand = new Map();
  for (const p of Object.values(profiles)) {
    if (!p.command || !p.baseCommand) continue;
    const pin = pins[p.baseCommand];
    if (!pin) continue;
    const e = byCommand.get(p.baseCommand) || { path: p.command, wanted: pin.version, profiles: [] };
    e.profiles.push(p.name);
    byCommand.set(p.baseCommand, e);
  }
  const results = [];
  for (const [command, e] of byCommand) {
    const { err, out } = await exec(e.path);
    const got = err ? null : extractVersion(out);
    const ok = !err && got === e.wanted;
    results.push({ command, path: e.path, wanted: e.wanted, got, ok, profiles: e.profiles });
    if (ok) log.log(`version ok: ${command} ${got} (${e.path})`);
    else log.warn(`VERSION MISMATCH: ${command} wanted ${e.wanted}, got ${got ?? 'unknown'} (${e.path}) — run "npm run pin", then the live canary (README "Updating a pinned CLI")`);
  }
  return { results, mismatches: results.filter((r) => !r.ok) };
}

export function applyStrict(report) {
  if (!report.mismatches.length) return;
  const lines = report.mismatches.map((m) => `  ${m.command}: wanted ${m.wanted}, got ${m.got ?? 'unknown'} (${m.path})`);
  throw new Error(`BRIDGE_STRICT_VERSIONS=1 and pinned-CLI versions mismatch:\n${lines.join('\n')}\nRe-run "npm run pin" or update cli-pins.json (then run the live canary).`);
}
```

(Move the `import { extractVersion }` to the top with the other import — shown mid-file above only to highlight the dependency.)

- [ ] **Step 7.3:** Run → PASS. **Wire into `src/server.js`** (before `server.listen`, top-level await is fine in ESM):

```js
import { loadPins } from './pins.js';
import { checkVersions, applyStrict } from './versionCheck.js';
// ... after `const config = loadConfig();`
for (const p of Object.values(config.profiles)) {
  if (p.command) console.log(`profile ${p.name}: ${p.command}`);
}
const versionReport = await checkVersions(config.profiles, loadPins());
if (config.strictVersions) {
  try { applyStrict(versionReport); } catch (e) { console.error(e.message); process.exit(1); }
}
```

- [ ] **Step 7.4:** Full suite → expect `pass 225`, fail 0. Manual boot check: `BRIDGE_TOKEN=t node src/server.js &` then kill — boot logs show per-profile resolved paths and per-pin version lines (host CLIs, so `claude` should report `ok 2.1.219`… or a mismatch warning, both prove the handshake runs).
- [ ] **Step 7.5:** Commit: `git add src/versionCheck.js src/server.js test/versionCheck.test.js && git commit -m "feat: boot version handshake against cli-pins.json (warn / strict)"`

---

### Task 8: Part B6 — bump-workflow docs + full sweep

**Files:**
- Modify: `README.md` (new "Version pinning" section, near Configuration)

**Interfaces:** none.

- [ ] **Step 8.1:** Add a README section:

```markdown
## Version pinning (decoupling from host autoupdates)

Adapter markers are version-pinned UI copy — a host CLI autoupdate can break
turn mechanics silently. `cli-pins.json` pins each CLI to the version its
adapter was verified against; `npm run pin` installs those exact versions
under `vendor/` (gitignored), and the bridge prefers `vendor/` bins over the
host `PATH` automatically (env overrides still win;
`BRIDGE_USE_HOST_CLIS=1` opts back into host bins). At boot the bridge runs
`--version` on every pinned CLI and warns on drift;
`BRIDGE_STRICT_VERSIONS=1` turns the warning into a refusal to boot.

### Updating a pinned CLI

1. Edit the version in `cli-pins.json`; run `npm run pin`.
2. Run the live canary: `node scripts/live-acceptance.mjs` (spends real
   quota; expect the first run after a CLI update to fail if UI copy moved).
3. Fix adapter markers/fixtures if drifted; update the adapter's
   verified-version comment.
4. Commit the manifest and adapter/fixture changes together.

A pin protects against *surprise* updates; it is not "frozen forever" —
vendors can force-obsolete old versions server-side, so expect to walk pins
forward deliberately.
```

- [ ] **Step 8.2:** Sweep + suite: `grep -riE 'xdr|defender|threat.hunt' . --exclude-dir=superpowers --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=vendor --exclude-dir=scratch` → zero hits; full suite → 225 pass.
- [ ] **Step 8.3:** Commit: `git add README.md && git commit -m "docs: version-pinning + bump workflow section"`

---

### Task 9: Real pin run + live validation (controller-side, foreground — NEVER a subagent)

**Files:** possibly `cli-pins.json` (sha256 write-back; claude contingency), `src/adapters/claude.js` (verified-version comment).

- [ ] **Step 9.1:** `npm run pin` → expect npm install of 3 pins + agy snapshot + report, all `ok`. (First run writes agy's sha256 into `cli-pins.json` — commit that.)
- [ ] **Step 9.2:** Boot check: `BRIDGE_TOKEN=t node src/server.js` (background via run_in_background, then kill): boot log must show `profile claude: <repo>/vendor/node_modules/.bin/claude` etc. and `version ok` lines for all four pins. Also boot once with `BRIDGE_USE_HOST_CLIS=1` and confirm the claude path reverts to host — that pair of logs is the spec's "host update can't change what the bridge spawns" evidence (host and vendor are now independent copies).
- [ ] **Step 9.3:** Live acceptance (spends real quota, ~9 turns; pre-approved drift canary): `node scripts/live-acceptance.mjs > /tmp/live.out 2>&1` foreground, then read. Expect 9/9.
  - **Contingency (claude 2.1.219 drift):** if claude-profile checks fail on marker drift, capture the failure, set `cli-pins.json` claude to `2.1.218`, re-run `npm run pin`, re-run `node scripts/live-acceptance.mjs claude` — the verified version stays pinned and 2.1.219 becomes a normal future bump via the Task 8 workflow. Record the outcome in the commit message.
  - If 2.1.219 passes: update `src/adapters/claude.js`'s verified-version comment to 2.1.219.
- [ ] **Step 9.4:** Commit whatever moved: `git add cli-pins.json src/adapters/claude.js && git commit -m "chore: record initial pin set (live-validated)"`

---

### Task 10 (STRETCH): Part C — Docker packaging

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docs/DOCKER.md`
- Modify: `README.md` (one link line in the deployment/pinning area)

Skip cleanly (record why) if the image build fails on environmental grounds; A/B must not depend on this task.

- [ ] **Step 10.1:** `.dockerignore`: `node_modules`, `vendor`, `scratch`, `.git`, `docs`, `test`, `.superpowers`, `*.log`.
- [ ] **Step 10.2:** `Dockerfile`:

```dockerfile
FROM node:20-bookworm-slim
# node-pty compiles a native addon at install time
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY bin ./bin
COPY scripts ./scripts
COPY cli-pins.json ./
# npm pins bake into the image; external pins (agy) bind-mount at runtime
RUN node scripts/pin-clis.mjs --npm-only
RUN useradd -m bridge && chown -R bridge /app
USER bridge
ENV HOST=0.0.0.0 PORT=7681
EXPOSE 7681
CMD ["node", "src/server.js"]
```

- [ ] **Step 10.3:** Build: `docker build -t pty-web-bridge . > /tmp/docker-build.out 2>&1; tail -5 /tmp/docker-build.out` → success.
- [ ] **Step 10.4:** Smoke (no CLI auth needed — generic/bash profile): start `docker run -d --name pwb-smoke -p 127.0.0.1:7699:7681 -e BRIDGE_TOKEN=t -e BRIDGE_PROFILES=generic -e PROFILE_GENERIC_COMMAND=bash -e DEFAULT_PROFILE=generic pty-web-bridge`, then exercise the documented session curl from README's Programmatic API section against `:7699` (create session, expect JSON with a session id), then `docker rm -f pwb-smoke`.
- [ ] **Step 10.5:** `docs/DOCKER.md`: image build/run, the volume mounts for auth state (`-v ~/.claude:/home/bridge/.claude -v ~/.codex:/home/bridge/.codex`), one-time interactive logins via `docker exec -it <ctr> claude`, agy runtime mount (`-v /path/to/agy-bin:/app/vendor/bin`), loopback publishing (`-p 127.0.0.1:7681:7681`), and the **documented known limitation**: copilot's gh-keyring auth is untested/awkward headless — copilot in-container is best-effort until a file-based auth path is verified. README gets one link to it.
- [ ] **Step 10.6:** Full suite still green; commit: `git add Dockerfile .dockerignore docs/DOCKER.md README.md && git commit -m "feat: Docker packaging from the pin manifest (stretch)"`

---

### Task 11: Finish — review, PR

- [ ] **Step 11.1:** Full suite (`node --test > /tmp/suite-final.out 2>&1; tail -3`) → all pass; leaked-PTY check `pgrep -f '[f]ake-repl'` → none.
- [ ] **Step 11.2:** Success-criteria sweep against spec §7 (grep criterion, banner, boot logs, renamed repo reachable).
- [ ] **Step 11.3:** Dispatch a code-review subagent over `git diff master...HEAD` (superpowers:requesting-code-review); fix what's real (superpowers:receiving-code-review).
- [ ] **Step 11.4:** Push branch; `gh pr create` with a summary keyed to the spec's parts; user merges (repo practice: merge-commit, branch kept).
- [ ] **Step 11.5:** Update auto-memory project-status file: Phase 3 implemented, PR open.

---

## Self-review notes (run after drafting)

- Spec coverage: A1→Task 1, A2→Task 2, A3→Task 3, B1/B2→Task 4, B3→Task 5, B4→Task 6, B5→Task 7, B6→Task 8, initial-pin live gate→Task 9, C→Task 10, criteria §7→Task 11.
- Test-count expectations (211/219/221/225) are directional; assert `fail 0` as the hard gate and update counts as measured.
- `DISABLE_AUTOUPDATER=1` is Claude Code's documented kill-switch; Task 6 Step 6.1 verifies the other CLIs empirically rather than assuming.
