# Cloud-API Facade (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bridge additionally speaks the wire formats of OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages, so unmodified official SDKs pointed at `http://127.0.0.1:7681/v1` can drive subscription-authenticated CLIs, with conversation continuity across stateless requests.

**Architecture:** A new `src/facade/` module mounts three toggleable dialect handlers on the existing HTTP server behind the same token. A `ConversationRouter` maps each request to a live CLI session via explicit pins or history-prefix fingerprints (SHA-256), seeding new sessions from client-held history on miss, with TTL + LRU reaping. Turns execute through a narrow runner seam: `runPtyTurn` (any `mode:'pty'` profile; streams line-granularity deltas via a `StreamRenderer` over the terminal model) and `runHeadlessClaudeTurn` (`claude -p --output-format stream-json`, real token usage, `--resume` continuity).

**Tech Stack:** Node ≥ 20 ESM, `node-pty`, `@xterm/headless`, `node --test`. No new **runtime** dependencies; `openai` and `@anthropic-ai/sdk` are added as **devDependencies** for acceptance tests (Task 13).

**Spec:** `docs/superpowers/specs/2026-07-23-universal-cli-and-api-facade-design.md` — sections "Phase 2 — Cloud-API facade", "Error handling", "Security", "Testing", "Translation rules" are authoritative. **CRITICAL deviation from the spec text (per the Phase 2 handoff): there is NO `gemini` profile — it was pivoted to `antigravity` (command `agy`). Trust `src/config.js`, not the spec's "gemini" wording. `copilot` is fully verified, not a stub. `antigravity` + `copilot` are alt-screen "degraded" (state detection reliable, `extractResponse` best-effort).**

## Global Constraints

- Work on branch `feat/cloud-api-facade` off `master` (already created). Commit after every green task; plain commit messages; **never add Claude/model co-author attribution**.
- Node `>=20` ESM (`"type": "module"`), tests via `node --test` from the repo root (`npm test`). Baseline: 109/109 pass on `master`.
- **`node --test` executes EVERY `.js`/`.mjs` file under `test/`, including subdirectories** (verified on this machine's Node v20.19.2). Executable test helpers (fake REPLs, the claude stream-json stub — it reads stdin and would hang the runner) MUST live in `scripts/helpers/`, never under `test/`. Also never under any directory named `test` at any depth (the glob is `**/test/**`).
- Facade env vars, verbatim (spec): toggles `FACADE_OPENAI_CHAT`, `FACADE_OPENAI_RESPONSES`, `FACADE_ANTHROPIC_MESSAGES` (all default **on**); `FACADE_SESSION_TTL_MS` default `600000`; `FACADE_PINNED_TTL_MS` default `3600000`; `FACADE_MAX_SESSIONS` default `8`; `FACADE_COLS` default `400`.
- `model` = profile name. Every facade error response uses the provider's native error JSON shape so official SDKs raise their native exception types. The bridge token is the API key (`Authorization: Bearer` everywhere; the Anthropic dialect also accepts `x-api-key`).
- Sampling/tooling params (`temperature`, `tools`, `max_tokens`, …) are accepted, ignored, and logged once per parameter name (spec Non-goals).
- Existing endpoints and behavior stay untouched except: `POST /:id/key` uses the session's per-profile quiescence (Phase-1 follow-up), `sendPrompt` gains the settle-timeout `suspect` gate (spec Error handling), and `createHttpServer` gains an optional third `facade` parameter (default `null` — all existing call sites keep working).
- PTY-spawning test suites MUST be run **foreground** (`npm test` or `node --test test/<file>`), never backgrounded — Phase-1 subagents stalled by backgrounding them (handoff §8).
- Live-CLI usage: only Task 14's opt-in script touches real CLIs; everything else runs against bash fake-REPLs and the claude stream-json stub.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/adapters/extract.js` | shared blank-line-preserving transcript cleaner | Create |
| `src/adapters/{claude,codex,antigravity,copilot}.js` | `extractResponse` delegates to the shared cleaner | Modify |
| `src/config.js` | `facade` config block; `args` defensive copy fix | Modify |
| `src/httpApi.js` | `/key` per-profile quiescence; `sendPrompt` suspect gate; facade delegation | Modify |
| `src/server.js` | wire `createFacade` | Modify |
| `src/facade/shared.js` | `FacadeError`, provider error shapes, SSE helpers, `AsyncQueue`, content flattening, usage mappers | Create |
| `src/facade/models.js` | `GET /v1/models` | Create |
| `src/facade/router.js` | `ConversationRouter`: fingerprint/pin routing, seeding, TTL+LRU, `executeTurn` orchestration, dialog-pending retry | Create |
| `src/facade/streamRenderer.js` | incremental clean-text deltas from TerminalModel | Create |
| `src/facade/turnRunner.js` | `runPtyTurn` (the PTY TurnRunner) | Create |
| `src/facade/headlessClaudeRunner.js` | `runHeadlessClaudeTurn` (claude -p stream-json) | Create |
| `src/facade/dialects/openaiChat.js` | `POST /v1/chat/completions` (+SSE) | Create |
| `src/facade/dialects/openaiResponses.js` | `POST /v1/responses` (+SSE) | Create |
| `src/facade/dialects/anthropicMessages.js` | `POST /v1/messages` (+SSE, x-api-key) | Create |
| `src/facade/index.js` | `createFacade(config, manager)`: route table, per-family auth, dispatch | Create |
| `scripts/helpers/fake-repl.sh` | deterministic generic-profile REPL (reply counter, PARA/SPAM/EXIT) | Create |
| `scripts/helpers/fake-dialog-repl.sh` | claude-marker REPL that raises a mid-turn dialog | Create |
| `scripts/helpers/claude-stub.mjs` | fake `claude -p` speaking stream-json (init/deltas/result, --resume chain) | Create |
| `scripts/helpers/sse.mjs` | SSE parsing helper imported by tests | Create |
| `scripts/live-acceptance.mjs` | opt-in manual acceptance against real CLIs | Create |
| `test/adapters.test.js`, `test/config.test.js`, `test/httpApi.test.js` | extended | Modify |
| `test/facadeShared.test.js`, `test/facadeMount.test.js`, `test/facadeRouter.test.js`, `test/streamRenderer.test.js`, `test/turnRunner.test.js`, `test/headlessRunner.test.js`, `test/facadeTurns.test.js`, `test/openaiChat.test.js`, `test/openaiResponses.test.js`, `test/anthropicMessages.test.js`, `test/facadeErrors.test.js`, `test/sdkAcceptance.test.js` | new tests | Create |
| `README.md`, `docs/API.md` | facade docs | Modify |
| spec doc | deviation addendum (gemini→antigravity, copilot verified) | Modify |

## Canonical internal contracts (used by every task — read this first)

- **Normalized message:** `{ role, text }` where `role ∈ 'system'|'user'|'assistant'` (`'developer'` normalizes to `'system'`) and `text` is the flattened string content. Dialects produce these; router consumes them. The trailing message MUST be `role:'user'` (dialects 400 otherwise).
- **Turn outcome (runners → router):** runners emit deltas via an `emit({type:'delta', text})` callback and resolve to either `{ text, usage, claudeSessionId? }` (success) or `{ dialog: { promptText, sinceIndex } }` (PTY only). They throw `FacadeError` on failure. `usage = { input, output, estimated }` (token counts, neutral naming; dialects map to wire names).
- **Events (router → dialects):** `router.executeTurn(...)` returns `{ conv, events }` where `events` is an `AsyncQueue` async-iterable yielding `{type:'delta', text}` then `{type:'done', text, finishReason:'stop', usage}`; failures (including dialogs) surface by the iterator **throwing** a `FacadeError`. The concatenation of delta texts equals `done.text` when no mid-turn repaint occurred (best-effort otherwise; `done.text` is authoritative and is what fingerprint advancement uses).
- **`FacadeError(status, kind, message, bridge?)`** with `kind ∈ 'invalid_request'|'auth'|'not_found'|'model_not_found'|'rate_limit'|'timeout'|'api_error'|'dialog'`; `bridge` is an optional vendor-extension object included in the error body.
- **`record.suspect`** (boolean, on SessionManager records): set when a settle timeout fires mid-turn; while set, the next prompt/turn must `waitForSettle` before typing (then clear it).

---

### Task 1: Blank-line-preserving `extractResponse` + `/key` per-profile quiescence

Phase-1 follow-ups §6.1 and §6.2 (handoff): every adapter's `extractResponse` currently drops ALL blank lines, so multi-paragraph replies become a run-on block — the facade's response fidelity depends on this. `/key` waits on the global `quiescenceMs` instead of the session profile's.

**Files:**
- Create: `src/adapters/extract.js`
- Modify: `src/adapters/claude.js`, `src/adapters/codex.js`, `src/adapters/antigravity.js`, `src/adapters/copilot.js`
- Modify: `src/httpApi.js` (the `/key` handler only)
- Test: `test/adapters.test.js`, `test/httpApi.test.js`

**Interfaces:**
- Consumes: existing adapter `CHROME` regex arrays.
- Produces: `cleanTranscript(lines, { chrome, blockMarker }) → string` — chrome lines dropped, runs of blank lines collapsed to one, leading/trailing blanks trimmed, then `blockMarker` regex stripped. All four real-CLI adapters delegate to it; single-line behavior is unchanged (existing fixture tests must keep passing).

- [ ] **Step 1: Write the failing tests** — append to `test/adapters.test.js`:

```js
// ---- Phase 2 Task 1: blank-line-preserving extractResponse ----

test('claude extractResponse preserves paragraph breaks', () => {
  const a = getAdapter('claude');
  const lines = [
    '> do the thing',
    '',
    '● First paragraph line one',
    '  still first paragraph',
    '',
    '  second paragraph',
    '',
    '',
    '  third paragraph after a double blank',
    '',
    '  ? for shortcuts · ← for agents',
  ];
  const out = a.extractResponse(lines);
  assert.equal(out,
    'First paragraph line one\n  still first paragraph\n\n  second paragraph\n\n  third paragraph after a double blank');
});

test('claude extractResponse: chrome between paragraphs does not add blanks', () => {
  const a = getAdapter('claude');
  const out = a.extractResponse(['para one', '', 'esc to interrupt', '', 'para two']);
  assert.equal(out, 'para one\n\npara two');
});

test('codex extractResponse preserves paragraph breaks and strips block marker', () => {
  const a = getAdapter('codex');
  const out = a.extractResponse(['› ping', '• first', '', 'second', '']);
  assert.equal(out, 'first\n\nsecond');
});

test('antigravity extractResponse preserves paragraph breaks', () => {
  const a = getAdapter('antigravity');
  const out = a.extractResponse(['first', '', 'second', '  ? for shortcuts']);
  assert.equal(out, 'first\n\nsecond');
});

test('copilot extractResponse preserves paragraph breaks', () => {
  const a = getAdapter('copilot');
  const out = a.extractResponse(['● first', '', 'second', '/ commands · ? help · tab next tab']);
  assert.equal(out, 'first\n\nsecond');
});
```

(`test/adapters.test.js` already imports `getAdapter`; if it imports adapters directly, match its existing import style.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/adapters.test.js`
Expected: the five new tests FAIL (current code collapses the blank lines); all pre-existing tests still pass.

- [ ] **Step 3: Implement the shared cleaner** — create `src/adapters/extract.js`:

```js
// src/adapters/extract.js
// Shared transcript cleaner for extractResponse (all real-CLI adapters).
// Phase 1 dropped ALL blank lines, collapsing multi-paragraph replies into a
// run-on block; the facade returns this text to API clients, so paragraph
// structure must survive. Rules: drop chrome lines entirely; collapse runs of
// blank lines to a single blank; trim leading/trailing blanks; finally strip
// the adapter's per-block transcript marker.
export function cleanTranscript(lines, { chrome = [], blockMarker = null } = {}) {
  const kept = lines.filter((l) => !chrome.some((re) => re.test(l)));
  const out = [];
  let pendingBlank = false;
  for (const l of kept) {
    if (l.trim() === '') { pendingBlank = out.length > 0; continue; }
    if (pendingBlank) out.push('');
    pendingBlank = false;
    out.push(l);
  }
  let text = out.join('\n');
  if (blockMarker) text = text.replace(blockMarker, '');
  return text.trim();
}
```

- [ ] **Step 4: Delegate each adapter's `extractResponse`**

In `src/adapters/claude.js` add `import { cleanTranscript } from './extract.js';` and replace the `extractResponse` method body:

```js
  extractResponse(lines) {
    return cleanTranscript(lines, { chrome: CHROME, blockMarker: /^●\s?/gm });
  },
```

Same in `src/adapters/codex.js` with `blockMarker: /^•\s?/gm`; in `src/adapters/antigravity.js` with `cleanTranscript(lines, { chrome: CHROME })` (no marker); in `src/adapters/copilot.js` with `blockMarker: /^\s*●\s?/gm`.

- [ ] **Step 5: Run adapter tests to verify they pass**

Run: `node --test test/adapters.test.js`
Expected: PASS, including all pre-existing fixture-derived extraction tests (single-line results are unaffected by blank handling).

- [ ] **Step 6: Write the failing `/key` quiescence test** — append to `test/httpApi.test.js`:

```js
test('POST /key waits on the session profile quiescence, not the global', async () => {
  // Global 400ms would make /key wait min(800,1000)=800ms; the generic
  // profile override of 50ms must make it wait min(100,1000)=100ms.
  const config = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]',
    BRIDGE_TOKEN: 'tok', QUIESCENCE_MS: '400', PROFILE_GENERIC_QUIESCENCE_MS: '50', PROMPT_TIMEOUT_MS: '8000' });
  const manager = new SessionManager(config);
  const server = createHttpServer(config, manager);
  const port = await new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
  const { id } = await (await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' })).json();
  const t0 = Date.now();
  const k = await fetch(url(port, `/api/sessions/${id}/key`), { method: 'POST', ...auth, body: JSON.stringify({ keys: ['x'] }) });
  assert.equal(k.status, 200);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0}ms — still using the global quiescence`);
  await fetch(url(port, `/api/sessions/${id}`), { method: 'DELETE', ...auth });
  server.close();
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `node --test test/httpApi.test.js`
Expected: the new test FAILS (elapsed ≈ 800ms).

- [ ] **Step 8: Fix the `/key` handler** — in `src/httpApi.js`, replace the wait line inside the `key` route:

```js
          const q = (config.profiles[rec.profile] && config.profiles[rec.profile].quiescenceMs) || config.quiescenceMs;
          await new Promise((r) => setTimeout(r, Math.min(q * 2, 1000)));
```

- [ ] **Step 9: Run the full suite**

Run: `npm test` (foreground; ~60-90s)
Expected: all tests pass (baseline 109 + the 6 new ones).

- [ ] **Step 10: Commit**

```bash
git add src/adapters/ src/httpApi.js test/adapters.test.js test/httpApi.test.js
git commit -m "fix(adapters): preserve paragraph breaks in extractResponse; /key uses per-profile quiescence"
```

---

### Task 2: Facade config block

**Files:**
- Modify: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env).facade` — frozen `{ openaiChat, openaiResponses, anthropicMessages: boolean, sessionTtlMs, pinnedTtlMs, maxSessions, cols: number }`. Toggles default true; falsy values are `0/false/no/off` (case-insensitive). Also fixes the latent `let args = base.args` shared-reference bug (§6.3): always copy.

- [ ] **Step 1: Write the failing tests** — append to `test/config.test.js`:

```js
// ---- Phase 2: facade config ----

test('facade config defaults: all dialects on, documented numbers', () => {
  const c = loadConfig({});
  assert.equal(c.facade.openaiChat, true);
  assert.equal(c.facade.openaiResponses, true);
  assert.equal(c.facade.anthropicMessages, true);
  assert.equal(c.facade.sessionTtlMs, 600000);
  assert.equal(c.facade.pinnedTtlMs, 3600000);
  assert.equal(c.facade.maxSessions, 8);
  assert.equal(c.facade.cols, 400);
});

test('facade toggles: 0/false/off/no disable, anything else stays on', () => {
  const c = loadConfig({ FACADE_OPENAI_CHAT: '0', FACADE_OPENAI_RESPONSES: 'false', FACADE_ANTHROPIC_MESSAGES: 'off' });
  assert.equal(c.facade.openaiChat, false);
  assert.equal(c.facade.openaiResponses, false);
  assert.equal(c.facade.anthropicMessages, false);
  const c2 = loadConfig({ FACADE_OPENAI_CHAT: '1', FACADE_OPENAI_RESPONSES: 'true' });
  assert.equal(c2.facade.openaiChat, true);
  assert.equal(c2.facade.openaiResponses, true);
});

test('facade numeric overrides parse', () => {
  const c = loadConfig({ FACADE_SESSION_TTL_MS: '1000', FACADE_PINNED_TTL_MS: '2000', FACADE_MAX_SESSIONS: '2', FACADE_COLS: '200' });
  assert.equal(c.facade.sessionTtlMs, 1000);
  assert.equal(c.facade.pinnedTtlMs, 2000);
  assert.equal(c.facade.maxSessions, 2);
  assert.equal(c.facade.cols, 200);
});

test('profile args are a fresh array per load, never the shared builtin', () => {
  const a = loadConfig({});
  const b = loadConfig({});
  assert.notEqual(a.profiles.codex.args, b.profiles.codex.args); // distinct frozen copies
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/config.test.js`
Expected: the four new tests FAIL (`c.facade` undefined; args identity equal).

- [ ] **Step 3: Implement** — in `src/config.js`:

Add next to `num`/`jsonArray`:

```js
function flag(v, d) {
  if (v == null || String(v).trim() === '') return d;
  return !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());
}
```

Change `let args = base.args;` to `let args = [...base.args];`.

Add to the returned frozen object (after `defaultProfile`):

```js
    facade: Object.freeze({
      openaiChat: flag(env.FACADE_OPENAI_CHAT, true),
      openaiResponses: flag(env.FACADE_OPENAI_RESPONSES, true),
      anthropicMessages: flag(env.FACADE_ANTHROPIC_MESSAGES, true),
      sessionTtlMs: num(env.FACADE_SESSION_TTL_MS, 600000),
      pinnedTtlMs: num(env.FACADE_PINNED_TTL_MS, 3600000),
      maxSessions: num(env.FACADE_MAX_SESSIONS, 8),
      cols: num(env.FACADE_COLS, 400),
    }),
```

- [ ] **Step 4: Run tests**

Run: `node --test test/config.test.js`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat(config): facade toggles and tuning block; copy builtin profile args defensively"
```

---

### Task 3: Facade core — `shared.js`, mount skeleton, `GET /v1/models`

**Files:**
- Create: `src/facade/shared.js`, `src/facade/models.js`, `src/facade/index.js`
- Modify: `src/httpApi.js` (facade delegation param), `src/server.js`
- Test: `test/facadeShared.test.js`, `test/facadeMount.test.js`

**Interfaces:**
- Consumes: `checkToken`/`extractToken` from `src/auth.js`; `config.facade` (Task 2).
- Produces (used by every later task):
  - `shared.js`: `FacadeError(status, kind, message, bridge?)`; `errorBody(family, err) → object`; `sendError(res, family, err)`; `jsonRes(res, code, obj)`; `readJsonBody(req) → Promise<object>` (throws `FacadeError` 413/400); `class AsyncQueue { push(v), end(), fail(err), [Symbol.asyncIterator] }`; `flattenContent(content, where) → string` (throws 400 on non-text parts); `noteIgnoredParams(body, known, dialect)`; `estTokens(chars) → int`; `now() → unix seconds`; `uuid()`; `sseInit(res)`; `sseFrame(obj) → string`; `sseEventFrame(event, obj) → string`; `writeIfOpen(res, str)`; `collectDone(events) → Promise<doneEvent>`; `usageOpenaiChat(u)`, `usageResponses(u)`, `usageAnthropic(u)`.
  - `models.js`: `makeModelsHandler(ctx) → async (req, res, u)` — `ctx = {config, manager, router}`.
  - `index.js`: `createFacade(config, manager) → { router: null /* until Task 4 wires it */, canHandle(method, pathname) → bool, handle(req, res, u) → Promise, close() }`. Dialect routes are registered in Tasks 9–11; this task registers only `GET /v1/models` (when at least one OpenAI-family dialect is enabled).
  - `createHttpServer(config, manager, facade = null)` — facade routes are matched **before** the bridge token check (the facade does its own per-family auth so 401s are provider-shaped).
- Family is `'openai'` or `'anthropic'`; error JSON shapes:
  - openai: `{"error": {"message", "type", "param", "code"}}` (+ optional top-level `"bridge"`).
  - anthropic: `{"type":"error","error":{"type","message"}}` (+ optional top-level `"bridge"`).
  - kind→(status-independent) mapping — openai `type`/`code`: `invalid_request`→`invalid_request_error`/`null`; `auth`→`invalid_request_error`/`invalid_api_key`; `not_found`→`invalid_request_error`/`null`; `model_not_found`→`invalid_request_error`/`model_not_found`; `rate_limit`→`rate_limit_error`/`rate_limit_exceeded`; `timeout`→`api_error`/`bridge_settle_timeout`; `api_error`→`api_error`/`null`; `dialog`→`invalid_request_error`/`bridge_dialog_pending`. anthropic `type`: `auth`→`authentication_error`; `not_found`|`model_not_found`→`not_found_error`; `rate_limit`→`overloaded_error` (spec: at-cap 429); `timeout`|`api_error`→`api_error`; `invalid_request`|`dialog`→`invalid_request_error`.

- [ ] **Step 1: Write failing unit tests** — create `test/facadeShared.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacadeError, errorBody, AsyncQueue, flattenContent, estTokens, usageOpenaiChat, usageResponses, usageAnthropic } from '../src/facade/shared.js';

