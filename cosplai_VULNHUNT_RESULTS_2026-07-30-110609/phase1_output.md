# Phase 1 — Reconnaissance: cosplai

Target: `/home/kali/repos/cosplai` (branch `main`, HEAD `4dc607b`)

---

## Attack Surface Report

**Languages**: JavaScript (ESM, Node.js ≥ 20). No TS/Go/Java/Python/Rust production code.
One HTML/inline-JS client (`public/index.html`). Vendored third-party browser
assets under `public/vendor/` (xterm.js, addon-fit) — excluded from analysis as
third-party, but their *serving path* is in scope.

**Frameworks / libraries** (`package.json`):
- No web framework — raw `node:http` server (`src/httpApi.js`)
- `ws` (WebSocket server, `src/wsApi.js`)
- `node-pty` (PTY process spawn, `src/session.js`)
- `@xterm/headless` (server-side terminal emulation, `src/terminalModel.js`)
- `node:child_process` `spawn`/`execFile` (headless runners, version handshake)
- No ORM, no SQL, no template engine, no crypto beyond `node:crypto`
  (`randomUUID`, `randomBytes`, `timingSafeEqual`, `createHash`)

**What the app is**: a local "bridge" that spawns *interactive AI coding CLIs*
(claude, codex, agy/antigravity, copilot) inside PTYs and exposes them three ways:
(a) a raw terminal over WebSocket, (b) a small session REST API, and (c) a
**cloud-API façade** that impersonates the OpenAI Chat/Responses and Anthropic
Messages wire protocols. Every façade prompt is ultimately *typed into a live
agentic CLI* or passed as `-p <prompt>` argv to a headless one.

**Input Inventory**: **41 inputs** across **14 entry points** (11 HTTP routes,
1 WebSocket upgrade, 1 CLI script, 1 env/config surface).

---

## Step 1 — Structural Overview

Production source (test/, node_modules/, public/vendor/, docs/ excluded):

```
src/server.js                       bootstrap (config → pins → versionCheck → http+ws+facade)
src/config.js                       env-driven config + built-in profile table
src/auth.js                         bearer/query token extraction + timing-safe compare
src/httpApi.js                      node:http server, bridge REST API, static shell, security headers
src/wsApi.js                        WebSocket upgrade + raw PTY bridging
src/session.js                      node-pty spawn wrapper + ring buffer
src/sessionManager.js               session registry, profile resolution, dialog auto-answer policy
src/terminalModel.js                @xterm/headless screen model
src/stateDetector.js                busy/idle/awaiting_input state machine
src/promptQueue.js                  per-session serialization
src/promptWriter.js                 multiline-safe PTY write + submit
src/pins.js                         cli-pins.json load/validate
src/versionCheck.js                 boot-time `<cli> --version` handshake (execFile)
src/adapters/{index,generic,claude,codex,antigravity,copilot,extract}.js
src/facade/index.js                 façade mount + per-family auth
src/facade/router.js                ConversationRouter (conversation↔session routing, TTL/LRU)
src/facade/turnRunner.js            PTY turn execution
src/facade/headlessClaudeRunner.js  child_process spawn `claude -p`
src/facade/headlessCopilotRunner.js child_process spawn `copilot -p <prompt>` + tool lockdown
src/facade/streamRenderer.js        incremental delta extraction
src/facade/shared.js                body reading, SSE, errors, AsyncQueue
src/facade/models.js                GET /v1/models
src/facade/dialects/{openaiChat,openaiResponses,anthropicMessages}.js
public/index.html                   terminal shell (inline JS, builds ws:// URL)
scripts/pin-clis.mjs                CLI vendoring script (argv, execFileSync npm)
bin/start.sh                        `exec node src/server.js`
```

Module structure: single flat `src/` + two sub-packages (`adapters/`, `facade/`).
No monorepo, no per-app split. **One production "app".**

---

## Step 1a — Sink Inventory

### Command / process execution
| # | Sink | Location | Notes |
|---|---|---|---|
| S1 | `pty.spawn(command, args, {cwd, env})` | `src/session.js:16` | command/args/cwd/env from profile + **caller-supplied `cwd`, `cols`, `rows`** |
| S2 | `spawn(profile.command, args, {cwd, env})` | `src/facade/headlessClaudeRunner.js:25` | prompt goes to **stdin**, not argv |
| S3 | `spawn(profile.command, args, {cwd, env})` | `src/facade/headlessCopilotRunner.js:113` | **user prompt is an argv element** (`-p <fullPrompt>`, line 96) |
| S4 | `execFile(cmdPath, ['--version'])` | `src/versionCheck.js:11` | cmdPath from config/pins; boot-time only |
| S5 | `execFileSync('npm', [...])`, `spawnSync(src, ['--version'])` | `scripts/pin-clis.mjs:29,43,70` | operator CLI, not server-reachable |

### PTY / terminal write (command-injection-adjacent: raw keystrokes to a live agent)
| # | Sink | Location | Notes |
|---|---|---|---|
| S6 | `rec.session.write(s)` — raw WS frame → PTY | `src/wsApi.js:54` | arbitrary bytes incl. control chars |
| S7 | `session.write(text)` / bracketed paste | `src/promptWriter.js:11,13,16` | prompt body → PTY |
| S8 | `session.write(adapter.keySeq(k))` | `src/httpApi.js:235` | `b.keys[]` → key sequences |
| S9 | `record.session.write(record.adapter.keySeq(k))` | `src/sessionManager.js:29` | dialog auto-answer |
| S10 | `session.write(adapter.keySeq('submit'))` | `src/promptWriter.js:31` | |
| S11 | `pty.resize(cols, rows)` / `terminalModel.resize` | `src/session.js:26`, `src/wsApi.js:53`, `src/terminalModel.js:10` | WS `{type:'resize'}` message |

### Filesystem
| # | Sink | Location | Notes |
|---|---|---|---|
| S12 | `fs.promises.stat(file)` + `fs.createReadStream(file)` | `src/httpApi.js:147,156` | `file` from `/vendor/<path>` |
| S13 | `path.resolve(PUBLIC, '.' + u.pathname)` | `src/httpApi.js:175` | traversal candidate; guarded at :176 |
| S14 | `readFileSync(filePath)` | `src/pins.js:39` | fixed repo path |
| S15 | `fs.writeFileSync` / `copyFileSync` / `chmodSync(0o755)` | `scripts/pin-clis.mjs:25,36,50,51` | operator CLI |

### Response / injection
| # | Sink | Location | Notes |
|---|---|---|---|
| S16 | `res.write('data: ' + JSON.stringify(...))` SSE | `src/httpApi.js:242,243`; `src/facade/shared.js:142,143` | PTY output → SSE; JSON-encoded |
| S17 | `socket.write('HTTP/1.1 400 ...' + body)` raw HTTP | `src/wsApi.js:16` | body is `JSON.stringify` of the **attacker-supplied profile name** — raw socket write, response-splitting candidate |
| S18 | `json(res, code, {error: msg})` echoing `e.message` | `src/httpApi.js:228,259`; `src/facade/shared.js:56` | error-text disclosure (stderr tails at `headlessClaudeRunner.js:74`, `headlessCopilotRunner.js:191`) |
| S19 | `term.write(e.data)` (browser xterm) | `public/index.html:38` | server→client, no HTML sink |

