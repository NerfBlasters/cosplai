# Interactive Claude Session Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local Node service that owns a PTY-backed interactive `claude` session and exposes it to both a browser `xterm.js` terminal and a programmatic HTTP/SSE API, so apps can drive flows on the Claude subscription while a human watches.

**Architecture:** One Node process. `SessionManager` owns `Session` objects (each a `node-pty` child running `claude`). Every raw chunk is fed to a `TerminalModel` (`@xterm/headless`) used by a `StateDetector` (quiescence + pluggable adapter markers) to classify `busy`/`idle`/`awaiting_input`. An HTTP API (token-gated) offers session CRUD, prompt, key, and SSE; a WebSocket API binds a browser terminal to a session. The one version-fragile surface is the adapter, injectable and fixture-driven.

**Tech Stack:** Node 20, `node-pty`, `ws`, `@xterm/headless`; browser `xterm` + `@xterm/addon-fit` (vendored). Tests use `node:test` + `node:assert`.

## Global Constraints

- Node 20 (target v20.19.2). No TypeScript — plain ESM `.js` (`"type":"module"`).
- Runtime deps only: `node-pty`, `ws`, `@xterm/headless`. Browser assets (`xterm`, `@xterm/addon-fit`) are **vendored into `public/vendor/`** — NO runtime CDN dependency.
- Bind `127.0.0.1` only — never `0.0.0.0`.
- Every HTTP route and WS upgrade requires a token (`Authorization: Bearer <t>` or `?token=`), compared with `crypto.timingSafeEqual` (length-guarded so it never throws on length mismatch).
- Child PTY env MUST have `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` deleted (forces subscription OAuth).
- No `Co-Authored-By` / Claude attribution in commits (per `~/.claude/CLAUDE.md`).
- Commit after each task with `git commit`.
- TDD: failing test first, then implementation. Tests must not spend Claude subscription usage — use the `generic` adapter + `bash` for pipeline tests; use captured fixtures for `claude` adapter tests.

---

### Task 1: Project scaffold, dependencies, vendored browser assets

**Files:**
- Create: `package.json`, `.gitignore` (exists), `test/smoke.test.js`
- Create (vendored): `public/vendor/xterm.js`, `public/vendor/xterm.css`, `public/vendor/addon-fit.js`

**Interfaces:**
- Produces: an installable project where `npm test` runs `node --test` green.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "interactive-claude-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  },
  "dependencies": {
    "@xterm/headless": "^5.5.0",
    "node-pty": "^1.0.0",
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 2: Install deps and verify node-pty native build**

Run: `cd /home/kali/pty-web-bridge && npm install`
Expected: completes; `node -e "import('node-pty').then(p=>console.log(typeof p.spawn))"` prints `function`.
If node-pty fails to build: STOP and report — the tmux-fallback path (spec Open Risks) is then required and must be raised with the orchestrator.

- [ ] **Step 3: Vendor browser assets**

Run:
```bash
cd /home/kali/pty-web-bridge
mkdir -p public/vendor
npm pack @xterm/xterm@5.5.0 --pack-destination /tmp/xterm-dl >/dev/null 2>&1 || npm pack xterm@5.3.0 --pack-destination /tmp/xterm-dl
tar -xzf /tmp/xterm-dl/*.tgz -C /tmp/xterm-dl
# copy the UMD build + css (path differs by package version; find them)
find /tmp/xterm-dl/package -name 'xterm.js' -path '*lib*' -exec cp {} public/vendor/xterm.js \; 2>/dev/null || find /tmp/xterm-dl/package -name '*.js' -path '*lib*' | head -1 | xargs -I{} cp {} public/vendor/xterm.js
find /tmp/xterm-dl/package -name 'xterm.css' -exec cp {} public/vendor/xterm.css \;
npm pack @xterm/addon-fit@0.10.0 --pack-destination /tmp/fit-dl >/dev/null 2>&1
tar -xzf /tmp/fit-dl/*.tgz -C /tmp/fit-dl
find /tmp/fit-dl/package -name '*.js' -path '*lib*' | head -1 | xargs -I{} cp {} public/vendor/addon-fit.js
ls -la public/vendor/
```
Expected: `xterm.js`, `xterm.css`, `addon-fit.js` present and non-empty. If the exact filenames/paths differ, adapt — the requirement is a working UMD `Terminal` global + fit addon usable from a plain `<script>`. Record the resolved versions in a comment in `public/index.html` later.

- [ ] **Step 4: Write a trivial smoke test**

```js
// test/smoke.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test runner works', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 5: Run tests**

Run: `cd /home/kali/pty-web-bridge && npm test`
Expected: 1 test passing.

- [ ] **Step 6: Commit**

```bash
cd /home/kali/pty-web-bridge
git add -A
git commit -m "chore: scaffold project, deps, vendored xterm assets"
```

---

### Task 2: Empirical spike — capture real Claude PTY fixtures

This task GATES the `claude` adapter (Task 6). No adapter marker may be written from assumption. It spends a trivial amount of subscription usage.

**Files:**
- Create: `scratch/spike.mjs` (throwaway, gitignored via `scratch/`)
- Create: `test/fixtures/claude-idle.txt`, `test/fixtures/claude-response.txt`, and (if encountered) `test/fixtures/claude-menu.txt`, `test/fixtures/claude-trust.txt`
- Create: `test/fixtures/NOTES.md`

**Interfaces:**
- Produces: raw byte fixtures + a NOTES.md documenting: alt-screen usage (yes/no), the idle input-prompt rendering, the submit key, and any startup/trust/permission dialog shape.

- [ ] **Step 1: Write the spike script**

```js
// scratch/spike.mjs — throwaway capture harness
import pty from 'node-pty';
import fs from 'node:fs';

const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
delete env.ANTHROPIC_AUTH_TOKEN;

const p = pty.spawn('claude', [], {
  name: 'xterm-256color', cols: 120, rows: 30,
  cwd: process.env.HOME, env,
});

let buf = Buffer.alloc(0);
p.onData(d => { buf = Buffer.concat([buf, Buffer.from(d, 'utf8')]); process.stdout.write(d); });

const write = s => p.write(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await sleep(4000);                         // let it boot (may show trust/onboarding)
  fs.writeFileSync('test/fixtures/claude-idle.txt', buf);  // capture startup+idle
  const preLen = buf.length;
  write('reply with exactly: PONG');
  await sleep(600);
  write('\r');                               // submit (verify this is correct)
  await sleep(12000);                         // let it answer
  fs.writeFileSync('test/fixtures/claude-response.txt', buf.slice(preLen));
  write('\x03'); write('\x03');              // ctrl-c twice
  await sleep(500);
  p.kill();
  console.error('\n\n=== captured', buf.length, 'bytes ===');
  process.exit(0);
})();
```

- [ ] **Step 2: Run the spike and observe**

Run: `cd /home/kali/pty-web-bridge && mkdir -p test/fixtures scratch && node scratch/spike.mjs`
Expected: Claude boots and answers `PONG`. Watch the live output for: a trust/onboarding dialog (if the cwd is untrusted), the exact idle input-box rendering, and whether the screen clears (alt-screen). If a trust or theme dialog blocks boot, answer it interactively is NOT possible in this script — instead re-run after first launching `claude` once manually in `$HOME` to clear onboarding, or set `cwd` to an already-trusted dir. Capture whatever dialog appears into `test/fixtures/claude-trust.txt` by adjusting timing.

- [ ] **Step 3: If a permission menu can be triggered, capture it**

Optionally extend the spike to ask something that triggers a tool-permission prompt (e.g. `run the shell command: ls`) and capture the menu frame to `test/fixtures/claude-menu.txt`. If not easily triggered, note that in NOTES.md and defer menu markers to a best-effort heuristic.

- [ ] **Step 4: Write findings to NOTES.md**

```md
# Claude Code 2.1.198 interactive TUI — observed under node-pty