test('errorBody: openai shape', () => {
  const e = new FacadeError(404, 'model_not_found', 'nope');
  assert.deepEqual(errorBody('openai', e), {
    error: { message: 'nope', type: 'invalid_request_error', param: null, code: 'model_not_found' },
  });
});

test('errorBody: anthropic shape with bridge vendor field', () => {
  const e = new FacadeError(409, 'dialog', 'answer the dialog', { conversation_id: 'c1', session_id: 's1', dialog: 'Trust?' });
  assert.deepEqual(errorBody('anthropic', e), {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'answer the dialog' },
    bridge: { conversation_id: 'c1', session_id: 's1', dialog: 'Trust?' },
  });
});

test('errorBody: auth maps per family', () => {
  const e = new FacadeError(401, 'auth', 'bad key');
  assert.equal(errorBody('openai', e).error.code, 'invalid_api_key');
  assert.equal(errorBody('anthropic', e).error.type, 'authentication_error');
});

test('AsyncQueue: yields pushed values then ends', async () => {
  const q = new AsyncQueue();
  q.push(1); q.push(2);
  setTimeout(() => { q.push(3); q.end(); }, 10);
  const got = [];
  for await (const v of q) got.push(v);
  assert.deepEqual(got, [1, 2, 3]);
});

test('AsyncQueue: fail() drains buffered values first, then throws', async () => {
  const q = new AsyncQueue();
  q.push('a');
  q.fail(new Error('boom'));
  const got = [];
  await assert.rejects(async () => { for await (const v of q) got.push(v); }, /boom/);
  assert.deepEqual(got, ['a']);
});

test('AsyncQueue: push after end/fail is ignored', async () => {
  const q = new AsyncQueue();
  q.end(); q.push('late');
  const got = [];
  for await (const v of q) got.push(v);
  assert.deepEqual(got, []);
});

test('flattenContent: string, text parts, input_text parts', () => {
  assert.equal(flattenContent('hi', 'x'), 'hi');
  assert.equal(flattenContent([{ type: 'text', text: 'a' }, { type: 'input_text', text: 'b' }], 'x'), 'ab');
  assert.equal(flattenContent(null, 'x'), '');
});

test('flattenContent: non-text part throws provider-shaped 400', () => {
  assert.throws(() => flattenContent([{ type: 'image_url', image_url: { url: 'http://x' } }], 'messages[0].content'),
    (e) => e instanceof FacadeError && e.status === 400 && /messages\[0\]\.content\[0\]/.test(e.message));
});

test('usage mappers', () => {
  const u = { input: 10, output: 5, estimated: true };
  assert.deepEqual(usageOpenaiChat(u), { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.deepEqual(usageAnthropic(u), { input_tokens: 10, output_tokens: 5 });
  assert.equal(usageResponses(u).total_tokens, 15);
  assert.equal(estTokens(9), 3);
  assert.equal(estTokens(0), 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/facadeShared.test.js`
Expected: FAIL — cannot find module `../src/facade/shared.js`.

- [ ] **Step 3: Implement `src/facade/shared.js`**

```js
// src/facade/shared.js
// Cross-dialect plumbing for the cloud-API facade: provider-shaped errors,
// SSE helpers, body reading, the events channel, content flattening, and
// usage mapping. Family is 'openai' or 'anthropic' — every error we send is
// shaped so the official SDK raises its native exception type.
import crypto from 'node:crypto';

export class FacadeError extends Error {
  constructor(status, kind, message, bridge = undefined) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.bridge = bridge;
  }
}

const OPENAI_KIND = {
  invalid_request: { type: 'invalid_request_error', code: null },
  auth: { type: 'invalid_request_error', code: 'invalid_api_key' },
  not_found: { type: 'invalid_request_error', code: null },
  model_not_found: { type: 'invalid_request_error', code: 'model_not_found' },
  rate_limit: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
  timeout: { type: 'api_error', code: 'bridge_settle_timeout' },
  api_error: { type: 'api_error', code: null },
  dialog: { type: 'invalid_request_error', code: 'bridge_dialog_pending' },
};
const ANTHROPIC_KIND = {
  invalid_request: 'invalid_request_error',
  auth: 'authentication_error',
  not_found: 'not_found_error',
  model_not_found: 'not_found_error',
  rate_limit: 'overloaded_error',
  timeout: 'api_error',
  api_error: 'api_error',
  dialog: 'invalid_request_error',
};

export function errorBody(family, err) {
  const bridge = err.bridge ? { bridge: err.bridge } : {};
  if (family === 'anthropic') {
    return { type: 'error', error: { type: ANTHROPIC_KIND[err.kind] || 'api_error', message: err.message }, ...bridge };
  }
  const m = OPENAI_KIND[err.kind] || OPENAI_KIND.api_error;
  return { error: { message: err.message, type: m.type, param: err.param ?? null, code: m.code }, ...bridge };
}

export function jsonRes(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(b);
}

export function sendError(res, family, err) {
  const e = err instanceof FacadeError ? err : new FacadeError(500, 'api_error', String((err && err.message) || err));
  jsonRes(res, e.status, errorBody(family, e));
}

// Facade requests carry whole conversation histories — allow more than the
// bridge API's 1 MiB.
const MAX_BODY = 8 * 1024 * 1024;

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    let len = 0;
    let over = false;
    req.on('data', (c) => {
      len += c.length;
      if (len > MAX_BODY) { over = true; d = ''; return; }
      if (!over) d += c;
    });
    req.on('end', () => {
      if (over) return reject(new FacadeError(413, 'invalid_request', 'request body too large'));
      try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new FacadeError(400, 'invalid_request', 'request body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

// Async push-queue: the router's turn loop produces events; the dialect
// consumes them with for-await. fail() surfaces as a throw from the iterator
// AFTER buffered values drain. push/end/fail after completion are no-ops.
export class AsyncQueue {
  constructor() {
    this._values = [];
    this._resolvers = [];
    this._ended = false;
    this._error = null;
  }
  _settle(result) { const r = this._resolvers.shift(); if (r) { r(result); return true; } return false; }
  push(value) { if (this._ended) return; if (!this._settle({ value })) this._values.push({ value }); }
  end() { if (this._ended) return; this._ended = true; while (this._resolvers.length) this._settle({ end: true }); }
  fail(error) { if (this._ended) return; this._ended = true; this._error = error; while (this._resolvers.length) this._settle({ error }); }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      let item;
      if (this._values.length) item = this._values.shift();
      else if (this._error) item = { error: this._error };
      else if (this._ended) item = { end: true };
      else item = await new Promise((res) => this._resolvers.push(res));
      if (item.error) throw item.error;
      if (item.end) return;
      yield item.value;
    }
  }
}

// Message content may be a string or the array-of-parts form; text parts are
// concatenated, non-text parts rejected provider-shaped (spec Translation).
const TEXT_PART_TYPES = ['text', 'input_text', 'output_text'];
export function flattenContent(content, where) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.map((p, i) => {
      if (p && TEXT_PART_TYPES.includes(p.type) && typeof p.text === 'string') return p.text;
      throw new FacadeError(400, 'invalid_request', `${where}[${i}]: only text content parts are supported by the bridge`);
    }).join('');
  }
  throw new FacadeError(400, 'invalid_request', `${where} must be a string or an array of text parts`);
}

// Non-goal params are accepted, ignored, and logged once per name (spec).
const ignoredLogged = new Set();
export function noteIgnoredParams(body, known, dialect) {
  for (const k of Object.keys(body)) {
    if (known.includes(k)) continue;
    const tag = `${dialect}.${k}`;
    if (ignoredLogged.has(tag)) continue;
    ignoredLogged.add(tag);
    console.warn(`facade: parameter "${k}" (${dialect}) is accepted but ignored by the bridge`);
  }
}

export const estTokens = (chars) => Math.max(1, Math.ceil(chars / 4));
export const now = () => Math.floor(Date.now() / 1000);
export const uuid = () => crypto.randomUUID();

export function sseInit(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
}
export const sseFrame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
export const sseEventFrame = (event, obj) => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
export function writeIfOpen(res, s) {
  if (res.writableEnded || res.destroyed) return;
  try { res.write(s); } catch { /* client gone mid-write */ }
}

export async function collectDone(events) {
  let done = null;
  for await (const ev of events) if (ev.type === 'done') done = ev;
  if (!done) throw new FacadeError(500, 'api_error', 'turn ended without a result');
  return done;
}

export const usageOpenaiChat = (u) => ({ prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output });
export const usageResponses = (u) => ({
  input_tokens: u.input, input_tokens_details: { cached_tokens: 0 },
  output_tokens: u.output, output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: u.input + u.output,
});
export const usageAnthropic = (u) => ({ input_tokens: u.input, output_tokens: u.output });
```

- [ ] **Step 4: Run unit tests**

Run: `node --test test/facadeShared.test.js`
Expected: PASS.

- [ ] **Step 5: Write failing mount tests** — create `test/facadeMount.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';
import { createFacade } from '../src/facade/index.js';

function boot(extraEnv = {}) {
  const config = loadConfig({ BRIDGE_TOKEN: 'tok', PROFILE_GENERIC_COMMAND: 'bash', ...extraEnv });
  const manager = new SessionManager(config);
  const facade = createFacade(config, manager);
  const server = createHttpServer(config, manager, facade);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    config, manager, facade, server, port: server.address().port,
    close() { facade.close(); for (const r of manager.list()) manager.remove(r.id); server.close(); },
  })));
}
const url = (port, path) => `http://127.0.0.1:${port}${path}`;

test('GET /v1/models: 401 without token is OpenAI-shaped', async () => {
  const b = await boot();
  const r = await fetch(url(b.port, '/v1/models'));
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.error.code, 'invalid_api_key');
  assert.equal(body.error.type, 'invalid_request_error');
  b.close();
});