### URL-path-concatenation sweep (MANDATORY)
Grepped all of `src/`, `public/`, `scripts/` for `${...}${...}` / `+ param` into
HTTP-client URL arguments. **Result: zero outbound HTTP clients in production
code** — no `fetch()`, no `http.request()`, no `axios`/`got`/`undici` import in
`src/`. The only URL construction is:
- `src/httpApi.js:171` — `new URL(req.url, 'http://x')` (parsing, not egress)
- `src/wsApi.js:7` — same
- `public/index.html:31-35` — client-side `new URL('/ws', location.href)` +
  `searchParams.set()` (structured API, same-origin, not concatenation)
- `src/server.js:29` — console log line only
**No SSRF sink exists in this codebase.** (`scripts/live-acceptance.mjs` uses
`fetch` but is a dev acceptance harness, not server code.)

### Module coverage cross-check
Single production app; per-module sink presence:

| Module | Sinks | Status |
|---|---|---|
| `src/httpApi.js` | S8, S12, S13, S16, S18 | PASS |
| `src/wsApi.js` | S6, S11, S17 | PASS |
| `src/session.js` | S1, S11 | PASS |
| `src/sessionManager.js` | S9 (+ constructs S1) | PASS |
| `src/promptWriter.js` | S7, S10 | PASS |
| `src/facade/*` (runners) | S2, S3, S18 | PASS |
| `src/facade/*` (dialects/shared) | S16, S18 | PASS |
| `src/versionCheck.js` | S4 | PASS |
| `src/pins.js` | S14 | PASS |
| `src/config.js` | none (produces the argv/env consumed by S1–S4) | PASS (declared) |
| `src/terminalModel.js` | S11 | PASS |
| `src/stateDetector.js`, `src/promptQueue.js` | none (pure state) | PASS (declared) |
| `src/adapters/*` | none directly (supply key sequences to S8/S9/S10) | PASS (declared) |
| `src/facade/streamRenderer.js` | none (read-only over terminal model) | PASS (declared) |
| `public/index.html` | S19 | PASS |
| `scripts/pin-clis.mjs` | S5, S15 | PASS |

---

## Step 1b — Input Inventory

| # | Source Type | Location | Variable | Entry Point | Trust Level |
|---|---|---|---|---|---|
| 1 | HTTP URL path | `src/httpApi.js:171,175` | `u.pathname` | `GET /vendor/*` | **unauth** |
| 2 | HTTP header | `src/httpApi.js:111` | `x-forwarded-proto` | all HTTP routes | **unauth** |
| 3 | HTTP header | `src/auth.js:12` | `authorization` | all routes (auth gate) | **unauth** |
| 4 | HTTP query param | `src/auth.js:15` | `token` | all routes (auth gate) | **unauth** |
| 5 | HTTP body field | `src/facade/dialects/openaiChat.js:21,37` | `model` | `POST /v1/chat/completions` | authenticated (bridge token) |
| 6 | HTTP body field | `openaiChat.js:24,30-33` | `messages[].role` | `POST /v1/chat/completions` | authenticated |
| 7 | HTTP body field | `openaiChat.js:32` → `shared.js:111` | `messages[].content` (**the prompt**) | `POST /v1/chat/completions` | authenticated |
| 8 | HTTP body field | `openaiChat.js:27` | `n` | `POST /v1/chat/completions` | authenticated |
| 9 | HTTP body field | `openaiChat.js:40` | `stream` | `POST /v1/chat/completions` | authenticated |
| 10 | HTTP body field | `openaiChat.js:41` | `stream_options.include_usage` | `POST /v1/chat/completions` | authenticated |
| 11 | HTTP header | `openaiChat.js:16` | `x-bridge-conversation` (pin id) | all 3 façade POST routes | authenticated |
| 12 | HTTP body field (derived) | `openaiChat.js:13-15` | `model` `#<pin>` suffix | all 3 façade POST routes | authenticated |
| 13 | HTTP body field | `openaiResponses.js:14` | `model` | `POST /v1/responses` | authenticated |
| 14 | HTTP body field | `openaiResponses.js:19-21` | `instructions` (system prompt) | `POST /v1/responses` | authenticated |
| 15 | HTTP body field | `openaiResponses.js:22-32` | `input` (string or items; **the prompt**) | `POST /v1/responses` | authenticated |
| 16 | HTTP body field | `openaiResponses.js:26-28` | `input[].role` / `.type` / `.content` | `POST /v1/responses` | authenticated |
| 17 | HTTP body field | `openaiResponses.js:37` | `previous_response_id` | `POST /v1/responses` | authenticated |
| 18 | HTTP body field | `openaiResponses.js:40` | `stream` | `POST /v1/responses` | authenticated |
| 19 | HTTP body field | `anthropicMessages.js:16` | `model` | `POST /v1/messages` | authenticated |
| 20 | HTTP body field | `anthropicMessages.js:23-26` | `system` | `POST /v1/messages` | authenticated |
| 21 | HTTP body field | `anthropicMessages.js:27-32` | `messages[].role` / `.content` (**the prompt**) | `POST /v1/messages` | authenticated |
| 22 | HTTP body field | `anthropicMessages.js:37` | `stream` | `POST /v1/messages` | authenticated |
| 23 | HTTP header | `src/facade/index.js:42` | `x-api-key` | `POST /v1/messages` | **unauth** (it *is* the credential) |
| 24 | HTTP body (arbitrary keys) | `src/facade/shared.js:125-133` | unknown params → `console.warn` | all 3 façade POST routes | authenticated |
| 25 | no-input endpoint | `src/facade/models.js:9` | N/A | `GET /v1/models` | authenticated |
| 26 | HTTP body field | `src/httpApi.js:194` → `sessionManager.js:41` | `profile` | `POST /api/sessions` | authenticated |
| 27 | HTTP body field | `src/httpApi.js:194` → `sessionManager.js:41,76` | **`cwd`** (→ `pty.spawn` cwd, S1) | `POST /api/sessions` | authenticated |
| 28 | HTTP body field | `src/httpApi.js:194` → `sessionManager.js:41,78,80` | `cols` (→ `pty.spawn`/xterm) | `POST /api/sessions` | authenticated |
| 29 | HTTP body field | `src/httpApi.js:194` → `sessionManager.js:41,78,80` | `rows` (→ `pty.spawn`/xterm) | `POST /api/sessions` | authenticated |
| 30 | no-input endpoint | `src/httpApi.js:203` | N/A (lists all sessions) | `GET /api/sessions` | authenticated |
| 31 | HTTP path segment | `src/httpApi.js:206-207` | `parts[2]` (session id) | `GET/DELETE /api/sessions/:id`, `/prompt`, `/key`, `/events` | authenticated |
| 32 | HTTP body field | `src/httpApi.js:219,222` | `text` (**typed into live CLI**, S7) | `POST /api/sessions/:id/prompt` | authenticated |
| 33 | HTTP body field | `src/httpApi.js:222` | `submit` | `POST /api/sessions/:id/prompt` | authenticated |
| 34 | HTTP body field | `src/httpApi.js:221` | `timeoutMs` | `POST /api/sessions/:id/prompt` | authenticated |
| 35 | HTTP body field | `src/httpApi.js:235` | `keys[]` (→ `adapter.keySeq`, S8) | `POST /api/sessions/:id/key` | authenticated |
| 36 | WS query param | `src/wsApi.js:11` | `session` | `GET /ws` (upgrade) | authenticated |
| 37 | WS query param | `src/wsApi.js:13,15,16,27-32` | `profile` (echoed into raw socket write, S17) | `GET /ws` (upgrade) | authenticated |
| 38 | WS message (raw) | `src/wsApi.js:52-54` | `raw` → `session.write` (**arbitrary PTY bytes**, S6) | `/ws` message handler | authenticated |
| 39 | WS message (JSON) | `src/wsApi.js:53` | `m.cols`, `m.rows` (resize, S11) | `/ws` message handler | authenticated |
| 40 | Env vars (~40) | `src/config.js:90-235` | `BRIDGE_TOKEN`, `HOST`, `PORT`, `CWD`, `CLAUDE_CMD`, `CLAUDE_ARGS`, `ADAPTER`, `BRIDGE_PROFILES`, `DEFAULT_PROFILE`, `PROFILE_<N>_{COMMAND,ARGS,CWD,ENV_SCRUB,DIALOG_POLICY,QUIESCENCE_MS,COLS,ROWS}`, `BRIDGE_TRUST_PROXY`, `BRIDGE_USE_HOST_CLIS`, `BRIDGE_STRICT_VERSIONS`, `FACADE_*` | process boot | privileged (operator) |
| 41 | File content | `src/pins.js:36-43` (`cli-pins.json`) | `pins[cmd].{source,version,package,sha256}`; keys become exec'd bin names | process boot | privileged (operator) |