- Alt-screen buffer used: <yes/no>
- Idle input prompt renders as: <describe / paste the line(s)>
- Submit key: <Enter=\r works? or needs something else>
- Startup/trust dialog: <none | describe + fixture file>
- Permission menu: <none captured | describe + fixture file>
- Spinner / "esc to interrupt" line during generation: <describe>
```

- [ ] **Step 5: Commit fixtures + notes (not the throwaway script)**

```bash
cd /home/kali/pty-web-bridge
git add test/fixtures
git commit -m "test: capture real Claude PTY fixtures for adapter markers"
```

---

### Task 3: Config + token auth

**Files:**
- Create: `src/config.js`, `src/auth.js`
- Test: `test/config.test.js`, `test/auth.test.js`

**Interfaces:**
- Produces:
  - `loadConfig(env = process.env)` → frozen object `{host, port, token, tokenGenerated:boolean, claudeCmd, claudeArgs:string[], cwd, quiescenceMs, promptTimeoutMs, cols, rows, scrollback, ringBytes, adapter:'claude'|'generic'}`.
  - `checkToken(provided, expected)` → boolean, timing-safe, false on null/length mismatch.
  - `extractToken(req)` → string|null (from `Authorization: Bearer` header or `?token=`).

- [ ] **Step 1: Write failing tests**

```js
// test/config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('defaults apply when env empty', () => {
  const c = loadConfig({});
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 7681);
  assert.equal(c.claudeCmd, 'claude');
  assert.equal(c.adapter, 'claude');
  assert.ok(c.token && c.token.length >= 16);
  assert.equal(c.tokenGenerated, true);
});

test('env overrides and CLAUDE_ARGS parses JSON', () => {
  const c = loadConfig({ PORT: '9000', BRIDGE_TOKEN: 'abc', CLAUDE_ARGS: '["--foo"]', ADAPTER: 'generic' });
  assert.equal(c.port, 9000);
  assert.equal(c.token, 'abc');
  assert.equal(c.tokenGenerated, false);
  assert.deepEqual(c.claudeArgs, ['--foo']);
  assert.equal(c.adapter, 'generic');
});

test('config is frozen', () => {
  const c = loadConfig({});
  assert.throws(() => { c.port = 1; });
});
```

```js
// test/auth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkToken, extractToken } from '../src/auth.js';

test('checkToken accepts equal, rejects unequal/null/length-mismatch', () => {
  assert.equal(checkToken('secret', 'secret'), true);
  assert.equal(checkToken('secret', 'secretx'), false);
  assert.equal(checkToken('wrong0', 'secret'), false); // same length, differ
  assert.equal(checkToken(null, 'secret'), false);
  assert.equal(checkToken('secret', null), false);
});