test('GET /v1/models lists facade-usable profiles (command resolves), incl. claude-headless', async () => {
  const b = await boot();
  const r = await fetch(url(b.port, '/v1/models'), { headers: { authorization: 'Bearer tok' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, 'list');
  const ids = body.data.map((m) => m.id).sort();
  // all built-ins have commands here (generic got one via PROFILE_GENERIC_COMMAND)
  assert.deepEqual(ids, ['antigravity', 'claude', 'claude-headless', 'codex', 'copilot', 'generic']);
  for (const m of body.data) { assert.equal(m.object, 'model'); assert.equal(m.owned_by, 'bridge'); assert.ok(m.created > 0); }
  b.close();
});

test('command-less generic is absent from /v1/models', async () => {
  const b = await boot({ PROFILE_GENERIC_COMMAND: '' });
  const r = await fetch(url(b.port, '/v1/models'), { headers: { authorization: 'Bearer tok' } });
  const ids = (await r.json()).data.map((m) => m.id);
  assert.ok(!ids.includes('generic'), `generic should be hidden, got ${ids}`);
  b.close();
});

test('models endpoint 404s when both OpenAI-family dialects are disabled', async () => {
  const b = await boot({ FACADE_OPENAI_CHAT: '0', FACADE_OPENAI_RESPONSES: '0' });
  const r = await fetch(url(b.port, '/v1/models'), { headers: { authorization: 'Bearer tok' } });
  assert.equal(r.status, 404); // falls through to the bridge 404
  b.close();
});

test('facade routes do not shadow the bridge API', async () => {
  const b = await boot();
  const r = await fetch(url(b.port, '/api/sessions'), { headers: { authorization: 'Bearer tok' } });
  assert.equal(r.status, 200);
  b.close();
});
```

Note: `PROFILE_GENERIC_COMMAND: ''` — confirm `loadConfig` treats empty string as unset (`P('COMMAND') != null` is true for `''`… it sets command to `''` which is falsy → hidden from models; either way the assertion holds). If boot throws because `DEFAULT_PROFILE` needs a command, pass `DEFAULT_PROFILE: 'claude'` in that test's `extraEnv`.

- [ ] **Step 6: Run to verify failure**

Run: `node --test test/facadeMount.test.js`
Expected: FAIL — no `src/facade/index.js`.

- [ ] **Step 7: Implement `src/facade/models.js`**

```js
// src/facade/models.js
// GET /v1/models — shared by the OpenAI-family dialects (mounted when at
// least one is enabled). model id = profile name; only facade-usable
// profiles are listed: enabled (BRIDGE_PROFILES already filtered them into
// config.profiles) AND command resolves. claude-headless IS facade-usable.
import { jsonRes, now } from './shared.js';

export function makeModelsHandler(ctx) {
  return async (req, res) => {
    const created = now();
    const data = Object.values(ctx.config.profiles)
      .filter((p) => p.command)
      .map((p) => ({ id: p.name, object: 'model', created, owned_by: 'bridge' }));
    jsonRes(res, 200, { object: 'list', data });
  };
}
```

- [ ] **Step 8: Implement `src/facade/index.js`**

```js
// src/facade/index.js
// Facade mount: builds the route table from the enabled dialect toggles and
// performs per-family auth (Bearer everywhere; the Anthropic dialect also
// accepts x-api-key) so even 401s are provider-shaped. Routes are matched by
// httpApi BEFORE its own token gate; a disabled dialect's route is simply not
// registered, so it falls through to the bridge's plain 404.
import { checkToken, extractToken } from '../auth.js';
import { FacadeError, sendError } from './shared.js';
import { makeModelsHandler } from './models.js';

export function createFacade(config, manager) {
  const router = null; // ConversationRouter lands in Task 4; dialects in Tasks 9-11
  const ctx = { config, manager, router };
  const routes = new Map(); // 'METHOD /path' → { family, handler }

  if (config.facade.openaiChat || config.facade.openaiResponses) {
    routes.set('GET /v1/models', { family: 'openai', handler: makeModelsHandler(ctx) });
  }

  return {
    router,
    canHandle(method, pathname) { return routes.has(`${method} ${pathname}`); },
    async handle(req, res, u) {
      const { family, handler } = routes.get(`${req.method} ${u.pathname}`);
      let token = extractToken(req);
      if (token == null && family === 'anthropic' && typeof req.headers['x-api-key'] === 'string') {
        token = req.headers['x-api-key'];
      }
      if (!checkToken(token, config.token)) {
        return sendError(res, family, new FacadeError(401, 'auth',
          family === 'anthropic' ? 'invalid x-api-key' : 'Incorrect API key provided'));
      }
      try {
        await handler(req, res, u);
      } catch (e) {
        if (!res.headersSent) sendError(res, family, e);
        else res.end();
      }
    },
    close() { if (router) router.close(); },
  };
}
```

- [ ] **Step 9: Wire delegation** — in `src/httpApi.js` change the signature and add dispatch after the `/vendor/` block, BEFORE the bridge token check:

```js
export function createHttpServer(config, manager, facade = null) {
```

```js
      // Cloud-API facade routes authenticate per provider family themselves
      // (provider-shaped 401s, x-api-key support) — match them before the
      // bridge token gate.
      if (facade && facade.canHandle(req.method, u.pathname)) return facade.handle(req, res, u);
```

In `src/server.js`:

```js
import { loadConfig } from './config.js';
import { SessionManager } from './sessionManager.js';
import { createHttpServer } from './httpApi.js';
import { attachWss } from './wsApi.js';
import { createFacade } from './facade/index.js';

const config = loadConfig();
const manager = new SessionManager(config);
const facade = createFacade(config, manager);
const server = createHttpServer(config, manager, facade);
attachWss(server, config, manager);
server.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}/?token=${encodeURIComponent(config.token)}`;
  const dialects = [
    config.facade.openaiChat && 'openai-chat',
    config.facade.openaiResponses && 'openai-responses',
    config.facade.anthropicMessages && 'anthropic-messages',
  ].filter(Boolean).join(', ') || 'none';
  console.log(`Interactive Claude bridge listening.`);
  console.log(`Open: ${url}`);
  console.log(`Facade dialects: ${dialects}`);
  if (config.tokenGenerated) console.log(`(token was generated; set BRIDGE_TOKEN to pin it)`);
});
```

- [ ] **Step 10: Run mount tests, then the full suite**

Run: `node --test test/facadeMount.test.js` → PASS.
Run: `npm test` (foreground) → all pass.

- [ ] **Step 11: Commit**

```bash
git add src/facade/ src/httpApi.js src/server.js test/facadeShared.test.js test/facadeMount.test.js
git commit -m "feat(facade): mount skeleton with per-family auth, provider error shapes, GET /v1/models"
```

---

### Task 4: ConversationRouter core (routing, fingerprints, seeding, TTL+LRU)

The hybrid router WITHOUT turn execution (that's Task 8). Everything here is unit-testable with a fake manager — no PTYs.

**Files:**
- Create: `src/facade/router.js`
- Modify: `src/facade/index.js` (construct the real router)
- Test: `test/facadeRouter.test.js`

**Interfaces:**
- Consumes: `config.facade` (Task 2), `config.profiles`, `manager.create/remove`, `PromptQueue`, `FacadeError`.
- Produces: `class ConversationRouter`:
  - `constructor({ config, manager })` — starts an unref'd 30s reap interval.
  - `acquire({ profileName, pinId, respConv, messages }) → { conv, fpKey, userText, seedText }` — `messages` = normalized `[{role,text}]`, trailing user. Throws `FacadeError` (`model_not_found` handled by caller in `executeTurn`; here: pin-profile-mismatch 400, capacity 429, spawn 500).
  - `completeTurn(conv, messages, assistantText)` — advances the fingerprint to `history+user+assistant`, clears `pending`/`needsSeed`.
  - `registerResponse(conv) → 'resp_<uuid>'`; `resolveResponseId(id) → conv|undefined`.
  - `reap(nowMs)`; `stats() → { conversations }`; `close()` (clears timer, destroys all conversations, kills their PTYs).
  - Internal conversation shape: `{ id, profileName, profile, mode, record, queue, claudeSessionId, fpKey, pinned, lastUsed, busy, respIds:Set, pending, needsSeed }`.
- Fingerprint: `profileName + '\n' + sha256hex(JSON.stringify([profileName, messages.map(m => [m.role, m.text])]))` — profile-scoped so identical histories on different models never collide.
- Seed preamble (exact format, used by tests):

```
Prior conversation context, replayed for continuity. Do not respond to it;
respond only to the message after the END CONTEXT line.
--- BEGIN CONTEXT ---
[role] text
...
--- END CONTEXT ---
```

- [ ] **Step 1: Write failing tests** — create `test/facadeRouter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { ConversationRouter } from '../src/facade/router.js';
import { PromptQueue } from '../src/promptQueue.js';

function fakeManager() {
  const records = new Map();
  let n = 0;
  return {
    created: [],
    create({ profile, cols }) {
      const id = `s${++n}`;
      const rec = { id, profile, cols, queue: new PromptQueue(), createdAt: Date.now(),
        session: { alive: true, kill() { this.alive = false; } }, detector: { state: 'idle' } };
      records.set(id, rec);
      this.created.push(rec);
      return rec;
    },
    get(id) { return records.get(id); },
    remove(id) { const r = records.get(id); if (r) { r.session.kill(); records.delete(id); } return !!r; },
    list() { return [...records.values()]; },
  };
}

function makeRouter(env = {}) {
  const config = loadConfig({ BRIDGE_TOKEN: 'tok', PROFILE_GENERIC_COMMAND: 'bash', ...env });
  const manager = fakeManager();
  const router = new ConversationRouter({ config, manager });
  return { config, manager, router };
}

const msgs = (...pairs) => pairs.map(([role, text]) => ({ role, text }));

test('fingerprint miss creates a session at facade cols; hit reuses it', () => {
  const { config, manager, router } = makeRouter();
  const m1 = msgs(['user', 'hello']);
  const a1 = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: m1 });
  assert.equal(manager.created.length, 1);
  assert.equal(manager.created[0].cols, config.facade.cols);
  assert.equal(a1.seedText, ''); // no history to seed
  assert.equal(a1.userText, 'hello');
  router.completeTurn(a1.conv, m1, 'REPLY');
  const m2 = msgs(['user', 'hello'], ['assistant', 'REPLY'], ['user', 'again']);
  const a2 = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: m2 });
  assert.equal(a2.conv, a1.conv);
  assert.equal(manager.created.length, 1);
  assert.equal(a2.seedText, '');
  router.close();
});

test('edited history misses and seeds a fresh session with the exact preamble', () => {
  const { manager, router } = makeRouter();
  const m1 = msgs(['user', 'hello']);
  const a1 = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: m1 });
  router.completeTurn(a1.conv, m1, 'REPLY');
  const edited = msgs(['system', 'S'], ['user', 'hello'], ['assistant', 'EDITED'], ['user', 'again']);
  const a2 = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: edited });
  assert.notEqual(a2.conv, a1.conv);
  assert.equal(manager.created.length, 2);
  assert.equal(a2.seedText, [
    'Prior conversation context, replayed for continuity. Do not respond to it;',
    'respond only to the message after the END CONTEXT line.',
    '--- BEGIN CONTEXT ---',
    '[system] S',
    '[user] hello',
    '[assistant] EDITED',
    '--- END CONTEXT ---',
  ].join('\n'));
  router.close();
});

test('same history on different profiles never collides', () => {
  const { manager, router } = makeRouter();
  const m = msgs(['user', 'x']);
  const a = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: m });
  router.completeTurn(a.conv, m, 'R');
  const m2 = msgs(['user', 'x'], ['assistant', 'R'], ['user', 'y']);
  const b = router.acquire({ profileName: 'claude', pinId: null, respConv: null, messages: m2 });
  assert.notEqual(b.conv, a.conv);
  assert.equal(manager.created.length, 2);
  router.close();
});

test('explicit pin: unknown id seeds, known id forwards trailing only, profile mismatch 400', () => {
  const { router } = makeRouter();
  const hist = msgs(['user', 'a'], ['assistant', 'b'], ['user', 'c']);
  const a1 = router.acquire({ profileName: 'generic', pinId: 'my-conv', respConv: null, messages: hist });
  assert.equal(a1.conv.id, 'my-conv');
  assert.match(a1.seedText, /BEGIN CONTEXT/);
  // known live pin: history ignored, no seed
  const a2 = router.acquire({ profileName: 'generic', pinId: 'my-conv', respConv: null, messages: msgs(['user', 'unrelated']) });
  assert.equal(a2.conv, a1.conv);
  assert.equal(a2.seedText, '');
  assert.throws(() => router.acquire({ profileName: 'claude', pinId: 'my-conv', respConv: null, messages: msgs(['user', 'x']) }),
    (e) => e.status === 400 && /bound to model/.test(e.message));
  router.close();
});

test('LRU cap: evicts least-recently-used idle conversation; all-busy → 429', () => {
  const { manager, router } = makeRouter({ FACADE_MAX_SESSIONS: '2' });
  const a = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'a']) });
  const b = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'b']) });
  a.conv.lastUsed = Date.now() - 5000; // a is LRU
  const c = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'c']) });
  assert.equal(router.stats().conversations, 2);
  assert.equal(manager.get(a.conv.record.id), undefined, 'LRU idle session was killed');
  b.conv.busy = 1; c.conv.busy = 1;
  assert.throws(() => router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'd']) }),
    (e) => e.status === 429 && e.kind === 'rate_limit');
  router.close();
});

test('TTL reap: default TTL for unpinned, longer for pinned, busy conversations survive', () => {
  const { manager, router } = makeRouter({ FACADE_SESSION_TTL_MS: '1000', FACADE_PINNED_TTL_MS: '5000' });
  const plain = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'a']) });
  const pinned = router.acquire({ profileName: 'generic', pinId: 'keep', respConv: null, messages: msgs(['user', 'b']) });
  const busy = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'c']) });
  busy.conv.busy = 1;
  router.reap(Date.now() + 2000);
  assert.equal(manager.get(plain.conv.record.id), undefined, 'unpinned reaped at session TTL');
  assert.ok(manager.get(pinned.conv.record.id), 'pinned survives session TTL');
  assert.ok(manager.get(busy.conv.record.id), 'busy survives');
  router.reap(Date.now() + 6000);
  assert.equal(manager.get(pinned.conv.record.id), undefined, 'pinned reaped at pinned TTL');
  // reaped pin recovers by reseeding on next request
  const again = router.acquire({ profileName: 'generic', pinId: 'keep', respConv: null, messages: msgs(['user', 'x'], ['assistant', 'y'], ['user', 'z']) });
  assert.match(again.seedText, /BEGIN CONTEXT/);
  router.close();
});

test('response-id registry: register, resolve, dropped on destroy', () => {
  const { router } = makeRouter();
  const a = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'a']) });
  const rid = router.registerResponse(a.conv);
  assert.match(rid, /^resp_/);
  assert.equal(router.resolveResponseId(rid), a.conv);
  router.reap(Date.now() + 10 * 60 * 1000 + 1);
  assert.equal(router.resolveResponseId(rid), undefined);
  router.close();
});

test('headless profile conversations get their own queue and no PTY record', () => {
  const { manager, router } = makeRouter();
  const a = router.acquire({ profileName: 'claude-headless', pinId: null, respConv: null, messages: msgs(['user', 'a']) });
  assert.equal(a.conv.mode, 'headless');
  assert.equal(a.conv.record, null);
  assert.ok(a.conv.queue);
  assert.equal(manager.created.length, 0);
  router.close();
});

test('needsSeed: a failed headless turn forces reseeding on the next hit', () => {
  const { router } = makeRouter();
  const m1 = msgs(['user', 'hello']);
  const a1 = router.acquire({ profileName: 'claude-headless', pinId: null, respConv: null, messages: m1 });
  router.completeTurn(a1.conv, m1, 'REPLY');
  a1.conv.claudeSessionId = null; // simulate what _failTurn does…
  a1.conv.needsSeed = true;
  const m2 = msgs(['user', 'hello'], ['assistant', 'REPLY'], ['user', 'again']);
  const a2 = router.acquire({ profileName: 'claude-headless', pinId: null, respConv: null, messages: m2 });
  assert.equal(a2.conv, a1.conv);
  assert.match(a2.seedText, /BEGIN CONTEXT/, 'hit still reseeds when needsSeed is set');
  router.completeTurn(a2.conv, m2, 'R2');
  assert.equal(a2.conv.needsSeed, false);
  router.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/facadeRouter.test.js`
Expected: FAIL — no `src/facade/router.js`.

- [ ] **Step 3: Implement `src/facade/router.js`** (Task 8 adds `executeTurn` to this class; keep the file open for it):

```js
// src/facade/router.js
// ConversationRouter: request → conversation → session (spec "Conversation
// routing (the hybrid)"). Explicit pins (model suffix / header / response id)
// when the client provides them; history-prefix fingerprint stickiness as the
// default; seed a fresh session from client-held history on miss; TTL + LRU
// lifecycle. Turn execution (executeTurn) is layered on top in turnRunner /
// headlessClaudeRunner via Task 8.
import crypto from 'node:crypto';
import { PromptQueue } from '../promptQueue.js';
import { FacadeError, estTokens } from './shared.js';

const REAP_EVERY_MS = 30000;

export class ConversationRouter {
  constructor({ config, manager }) {
    this._config = config;
    this._manager = manager;
    this._convs = new Map();   // conv.id → conv
    this._byFp = new Map();    // fingerprint key → conv
    this._pins = new Map();    // explicit pin id → conv
    this._byResp = new Map();  // resp_<uuid> → conv
    this._reapTimer = setInterval(() => this.reap(Date.now()), REAP_EVERY_MS);
    if (this._reapTimer.unref) this._reapTimer.unref();
  }

  _fp(profileName, messages) {
    const h = crypto.createHash('sha256');
    h.update(JSON.stringify([profileName, messages.map((m) => [m.role, m.text])]));
    return `${profileName}\n${h.digest('hex')}`;
  }

  _buildSeed(history) {
    if (!history.length) return '';
    return [
      'Prior conversation context, replayed for continuity. Do not respond to it;',
      'respond only to the message after the END CONTEXT line.',
      '--- BEGIN CONTEXT ---',
      ...history.map((m) => `[${m.role}] ${m.text}`),
      '--- END CONTEXT ---',
    ].join('\n');
  }

  _ensureCapacity() {
    const pty = [...this._convs.values()].filter((c) => c.mode === 'pty');
    if (pty.length < this._config.facade.maxSessions) return;
    const idle = pty.filter((c) => c.busy === 0).sort((a, b) => a.lastUsed - b.lastUsed);
    if (!idle.length) throw new FacadeError(429, 'rate_limit', 'all bridge sessions are mid-turn; retry shortly');
    this._destroy(idle[0]);
  }

  _create({ profileName, id = null, pinned = false }) {
    const profile = this._config.profiles[profileName];
    if (profile.mode === 'pty') this._ensureCapacity();
    const conv = {
      id: id ?? crypto.randomUUID(), profileName, profile, mode: profile.mode,
      record: null, queue: null, claudeSessionId: null, fpKey: null,
      pinned, lastUsed: Date.now(), busy: 0, respIds: new Set(), pending: null, needsSeed: false,
    };
    if (profile.mode === 'pty') {
      try {
        conv.record = this._manager.create({ profile: profileName, cols: this._config.facade.cols });
      } catch (e) {
        throw new FacadeError(500, 'api_error', `failed to start a "${profileName}" session: ${e.message}`,
          { spawn_error: String(e.message || e) });
      }
      conv.queue = conv.record.queue;
    } else {
      conv.queue = new PromptQueue();
    }
    this._convs.set(conv.id, conv);
    return conv;
  }

  _destroy(conv) {
    if (conv.record) this._manager.remove(conv.record.id);
    this._convs.delete(conv.id);
    if (conv.pinned) this._pins.delete(conv.id);
    if (conv.fpKey && this._byFp.get(conv.fpKey) === conv) this._byFp.delete(conv.fpKey);
    for (const rid of conv.respIds) this._byResp.delete(rid);
  }

  // messages: normalized [{role, text}], trailing role 'user' (dialect-validated).
  acquire({ profileName, pinId, respConv, messages }) {
    const history = messages.slice(0, -1);
    const userText = messages[messages.length - 1].text;
    const fpKey = this._fp(profileName, history);
    let conv = null;
    let created = false;
    if (respConv) {
      conv = respConv;
    } else if (pinId != null) {
      conv = this._pins.get(pinId) || null;
      if (conv && conv.profileName !== profileName) {
        throw new FacadeError(400, 'invalid_request',
          `conversation "${pinId}" is bound to model "${conv.profileName}", not "${profileName}"`);
      }
      if (!conv) {
        conv = this._create({ profileName, id: pinId, pinned: true });
        created = true;
        this._pins.set(pinId, conv);
      }
    } else {
      conv = this._byFp.get(fpKey) || null;
      if (!conv) { conv = this._create({ profileName }); created = true; }
    }
    if (created) { conv.fpKey = fpKey; this._byFp.set(fpKey, conv); }
    const seedText = (created || conv.needsSeed) ? this._buildSeed(history) : '';
    return { conv, fpKey, userText, seedText };
  }

  // Store the next expected fingerprint: received history + user message +
  // the exact assistant text returned (spec) — turn N+1 then hits.
  completeTurn(conv, messages, assistantText) {
    const next = [...messages, { role: 'assistant', text: assistantText }];
    const key = this._fp(conv.profileName, next);
    if (conv.fpKey && this._byFp.get(conv.fpKey) === conv) this._byFp.delete(conv.fpKey);
    conv.fpKey = key;
    this._byFp.set(key, conv);
    conv.pending = null;
    conv.needsSeed = false;
    conv.lastUsed = Date.now();
  }

  registerResponse(conv) {
    const id = `resp_${crypto.randomUUID()}`;
    this._byResp.set(id, conv);
    conv.respIds.add(id);
    return id;
  }

  resolveResponseId(id) { return this._byResp.get(id); }

  reap(nowMs) {
    for (const conv of [...this._convs.values()]) {
      const ttl = conv.pinned ? this._config.facade.pinnedTtlMs : this._config.facade.sessionTtlMs;
      if (conv.busy === 0 && nowMs - conv.lastUsed > ttl) this._destroy(conv);
    }
  }

  stats() { return { conversations: this._convs.size }; }

  close() {
    clearInterval(this._reapTimer);
    for (const conv of [...this._convs.values()]) this._destroy(conv);
  }
}
```

- [ ] **Step 4: Wire the real router into `src/facade/index.js`** — replace `const router = null; // …` with:

```js
  const router = new ConversationRouter({ config, manager });
```

adding `import { ConversationRouter } from './router.js';`, and in `close()` drop the `if (router)` guard: `close() { router.close(); }`.

- [ ] **Step 5: Run tests**

Run: `node --test test/facadeRouter.test.js test/facadeMount.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/facade/router.js src/facade/index.js test/facadeRouter.test.js
git commit -m "feat(facade): ConversationRouter — hybrid pin/fingerprint routing, seeding, TTL+LRU lifecycle"
```

---

### Task 5: StreamRenderer

Incremental clean-text deltas from the TerminalModel: on each tick, re-render the transcript delta since the turn started, clean it through `adapter.extractResponse`, and emit newly-**stabilized** lines (everything but the last cleaned line, which may still be repainted). Line-granularity streaming — honest but coarse (spec TurnRunner seam).

**Files:**
- Create: `src/facade/streamRenderer.js`
- Test: `test/streamRenderer.test.js`

**Interfaces:**
- Consumes: `TerminalModel.renderLinesSince(index)`, `adapter.extractResponse(lines)`.
- Produces: `class StreamRenderer { constructor({terminalModel, adapter, sinceIndex}); tick() → string[]; finish() → { text, rest: string[] } }`. Guarantee: `tick()` never re-emits a line index it already emitted; `finish().text` is the full cleaned text; `finish().rest` is exactly the cleaned lines beyond what `tick()` emitted (empty if the cleaned render shrank).

- [ ] **Step 1: Write failing tests** — create `test/streamRenderer.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalModel } from '../src/terminalModel.js';
import { StreamRenderer } from '../src/facade/streamRenderer.js';
import { getAdapter } from '../src/adapters/index.js';

test('emits stabilized lines incrementally; finish returns full text + remainder', async () => {
  const tm = new TerminalModel({ cols: 120, rows: 30 });
  const generic = getAdapter('generic');
  const sr = new StreamRenderer({ terminalModel: tm, adapter: generic, sinceIndex: tm.snapshotLineCount() });
  await tm.write('echoed-input\r\n');
  assert.deepEqual(sr.tick(), []); // only the echoed line (dropped by generic) + partial
  await tm.write('line one\r\nline two\r\n');
  const t1 = sr.tick();
  assert.deepEqual(t1, ['line one']); // 'line two' is the last cleaned line — not stable yet
  await tm.write('line three\r\n');
  assert.deepEqual(sr.tick(), ['line two']);
  const { text, rest } = sr.finish();
  assert.equal(text, 'line one\nline two\nline three');
  assert.deepEqual(rest, ['line three']);
});

test('tick is idempotent when nothing new stabilized', async () => {
  const tm = new TerminalModel({ cols: 120, rows: 30 });
  const generic = getAdapter('generic');
  const sr = new StreamRenderer({ terminalModel: tm, adapter: generic, sinceIndex: tm.snapshotLineCount() });
  await tm.write('in\r\nonly line\r\n');
  const first = sr.tick();
  assert.deepEqual(sr.tick(), []);
  assert.deepEqual(sr.tick(), []);
  assert.deepEqual(first, []);
  const { text } = sr.finish();
  assert.equal(text, 'only line');
});

test('works through a chrome-stripping adapter', async () => {
  const tm = new TerminalModel({ cols: 120, rows: 30 });
  const claude = getAdapter('claude');
  const sr = new StreamRenderer({ terminalModel: tm, adapter: claude, sinceIndex: tm.snapshotLineCount() });
  await tm.write('● first paragraph\r\n\r\nsecond paragraph\r\n  ? for shortcuts\r\n');
  const { text } = sr.finish();
  assert.equal(text, 'first paragraph\n\nsecond paragraph');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/streamRenderer.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/facade/streamRenderer.js`**

```js
// src/facade/streamRenderer.js
// Incremental clean-text deltas from a TerminalModel transcript delta (spec
// "streamRenderer.js"). Each tick re-renders lines since the turn started,
// cleans them via adapter.extractResponse, and reports newly-STABILIZED
// cleaned lines — all but the last, which the CLI may still be repainting.
// Streaming is line-granular and best-effort: on a mid-turn repaint an
// already-emitted line can differ from the final render; finish().text (the
// full final clean render) is authoritative and is what the router stores.
export class StreamRenderer {
  constructor({ terminalModel, adapter, sinceIndex }) {
    this._tm = terminalModel;
    this._adapter = adapter;
    this._since = sinceIndex;
    this._emitted = 0;
  }
  _cleanLines() {
    const text = this._adapter.extractResponse(this._tm.renderLinesSince(this._since));
    return text === '' ? [] : text.split('\n');
  }
  tick() {
    const stable = this._cleanLines().slice(0, -1);
    if (stable.length <= this._emitted) return [];
    const out = stable.slice(this._emitted);
    this._emitted = stable.length;
    return out;
  }
  finish() {
    const lines = this._cleanLines();
    const rest = lines.length > this._emitted ? lines.slice(this._emitted) : [];
    return { text: lines.join('\n'), rest };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/streamRenderer.test.js`
Expected: PASS. (If the first test's `t1` assertion fails because `@xterm/headless` buffers writes differently, remember `tm.write` returns a promise — the test already awaits each write; debug with `console.log(tm.renderLinesSince(0))` before adjusting expectations.)

- [ ] **Step 5: Commit**

```bash
git add src/facade/streamRenderer.js test/streamRenderer.test.js
git commit -m "feat(facade): StreamRenderer — incremental stabilized clean-line deltas"
```

---

### Task 6: `runPtyTurn` + the `suspect` gate (incl. `sendPrompt`)

The PTY TurnRunner (spec "TurnRunner seam") plus the settle-timeout hazard fix (spec Error handling) applied to BOTH turn paths: a settle timeout flags the record `suspect`; the next prompt/turn waits for a confirmed settle before typing.

**Files:**
- Create: `src/facade/turnRunner.js`, `scripts/helpers/fake-repl.sh`
- Modify: `src/httpApi.js` (`sendPrompt` only)
- Test: `test/turnRunner.test.js`, `test/httpApi.test.js`

**Interfaces:**
- Consumes: `record` (SessionManager record), `writePromptText`, `StreamRenderer`, `FacadeError`, `estTokens`.
- Produces: `runPtyTurn({ record, userText, seedText = '', emit, timeoutMs }) → Promise<outcome>` where outcome is `{ text, usage: {input, output, estimated: true} }` or `{ dialog: { promptText, sinceIndex } }`; deltas emitted as `emit({type:'delta', text})` with `text` = `(first ? '' : '\n') + line` so concatenation reproduces the joined text. Throws `FacadeError(504,'timeout',…)` (setting `record.suspect = true`) or `FacadeError(500,'api_error',…)` with `.sessionExited = true`. If the session is already `awaiting_input` at turn start, returns the dialog outcome **without typing** (protects a dialog-blocked session from interleaved prompts). `MultilineUnsupportedError` → `FacadeError(400,'invalid_request',…)`.
- `scripts/helpers/fake-repl.sh` — the deterministic REPL every facade integration test uses (generic profile): replies `reply <n> to: <line>` with a session-lifetime line counter `n`; `PARA` → two paragraphs separated by a blank line; `SPAM` → ~1.2s of continuous 100ms-spaced output then `spam done`; `EXIT` → exits.

- [ ] **Step 1: Create `scripts/helpers/fake-repl.sh`**

```bash
#!/usr/bin/env bash
# Deterministic fake REPL for facade tests (generic profile). The reply
# counter is session-lifetime, so tests can tell whether two turns hit the
# same session (counter continues) or a fresh seeded one (counter restarts /
# jumps by the seed's line count).
n=0
while IFS= read -r line; do
  n=$((n+1))
  case "$line" in
    PARA) printf 'first paragraph\n\nsecond paragraph\n' ;;
    SPAM) i=0; while [ "$i" -lt 12 ]; do printf 'spam %d\n' "$i"; sleep 0.1; i=$((i+1)); done; printf 'spam done\n' ;;
    EXIT) exit 0 ;;
    *) printf 'reply %d to: %s\n' "$n" "$line" ;;
  esac
done
```

Run: `mkdir -p scripts/helpers` then create the file and `chmod +x scripts/helpers/fake-repl.sh`.

- [ ] **Step 2: Write failing tests** — create `test/turnRunner.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { runPtyTurn } from '../src/facade/turnRunner.js';

const REPL = path.resolve('scripts/helpers/fake-repl.sh');

function boot(extraEnv = {}) {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '120', ...extraEnv,
  });
  const manager = new SessionManager(config);
  return { config, manager };
}

test('runPtyTurn: deltas + done text, estimated usage', async () => {
  const { manager } = boot();
  const rec = manager.create({});
  const deltas = [];
  const out = await runPtyTurn({ record: rec, userText: 'hello', emit: (e) => deltas.push(e.text), timeoutMs: 8000 });
  assert.match(out.text, /reply 1 to: hello/);
  assert.equal(out.usage.estimated, true);
  assert.ok(out.usage.input >= 1 && out.usage.output >= 1);
  assert.equal(deltas.join(''), out.text, 'delta concatenation reproduces done text');
  manager.remove(rec.id);
});

test('runPtyTurn: seedText is written before the user text in the same turn', async () => {
  const { manager } = boot();
  const rec = manager.create({});
  const out = await runPtyTurn({ record: rec, userText: 'real question', seedText: 'context line A\ncontext line B', emit: () => {}, timeoutMs: 8000 });
  // raw multiline on generic: every line got a reply — 2 seed lines, the empty
  // line from the seed/user '\n\n' join, then the user text as line 4.
  assert.match(out.text, /reply 4 to: real question/);
  manager.remove(rec.id);
});

test('runPtyTurn: settle timeout flags the record suspect; next turn self-heals', async () => {
  const { manager } = boot();
  const rec = manager.create({});
  await assert.rejects(
    () => runPtyTurn({ record: rec, userText: 'SPAM', emit: () => {}, timeoutMs: 400 }),
    (e) => e.status === 504 && e.kind === 'timeout');
  assert.equal(rec.suspect, true);
  // next turn waits out the spam instead of typing into it
  const out = await runPtyTurn({ record: rec, userText: 'after', emit: () => {}, timeoutMs: 8000 });
  assert.equal(rec.suspect, false);
  assert.match(out.text, /reply \d+ to: after/);
  assert.ok(!/spam \d/.test(out.text), 'second turn must not swallow the first turn\'s spam');
  manager.remove(rec.id);
});

test('runPtyTurn: session exit mid-turn throws with sessionExited marker', async () => {
  const { manager } = boot();
  const rec = manager.create({});
  await assert.rejects(
    () => runPtyTurn({ record: rec, userText: 'EXIT', emit: () => {}, timeoutMs: 8000 }),
    (e) => e.status === 500 && e.sessionExited === true);
  manager.remove(rec.id);
});

test('runPtyTurn: dialog surfaced when session is awaiting_input at turn start', async () => {
  // Fake detector/record — no PTY needed to exercise the guard.
  const record = {
    suspect: false,
    detector: { state: 'awaiting_input' },
    terminalModel: { viewportTail: () => ['Quick safety check: trust?', '❯ 1. Yes'], snapshotLineCount: () => 42 },
    adapter: { describePrompt: (tail) => tail.join('\n') },
  };
  const out = await runPtyTurn({ record, userText: 'x', emit: () => {}, timeoutMs: 1000 });
  assert.ok(out.dialog);
  assert.match(out.dialog.promptText, /Quick safety check/);
  assert.equal(out.dialog.sinceIndex, 42);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/turnRunner.test.js` (foreground)
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `src/facade/turnRunner.js`**

```js
// src/facade/turnRunner.js
// The PTY TurnRunner (spec "TurnRunner seam"): enqueueing happens in the
// router; this function runs ONE turn against an already-acquired session
// record. markBusy → multiline-safe write + submit → StreamRenderer emits
// newly-stabilized cleaned lines as deltas on a fixed tick → on settle,
// resolve with the full cleaned text and chars/4-estimated usage.
//
// The suspect gate (spec Error handling): a settle timeout leaves the CLI in
// an unknown mid-turn state, so the record is flagged and the NEXT turn (here
// and in httpApi.sendPrompt) must wait for a confirmed settle before typing —
// this is what stops a timed-out prompt's successor interleaving into a
// still-busy CLI.
import { writePromptText, MultilineUnsupportedError } from '../promptWriter.js';
import { StreamRenderer } from './streamRenderer.js';
import { FacadeError, estTokens } from './shared.js';

const TICK_MS = 100;

function settleError(e, record) {
  if (/settle timeout/.test(String((e && e.message) || e))) {
    record.suspect = true;
    return new FacadeError(504, 'timeout', 'the CLI did not settle within the bridge prompt timeout');
  }
  const err = new FacadeError(500, 'api_error', 'the CLI session exited mid-turn', { reason: 'session_exited' });
  err.sessionExited = true;
  return err;
}

function dialogOutcome(record, sinceIndex) {
  const tail = record.terminalModel.viewportTail(8);
  return { dialog: { promptText: record.adapter.describePrompt(tail) || tail.join('\n'), sinceIndex } };
}

export async function runPtyTurn({ record, userText, seedText = '', emit, timeoutMs }) {
  const det = record.detector;
  if (record.suspect) {
    try { await det.waitForSettle({ timeoutMs }); } catch (e) { throw settleError(e, record); }
    record.suspect = false;
  }
  if (det.state === 'awaiting_input') {
    // A surfaced dialog is blocking this session; never type into it.
    return dialogOutcome(record, record.terminalModel.snapshotLineCount());
  }
  const full = seedText ? `${seedText}\n\n${userText}` : userText;
  const sinceIndex = record.terminalModel.snapshotLineCount();
  det.markBusy();
  try {
    writePromptText(record.session, record.adapter, full);
  } catch (e) {
    if (e instanceof MultilineUnsupportedError) throw new FacadeError(400, 'invalid_request', String(e.message));
    throw e;
  }
  record.session.write(record.adapter.keySeq('submit'));

  const renderer = new StreamRenderer({ terminalModel: record.terminalModel, adapter: record.adapter, sinceIndex });
  let first = true;
  const flush = (lines) => {
    for (const l of lines) { emit({ type: 'delta', text: (first ? '' : '\n') + l }); first = false; }
  };
  const iv = setInterval(() => flush(renderer.tick()), TICK_MS);

  let state;
  try {
    state = await det.waitForSettle({ timeoutMs });
  } catch (e) {
    throw settleError(e, record);
  } finally {
    clearInterval(iv);
  }

  if (state === 'awaiting_input') return dialogOutcome(record, sinceIndex);

  const { text, rest } = renderer.finish();
  if (rest.length) flush(rest.length === 1 ? rest : [rest.join('\n')]);
  return { text, usage: { input: estTokens(full.length), output: estTokens(text.length), estimated: true } };
}
```

Note on the final flush: emitting `rest` joined keeps the `(first ? '' : '\n') + line` framing exact, so delta concatenation equals `text`.

- [ ] **Step 5: Run turnRunner tests**

Run: `node --test test/turnRunner.test.js` (foreground)
Expected: PASS (the SPAM test takes ~2-3s).

- [ ] **Step 6: Write the failing `sendPrompt` suspect test** — append to `test/httpApi.test.js`:

```js
test('a timed-out /prompt flags the session; the next /prompt waits instead of interleaving', async () => {
  const REPL2 = path.resolve('scripts/helpers/fake-repl.sh');
  const config = loadConfig({ BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL2]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '120' });
  const manager = new SessionManager(config);
  const server = createHttpServer(config, manager);
  const port = await new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
  const { id } = await (await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' })).json();
  const p1 = await fetch(url(port, `/api/sessions/${id}/prompt`), { method: 'POST', ...auth,
    body: JSON.stringify({ text: 'SPAM', timeoutMs: 400 }) });
  assert.equal(p1.status, 504);
  const p2 = await (await fetch(url(port, `/api/sessions/${id}/prompt`), { method: 'POST', ...auth,
    body: JSON.stringify({ text: 'after' }) })).json();
  assert.match(p2.output, /after/);
  assert.ok(!/spam \d/.test(p2.output), `second prompt swallowed the first turn's output: ${JSON.stringify(p2.output)}`);
  await fetch(url(port, `/api/sessions/${id}`), { method: 'DELETE', ...auth });
  server.close();
});
```

(Add `import path from 'node:path';` to the file's imports if missing.)

- [ ] **Step 7: Run to verify it fails**

Run: `node --test test/httpApi.test.js`
Expected: the new test FAILS — today the second prompt types into the still-spamming CLI and its output window contains `spam` lines.

- [ ] **Step 8: Add the suspect gate to `sendPrompt`** in `src/httpApi.js`:

```js
export async function sendPrompt(record, { text, submit = true, timeoutMs = 600000 }) {
  const start = Date.now();
  // Settle-timeout hazard (spec Error handling): after a timed-out turn the
  // CLI is still mid-generation; refuse to type until a confirmed settle.
  if (record.suspect) {
    await record.detector.waitForSettle({ timeoutMs });
    record.suspect = false;
  }
  const before = record.terminalModel.snapshotLineCount();
  record.detector.markBusy();
  writePromptText(record.session, record.adapter, text);
  if (submit) record.session.write(record.adapter.keySeq('submit'));
  let state;
  try {
    state = await record.detector.waitForSettle({ timeoutMs });
  } catch (e) {
    if (/settle timeout/.test(String(e.message || e))) record.suspect = true;
    throw e;
  }
  const lines = record.terminalModel.renderLinesSince(before);
  const output = lines.join('\n');
  const cleaned = typeof record.adapter.extractResponse === 'function'
    ? record.adapter.extractResponse(lines)
    : output;
  const prompt = state === 'awaiting_input' ? record.adapter.describePrompt(record.terminalModel.viewportTail(8)) : null;
  return { state, output, text: cleaned, prompt, durationMs: Date.now() - start };
}
```

- [ ] **Step 9: Run the full suite**

Run: `npm test` (foreground)
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src/facade/turnRunner.js src/httpApi.js scripts/helpers/fake-repl.sh test/turnRunner.test.js test/httpApi.test.js
git commit -m "feat(facade): PTY turn runner with streaming deltas; suspect gate stops post-timeout interleaving"
```

---

### Task 7: `runHeadlessClaudeTurn` + the claude stream-json stub

**Files:**
- Create: `src/facade/headlessClaudeRunner.js`, `scripts/helpers/claude-stub.mjs`
- Test: `test/headlessRunner.test.js`

**Interfaces:**
- Consumes: a resolved profile object `{command, args, envScrub, cwd}`, `FacadeError`.
- Produces: `runHeadlessClaudeTurn({ profile, resumeSessionId, userText, seedText = '', emit, timeoutMs }) → Promise<{ text, claudeSessionId, usage: {input, output, estimated:false} }>`. Fixed flags `-p --output-format stream-json --verbose --include-partial-messages`, then `--resume <id>` when resuming, then `profile.args` (spec: profile args appended after the runner's fixed flags). Prompt written to stdin. Parses NDJSON: `system/init` → session_id; `stream_event` `content_block_delta` `text_delta` → `emit` delta; `result` → final text + real usage. Nonzero exit, missing result, or timeout → `FacadeError` (`api_error` 500 with trailing stderr in `bridge.stderr`; timeout kind `'timeout'` 504). Spawned with the profile's env-scrub applied and `cwd: profile.cwd`.
- `scripts/helpers/claude-stub.mjs` (chmod +x, shebang `#!/usr/bin/env node`, spawned directly as the profile command): emits `init` with `session_id: stub-<n>` where `n` = 1 or (resumed n)+1, two `text_delta` frames halving the reply `turn <n> reply to: <last input line>`, then `result` with `usage {input_tokens: 42, output_tokens: 7}`. `--resume` of anything not matching `stub-<n>` → stderr `No conversation found…`, exit 1. Prompt containing `CRASH` → exit 1.

- [ ] **Step 1: Create `scripts/helpers/claude-stub.mjs`** (then `chmod +x`):

```js
#!/usr/bin/env node
// Fake `claude -p --output-format stream-json --include-partial-messages`
// for headless-runner tests (spec Testing §3): real enough to exercise the
// parser — init/session_id, incremental text_delta stream_events, a result
// with usage — plus failure modes (--resume rejection, CRASH → nonzero exit).
// The session-id chain stub-1 → stub-2 → … proves --resume is passed through.
const args = process.argv.slice(2);
const ri = args.indexOf('--resume');
const resumed = ri === -1 ? null : args[ri + 1];
let turn = 1;
if (resumed != null) {
  const m = /^stub-(\d+)$/.exec(resumed);
  if (!m) { process.stderr.write(`No conversation found with session ID: ${resumed}\n`); process.exit(1); }
  turn = Number(m[1]) + 1;
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const prompt = input.trim();
  if (/CRASH/.test(prompt)) { process.stderr.write('stub: synthetic failure\n'); process.exit(1); }
  const sid = `stub-${turn}`;
  const reply = `turn ${turn} reply to: ${prompt.split('\n').pop()}`;
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'stub' });
  const half = Math.ceil(reply.length / 2);
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(0, half) } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(half) } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sid, usage: { input_tokens: 42, output_tokens: 7 } });
  process.exit(0);
});
```

- [ ] **Step 2: Write failing tests** — create `test/headlessRunner.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runHeadlessClaudeTurn } from '../src/facade/headlessClaudeRunner.js';

const STUB = path.resolve('scripts/helpers/claude-stub.mjs');
const profile = { command: STUB, args: [], envScrub: [], cwd: process.cwd() };

test('first turn: init session id, streamed deltas, result text, REAL usage', async () => {
  const deltas = [];
  const out = await runHeadlessClaudeTurn({ profile, resumeSessionId: null, userText: 'hello', emit: (e) => deltas.push(e.text), timeoutMs: 5000 });
  assert.equal(out.text, 'turn 1 reply to: hello');
  assert.equal(out.claudeSessionId, 'stub-1');
  assert.deepEqual(out.usage, { input: 42, output: 7, estimated: false });
  assert.equal(deltas.join(''), out.text);
});

test('resume chains the session id', async () => {
  const out = await runHeadlessClaudeTurn({ profile, resumeSessionId: 'stub-1', userText: 'again', emit: () => {}, timeoutMs: 5000 });
  assert.equal(out.text, 'turn 2 reply to: again');
  assert.equal(out.claudeSessionId, 'stub-2');
});

test('seed text is prepended; the reply answers the trailing user line', async () => {
  const out = await runHeadlessClaudeTurn({ profile, resumeSessionId: null, userText: 'the question', seedText: 'ctx a\nctx b', emit: () => {}, timeoutMs: 5000 });
  assert.equal(out.text, 'turn 1 reply to: the question');
});

test('rejected --resume fails provider-shaped with stderr captured', async () => {
  await assert.rejects(
    () => runHeadlessClaudeTurn({ profile, resumeSessionId: 'bogus', userText: 'x', emit: () => {}, timeoutMs: 5000 }),
    (e) => e.status === 500 && e.kind === 'api_error' && /No conversation found/.test(e.bridge.stderr));
});

test('nonzero exit fails provider-shaped', async () => {
  await assert.rejects(
    () => runHeadlessClaudeTurn({ profile, resumeSessionId: null, userText: 'please CRASH now', emit: () => {}, timeoutMs: 5000 }),
    (e) => e.status === 500 && /exited with code 1/.test(e.message));
});

test('timeout kills the child and fails 504', async () => {
  await assert.rejects(
    () => runHeadlessClaudeTurn({ profile, resumeSessionId: null, userText: 'please HANG forever', emit: () => {}, timeoutMs: 300 }),
    (e) => e.status === 504 && e.kind === 'timeout');
});
```

The timeout test needs a child that ignores argv and never exits (external commands like `sleep`/`cat` choke on the runner's fixed flags). That is the stub's `HANG` mode — add to the stub, right after the CRASH check:

```js
  if (/HANG/.test(prompt)) { setInterval(() => {}, 1000); return; } // never results, never exits
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/headlessRunner.test.js`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `src/facade/headlessClaudeRunner.js`**

```js
// src/facade/headlessClaudeRunner.js
// HeadlessClaudeRunner (spec "TurnRunner seam"): one facade turn = one
// `claude -p --output-format stream-json --verbose --include-partial-messages`
// invocation (the partial-messages flag is required for incremental deltas).
// First turn captures Claude's own session_id from the init event; later
// turns pass --resume <id>, so no seeding is needed while resume works. The
// profile's args are appended AFTER the fixed flags; env-scrub forces
// subscription auth. Real token usage comes from the result event.
import { spawn } from 'node:child_process';
import { FacadeError } from './shared.js';

const FIXED_ARGS = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

export function runHeadlessClaudeTurn({ profile, resumeSessionId, userText, seedText = '', emit, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [...FIXED_ARGS];
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    args.push(...profile.args);
    const env = { ...process.env };
    for (const k of profile.envScrub) delete env[k];

    let child;
    try {
      child = spawn(profile.command, args, { cwd: profile.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new FacadeError(500, 'api_error', `failed to spawn "${profile.command}": ${e.message}`,
        { spawn_error: String(e.message || e) }));
    }

    let sessionId = null;
    let resultText = null;
    let usage = null;
    let stderr = '';
    let buf = '';
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      reject(err);
    };
    const timer = setTimeout(() => fail(new FacadeError(504, 'timeout', 'headless claude turn timed out',
      { stderr: stderr.slice(-2000) })), timeoutMs);

    child.on('error', (e) => fail(new FacadeError(500, 'api_error', `failed to spawn "${profile.command}": ${e.message}`,
      { spawn_error: String(e.message || e) })));
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; } // tolerate noise; a missing result is caught at exit
        if (j.type === 'system' && j.subtype === 'init' && j.session_id) sessionId = j.session_id;
        else if (j.type === 'stream_event' && j.event && j.event.type === 'content_block_delta'
                 && j.event.delta && j.event.delta.type === 'text_delta') emit({ type: 'delta', text: j.event.delta.text });
        else if (j.type === 'result') {
          resultText = j.is_error ? null : (j.result ?? '');
          usage = j.usage || null;
          if (j.session_id) sessionId = j.session_id;
        }
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new FacadeError(500, 'api_error', `headless claude exited with code ${code}`, { stderr: stderr.slice(-2000) }));
      if (resultText == null) return reject(new FacadeError(500, 'api_error', 'headless claude produced no result event', { stderr: stderr.slice(-2000) }));
      resolve({
        text: resultText,
        claudeSessionId: sessionId,
        usage: usage
          ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, estimated: false }
          : { input: 0, output: 0, estimated: true },
      });
    });
    child.stdin.on('error', () => { /* child died before reading stdin; close handler reports it */ });
    child.stdin.write(seedText ? `${seedText}\n\n${userText}` : userText);
    child.stdin.end();
  });
}
```

- [ ] **Step 5: Run tests**

Run: `node --test test/headlessRunner.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/facade/headlessClaudeRunner.js scripts/helpers/claude-stub.mjs test/headlessRunner.test.js
git commit -m "feat(facade): headless claude runner (stream-json parse, resume chain, real usage) + stub shim"
```

---

### Task 8: `executeTurn` orchestration (router ⇄ runners, dialog-pending retry)

Wire the runners into the router: enqueue on the conversation's queue, forward deltas into an `AsyncQueue`, advance the fingerprint on success, buffer a dialog-blocked pending turn, drop mappings on session exit, drop `claudeSessionId` (+ force reseed) on headless failure.

**Files:**
- Modify: `src/facade/router.js`
- Create: `scripts/helpers/fake-dialog-repl.sh`
- Test: `test/facadeTurns.test.js`

**Interfaces:**
- Consumes: `runPtyTurn` (Task 6), `runHeadlessClaudeTurn` (Task 7), `AsyncQueue`.
- Produces on `ConversationRouter`:
  - `executeTurn({ profileName, pinId = null, previousResponseId = null, messages, signal = null, timeoutMs }) → { conv, events }`. Throws synchronously: `model_not_found` (unknown/command-less profile), `not_found` (unknown `previousResponseId`), plus everything `acquire` throws. `events` yields deltas then `done`; failures throw from the iterator. When `signal` aborts, delta emission stops but the turn runs to completion in the background (client-disconnect semantics) and bookkeeping still happens.
  - Dialog handling: a turn ending in a dialog sets `conv.pending = { fpKey, userText, sinceIndex }` and fails the events queue with `FacadeError(409,'dialog', …, { conversation_id, session_id, dialog })`; the fingerprint does NOT advance. A retry with identical fingerprint AND identical trailing user text **attaches**: if the session has settled idle, the transcript since `sinceIndex` is extracted and returned as the completed turn (fingerprint then advances); if still awaiting, the same dialog error; if busy, it waits for settle first.
- `scripts/helpers/fake-dialog-repl.sh`: prints the claude idle footer at boot; input `DIALOG` prints the claude trust-dialog markers and waits for one more line (the operator's `POST /key` enter), then prints `dialog answered` + footer; any other input prints `plain reply to: <line>` + footer. Used with `PROFILE_CLAUDE_COMMAND=bash`, `PROFILE_CLAUDE_ARGS=[…]`, `PROFILE_CLAUDE_DIALOG_POLICY=never` so the dialog surfaces instead of being auto-answered.

- [ ] **Step 1: Create `scripts/helpers/fake-dialog-repl.sh`** (then `chmod +x`):

```bash
#!/usr/bin/env bash
# Emulates the claude adapter's fixture markers well enough to drive the
# facade's mid-turn dialog path without a real CLI: idle footer at boot,
# trust-dialog markers on demand, then an answer line after the operator key.
printf '  ? for shortcuts\n'
while IFS= read -r line; do
  case "$line" in
    DIALOG)
      printf ' Quick safety check: Is this a project you created or one you trust?\n'
      printf ' %s 1. Yes, I trust this folder\n' '❯'
      IFS= read -r _answer
      printf 'dialog answered\n'
      printf '  ? for shortcuts\n'
      ;;
    *)
      printf 'plain reply to: %s\n' "$line"
      printf '  ? for shortcuts\n'
      ;;
  esac
done
```

- [ ] **Step 2: Write failing tests** — create `test/facadeTurns.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { ConversationRouter } from '../src/facade/router.js';

const REPL = path.resolve('scripts/helpers/fake-repl.sh');
const DIALOG_REPL = path.resolve('scripts/helpers/fake-dialog-repl.sh');
const STUB = path.resolve('scripts/helpers/claude-stub.mjs');

function boot(extraEnv = {}) {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '120', PROMPT_TIMEOUT_MS: '8000',
    PROFILE_CLAUDE_COMMAND: 'bash', PROFILE_CLAUDE_ARGS: JSON.stringify([DIALOG_REPL]),
    PROFILE_CLAUDE_DIALOG_POLICY: 'never', PROFILE_CLAUDE_QUIESCENCE_MS: '120', PROFILE_CLAUDE_CWD: process.cwd(),
    PROFILE_CLAUDE_HEADLESS_COMMAND: STUB, PROFILE_CLAUDE_HEADLESS_CWD: process.cwd(),
    ...extraEnv,
  });
  const manager = new SessionManager(config);
  const router = new ConversationRouter({ config, manager });
  return { config, manager, router, close() { router.close(); for (const r of manager.list()) manager.remove(r.id); } };
}

const msgs = (...pairs) => pairs.map(([role, text]) => ({ role, text }));

async function drain(events) {
  const deltas = [];
  let done = null;
  for await (const ev of events) { if (ev.type === 'delta') deltas.push(ev.text); else if (ev.type === 'done') done = ev; }
  return { deltas, done };
}

test('pty turn end-to-end: deltas, done, fingerprint advances for the next turn', async () => {
  const b = boot();
  const m1 = msgs(['user', 'hello']);
  const t1 = b.router.executeTurn({ profileName: 'generic', messages: m1, timeoutMs: 8000 });
  const r1 = await drain(t1.events);
  assert.match(r1.done.text, /reply 1 to: hello/);
  assert.equal(r1.deltas.join(''), r1.done.text);
  const m2 = msgs(['user', 'hello'], ['assistant', r1.done.text], ['user', 'again']);
  const t2 = b.router.executeTurn({ profileName: 'generic', messages: m2, timeoutMs: 8000 });
  const r2 = await drain(t2.events);
  assert.equal(t2.conv, t1.conv, 'fingerprint hit routes to the same conversation');
  assert.match(r2.done.text, /reply 2 to: again/, 'same session — counter continued');
  b.close();
});

test('unknown model → model_not_found before any session spawns', () => {
  const b = boot();
  assert.throws(() => b.router.executeTurn({ profileName: 'gpt-4o', messages: msgs(['user', 'x']), timeoutMs: 1000 }),
    (e) => e.status === 404 && e.kind === 'model_not_found');
  assert.equal(b.manager.list().length, 0);
  b.close();
});

test('headless turn: stub session-id chain proves --resume continuity', async () => {
  const b = boot();
  const m1 = msgs(['user', 'first']);
  const t1 = b.router.executeTurn({ profileName: 'claude-headless', messages: m1, timeoutMs: 8000 });
  const r1 = await drain(t1.events);
  assert.equal(r1.done.text, 'turn 1 reply to: first');
  assert.deepEqual(r1.done.usage, { input: 42, output: 7, estimated: false });
  assert.equal(t1.conv.claudeSessionId, 'stub-1');
  const m2 = msgs(['user', 'first'], ['assistant', r1.done.text], ['user', 'second']);
  const t2 = b.router.executeTurn({ profileName: 'claude-headless', messages: m2, timeoutMs: 8000 });
  const r2 = await drain(t2.events);
  assert.equal(t2.conv, t1.conv);
  assert.equal(r2.done.text, 'turn 2 reply to: second');
  assert.equal(t2.conv.claudeSessionId, 'stub-2');
  b.close();
});

test('headless failure drops the session id and reseeds the next turn', async () => {
  const b = boot();
  const m1 = msgs(['user', 'alpha']);
  const t1 = b.router.executeTurn({ profileName: 'claude-headless', messages: m1, timeoutMs: 8000 });
  const r1 = await drain(t1.events);
  const m2 = msgs(['user', 'alpha'], ['assistant', r1.done.text], ['user', 'now CRASH please']);
  const t2 = b.router.executeTurn({ profileName: 'claude-headless', messages: m2, timeoutMs: 8000 });
  await assert.rejects(() => drain(t2.events), (e) => e.status === 500);
  assert.equal(t2.conv.claudeSessionId, null, 'session id dropped');
  assert.equal(t2.conv.needsSeed, true, 'next turn reseeds from client-held history');
  // recovery: same history retried (fingerprint unchanged — the failed turn did not advance it)
  const t3 = b.router.executeTurn({ profileName: 'claude-headless', messages: msgs(['user', 'alpha'], ['assistant', r1.done.text], ['user', 'recover']), timeoutMs: 8000 });
  const r3 = await drain(t3.events);
  assert.equal(t3.conv, t2.conv);
  assert.equal(r3.done.text, 'turn 1 reply to: recover', 'fresh -p turn (counter restarted), seeded');
  b.close();
});

test('session exit mid-turn drops the conversation mapping', async () => {
  const b = boot();
  const m1 = msgs(['user', 'EXIT']);
  const t1 = b.router.executeTurn({ profileName: 'generic', messages: m1, timeoutMs: 8000 });
  await assert.rejects(() => drain(t1.events), (e) => e.status === 500);
  assert.equal(b.router.stats().conversations, 0, 'mapping dropped so the next request reseeds');
  b.close();
});

test('dialog mid-turn: pending buffered, retry attaches after POST-/key-style answer', async () => {
  const b = boot();
  const m = msgs(['user', 'DIALOG']);
  const t1 = b.router.executeTurn({ profileName: 'claude', messages: m, timeoutMs: 8000 });
  let dialogErr;
  try { await drain(t1.events); } catch (e) { dialogErr = e; }
  assert.equal(dialogErr.status, 409);
  assert.equal(dialogErr.kind, 'dialog');
  assert.match(dialogErr.bridge.dialog, /Quick safety check/);
  assert.equal(dialogErr.bridge.conversation_id, t1.conv.id);
  assert.equal(dialogErr.bridge.session_id, t1.conv.record.id);
  assert.ok(t1.conv.pending, 'pending turn buffered');
  // a retry while still blocked gets the same dialog error, and does NOT type
  const t2 = b.router.executeTurn({ profileName: 'claude', messages: m, timeoutMs: 3000 });
  await assert.rejects(() => drain(t2.events), (e) => e.kind === 'dialog');
  // operator answers (what POST /key does)
  t1.conv.record.session.write(t1.conv.record.adapter.keySeq('enter'));
  await t1.conv.record.detector.waitForSettle({ timeoutMs: 5000 });
  // identical retry now attaches and returns the extracted text
  const t3 = b.router.executeTurn({ profileName: 'claude', messages: m, timeoutMs: 8000 });
  const r3 = await drain(t3.events);
  assert.match(r3.done.text, /dialog answered/);
  assert.equal(t3.conv.pending, null);
  b.close();
});

test('at-capacity with all sessions mid-turn → 429; after settle, eviction works', async () => {
  const b = boot({ FACADE_MAX_SESSIONS: '1' });
  const t1 = b.router.executeTurn({ profileName: 'generic', messages: msgs(['user', 'SPAM']), timeoutMs: 8000 });
  await new Promise((r) => setTimeout(r, 250)); // let the turn start (busy=1)
  assert.throws(() => b.router.executeTurn({ profileName: 'generic', messages: msgs(['user', 'other']), timeoutMs: 8000 }),
    (e) => e.status === 429 && e.kind === 'rate_limit');
  await drain(t1.events); // spam finishes, conv idle
  const t2 = b.router.executeTurn({ profileName: 'generic', messages: msgs(['user', 'other']), timeoutMs: 8000 });
  const r2 = await drain(t2.events);
  assert.match(r2.done.text, /reply 1 to: other/, 'LRU idle conversation evicted, fresh session spawned');
  b.close();
});

test('abort signal stops delta emission but the turn still completes and advances', async () => {
  const b = boot();
  const ac = new AbortController();
  const m1 = msgs(['user', 'SPAM']);
  const t1 = b.router.executeTurn({ profileName: 'generic', messages: m1, signal: ac.signal, timeoutMs: 8000 });
  const seen = [];
  let ended = false;
  (async () => { try { for await (const ev of t1.events) seen.push(ev); } catch { /* ignored */ } ended = true; })();
  await new Promise((r) => setTimeout(r, 300));
  ac.abort(); // client disconnects mid-stream
  await new Promise((r) => setTimeout(r, 2500)); // let the CLI finish in background
  assert.equal(t1.conv.busy, 0, 'turn completed in background');
  assert.ok(t1.conv.record.session.alive, 'no ESC-interrupt: session left consistent');
  const countAfterAbort = seen.filter((e) => e.type === 'delta').length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(seen.filter((e) => e.type === 'delta').length, countAfterAbort, 'no deltas after abort');
  b.close();
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/facadeTurns.test.js` (foreground)
Expected: FAIL — `executeTurn` is not a function.

- [ ] **Step 4: Implement in `src/facade/router.js`**

Add imports:

```js
import { FacadeError, AsyncQueue, estTokens } from './shared.js';
import { runPtyTurn } from './turnRunner.js';
import { runHeadlessClaudeTurn } from './headlessClaudeRunner.js';
```

(merge with the existing `FacadeError, estTokens` import). Add these methods to `ConversationRouter`:

```js
  _dialogError(conv, promptText) {
    return new FacadeError(409, 'dialog',
      `the CLI is waiting on an interactive dialog; answer it via POST /api/sessions/${conv.record.id}/key and retry`,
      { conversation_id: conv.id, session_id: conv.record.id, dialog: promptText });
  }

  _failTurn(conv, e) {
    if (conv.mode === 'headless') {
      // Spec Error handling: drop the stored session_id; the next request
      // reseeds a fresh first -p turn from client-held history.
      conv.claudeSessionId = null;
      conv.needsSeed = true;
      return;
    }
    if (e && e.sessionExited) this._destroy(conv); // next request reseeds a fresh session
  }

  async _runTurn({ conv, userText, seedText, timeoutMs, emit }) {
    if (conv.mode === 'headless') {
      const out = await runHeadlessClaudeTurn({
        profile: conv.profile, resumeSessionId: conv.claudeSessionId, userText, seedText, emit, timeoutMs,
      });
      conv.claudeSessionId = out.claudeSessionId ?? conv.claudeSessionId;
      return out;
    }
    return runPtyTurn({ record: conv.record, userText, seedText, emit, timeoutMs });
  }

  // Attach to a dialog-blocked pending turn (spec Error handling): the retry
  // does not re-type — it returns the extracted text if the operator's answer
  // let the session settle, or the same dialog error if still blocked.
  _attachPending(conv, messages, events, timeoutMs) {
    const { sinceIndex, userText } = conv.pending;
    conv.busy += 1;
    (async () => {
      try {
        const det = conv.record.detector;
        const state = (det.state === 'idle' || det.state === 'awaiting_input')
          ? det.state
          : await det.waitForSettle({ timeoutMs });
        if (state === 'awaiting_input') {
          const tail = conv.record.terminalModel.viewportTail(8);
          events.fail(this._dialogError(conv, conv.record.adapter.describePrompt(tail) || tail.join('\n')));
          return;
        }
        const lines = conv.record.terminalModel.renderLinesSince(sinceIndex);
        const text = conv.record.adapter.extractResponse(lines);
        this.completeTurn(conv, messages, text);
        events.push({ type: 'done', text, finishReason: 'stop',
          usage: { input: estTokens(userText.length), output: estTokens(text.length), estimated: true } });
        events.end();
      } catch (e) {
        events.fail(e instanceof FacadeError ? e : new FacadeError(500, 'api_error', String((e && e.message) || e)));
      } finally {
        conv.busy -= 1;
        conv.lastUsed = Date.now();
      }
    })();
  }

  executeTurn({ profileName, pinId = null, previousResponseId = null, messages, signal = null, timeoutMs }) {
    const profile = this._config.profiles[profileName];
    if (!profile || !profile.command) {
      throw new FacadeError(404, 'model_not_found', `The model \`${profileName}\` does not exist or is not available on this bridge`);
    }
    let respConv = null;
    if (previousResponseId != null && pinId == null) {
      respConv = this._byResp.get(previousResponseId);
      if (!respConv) throw new FacadeError(404, 'not_found', `previous response "${previousResponseId}" not found or expired`);
    }
    const { conv, fpKey, userText, seedText } = this.acquire({ profileName, pinId, respConv, messages });
    const events = new AsyncQueue();
    if (conv.pending && conv.pending.fpKey === fpKey && conv.pending.userText === userText) {
      this._attachPending(conv, messages, events, timeoutMs);
      return { conv, events };
    }
    conv.busy += 1;
    conv.lastUsed = Date.now();
    conv.queue.enqueue(async () => {
      try {
        const emit = (ev) => { if (!signal || !signal.aborted) events.push(ev); };
        const outcome = await this._runTurn({ conv, userText, seedText, timeoutMs, emit });
        if (outcome.dialog) {
          conv.pending = { fpKey, userText, sinceIndex: outcome.dialog.sinceIndex };
          events.fail(this._dialogError(conv, outcome.dialog.promptText));
        } else {
          this.completeTurn(conv, messages, outcome.text);
          events.push({ type: 'done', text: outcome.text, finishReason: 'stop', usage: outcome.usage });
          events.end();
        }
      } catch (e) {
        this._failTurn(conv, e);
        events.fail(e instanceof FacadeError ? e : new FacadeError(500, 'api_error', String((e && e.message) || e)));
      } finally {
        conv.busy -= 1;
        conv.lastUsed = Date.now();
      }
    });
    return { conv, events };
  }
```

Note: the enqueued function never rejects (everything is caught), so the `enqueue` return value needs no `.catch`.

- [ ] **Step 5: Run the tests**

Run: `node --test test/facadeTurns.test.js` (foreground; this suite spawns several PTYs and takes ~15-25s)
Expected: PASS.

- [ ] **Step 6: Run the full suite, then commit**

Run: `npm test` → all pass.

```bash
git add src/facade/router.js scripts/helpers/fake-dialog-repl.sh test/facadeTurns.test.js
git commit -m "feat(facade): executeTurn orchestration — queue serialization, dialog-pending retry, exit/headless recovery"
```

---

### Task 9: OpenAI Chat Completions dialect

**Files:**
- Create: `src/facade/dialects/openaiChat.js`, `scripts/helpers/sse.mjs`
- Modify: `src/facade/index.js` (register the route)
- Test: `test/openaiChat.test.js`

**Interfaces:**
- Consumes: `ctx = { config, manager, router }`, everything in `shared.js`.
- Produces: `makeOpenaiChatHandler(ctx) → async (req, res, u)` for `POST /v1/chat/completions`.
  - Non-stream response: `{ id: 'chatcmpl-<uuid>', object: 'chat.completion', created, model: <as requested>, choices: [{index:0, message:{role:'assistant', content}, logprobs:null, finish_reason:'stop'}], usage, bridge?: {usage_estimated:true} }`.
  - Stream: first chunk `delta:{role:'assistant',content:''}`, then `delta:{content}` per event, then `delta:{}, finish_reason:'stop'`, then (only when `stream_options.include_usage`) a usage chunk with empty `choices`, then `data: [DONE]`. Errors after streaming began: `data: {"error":{…}}` then `data: [DONE]` (spec).
  - Pin extraction: model suffix `<profile>#<id>`; header `X-Bridge-Conversation` wins on disagreement.
  - Validation (all provider-shaped 400): missing/empty `model`; `messages` not a non-empty array; missing role; non-text content parts; trailing message not `user`; `n` present and ≠ 1.
  - `KNOWN = ['model','messages','stream','stream_options','n']` — everything else logged-ignored once.
- `scripts/helpers/sse.mjs`: `readSse(response) → Promise<[{event, data}]>` (waits for stream close; `data` is the raw string — `[DONE]` stays unparsed).

- [ ] **Step 1: Create `scripts/helpers/sse.mjs`**

```js
// Parse a fetch() Response carrying an SSE stream into ordered frames.
// data is left as the raw string so tests can assert on '[DONE]' as-is.
export async function readSse(response) {
  const text = await response.text();
  const frames = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = null;
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (event !== null || dataLines.length) frames.push({ event, data: dataLines.join('\n') });
  }
  return frames;
}
```

- [ ] **Step 2: Write failing tests** — create `test/openaiChat.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';
import { createFacade } from '../src/facade/index.js';
import { readSse } from '../scripts/helpers/sse.mjs';

const REPL = path.resolve('scripts/helpers/fake-repl.sh');

function boot(extraEnv = {}) {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '120', PROMPT_TIMEOUT_MS: '8000', ...extraEnv,
  });
  const manager = new SessionManager(config);
  const facade = createFacade(config, manager);
  const server = createHttpServer(config, manager, facade);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    config, manager, facade, server, port: server.address().port,
    close() { facade.close(); for (const r of manager.list()) manager.remove(r.id); server.close(); },
  })));
}
const url = (port, p) => `http://127.0.0.1:${port}${p}`;
const H = { authorization: 'Bearer tok', 'content-type': 'application/json' };
const post = (port, p, body, headers = {}) => fetch(url(port, p), { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify(body) });

test('non-streaming completion: shape, estimated usage, bridge flag', async () => {
  const b = await boot();
  const r = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.id, /^chatcmpl-/);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, 'generic');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.match(body.choices[0].message.content, /reply 1 to: hello/);
  assert.equal(body.usage.total_tokens, body.usage.prompt_tokens + body.usage.completion_tokens);
  assert.deepEqual(body.bridge, { usage_estimated: true });
  b.close();
});

