# Universal CLI Support (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One bridge process hosts PTY sessions of different AI CLIs (claude, codex, gemini, copilot, generic), selected per session via named profiles, with fixture-verified state-detection adapters and clean assistant-text extraction.

**Architecture:** Generalize the existing single-CLI machinery: `config.js` grows a resolved `profiles` table (one total precedence order), `adapters/index.js` becomes a strict registry, the adapter contract gains `isBusy`/`extractResponse`/`startupDialogs`/multiline members, `SessionManager.create` accepts a profile and applies its env-scrub/dialog policy, and the HTTP/WS APIs gain a `profile` parameter. New adapters are built fixture-first: capture real CLI screens under node-pty, render via `@xterm/headless`, derive markers from rendered lines.

**Tech Stack:** Node ≥ 20 ESM, `node-pty`, `@xterm/headless`, `ws`, `node --test`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-23-universal-cli-and-api-facade-design.md` (Phase 1 sections are authoritative; this plan implements Phase 1 only).

## Global Constraints

- Node `>=20`, ESM (`"type": "module"`), tests via `node --test` from the repo root (`npm test`). The bridge itself and all `src`/`test` code stay on the `>=20` baseline (this machine is Node v20.19.2). **Exception, Task 13 only:** the GitHub Copilot CLI's npm install requires Node 22+; that capture task carries its own preflight and does not raise the project baseline.
- No new runtime dependencies. Dev-time capture scripts live in `scratch/`, fixtures in `test/fixtures/`.
- Backward compatibility (spec "Goals"): documented values of `CLAUDE_CMD`, `CLAUDE_ARGS`, `ADAPTER`, `QUIESCENCE_MS`, `COLS`, `ROWS`, `CWD`, `PROMPT_TIMEOUT_MS`, `SCROLLBACK`, `RING_BYTES` keep working; unknown `ADAPTER` now fails fast at boot.
- Profile field precedence, highest first (spec "Profiles"): (1) `PROFILE_<NAME>_*` env override → (2) profiles-table value (legacy `CLAUDE_CMD`/`CLAUDE_ARGS` mapping lands here) → (3) legacy global env vars → (4) built-in defaults. `<NAME>` is the profile name uppercased with `-` → `_`.
- Env-scrub lists (spec, verbatim): claude & claude-headless `ANTHROPIC_API_KEY`,`ANTHROPIC_AUTH_TOKEN`; codex `OPENAI_API_KEY`,`CODEX_API_KEY`; gemini `GEMINI_API_KEY`,`GOOGLE_API_KEY`,`GOOGLE_APPLICATION_CREDENTIALS`,`GOOGLE_GENAI_USE_VERTEXAI`,`GOOGLE_CLOUD_PROJECT`,`GOOGLE_CLOUD_PROJECT_ID`,`GOOGLE_CLOUD_LOCATION`; copilot `GH_TOKEN`,`GITHUB_TOKEN`,`COPILOT_GITHUB_TOKEN`; generic none.
- `dialogPolicy` ∈ `startup-only` (default) | `auto-approve` | `never` with the exact semantics from the spec's Profiles section.
- Adapter markers are matched against **rendered** lines (`TerminalModel.viewportTail` / `renderLinesSince`), never raw PTY bytes (see `test/fixtures/NOTES.md` "Critical architecture finding").
- Commit after every green task. Plain commit messages, no attribution trailers.
- Live-CLI capture tasks (9, 11, 13) consume real subscription quota — keep prompts to the single `reply with exactly: PONG` message specified.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/config.js` | env → frozen config; NEW: resolved `profiles` table, `defaultProfile`, `BRIDGE_PROFILES`, back-compat mapping | Modify |
| `src/adapters/index.js` | strict name→adapter registry (unknown throws) | Modify |
| `src/adapters/claude.js` | + `isBusy`, `extractResponse`, `startupDialogs` | Modify |
| `src/adapters/generic.js` | + identity `extractResponse`, `multiline: 'raw'` | Modify |
| `src/adapters/codex.js` | codex adapter (fixture-derived) | Create |
| `src/adapters/gemini.js` | gemini adapter (fixture-derived) | Create |
| `src/adapters/copilot.js` | copilot adapter (pre-auth fixtures real, rest marked unverified) | Create |
| `src/promptWriter.js` | shared multiline-safe prompt writer | Create |
| `src/stateDetector.js` | + `isBusy` quiet-tick gate, periodic marker evaluation | Modify |
| `src/session.js` | `envScrub` option replaces hardcoded ANTHROPIC deletes | Modify |
| `src/sessionManager.js` | per-session profile resolution, dialog-policy wiring | Modify |
| `src/httpApi.js` | `profile` on session create/list, `text` field on `/prompt`, multiline 400 | Modify |
| `src/wsApi.js` | `?profile=` (creation only), 400 pre-upgrade rejection | Modify |
| `public/index.html` | pass `?profile=` through to the WS URL | Modify |
| `scratch/capture-codex.mjs`, `scratch/capture-gemini.mjs`, `scratch/capture-copilot.mjs`, `scratch/render-fixture.mjs` | capture/render tooling | Create |
| `test/fixtures/codex-*.txt`, `gemini-*.txt`, `copilot-*.txt`, `NOTES.md` | raw PTY fixtures + spike writeups | Create/Modify |
| `test/config.test.js`, `test/adapters.test.js`, `test/promptWriter.test.js`, `test/stateDetector.test.js`, `test/session.test.js`, `test/sessionManager.test.js`, `test/httpApi.test.js`, `test/wsApi.test.js` | tests | Modify/Create |
| `README.md`, `docs/API.md`, `docs/ARCHITECTURE.md` | document profiles, `text` field, new env vars | Modify |

---

### Task 1: Profile resolution in config.js

**Files:**
- Modify: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadConfig(env)` additionally returns `profiles` (frozen map: name → frozen `{name, command, args, adapter, envScrub, dialogPolicy, mode, quiescenceMs, cols, rows, cwd}`) and `defaultProfile` (string). All existing fields (`claudeCmd`, `claudeArgs`, `adapter`, …) remain. Throws on: unknown `ADAPTER` value, unknown name in `BRIDGE_PROFILES`, invalid `PROFILE_<NAME>_DIALOG_POLICY`, `DEFAULT_PROFILE` not in the enabled set.

- [ ] **Step 1: Write the failing tests** — append to `test/config.test.js`:

```js
// ---- profiles (Phase 1: universal CLI support) ----