test('extractToken reads header then query', () => {
  assert.equal(extractToken({ headers: { authorization: 'Bearer xyz' }, url: '/x' }), 'xyz');
  assert.equal(extractToken({ headers: {}, url: '/x?token=qq' }), 'qq');
  assert.equal(extractToken({ headers: {}, url: '/x' }), null);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `src/config.js`**

```js
import crypto from 'node:crypto';

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

export function loadConfig(env = process.env) {
  const token = env.BRIDGE_TOKEN || crypto.randomBytes(24).toString('base64url');
  let claudeArgs = [];
  if (env.CLAUDE_ARGS) { try { claudeArgs = JSON.parse(env.CLAUDE_ARGS); } catch { claudeArgs = []; } }
  return Object.freeze({
    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 7681),
    token,
    tokenGenerated: !env.BRIDGE_TOKEN,
    claudeCmd: env.CLAUDE_CMD || 'claude',
    claudeArgs,
    cwd: env.CWD || env.HOME || process.cwd(),
    quiescenceMs: num(env.QUIESCENCE_MS, 500),
    promptTimeoutMs: num(env.PROMPT_TIMEOUT_MS, 600000),
    cols: num(env.COLS, 120),
    rows: num(env.ROWS, 30),
    scrollback: num(env.SCROLLBACK, 5000),
    ringBytes: num(env.RING_BYTES, 262144),
    adapter: env.ADAPTER === 'generic' ? 'generic' : 'claude',
  });
}
```

- [ ] **Step 4: Implement `src/auth.js`**

```js
import crypto from 'node:crypto';

export function checkToken(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function extractToken(req) {
  const h = req.headers?.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  const q = (req.url || '').split('?')[1];
  if (q) { const p = new URLSearchParams(q); if (p.get('token')) return p.get('token'); }
  return null;
}
```

- [ ] **Step 5: Run tests, verify pass; commit**

Run: `npm test` → all pass.
```bash
git add -A && git commit -m "feat: config loader and timing-safe token auth"
```

---

### Task 4: Session (node-pty wrapper) with injectable command

**Files:**
- Create: `src/session.js`
- Test: `test/session.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `class Session extends EventEmitter`:
  - `new Session({command, args=[], cwd, env, cols, rows, ringBytes})` — spawns immediately; strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from a copy of the passed `env` (default `process.env`).
  - property `id` (uuid), `alive` (boolean).
  - emits `'data'`(string chunk), `'exit'`({exitCode,signal}).
  - `write(data)`, `resize(cols,rows)`, `kill()`.
  - `scrollback()` → string (current ring-buffer contents, decoded).

- [ ] **Step 1: Write failing tests (use `bash`/`cat`, never claude)**

```js
// test/session.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/session.js';

const once = (em, ev) => new Promise(r => em.once(ev, r));

test('spawns, echoes input, buffers scrollback, exits', async () => {
  const s = new Session({ command: 'cat', args: [], cwd: process.cwd() });
  assert.ok(s.id);
  assert.equal(s.alive, true);
  let out = '';
  s.on('data', d => { out += d; });
  s.write('hello\n');
  await new Promise(r => setTimeout(r, 200));
  assert.match(out, /hello/);
  assert.match(s.scrollback(), /hello/);
  const exited = once(s, 'exit');
  s.kill();
  await exited;
  assert.equal(s.alive, false);
});

test('strips ANTHROPIC_API_KEY from child env', async () => {
  const s = new Session({ command: 'bash', args: ['-lc', 'echo KEY=[$ANTHROPIC_API_KEY]'],
    cwd: process.cwd(), env: { ...process.env, ANTHROPIC_API_KEY: 'sk-should-be-gone' } });
  let out = '';
  s.on('data', d => { out += d; });
  await once(s, 'exit');
  assert.match(out, /KEY=\[\]/);
});
```

- [ ] **Step 2: Run, verify fail** — `npm test` FAIL (no module).

- [ ] **Step 3: Implement `src/session.js`**

```js
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import pty from 'node-pty';

export class Session extends EventEmitter {
  constructor({ command, args = [], cwd, env = process.env, cols = 120, rows = 30, ringBytes = 262144 }) {
    super();
    this.id = crypto.randomUUID();
    this.alive = true;
    this._ringBytes = ringBytes;
    this._ring = Buffer.alloc(0);
    const childEnv = { ...env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    this._pty = pty.spawn(command, args, { name: 'xterm-256color', cols, rows, cwd, env: childEnv });
    this._pty.onData(d => {
      const b = Buffer.from(d, 'utf8');
      this._ring = Buffer.concat([this._ring, b]);
      if (this._ring.length > this._ringBytes) this._ring = this._ring.subarray(this._ring.length - this._ringBytes);
      this.emit('data', d);
    });
    this._pty.onExit(e => { this.alive = false; this.emit('exit', { exitCode: e.exitCode, signal: e.signal }); });
  }
  write(data) { if (this.alive) this._pty.write(data); }
  resize(cols, rows) { if (this.alive) { try { this._pty.resize(cols, rows); } catch { /* ignore */ } } }
  kill() { if (this.alive) { try { this._pty.kill(); } catch { /* ignore */ } } }
  scrollback() { return this._ring.toString('utf8'); }
}
```

- [ ] **Step 4: Run, verify pass; commit**

Run `npm test` → pass.
```bash
git add -A && git commit -m "feat: Session pty wrapper with env sanitization and ring buffer"
```

---

### Task 5: TerminalModel (@xterm/headless)

**Files:**
- Create: `src/terminalModel.js`
- Test: `test/terminalModel.test.js`

**Interfaces:**
- Produces: `class TerminalModel`:
  - `new TerminalModel({cols, rows, scrollback})`.
  - `write(chunk)` (feeds the emulator; accepts string).
  - `snapshotLineCount()` → integer absolute line index (`buffer.active.baseY + rows`... use `baseY + cursorY + 1` upper bound; see impl).
  - `renderLinesSince(index)` → string[] trimmed rendered lines from `index` to current end (walks scrollback+viewport), trailing blank lines removed.
  - `viewportTail(n=6)` → string[] last `n` non-empty rendered lines.

- [ ] **Step 1: Write failing tests**

```js
// test/terminalModel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalModel } from '../src/terminalModel.js';

test('renders plain text and strips escape codes', () => {
  const t = new TerminalModel({ cols: 80, rows: 24, scrollback: 1000 });
  const before = t.snapshotLineCount();
  t.write('\x1b[32mgreen line\x1b[0m\r\nsecond line\r\n');
  const lines = t.renderLinesSince(before);
  assert.ok(lines.some(l => l.includes('green line')));
  assert.ok(lines.some(l => l.includes('second line')));
  assert.ok(!lines.join('\n').includes('\x1b'));
});

test('viewportTail returns last non-empty lines', () => {
  const t = new TerminalModel({ cols: 80, rows: 24, scrollback: 1000 });
  t.write('alpha\r\nbeta\r\n> \r\n');
  const tail = t.viewportTail(3);
  assert.ok(tail.some(l => l.includes('beta')));
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `src/terminalModel.js`**

```js
import { Terminal } from '@xterm/headless';

export class TerminalModel {
  constructor({ cols = 120, rows = 30, scrollback = 5000 }) {
    this._term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this._rows = rows;
  }
  write(chunk) { this._term.write(chunk); }
  _buf() { return this._term.buffer.active; }
  snapshotLineCount() { const b = this._buf(); return b.baseY + this._rows; }
  _lineText(i) { const line = this._buf().getLine(i); return line ? line.translateToString(true) : ''; }
  renderLinesSince(index) {
    const b = this._buf();
    const end = b.baseY + this._rows;
    const out = [];
    for (let i = Math.max(0, index); i < end; i++) out.push(this._lineText(i).replace(/\s+$/, ''));
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }
  viewportTail(n = 6) {
    const b = this._buf();
    const end = b.baseY + this._rows;
    const out = [];
    for (let i = end - 1; i >= 0 && out.length < n; i--) {
      const t = this._lineText(i).replace(/\s+$/, '');
      if (t !== '') out.unshift(t);
    }
    return out;
  }
}
```

- [ ] **Step 4: Run, verify pass; commit.**

```bash
git add -A && git commit -m "feat: headless TerminalModel for detection and clean text"
```

---

### Task 6: Adapters (generic + claude, fixture-driven)

**Files:**
- Create: `src/adapters/generic.js`, `src/adapters/claude.js`, `src/adapters/index.js`
- Test: `test/adapters.test.js`

**Interfaces:**
- Produces: an adapter object shape `{ name, isIdle(tail:string[]):bool, isAwaitingInput(tail:string[]):bool, describePrompt(tail:string[]):string|null, keySeq(name:string):string }` and `getAdapter(name)` from `index.js`.
- generic: `isIdle` = true whenever called (quiescence alone = idle), `isAwaitingInput` = false, `describePrompt` = null, `keySeq` maps arrows/enter/esc/tab/ctrl-c and passes through printable strings.
- claude: markers derived from Task 2 fixtures. `keySeq` submit = the empirically-verified submit sequence.

- [ ] **Step 1: Write failing tests**

Generic behavior + claude classification against real fixtures. The claude assertions MUST be written to match the actual captured fixtures from Task 2 (read `test/fixtures/*.txt` + NOTES.md first). Template:

```js
// test/adapters.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getAdapter } from '../src/adapters/index.js';
import { TerminalModel } from '../src/terminalModel.js';

test('generic adapter: quiescence means idle', () => {
  const a = getAdapter('generic');
  assert.equal(a.isIdle(['anything']), true);
  assert.equal(a.isAwaitingInput(['anything']), false);
  assert.equal(a.keySeq('down'), '\x1b[B');
  assert.equal(a.keySeq('enter'), '\r');
  assert.equal(a.keySeq('x'), 'x');
});

test('claude adapter: idle fixture classifies as idle, not awaiting', () => {
  const a = getAdapter('claude');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  t.write(fs.readFileSync('test/fixtures/claude-idle.txt', 'utf8'));
  const tail = t.viewportTail(8);
  assert.equal(a.isIdle(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isAwaitingInput(tail), false);
});
```
Add a `claude-menu.txt`/`claude-trust.txt` assertion for `isAwaitingInput===true` ONLY if that fixture was captured in Task 2; otherwise note its absence and skip (do not assert against a non-existent fixture).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `src/adapters/generic.js`**

```js
const KEYS = { enter: '\r', submit: '\r', up: '\x1b[A', down: '\x1b[B',
  left: '\x1b[D', right: '\x1b[C', esc: '\x1b', tab: '\t', 'ctrl-c': '\x03' };

export const generic = {
  name: 'generic',
  isIdle() { return true; },
  isAwaitingInput() { return false; },
  describePrompt() { return null; },
  keySeq(name) { return Object.prototype.hasOwnProperty.call(KEYS, name) ? KEYS[name] : String(name); },
};
```

- [ ] **Step 4: Implement `src/adapters/claude.js`** using the Task 2 findings.

Write the markers to match the captured fixtures. Use the generic key map as a base and override `submit` if the spike proved Enter is not the submit key. The idle test is the source of truth — tune the regexes until `test/adapters.test.js` passes against the real fixture. Structure:

```js
// Pinned to Claude Code 2.x (built against 2.1.198). Markers derived from
// test/fixtures/*.txt captured in the empirical spike (see fixtures/NOTES.md).
const KEYS = { enter: '\r', submit: '\r', up: '\x1b[A', down: '\x1b[B',
  left: '\x1b[D', right: '\x1b[C', esc: '\x1b', tab: '\t', 'ctrl-c': '\x03' };

// TUNE these against the real fixtures — placeholders below must be replaced
// with patterns that actually match the captured idle/menu frames.
const IDLE_MARKERS = [ /* e.g. the input box border / prompt glyph seen when idle */ ];
const BUSY_MARKERS = [ /* e.g. "esc to interrupt" spinner line seen mid-generation */ ];
const MENU_MARKERS = [ /* e.g. numbered options / "Do you want" / "❯" selector */ ];

const anyMatch = (tail, res) => res.some(re => tail.some(l => re.test(l)));

export const claude = {
  name: 'claude',
  isAwaitingInput(tail) { return anyMatch(tail, MENU_MARKERS); },
  isIdle(tail) {
    if (this.isAwaitingInput(tail)) return false;
    if (anyMatch(tail, BUSY_MARKERS)) return false;
    return anyMatch(tail, IDLE_MARKERS);
  },
  describePrompt(tail) { return this.isAwaitingInput(tail) ? tail.join('\n') : null; },
  keySeq(name) { return Object.prototype.hasOwnProperty.call(KEYS, name) ? KEYS[name] : String(name); },
};
```

- [ ] **Step 5: Implement `src/adapters/index.js`**

```js
import { generic } from './generic.js';
import { claude } from './claude.js';
export function getAdapter(name) { return name === 'generic' ? generic : claude; }
```

- [ ] **Step 6: Run tests, verify pass (claude idle fixture classifies correctly); commit.**

```bash
git add -A && git commit -m "feat: pluggable adapters (generic + fixture-driven claude)"
```

---

### Task 7: StateDetector + PromptQueue

**Files:**
- Create: `src/stateDetector.js`, `src/promptQueue.js`
- Test: `test/stateDetector.test.js`, `test/promptQueue.test.js`

**Interfaces:**
- Produces:
  - `class StateDetector extends EventEmitter`: `new StateDetector({session, terminalModel, adapter, quiescenceMs})`. Subscribes to `session` `'data'`/`'exit'`. Property `state` (`starting|idle|busy|awaiting_input|exited`). Emits `'state'`(newState). `waitForSettle({timeoutMs})` → Promise resolving `'idle'|'awaiting_input'`, rejecting on timeout or `'exited'`.
  - `class PromptQueue`: `enqueue(fn)` → Promise (runs `fn` after prior ones settle, FIFO).

- [ ] **Step 1: Write failing tests**

```js
// test/promptQueue.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromptQueue } from '../src/promptQueue.js';

test('runs in FIFO order, serialized', async () => {
  const q = new PromptQueue();
  const order = [];
  const mk = (n, ms) => () => new Promise(r => setTimeout(() => { order.push(n); r(n); }, ms));
  const p1 = q.enqueue(mk(1, 30));
  const p2 = q.enqueue(mk(2, 5));
  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2]);
});
```

```js
// test/stateDetector.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StateDetector } from '../src/stateDetector.js';
import { TerminalModel } from '../src/terminalModel.js';
import { generic } from '../src/adapters/generic.js';

function fakeSession() { const s = new EventEmitter(); s.alive = true; return s; }

test('goes busy on data then idle after quiescence (generic)', async () => {
  const session = fakeSession();
  const tm = new TerminalModel({ cols: 80, rows: 24, scrollback: 500 });
  const d = new StateDetector({ session, terminalModel: tm, adapter: generic, quiescenceMs: 50 });
  const settle = d.waitForSettle({ timeoutMs: 2000 });
  session.emit('data', 'hello');
  tm.write('hello');
  assert.equal(d.state, 'busy');
  const s = await settle;
  assert.equal(s, 'idle');
  assert.equal(d.state, 'idle');
});

test('waitForSettle rejects on exit', async () => {
  const session = fakeSession();
  const tm = new TerminalModel({ cols: 80, rows: 24, scrollback: 500 });
  const d = new StateDetector({ session, terminalModel: tm, adapter: generic, quiescenceMs: 50 });
  const settle = d.waitForSettle({ timeoutMs: 2000 });
  session.emit('exit', { exitCode: 0 });
  await assert.rejects(() => settle);
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `src/promptQueue.js`**

```js
export class PromptQueue {
  constructor() { this._tail = Promise.resolve(); }
  enqueue(fn) {
    const run = this._tail.then(fn, fn);
    this._tail = run.then(() => {}, () => {});
    return run;
  }
}
```

- [ ] **Step 4: Implement `src/stateDetector.js`**

```js
import { EventEmitter } from 'node:events';

export class StateDetector extends EventEmitter {
  constructor({ session, terminalModel, adapter, quiescenceMs = 500 }) {
    super();
    this._tm = terminalModel;
    this._adapter = adapter;
    this._quiescenceMs = quiescenceMs;
    this._timer = null;
    this.state = 'starting';
    session.on('data', () => this._onData());
    session.on('exit', () => this._setState('exited'));
    this._onData(); // arm initial quiescence so a quiet startup can settle
  }
  _setState(s) { if (this.state !== s) { this.state = s; this.emit('state', s); } }
  _onData() {
    if (this.state !== 'exited') this._setState('busy');
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._evaluate(), this._quiescenceMs);
  }
  _evaluate() {
    if (this.state === 'exited') return;
    const tail = this._tm.viewportTail(8);
    if (this._adapter.isAwaitingInput(tail)) this._setState('awaiting_input');
    else if (this._adapter.isIdle(tail)) this._setState('idle');
    else this._setState('busy'); // not settled — a later chunk will re-arm; if none, stays busy
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

- [ ] **Step 5: Run, verify pass; commit.**

```bash
git add -A && git commit -m "feat: state detector and prompt queue"
```

---

### Task 8: SessionManager + HTTP API (CRUD, prompt, key, SSE)

**Files:**
- Create: `src/sessionManager.js`, `src/httpApi.js`
- Test: `test/httpApi.test.js`

**Interfaces:**
- Consumes: `Session`, `TerminalModel`, `StateDetector`, `PromptQueue`, `getAdapter`, `loadConfig`, `checkToken`, `extractToken`.
- Produces:
  - `class SessionManager`: `new SessionManager(config)`. `create({cwd,cols,rows}={})` → managed session record `{id, session, terminalModel, detector, queue, createdAt}`. `get(id)`, `list()`, `remove(id)`. Each managed record wires `session.'data' → terminalModel.write` and stores everything. In tests a config with `adapter:'generic'` and `claudeCmd:'bash'`, `claudeArgs:['-i']` (or `cat`) is used.
  - `createHttpServer(config, manager)` → Node `http.Server` (not yet listening) implementing the routes in the spec. Returns the server so tests can `listen(0)`.
  - `sendPrompt(record, {text, submit, timeoutMs})` helper → `{state, output, prompt, durationMs}` (exported for direct unit test): snapshot line count, write text (+ submit key via adapter), `waitForSettle`, then `renderLinesSince`.

- [ ] **Step 1: Write failing tests (bash-backed, generic adapter, real HTTP)**

```js
// test/httpApi.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';

function boot() {
  const config = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]',
    BRIDGE_TOKEN: 'tok', QUIESCENCE_MS: '150', PROMPT_TIMEOUT_MS: '8000' });
  const manager = new SessionManager(config);
  const server = createHttpServer(config, manager);
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ config, manager, server, port: server.address().port })));
}
const url = (port, path) => `http://127.0.0.1:${port}${path}`;
const auth = { headers: { authorization: 'Bearer tok', 'content-type': 'application/json' } };

test('401 without token', async () => {
  const { server, port } = await boot();
  const r = await fetch(url(port, '/api/sessions'), { method: 'POST' });
  assert.equal(r.status, 401);
  server.close();
});

test('create session, prompt echoes output, delete', async () => {
  const { server, port, manager } = await boot();
  const c = await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' });
  assert.equal(c.status, 201);
  const { id } = await c.json();
  assert.ok(id);
  const p = await fetch(url(port, `/api/sessions/${id}/prompt`), { method: 'POST', ...auth,
    body: JSON.stringify({ text: 'echo hello-there' }) });
  assert.equal(p.status, 200);
  const body = await p.json();
  assert.equal(body.state, 'idle');
  assert.match(body.output, /hello-there/);
  const d = await fetch(url(port, `/api/sessions/${id}`), { method: 'DELETE', ...auth });
  assert.equal(d.status, 204);
  server.close();
});

test('key endpoint returns state', async () => {
  const { server, port } = await boot();
  const c = await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' });
  const { id } = await c.json();
  const k = await fetch(url(port, `/api/sessions/${id}/key`), { method: 'POST', ...auth,
    body: JSON.stringify({ keys: ['x', 'ctrl-c'] }) });
  assert.equal(k.status, 200);
  assert.ok((await k.json()).state);
  server.close();
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `src/sessionManager.js`**

```js
import { Session } from './session.js';
import { TerminalModel } from './terminalModel.js';
import { StateDetector } from './stateDetector.js';
import { PromptQueue } from './promptQueue.js';
import { getAdapter } from './adapters/index.js';

export class SessionManager {
  constructor(config) { this._config = config; this._records = new Map(); }
  create({ cwd, cols, rows } = {}) {
    const c = this._config;
    const session = new Session({
      command: c.claudeCmd, args: c.claudeArgs, cwd: cwd || c.cwd,
      env: process.env, cols: cols || c.cols, rows: rows || c.rows, ringBytes: c.ringBytes,
    });
    const terminalModel = new TerminalModel({ cols: cols || c.cols, rows: rows || c.rows, scrollback: c.scrollback });
    session.on('data', d => terminalModel.write(d));
    const adapter = getAdapter(c.adapter);
    const detector = new StateDetector({ session, terminalModel, adapter, quiescenceMs: c.quiescenceMs });
    const record = { id: session.id, session, terminalModel, detector, adapter, queue: new PromptQueue(), createdAt: Date.now() };
    this._records.set(session.id, record);
    session.on('exit', () => { /* keep record so state reads 'exited'; reaped by remove */ });
    return record;
  }
  get(id) { return this._records.get(id); }
  list() { return [...this._records.values()]; }
  remove(id) { const r = this._records.get(id); if (r) { r.session.kill(); this._records.delete(id); } return !!r; }
}
```

- [ ] **Step 4: Implement `src/httpApi.js`**

Provide `sendPrompt` + routing. Key logic:

```js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkToken, extractToken } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

export async function sendPrompt(record, { text, submit = true, timeoutMs = 600000 }) {
  const start = Date.now();
  const before = record.terminalModel.snapshotLineCount();
  record.session.write(text);
  if (submit) record.session.write(record.adapter.keySeq('submit'));
  const state = await record.detector.waitForSettle({ timeoutMs });
  const output = record.terminalModel.renderLinesSince(before).join('\n');
  const prompt = state === 'awaiting_input' ? record.adapter.describePrompt(record.terminalModel.viewportTail(8)) : null;
  return { state, output, prompt, durationMs: Date.now() - start };
}

function json(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json' }); res.end(b); }
function readBody(req) { return new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } }); }); }

export function createHttpServer(config, manager) {
  return http.createServer(async (req, res) => {
    try {
      if (!checkToken(extractToken(req), config.token)) return json(res, 401, { error: 'unauthorized' });
      const u = new URL(req.url, 'http://x');
      const parts = u.pathname.split('/').filter(Boolean); // e.g. ['api','sessions',':id','prompt']

      if (req.method === 'POST' && u.pathname === '/api/sessions') {
        const b = await readBody(req); const rec = manager.create(b);
        return json(res, 201, { id: rec.id, state: rec.detector.state });
      }
      if (req.method === 'GET' && u.pathname === '/api/sessions') {
        return json(res, 200, { sessions: manager.list().map(r => ({ id: r.id, state: r.detector.state, createdAt: r.createdAt })) });
      }
      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2]) {
        const rec = manager.get(parts[2]);
        if (!rec) return json(res, 404, { error: 'not found' });
        if (req.method === 'GET' && parts.length === 3) return json(res, 200, { id: rec.id, state: rec.detector.state, createdAt: rec.createdAt });
        if (req.method === 'DELETE' && parts.length === 3) { manager.remove(rec.id); res.writeHead(204); return res.end(); }
        if (req.method === 'POST' && parts[3] === 'prompt') {
          if (!rec.session.alive) return json(res, 409, { error: 'session not alive' });
          const b = await readBody(req);
          if (typeof b.text !== 'string') return json(res, 400, { error: 'text required' });
          try {
            const out = await rec.queue.enqueue(() => sendPrompt(rec, { text: b.text, submit: b.submit !== false, timeoutMs: b.timeoutMs || config.promptTimeoutMs }));
            return json(res, 200, out);
          } catch (e) { return json(res, 504, { error: String(e.message || e) }); }
        }
        if (req.method === 'POST' && parts[3] === 'key') {
          if (!rec.session.alive) return json(res, 409, { error: 'session not alive' });
          const b = await readBody(req);
          for (const k of (b.keys || [])) rec.session.write(rec.adapter.keySeq(k));
          await new Promise(r => setTimeout(r, Math.min(config.quiescenceMs * 2, 1000)));
          return json(res, 200, { state: rec.detector.state });
        }
        if (req.method === 'GET' && parts[3] === 'events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          const onData = d => res.write(`data: ${JSON.stringify({ type: 'output', data: d })}\n\n`);
          const onState = s => res.write(`data: ${JSON.stringify({ type: 'state', state: s })}\n\n`);
          rec.session.on('data', onData); rec.detector.on('state', onState);
          req.on('close', () => { rec.session.off('data', onData); rec.detector.off('state', onState); });
          return;
        }
      }
      // static: GET / and /index.html (token already checked)
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
        return fs.createReadStream(path.join(PUBLIC, 'index.html')).on('error', () => json(res, 404, { error: 'no page' })).pipe(res.writeHead(200, { 'content-type': 'text/html' }));
      }
      if (req.method === 'GET' && u.pathname.startsWith('/vendor/')) {
        const f = path.join(PUBLIC, path.normalize(u.pathname));
        if (!f.startsWith(path.join(PUBLIC, 'vendor'))) return json(res, 403, { error: 'forbidden' });
        const type = f.endsWith('.css') ? 'text/css' : 'application/javascript';
        return fs.createReadStream(f).on('error', () => json(res, 404, { error: 'not found' })).pipe(res.writeHead(200, { 'content-type': type }));
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 500, { error: String(e.message || e) }); }
  });
}
```

Note for implementer: the `res.writeHead(...).pipe` chaining is invalid (`writeHead` returns the response in Node ≥ 12 actually returns the ServerResponse, but keep it robust) — write it as `const s = fs.createReadStream(f); res.writeHead(200,{...}); s.on('error',...); s.pipe(res);`. Fix during implementation; the test only exercises `/api/*`.

- [ ] **Step 5: Run, verify pass; commit.**

```bash
git add -A && git commit -m "feat: SessionManager and token-gated HTTP API (crud/prompt/key/sse)"
```

---

### Task 9: WebSocket API (browser terminal binding)

**Files:**
- Create: `src/wsApi.js`
- Test: `test/wsApi.test.js`

**Interfaces:**
- Consumes: `SessionManager`, `checkToken`, `extractToken`, config.
- Produces: `attachWss(server, config, manager)` → attaches a `ws` `WebSocketServer` with `noServer:true` on the given http server's `upgrade`. On connect (path `/ws`): validate token; get/create session (`?session=id` or new); send `scrollback()` first; forward `session 'data' → ws`; `ws message` (string) → `session.write`; JSON `{type:'resize',cols,rows}` → `session.resize`; on `session 'exit'` → close ws.

- [ ] **Step 1: Write failing test (uses `ws` client against `bash`)**

```js
// test/wsApi.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { attachWss } from '../src/wsApi.js';

test('ws relays pty output for a bash session', async () => {
  const config = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]', BRIDGE_TOKEN: 'tok' });
  const manager = new SessionManager(config);
  const server = http.createServer((_q, s) => s.end());
  attachWss(server, config, manager);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const rec = manager.create();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok&session=${rec.id}`);
  let got = '';
  ws.on('message', m => { got += m.toString(); });
  await new Promise(r => ws.on('open', r));
  ws.send('echo relayed-ok\n');
  await new Promise(r => setTimeout(r, 400));
  assert.match(got, /relayed-ok/);
  ws.close(); server.close(); manager.remove(rec.id);
});

test('ws rejects bad token', async () => {
  const config = loadConfig({ BRIDGE_TOKEN: 'tok' });
  const manager = new SessionManager(config);
  const server = http.createServer((_q, s) => s.end());
  attachWss(server, config, manager);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=WRONG`);
  const closed = await new Promise(r => { ws.on('close', c => r(c)); ws.on('error', () => {}); });
  assert.ok(closed);
  server.close();
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `src/wsApi.js`**

```js
import { WebSocketServer } from 'ws';
import { checkToken, extractToken } from './auth.js';

export function attachWss(server, config, manager) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/ws' || !checkToken(extractToken(req), config.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const sid = u.searchParams.get('session');
      const rec = (sid && manager.get(sid)) || manager.create();
      ws.send(rec.session.scrollback());
      const onData = d => { if (ws.readyState === ws.OPEN) ws.send(d); };
      rec.session.on('data', onData);
      const onExit = () => { try { ws.close(); } catch { /* ignore */ } };
      rec.session.on('exit', onExit);
      ws.on('message', raw => {
        const s = raw.toString();
        if (s.startsWith('{')) { try { const m = JSON.parse(s); if (m.type === 'resize') { rec.session.resize(m.cols, m.rows); return; } } catch { /* fallthrough */ } }
        rec.session.write(s);
      });
      ws.on('close', () => { rec.session.off('data', onData); rec.session.off('exit', onExit); });
    });
  });
  return wss;
}
```

- [ ] **Step 4: Run, verify pass; commit.**

```bash
git add -A && git commit -m "feat: websocket api binding browser terminal to a session"
```

---

### Task 10: Browser page, server composition root, start script

**Files:**
- Create: `public/index.html`, `src/server.js`, `bin/start.sh`

**Interfaces:**
- Consumes: everything. Produces a runnable server: `npm start` prints `http://127.0.0.1:7681/?token=…`.

- [ ] **Step 1: Write `public/index.html`** (vendored assets, token from page URL, auto-create session, fit + resize)

```html
<!doctype html><html><head><meta charset="utf-8"><title>Claude bridge</title>
<link rel="stylesheet" href="/vendor/xterm.css?token=__T__">
<style>html,body{margin:0;height:100%;background:#000}#t{height:100vh}</style></head>
<body><div id="t"></div>
<script src="/vendor/xterm.js?token=__T__"></script>
<script src="/vendor/addon-fit.js?token=__T__"></script>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const term = new Terminal({ cursorBlink:true, fontFamily:'monospace', fontSize:14 });
const fit = new (FitAddon.FitAddon || FitAddon)();
term.loadAddon(fit); term.open(document.getElementById('t')); fit.fit();
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
ws.binaryType = 'arraybuffer';
ws.onmessage = e => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
ws.onopen = () => { sendResize(); };
term.onData(d => ws.readyState===1 && ws.send(d));
function sendResize(){ fit.fit(); ws.readyState===1 && ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows})); }
addEventListener('resize', sendResize);
</script></body></html>
```

Note: `__T__` is a marker — the static handler must inject the token into asset URLs so vendored assets pass the token gate. Simpler alternative (implement this): in `httpApi.js`, exempt `/vendor/*` from the token check (they are static, non-sensitive libs) and drop the `?token=__T__` from the HTML. Choose the exemption approach: it is simpler and the assets are public libraries. Update `httpApi.js` `/vendor/` branch to run BEFORE the token check. Keep `/` and `/api/*` and `/ws` gated.

- [ ] **Step 2: Implement `src/server.js`**

```js
import { loadConfig } from './config.js';
import { SessionManager } from './sessionManager.js';
import { createHttpServer } from './httpApi.js';
import { attachWss } from './wsApi.js';

const config = loadConfig();
const manager = new SessionManager(config);
const server = createHttpServer(config, manager);
attachWss(server, config, manager);
server.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}/?token=${encodeURIComponent(config.token)}`;
  console.log(`Interactive Claude bridge listening.`);
  console.log(`Open: ${url}`);
  if (config.tokenGenerated) console.log(`(token was generated; set BRIDGE_TOKEN to pin it)`);
});
```

- [ ] **Step 3: Adjust `httpApi.js` static handling** so `/vendor/*` is served before the token check, and `/` serves `public/index.html` (token-gated). Re-run `test/httpApi.test.js` to confirm no regression (401 test still passes because it hits `/api/sessions`).

- [ ] **Step 4: Write `bin/start.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec node src/server.js
```
Run: `chmod +x bin/start.sh`

- [ ] **Step 5: Run full test suite; commit.**

Run: `npm test` → all green.
```bash
git add -A && git commit -m "feat: browser terminal page, server entrypoint, start script"
```

---

### Task 11: README + full component smoke check

**Files:**
- Create: `README.md`
- Test: `test/component.test.js` (bash-backed end-to-end through HTTP + SSE)

**Interfaces:** none new.

- [ ] **Step 1: Write `test/component.test.js`** — create session, open SSE, POST prompt, assert SSE saw a `state` event and prompt output contains the echo. (Reuse the boot helper pattern from Task 8.)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';

test('end-to-end: prompt over HTTP returns echoed output (bash/generic)', async () => {
  const config = loadConfig({ ADAPTER:'generic', CLAUDE_CMD:'bash', CLAUDE_ARGS:'["-i"]', BRIDGE_TOKEN:'tok', QUIESCENCE_MS:'150' });
  const manager = new SessionManager(config);
  const server = createHttpServer(config, manager);
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const port = server.address().port;
  const A = { headers:{ authorization:'Bearer tok','content-type':'application/json' } };
  const { id } = await (await fetch(`http://127.0.0.1:${port}/api/sessions`,{method:'POST',...A,body:'{}'})).json();
  const r = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/prompt`,{method:'POST',...A,body:JSON.stringify({text:'echo COMPONENT_OK'})});
  const b = await r.json();
  assert.match(b.output,/COMPONENT_OK/);
  assert.equal(b.state,'idle');
  server.close(); manager.remove(id);
});
```

- [ ] **Step 2: Run, verify pass.**

- [ ] **Step 3: Write `README.md`** covering: what it is; the subscription-auth rationale + `ANTHROPIC_API_KEY`-must-be-unset requirement; security (loopback + token, ssh tunnel, token is a high-value secret, operator-scope caveat re Anthropic policy); quick start (`npm install`, `npm start`, open URL); the programmatic API contract (endpoints, request/response JSON) with `curl` examples; the `POST /key` menu-answering flow; adapter/version-pinning note (`claude` 2.1.198) and where to refresh markers; the best-effort-response caveat; the generic-adapter test mode.

- [ ] **Step 4: Final commit.**

```bash
git add -A && git commit -m "docs: README; add end-to-end component test"
```

---

## Post-plan: live verification (orchestrator, not a subagent task)

After all tasks pass and reviews are clean, the orchestrator runs the server with the real `claude` adapter, opens the page (or drives headless), and runs one scripted `POST /api/sessions/:id/prompt {text:"reply with exactly: PONG"}` against a real session, confirming `PONG` in `output` and `state:"idle"`. Keep subscription usage trivial. Record the result in the final report.

## Self-review (against spec)

- Subscription auth (env strip) → Task 4 + verified in Task 4 test. ✓
- Browser xterm.js view → Tasks 9, 10. ✓
- Programmatic API (create/list/get/delete/prompt/key/SSE) → Task 8. ✓
- State detection (busy/idle/awaiting) → Tasks 6,7. ✓
- Best-effort response extraction → Task 5 + `sendPrompt` (Task 8). ✓
- Security (loopback, token timing-safe, vendored assets) → Tasks 1,3,8,10. ✓
- Fragility contained in adapter, fixture-driven, spike-gated → Tasks 2,6. ✓
- Testing without spending subscription (generic + bash) → Tasks 4,8,9,11. ✓
- Live check → Post-plan. ✓
- Types consistent: `record` shape {id,session,terminalModel,detector,adapter,queue,createdAt} used identically in Tasks 8,9. `sendPrompt` return {state,output,prompt,durationMs} matches API contract. `getAdapter`, `keySeq('submit')`, `waitForSettle`, `snapshotLineCount`/`renderLinesSince`/`viewportTail` names consistent across tasks. ✓