test('multi-turn fingerprint stickiness reuses the session', async () => {
  const b = await boot();
  const r1 = await (await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'hello' }] })).json();
  const text1 = r1.choices[0].message.content;
  const r2 = await (await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [
    { role: 'user', content: 'hello' }, { role: 'assistant', content: text1 }, { role: 'user', content: 'again' },
  ] })).json();
  assert.match(r2.choices[0].message.content, /reply 2 to: again/, 'counter continued — same session');
  assert.equal(b.manager.list().length, 1);
  b.close();
});

test('streaming: role chunk, content deltas, stop chunk, [DONE]; concat matches', async () => {
  const b = await boot();
  const r = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'PARA' }], stream: true, stream_options: { include_usage: true } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const frames = await readSse(r);
  assert.equal(frames.at(-1).data, '[DONE]');
  const chunks = frames.slice(0, -1).map((f) => JSON.parse(f.data));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  const content = chunks.map((c) => c.choices[0]?.delta?.content || '').join('');
  assert.match(content, /first paragraph\n\nsecond paragraph/);
  const stop = chunks.find((c) => c.choices[0]?.finish_reason === 'stop');
  assert.ok(stop, 'finish_reason stop chunk present');
  const usageChunk = chunks.find((c) => c.usage);
  assert.ok(usageChunk, 'include_usage chunk present');
  assert.deepEqual(usageChunk.choices, []);
  b.close();
});