test('profiles: built-ins present with commands, adapters, scrub lists', () => {
  const c = loadConfig({});
  assert.deepEqual(
    Object.keys(c.profiles).sort(),
    ['claude', 'claude-headless', 'codex', 'copilot', 'gemini', 'generic'],
  );
  assert.equal(c.profiles.claude.command, 'claude');
  assert.equal(c.profiles.claude.adapter, 'claude');
  assert.deepEqual(c.profiles.claude.envScrub, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  assert.equal(c.profiles.codex.command, 'codex');
  assert.deepEqual(c.profiles.codex.envScrub, ['OPENAI_API_KEY', 'CODEX_API_KEY']);
  assert.deepEqual(c.profiles.gemini.envScrub, [
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_LOCATION',
  ]);
  assert.deepEqual(c.profiles.copilot.envScrub, ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN']);
  assert.equal(c.profiles['claude-headless'].mode, 'headless');
  assert.equal(c.profiles['claude-headless'].adapter, null);
  assert.equal(c.profiles.generic.command, null);
  assert.equal(c.defaultProfile, 'claude');
  assert.equal(c.profiles.claude.dialogPolicy, 'startup-only');
  assert.equal(c.profiles.claude.mode, 'pty');
});

test('profiles: per-profile env override beats table; legacy global beats builtin default', () => {
  const c = loadConfig({
    PROFILE_CODEX_COMMAND: '/opt/codex/bin/codex',
    PROFILE_CODEX_ARGS: '["--sandbox","read-only"]',
    PROFILE_GEMINI_QUIESCENCE_MS: '800',
    QUIESCENCE_MS: '650',
    COLS: '200',
  });
  assert.equal(c.profiles.codex.command, '/opt/codex/bin/codex');
  assert.deepEqual(c.profiles.codex.args, ['--sandbox', 'read-only']);
  assert.equal(c.profiles.gemini.quiescenceMs, 800);   // level 1 beats level 3
  assert.equal(c.profiles.codex.quiescenceMs, 650);    // level 3 (legacy global)
  assert.equal(c.profiles.claude.cols, 200);           // legacy global applies to every profile
});

test('profiles: hyphenated names map to underscored env keys', () => {
  const c = loadConfig({ PROFILE_CLAUDE_HEADLESS_QUIESCENCE_MS: '900' });
  assert.equal(c.profiles['claude-headless'].quiescenceMs, 900);
});

test('profiles: legacy CLAUDE_CMD/CLAUDE_ARGS land on the claude profile at table level', () => {
  const c = loadConfig({ CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]' });
  assert.equal(c.profiles.claude.command, 'bash');
  assert.deepEqual(c.profiles.claude.args, ['-i']);
  // per-profile env override still wins over the legacy mapping
  const c2 = loadConfig({ CLAUDE_CMD: 'bash', PROFILE_CLAUDE_COMMAND: 'zsh' });
  assert.equal(c2.profiles.claude.command, 'zsh');
});

test('profiles: ADAPTER=generic keeps legacy behavior (default profile + effective command)', () => {
  const c = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash' });
  assert.equal(c.defaultProfile, 'generic');
  assert.equal(c.profiles.generic.command, 'bash');
  // bare ADAPTER=generic (CLAUDE_CMD unset) must also keep working: effective claude cmd defaults to 'claude'
  const c2 = loadConfig({ ADAPTER: 'generic' });
  assert.equal(c2.defaultProfile, 'generic');
  assert.equal(c2.profiles.generic.command, 'claude');
  // PROFILE_GENERIC_COMMAND beats the legacy mapping
  const c3 = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash', PROFILE_GENERIC_COMMAND: 'sh' });
  assert.equal(c3.profiles.generic.command, 'sh');
});

test('profiles: legacy ADAPTER=generic inherits the ANTHROPIC scrub (back-compat)', () => {
  // Existing ADAPTER=generic deployments must keep stripping ANTHROPIC_* from
  // children (spec Security back-compat). A fresh generic-by-name stays scrub-free.
  const legacy = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash' });
  assert.deepEqual(legacy.profiles.generic.envScrub, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  const fresh = loadConfig({ PROFILE_GENERIC_COMMAND: 'bash' }); // generic exists but not via legacy mapping
  assert.deepEqual(fresh.profiles.generic.envScrub, []);
});

test('profiles: a shipped table numeric value is honored above the legacy global (level 2)', () => {
  // Simulate a fixture-spike default by asserting the resolver reads base.<field>.
  // (Task 12 adds such a value to BUILTIN_PROFILES.gemini; this test pins the
  //  resolver mechanism now using claude, which ships none, as the control.)
  // Control: claude ships no quiescenceMs, so the legacy global wins.
  const c = loadConfig({ QUIESCENCE_MS: '650' });
  assert.equal(c.profiles.claude.quiescenceMs, 650);
  // Override still beats everything.
  const c2 = loadConfig({ QUIESCENCE_MS: '650', PROFILE_CLAUDE_QUIESCENCE_MS: '900' });
  assert.equal(c2.profiles.claude.quiescenceMs, 900);
});

test('profiles: unknown ADAPTER fails fast', () => {
  assert.throws(() => loadConfig({ ADAPTER: 'copilot' }), /unknown ADAPTER/);
});

test('profiles: a headless or command-less DEFAULT_PROFILE is rejected at boot', () => {
  // A bare /ws or POST /api/sessions must be spawnable.
  assert.throws(() => loadConfig({ DEFAULT_PROFILE: 'claude-headless' }), /headless-mode|must be a pty/);
  assert.throws(
    () => loadConfig({ BRIDGE_PROFILES: 'generic', DEFAULT_PROFILE: 'generic' }), // generic has no command
    /no command configured/,
  );
});

test('profiles: BRIDGE_PROFILES allowlists; unknown name throws; DEFAULT_PROFILE validated', () => {
  const c = loadConfig({ BRIDGE_PROFILES: 'claude,codex' });
  assert.deepEqual(Object.keys(c.profiles).sort(), ['claude', 'codex']);
  assert.throws(() => loadConfig({ BRIDGE_PROFILES: 'claude,nope' }), /unknown profile "nope"/);
  assert.throws(() => loadConfig({ BRIDGE_PROFILES: 'codex', }), /DEFAULT_PROFILE/); // default 'claude' not enabled
  const c2 = loadConfig({ BRIDGE_PROFILES: 'codex', DEFAULT_PROFILE: 'codex' });
  assert.equal(c2.defaultProfile, 'codex');
});

test('profiles: PROFILE_<NAME>_ENV_SCRUB and _DIALOG_POLICY overrides; bad policy throws', () => {
  const c = loadConfig({ PROFILE_CODEX_ENV_SCRUB: 'FOO, BAR', PROFILE_CODEX_DIALOG_POLICY: 'never' });
  assert.deepEqual(c.profiles.codex.envScrub, ['FOO', 'BAR']);
  assert.equal(c.profiles.codex.dialogPolicy, 'never');
  assert.throws(() => loadConfig({ PROFILE_CODEX_DIALOG_POLICY: 'yolo' }), /dialogPolicy/);
});

test('profiles: frozen', () => {
  const c = loadConfig({});
  assert.throws(() => { c.profiles.claude.command = 'x'; });
  assert.throws(() => { c.profiles.claude.args.push('x'); });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/config.test.js`
Expected: FAIL — the new tests error on `c.profiles` being `undefined` / missing throws. The 7 pre-existing tests still pass.

- [ ] **Step 3: Implement** — replace `src/config.js` with:

```js
import crypto from 'node:crypto';

function num(v, d) { if (v == null || String(v).trim() === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; }

function jsonArray(v, d = []) {
  if (!v) return d;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : d; } catch { return d; }
}

const DIALOG_POLICIES = ['startup-only', 'auto-approve', 'never'];

// Built-in profile table (spec "Profiles (config.js)"). Numeric/cwd fields are
// OPTIONAL here: a profile that omits them resolves through the legacy globals
// (QUIESCENCE_MS/COLS/ROWS/CWD) so existing deployments keep their tuning
// (precedence level 3); a profile that ships one (e.g. a fixture-spike-derived
// `quiescenceMs: 800` added to `gemini` in Task 12) has it honored as level 2,
// above the legacy global. The resolver reads `base.<field> ?? <global>`.
const BUILTIN_PROFILES = {
  claude: {
    command: 'claude', args: [], adapter: 'claude',
    envScrub: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    dialogPolicy: 'startup-only', mode: 'pty',
  },
  codex: {
    command: 'codex', args: [], adapter: 'codex',
    envScrub: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    dialogPolicy: 'startup-only', mode: 'pty',
  },
  gemini: {
    command: 'gemini', args: [], adapter: 'gemini',
    envScrub: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_LOCATION'],
    dialogPolicy: 'startup-only', mode: 'pty',
  },
  copilot: {
    command: 'copilot', args: [], adapter: 'copilot',
    envScrub: ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN'],
    dialogPolicy: 'startup-only', mode: 'pty',
  },
  'claude-headless': {
    command: 'claude', args: [], adapter: null,
    envScrub: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    dialogPolicy: 'startup-only', mode: 'headless',
  },
  generic: {
    command: null, args: [], adapter: 'generic',
    envScrub: [], dialogPolicy: 'startup-only', mode: 'pty',
  },
};

const envKey = (name) => name.toUpperCase().replace(/-/g, '_');

export function loadConfig(env = process.env) {
  const token = env.BRIDGE_TOKEN || crypto.randomBytes(24).toString('base64url');
  const claudeCmd = env.CLAUDE_CMD || 'claude';
  const claudeArgs = Object.freeze(jsonArray(env.CLAUDE_ARGS));
  const cwd = env.CWD || env.HOME || process.cwd();
  const quiescenceMs = num(env.QUIESCENCE_MS, 500);
  const cols = num(env.COLS, 120);
  const rows = num(env.ROWS, 30);

  if (env.ADAPTER && env.ADAPTER !== 'generic' && env.ADAPTER !== 'claude') {
    throw new Error(`unknown ADAPTER "${env.ADAPTER}" (valid: claude, generic)`);
  }

  const allow = env.BRIDGE_PROFILES
    ? env.BRIDGE_PROFILES.split(',').map((s) => s.trim()).filter(Boolean)
    : Object.keys(BUILTIN_PROFILES);

  const profiles = {};
  for (const name of allow) {
    const base = BUILTIN_PROFILES[name];
    if (!base) {
      throw new Error(`unknown profile "${name}" in BRIDGE_PROFILES (valid: ${Object.keys(BUILTIN_PROFILES).join(', ')})`);
    }
    const P = (field) => env[`PROFILE_${envKey(name)}_${field}`];

    // Precedence level 2 (table), including the legacy mappings that land here.
    let command = base.command;
    let args = base.args;
    if (name === 'claude') {
      if (env.CLAUDE_CMD) command = env.CLAUDE_CMD;
      if (env.CLAUDE_ARGS) args = [...claudeArgs];
    }
    let envScrubBase = [...base.envScrub];
    if (name === 'generic' && env.ADAPTER === 'generic') {
      // Effective claude command/args (defaults 'claude'/[]), preserving both
      // ADAPTER=generic CLAUDE_CMD=bash and bare ADAPTER=generic behavior.
      command = claudeCmd;
      args = [...claudeArgs];
      // Legacy back-compat (spec Security): today Session unconditionally
      // strips ANTHROPIC_* from every child, and the README promises it for
      // exactly this ADAPTER=generic combo. Inherit the scrub so existing
      // deployments don't start leaking Anthropic creds to the child. A fresh
      // `generic` profile chosen by name keeps its scrub-free table entry.
      envScrubBase = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
    }
    // Precedence level 1 (per-profile env override) wins over level 2.
    if (P('COMMAND') != null) command = P('COMMAND');
    if (P('ARGS') != null) args = jsonArray(P('ARGS'));

    const dialogPolicy = P('DIALOG_POLICY') != null ? P('DIALOG_POLICY') : base.dialogPolicy;
    if (!DIALOG_POLICIES.includes(dialogPolicy)) {
      throw new Error(`invalid dialogPolicy "${dialogPolicy}" for profile "${name}" (valid: ${DIALOG_POLICIES.join(', ')})`);
    }
    const envScrub = P('ENV_SCRUB') != null
      ? P('ENV_SCRUB').split(',').map((s) => s.trim()).filter(Boolean)
      : envScrubBase;

    profiles[name] = Object.freeze({
      name,
      command,
      args: Object.freeze(args),
      adapter: base.adapter,
      envScrub: Object.freeze(envScrub),
      dialogPolicy,
      mode: base.mode,
      // Precedence for numerics/cwd: level 1 (PROFILE_<NAME>_*) → level 2
      // (a shipped table value if the profile provides one — most don't) →
      // level 3 (legacy global) → level 4 (built-in default). `?? quiescenceMs`
      // etc. supplies levels 3/4 when the table omits the field; a fixture
      // spike that ships e.g. `quiescenceMs: 800` in BUILTIN_PROFILES.gemini is
      // then honored here as level 2.
      quiescenceMs: num(P('QUIESCENCE_MS'), base.quiescenceMs ?? quiescenceMs),
      cols: num(P('COLS'), base.cols ?? cols),
      rows: num(P('ROWS'), base.rows ?? rows),
      cwd: P('CWD') != null ? P('CWD') : (base.cwd ?? cwd),
    });
  }

  const defaultProfile = env.ADAPTER === 'generic' ? 'generic' : (env.DEFAULT_PROFILE || 'claude');
  if (!profiles[defaultProfile]) {
    throw new Error(`DEFAULT_PROFILE "${defaultProfile}" is not an enabled profile (enabled: ${Object.keys(profiles).join(', ')})`);
  }
  // A bare POST /api/sessions or /ws must always be spawnable (spec Profiles):
  // reject a headless or command-less default at boot rather than crashing on
  // first connection.
  if (profiles[defaultProfile].mode !== 'pty') {
    throw new Error(`DEFAULT_PROFILE "${defaultProfile}" is ${profiles[defaultProfile].mode}-mode; a session default must be a pty profile`);
  }
  if (!profiles[defaultProfile].command) {
    throw new Error(`DEFAULT_PROFILE "${defaultProfile}" has no command configured (set PROFILE_${envKey(defaultProfile)}_COMMAND)`);
  }

  return Object.freeze({
    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 7681),
    token,
    tokenGenerated: !env.BRIDGE_TOKEN,
    claudeCmd,
    claudeArgs,
    cwd,
    quiescenceMs,
    promptTimeoutMs: num(env.PROMPT_TIMEOUT_MS, 600000),
    cols,
    rows,
    scrollback: num(env.SCROLLBACK, 5000),
    ringBytes: num(env.RING_BYTES, 262144),
    adapter: env.ADAPTER === 'generic' ? 'generic' : 'claude',
    profiles: Object.freeze(profiles),
    defaultProfile,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/config.test.js`
Expected: PASS (all pre-existing + new tests).

- [ ] **Step 5: Run the full suite to catch regressions**

Run: `npm test`
Expected: PASS (46 pre-existing tests unaffected — config output is a superset).

- [ ] **Step 6: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat(config): per-CLI profile table with total precedence order and BRIDGE_PROFILES allowlist"
```

---

### Task 2: Strict adapter registry

**Files:**
- Modify: `src/adapters/index.js`
- Test: `test/adapters.test.js` (the `getAdapter` block)

**Interfaces:**
- Consumes: existing `claude`, `generic` adapter objects.
- Produces: `getAdapter(name)` → adapter, **throws** `Error(/unknown adapter/)` for unrecognized names. Tasks 10/12/13 add `codex`/`gemini`/`copilot` entries to the same `REGISTRY` map.

- [ ] **Step 1: Update the failing test** — in `test/adapters.test.js`, replace the final test (`getAdapter: returns generic for "generic", claude otherwise`) with:

```js
test('getAdapter: strict registry — known names resolve, unknown names throw', () => {
  assert.equal(getAdapter('generic').name, 'generic');
  assert.equal(getAdapter('claude').name, 'claude');
  assert.throws(() => getAdapter('unknown-thing'), /unknown adapter "unknown-thing"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/adapters.test.js`
Expected: FAIL — `getAdapter('unknown-thing')` currently returns claude instead of throwing.

- [ ] **Step 3: Implement** — replace `src/adapters/index.js` with:

```js
// src/adapters/index.js
import { generic } from './generic.js';
import { claude } from './claude.js';

// Tasks 10/12/13 add codex/gemini/copilot imports + entries here.
const REGISTRY = { generic, claude };

export function getAdapter(name) {
  const a = REGISTRY[name];
  if (!a) throw new Error(`unknown adapter "${name}" (valid: ${Object.keys(REGISTRY).join(', ')})`);
  return a;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/adapters.test.js` then `npm test`
Expected: PASS. (`config.js` already rejects unknown `ADAPTER` values, so nothing reaches `getAdapter` with a bad name.)

- [ ] **Step 5: Commit**

```bash
git add src/adapters/index.js test/adapters.test.js
git commit -m "feat(adapters): strict registry — unknown adapter names throw"
```

---

### Task 3: Contract growth on claude + generic (extractResponse, isBusy, startupDialogs, multiline)

**Files:**
- Modify: `src/adapters/claude.js`, `src/adapters/generic.js`
- Test: `test/adapters.test.js`

**Interfaces:**
- Consumes: existing fixtures `test/fixtures/claude-{idle,trust,response}.txt`, `TerminalModel`.
- Produces (used by Tasks 4–7):
  - `adapter.isBusy(tailLines: string[]) → boolean` (claude only for now; optional member).
  - `adapter.extractResponse(lines: string[]) → string` (claude: chrome-stripped; generic: identity minus echoed first line).
  - `adapter.startupDialogs: Array<{matcher(tailLines: string[]) → boolean, answerKeys: string[]}>` (claude: trust dialog → `['enter']`).
  - `generic.multiline === 'raw'`.
  - `supportsBracketedPaste` stays **absent** on both (absent ⇒ treated as `true` by the writer; `generic.multiline === 'raw'` short-circuits before paste support is consulted).

- [ ] **Step 1: Write the failing tests** — append to `test/adapters.test.js`:

```js
// ---- Phase 1 contract growth ----

test('claude adapter: isBusy true on busy frame, false on idle frame', async () => {
  const a = getAdapter('claude');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  const full = fs.readFileSync('test/fixtures/claude-response.txt');
  await t.write(full.subarray(0, 4000)); // mid-generation window (see busy test above)
  assert.equal(a.isBusy(t.viewportTail(8)), true);
  const t2 = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t2.write(fs.readFileSync('test/fixtures/claude-idle.txt'));
  assert.equal(a.isBusy(t2.viewportTail(8)), false);
});

test('claude adapter: startupDialogs matches the trust dialog, answers with enter', async () => {
  const a = getAdapter('claude');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/claude-trust.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.startupDialogs.length >= 1, true);
  const hit = a.startupDialogs.find((d) => d.matcher(tail));
  assert.ok(hit, `no startupDialogs entry matched: ${JSON.stringify(tail)}`);
  assert.deepEqual(hit.answerKeys, ['enter']);
  // idle screen must NOT match
  const t2 = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t2.write(fs.readFileSync('test/fixtures/claude-idle.txt'));
  assert.equal(a.startupDialogs.some((d) => d.matcher(t2.viewportTail(8))), false);
});

test('claude adapter: extractResponse strips chrome, keeps the assistant reply', async () => {
  const a = getAdapter('claude');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/claude-response.txt'));
  const lines = t.renderLinesSince(0);
  const text = a.extractResponse(lines);
  assert.ok(text.includes('PONG'), `text was: ${JSON.stringify(text)}`);
  assert.ok(!/\? for shortcuts|esc to interrupt/.test(text), `text was: ${JSON.stringify(text)}`);
  assert.ok(!text.includes('❯'), `text was: ${JSON.stringify(text)}`);
  assert.ok(!/^\s*─+\s*$/m.test(text), `text was: ${JSON.stringify(text)}`);
});

test('generic adapter: extractResponse = identity minus echoed first line; multiline raw', () => {
  const a = getAdapter('generic');
  assert.equal(a.multiline, 'raw');
  assert.equal(a.extractResponse(['echo hi', 'hi', 'prompt$']), 'hi\nprompt$');
  assert.equal(a.extractResponse(['only-line']), 'only-line');
  assert.equal(a.extractResponse([]), '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/adapters.test.js`
Expected: FAIL — `isBusy`/`startupDialogs`/`extractResponse`/`multiline` undefined.

- [ ] **Step 3: Implement claude additions** — in `src/adapters/claude.js`, add below the existing marker constants:

```js
// Chrome lines to strip when extracting the assistant reply from a rendered
// transcript delta (spec: adapter contract, extractResponse). Derived from the
// same fixtures as the markers above. Best-effort by design.
const CHROME = [
  /^\s*─+\s*$/,          // input-box horizontal rules
  /\?\s*for shortcuts/,  // idle footer
  /esc to interrupt/,    // busy footer
  /^\s*◉/,               // effort/status footer line
  /^\s*❯/,               // input box (typed text before submit)
  /^\s*>\s/,             // submitted-prompt echo in the transcript
  /^\s*[✻✶✳]\s/,        // spinner / post-run summary lines ("✻ Crunched for 2s")
  /^\s*\+\d+ more ·/,    // banner overflow line
];
```

and extend the exported object:

```js
export const claude = {
  name: 'claude',
  isAwaitingInput(tail) { return anyMatch(tail, AWAITING_INPUT_MARKERS); },
  isBusy(tail) { return anyMatch(tail, BUSY_MARKERS); },
  isIdle(tail) {
    if (this.isAwaitingInput(tail)) return false;
    if (anyMatch(tail, BUSY_MARKERS)) return false;
    return anyMatch(tail, IDLE_MARKERS);
  },
  describePrompt(tail) { return this.isAwaitingInput(tail) ? tail.join('\n') : null; },
  extractResponse(lines) {
    const kept = lines.filter((l) => l.trim() !== '' && !CHROME.some((re) => re.test(l)));
    // "● " prefixes each response/tool block in the transcript — strip the marker.
    return kept.join('\n').replace(/^●\s?/gm, '').trim();
  },
  startupDialogs: [
    {
      // The every-launch trust dialog (test/fixtures/claude-trust.txt).
      matcher: (tail) => tail.some((l) => /Quick safety check:|Yes, I trust this folder/.test(l)),
      answerKeys: ['enter'],
    },
  ],
  keySeq(name) {
    return Object.prototype.hasOwnProperty.call(KEYS, name) ? KEYS[name] : String(name);
  },
};
```

If the `extractResponse` test is red because the fixture renders an unanticipated chrome line, **extend `CHROME` from the actual rendered lines** (print them with `console.log(JSON.stringify(lines))` in the test) — never weaken the test's exclusion assertions.

- [ ] **Step 4: Implement generic additions** — extend the exported object in `src/adapters/generic.js`:

```js
export const generic = {
  name: 'generic',
  multiline: 'raw', // legacy pass-through: newlines submit per line (spec exception)
  isIdle() { return true; },
  isAwaitingInput() { return false; },
  describePrompt() { return null; },
  extractResponse(lines) {
    // Identity minus the echoed first line (spec: adapter contract table).
    return (lines.length > 1 ? lines.slice(1) : lines).join('\n').trim();
  },
  keySeq(name) {
    return Object.prototype.hasOwnProperty.call(KEYS, name) ? KEYS[name] : String(name);
  },
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/adapters.test.js` then `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/claude.js src/adapters/generic.js test/adapters.test.js
git commit -m "feat(adapters): extractResponse, isBusy, startupDialogs on claude; raw-multiline identity extraction on generic"
```

---

### Task 4: Shared multiline-safe prompt writer

**Files:**
- Create: `src/promptWriter.js`
- Test: `test/promptWriter.test.js`

**Interfaces:**
- Consumes: an object with `.write(data)` (Session-shaped) and an adapter (`multiline`, `supportsBracketedPaste`, `newlineKey` members consulted).
- Produces (used by Task 7 and Phase 2):
  - `writePromptText(session, adapter, text) → void` — single-line text writes as-is; multiline follows spec order: `multiline:'raw'` → unchanged; bracketed paste (unless `supportsBracketedPaste === false`) → `\x1b[200~` + text + `\x1b[201~`; else `newlineKey` joins lines; else throws.
  - `class MultilineUnsupportedError extends Error`.

- [ ] **Step 1: Write the failing tests** — create `test/promptWriter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writePromptText, MultilineUnsupportedError } from '../src/promptWriter.js';

const fakeSession = () => { const w = []; return { writes: w, write: (d) => w.push(d) }; };

test('single-line text writes verbatim regardless of adapter', () => {
  const s = fakeSession();
  writePromptText(s, {}, 'hello');
  assert.deepEqual(s.writes, ['hello']);
});

test('multiline wraps in bracketed paste by default', () => {
  const s = fakeSession();
  writePromptText(s, {}, 'a\nb');
  assert.deepEqual(s.writes, ['\x1b[200~a\nb\x1b[201~']);
});

test('multiline raw passes through unchanged', () => {
  const s = fakeSession();
  writePromptText(s, { multiline: 'raw' }, 'a\nb');
  assert.deepEqual(s.writes, ['a\nb']);
});

test('paste opt-out with newlineKey joins lines with the key sequence', () => {
  const s = fakeSession();
  writePromptText(s, { supportsBracketedPaste: false, newlineKey: '\x1b\r' }, 'a\nb\nc');
  assert.deepEqual(s.writes, ['a\x1b\rb\x1b\rc']);
});

test('paste opt-out without newlineKey throws MultilineUnsupportedError', () => {
  const s = fakeSession();
  assert.throws(() => writePromptText(s, { supportsBracketedPaste: false }, 'a\nb'), MultilineUnsupportedError);
  assert.deepEqual(s.writes, []); // nothing partial written
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/promptWriter.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/promptWriter.js`:

```js
// Shared multiline-safe prompt writer (spec: "Multiline input").
// Order of strategies for text containing '\n':
//   1. adapter.multiline === 'raw'      → legacy pass-through (generic only)
//   2. bracketed paste (default)        → \x1b[200~ … \x1b[201~
//   3. adapter.newlineKey               → join lines with the key sequence
//   4. reject                           → MultilineUnsupportedError
export class MultilineUnsupportedError extends Error {}

export function writePromptText(session, adapter, text) {
  if (!text.includes('\n')) { session.write(text); return; }
  if (adapter.multiline === 'raw') { session.write(text); return; }
  if (adapter.supportsBracketedPaste !== false) {
    session.write(`\x1b[200~${text}\x1b[201~`);
    return;
  }
  if (adapter.newlineKey) { session.write(text.split('\n').join(adapter.newlineKey)); return; }
  throw new MultilineUnsupportedError('multiline input not supported by this profile');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/promptWriter.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/promptWriter.js test/promptWriter.test.js
git commit -m "feat: shared multiline-safe prompt writer (bracketed paste / newlineKey / raw / reject)"
```

---

### Task 5: StateDetector — isBusy gate + periodic marker evaluation

**Files:**
- Modify: `src/stateDetector.js`
- Test: `test/stateDetector.test.js`

**Interfaces:**
- Consumes: optional `adapter.isBusy(tail)` (Task 3); optional `dialogHandler` callback (built by SessionManager in Task 6).
- Produces (relied on by SessionManager/facade): public surface `state`, `markBusy()`, `waitForSettle()`, `'state'` event, plus a new constructor option `dialogHandler`. Behavior per spec "StateDetector changes":
  - **isBusy adapters**: a periodic tick every `quiescenceMs` evaluates markers even during sustained output. Data arrival alone does **not** demote an established `idle`/`awaiting_input` — marker evaluation owns downward transitions (so continuous spinner repaints can't trap the session in `busy`). `markBusy()` is the explicit "new turn" signal: it forces `busy`, resets the idle-tick counter, **and re-phases the periodic interval** so both confirming idle-ticks post-date the prompt write by a full quiescence period.
  - **pure-quiescence adapters** (no `isBusy`): unchanged legacy behavior — every data chunk ⇒ `busy`, settle on quiescence.
  - **idle confirmation**: `isIdle && !isBusy` for **two consecutive periodic ticks** ⇒ `idle`.
  - **dialog handling**: when a `dialogHandler` is set and `isAwaitingInput(tail)` is true, the detector calls `dialogHandler(tail)`; if it returns `true` (the policy consumed the dialog) the detector stays `busy` and re-arms — it does **not** emit `awaiting_input`, so an in-flight `sendPrompt` never sees an auto-answered dialog (fixes the leak where `waitForSettle` resolves on the same emit). Only a dialog the handler declines surfaces as `awaiting_input`.
  - interval cleared on exit.

- [ ] **Step 1: Write the failing tests** — append to `test/stateDetector.test.js`. **Do NOT add an `import` line** — the file already imports `EventEmitter` (line 3), `StateDetector`, and `assert`. Reuse its existing `fakeSession()` helper (an `EventEmitter` with `.alive`); these tests wrap it with a fake `terminalModel`:

```js
// ---- Phase 1: isBusy gate + periodic evaluation + dialog handler ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmOf = (tailRef) => ({ viewportTail: () => tailRef.value });

test('quiet + isBusy stays busy, then settles when isBusy clears', async () => {
  const tailRef = { value: ['working…'] };
  const session = fakeSession();
  let busy = true;
  const adapter = { isIdle: () => true, isAwaitingInput: () => false, isBusy: () => busy };
  const d = new StateDetector({ session, terminalModel: tmOf(tailRef), adapter, quiescenceMs: 40 });
  session.emit('data');
  await sleep(120); // quiet ticks elapse while isBusy is true
  assert.equal(d.state, 'busy');
  busy = false;
  await sleep(150); // markers now read idle ⇒ settles
  assert.equal(d.state, 'idle');
  session.emit('exit');
});

test('periodic evaluation reaches idle despite continuous output when markers say idle', async () => {
  const tailRef = { value: ['❯ ', 'ready'] };
  const session = fakeSession();
  const adapter = { isIdle: () => true, isAwaitingInput: () => false, isBusy: () => false };
  const d = new StateDetector({ session, terminalModel: tmOf(tailRef), adapter, quiescenceMs: 50 });
  const iv = setInterval(() => session.emit('data'), 20); // repaints, quiescence never fires
  await sleep(200);
  clearInterval(iv);
  assert.equal(d.state, 'idle', 'periodic ticks should classify idle during sustained output');
  session.emit('exit');
});

test('adapters without isBusy keep pure-quiescence behavior (no periodic interval)', async () => {
  const tailRef = { value: ['x'] };
  const session = fakeSession();
  const adapter = { isIdle: () => false, isAwaitingInput: () => false };
  const d = new StateDetector({ session, terminalModel: tmOf(tailRef), adapter, quiescenceMs: 30 });
  const iv = setInterval(() => session.emit('data'), 10);
  await sleep(120);
  clearInterval(iv);
  assert.equal(d.state, 'busy'); // no periodic path; output never went quiet
  session.emit('exit');
});

test('markBusy resets the consecutive-idle-tick counter and re-phases the interval', async () => {
  const tailRef = { value: ['ready'] };
  const session = fakeSession();
  const adapter = { isIdle: () => true, isAwaitingInput: () => false, isBusy: () => false };
  const d = new StateDetector({ session, terminalModel: tmOf(tailRef), adapter, quiescenceMs: 60 });
  const iv = setInterval(() => session.emit('data'), 20);
  await sleep(70);        // ~1 tick accumulated
  d.markBusy();           // reset — needs 2 fresh ticks from here
  await sleep(70);        // only ~1 tick since reset
  assert.equal(d.state, 'busy');
  await sleep(80);        // 2nd consecutive tick since reset
  clearInterval(iv);
  assert.equal(d.state, 'idle');
  session.emit('exit');
});

test('dialogHandler that consumes a dialog keeps the session busy (no awaiting_input leak)', async () => {
  const tailRef = { value: ['Trust this folder?'] };
  const session = fakeSession();
  const adapter = { isIdle: () => false, isAwaitingInput: () => /Trust/.test(tailRef.value.join('')), isBusy: () => false };
  let answered = 0;
  const d = new StateDetector({
    session, terminalModel: tmOf(tailRef), adapter, quiescenceMs: 30,
    dialogHandler: () => { answered += 1; return true; }, // pretend to answer
  });
  const settle = d.waitForSettle({ timeoutMs: 500 });
  session.emit('data');
  await sleep(90);                 // a couple of quiescence evaluations
  assert.ok(answered >= 1, 'handler should be consulted');
  assert.equal(d.state, 'busy', 'consumed dialog must not surface as awaiting_input');
  tailRef.value = ['done']; adapter.isIdle = () => true; // dialog dismissed, now idle
  const s = await settle;
  assert.equal(s, 'idle');
  session.emit('exit');
});

test('dialogHandler that declines lets the dialog surface as awaiting_input', async () => {
  const tailRef = { value: ['Some modal'] };
  const session = fakeSession();
  const adapter = { isIdle: () => false, isAwaitingInput: () => true, isBusy: () => false };
  const d = new StateDetector({
    session, terminalModel: tmOf(tailRef), adapter, quiescenceMs: 30,
    dialogHandler: () => false, // policy declines
  });
  const s = await d.waitForSettle({ timeoutMs: 500 });
  assert.equal(s, 'awaiting_input');
  session.emit('exit');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/stateDetector.test.js`
Expected: FAIL with wrong states, not a hang — against the CURRENT detector: test 1 goes `idle` too early (no isBusy gate), tests 2 and 4 end `busy` (data flips them back to busy every repaint), and the two `dialogHandler` tests fail because the option is ignored (dialog surfaces / never handled). The 2 pre-existing detector tests still pass.

- [ ] **Step 3: Implement** — replace `src/stateDetector.js` with:

```js
import { EventEmitter } from 'node:events';

export class StateDetector extends EventEmitter {
  constructor({ session, terminalModel, adapter, quiescenceMs = 500, dialogHandler = null }) {
    super();
    this._tm = terminalModel;
    this._adapter = adapter;
    this._quiescenceMs = quiescenceMs;
    this._dialogHandler = dialogHandler;
    this._hasBusy = typeof adapter.isBusy === 'function';
    this._timer = null;
    this._idleTicks = 0;
    this._interval = null;
    this.state = 'starting';
    session.on('data', () => this._onData());
    session.on('exit', () => { this._clearTimers(); this._setState('exited'); });
    // Spinner-animated CLIs never go quiescent: when the adapter offers a
    // positive busy signal, ALSO evaluate markers on a periodic tick during
    // sustained output (spec "StateDetector changes").
    if (this._hasBusy) this._startInterval();
    this._onData(); // arm initial quiescence so a quiet startup can settle
  }
  _setState(s) { if (this.state !== s) { this.state = s; this.emit('state', s); } }
  _startInterval() {
    this._interval = setInterval(() => this._periodicCheck(), this._quiescenceMs);
    if (this._interval.unref) this._interval.unref();
  }
  _clearTimers() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }
  _armQuiescence() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._evaluate(), this._quiescenceMs);
  }
  markBusy() {
    if (this.state === 'exited') return;
    this._idleTicks = 0;
    this._setState('busy');
    // Re-phase the periodic interval so both confirming idle-ticks post-date
    // this prompt write by a full quiescence period (no stale pre-prompt frame).
    if (this._hasBusy) { clearInterval(this._interval); this._startInterval(); }
    this._armQuiescence();
  }
  _onData() {
    if (this.state === 'exited') return;
    // Pure-quiescence adapters: every chunk means busy (legacy behavior).
    // isBusy adapters: data arrival must NOT demote an established idle/awaiting
    // — marker evaluation owns downward transitions, so continuous spinner
    // repaints can't trap the session in busy.
    if (!this._hasBusy) this._setState('busy');
    else if (this.state === 'starting') this._setState('busy');
    this._armQuiescence();
  }
  // Returns true if the dialog policy consumed the awaiting-input screen (stay
  // busy); false if it surfaced as awaiting_input.
  _handleAwaiting(tail) {
    if (this._dialogHandler && this._dialogHandler(tail)) {
      this._idleTicks = 0;
      this._setState('busy');
      this._armQuiescence();
      return true;
    }
    this._setState('awaiting_input');
    return false;
  }
  _evaluate() {
    if (this.state === 'exited') return;
    const tail = this._tm.viewportTail(8);
    if (this._adapter.isAwaitingInput(tail)) { this._handleAwaiting(tail); return; }
    if (this._hasBusy && this._adapter.isBusy(tail)) {
      // Quiet but still painting a busy footer (long silent tool run): stay
      // busy and re-arm so the next quiet gap re-checks.
      this._setState('busy');
      this._armQuiescence();
      return;
    }
    if (this._adapter.isIdle(tail)) this._setState('idle');
    else this._setState('busy'); // not settled — a later chunk re-arms; else stays busy
  }
  _periodicCheck() {
    if (this.state === 'exited' || this.state === 'awaiting_input') return;
    const tail = this._tm.viewportTail(8);
    if (this._adapter.isAwaitingInput(tail)) { this._handleAwaiting(tail); return; }
    if (this._adapter.isBusy(tail)) { this._idleTicks = 0; return this._setState('busy'); }
    if (this._adapter.isIdle(tail)) {
      this._idleTicks += 1;
      if (this._idleTicks >= 2) { this._idleTicks = 0; this._setState('idle'); }
    } else {
      this._idleTicks = 0;
    }
  }
  waitForSettle({ timeoutMs = 600000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.state === 'idle' || this.state === 'awaiting_input') return resolve(this.state);
      if (this.state === 'exited') return reject(new Error('session exited'));
      let to = null;
      const onState = (s) => {
        if (s === 'idle' || s === 'awaiting_input') { cleanup(); resolve(s); }
        else if (s === 'exited') { cleanup(); reject(new Error('session exited')); }
      };
      const cleanup = () => { this.off('state', onState); if (to) clearTimeout(to); };
      to = setTimeout(() => { cleanup(); reject(new Error('settle timeout')); }, timeoutMs);
      this.on('state', onState);
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/stateDetector.test.js` then `npm test`
Expected: PASS (pre-existing detector tests use `generic`, which has no `isBusy` and no `dialogHandler`, so their behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/stateDetector.js test/stateDetector.test.js
git commit -m "feat(detector): isBusy quiet-tick gate and periodic marker evaluation for spinner-animated CLIs"
```

---

### Task 6: Session envScrub + SessionManager profiles + dialog-policy wiring

**Files:**
- Modify: `src/session.js`, `src/sessionManager.js`
- Test: `test/session.test.js`, `test/sessionManager.test.js` (create)

**Interfaces:**
- Consumes: `config.profiles`/`config.defaultProfile` (Task 1), `getAdapter` (Task 2), `adapter.startupDialogs` (Task 3), the detector's `dialogHandler` option (Task 5).
- Produces (used by Tasks 7–8 and Phase 2):
  - `new Session({ …, envScrub: string[] })` — listed keys deleted from the child env at spawn; the hardcoded `ANTHROPIC_*` deletes are **removed** (each profile's `envScrub` carries what it needs; the legacy `ADAPTER=generic` mapping and the claude profile carry `ANTHROPIC_*`).
  - `SessionManager.create({ profile?, cwd?, cols?, rows? })` → record gaining `profile` (name) and `dialogPolicy`. Throws `Error` with `.code` `'UNKNOWN_PROFILE'` (+ `.validProfiles: string[]`), `'PROFILE_NOT_PTY'`, `'PROFILE_NO_COMMAND'`, or `'ADAPTER_UNAVAILABLE'` (adapter not yet in the registry — the transient window before Tasks 10/12/13, also `.validProfiles`). Per-profile `quiescenceMs`/`cols`/`rows` reach the detector/terminal/session.
  - Exported `makeDialogHandler(record) → (tail) => boolean` — a pure function implementing the spec's per-value dialog semantics, passed to the detector as `dialogHandler`. Returns `true` when it answered/consumed the dialog (detector stays busy), `false` to let it surface. Caps answers at **two per persisting screen** (identical rendered tail); a different awaiting screen resets the counter.

- [ ] **Step 1: Write the failing tests** — create `test/sessionManager.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SessionManager, makeDialogHandler } from '../src/sessionManager.js';

// Profile-resolution tests use bash via the generic profile: no real AI CLI,
// no subscription usage (same approach as test/component.test.js).
const cfg = (extra = {}) => loadConfig({ QUIESCENCE_MS: '100', ...extra });

test('create resolves the requested profile and records it', async () => {
  const m = new SessionManager(cfg({ PROFILE_GENERIC_COMMAND: 'bash' }));
  const rec = m.create({ profile: 'generic' });
  assert.equal(rec.profile, 'generic');
  assert.equal(rec.dialogPolicy, 'startup-only');
  assert.equal(rec.adapter.name, 'generic');
  m.remove(rec.id);
});

test('create with unknown profile throws UNKNOWN_PROFILE with validProfiles', () => {
  const m = new SessionManager(cfg());
  assert.throws(() => m.create({ profile: 'nope' }), (e) => {
    assert.equal(e.code, 'UNKNOWN_PROFILE');
    assert.ok(e.validProfiles.includes('claude'));
    return true;
  });
});

test('create with headless profile throws PROFILE_NOT_PTY', () => {
  const m = new SessionManager(cfg());
  assert.throws(() => m.create({ profile: 'claude-headless' }), (e) => e.code === 'PROFILE_NOT_PTY');
});

test('create with command-less generic throws PROFILE_NO_COMMAND', () => {
  const m = new SessionManager(cfg()); // no PROFILE_GENERIC_COMMAND, no ADAPTER=generic
  assert.throws(() => m.create({ profile: 'generic' }), (e) => e.code === 'PROFILE_NO_COMMAND');
});

test('create with a profile whose adapter is not yet registered throws ADAPTER_UNAVAILABLE', () => {
  // Transient window before Tasks 10/12/13 register codex/gemini/copilot: the
  // profile exists in config (adapter:'codex') but getAdapter('codex') throws.
  // create() must translate that into a coded 400-able error, not a raw 500.
  // (After those tasks land, requesting codex/gemini succeeds and this test is
  //  updated to assert success — see Task 10 Step 4.)
  const m = new SessionManager(cfg({ PROFILE_CODEX_COMMAND: 'bash' }));
  try {
    m.create({ profile: 'codex' });
    assert.fail('expected create to throw');
  } catch (e) {
    if (e.code === 'ADAPTER_UNAVAILABLE') {
      assert.ok(Array.isArray(e.validProfiles));
    } else {
      // Once the codex adapter is registered (Task 10), create succeeds and
      // this branch cleans up. Keep the test green across both eras.
      assert.equal(e, undefined, `unexpected throw: ${e && e.message}`);
    }
  }
});

test('per-profile quiescenceMs reaches the detector (not the global default)', () => {
  const m = new SessionManager(cfg({           // cfg sets the GLOBAL QUIESCENCE_MS=100
    PROFILE_GENERIC_COMMAND: 'bash',
    PROFILE_GENERIC_QUIESCENCE_MS: '777',       // per-profile override
  }));
  const rec = m.create({ profile: 'generic' });
  // White-box: proves SessionManager passes the resolved per-profile value, not
  // c.quiescenceMs (100). If the detector's private field is named differently
  // in the final source, assert against that name — the value 777 is the point.
  assert.equal(rec.detector._quiescenceMs, 777);
  m.remove(rec.id);
});

test('profile envScrub removes listed vars from the child env', async () => {
  process.env.BRIDGE_TEST_SENTINEL = 'leaky';
  try {
    const m = new SessionManager(cfg({
      PROFILE_GENERIC_COMMAND: 'bash',
      PROFILE_GENERIC_ARGS: '["-c","echo -n SCRUB:${BRIDGE_TEST_SENTINEL:-gone}; sleep 30"]',
      PROFILE_GENERIC_ENV_SCRUB: 'BRIDGE_TEST_SENTINEL',
    }));
    const rec = m.create({ profile: 'generic' });
    let out = '';
    rec.session.on('data', (d) => { out += d; });
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(out.includes('SCRUB:gone'), `output was: ${JSON.stringify(out)}`);
    m.remove(rec.id);
  } finally {
    delete process.env.BRIDGE_TEST_SENTINEL;
  }
});

// ---- makeDialogHandler: pure function, deterministic (no timers) ----

function fakeRecord({ dialogPolicy, startupDialogs = [] }) {
  const writes = [];
  return {
    writes,
    dialogPolicy,
    session: { write: (d) => writes.push(d) },
    adapter: { startupDialogs, keySeq: (n) => (n === 'enter' ? '\r' : String(n)) },
  };
}

test('makeDialogHandler startup-only: matched answered once, unmatched declined', () => {
  const rec = fakeRecord({
    dialogPolicy: 'startup-only',
    startupDialogs: [{ matcher: (t) => t.some((l) => l.includes('trust')), answerKeys: ['enter'] }],
  });
  const h = makeDialogHandler(rec);
  assert.equal(h(['please trust this']), true);
  assert.deepEqual(rec.writes, ['\r']);
  // a different (unmatched) screen: declined, no write
  assert.equal(h(['some other modal']), false);
  assert.deepEqual(rec.writes, ['\r']);
});

test('makeDialogHandler never: declines everything', () => {
  const rec = fakeRecord({ dialogPolicy: 'never', startupDialogs: [{ matcher: () => true, answerKeys: ['enter'] }] });
  const h = makeDialogHandler(rec);
  assert.equal(h(['trust prompt']), false);
  assert.deepEqual(rec.writes, []);
});

test('makeDialogHandler caps a persisting screen at two answers, then surfaces', () => {
  const rec = fakeRecord({ dialogPolicy: 'auto-approve', startupDialogs: [] });
  const h = makeDialogHandler(rec);
  assert.equal(h(['stuck modal']), true);   // 1
  assert.equal(h(['stuck modal']), true);   // 2 (same screen)
  assert.equal(h(['stuck modal']), false);  // capped → surface
  assert.deepEqual(rec.writes, ['\r', '\r']);
});

test('makeDialogHandler resets the cap when the awaiting screen changes', () => {
  const rec = fakeRecord({ dialogPolicy: 'auto-approve', startupDialogs: [] });
  const h = makeDialogHandler(rec);
  assert.equal(h(['dialog A']), true);
  assert.equal(h(['dialog A']), true);
  assert.equal(h(['dialog B']), true);      // different screen → counter reset, answered again
  assert.deepEqual(rec.writes, ['\r', '\r', '\r']);
});
```

Also update `test/session.test.js`. The two pre-existing tests `strips ANTHROPIC_API_KEY from child env` (lines 23-30) and `strips ANTHROPIC_AUTH_TOKEN from child env` (lines 32-39) construct `Session` with **no** `envScrub` and assert the vars are stripped — that hardcoded behavior is being removed, so **rewrite them** to drive the new option, and **add** a pass-through + generic-mechanism test:

```js
// REPLACE the two 'strips ANTHROPIC_*' tests with these:
test('envScrub option strips the listed key (was hardcoded ANTHROPIC scrub)', async () => {
  const s = new Session({ command: 'bash', args: ['-lc', 'echo KEY=[$ANTHROPIC_API_KEY]'],
    cwd: process.cwd(), env: { ...process.env, ANTHROPIC_API_KEY: 'sk-should-be-gone' },
    envScrub: ['ANTHROPIC_API_KEY'] });
  let out = '';
  s.on('data', d => { out += d; });
  await once(s, 'exit');
  assert.match(out, /KEY=\[\]/);
});

test('without envScrub, env passes through unchanged', async () => {
  const s = new Session({ command: 'bash', args: ['-lc', 'echo TOK=[$ANTHROPIC_AUTH_TOKEN]'],
    cwd: process.cwd(), env: { ...process.env, ANTHROPIC_AUTH_TOKEN: 'kept' } });
  let out = '';
  s.on('data', d => { out += d; });
  await once(s, 'exit');
  assert.match(out, /TOK=\[kept\]/);
});

// ADD (new envScrub-mechanism test, unrelated to ANTHROPIC naming):
test('envScrub option removes an arbitrary listed key from the child env', async () => {
  const s = new Session({
    command: 'bash', args: ['-lc', 'echo V=[${SCRUB_ME:-gone}]'],
    cwd: process.cwd(), env: { ...process.env, SCRUB_ME: 'leaky' }, envScrub: ['SCRUB_ME'],
  });
  let out = '';
  s.on('data', d => { out += d; });
  await once(s, 'exit');
  assert.match(out, /V=\[gone\]/);
});
```

The claude-profile back-compat (that `loadConfig` puts `ANTHROPIC_*` on the claude profile's `envScrub`, and the legacy `ADAPTER=generic` mapping inherits it) is already covered by Task 1's config tests — so end-to-end scrubbing for real profiles is verified there, at the seam the spec moved it to.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/sessionManager.test.js test/session.test.js`
Expected: FAIL — `makeDialogHandler` not exported, `create` ignores `profile`/`envScrub`, and (until Step 3) the rewritten session tests fail because Session still hardcodes the ANTHROPIC deletes (so the pass-through test sees `TOK=[]`).

- [ ] **Step 3: Implement Session change** — in `src/session.js`, change the constructor signature and env handling:

```js
constructor({ command, args = [], cwd, env = process.env, cols = 120, rows = 30, ringBytes = 262144, envScrub = [] }) {
```

and replace the two hardcoded deletes:

```js
    const childEnv = { ...env };
    for (const k of envScrub) delete childEnv[k];
```

(The `delete childEnv.ANTHROPIC_API_KEY; delete childEnv.ANTHROPIC_AUTH_TOKEN;` lines are removed — the claude profile's `envScrub` now carries them.)

- [ ] **Step 4: Implement SessionManager** — replace `src/sessionManager.js` with:

```js
import { Session } from './session.js';
import { TerminalModel } from './terminalModel.js';
import { StateDetector } from './stateDetector.js';
import { PromptQueue } from './promptQueue.js';
import { getAdapter } from './adapters/index.js';

const envKey = (name) => name.toUpperCase().replace(/-/g, '_');

// Startup-dialog policy as a pure per-tail decision (spec "Profiles"), consulted
// by the detector BEFORE it settles a turn (so an answered dialog never surfaces
// as awaiting_input). Returns true when it answered/consumed the dialog.
//   never        — decline everything (dialogs always surface)
//   startup-only — answer startupDialogs-matched screens
//   auto-approve — matched as above; plus default-accept 'enter' for unmatched
// Loop guard (both matched and unmatched): at most TWO answers per persisting
// screen (identical rendered tail); a different awaiting screen resets the cap,
// so a genuinely dismissed dialog frees the budget for the next one.
export function makeDialogHandler(record) {
  let answers = 0;
  let lastKey = null;
  const MAX = 2;
  return (tail) => {
    if (record.dialogPolicy === 'never') return false;
    const key = tail.join('\n');
    if (key !== lastKey) { answers = 0; lastKey = key; }
    const entry = (record.adapter.startupDialogs || []).find((d) => d.matcher(tail));
    const answer = (keys) => {
      if (answers >= MAX) return false;
      for (const k of keys) record.session.write(record.adapter.keySeq(k));
      answers += 1;
      return true;
    };
    if (entry) return answer(entry.answerKeys);
    if (record.dialogPolicy === 'auto-approve') return answer(['enter']);
    return false;
  };
}

export class SessionManager {
  constructor(config) { this._config = config; this._records = new Map(); }
  create({ profile, cwd, cols, rows } = {}) {
    const c = this._config;
    const name = profile || c.defaultProfile;
    const p = c.profiles[name];
    if (!p) {
      const err = new Error(`unknown profile "${name}"`);
      err.code = 'UNKNOWN_PROFILE';
      err.validProfiles = Object.keys(c.profiles);
      throw err;
    }
    if (p.mode !== 'pty') {
      const err = new Error(`profile "${name}" is ${p.mode}-mode and cannot back an interactive session`);
      err.code = 'PROFILE_NOT_PTY';
      throw err;
    }
    if (!p.command) {
      const err = new Error(`profile "${name}" has no command configured (set PROFILE_${envKey(name)}_COMMAND)`);
      err.code = 'PROFILE_NO_COMMAND';
      throw err;
    }
    // Registry may not yet carry this profile's adapter (transient window before
    // Tasks 10/12/13). Translate the registry throw into a coded, 400-able error
    // instead of letting a raw Error surface as a 500.
    let adapter;
    try {
      adapter = getAdapter(p.adapter);
    } catch {
      const err = new Error(`profile "${name}" uses adapter "${p.adapter}", which is not registered`);
      err.code = 'ADAPTER_UNAVAILABLE';
      err.validProfiles = Object.keys(c.profiles);
      throw err;
    }
    const session = new Session({
      command: p.command, args: [...p.args], cwd: cwd || p.cwd,
      env: process.env, envScrub: p.envScrub,
      cols: cols || p.cols, rows: rows || p.rows, ringBytes: c.ringBytes,
    });
    const terminalModel = new TerminalModel({ cols: cols || p.cols, rows: rows || p.rows, scrollback: c.scrollback });
    session.on('data', (d) => terminalModel.write(d));
    const record = {
      id: session.id, session, terminalModel, adapter,
      queue: new PromptQueue(), createdAt: Date.now(),
      profile: name, dialogPolicy: p.dialogPolicy,
    };
    // Build the dialog handler over the record, then hand it to the detector so
    // an auto-answered dialog keeps the session busy rather than surfacing.
    const dialogHandler = makeDialogHandler(record);
    record.detector = new StateDetector({ session, terminalModel, adapter, quiescenceMs: p.quiescenceMs, dialogHandler });
    this._records.set(session.id, record);
    return record;
  }
  get(id) { return this._records.get(id); }
  list() { return [...this._records.values()]; }
  remove(id) { const r = this._records.get(id); if (r) { r.session.kill(); this._records.delete(id); } return !!r; }
}
```

Note: `record.detector` is assigned after the record object exists (the dialog handler closes over the record but only reads `dialogPolicy`/`session`/`adapter`, all present before the detector is built), so there is no ordering hazard.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/sessionManager.test.js test/session.test.js` then `npm test`
Expected: PASS. If any pre-existing test hand-rolls a config object for `SessionManager` (instead of using `loadConfig`), update that test to build its config via `loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash', … })` — the back-compat mapping makes this equivalent to its old intent. (The `per-profile quiescenceMs` test does a white-box read of `rec.detector._quiescenceMs`; if the detector field is named differently in the final source, assert against that name — the point is that the profile value, not the global default, reached the detector.)

- [ ] **Step 6: Commit**

```bash
git add src/session.js src/sessionManager.js test/session.test.js test/sessionManager.test.js
git commit -m "feat(sessions): per-session profiles, profile-driven env scrub, dialog-policy handler"
```

---

### Task 7: HTTP API — profile param, `text` field, multiline 400

**Files:**
- Modify: `src/httpApi.js`
- Test: `test/httpApi.test.js`

**Interfaces:**
- Consumes: `writePromptText`/`MultilineUnsupportedError` (Task 4), `adapter.extractResponse` (Task 3), SessionManager error codes (Task 6).
- Produces (wire contract, also used by Phase 2 and docs):
  - `POST /api/sessions` body gains optional `profile`; `201 {id, state, profile}`; profile errors → `400 {error, validProfiles?}`.
  - `GET /api/sessions` and `GET /api/sessions/:id` include `profile`.
  - `POST /api/sessions/:id/prompt` response gains `text` (chrome-stripped via `extractResponse`; falls back to `output` when the adapter lacks the method); `MultilineUnsupportedError` → `400`.

- [ ] **Step 1: Write the failing tests** — append to `test/httpApi.test.js`. **This file has no shared `base`/`tok`.** Its real helpers are: `boot()` → `Promise<{config, manager, server, port}>` (boots `loadConfig({ ADAPTER:'generic', CLAUDE_CMD:'bash', CLAUDE_ARGS:'["-i"]', BRIDGE_TOKEN:'tok', … })`), `url(port, path)` → full URL, and a module-scope `auth = { headers: { authorization: 'Bearer tok', 'content-type':'application/json' } }`. Each test calls `await boot()`, uses `url(port, …)` + `auth`, and ends with `server.close()`. Follow that idiom exactly:

```js
// ---- Phase 1: profiles + text field + multiline 400 ----

test('POST /api/sessions with unknown profile returns 400 listing valid profiles', async () => {
  const { server, port } = await boot();
  const r = await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: JSON.stringify({ profile: 'nope' }) });
  assert.equal(r.status, 400);
  const b = await r.json();
  assert.ok(Array.isArray(b.validProfiles) && b.validProfiles.length > 0);
  server.close();
});

test('POST /api/sessions with headless profile returns 400', async () => {
  const { server, port } = await boot();
  const r = await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: JSON.stringify({ profile: 'claude-headless' }) });
  assert.equal(r.status, 400);
  server.close();
});

test('session create/list/get responses carry the profile name', async () => {
  const { server, port } = await boot();
  const created = await (await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' })).json();
  assert.equal(created.profile, 'generic'); // boot() uses ADAPTER=generic
  const list = await (await fetch(url(port, '/api/sessions'), { headers: auth.headers })).json();
  assert.equal(list.sessions.find((s) => s.id === created.id).profile, 'generic');
  const one = await (await fetch(url(port, `/api/sessions/${created.id}`), { headers: auth.headers })).json();
  assert.equal(one.profile, 'generic');
  await fetch(url(port, `/api/sessions/${created.id}`), { method: 'DELETE', headers: auth.headers });
  server.close();
});

test('POST /prompt returns a cleaned text field alongside raw output', async () => {
  const { server, port } = await boot();
  const { id } = await (await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' })).json();
  const p = await fetch(url(port, `/api/sessions/${id}/prompt`), { method: 'POST', ...auth,
    body: JSON.stringify({ text: 'echo BRIDGE_TEXT_FIELD' }) });
  assert.equal(p.status, 200);
  const b = await p.json();
  assert.equal(typeof b.text, 'string');
  assert.ok(b.text.includes('BRIDGE_TEXT_FIELD'), `text was: ${JSON.stringify(b.text)}`);
  assert.notEqual(b.text, b.output); // generic extractResponse drops the echoed first line
  await fetch(url(port, `/api/sessions/${id}`), { method: 'DELETE', headers: auth.headers });
  server.close();
});

test('POST /prompt with multiline text on a no-paste/no-newlineKey adapter returns 400', async () => {
  // Exercises the MultilineUnsupportedError→400 mapping end-to-end. The generic
  // profile is multiline:'raw' (never rejects), so monkeypatch the created
  // record's adapter to the reject path (mirrors how test/wsApi.test.js patches
  // record members). manager is returned by boot().
  const { server, port, manager } = await boot();
  const { id } = await (await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' })).json();
  const rec = manager.get(id);
  rec.adapter = { ...rec.adapter, multiline: undefined, supportsBracketedPaste: false }; // no newlineKey → reject
  const p = await fetch(url(port, `/api/sessions/${id}/prompt`), { method: 'POST', ...auth,
    body: JSON.stringify({ text: 'line one\nline two' }) });
  assert.equal(p.status, 400);
  const b = await p.json();
  assert.match(String(b.error), /multiline/i);
  await fetch(url(port, `/api/sessions/${id}`), { method: 'DELETE', headers: auth.headers });
  server.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/httpApi.test.js`
Expected: FAIL — profile create 500s (uncaught error) instead of 400; no `profile`/`text` fields; the multiline test gets 200 or 500 instead of 400 (mapping not present).

- [ ] **Step 3: Implement** — in `src/httpApi.js`:

Add the import:

```js
import { writePromptText, MultilineUnsupportedError } from './promptWriter.js';
```

Replace `sendPrompt` with:

```js
export async function sendPrompt(record, { text, submit = true, timeoutMs = 600000 }) {
  const start = Date.now();
  const before = record.terminalModel.snapshotLineCount();
  record.detector.markBusy();
  writePromptText(record.session, record.adapter, text);
  if (submit) record.session.write(record.adapter.keySeq('submit'));
  const state = await record.detector.waitForSettle({ timeoutMs });
  const lines = record.terminalModel.renderLinesSince(before);
  const output = lines.join('\n');
  const cleaned = typeof record.adapter.extractResponse === 'function'
    ? record.adapter.extractResponse(lines)
    : output;
  const prompt = state === 'awaiting_input' ? record.adapter.describePrompt(record.terminalModel.viewportTail(8)) : null;
  return { state, output, text: cleaned, prompt, durationMs: Date.now() - start };
}
```

Replace the `POST /api/sessions` branch with:

```js
      if (req.method === 'POST' && u.pathname === '/api/sessions') {
        const b = await readBodyOr413(req, res);
        if (b === undefined) return;
        try {
          const rec = manager.create(b);
          return json(res, 201, { id: rec.id, state: rec.detector.state, profile: rec.profile });
        } catch (e) {
          if (['UNKNOWN_PROFILE', 'PROFILE_NOT_PTY', 'PROFILE_NO_COMMAND', 'ADAPTER_UNAVAILABLE'].includes(e.code)) {
            return json(res, 400, { error: String(e.message), ...(e.validProfiles ? { validProfiles: e.validProfiles } : {}) });
          }
          throw e;
        }
      }
```

Add `profile` to the two GET shapes:

```js
        return json(res, 200, { sessions: manager.list().map((r) => ({ id: r.id, state: r.detector.state, createdAt: r.createdAt, profile: r.profile })) });
```

```js
        if (req.method === 'GET' && parts.length === 3) return json(res, 200, { id: rec.id, state: rec.detector.state, createdAt: rec.createdAt, profile: rec.profile });
```

In the prompt route's `catch`, map the multiline rejection before the existing 409/504 mapping:

```js
          } catch (e) {
            if (e instanceof MultilineUnsupportedError) return json(res, 400, { error: String(e.message) });
            const msg = String(e.message || e);
            const code = /exited/.test(msg) ? 409 : 504;
            return json(res, code, { error: msg });
          }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/httpApi.test.js` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/httpApi.js test/httpApi.test.js
git commit -m "feat(http): profile selection on session create, cleaned text field on /prompt, multiline 400"
```

---

### Task 8: WS API — `?profile=` at creation, 400 pre-upgrade rejection

**Files:**
- Modify: `src/wsApi.js`, `public/index.html`
- Test: `test/wsApi.test.js`

**Interfaces:**
- Consumes: `config.profiles`/`config.defaultProfile` (Task 1), SessionManager profile create (Task 6).
- Produces (wire contract): `/ws?profile=<name>` selects the profile **only when creating** (no usable `?session=`); an invalid/headless/command-less **effective** creation profile (the explicit param, or the default when none is given) → HTTP `400` with a JSON body (same shape as REST) written pre-upgrade; a `manager.create` throw inside the upgrade is caught and closed cleanly (no uncaught crash); when `?session=` names an existing session, `?profile=` is ignored (spec: attachment never respawns). `public/index.html` forwards a `profile` page param onto the WS URL.

- [ ] **Step 1: Write the failing tests** — `test/wsApi.test.js` has **no shared helpers**: every test builds its own `loadConfig(...)` + `SessionManager` + `http.createServer(...)` + `attachWss(...)` and derives `port` from `server.address().port`. Two tests here also drive the REST API, so they mount `createHttpServer(config, manager)` **as** the HTTP server (add `import { createHttpServer } from '../src/httpApi.js';` at the top of the file if not present) instead of the existing `http.createServer((_q, s) => s.end())` stub. Add a small local helper at the top of the new block and follow the file's inline idiom:

```js
// ---- Phase 1: profile param ----
// Boot a server whose DEFAULT profile is 'claude' (bash) but which ALSO enables
// 'generic' (bash) — so `?profile=generic` selecting a NON-default profile is a
// real, observable choice (not vacuously equal to the default).
function bootProfiles() {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', QUIESCENCE_MS: '120',
    DEFAULT_PROFILE: 'claude', PROFILE_CLAUDE_COMMAND: 'bash', PROFILE_CLAUDE_ARGS: '["-i"]',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: '["-i"]',
  });
  const manager = new SessionManager(config);
  const server = createHttpServer(config, manager); // real REST + static
  attachWss(server, config, manager);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ config, manager, server, port: server.address().port })));
}
const wsUrl = (port, qs) => `ws://127.0.0.1:${port}/ws?token=tok&${qs}`;

test('ws upgrade with unknown profile is rejected 400 pre-upgrade', async () => {
  const { server, port } = await bootProfiles();
  const status = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl(port, 'profile=nope'));
    ws.on('unexpected-response', (_req, res2) => resolve(res2.statusCode));
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => {}); // unexpected-response resolves first
  });
  assert.equal(status, 400);
  server.close();
});

test('ws upgrade with headless profile is rejected 400 pre-upgrade', async () => {
  const { server, port } = await bootProfiles();
  const status = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl(port, 'profile=claude-headless'));
    ws.on('unexpected-response', (_req, res2) => resolve(res2.statusCode));
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => {});
  });
  assert.equal(status, 400);
  server.close();
});