### Second-order / indirect inputs
| # | Source Type | Location | Variable | Entry Point | Trust Level |
|---|---|---|---|---|---|
| 42 | Child-process stdout (untrusted-ish) | `headlessClaudeRunner.js:51-68` | `j.session_id`, `j.result`, `j.usage` (JSONL from spawned CLI) | headless claude turn | internal (LLM-influenced) |
| 43 | Child-process stdout | `headlessCopilotRunner.js:140-186` | `j.data.content`, `j.data.phase`, `j.sessionId`, `outputTokens` | headless copilot turn | internal (LLM-influenced) |
| 44 | Child-process stderr | `headlessClaudeRunner.js:49,74`; `headlessCopilotRunner.js:138,191` | `stderr.slice(-2000)` → echoed to API client | façade error path | internal |
| 45 | PTY output (LLM-generated) | `session.js:17-22` → `terminalModel.write` → `renderLinesSince` | terminal screen text → response `text`/deltas | all PTY turns | internal (LLM-influenced) |
| 46 | CLI argv | `scripts/pin-clis.mjs:14-18` | `--npm-only`, `positional[0]` (pins path) | `npm run pin` | local/operator |

**Sibling-input rule applied**: every destructured field at
`sessionManager.js:41` (`{profile, cwd, cols, rows}`) is inventoried (#26-29),
including the ones that look benign. Every façade body key validated in each
`normalize()` is inventoried, plus the catch-all unknown-key path (#24).

**Completeness check** — every entry point has ≥1 input:
`GET /vendor/*`(#1) · `GET /v1/models`(#25, no-input) · `POST /v1/chat/completions`(#5-12,24) ·
`POST /v1/responses`(#11-18,24) · `POST /v1/messages`(#11,19-24) · `POST /api/sessions`(#26-29) ·
`GET /api/sessions`(#30, no-input) · `GET /api/sessions/:id`(#31) · `DELETE /api/sessions/:id`(#31) ·
`POST /api/sessions/:id/prompt`(#31-34) · `POST /api/sessions/:id/key`(#31,35) ·
`GET /api/sessions/:id/events`(#31) · `GET /` + `/index.html`(#3,4) · `GET /ws` upgrade(#36-39) ·
`npm run pin`(#46) · boot(#40,41). **PASS.**

---

## Step 1c — Indirect Dispatch Detection

| Dispatch | Location | Table entries | Notes |
|---|---|---|---|
| **Route table** (`Map` of `'METHOD /path'` → handler) | `src/facade/index.js:18-40` | `makeModelsHandler`, `makeOpenaiChatHandler`, `makeOpenaiResponsesHandler`, `makeAnthropicMessagesHandler` | keyed by exact `${method} ${pathname}`; registration gated on `config.facade.*` toggles (all **default true**, `config.js:227-229`) |
| **Headless runner map** | `src/facade/router.js:16,178` | `HEADLESS_RUNNERS = {claude: runHeadlessClaudeTurn, copilot: runHeadlessCopilotTurn}` | selected by `conv.profile.headlessRunner`; **falls back to `runHeadlessClaudeTurn`** on unknown key |
| **Adapter registry** | `src/adapters/index.js:8-13` | `generic, claude, codex, antigravity, copilot` | selected by `p.adapter` (profile table, not user input) |
| **Profile table** | `src/config.js:36-86` | 7 built-ins | selected by user-supplied `profile` / `model` (#26, #5/#13/#19) — **user-steered dispatch into distinct spawn configurations** |
| **Dialog auto-answer closure** | `src/sessionManager.js:18-37`, wired at `:89-90` | `record.adapter.startupDialogs[].matcher/answerKeys` | closure invoked by StateDetector before settle; writes keystrokes to the PTY (S9). Policy from `dialogPolicy` (#40 `PROFILE_<N>_DIALOG_POLICY`); `auto-approve` default-presses **Enter** on unmatched screens |
| **Callback registration** | `src/httpApi.js:244-246`; `src/wsApi.js:48-50` | `session.on('data')`, `detector.on('state')`, `session.on('exit')` | listener add/remove per connection — leak/DoS surface |
| **Deferred queue closure** | `src/promptQueue.js:3-7`; `router.js:238` | arbitrary `fn` chained on `_tail` | turn bodies run later, out of request scope |
| **Async event queue** | `src/facade/shared.js:83-105` | producer(router)/consumer(dialect) | `fail()` surfaces as throw inside dialect stream |
| **Re-export/wrapper** | `anthropicMessages.js:11`, `openaiResponses.js:9` both import `parsePin` from `openaiChat.js` | — | pin-parsing logic shared across all 3 dialects; a defect there hits all three |

**Actor/message-framework dispatch — conversation identity & cached state
(security-critical, flagged for Phase 2):**
- **Entity/cache ID construction**: `ConversationRouter._fp()`
  (`router.js:32-36`) builds the routing key as
  `sha256(JSON.stringify([profileName, messages.map(m => [m.role, m.text])]))`
  prefixed by `${profileName}\n`. Two key spaces (**primary** = full message
  list, **secondary** = history only) deliberately share one `_byFp` map
  (`router.js:102-104,120,130-138`).
- **Cached state reuse**: a fingerprint hit **reuses an existing live CLI
  session** (`router.js:120-121`) — i.e. an already-authenticated,
  already-CWD-bound agent process — including its `resumeSessionId`
  (`router.js:182`) and its whole conversation memory. The code's own comment
  (`router.js:99-101`) states there is **no client identity in the cache key**:
  "there is no client identity to separate 'two users who typed the same
  thing'."
- **Explicit pin space**: `pinId` from the `X-Bridge-Conversation` header or
  `model#<id>` suffix (#11, #12) is an **attacker-chosen string** used directly
  as the conversation id (`router.js:113-118`, `_create({id: pinId})`), and
  `previous_response_id` (#17) resolves through `_byResp`
  (`router.js:141-148,226-229`). All three are unauthenticated *within* the
  token-holder population.
- **Companion/factory methods read**: `_fp`, `_buildSeed`, `_create`,
  `_destroy`, `acquire`, `completeTurn`, `registerResponse`, `reap` — all in
  `router.js`; no separate companion object.

---

## Step 1d — Adjacency Map & Subgraph Partitioning

### 1. Application Call Graph

| Entry Point | Inputs | App Functions Called | Sinks Reached | Files Touched |
|---|---|---|---|---|
| `GET /vendor/*` | #1 | `applySecurityHeaders`→`isSecureRequest`, `sendFile` | S12, S13 | `httpApi.js` |
| `GET /` , `/index.html` | #3,#4 | `extractToken`, `checkToken`, `sendFile` | S12 | `httpApi.js`, `auth.js`, `public/index.html` |
| `POST /v1/chat/completions` | #5-12,24 | `extractToken`,`checkToken`,`readJsonBody`,`normalize`,`flattenContent`,`parsePin`,`noteIgnoredParams`,`router.executeTurn`→`acquire`→`_fp`/`_create`/`_buildSeed`/`_ensureCapacity`→`manager.create`→`Session`→`_runTurn`→`runPtyTurn`\|`runHeadless*Turn`, `StreamRenderer`, `collectDone`, `usageOpenaiChat`, `sseFrame` | **S1,S2,S3,S7,S10,S16,S18** | `facade/index.js`, `dialects/openaiChat.js`, `facade/shared.js`, `facade/router.js`, `facade/turnRunner.js`, `facade/headlessClaudeRunner.js`, `facade/headlessCopilotRunner.js`, `facade/streamRenderer.js`, `sessionManager.js`, `session.js`, `promptWriter.js`, `adapters/*`, `auth.js` |
| `POST /v1/responses` | #11-18,24 | same as above + `registerResponse`, `resolveResponseId`, `usageResponses`, `responseBody` | **S1,S2,S3,S7,S10,S16,S18** | + `dialects/openaiResponses.js` |
| `POST /v1/messages` | #11,19-24 | same as chat + `usageAnthropic`, `sseEventFrame`; auth also accepts `x-api-key` | **S1,S2,S3,S7,S10,S16,S18** | + `dialects/anthropicMessages.js` |
| `GET /v1/models` | #25 | `checkToken`, `makeModelsHandler`, `jsonRes` | S18 | `facade/models.js` |
| `POST /api/sessions` | #26-29 | `readBodyOr413`,`readBody`,`manager.create`→`getAdapter`,`new Session`,`new TerminalModel`,`makeDialogHandler`,`new StateDetector` | **S1**, S9, S11 | `httpApi.js`, `sessionManager.js`, `session.js`, `terminalModel.js`, `stateDetector.js`, `adapters/*` |
| `GET /api/sessions` | #30 | `manager.list` | — | `httpApi.js`, `sessionManager.js` |
| `GET/DELETE /api/sessions/:id` | #31 | `manager.get`, `manager.remove`→`session.kill` | — | `httpApi.js`, `sessionManager.js`, `session.js` |
| `POST /api/sessions/:id/prompt` | #31-34 | `manager.get`,`readBodyOr413`,`queue.enqueue`,`sendPrompt`→`detector.waitForSettle`/`markBusy`,`writeAndSubmitPrompt`→`writePromptText`,`terminalModel.renderLinesSince`,`adapter.extractResponse`,`adapter.describePrompt` | **S7,S10**, S18 | `httpApi.js`, `promptWriter.js`, `promptQueue.js`, `stateDetector.js`, `terminalModel.js`, `session.js`, `adapters/*` |
| `POST /api/sessions/:id/key` | #31,#35 | `manager.get`,`readBodyOr413`,`adapter.keySeq`,`session.write` | **S8** | `httpApi.js`, `session.js`, `adapters/*` |
| `GET /api/sessions/:id/events` | #31 | `manager.get`, `session.on('data')`, `detector.on('state')` | **S16** | `httpApi.js`, `session.js`, `stateDetector.js` |
| `GET /ws` (upgrade) | #36-39 | `extractToken`,`checkToken`,`manager.get`,`manager.create`,`reject400`,`wss.handleUpgrade`,`session.scrollback/write/resize`,`terminalModel.resize`,`manager.remove` | **S6,S11,S17** | `wsApi.js`, `sessionManager.js`, `session.js`, `terminalModel.js`, `auth.js` |
| boot | #40,#41 | `loadConfig`,`loadPins`→`validatePins`,`checkVersions`→`execVersion`,`applyStrict`,`createHttpServer`,`attachWss`,`createFacade` | **S4**, S14 | `server.js`, `config.js`, `pins.js`, `versionCheck.js` |
| `npm run pin` | #46 | `loadPins`,`npmDepsFromPins`,`extractVersion` | **S5**, S15 | `scripts/pin-clis.mjs`, `pins.js` |

### 2. Shared Infrastructure Catalog

| Module | Role | Files |
|---|---|---|
| token auth | authentication (extract + timing-safe compare) — used by **100%** of gated entry points | `src/auth.js` |
| security headers / TLS detection | response hardening, `x-forwarded-proto` trust | `src/httpApi.js:108-139` |
| body readers | request deserialization + size caps (1 MiB bridge / 8 MiB façade) | `src/httpApi.js:48-83`, `src/facade/shared.js:60-78` |
| error shaping / SSE plumbing | `FacadeError`, `errorBody`, `sendError`, `jsonRes`, `sseInit/sseFrame/sseEventFrame`, `writeIfOpen`, `AsyncQueue`, `estTokens` | `src/facade/shared.js` |
| config reader | env/profile resolution, vendor-first command resolution | `src/config.js` |
| pins/version handshake | boot-time integrity check | `src/pins.js`, `src/versionCheck.js` |
| serialization queue | per-session turn serialization | `src/promptQueue.js` |
| terminal state | screen model + busy/idle detection | `src/terminalModel.js`, `src/stateDetector.js` |
| adapter registry | per-CLI marker/keyseq strategy | `src/adapters/index.js` + `generic/claude/codex/antigravity/copilot/extract.js` |

**Exception (per Step 1d.2)**: `src/config.js` **is NOT treated as pure shared
infrastructure** — it constructs the `command`/`args`/`cwd`/`env` tuples that
are handed verbatim to `pty.spawn` / `child_process.spawn` (S1-S3), and it
performs filesystem-probing command resolution (`config.js:147-151`). It is
included in the app-specific file list of SG-1 and SG-2.
Likewise `src/sessionManager.js` and `src/session.js` are **spawn sinks**, not
infrastructure, and stay app-specific.

### 3. Subgraph Partitions

Union-find over non-shared functions: the façade dialects and the bridge REST
API both reach `SessionManager.create` → `Session` → `pty.spawn`, and both reach
`promptWriter`. `SessionManager.create` therefore connects nearly everything.
Per Step 1d.4 rule 2, `SessionManager.create` is **not** promoted to shared
infrastructure (it *is* the primary spawn sink — promoting it would erase the
partition's most important node); instead the component is **DEPTH-SPLIT** by
entry-point family, since the two families reach it with structurally different
input shapes (façade: prompt text only, fixed profile/cols; bridge API: raw
`profile`/`cwd`/`cols`/`rows`).

| Partition | Inputs | Entry Points | App-Specific Files | Shared Nodes Used | Marker |
|---|---|---|---|---|---|
| **SG-1** — Cloud-API façade | #5-25, #42-44 (24) | `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`, `GET /v1/models` | `facade/index.js`, `facade/router.js`, `facade/turnRunner.js`, `facade/headlessClaudeRunner.js`, `facade/headlessCopilotRunner.js`, `facade/streamRenderer.js`, `facade/models.js`, `facade/dialects/openaiChat.js`, `facade/dialects/openaiResponses.js`, `facade/dialects/anthropicMessages.js`, `sessionManager.js`, `session.js`, `promptWriter.js`, `config.js` (14) | auth, shared.js, promptQueue, terminalModel, stateDetector, adapters | **DEPTH-SPLIT** from SG-2 |
| **SG-2** — Bridge session REST API | #26-35, #45 (11) | `POST /api/sessions`, `GET /api/sessions`, `GET/DELETE /api/sessions/:id`, `POST /api/sessions/:id/prompt`, `POST /api/sessions/:id/key`, `GET /api/sessions/:id/events` | `httpApi.js`, `sessionManager.js`, `session.js`, `promptWriter.js`, `config.js` (5) | auth, body readers, promptQueue, terminalModel, stateDetector, adapters | — |
| **SG-3** — WebSocket terminal | #36-39 (4) | `GET /ws` upgrade + message handler | `wsApi.js`, `sessionManager.js`, `session.js`, `terminalModel.js` (4) | auth, adapters | — |
| **SG-4** — Static serving & transport hardening | #1, #2, #3, #4 (4) | `GET /vendor/*`, `GET /`, `GET /index.html`, header path on every response | `httpApi.js` (`sendFile`, `applySecurityHeaders`, `isSecureRequest`, vendor path resolution), `auth.js`, `public/index.html` (3) | — | — |
| **SG-5** — Boot-time config, pinning & version handshake | #40, #41, #46 (3) | process boot, `npm run pin` | `config.js`, `pins.js`, `versionCheck.js`, `server.js`, `scripts/pin-clis.mjs` (5) | — | merged (#46 CLI folded in — undersized alone) |

No partition exceeds 20 inputs or 15 app-specific files. No
`SEQUENTIAL-FALLBACK` needed. SG-4 and SG-5 are each >2 inputs so they stand
alone; the `npm run pin` CLI (1 input, 1 file) was merged into SG-5 per the
undersized rule.

### 4. Pathological check
- Oversized: none (max SG-1 at 24 inputs / 14 files — at the boundary; already
  the result of a depth-split, and its inputs are 3 near-identical dialect
  parameter sets, so it stays coherent).
- Single connecting function: `SessionManager.create` — deliberately **not**
  promoted (it is the spawn sink); handled by DEPTH-SPLIT instead.
- Monolithic: no.
- Undersized: `npm run pin` merged into SG-5.

### 5. Production Reachability

| Partition | Verdict | Evidence |
|---|---|---|
| SG-1 | **PRODUCTION** | `src/server.js:25-26` mounts the façade unconditionally; dialect routes registered at `facade/index.js:20-34` gated only on `config.facade.*`, which **default to `true`** (`config.js:227-229` via `flag(env.X, true)`). No `NODE_ENV` check anywhere in `src/`. |
| SG-2 | **PRODUCTION** | `src/server.js:26` → `createHttpServer`; routes at `httpApi.js:190-249`, no env gate. |
| SG-3 | **PRODUCTION** | `src/server.js:27` → `attachWss`; `wsApi.js:6` upgrade listener, no env gate. |
| SG-4 | **PRODUCTION** | `httpApi.js:174` (`/vendor/`, before the auth gate) and `:252` (shell), no env gate. |
| SG-5 | **PRODUCTION** (boot) / operator-local (`npm run pin`) | `server.js:9-23` runs on every boot. |

**No DEV-ONLY partitions. No build-time code swapping** (see Step 4).

**Partition coverage check (per production app/module):**

| Module | Covered by | Pass/Fail |
|---|---|---|
| `src/server.js` | SG-5 | PASS |
| `src/config.js` | SG-1, SG-2, SG-5 | PASS |
| `src/auth.js` | SG-1, SG-2, SG-3, SG-4 | PASS |
| `src/httpApi.js` | SG-2, SG-4 | PASS |
| `src/wsApi.js` | SG-3 | PASS |
| `src/session.js` | SG-1, SG-2, SG-3 | PASS |
| `src/sessionManager.js` | SG-1, SG-2, SG-3 | PASS |
| `src/terminalModel.js` | SG-2, SG-3 | PASS |
| `src/stateDetector.js` | SG-1, SG-2 | PASS |
| `src/promptQueue.js` | SG-1, SG-2 | PASS |
| `src/promptWriter.js` | SG-1, SG-2 | PASS |
| `src/pins.js` | SG-5 | PASS |
| `src/versionCheck.js` | SG-5 | PASS |
| `src/adapters/*` (7 files) | SG-1, SG-2, SG-3 | PASS |
| `src/facade/*` (8 files) | SG-1 | PASS |
| `src/facade/dialects/*` (3 files) | SG-1 | PASS |
| `public/index.html` | SG-4 | PASS |
| `scripts/pin-clis.mjs` | SG-5 | PASS |

**All 18 production modules covered. No gaps.**

---

## Step 1e — Authorization & Classification Gate Audit

Grepped `.contains(`, `.includes(`, `.indexOf(`, `.has(`, `.startsWith(` across `src/`:

| Site | Receiver | Verdict |
|---|---|---|
| `src/auth.js:13` `h.startsWith('Bearer ')` | String | Not an allowlist; prefix strip only. Not a gate. |
| `src/httpApi.js:176` `f.startsWith(VENDOR + path.sep)` | String (resolved abs path) | **Path-containment gate on a String.** Correct *shape* (post-`path.resolve`, with `path.sep` appended and an exact-equality escape for the dir itself). **CANDIDATE** for Phase 2 — symlink escape (`fs.promises.stat` follows symlinks; no `realpath`), and `path.resolve(PUBLIC, '.' + u.pathname)` with a `%2e`-encoded or backslash pathname on non-POSIX. |
| `src/httpApi.js:197` `[...].includes(e.code)` | Array literal of error codes | Membership on Array, exact match. Safe. |
| `src/config.js:17` `['0','false','no','off'].includes(...)` | Array | Safe (denylist for boolean parsing — note: **any unrecognized value is truthy**, e.g. `BRIDGE_TRUST_PROXY=maybe` → `true`). Minor CANDIDATE. |
| `src/config.js:20,154` `DIALOG_POLICIES.includes(dialogPolicy)` | Array | Safe. |
| `src/config.js:99` `env.ADAPTER !== 'generic' && !== 'claude'` | String equality | Safe. |
| `src/config.js:147` `!command.includes('/')` | **String substring** | Gates vendor-first path resolution. Checks `/` only — a Windows `\` separator or a `..`-containing bare name would pass. Also `command` here can be operator-set. Low sev, operator-trusted. **CANDIDATE (latent).** |
| `src/facade/shared.js:110,116` `TEXT_PART_TYPES.includes(p.type)` | Array | Safe. |
| `src/facade/index.js:38` `routes.has(...)` | Map, exact `${method} ${pathname}` | Exact key. **CANDIDATE**: match is on the *raw* pathname — a request to `/v1/messages/` or `/V1/messages` misses the façade table and falls through to the bridge token gate (different auth family), and `/v1/messages` matched here **bypasses the bridge token gate at `httpApi.js:186`** by design (`httpApi.js:184`). Ordering is the security control. |
| `src/facade/headlessCopilotRunner.js:65,66,76,77` `EXPOSURE_*_FLAGS.has(name)` | Set, **exact & case-sensitive** | The file's own comment (lines 40-47) admits this: "flag matching here is exact/case-sensitive, so an alternate spelling copilot's parser might accept could slip past", and `--mcp-config` is **not in the scrub set**. **CANDIDATE (tool-lockdown bypass, operator-config-gated).** |
| `src/facade/dialects/openaiChat.js:13` `model.indexOf('#')` | String | Splits `model` into profile + pin. **CANDIDATE**: `profileName` is then looked up in `config.profiles` (`router.js:221`) — classification of an attacker string into a spawn profile. |
| `src/pins.js:25,27,28` regex + `['npm','external'].includes` | anchored regex / Array | Safe — bin-name regex is anchored `^[A-Za-z0-9][A-Za-z0-9._-]*$`. |

**Classification consistency check** — the security-relevant dimension
**"which conversation/session does this request bind to"** is derived in
**four** different places with **four** different rules:

1. `router.js:32-36` `_fp()` — sha256 over `[profileName, messages]`
2. `router.js:113-118` — explicit `pinId` (raw attacker string) as the map key
3. `router.js:226-229` / `:141-148` — `previous_response_id` → `_byResp`
4. `openaiChat.js:12-18` `parsePin()` — precedence header > suffix; but
   `openaiResponses.js:39-40` uses a **different** precedence
   (header > `previous_response_id` > suffix) and *nulls* `previousResponseId`
   when a header pin is present.

Additionally, `_fp` prefixes the digest with `${profileName}\n` while the
digest itself already covers `profileName` — and the two key spaces (full
messages vs. history-only) are stored in the **same map** (`router.js:98-104`).
**CANDIDATE — collision/confusion in conversation routing identity.** Flagged
for Phase 2 (SG-1).

**Gate-logic inventory entries** (added per Step 1e):

| # | Source Type | Location | Variable | Entry Point | Trust Level |
|---|---|---|---|---|---|
| G1 | authorization gate | `src/httpApi.js:176` | `f` (resolved vendor path) | `GET /vendor/*` | unauth |
| G2 | authorization gate (route ordering) | `src/httpApi.js:184-186` | `u.pathname` | all HTTP | unauth |
| G3 | authorization gate | `src/auth.js:3-9` | `provided` vs `expected` | all gated routes | unauth |
| G4 | authorization gate (tool lockdown) | `src/facade/headlessCopilotRunner.js:70-89` | `profile.args` | copilot-headless turns | privileged (operator config) |
| G5 | classification gate | `src/facade/router.js:32-36,89-126` | `fpKey`/`pinId`/`respId` | all 3 façade POST routes | authenticated |
| G6 | classification gate | `src/config.js:147` | `command` | boot | privileged |

---

## Step 1f — Authentication Path Enumeration

`checkToken(extractToken(req), config.token)` is the **only** credential check
in the codebase. Branches:

| Branch | Location | Credential required | Cryptographically verified? | Identity source |
|---|---|---|---|---|
| A. `Authorization: Bearer <t>` | `auth.js:12-13` | shared bearer token | **No** — constant-time byte equality of a shared secret (`auth.js:3-9`). Not a signature/cert/HMAC over a claim. **No caller identity is produced.** | the token itself |
| B. `?token=<t>` query param | `auth.js:14-16` | same shared token | No (same). **Token travels in the URL** — lands in access logs, browser history, and `Referer` (mitigated only by `referrer-policy: no-referrer`, `httpApi.js:135`). | query string |
| C. `x-api-key: <t>` (Anthropic family only) | `facade/index.js:42-44` | same shared token | No (same) | header |
| D. **No credential — `GET /vendor/*`** | `httpApi.js:174-179` | **none** | n/a | n/a — **runs before the token gate at `:186`** |
| E. **No credential — security-header path** | `httpApi.js:170` | **none** | n/a | `x-forwarded-proto` (#2) read before auth |
| F. WS upgrade | `wsApi.js:8` | same shared token, same `extractToken` | No | query param (browsers cannot set headers on WS upgrade, so **branch B is mandatory** for the shell) |
| G. **Pre-auth 400 responder** | `wsApi.js:25-33` — profile validation | token IS checked first (`:8`) | — | — |

**Findings for Phase 2:**
- **Every branch is a single shared secret.** There is exactly one principal.
  No per-client identity, no rotation, no scope. `config.token` is either
  `BRIDGE_TOKEN` or a per-boot random (`config.js:91`) printed to stdout with
  the URL (`server.js:29`).
- **No CSRF defense on state-changing routes.** `POST /api/sessions`,
  `/prompt`, `/key`, and all façade POSTs accept `?token=` (branch B) — so a
  cross-site `<form>`/`fetch` to `http://127.0.0.1:7681/api/sessions?token=…`
  is a same-token, no-preflight-needed request if the token leaks. No
  `Origin`/`Sec-Fetch-Site` check exists anywhere. **`/ws` upgrade has no
  `Origin` check** (`wsApi.js:6-33`) — classic cross-site WebSocket hijacking
  shape. **CANDIDATE.**
- **`extractToken` returns `null` when the header is malformed**, and
  `checkToken(null, …)` returns `false` (`auth.js:4`) — no null-bypass.
- Length-leak: `checkToken` returns early on length mismatch (`auth.js:7`)
  before `timingSafeEqual`. Token length is observable. Low severity.
- Grep for `bypass` / `skip auth` / `without auth` / `no token` comments in
  `src/`: **only** `httpApi.js:173` ("Public, unauthenticated: vendored
  third-party static assets") and `httpApi.js:181-183` ("Cloud-API facade routes
  authenticate per provider family themselves … match them **before the bridge
  token gate**"). Both are deliberate; both are inventoried as G1/G2.

---

## Step 2 — Threat Model

Per the phase's pessimism rule, prose in comments/README about "loopback only",
"single-operator trust model", or "operator-trusted config" is **not admissible**
and is recorded as `NONE`.

| Entry-point group | App-layer auth enforcement | Caller identity binding | Per-resource authorization |
|---|---|---|---|
| `GET /vendor/*` | `NONE` (`src/httpApi.js:174-179` returns before the gate at `:186`) | `NONE` | `NONE` |
| `GET /` , `GET /index.html` | `src/httpApi.js:186` | `NONE` | `NONE` |
| `POST /api/sessions`, `GET /api/sessions` | `src/httpApi.js:186` | `NONE` | `NONE` |
| `GET/DELETE /api/sessions/:id`, `POST /api/sessions/:id/{prompt,key}`, `GET /api/sessions/:id/events` | `src/httpApi.js:186` | `NONE` | `NONE` — `manager.get(parts[2])` (`httpApi.js:207`) is an existence check only; no owner is recorded on the record (`sessionManager.js:82-86`) |
| `POST /v1/chat/completions`, `POST /v1/responses` | `src/facade/index.js:45` | `NONE` | `NONE` |
| `POST /v1/messages` | `src/facade/index.js:45` (accepts `x-api-key`, `:42-44`) | `NONE` | `NONE` — conversation pins (`router.js:110-118`) check only *profile* agreement, never ownership |
| `GET /v1/models` | `src/facade/index.js:45` | `NONE` | `NONE` |
| `GET /ws` (upgrade + message stream) | `src/wsApi.js:8` | `NONE` | `NONE` — `?session=<id>` attaches to **any** existing session (`wsApi.js:11-12,37`) with no ownership check |
| process boot / `npm run pin` | `NONE` (execution boundary = local shell) | `NONE` | `NONE` |

**Why every "caller identity binding" is `NONE`**: `checkToken`
(`src/auth.js:3-9`) is a constant-time comparison against a single shared
secret. It authenticates *possession of a secret*, not a *caller*. It produces
no principal, no claim, no subject. Per the Step 2 definition (signature /
certificate / HMAC / signed assertion yielding a verified caller identity), a
shared bearer token does not qualify.

### Attacker profile (per row)
- **`GET /vendor/*`** (all three `NONE`): **any party that can reach the
  listening socket** — no credential at all. Default bind is `127.0.0.1:7681`
  (`config.js:202-203`), but `HOST`/`PORT` are env-configurable (#40) and the
  code applies no bind-address restriction of its own.
- **All token-gated rows** (enforcement present, binding `NONE`, authz `NONE`):
  **any holder of the single bridge token**, plus anyone who can replay it.
  Because the token is accepted in the **query string** (`auth.js:14-16`) it is
  exposed to logs, `Referer`, browser history, and shoulder-surfing; and it is
  **printed to stdout at boot** (`server.js:29`). Because there is no `Origin`
  check on `/ws` or on any POST, a **web page in the victim's browser** is also
  in this class once it learns or guesses the token.
- **`process boot` / `npm run pin`**: any party who can set the process
  environment or write `cli-pins.json` — i.e. local code execution as the
  service user.

### Attacker controls
Inventory rows **#1-#39** and **G1-G5**. Most consequentially:
- **#7 / #15 / #21 — the prompt text**, which is written verbatim (after a
  fixed seed preamble, `router.js:38-47`) into a **live, agentic AI coding CLI**
  running in the operator's shell with the operator's credentials
  (`turnRunner.js:84-91` → `promptWriter.js:9-18` → `session.write` → `pty.spawn`),
  or passed as `-p <fullPrompt>` argv (`headlessCopilotRunner.js:95-96`), or on
  stdin (`headlessClaudeRunner.js:85`).
- **#38 — arbitrary raw bytes to the PTY** (`wsApi.js:54`), including terminal
  control sequences and, since the child is an interactive REPL, whatever that
  REPL will do with them.
- **#27 — `cwd`** for `pty.spawn` (`httpApi.js:194` → `sessionManager.js:76` →
  `session.js:16`): an unvalidated, unconstrained absolute path.
- **#26 / #5 / #13 / #19 — `profile` / `model`**: selects *which binary* is
  spawned from the built-in table, including `generic` (whose command is
  operator-set and may be `bash`, per `config.js:123-133`).
- **#28/#29/#39 — `cols`/`rows`** reaching `pty.spawn` and
  `@xterm/headless` `resize()` with no numeric validation.
- **#11/#12/#17 — conversation pin identifiers**, arbitrary strings used as map
  keys and as the identity for reusing a live authenticated CLI session.
- **#2 — `x-forwarded-proto`**, believed when `BRIDGE_TRUST_PROXY` is set
  (`httpApi.js:108-114`).
- **#1 — the `/vendor/` path**, pre-authentication.

### Attacker does NOT control
- `config.token` (unless leaked), the `BUILTIN_PROFILES` table
  (`config.js:36-86`), `FIXED_ARGS` in both headless runners
  (`headlessClaudeRunner.js:12`, `headlessCopilotRunner.js:54-61`), the
  `envScrub` lists, `SHELL_CSP` (`httpApi.js:92-102`), the response security
  headers, `cli-pins.json` contents, the `PROFILE_*` env values, the bind
  host/port, the ambient credentials of the AI CLIs (subscription auth in the
  operator's home directory), and the contents of the operator's filesystem
  *except* insofar as a spawned agent CLI acts on them.
- Session ids are `crypto.randomUUID()` (`session.js:8`) and response ids are
  `resp_<uuid>` (`router.js:142`) — unguessable.

### Existing attacker capabilities (Gate 3 baseline, per row)
- **`GET /vendor/*`** (all-NONE row): baseline is **"can reach the endpoint"**
  — nothing more. Per the all-NONE constraint, no read/write capability is
  presumed; CWE-306/-22 evaluation of this route remains open for Phase 2 NAV.
- **All token-gated rows**: a binding-accepted caller — i.e. any bridge-token
  holder — can, **per the documented contract**: create/list/delete PTY
  sessions; type text into them and read the rendered output; send named key
  sequences; stream terminal output over SSE and WebSocket; and drive
  conversations through the three cloud-API dialects. This is the intended
  product surface (README/docs/API.md) and is the Gate 3 baseline for SG-1,
  SG-2, SG-3. **Not** in the baseline (and therefore still findable in Phase 2):
  controlling the child process's **working directory**, escaping the vendor
  directory, hijacking or colliding with *another* conversation's live session,
  reopening the copilot tool lockdown, splitting the raw upgrade response, or
  reaching any of this from a **cross-origin web page** without the operator's
  intent.
- **boot / `npm run pin`**: full control of what is spawned. Baseline is total;
  nothing in SG-5 is a finding against an attacker who already has it. SG-5's
  value is defensive-control review (does the version handshake actually
  constrain what gets spawned?), not exploitation.

---

## Step 3 — Trust Boundaries

| Boundary | Location | Input Source | Validation |
|---|---|---|---|
| Network → HTTP server | `src/httpApi.js:168-171` | raw request line, URL, headers | `new URL(req.url,'http://x')`; **security headers applied before any auth** (`:170`) |
| Unauthenticated → authenticated (bridge) | `src/httpApi.js:186` | `Authorization` / `?token` | `checkToken` timing-safe compare; **`/vendor/*` (`:174`) and the façade (`:184`) are matched *before* this line** |
| Unauthenticated → authenticated (façade) | `src/facade/index.js:39-48` | `Authorization` / `x-api-key` | same shared token, provider-shaped 401 |
| Unauthenticated → authenticated (WebSocket) | `src/wsApi.js:8` | `?token` on the upgrade URL | `checkToken`; **no `Origin` validation** |
| HTTP body → application | `src/httpApi.js:49-83` (1 MiB), `src/facade/shared.js:62-78` (8 MiB) | request body | size cap + `JSON.parse`; **`httpApi.readBody` swallows parse errors and resolves `{}`** (`:67`) whereas the façade rejects with 400 (`shared.js:74`) — inconsistent |
| Application → **child process** (the critical one) | `src/session.js:16`; `src/facade/headlessClaudeRunner.js:25`; `src/facade/headlessCopilotRunner.js:113` | profile command/args, **user `cwd`/`cols`/`rows`**, **user prompt as argv/stdin** | `envScrub`/`envSet` applied; **no validation of `cwd`**; copilot argv lockdown at `headlessCopilotRunner.js:54-89` |
| Application → **PTY of a live agent** | `src/promptWriter.js:9-18`; `src/wsApi.js:54`; `src/httpApi.js:235` | prompt text, raw WS bytes, `keys[]` | bracketed-paste wrapping for multiline; **`adapter.keySeq(k)` for unknown `k` — see adapters**; no content filtering |
| Application → filesystem | `src/httpApi.js:147,156,175-176` | `/vendor/<path>` | `path.resolve` + `startsWith(VENDOR + sep)`; **no `realpath`** (symlink) |
| Application → filesystem (boot) | `src/pins.js:39`; `src/config.js:147-150` `existsSync` probes | `cli-pins.json`, vendor dir | anchored bin-name regex (`pins.js:25`) |
| Child process → application (**untrusted return path**) | `headlessClaudeRunner.js:51-68`; `headlessCopilotRunner.js:140-186`; `session.js:17-22` → `terminalModel` | JSONL / raw PTY bytes emitted by an **LLM-driven** process | `JSON.parse` with `catch{continue}`; `@xterm/headless` sanitizes escape sequences into a screen model; **stderr tails echoed to the API client** (`:74`, `:191`) |
| Server → browser | `src/httpApi.js:92-102` (CSP), `:132-139` (headers), `public/index.html:19-36` | PTY output → SSE/WS → `term.write` | CSP `default-src 'none'` + `connect-src 'self'`; `frame-ancestors 'none'`; xterm renders to canvas/DOM as text (not HTML) |
| Operator env/config → application | `src/config.js:90-235` | ~40 env vars | type coercion (`num`/`flag`/`jsonArray`); profile-name and dialog-policy allowlists; **`flag()` treats any unrecognized string as `true`** (`:17`) |

---

## Step 4 — Build-Time Code Swapping Detection

**Result: NO build-time code swapping.**

Evidence:
- `package.json` has **no `build` script**; `bin/start.sh:4` is
  `exec node src/server.js` — the checked-in source *is* what runs. There is no
  bundler, no transpiler, no `dist/`, no `Dockerfile` (HEAD commit `4dc607b`
  explicitly *drops* Docker packaging).
- The only file-copying script is `scripts/pin-clis.mjs`, and it copies
  **third-party CLI binaries** into `vendor/` (gitignored) — it never copies
  application source. `pin-clis.mjs:50-51` `copyFileSync` + `chmod 0o755` target
  `vendor/bin/<cmd>`.
- No parallel prod/mock source trees. `scripts/helpers/*.mjs` and
  `scripts/helpers/*.sh` (claude-stub, copilot-stub, fake-repl) are **test
  fixtures** referenced only from `test/` and `scripts/live-acceptance.mjs`;
  they are never substituted into `src/`.
- **However — a runtime binary-substitution mechanism does exist and is
  in-scope**: `config.js:143-151` performs *vendor-first command resolution* —
  if `vendor/node_modules/.bin/<cmd>` or `vendor/bin/<cmd>` exists, it silently
  **replaces** the PATH binary the profile would otherwise spawn. This is not a
  build-time swap but it *is* a "which code actually executes" question, and
  `pin-clis.mjs:62-64` acknowledges the stale-bin shadowing hazard as a warning
  only. **Phase 2 must treat `vendor/` as the effective production binary
  source** when reasoning about what `pty.spawn`/`spawn` actually executes.

---

## Phase 2 Dispatch Notes

Priority order (lowest trust first):

1. **SG-4** — the only *unauthenticated* surface (#1, #2, G1, G2). Small, sharp:
   vendor path containment (symlink / encoding), pre-auth header handling, and
   the route-ordering gate that lets `/v1/*` skip the bridge token check.
2. **SG-1** — largest, richest. Prompt → `spawn`/PTY of an agentic CLI;
   conversation-identity collisions (G5); the copilot tool lockdown (G4);
   `stderr` echo; SSE error framing.
3. **SG-2** — `cwd`/`cols`/`rows` → `pty.spawn` (#27-29); `keys[]` → `keySeq`
   (#35); missing per-session ownership; CSRF shape on all POSTs.
4. **SG-3** — raw PTY byte channel (#38), unvalidated `resize` (#39), the raw
   `socket.write` 400 responder (S17/#37), and the **absent `Origin` check**.
5. **SG-5** — boot-time controls; review-only (baseline capability is total).

Cross-cutting items every trace agent should carry:
- The single-shared-token model means "authenticated" ≈ "one principal"; any
  finding that lets one *conversation/session* affect another is meaningful
  despite that (see G5, `wsApi.js:11-12`).
- `src/facade/shared.js` and `src/auth.js` are reference context (shared
  infrastructure), not trace scope — but `src/config.js`, `src/sessionManager.js`
  and `src/session.js` **are** trace scope (they build and execute the spawn).