test('explicit pin via model suffix; header wins over suffix', async () => {
  const b = await boot();
  const r1 = await (await post(b.port, '/v1/chat/completions', { model: 'generic#alpha', messages: [{ role: 'user', content: 'one' }] })).json();
  assert.match(r1.choices[0].message.content, /reply 1 to: one/);
  assert.equal(r1.model, 'generic#alpha', 'model echoed as requested');
  // no history at all — the pin alone routes to the same session
  const r2 = await (await post(b.port, '/v1/chat/completions', { model: 'generic#alpha', messages: [{ role: 'user', content: 'two' }] })).json();
  assert.match(r2.choices[0].message.content, /reply 2 to: two/);
  // header pin 'beta' overrides the suffix 'alpha' → different (new) conversation
  const r3 = await (await post(b.port, '/v1/chat/completions', { model: 'generic#alpha', messages: [{ role: 'user', content: 'three' }] },
    { 'x-bridge-conversation': 'beta' })).json();
  assert.match(r3.choices[0].message.content, /reply 1 to: three/);
  b.close();
});

test('validation 400s are OpenAI-shaped', async () => {
  const b = await boot();
  for (const [body, re] of [
    [{ messages: [{ role: 'user', content: 'x' }] }, /model/],
    [{ model: 'generic', messages: [] }, /messages/],
    [{ model: 'generic', messages: [{ role: 'user', content: 'x' }], n: 2 }, /n=1/],
    [{ model: 'generic', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }, /text content parts/],
    [{ model: 'generic', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }, /final message/],
  ]) {
    const r = await post(b.port, '/v1/chat/completions', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    const e = await r.json();
    assert.equal(e.error.type, 'invalid_request_error');
    assert.match(e.error.message, re);
  }
  b.close();
});

test('unknown model → 404 model_not_found', async () => {
  const b = await boot();
  const r = await post(b.port, '/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 404);
  const e = await r.json();
  assert.equal(e.error.code, 'model_not_found');
  b.close();
});

test('disabled chat dialect 404s while models stays up', async () => {
  const b = await boot({ FACADE_OPENAI_CHAT: '0' });
  const r = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 404);
  const m = await fetch(url(b.port, '/v1/models'), { headers: { authorization: 'Bearer tok' } });
  assert.equal(m.status, 200);
  b.close();
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test test/openaiChat.test.js`
Expected: FAIL — dialect module missing / route not registered.

- [ ] **Step 4: Implement `src/facade/dialects/openaiChat.js`**

```js
// src/facade/dialects/openaiChat.js
// POST /v1/chat/completions (+SSE). model = profile name, optionally with a
// '#<conversation-id>' pin suffix; the X-Bridge-Conversation header wins on
// disagreement. All errors are OpenAI-shaped (handled by shared.sendError).
import {
  FacadeError, readJsonBody, sendError, jsonRes, errorBody, flattenContent, noteIgnoredParams,
  sseInit, sseFrame, writeIfOpen, collectDone, usageOpenaiChat, now, uuid,
} from '../shared.js';

const KNOWN = ['model', 'messages', 'stream', 'stream_options', 'n'];

export function parsePin(model, req) {
  const hash = model.indexOf('#');
  const profileName = hash === -1 ? model : model.slice(0, hash);
  const suffixPin = hash === -1 ? null : model.slice(hash + 1);
  const headerPin = req.headers['x-bridge-conversation'];
  return { profileName, suffixPin: suffixPin || null, headerPin: (typeof headerPin === 'string' && headerPin) ? headerPin : null };
}

function normalize(body, req) {
  if (typeof body.model !== 'string' || !body.model) {
    throw new FacadeError(400, 'invalid_request', 'you must provide a model parameter');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new FacadeError(400, 'invalid_request', 'messages must be a non-empty array');
  }
  if (body.n != null && body.n !== 1) {
    throw new FacadeError(400, 'invalid_request', 'the bridge supports only n=1');
  }
  const messages = body.messages.map((m, i) => {
    if (!m || typeof m.role !== 'string') throw new FacadeError(400, 'invalid_request', `messages[${i}].role is required`);
    return { role: m.role === 'developer' ? 'system' : m.role, text: flattenContent(m.content, `messages[${i}].content`) };
  });
  if (messages[messages.length - 1].role !== 'user') {
    throw new FacadeError(400, 'invalid_request', 'the final message must be a user message (the bridge cannot continue an assistant turn)');
  }
  const { profileName, suffixPin, headerPin } = parsePin(body.model, req);
  return {
    profileName, pinId: headerPin || suffixPin, messages,
    stream: body.stream === true,
    includeUsage: !!(body.stream_options && body.stream_options.include_usage),
  };
}

export function makeOpenaiChatHandler(ctx) {
  return async (req, res) => {
    let body;
    let norm;
    try {
      body = await readJsonBody(req);
      norm = normalize(body, req);
    } catch (e) {
      return sendError(res, 'openai', e);
    }
    noteIgnoredParams(body, KNOWN, 'chat.completions');
    const id = `chatcmpl-${uuid()}`;
    const created = now();
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let turn;
    try {
      turn = ctx.router.executeTurn({
        profileName: norm.profileName, pinId: norm.pinId, messages: norm.messages,
        signal: ac.signal, timeoutMs: ctx.config.promptTimeoutMs,
      });
    } catch (e) {
      return sendError(res, 'openai', e);
    }

    if (!norm.stream) {
      try {
        const done = await collectDone(turn.events);
        return jsonRes(res, 200, {
          id, object: 'chat.completion', created, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: done.text }, logprobs: null, finish_reason: 'stop' }],
          usage: usageOpenaiChat(done.usage),
          ...(done.usage.estimated ? { bridge: { usage_estimated: true } } : {}),
        });
      } catch (e) {
        return sendError(res, 'openai', e);
      }
    }

    sseInit(res);
    const chunk = (delta, finish = null) => ({
      id, object: 'chat.completion.chunk', created, model: body.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    });
    writeIfOpen(res, sseFrame(chunk({ role: 'assistant', content: '' })));
    try {
      for await (const ev of turn.events) {
        if (ev.type === 'delta') writeIfOpen(res, sseFrame(chunk({ content: ev.text })));
        else if (ev.type === 'done') {
          writeIfOpen(res, sseFrame(chunk({}, 'stop')));
          if (norm.includeUsage) {
            writeIfOpen(res, sseFrame({
              id, object: 'chat.completion.chunk', created, model: body.model, choices: [],
              usage: usageOpenaiChat(ev.usage),
              ...(ev.usage.estimated ? { bridge: { usage_estimated: true } } : {}),
            }));
          }
        }
      }
      writeIfOpen(res, 'data: [DONE]\n\n');
    } catch (e) {
      // Errors after streaming began (spec): a final error frame, then [DONE].
      const err = e instanceof FacadeError ? e : new FacadeError(500, 'api_error', String((e && e.message) || e));
      writeIfOpen(res, sseFrame(errorBody('openai', err)));
      writeIfOpen(res, 'data: [DONE]\n\n');
    }
    res.end();
  };
}
```

- [ ] **Step 5: Register the route** — in `src/facade/index.js` add `import { makeOpenaiChatHandler } from './dialects/openaiChat.js';` and inside `createFacade`:

```js
  if (config.facade.openaiChat) {
    routes.set('POST /v1/chat/completions', { family: 'openai', handler: makeOpenaiChatHandler(ctx) });
  }