test('ws bare connection creates the DEFAULT profile; ?profile= selects a non-default one', async () => {
  const { server, port, manager } = await bootProfiles();
  // bare connection → default profile 'claude'
  const bare = new WebSocket(wsUrl(port, 'x=1'));
  await new Promise((resolve, reject) => { bare.on('open', resolve); bare.on('error', reject); });
  assert.ok(manager.list().some((r) => r.profile === 'claude'), 'bare connection uses DEFAULT_PROFILE');
  // ?profile=generic → the non-default profile actually applied
  const chosen = new WebSocket(wsUrl(port, 'profile=generic'));
  await new Promise((resolve, reject) => { chosen.on('open', resolve); chosen.on('error', reject); });
  assert.ok(manager.list().some((r) => r.profile === 'generic'), '?profile= applied at creation');
  bare.close(); chosen.close();
  await new Promise((r) => setTimeout(r, 300)); // ws-owned sessions reaped on close
  server.close();
});

test('ws attaching to an existing session ignores a conflicting profile param', async () => {
  const { server, port, manager } = await bootProfiles();
  const existing = manager.create({ profile: 'generic' }); // pre-existing session
  const ws = new WebSocket(wsUrl(port, `session=${existing.id}&profile=nope`));
  const opened = await new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('unexpected-response', () => resolve(false));
    ws.on('error', () => resolve(false));
  });
  assert.equal(opened, true); // attachment proceeds; ?profile= ignored, not validated
  assert.equal(manager.get(existing.id).profile, 'generic'); // unchanged
  ws.close(); manager.remove(existing.id); server.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wsApi.test.js`
Expected: FAIL — unknown/headless-profile upgrades currently succeed (param ignored), and the default-vs-chosen test can't distinguish profiles (create ignores `profile`).

- [ ] **Step 3: Implement** — replace the `upgrade` handler body in `src/wsApi.js`:

```js
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/ws' || !checkToken(extractToken(req), config.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }
    const providedSid = u.searchParams.get('session');
    const existing = providedSid ? manager.get(providedSid) : null;
    const profileParam = u.searchParams.get('profile');
    const reject400 = (msg) => {
      const body = JSON.stringify({ error: msg, validProfiles: Object.keys(config.profiles) });
      socket.write(`HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      socket.destroy();
    };
    // Validate the EFFECTIVE creation profile pre-upgrade whenever this
    // connection will create a session (no ?session= at all): the explicit
    // ?profile=, or the default when none is given. A ?session= naming an
    // unknown id keeps today's create-fallback and ignores ?profile= (spec:
    // attachment never respawns). This covers the crash where a headless or
    // command-less DEFAULT_PROFILE would otherwise throw inside handleUpgrade.
    if (!providedSid) {
      const effective = profileParam || config.defaultProfile;
      const p = config.profiles[effective];
      const problem = !p ? `unknown profile "${effective}"`
        : p.mode !== 'pty' ? `profile "${effective}" is ${p.mode}-mode and cannot back an interactive session`
        : !p.command ? `profile "${effective}" has no command configured`
        : null;
      if (problem) { reject400(problem); return; }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let rec;
      try {
        rec = existing || manager.create(!providedSid && profileParam ? { profile: profileParam } : {});
      } catch (e) {
        // Belt-and-suspenders: pre-validation should have caught profile errors,
        // but a spawn/registry failure here must close the socket, never crash
        // the process.
        try { ws.close(1011, String(e.code || e.message || 'session create failed').slice(0, 120)); } catch { /* ignore */ }
        return;
      }
      const ownedByWs = !existing;
      ws.send(rec.session.scrollback());
      const onData = (d) => { if (ws.readyState === ws.OPEN) ws.send(d); };
      rec.session.on('data', onData);
      const onExit = () => { try { ws.close(); } catch { /* ignore */ } };
      rec.session.on('exit', onExit);
      ws.on('message', (raw) => {
        const s = raw.toString();
        if (s.startsWith('{')) { try { const m = JSON.parse(s); if (m.type === 'resize') { rec.session.resize(m.cols, m.rows); rec.terminalModel.resize(m.cols, m.rows); return; } } catch { /* fallthrough */ } }
        rec.session.write(s);
      });
      ws.on('close', () => {
        rec.session.off('data', onData);
        rec.session.off('exit', onExit);
        if (ownedByWs) manager.remove(rec.id);
      });
    });
  });
```

Note the deliberate edge kept from today's behavior: `?session=<unknown-id>` still falls through to creation of the **default** profile — and because `providedSid` was set, the conflicting `profileParam` is **not** applied (`!providedSid && profileParam` guard). Since a bad default is now rejected at boot (Task 1) and unknown-id creation uses the default, that path can't reach a headless/command-less create.

- [ ] **Step 4: Implement the browser passthrough** — in `public/index.html`, after the `const session = params.get('session');` line add:

```js
const profile = params.get('profile');
```

and after `if (session) q.set('session', session);` add:

```js
if (profile && !session) q.set('profile', profile);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/wsApi.test.js` then `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/wsApi.js public/index.html test/wsApi.test.js
git commit -m "feat(ws): profile selection at session creation with pre-upgrade 400 validation"
```

---

### Task 9: Codex capture spike (fixtures + NOTES + verified marker regexes)

**Files:**
- Create: `scratch/render-fixture.mjs`, `scratch/capture-codex.mjs`
- Create: `test/fixtures/codex-boot.txt`, `codex-idle.txt`, `codex-typed.txt`, `codex-busy.txt`, `codex-response.txt` (plus `codex-dialog.txt` if a startup dialog appears)
- Modify: `test/fixtures/NOTES.md` (new top-level section)

**Interfaces:**
- Consumes: the installed, ChatGPT-authenticated `codex` CLI (0.134.x), `TerminalModel`.
- Produces: raw-byte fixtures + a NOTES.md section titled `# Codex CLI <exact version> — observed under node-pty` recording, in this order: (a) alt-screen verdict (`\x1b[?1049h` count per capture); (b) startup dialog(s) observed and the keys that answer them; (c) submit-key behavior; (d) **verified candidate marker regexes** for idle / busy / awaiting-input, each quoted with its source rendered line and checked against every fixture (matches where it must, zero matches where it must not); (e) the transcript shape of a response (for `extractResponse`); (f) whether spinner animation repaints while idle (decides if the adapter needs `isBusy` + periodic ticks to work — it should ship `isBusy` regardless if any busy marker exists). Task 10 copies these regexes verbatim.

This task consumes one ChatGPT-subscription prompt (`reply with exactly: PONG`).

- [ ] **Step 1: Write the render helper** — create `scratch/render-fixture.mjs`:

```js
// Render a raw PTY capture through the project's TerminalModel and print
// numbered lines + the 8-line viewport tail (what adapters actually match).
// Usage: node scratch/render-fixture.mjs test/fixtures/codex-idle.txt [prefixBytes]
import fs from 'node:fs';
import { TerminalModel } from '../src/terminalModel.js';

const file = process.argv[2];
const prefix = process.argv[3] ? Number(process.argv[3]) : null;
let bytes = fs.readFileSync(file);
if (prefix) bytes = bytes.subarray(0, prefix);
const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
await t.write(bytes);
console.log(t.renderLinesSince(0).map((l, i) => `${String(i).padStart(3)}| ${l}`).join('\n'));
console.log('---- viewportTail(8) ----');
console.log(t.viewportTail(8).map((l) => JSON.stringify(l)).join('\n'));
```

- [ ] **Step 2: Write the capture script** — create `scratch/capture-codex.mjs`:

```js
// Staged raw-byte capture of the codex TUI, following the protocol in
// test/fixtures/NOTES.md (claude spike). Stages mirror the claude staging
// pitfall: never type the prompt while a startup dialog may be up.
import pty from 'node-pty';
import fs from 'node:fs';

const env = { ...process.env };
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;

const chunks = [];
const save = (n) => fs.writeFileSync(`test/fixtures/codex-${n}.txt`, Buffer.concat(chunks));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const p = pty.spawn('codex', [], { name: 'xterm-256color', cols: 120, rows: 30, cwd: process.env.HOME, env });
p.onData((d) => chunks.push(Buffer.from(d, 'utf8')));

await sleep(8000); save('boot');          // whatever codex shows on start (dialog? idle?)
p.write('\r');                            // accept a default-selected dialog if one is up (harmless Enter if not)
await sleep(5000); save('idle');
p.write('reply with exactly: PONG');
await sleep(1000); save('typed');
p.write('\r');
await sleep(2000); save('busy');
await sleep(25000); save('response');
p.kill();
console.log('captured', fs.readdirSync('test/fixtures').filter((f) => f.startsWith('codex-')));
```

- [ ] **Step 3: Run the capture**

Run: `node scratch/capture-codex.mjs`
Expected: five `test/fixtures/codex-*.txt` files. If the boot screen shows a dialog that Enter did not clear (inspect in Step 4), adjust the staging (e.g. answer keys, longer waits) and re-run until the `response` capture contains a completed PONG turn.

- [ ] **Step 4: Analyze**

```bash
codex --version                              # record exact version for the pin
for f in test/fixtures/codex-*.txt; do
  echo "$f alt-screen-enters: $(python3 -c "print(open('$f','rb').read().count(b'\x1b[?1049h'))")"
done
node scratch/render-fixture.mjs test/fixtures/codex-boot.txt
node scratch/render-fixture.mjs test/fixtures/codex-idle.txt
node scratch/render-fixture.mjs test/fixtures/codex-busy.txt
node scratch/render-fixture.mjs test/fixtures/codex-response.txt
```

From the rendered output identify: the stable idle signature, the stable busy signature (footer/status text, NOT spinner glyphs — the claude spike showed glyphs/verbs rotate), any dialog text, and where the response text sits in the transcript. If `codex-busy.txt` ends after the busy window, find a byte prefix that renders the busy frame (`node scratch/render-fixture.mjs test/fixtures/codex-response.txt <prefixBytes>`, bisect by hand) and record the prefix length in NOTES.

- [ ] **Step 5: Verify each candidate regex programmatically** — for every candidate, run a check of this shape and record the results in NOTES:

```bash
node -e "
import('node:fs').then(async ({ default: fs }) => {
  const { TerminalModel } = await import('./src/terminalModel.js');
  const re = /REPLACE_WITH_CANDIDATE/;
  for (const f of fs.readdirSync('test/fixtures').filter((x) => x.startsWith('codex-'))) {
    const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
    await t.write(fs.readFileSync('test/fixtures/' + f));
    console.log(f, t.viewportTail(8).some((l) => re.test(l)));
  }
});"
```

A marker is **verified** only if it matches every fixture where its state holds and no fixture where it doesn't.

- [ ] **Step 6: Write the NOTES section** — append to `test/fixtures/NOTES.md` a section with the exact structure listed under "Produces" above (mirror the claude section's headings: alt-screen, idle rendering, submit key, startup dialog, busy signature, candidate marker regexes with source lines, response/transcript shape for extractResponse, files list).

- [ ] **Step 7: Commit**

```bash
git add scratch/render-fixture.mjs scratch/capture-codex.mjs test/fixtures/codex-*.txt test/fixtures/NOTES.md
git commit -m "test(fixtures): codex CLI capture spike with verified marker candidates"
```

---

### Task 10: Codex adapter

**Files:**
- Create: `src/adapters/codex.js`
- Modify: `src/adapters/index.js` (registry entry)
- Test: `test/adapters.test.js`

**Interfaces:**
- Consumes: Task 9's fixtures and NOTES-recorded verified regexes.
- Produces: `codex` adapter implementing the full contract (`name`, `isIdle`, `isBusy`, `isAwaitingInput`, `describePrompt`, `extractResponse`, `startupDialogs`, `keySeq`), registered as `codex`.

- [ ] **Step 1: Write the failing tests** — append to `test/adapters.test.js` (adjust the dialog test to whatever Task 9 actually captured — if codex showed no startup dialog, assert `startupDialogs` is an empty array instead):

```js
// ---- codex adapter: fixture-driven (see NOTES.md "Codex CLI") ----

test('codex adapter: idle fixture classifies as idle', async () => {
  const a = getAdapter('codex');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/codex-idle.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.isIdle(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isAwaitingInput(tail), false);
  assert.equal(a.isBusy(tail), false);
});

test('codex adapter: busy frame is busy, not idle', async () => {
  const a = getAdapter('codex');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/codex-busy.txt')); // or the NOTES-recorded response-prefix
  const tail = t.viewportTail(8);
  assert.equal(a.isBusy(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isIdle(tail), false);
});

test('codex adapter: completed response classifies idle and extractResponse strips chrome', async () => {
  const a = getAdapter('codex');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/codex-response.txt'));
  assert.equal(a.isIdle(t.viewportTail(8)), true);
  const text = a.extractResponse(t.renderLinesSince(0));
  assert.ok(text.includes('PONG'), `text was: ${JSON.stringify(text)}`);
  // Negative assertions must use CODEX-fixture chrome recorded in NOTES §Codex —
  // NOT copied claude glyphs (a claude '❯' check passes vacuously if codex uses a
  // different input marker, letting an empty-CHROME adapter slip through). Replace
  // the two placeholders below with the exact idle-footer text and input-box
  // marker Task 9 verified for codex; assert the extracted reply contains neither.
  assert.ok(!/<FROM NOTES §Codex: verified idle-footer text, e.g. the "send" hint>/.test(text), `text was: ${JSON.stringify(text)}`);
  assert.ok(!/<FROM NOTES §Codex: verified input-box / prompt marker>/.test(text), `text was: ${JSON.stringify(text)}`);
});

test('codex adapter: key map baseline', () => {
  const a = getAdapter('codex');
  assert.equal(a.name, 'codex');
  assert.equal(a.keySeq('enter'), '\r');
  assert.equal(a.keySeq('submit'), '\r'); // adjust ONLY if NOTES recorded a different submit key
  assert.equal(a.keySeq('esc'), '\x1b');
  assert.equal(a.keySeq('hello'), 'hello');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/adapters.test.js`
Expected: FAIL — `getAdapter('codex')` throws (not registered).

- [ ] **Step 3: Implement** — create `src/adapters/codex.js` from this template, filling every `<FROM NOTES §Codex>` constant with the exact regexes/lines Task 9 verified and recorded (this is a copy step, not a design step — the design happened in Task 9):

```js
// src/adapters/codex.js
//
// Pinned to Codex CLI <FROM NOTES §Codex: exact version>. Markers derived from
// test/fixtures/codex-*.txt (see NOTES.md §Codex), matched against RENDERED
// lines only. Alt-screen verdict: <FROM NOTES §Codex — if it uses alt-screen,
// note "PTY transcript DEGRADED" here per the spec's fixture-spike rule>.
const KEYS = {
  enter: '\r', submit: '\r', up: '\x1b[A', down: '\x1b[B',
  left: '\x1b[D', right: '\x1b[C', esc: '\x1b', tab: '\t', 'ctrl-c': '\x03',
};

const IDLE_MARKERS = [/<FROM NOTES §Codex: verified idle regex>/];
const BUSY_MARKERS = [/<FROM NOTES §Codex: verified busy regex>/];
const AWAITING_INPUT_MARKERS = [/<FROM NOTES §Codex: verified dialog regex — or leave [] if none captured>/];
const CHROME = [
  // <FROM NOTES §Codex: chrome-line regexes — input box, rules, footer, spinner>
];

const anyMatch = (tail, res) => res.some((re) => tail.some((l) => re.test(l)));

export const codex = {
  name: 'codex',
  isAwaitingInput(tail) { return anyMatch(tail, AWAITING_INPUT_MARKERS); },
  isBusy(tail) { return anyMatch(tail, BUSY_MARKERS); },
  isIdle(tail) {
    if (this.isAwaitingInput(tail)) return false;
    if (anyMatch(tail, BUSY_MARKERS)) return false;
    return anyMatch(tail, IDLE_MARKERS);
  },
  describePrompt(tail) { return this.isAwaitingInput(tail) ? tail.join('\n') : null; },
  extractResponse(lines) {
    const kept = lines.filter((l) => l.trim() !== '' && !CHROME.some((re) => re.test(l)));
    return kept.join('\n').trim();
  },
  startupDialogs: [
    // <FROM NOTES §Codex: one entry per observed startup dialog, or empty>
    // { matcher: (tail) => tail.some((l) => /…/.test(l)), answerKeys: ['enter'] },
  ],
  keySeq(name) {
    return Object.prototype.hasOwnProperty.call(KEYS, name) ? KEYS[name] : String(name);
  },
};
```

Register it — in `src/adapters/index.js`:

```js
import { codex } from './codex.js';

const REGISTRY = { generic, claude, codex };
```

- [ ] **Step 4: Run tests to verify they pass, and close the transient-window test**

Run: `node --test test/adapters.test.js` then `npm test`
Expected: PASS. If `extractResponse` keeps chrome, extend `CHROME` from the actual rendered lines (never weaken assertions).

Now that `codex` is registered, update the Task 6 test `create with a profile whose adapter is not yet registered throws ADAPTER_UNAVAILABLE` in `test/sessionManager.test.js`: `getAdapter('codex')` now succeeds, so change that test to assert `create({ profile: 'codex' })` **succeeds** (record `profile === 'codex'`, then `m.remove`) using `PROFILE_CODEX_COMMAND: 'bash'`. Re-run `node --test test/sessionManager.test.js` → PASS. (The `ADAPTER_UNAVAILABLE` mapping stays exercised by `copilot`/`gemini` until their tasks land; after Task 13 it is covered only by a hand-rolled profile whose adapter name is bogus — keep one such unit test in `sessionManager.test.js` so the branch never goes dead.)

- [ ] **Step 5: Commit**

```bash
git add src/adapters/codex.js src/adapters/index.js test/adapters.test.js test/sessionManager.test.js
git commit -m "feat(adapters): codex adapter from captured fixtures"
```

---

### Task 11: Gemini capture spike

**Files:**
- Create: `scratch/capture-gemini.mjs`
- Create: `test/fixtures/gemini-boot.txt`, `gemini-idle.txt`, `gemini-typed.txt`, `gemini-busy.txt`, `gemini-response.txt` (+ dialog capture if shown)
- Modify: `test/fixtures/NOTES.md`

**Interfaces:**
- Consumes: installed, Google-OAuth-authenticated `gemini` CLI (0.33.x).
- Produces: same deliverable structure as Task 9's NOTES section, plus one extra REQUIRED finding: whether gemini repaints continuously while idle (its spinner/status animation is the spec's canonical "never goes quiescent" risk) — if yes, the NOTES section must state that the adapter REQUIRES `isBusy` for usable settling, and should recommend a `PROFILE_GEMINI_QUIESCENCE_MS` shipped default if the spike shows 500ms misbehaving.

This task consumes one Gemini-subscription prompt (`reply with exactly: PONG`).

- [ ] **Step 1: Write the capture script** — create `scratch/capture-gemini.mjs`: copy `scratch/capture-codex.mjs` verbatim and change: spawn `'gemini'` instead of `'codex'`; the env deletes to the gemini scrub list (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_CLOUD_LOCATION`); the output filename prefix to `gemini-`.

- [ ] **Step 2: Run the capture**

Run: `node scratch/capture-gemini.mjs`
Expected: five `test/fixtures/gemini-*.txt` files; adjust staging on inspection exactly as in Task 9 Step 3.

- [ ] **Step 3: Analyze** — same commands as Task 9 Step 4 with `gemini-` filenames, plus the idle-animation check:

```bash
python3 - <<'EOF'
# Does the idle screen keep painting? Compare byte counts across a quiet window:
# re-run capture with two idle saves 5s apart if needed; a growing byte count
# with no input means idle-animation (record verdict in NOTES).
import os
for f in sorted(os.listdir('test/fixtures')):
    if f.startswith('gemini-'):
        print(f, os.path.getsize('test/fixtures/' + f))
EOF
```

- [ ] **Step 4: Verify candidate regexes** (same harness as Task 9 Step 5, `gemini-` files) and **write the NOTES section**.

Record the pinned version. `gemini --version` can be slow to start (it may boot the full CLI); if it hangs, read the installed package version instead:

```bash
timeout 15 gemini --version || npm ls -g @google/gemini-cli --depth=0 2>/dev/null \
  || node -e "console.log(require('/usr/local/lib/node_modules/@google/gemini-cli/package.json').version)"
```

- [ ] **Step 5: Commit**

```bash
git add scratch/capture-gemini.mjs test/fixtures/gemini-*.txt test/fixtures/NOTES.md
git commit -m "test(fixtures): gemini CLI capture spike with verified marker candidates"
```

---

### Task 12: Gemini adapter

**Files:**
- Create: `src/adapters/gemini.js`
- Modify: `src/adapters/index.js`
- Test: `test/adapters.test.js`

**Interfaces:**
- Consumes: Task 11's fixtures + NOTES regexes.
- Produces: `gemini` adapter (full contract, `isBusy` REQUIRED if NOTES recorded idle-animation), registered as `gemini`.

- [ ] **Step 1: Write the failing tests** — append to `test/adapters.test.js` the same four-test block as Task 10 Step 1 with `codex` → `gemini` in adapter name, fixture filenames, and test titles (the assertions are identical; adjust the dialog/startupDialogs expectation to what Task 11 captured).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/adapters.test.js`
Expected: FAIL — `getAdapter('gemini')` throws.

- [ ] **Step 3: Implement** — create `src/adapters/gemini.js` from the Task 10 Step 3 template with `codex` → `gemini` and every `<FROM NOTES §Codex>` → the Task 11 NOTES §Gemini values. Register in `src/adapters/index.js`:

```js
import { gemini } from './gemini.js';

const REGISTRY = { generic, claude, codex, gemini };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/adapters.test.js` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/gemini.js src/adapters/index.js test/adapters.test.js
git commit -m "feat(adapters): gemini adapter from captured fixtures"
```

---

### Task 13: Copilot install, pre-auth fixtures, stub adapter

**Files:**
- Create: `scratch/capture-copilot.mjs`, `test/fixtures/copilot-boot.txt` (+ `copilot-login.txt` if a distinct login screen renders), `src/adapters/copilot.js`
- Modify: `src/adapters/index.js`, `test/fixtures/NOTES.md`
- Test: `test/adapters.test.js`

**Interfaces:**
- Consumes: `@github/copilot` CLI (installed in this task), no seat available — pre-auth screens only.
- Produces: `copilot` adapter registered as `copilot`, with **real fixture-verified** login/boot detection (`isAwaitingInput` on the login screen, `startupDialogs: []` — browser OAuth must NEVER be auto-answered, spec Security) and **explicitly unverified** idle/busy markers carrying a `VERIFIED: false` header note per the spec's Copilot decision.

- [ ] **Step 1: Preflight the Node version, then install the CLI**

GitHub's `@github/copilot` npm install requires **Node.js 22+**, and this machine is Node v20.19.2 — so the plain install will fail its engines check. Preflight and pick an install path that works on this box:

```bash
node -v   # v20.19.2 here — below @github/copilot's Node 22 floor
```

- **If a Node 22+ runtime is available** (e.g. via `nvm`/`fnm`/`volta`, or a system Node 22): use it just for the install and to run `copilot`, e.g. `nvm exec 22 npm install -g @github/copilot` (or activate 22 for this task). The bridge itself stays on Node 20 — only the capture spike needs 22.
- **If no Node 22 is available**, use a documented non-npm install path (GitHub also ships an install script / Homebrew formula for the Copilot CLI — see its install docs) and record which path was used in NOTES.
- **If neither is possible on this machine**, do not fake it: skip the live capture, ship the copilot adapter as a pure `VERIFIED: false` stub with **no** real fixtures (Step 5 still runs; Step 2's fixtures are simply absent), and record in NOTES §Copilot that no capture was possible and why. The registry entry and interface still land so a later seat/runtime can drop in fixtures.

```bash
# once a suitable runtime is active:
npm install -g @github/copilot && copilot --version
```

Expected: a version prints (record it), or a documented skip per the bullet above. If the package name has changed upstream, consult GitHub's current Copilot CLI docs and record what was installed in NOTES.

- [ ] **Step 2: Capture pre-auth screens** — create `scratch/capture-copilot.mjs`: copy `scratch/capture-codex.mjs` and change: spawn `'copilot'`; env deletes to `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`; prefix `copilot-`; and truncate the stages to boot-only:

```js
await sleep(8000); save('boot');   // expected: a login / device-code screen (no seat on this machine)
p.write('\r');
await sleep(5000); save('login');  // whatever Enter leads to pre-auth
p.kill();
```

Run: `node scratch/capture-copilot.mjs`, then render both captures with `scratch/render-fixture.mjs`, check alt-screen usage, and append a NOTES section `# GitHub Copilot CLI <version> — PRE-AUTH ONLY` recording: the login-screen text and a verified matcher regex for it, alt-screen verdict, and an explicit list of what is UNVERIFIED (idle/busy/response shapes — no seat).

- [ ] **Step 3: Write the failing tests** — append to `test/adapters.test.js`:

```js
// ---- copilot adapter: pre-auth fixtures only; idle/busy markers UNVERIFIED ----
import { existsSync } from 'node:fs'; // (if not already imported at top of file)

// Fixture-gated: runs only when a pre-auth capture exists (skipped entirely if
// Step 1 could not install/capture on this machine — the adapter still ships as
// a marked stub and the contract test below always runs).
test('copilot adapter: login screen classifies as awaiting_input, never auto-answered', { skip: !existsSync('test/fixtures/copilot-boot.txt') }, async () => {
  const a = getAdapter('copilot');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/copilot-boot.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.isAwaitingInput(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isIdle(tail), false);
  assert.deepEqual(a.startupDialogs, []); // browser OAuth is never auto-answered (spec Security)
});

test('copilot adapter: key map baseline, contract members present, no auto-answer', () => {
  const a = getAdapter('copilot');
  assert.equal(a.name, 'copilot');
  assert.equal(a.keySeq('enter'), '\r');
  assert.equal(typeof a.isBusy, 'function');
  assert.equal(typeof a.extractResponse, 'function');
  assert.deepEqual(a.startupDialogs, []); // holds even with no fixtures — OAuth is never auto-answered
});
```

(If the boot capture shows something other than a login screen — e.g. the CLI errors out pre-auth — adapt the first test to assert the classification the fixture actually supports, and record the discrepancy in NOTES. If no capture was possible at all, the fixture-gated test is skipped and the contract test still guards the registry entry.)

- [ ] **Step 4: Run tests to verify they fail**

Run: `node --test test/adapters.test.js`
Expected: FAIL — `getAdapter('copilot')` throws.

- [ ] **Step 5: Implement** — create `src/adapters/copilot.js` from the Task 10 template with these deltas, then register (`REGISTRY = { generic, claude, codex, gemini, copilot }`):

```js
// src/adapters/copilot.js
//
// VERIFIED: false (partial). Built without a Copilot seat: the login/boot
// markers below are fixture-verified (test/fixtures/copilot-*.txt, NOTES.md
// §Copilot), but IDLE_MARKERS/BUSY_MARKERS/CHROME are best-effort guesses
// pending fixtures from an authenticated session. Capture those fixtures and
// re-derive before trusting this adapter for facade traffic (spec: Copilot
// decision — "stub the rest").
```

with `AWAITING_INPUT_MARKERS = [<verified login-screen regex from NOTES §Copilot>]`, `startupDialogs: []`, and placeholder-but-functional idle/busy markers chosen from the CLI's public docs/help output — each tagged `// UNVERIFIED` inline.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/adapters.test.js` then `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scratch/capture-copilot.mjs test/fixtures/copilot-*.txt test/fixtures/NOTES.md src/adapters/copilot.js src/adapters/index.js test/adapters.test.js
git commit -m "feat(adapters): copilot pre-auth fixtures and marked-unverified stub adapter"
```

---

### Task 14: Documentation + full-suite verification

**Files:**
- Modify: `README.md`, `docs/API.md`, `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: docs matching the shipped behavior; a fully green suite.

- [ ] **Step 1: Update `docs/API.md`**
  - `POST /api/sessions`: document optional `profile` (valid names; `400 {error, validProfiles}`; headless rejected) and the `profile` field in all session responses.
  - `POST /api/sessions/:id/prompt`: document the new `text` field ("chrome-stripped assistant text via the adapter's `extractResponse`; `output` remains the raw rendered delta") and the multiline `400`.
  - `GET /ws`: document `?profile=` (creation only; ignored with `?session=`; 400 pre-upgrade shape).
  - Configuration list: add `DEFAULT_PROFILE`, `BRIDGE_PROFILES`, `PROFILE_<NAME>_*` (COMMAND, ARGS, ENV_SCRUB, DIALOG_POLICY, QUIESCENCE_MS, COLS, ROWS, CWD) with the four-level precedence order, copied from the spec's Profiles section.

- [ ] **Step 2: Update `README.md`**
  - Extend the configuration env table with the same new vars, one line each (`DEFAULT_PROFILE`, `BRIDGE_PROFILES`, `PROFILE_<NAME>_*`).
  - Add a short "Profiles" section: what a profile is, the built-in names, and the `dialogPolicy: auto-approve` security warning (spec: explicit opt-in — auto-answers dialogs the bridge cannot verify, so only enable it for unattended, trusted use).
  - **Env-scrub, per profile** (spec Security requires this be documented *per profile*, not one generic sentence): a short list, one row per CLI, naming both the env vars each profile scrubs **and** the file-based auth locations env-scrub cannot reach and that remain the operator's responsibility — claude (`~/.claude/.credentials.json` is the intended subscription path); codex (`~/.codex/auth.json`); gemini (`~/.gemini/.env`, gcloud ADC files, `~/.gemini/oauth_creds.json`); copilot (`gh` CLI stored creds). State plainly that env-scrub is best-effort: it blocks the documented API-key env vars, not file-based auth.
  - **Rewrite the existing back-compat paragraph** that currently reads "The bridge handles this for you: `src/session.js` deletes both variables from the environment it hands to the spawned PTY process." That is no longer literally true — env-scrub is now profile-driven. Replace it with: the `claude` profile (and the legacy `ADAPTER=generic` combination, for back-compat) scrub `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`; a profile's `envScrub` list is the source of truth.

- [ ] **Step 3: Update `docs/ARCHITECTURE.md`** — in the module table: `config.js` row mentions the profiles table; `adapters/` row lists `claude | codex | gemini | copilot (stub) | generic`; `session.js` row's env-scrub note becomes profile-driven (mention the legacy `ADAPTER=generic` still scrubs `ANTHROPIC_*`); `sessionManager.js` row notes the dialog-handler wiring. Add one sentence under "Readiness detection" about the periodic `isBusy` evaluation for spinner-animated CLIs, and one under "Security model" that env-scrub moved from a hardcoded `ANTHROPIC_*` delete to per-profile lists (best-effort; file-based auth out of scope).

- [ ] **Step 4: Full verification**

Run: `npm test`
Expected: PASS — every pre-existing and new test.

Run: `BRIDGE_TOKEN=t PROFILE_GENERIC_COMMAND=bash DEFAULT_PROFILE=generic node src/server.js &` then
`curl -s -XPOST http://127.0.0.1:7681/api/sessions -H 'authorization: Bearer t' -H 'content-type: application/json' -d '{"profile":"generic"}'`
Expected: `201` with `"profile":"generic"`. Kill the server afterward.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/API.md docs/ARCHITECTURE.md
git commit -m "docs: profiles, text field, and new env vars for universal CLI support"
```

---

## Plan Self-Review Notes

- **Spec coverage (Phase 1):** profiles + precedence + allowlist + boot validation (Task 1); strict registry (Task 2); contract growth incl. `multiline:'raw'` exception (Tasks 3–4); StateDetector isBusy/periodic + dialog-handler hook (Task 5); per-session selection, env-scrub move, `makeDialogHandler` (Task 6); `POST /prompt` `text`, profile params, WS rules (Tasks 7–8); fixture-first codex/gemini adapters (Tasks 9–12); copilot install + pre-auth fixtures + marked stub (Task 13); docs (Task 14). Phase 2 items (facade, turn runners, router) are intentionally absent — separate plan per the spec's Phasing section.
- **Empirical steps:** Tasks 9/11/13 produce verified marker regexes as recorded NOTES deliverables; Tasks 10/12 consume them verbatim. This is the same fixture-first discipline the claude adapter used, not a placeholder: every `<FROM NOTES>` slot has a defined producer step.
- **Type consistency spot-checks:** `record.profile`/`record.dialogPolicy`/`record.detector` (Task 6) match Tasks 7–8 usage; `writePromptText(session, adapter, text)` signature identical in Tasks 4 and 7; the detector's `dialogHandler` option (Task 5) is produced by `makeDialogHandler` (Task 6); error `.code` strings (`UNKNOWN_PROFILE`/`PROFILE_NOT_PTY`/`PROFILE_NO_COMMAND`/`ADAPTER_UNAVAILABLE`) identical in Tasks 6, 7, 8; `extractResponse(lines: string[])` consistent across Tasks 3, 7, 10, 12, 13.
- **Pre-flight validation done while writing:** the foundational units were extracted from this plan and run against their tests before finalizing — `config.js` (19/19, incl. precedence + boot validation), `promptWriter.js` (5/5), `stateDetector.js` (6/6, incl. the redesigned isBusy/periodic path and dialog-handler hook), Task 3 adapter growth against real fixtures (4/4), and `makeDialogHandler` (4/4). PTY-backed tasks (6 SessionManager spawn, 7 HTTP, 8 WS) rely on those validated units and the existing `bash`+generic integration harness.
- **Adversarial-review fixes folded in (2026-07-23):** detector no longer lets a data chunk demote a periodic-tick idle (was a self-failing test); `markBusy` re-phases the interval; auto-answered dialogs go through a detector `dialogHandler` so they never leak `awaiting_input` to `sendPrompt`, with a two-answers-per-persisting-screen cap; the two pre-existing `session.test.js` ANTHROPIC tests are explicitly rewritten (env-scrub moved to profiles); legacy `ADAPTER=generic` inherits the `ANTHROPIC_*` scrub (no security regression); a headless/command-less `DEFAULT_PROFILE` is rejected at boot and the WS handler validates the *effective* creation profile + wraps `create` in try/catch (no uncaught crash); `ADAPTER_UNAVAILABLE` closes the transient pre-adapter-registration window; a shipped table numeric value is honored above the legacy global; test snippets match the real `boot()`/`url()`/`auth` (http) and inline (ws) helper shapes; a multiline-400 test and per-CLI `extractResponse` chrome assertions were added; Copilot carries a Node-22 preflight with a documented skip path.