```

- [ ] **Step 6: Run the tests, then the full suite**

Run: `node --test test/openaiChat.test.js` (foreground) → PASS.
Run: `npm test` → all pass.

- [ ] **Step 7: Commit**

```bash
git add src/facade/dialects/openaiChat.js src/facade/index.js scripts/helpers/sse.mjs test/openaiChat.test.js
git commit -m "feat(facade): OpenAI Chat Completions dialect (non-stream + SSE, pins, provider-shaped errors)"
```

---

### Task 10: OpenAI Responses dialect

**Files:**
- Create: `src/facade/dialects/openaiResponses.js`
- Modify: `src/facade/index.js` (register route)
- Test: `test/openaiResponses.test.js`

**Interfaces:**
- Consumes: `parsePin` from `openaiChat.js`, shared helpers, `router.executeTurn` (its `previousResponseId` param), `router.registerResponse`.
- Produces: `makeOpenaiResponsesHandler(ctx)` for `POST /v1/responses`.
  - Input normalization: `instructions` (string) → leading system message; `input` string → one user message; `input` array → message items (`{role, content}` with optional `type:'message'`; `developer`→`system`; content flattened, `input_text`/`output_text`/`text` parts accepted). Trailing item must be user.
  - Pin precedence: `X-Bridge-Conversation` header > `previous_response_id` > model `#` suffix. Unknown/expired `previous_response_id` → provider-shaped 404. `store` accepted and ignored silently (in KNOWN).
  - Every success registers a `resp_<uuid>` id (streaming too) via `router.registerResponse(turn.conv)`.
  - `KNOWN = ['model','input','instructions','stream','store','previous_response_id']`.
  - Non-stream body (full object, SDK-parseable):

```js
{
  id: respId, object: 'response', created_at: created, status: 'completed', background: false,
  error: null, incomplete_details: null, instructions: body.instructions ?? null,
  max_output_tokens: null, max_tool_calls: null, model: body.model,
  output: [{ id: msgId, type: 'message', status: 'completed', role: 'assistant',
             content: [{ type: 'output_text', annotations: [], logprobs: [], text: done.text }] }],
  parallel_tool_calls: true, previous_response_id: norm.previousResponseId ?? null,
  reasoning: { effort: null, summary: null }, store: true, temperature: null,
  text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [], top_p: null,
  truncation: 'disabled', usage: usageResponses(done.usage), user: null, metadata: {},
  ...(done.usage.estimated ? { bridge: { usage_estimated: true } } : {}),
}
```

  - Stream: `event:`-named frames, each data object carrying `type` and `sequence_number` (monotonic from 0), in the spec's minimum sequence: `response.created` → `response.in_progress` → `response.output_item.added` → `response.content_part.added` → `response.output_text.delta`× → `response.output_text.done` → `response.content_part.done` → `response.output_item.done` → `response.completed`. Errors after streaming began: OpenAI-family rule — a final `data: {"error":{…}}` frame then `data: [DONE]`. (Non-error streams do NOT end with `[DONE]` in the Responses API; `response.completed` is terminal.)

- [ ] **Step 1: Write failing tests** — create `test/openaiResponses.test.js` (same `boot`/`url`/`H`/`post` helpers as `test/openaiChat.test.js`, copied verbatim):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';
import { createFacade } from '../src/facade/index.js';
import { readSse } from '../scripts/helpers/sse.mjs';

const REPL = path.resolve('scripts/helpers/fake-repl.sh');

function boot(extraEnv = {}) {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '120', PROMPT_TIMEOUT_MS: '8000', ...extraEnv,
  });
  const manager = new SessionManager(config);
  const facade = createFacade(config, manager);
  const server = createHttpServer(config, manager, facade);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    config, manager, facade, server, port: server.address().port,
    close() { facade.close(); for (const r of manager.list()) manager.remove(r.id); server.close(); },
  })));
}
const url = (port, p) => `http://127.0.0.1:${port}${p}`;
const H = { authorization: 'Bearer tok', 'content-type': 'application/json' };
const post = (port, p, body, headers = {}) => fetch(url(port, p), { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify(body) });

test('non-streaming response: shape, string input, instructions as system', async () => {
  const b = await boot();
  const r = await post(b.port, '/v1/responses', { model: 'generic', input: 'hello', instructions: 'be terse' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.id, /^resp_/);
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  assert.equal(body.output[0].type, 'message');
  assert.equal(body.output[0].content[0].type, 'output_text');
  assert.match(body.output[0].content[0].text, /reply 1 to: hello/);
  assert.equal(body.usage.total_tokens, body.usage.input_tokens + body.usage.output_tokens);
  b.close();
});

test('previous_response_id continues the conversation; unknown id 404s', async () => {
  const b = await boot();
  const r1 = await (await post(b.port, '/v1/responses', { model: 'generic', input: 'one' })).json();
  const r2 = await (await post(b.port, '/v1/responses', { model: 'generic', input: 'two', previous_response_id: r1.id })).json();
  assert.match(r2.output[0].content[0].text, /reply 2 to: two/, 'same session — only the new input forwarded');
  assert.equal(r2.previous_response_id, r1.id);
  const r3 = await post(b.port, '/v1/responses', { model: 'generic', input: 'x', previous_response_id: 'resp_nope' });
  assert.equal(r3.status, 404);
  assert.equal((await r3.json()).error.type, 'invalid_request_error');
  b.close();
});

test('streaming: exact minimum event sequence with sequence numbers', async () => {
  const b = await boot();
  const r = await post(b.port, '/v1/responses', { model: 'generic', input: 'hello', stream: true });
  assert.equal(r.status, 200);
  const frames = await readSse(r);
  const types = frames.map((f) => f.event);
  assert.deepEqual(types.slice(0, 4), ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added']);
  assert.ok(types.includes('response.output_text.delta'));
  const tail = types.slice(types.indexOf('response.output_text.done'));
  assert.deepEqual(tail, ['response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed']);
  const seqs = frames.map((f) => JSON.parse(f.data).sequence_number);
  assert.deepEqual(seqs, seqs.map((_, i) => i), 'sequence_number is 0..n monotonic');
  const deltas = frames.filter((f) => f.event === 'response.output_text.delta').map((f) => JSON.parse(f.data).delta).join('');
  const final = JSON.parse(frames.at(-1).data).response;
  assert.equal(final.status, 'completed');
  assert.equal(deltas, final.output[0].content[0].text);
  assert.match(final.id, /^resp_/);
  b.close();
});

test('array input with parts; trailing non-user item 400s; non-message item 400s', async () => {
  const b = await boot();
  const ok = await post(b.port, '/v1/responses', { model: 'generic', input: [
    { role: 'user', content: [{ type: 'input_text', text: 'part one' }] },
  ] });
  assert.equal(ok.status, 200);
  const bad1 = await post(b.port, '/v1/responses', { model: 'generic', input: [
    { role: 'user', content: 'x' }, { role: 'assistant', content: 'y' },
  ] });
  assert.equal(bad1.status, 400);
  const bad2 = await post(b.port, '/v1/responses', { model: 'generic', input: [{ type: 'function_call', name: 'f' }] });
  assert.equal(bad2.status, 400);
  b.close();
});

test('streamed responses also register their id for later continuity', async () => {
  const b = await boot();
  const r = await post(b.port, '/v1/responses', { model: 'generic', input: 'first', stream: true });
  const frames = await readSse(r);
  const rid = JSON.parse(frames.at(-1).data).response.id;
  const r2 = await (await post(b.port, '/v1/responses', { model: 'generic', input: 'second', previous_response_id: rid })).json();
  assert.match(r2.output[0].content[0].text, /reply 2 to: second/);
  b.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/openaiResponses.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `src/facade/dialects/openaiResponses.js`**

```js
// src/facade/dialects/openaiResponses.js
// POST /v1/responses (+SSE). previous_response_id is an explicit pin to the
// conversation that produced that response (spec Translation rules); the
// X-Bridge-Conversation header outranks it, the model '#' suffix ranks below.
import {
  FacadeError, readJsonBody, sendError, jsonRes, errorBody, flattenContent, noteIgnoredParams,
  sseInit, sseEventFrame, sseFrame, writeIfOpen, collectDone, usageResponses, now, uuid,
} from '../shared.js';
import { parsePin } from './openaiChat.js';

const KNOWN = ['model', 'input', 'instructions', 'stream', 'store', 'previous_response_id'];

function normalize(body, req) {
  if (typeof body.model !== 'string' || !body.model) {
    throw new FacadeError(400, 'invalid_request', 'you must provide a model parameter');
  }
  const messages = [];
  if (body.instructions != null) {
    if (typeof body.instructions !== 'string') throw new FacadeError(400, 'invalid_request', 'instructions must be a string');
    messages.push({ role: 'system', text: body.instructions });
  }
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', text: body.input });
  } else if (Array.isArray(body.input)) {
    body.input.forEach((item, i) => {
      const isMessage = item && typeof item.role === 'string' && (item.type == null || item.type === 'message');
      if (!isMessage) throw new FacadeError(400, 'invalid_request', `input[${i}]: only message items are supported by the bridge`);
      messages.push({ role: item.role === 'developer' ? 'system' : item.role, text: flattenContent(item.content, `input[${i}].content`) });
    });
  } else {
    throw new FacadeError(400, 'invalid_request', 'input must be a string or an array of message items');
  }
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    throw new FacadeError(400, 'invalid_request', 'the final input item must be a user message');
  }
  const { profileName, suffixPin, headerPin } = parsePin(body.model, req);
  const previousResponseId = typeof body.previous_response_id === 'string' ? body.previous_response_id : null;
  // Precedence: header > previous_response_id > model suffix.
  const pinId = headerPin || (previousResponseId ? null : suffixPin);
  return { profileName, pinId, previousResponseId: headerPin ? null : previousResponseId, messages, stream: body.stream === true };
}

function responseBody({ respId, msgId, created, body, norm, text, usage }) {
  return {
    id: respId, object: 'response', created_at: created, status: 'completed', background: false,
    error: null, incomplete_details: null, instructions: body.instructions ?? null,
    max_output_tokens: null, max_tool_calls: null, model: body.model,
    output: [{ id: msgId, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', annotations: [], logprobs: [], text }] }],
    parallel_tool_calls: true, previous_response_id: norm.previousResponseId ?? null,
    reasoning: { effort: null, summary: null }, store: true, temperature: null,
    text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [], top_p: null,
    truncation: 'disabled', usage: usageResponses(usage), user: null, metadata: {},
    ...(usage.estimated ? { bridge: { usage_estimated: true } } : {}),
  };
}

export function makeOpenaiResponsesHandler(ctx) {
  return async (req, res) => {
    let body;
    let norm;
    try {
      body = await readJsonBody(req);
      norm = normalize(body, req);
    } catch (e) {
      return sendError(res, 'openai', e);
    }
    noteIgnoredParams(body, KNOWN, 'responses');
    const created = now();
    const msgId = `msg_${uuid()}`;
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let turn;
    try {
      turn = ctx.router.executeTurn({
        profileName: norm.profileName, pinId: norm.pinId, previousResponseId: norm.previousResponseId,
        messages: norm.messages, signal: ac.signal, timeoutMs: ctx.config.promptTimeoutMs,
      });
    } catch (e) {
      return sendError(res, 'openai', e);
    }

    if (!norm.stream) {
      try {
        const done = await collectDone(turn.events);
        const respId = ctx.router.registerResponse(turn.conv);
        return jsonRes(res, 200, responseBody({ respId, msgId, created, body, norm, text: done.text, usage: done.usage }));
      } catch (e) {
        return sendError(res, 'openai', e);
      }
    }

    sseInit(res);
    let seq = 0;
    const send = (type, extra) => writeIfOpen(res, sseEventFrame(type, { type, sequence_number: seq++, ...extra }));
    const respId = ctx.router.registerResponse(turn.conv);
    const skeleton = (status) => ({
      id: respId, object: 'response', created_at: created, status, background: false, error: null,
      incomplete_details: null, instructions: body.instructions ?? null, max_output_tokens: null,
      max_tool_calls: null, model: body.model, output: [], parallel_tool_calls: true,
      previous_response_id: norm.previousResponseId ?? null, reasoning: { effort: null, summary: null },
      store: true, temperature: null, text: { format: { type: 'text' } }, tool_choice: 'auto',
      tools: [], top_p: null, truncation: 'disabled', usage: null, user: null, metadata: {},
    });
    send('response.created', { response: skeleton('in_progress') });
    send('response.in_progress', { response: skeleton('in_progress') });
    send('response.output_item.added', { output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    send('response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', annotations: [], text: '' } });
    try {
      let done = null;
      for await (const ev of turn.events) {
        if (ev.type === 'delta') send('response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: ev.text, logprobs: [] });
        else if (ev.type === 'done') done = ev;
      }
      if (!done) throw new FacadeError(500, 'api_error', 'turn ended without a result');
      send('response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text: done.text, logprobs: [] });
      const part = { type: 'output_text', annotations: [], text: done.text };
      send('response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part });
      send('response.output_item.done', { output_index: 0, item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [part] } });
      const final = responseBody({ respId, msgId, created, body, norm, text: done.text, usage: done.usage });
      send('response.completed', { response: final });
    } catch (e) {
      const err = e instanceof FacadeError ? e : new FacadeError(500, 'api_error', String((e && e.message) || e));
      writeIfOpen(res, sseFrame(errorBody('openai', err)));
      writeIfOpen(res, 'data: [DONE]\n\n');
    }
    res.end();
  };
}
```

- [ ] **Step 4: Register** in `src/facade/index.js`:

```js
  if (config.facade.openaiResponses) {
    routes.set('POST /v1/responses', { family: 'openai', handler: makeOpenaiResponsesHandler(ctx) });
  }
```

- [ ] **Step 5: Run tests, full suite, commit**

Run: `node --test test/openaiResponses.test.js` → PASS. `npm test` → all pass.

```bash
git add src/facade/dialects/openaiResponses.js src/facade/index.js test/openaiResponses.test.js
git commit -m "feat(facade): OpenAI Responses dialect with previous_response_id continuity and spec SSE sequence"
```

---

### Task 11: Anthropic Messages dialect

**Files:**
- Create: `src/facade/dialects/anthropicMessages.js`
- Modify: `src/facade/index.js` (register route — family `'anthropic'`, which makes the auth gate accept `x-api-key`)
- Test: `test/anthropicMessages.test.js`

**Interfaces:**
- Consumes: `parsePin`, shared helpers.
- Produces: `makeAnthropicMessagesHandler(ctx)` for `POST /v1/messages`.
  - `system` param (string or array of `{type:'text',text}` blocks) → leading `(system, text)` tuple in the normalized sequence (spec: two conversations differing only in system prompt never collide — this falls out of fingerprinting the normalized sequence).
  - Trailing non-user message → 400 "assistant prefill is not supported by the bridge".
  - Roles must be `user`/`assistant` (400 otherwise).
  - Non-stream body: `{ id: 'msg_<uuid>', type: 'message', role: 'assistant', model, content: [{type:'text', text}], stop_reason: 'end_turn', stop_sequence: null, usage, bridge? }`.
  - Stream frames (each `event:`-named): `message_start` (message skeleton, usage zeros) → `content_block_start` (index 0, empty text block) → `content_block_delta`× (`text_delta`) → `content_block_stop` → `message_delta` (`{stop_reason:'end_turn', stop_sequence:null}` + usage + bridge flag) → `message_stop`. Mid-stream errors: `event: error` frame (native Anthropic rule), then close — no message_stop.
  - `KNOWN = ['model','messages','system','stream']` (`max_tokens` etc. logged-ignored).

- [ ] **Step 1: Write failing tests** — create `test/anthropicMessages.test.js` (same boot helpers again):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';
import { createFacade } from '../src/facade/index.js';
import { readSse } from '../scripts/helpers/sse.mjs';

const REPL = path.resolve('scripts/helpers/fake-repl.sh');

function boot(extraEnv = {}) {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '120', PROMPT_TIMEOUT_MS: '8000', ...extraEnv,
  });
  const manager = new SessionManager(config);
  const facade = createFacade(config, manager);
  const server = createHttpServer(config, manager, facade);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    config, manager, facade, server, port: server.address().port,
    close() { facade.close(); for (const r of manager.list()) manager.remove(r.id); server.close(); },
  })));
}
const url = (port, p) => `http://127.0.0.1:${port}${p}`;
const post = (port, body, headers) => fetch(url(port, '/v1/messages'), {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('x-api-key auth works; missing auth is anthropic-shaped 401', async () => {
  const b = await boot();
  const ok = await post(b.port, { model: 'generic', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] },
    { 'x-api-key': 'tok' });
  assert.equal(ok.status, 200);
  const bad = await post(b.port, { model: 'generic', messages: [{ role: 'user', content: 'x' }] }, {});
  assert.equal(bad.status, 401);
  const e = await bad.json();
  assert.equal(e.type, 'error');
  assert.equal(e.error.type, 'authentication_error');
  b.close();
});

test('non-streaming message shape', async () => {
  const b = await boot();
  const r = await post(b.port, { model: 'generic', max_tokens: 50, messages: [{ role: 'user', content: 'ping' }] }, { 'x-api-key': 'tok' });
  const body = await r.json();
  assert.match(body.id, /^msg_/);
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.stop_reason, 'end_turn');
  assert.equal(body.content[0].type, 'text');
  assert.match(body.content[0].text, /reply \d+ to: ping/);
  assert.ok(body.usage.input_tokens >= 1 && body.usage.output_tokens >= 1);
  assert.deepEqual(body.bridge, { usage_estimated: true });
  b.close();
});

test('system param participates in continuity: same system+history sticks, changed system reseeds', async () => {
  const b = await boot();
  const mk = (msgs) => ({ model: 'generic', max_tokens: 50, system: 'be terse', messages: msgs });
  const r1 = await (await post(b.port, mk([{ role: 'user', content: 'one' }]), { 'x-api-key': 'tok' })).json();
  const t1 = r1.content[0].text;
  const r2 = await (await post(b.port, mk([
    { role: 'user', content: 'one' }, { role: 'assistant', content: t1 }, { role: 'user', content: 'two' },
  ]), { 'x-api-key': 'tok' })).json();
  assert.match(r2.content[0].text, /reply 2 to: two/, 'sticky with unchanged system');
  const r3 = await (await post(b.port, { model: 'generic', max_tokens: 50, system: 'DIFFERENT', messages: [
    { role: 'user', content: 'one' }, { role: 'assistant', content: t1 }, { role: 'user', content: 'three' },
  ] }, { 'x-api-key': 'tok' })).json();
  assert.ok(!/reply 3 to: three/.test(r3.content[0].text), 'changed system must reseed a fresh session');
  b.close();
});

test('assistant prefill rejected 400', async () => {
  const b = await boot();
  const r = await post(b.port, { model: 'generic', max_tokens: 50, messages: [
    { role: 'user', content: 'x' }, { role: 'assistant', content: 'The answer is' },
  ] }, { 'x-api-key': 'tok' });
  assert.equal(r.status, 400);
  const e = await r.json();
  assert.equal(e.error.type, 'invalid_request_error');
  assert.match(e.error.message, /prefill/);
  b.close();
});

test('streaming frame sequence', async () => {
  const b = await boot();
  const r = await post(b.port, { model: 'generic', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'PARA' }] }, { 'x-api-key': 'tok' });
  assert.equal(r.status, 200);
  const frames = await readSse(r);
  const types = frames.map((f) => f.event);
  assert.equal(types[0], 'message_start');
  assert.equal(types[1], 'content_block_start');
  assert.ok(types.includes('content_block_delta'));
  assert.deepEqual(types.slice(-3), ['content_block_stop', 'message_delta', 'message_stop']);
  const text = frames.filter((f) => f.event === 'content_block_delta').map((f) => JSON.parse(f.data).delta.text).join('');
  assert.match(text, /first paragraph\n\nsecond paragraph/);
  const md = JSON.parse(frames[types.indexOf('message_delta')].data);
  assert.equal(md.delta.stop_reason, 'end_turn');
  assert.ok(md.usage.output_tokens >= 1);
  b.close();
});

test('unknown model → anthropic not_found_error', async () => {
  const b = await boot();
  const r = await post(b.port, { model: 'claude-sonnet-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }, { 'x-api-key': 'tok' });
  assert.equal(r.status, 404);
  const e = await r.json();
  assert.equal(e.error.type, 'not_found_error');
  b.close();
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/anthropicMessages.test.js` → FAIL.

- [ ] **Step 3: Implement `src/facade/dialects/anthropicMessages.js`**

```js
// src/facade/dialects/anthropicMessages.js
// POST /v1/messages (+SSE). The facade auth gate accepts x-api-key for this
// family (see index.js). The top-level `system` parameter canonicalizes to a
// leading (system, text) tuple in the normalized sequence, so fingerprinting
// naturally separates conversations that differ only in system prompt.
// Assistant prefill (trailing non-user message) is unsupported → 400.
import {
  FacadeError, readJsonBody, sendError, jsonRes, errorBody, flattenContent, noteIgnoredParams,
  sseInit, sseEventFrame, writeIfOpen, collectDone, usageAnthropic, uuid,
} from '../shared.js';
import { parsePin } from './openaiChat.js';

const KNOWN = ['model', 'messages', 'system', 'stream'];

function normalize(body, req) {
  if (typeof body.model !== 'string' || !body.model) {
    throw new FacadeError(400, 'invalid_request', 'model: field required');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new FacadeError(400, 'invalid_request', 'messages: field required and must be non-empty');
  }
  const messages = [];
  if (body.system != null) {
    const text = typeof body.system === 'string' ? body.system : flattenContent(body.system, 'system');
    messages.push({ role: 'system', text });
  }
  body.messages.forEach((m, i) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      throw new FacadeError(400, 'invalid_request', `messages[${i}].role must be "user" or "assistant"`);
    }
    messages.push({ role: m.role, text: flattenContent(m.content, `messages[${i}].content`) });
  });
  if (messages[messages.length - 1].role !== 'user') {
    throw new FacadeError(400, 'invalid_request', 'assistant prefill is not supported by the bridge: the final message must have role "user"');
  }
  const { profileName, suffixPin, headerPin } = parsePin(body.model, req);
  return { profileName, pinId: headerPin || suffixPin, messages, stream: body.stream === true };
}

export function makeAnthropicMessagesHandler(ctx) {
  return async (req, res) => {
    let body;
    let norm;
    try {
      body = await readJsonBody(req);
      norm = normalize(body, req);
    } catch (e) {
      return sendError(res, 'anthropic', e);
    }
    noteIgnoredParams(body, KNOWN, 'messages');
    const id = `msg_${uuid()}`;
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let turn;
    try {
      turn = ctx.router.executeTurn({
        profileName: norm.profileName, pinId: norm.pinId, messages: norm.messages,
        signal: ac.signal, timeoutMs: ctx.config.promptTimeoutMs,
      });
    } catch (e) {
      return sendError(res, 'anthropic', e);
    }

    if (!norm.stream) {
      try {
        const done = await collectDone(turn.events);
        return jsonRes(res, 200, {
          id, type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: done.text }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: usageAnthropic(done.usage),
          ...(done.usage.estimated ? { bridge: { usage_estimated: true } } : {}),
        });
      } catch (e) {
        return sendError(res, 'anthropic', e);
      }
    }

    sseInit(res);
    const send = (event, obj) => writeIfOpen(res, sseEventFrame(event, obj));
    send('message_start', { type: 'message_start', message: {
      id, type: 'message', role: 'assistant', model: body.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    } });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    try {
      let done = null;
      for await (const ev of turn.events) {
        if (ev.type === 'delta') send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ev.text } });
        else if (ev.type === 'done') done = ev;
      }
      if (!done) throw new FacadeError(500, 'api_error', 'turn ended without a result');
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: usageAnthropic(done.usage),
        ...(done.usage.estimated ? { bridge: { usage_estimated: true } } : {}) });
      send('message_stop', { type: 'message_stop' });
    } catch (e) {
      // Native Anthropic mid-stream error framing (spec): event: error, then close.
      const err = e instanceof FacadeError ? e : new FacadeError(500, 'api_error', String((e && e.message) || e));
      send('error', errorBody('anthropic', err));
    }
    res.end();
  };
}
```

- [ ] **Step 4: Register** in `src/facade/index.js`:

```js
  if (config.facade.anthropicMessages) {
    routes.set('POST /v1/messages', { family: 'anthropic', handler: makeAnthropicMessagesHandler(ctx) });
  }
```

- [ ] **Step 5: Run tests, full suite, commit**

Run: `node --test test/anthropicMessages.test.js` → PASS. `npm test` → all pass.

```bash
git add src/facade/dialects/anthropicMessages.js src/facade/index.js test/anthropicMessages.test.js
git commit -m "feat(facade): Anthropic Messages dialect (x-api-key, system canonicalization, native SSE frames)"
```

---

### Task 12: Error-path & continuity integration through the HTTP surface

End-to-end proof of the Error-handling section through real dialect routes: dialog → provider error → `POST /key` → retry-attach; settle-timeout 504 + self-heal; streaming mid-turn error framing per family; client disconnect leaves the session consistent.

**Files:**
- Test: `test/facadeErrors.test.js` (no production code expected; any failure here is a bug in Tasks 6–11 — fix it where it lives)

- [ ] **Step 1: Write the tests** — create `test/facadeErrors.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';
import { createFacade } from '../src/facade/index.js';
import { readSse } from '../scripts/helpers/sse.mjs';

const REPL = path.resolve('scripts/helpers/fake-repl.sh');
const DIALOG_REPL = path.resolve('scripts/helpers/fake-dialog-repl.sh');

function boot(extraEnv = {}) {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '120', PROMPT_TIMEOUT_MS: '8000',
    PROFILE_CLAUDE_COMMAND: 'bash', PROFILE_CLAUDE_ARGS: JSON.stringify([DIALOG_REPL]),
    PROFILE_CLAUDE_DIALOG_POLICY: 'never', PROFILE_CLAUDE_QUIESCENCE_MS: '120', PROFILE_CLAUDE_CWD: process.cwd(),
    ...extraEnv,
  });
  const manager = new SessionManager(config);
  const facade = createFacade(config, manager);
  const server = createHttpServer(config, manager, facade);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    config, manager, facade, server, port: server.address().port,
    close() { facade.close(); for (const r of manager.list()) manager.remove(r.id); server.close(); },
  })));
}
const url = (port, p) => `http://127.0.0.1:${port}${p}`;
const H = { authorization: 'Bearer tok', 'content-type': 'application/json' };
const post = (port, p, body, headers = {}) => fetch(url(port, p), { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify(body) });

test('dialog mid-turn → 409 with session id; POST /key answers; identical retry attaches', async () => {
  const b = await boot();
  const reqBody = { model: 'claude', messages: [{ role: 'user', content: 'DIALOG' }] };
  const r1 = await post(b.port, '/v1/chat/completions', reqBody);
  assert.equal(r1.status, 409);
  const e1 = await r1.json();
  assert.equal(e1.error.code, 'bridge_dialog_pending');
  assert.match(e1.bridge.dialog, /Quick safety check/);
  const sid = e1.bridge.session_id;
  assert.ok(sid);
  // still blocked → same dialog error on retry
  const r2 = await post(b.port, '/v1/chat/completions', reqBody);
  assert.equal(r2.status, 409);
  // operator answers through the EXISTING bridge API
  const k = await fetch(url(b.port, `/api/sessions/${sid}/key`), { method: 'POST', headers: H, body: JSON.stringify({ keys: ['enter'] }) });
  assert.equal(k.status, 200);
  await new Promise((r) => setTimeout(r, 600)); // let the detector settle idle
  // identical retry attaches to the pending turn and returns the extracted text
  const r3 = await post(b.port, '/v1/chat/completions', reqBody);
  assert.equal(r3.status, 200, JSON.stringify(await r3.clone().json().catch(() => null)));
  const done = await r3.json();
  assert.match(done.choices[0].message.content, /dialog answered/);
  b.close();
});

test('settle timeout → provider-shaped 504; conversation self-heals for the next request', async () => {
  const b = await boot({ PROMPT_TIMEOUT_MS: '400' });
  const r1 = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'SPAM' }] });
  assert.equal(r1.status, 504);
  const e1 = await r1.json();
  assert.equal(e1.error.type, 'api_error');
  assert.equal(e1.error.code, 'bridge_settle_timeout');
  // wait out the spam, then a fresh conversation on the SAME (suspect) session pool works
  await new Promise((r) => setTimeout(r, 2000));
  const r2 = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'recovered' }] });
  assert.equal(r2.status, 200);
  assert.match((await r2.json()).choices[0].message.content, /reply \d+ to: recovered/);
  b.close();
});

test('mid-stream failure framing: openai gets error frame + [DONE]; anthropic gets event:error', async () => {
  const b = await boot({ PROMPT_TIMEOUT_MS: '600' });
  const r = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'SPAM' }], stream: true });
  assert.equal(r.status, 200, 'status was already 200 when the stream started');
  const frames = await readSse(r);
  assert.equal(frames.at(-1).data, '[DONE]');
  const errFrame = JSON.parse(frames.at(-2).data);
  assert.equal(errFrame.error.type, 'api_error');
  const ra = await post(b.port, '/v1/messages', { model: 'generic', max_tokens: 5, stream: true, messages: [{ role: 'user', content: 'SPAM' }] }, { 'x-api-key': 'tok' });
  const aframes = await readSse(ra);
  assert.equal(aframes.at(-1).event, 'error');
  assert.equal(JSON.parse(aframes.at(-1).data).error.type, 'api_error');
  b.close();
});

test('client disconnect mid-stream: CLI finishes in background, session stays alive and idle', async () => {
  const b = await boot();
  const ac = new AbortController();
  const p = fetch(url(b.port, '/v1/chat/completions'), {
    method: 'POST', headers: H, signal: ac.signal,
    body: JSON.stringify({ model: 'generic', messages: [{ role: 'user', content: 'SPAM' }], stream: true }),
  });
  const resp = await p;
  const reader = resp.body.getReader();
  await reader.read(); // first chunk arrived — stream is live
  ac.abort();
  await new Promise((r) => setTimeout(r, 2500)); // spam finishes in background
  const sessions = b.manager.list();
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0].session.alive, 'no ESC-interrupt on disconnect');
  assert.equal(sessions[0].detector.state, 'idle');
  b.close();
});

test('session exited mid-turn → 500; next request transparently reseeds', async () => {
  const b = await boot();
  const r1 = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'EXIT' }] });
  assert.equal(r1.status, 500);
  const r2 = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'EXIT' }, { role: 'assistant', content: 'gone' }, { role: 'user', content: 'fresh' }] });
  assert.equal(r2.status, 200);
  assert.match((await r2.json()).choices[0].message.content, /reply \d+ to: fresh/);
  b.close();
});

test('listed model whose process fails to spawn → 500 api_error with bridge.spawn_error', async () => {
  // codex is enabled by default; point its command at a nonexistent binary.
  const b = await boot({ PROFILE_CODEX_COMMAND: '/nonexistent-cli-binary-xyz' });
  const m = await fetch(url(b.port, '/v1/models'), { headers: { authorization: 'Bearer tok' } });
  assert.ok((await m.json()).data.some((x) => x.id === 'codex'), 'still listed (command is set, just broken)');
  const r = await post(b.port, '/v1/chat/completions', { model: 'codex', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 500);
  const e = await r.json();
  assert.equal(e.error.type, 'api_error');
  assert.ok(e.bridge && e.bridge.spawn_error, `spawn error missing from bridge field: ${JSON.stringify(e)}`);
  b.close();
});
```

- [ ] **Step 2: Run**

Run: `node --test test/facadeErrors.test.js` (foreground; ~20-30s)
Expected: PASS. Any failure is a real bug in Tasks 6–11 — debug with `superpowers:systematic-debugging`, fix in the owning module, and note the fix in the commit.

- [ ] **Step 3: Full suite + commit**

Run: `npm test` → all pass.

```bash
git add test/facadeErrors.test.js
git commit -m "test(facade): end-to-end error paths — dialog retry-attach, timeout self-heal, stream error framing, disconnect"
```

---

### Task 13: Official-SDK acceptance tests

The spec's acceptance proof: unmodified `openai` and `@anthropic-ai/sdk` clients pointed at the bridge, streaming + non-streaming, multi-turn stickiness, explicit pinning, headless model — all against the fake REPL / stub (no subscription usage).

**Files:**
- Modify: `package.json` (devDependencies)
- Test: `test/sdkAcceptance.test.js`

- [ ] **Step 1: Install SDKs as devDependencies**

Run: `npm install --save-dev openai @anthropic-ai/sdk`
Expected: both install cleanly on Node 20 (openai ≥5 supports Node 20; if the latest major refuses the engine, pin the newest major that supports Node 20 and record it in the commit message).

- [ ] **Step 2: Write the tests** — create `test/sdkAcceptance.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';
import { createFacade } from '../src/facade/index.js';

const REPL = path.resolve('scripts/helpers/fake-repl.sh');
const STUB = path.resolve('scripts/helpers/claude-stub.mjs');

function boot(extraEnv = {}) {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '120', PROMPT_TIMEOUT_MS: '8000',
    PROFILE_CLAUDE_HEADLESS_COMMAND: STUB, PROFILE_CLAUDE_HEADLESS_CWD: process.cwd(),
    ...extraEnv,
  });
  const manager = new SessionManager(config);
  const facade = createFacade(config, manager);
  const server = createHttpServer(config, manager, facade);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    config, manager, facade, server, port: server.address().port,
    close() { facade.close(); for (const r of manager.list()) manager.remove(r.id); server.close(); },
  })));
}

test('openai SDK: chat non-stream + multi-turn stickiness', async () => {
  const b = await boot();
  const client = new OpenAI({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}/v1` });
  const r1 = await client.chat.completions.create({ model: 'generic', messages: [{ role: 'user', content: 'hello' }] });
  assert.match(r1.choices[0].message.content, /reply 1 to: hello/);
  const r2 = await client.chat.completions.create({ model: 'generic', messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: r1.choices[0].message.content },
    { role: 'user', content: 'again' },
  ] });
  assert.match(r2.choices[0].message.content, /reply 2 to: again/);
  assert.equal(b.manager.list().length, 1, 'one session served both turns');
  b.close();
});

test('openai SDK: chat streaming', async () => {
  const b = await boot();
  const client = new OpenAI({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}/v1` });
  const stream = await client.chat.completions.create({ model: 'generic', stream: true, messages: [{ role: 'user', content: 'PARA' }] });
  let text = '';
  for await (const chunk of stream) text += chunk.choices[0]?.delta?.content || '';
  assert.match(text, /first paragraph\n\nsecond paragraph/);
  b.close();
});

test('openai SDK: models.list and native NotFoundError', async () => {
  const b = await boot();
  const client = new OpenAI({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}/v1` });
  const models = await client.models.list();
  assert.ok(models.data.some((m) => m.id === 'generic'));
  await assert.rejects(
    () => client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
    OpenAI.NotFoundError);
  b.close();
});

test('openai SDK: explicit pin via model suffix survives history-free requests', async () => {
  const b = await boot();
  const client = new OpenAI({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}/v1` });
  const r1 = await client.chat.completions.create({ model: 'generic#pinned', messages: [{ role: 'user', content: 'one' }] });
  assert.match(r1.choices[0].message.content, /reply 1 to: one/);
  const r2 = await client.chat.completions.create({ model: 'generic#pinned', messages: [{ role: 'user', content: 'two' }] });
  assert.match(r2.choices[0].message.content, /reply 2 to: two/);
  b.close();
});

test('openai SDK: responses non-stream, previous_response_id, streaming', async () => {
  const b = await boot();
  const client = new OpenAI({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}/v1` });
  const r1 = await client.responses.create({ model: 'generic', input: 'first' });
  assert.match(r1.output[0].content[0].text, /reply 1 to: first/);
  const r2 = await client.responses.create({ model: 'generic', input: 'second', previous_response_id: r1.id });
  assert.match(r2.output[0].content[0].text, /reply 2 to: second/);
  const stream = await client.responses.create({ model: 'generic', input: 'third', previous_response_id: r2.id, stream: true });
  let deltas = '';
  let completed = null;
  for await (const ev of stream) {
    if (ev.type === 'response.output_text.delta') deltas += ev.delta;
    if (ev.type === 'response.completed') completed = ev.response;
  }
  assert.match(deltas, /reply 3 to: third/);
  assert.equal(completed.status, 'completed');
  b.close();
});

test('anthropic SDK: messages non-stream + streaming + native BadRequestError on prefill', async () => {
  const b = await boot();
  const client = new Anthropic({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}` });
  const m1 = await client.messages.create({ model: 'generic', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] });
  assert.match(m1.content[0].text, /reply 1 to: hello/);
  const stream = client.messages.stream({ model: 'generic', max_tokens: 100, messages: [
    { role: 'user', content: 'hello' }, { role: 'assistant', content: m1.content[0].text }, { role: 'user', content: 'PARA' },
  ] });
  const final = await stream.finalMessage();
  assert.match(final.content[0].text, /first paragraph\n\nsecond paragraph/);
  assert.equal(final.stop_reason, 'end_turn');
  await assert.rejects(
    () => client.messages.create({ model: 'generic', max_tokens: 5, messages: [
      { role: 'user', content: 'x' }, { role: 'assistant', content: 'prefill' },
    ] }),
    Anthropic.BadRequestError);
  b.close();
});

test('headless model through the openai SDK: real usage, resume continuity', async () => {
  const b = await boot();
  const client = new OpenAI({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}/v1` });
  const r1 = await client.chat.completions.create({ model: 'claude-headless', messages: [{ role: 'user', content: 'alpha' }] });
  assert.equal(r1.choices[0].message.content, 'turn 1 reply to: alpha');
  assert.equal(r1.usage.prompt_tokens, 42, 'REAL usage from the result event');
  assert.equal(r1.usage.completion_tokens, 7);
  assert.equal(r1.bridge, undefined, 'no usage_estimated flag on the headless path');
  const r2 = await client.chat.completions.create({ model: 'claude-headless', messages: [
    { role: 'user', content: 'alpha' },
    { role: 'assistant', content: r1.choices[0].message.content },
    { role: 'user', content: 'beta' },
  ] });
  assert.equal(r2.choices[0].message.content, 'turn 2 reply to: beta', '--resume chained');
  b.close();
});

test('anthropic SDK streaming against the headless model (text_delta passthrough)', async () => {
  const b = await boot();
  const client = new Anthropic({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}` });
  const stream = client.messages.stream({ model: 'claude-headless', max_tokens: 100, messages: [{ role: 'user', content: 'streamme' }] });
  const final = await stream.finalMessage();
  assert.equal(final.content[0].text, 'turn 1 reply to: streamme');
  assert.equal(final.usage.output_tokens, 7);
  b.close();
});
```

- [ ] **Step 3: Run (foreground!)**

Run: `node --test test/sdkAcceptance.test.js`
Expected: PASS. Known SDK quirks to check if not: (a) openai SDK v5+ throws client-side if `apiKey` missing — ours is set; (b) `client.responses` requires openai ≥ 4.87 — we installed latest; (c) Anthropic SDK sends `x-api-key` (not Bearer) — that's exactly what the anthropic family gate accepts; (d) if the Anthropic SDK validates response `model` names client-side it doesn't — it echoes.

- [ ] **Step 4: Full suite + commit**

Run: `npm test` → all pass (now including the SDK suite).

```bash
git add package.json package-lock.json test/sdkAcceptance.test.js
git commit -m "test(facade): official openai + anthropic SDK acceptance against the bridge (streaming, stickiness, pins, headless)"
```

---

### Task 14: Live-acceptance script, docs, spec addendum, final verification

**Files:**
- Create: `scripts/live-acceptance.mjs`
- Modify: `README.md`, `docs/API.md`, `docs/superpowers/specs/2026-07-23-universal-cli-and-api-facade-design.md` (addendum only)

- [ ] **Step 1: Create `scripts/live-acceptance.mjs`** (opt-in, consumes subscription quota, NEVER run in CI):

```js
#!/usr/bin/env node
// Live acceptance (spec Testing §4): drives REAL CLIs through the official
// SDKs against an in-process bridge. Opt-in and manual — consumes
// subscription quota. Usage:
//   node scripts/live-acceptance.mjs [profile ...]   # default: claude claude-headless codex
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';
import { createFacade } from '../src/facade/index.js';

const profiles = process.argv.slice(2).length ? process.argv.slice(2) : ['claude', 'claude-headless', 'codex'];
const config = loadConfig({ ...process.env, BRIDGE_TOKEN: process.env.BRIDGE_TOKEN || 'live-tok' });
const manager = new SessionManager(config);
const facade = createFacade(config, manager);
const server = createHttpServer(config, manager, facade);
const port = await new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
const openai = new OpenAI({ apiKey: config.token, baseURL: `http://127.0.0.1:${port}/v1` });
const anthropic = new Anthropic({ apiKey: config.token, baseURL: `http://127.0.0.1:${port}` });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

for (const profile of profiles) {
  console.log(`\n=== ${profile} ===`);
  try {
    const r = await openai.chat.completions.create({ model: profile, messages: [{ role: 'user', content: 'reply with exactly: PONG' }] });
    const text = r.choices[0].message.content;
    check(`${profile} openai non-stream`, /PONG/.test(text), JSON.stringify(text.slice(0, 120)));
    const stream = await openai.chat.completions.create({ model: profile, stream: true, messages: [
      { role: 'user', content: 'reply with exactly: PONG' },
      { role: 'assistant', content: text },
      { role: 'user', content: 'reply with exactly: DONG' },
    ] });
    let streamed = '';
    for await (const c of stream) streamed += c.choices[0]?.delta?.content || '';
    check(`${profile} openai stream + stickiness`, /DONG/.test(streamed), JSON.stringify(streamed.slice(0, 120)));
    const a = await anthropic.messages.create({ model: profile, max_tokens: 100, messages: [{ role: 'user', content: 'reply with exactly: PING' }] });
    check(`${profile} anthropic non-stream`, /PING/.test(a.content[0].text), JSON.stringify(a.content[0].text.slice(0, 120)));
  } catch (e) {
    check(`${profile}`, false, String(e.message || e).slice(0, 200));
  }
}

facade.close();
for (const r of manager.list()) manager.remove(r.id);
server.close();
console.log(failures ? `\n${failures} FAILURES` : '\nall live checks passed');
process.exit(failures ? 1 : 0);
```

`chmod +x scripts/live-acceptance.mjs`. Verify it is NOT picked up by `npm test` (it isn't — `scripts/` matches no test glob; confirm the test count is unchanged).

- [ ] **Step 2: README** — add a `## Cloud-API facade` section after the existing API docs covering: what it is (point tools expecting an OpenAI/Anthropic endpoint at the bridge); base URLs (`http://127.0.0.1:7681/v1` for OpenAI SDKs, `http://127.0.0.1:7681` for the Anthropic SDK); the bridge token as API key (`Authorization: Bearer` / `x-api-key`); `model` = profile name (list via `GET /v1/models`); conversation continuity (automatic fingerprint stickiness; explicit pinning via `model: "claude#my-conv"` or `X-Bridge-Conversation`; `previous_response_id` on the Responses API); the env vars (three `FACADE_*` toggles + `FACADE_SESSION_TTL_MS`, `FACADE_PINNED_TTL_MS`, `FACADE_MAX_SESSIONS`, `FACADE_COLS` with defaults); usage semantics (PTY = estimated chars/4, flagged `bridge.usage_estimated`; `claude-headless` = real usage); dialog errors (409 `bridge_dialog_pending`, answer via `POST /api/sessions/<id>/key`, then retry the identical request); security restatement (same single-token trust level; handing out the URL+token grants full control of enabled CLIs; blast-radius controls = `BRIDGE_PROFILES` + the facade toggles); non-goals (sampling params ignored and logged once); and `node scripts/live-acceptance.mjs` for live verification. Include a copy-paste python + node snippet for each SDK.

- [ ] **Step 3: docs/API.md** — document the four routes (`GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`) with request/response examples (non-stream + one SSE transcript each), the error-shape table (status/kind → openai/anthropic bodies, incl. 409 dialog with `bridge` fields, 429 at-capacity, 504 settle-timeout), and the pin/continuity rules (header > previous_response_id > model suffix; reaped pins recover by reseeding).

- [ ] **Step 4: Spec addendum** — at the top of `docs/superpowers/specs/2026-07-23-universal-cli-and-api-facade-design.md`, under the Status line, insert:

```markdown
> **Addendum (2026-07-24, Phase 1 as-built):** the `gemini` profile described
> below shipped as **`antigravity`** (command `agy`, adapter `antigravity`) —
> Google sunset the standalone gemini CLI's OAuth for individual accounts
> mid-implementation. Wherever this spec says `gemini`, read `antigravity`.
> The `copilot` adapter shipped **fully verified** (gh-keyring auth), not as
> the anticipated stub. `antigravity` and `copilot` are alt-screen "degraded":
> state detection is fixture-verified but PTY `extractResponse` is
> best-effort — the headless runner is the fidelity path for such CLIs.
```

- [ ] **Step 5: Final verification**

Run: `npm test` (foreground) → all pass; record the final count.
Run: `node scripts/live-acceptance.mjs claude` — OPTIONAL, only if explicitly approved to spend quota; otherwise skip and note it was not run.

- [ ] **Step 6: Commit**

```bash
git add scripts/live-acceptance.mjs README.md docs/API.md docs/superpowers/specs/2026-07-23-universal-cli-and-api-facade-design.md
git commit -m "docs(facade): README + API docs, live-acceptance script, spec as-built addendum"
```

---

## Execution notes for the controller

- **Task order is dependency order**; do not parallelize tasks that touch `src/facade/index.js` or `src/facade/router.js` (3, 4, 8, 9, 10, 11).
- **Run every test invocation foreground.** If dispatching subagents, put "run `npm test` in the foreground and wait for it; do NOT background it" in every implementer prompt (Phase-1 lesson).
- Tasks 12 and 13 are integration-heavy (many PTY spawns); if a subagent stalls on them, pull them controller-side and dispatch only reviewers (Phase-1 workaround).
- The full suite grows to roughly 170+ tests and ~2-3 minutes; keep `npm test` as the gate after every task.
- After Task 14: final whole-branch review (superpowers:requesting-code-review), then merge via PR like Phase 1.
