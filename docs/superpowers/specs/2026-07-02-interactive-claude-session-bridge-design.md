# Interactive Claude Session Bridge — Design Spec

Date: 2026-07-02
Status: Approved for implementation

## Overview

A local Node service that owns a real PTY running an **interactive** `claude`
(Claude Code) session and exposes it two ways at once:

1. **Browser terminal** — an `xterm.js` page over WebSocket so a human can watch
   the session live and take over typing.
2. **Programmatic API** — an HTTP + SSE interface so the operator's own JS/TS
   apps can send prompts/keys into the *same* live session and read back the
   response.

Both interfaces attach to the same PTY-backed session, so an app can drive a
flow while a human watches it happen.

## Why this shape (constraints that fix the architecture)

- **Subscription auth is required.** Interactive `claude` uses the Max/Pro OAuth
  login in `~/.claude/.credentials.json`. The Claude Agent SDK is contractually
  API-key-only, and `claude -p` is headless (one-shot / history replay), not a
  live REPL. Driving the interactive REPL over a PTY is the only way to run a
  flow on the subscription. This is the load-bearing reason the whole project
  exists.
- **Interactive-only features** (slash commands, permission prompts, menus, plan
  mode, interactively-loaded MCP) must be usable, so the programmatic API must
  expose session *state* and a way to answer prompts, not just fire-and-forget.
- **Watch-live** is a first-class goal: the browser view mirrors the exact bytes
  the app is driving.

## Goals

- Spawn and manage one or more interactive `claude` sessions under a PTY.
- Serve a browser `xterm.js` terminal bound to a session (view + type).
- Programmatic API: create session, send a prompt, send raw keys, read a
  best-effort captured response, subscribe to a live event stream.
- Detect session readiness state (`busy` / `idle` / `awaiting_input`) so callers
  know when a response is complete or when input is being requested.
- Force subscription auth by ensuring `ANTHROPIC_API_KEY` is absent from the
  child environment.
- Bind to loopback only, gated by a token.

## Non-goals

- Perfect, loss-free structured response extraction from the TUI. Response text
  is **best-effort** (rendered-transcript delta). Callers needing exact
  structured output should use headless tooling — explicitly out of scope here.
- Multi-user / public exposure. Single trusted operator on localhost only.
- Reparenting the already-running `claude` on pts/0 (ruled out earlier: TIOCSTI
  disabled, no `reptyr`). We always spawn a fresh session under our own PTY.
- Persisting/replaying warm session context across restarts (the operator did
  not require warm-context reuse).

## Architecture

```
   browser (xterm.js) ──WS──┐
                            ├─▶  Bridge (Node, single process)  ──▶ node-pty ──▶ claude (interactive, subscription OAuth)
   your app  ──HTTP/SSE─────┘        │
                                     ├─ SessionManager  (owns PTYs, one Session each)
                                     ├─ Session         (node-pty wrapper + raw ring buffer)
                                     ├─ TerminalModel    (@xterm/headless: renders the stream for detection + clean text)
                                     ├─ StateDetector    (quiescence + marker heuristics → state machine)
                                     ├─ claudeAdapter    (version-pinned markers + key sequences — the one fragile file)
                                     └─ HttpApi / WsApi  (routes, token auth, prompt queue)
```

### Modules (each independently testable)

- **`src/config.js`** — resolves configuration from env with defaults:
  `HOST=127.0.0.1`, `PORT=7681`, `TOKEN` (env `BRIDGE_TOKEN` or generated via
  `crypto.randomBytes(24).toString('base64url')` and logged once at startup),
  `CLAUDE_CMD` (default `claude`), `CLAUDE_ARGS` (default `[]`), `CWD`
  (default `process.env.HOME`), `QUIESCENCE_MS` (default `500`),
  `PROMPT_TIMEOUT_MS` (default `600000`), `COLS`/`ROWS` (default `120`/`30`),
  `SCROLLBACK` (default `5000`). Exposes a frozen config object. No side effects
  besides reading env.

- **`src/session.js`** — `Session` class. Wraps one `node-pty` child.
  Responsibilities: spawn `claude` with a **sanitized env** (a shallow copy of
  `process.env` with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` deleted);
  emit `data` (raw chunk) and `exit` events; `write(data)`, `resize(cols,rows)`,
  `kill()`. Maintain a bounded **raw ring buffer** (last N bytes, default 256 KB)
  so a late-joining browser client gets recent scrollback. Assign a `id`
  (uuid). Does NOT interpret content — pure transport + buffering.

- **`src/terminalModel.js`** — wraps `@xterm/headless` `Terminal`. Feeds it every
  raw chunk (`terminal.write`). Exposes: `snapshotLineCount()` (current absolute
  line index = scrollback baseY + rows), and `renderLinesSince(index)` →
  array of trimmed strings for lines `[index, end)` read from
  `terminal.buffer.active` (walking scrollback + viewport). Also
  `viewportTail(n)` → last n non-empty rendered lines (used by the detector to
  inspect the input area). This gives clean, escape-free text using the same
  engine the browser renders with. If `@xterm/headless` cannot be used, the
  documented fallback is `strip-ansi` on the raw delta (lower fidelity) —
  chosen at build time, recorded in code comments, not a runtime switch.

- **`src/claudeAdapter.js`** — the single version-pinned surface. Pinned to
  Claude Code `2.x` (built against `2.1.198`). Contains:
  - `isIdle(tailLines)` → boolean: the input prompt is present and no spinner.
  - `isAwaitingInput(tailLines)` → boolean: a selection menu / permission prompt
    / trust dialog is visible (best-effort classification).
  - `describePrompt(tailLines)` → string | null: best-effort text of what is
    being asked.
  - `keySeq(name)` → byte sequence for logical keys: `enter`(`\r`),
    `submit` (whatever submits a prompt — verified empirically), `up`(`\x1b[A`),
    `down`(`\x1b[B`), `left`, `right`, `esc`(`\x1b`), `tab`(`\t`),
    `ctrl-c`(`\x03`); any single printable string passes through.
  All markers are backed by fixtures captured from the real CLI (see Testing).

- **`src/stateDetector.js`** — the state machine. Inputs: `data` events from a
  Session + the TerminalModel. States: `starting`, `idle`, `busy`,
  `awaiting_input`, `exited`. Logic: on each chunk, (re)arm a `QUIESCENCE_MS`
  timer and set state `busy`. When the timer fires (stream quiet), inspect
  `terminalModel.viewportTail()` via `claudeAdapter`: if `isAwaitingInput` →
  `awaiting_input`; else if `isIdle` → `idle`; else remain `busy` (keep waiting).
  Emits `state` events on transition. Exposes `waitForSettle({timeoutMs})` →
  Promise resolving to the settled state (`idle`|`awaiting_input`) or rejecting
  on timeout / `exited`.

- **`src/promptQueue.js`** — per-session FIFO. `enqueue(fn)` serializes async
  prompt operations so concurrent API calls never interleave input.

- **`src/httpApi.js`** — HTTP routes (Node `http` + a tiny router, or `express`).
  Token auth on every route. SSE endpoint. Static file serving for the browser
  page. See API contract below.

- **`src/wsApi.js`** — WebSocket upgrade handler (`ws`). Token auth on upgrade.
  Binds a browser client to a session: forwards Session `data` → client (after
  first sending the ring-buffer scrollback), and client messages → Session.
  Control frames (JSON) for `resize`.

- **`public/index.html`** — loads `xterm.js` + fit addon (vendored under
  `public/vendor/`, not CDN, so the tool is self-contained and offline-capable),
  opens the WS with the token, wires terminal ↔ WS, auto-fits + sends resize.

- **`src/server.js`** — composition root: build config, SessionManager, start
  HTTP+WS on `HOST:PORT`, print the ready URL with token.

- **`bin/start.sh`** — generate/echo token, run `node src/server.js`.

## API contract

All routes require the token via `Authorization: Bearer <token>` header **or**
`?token=` query param. Missing/invalid → `401`. Bind `127.0.0.1` only.

### Programmatic (HTTP/JSON)

- `POST /api/sessions` → `201 {id, state}`. Spawns an interactive session.
  Optional body `{cwd?, cols?, rows?}`.
- `GET  /api/sessions` → `200 {sessions:[{id,state,createdAt}]}`.
- `GET  /api/sessions/:id` → `200 {id,state,createdAt}` | `404`.
- `DELETE /api/sessions/:id` → `204`. Kills the PTY.
- `POST /api/sessions/:id/prompt` body `{text, submit?=true, timeoutMs?}` →
  queued; resolves `200 {state, output, durationMs}` where `output` is the
  cleaned rendered-transcript delta captured between send and settle. `state` is
  the settled state (`idle` = response complete; `awaiting_input` = Claude is
  asking something — inspect `prompt`). Shape:
  `{state, output, prompt?:string|null, durationMs}`. `409` if session not
  spawned/`exited`; `504` on timeout (session left as-is).
- `POST /api/sessions/:id/key` body `{keys:[...]}` → sends logical keys/strings
  (via `claudeAdapter.keySeq`). Used to answer menus/permission prompts.
  `200 {state}` (state re-evaluated after a short settle).
- `GET  /api/sessions/:id/events` (SSE) → stream of
  `{type:"output", data}` (cleaned incremental text) and
  `{type:"state", state}` events for real-time reaction.

### Browser (WebSocket)

- `GET /` (token in query) → serves `public/index.html`.
- `WS /ws?token=…&session=:id` → binds to session `:id` (or creates one if
  omitted). Server → client: raw PTY bytes (scrollback first, then live).
  Client → server: text frames = keystrokes → PTY; JSON control frame
  `{type:"resize",cols,rows}` → PTY resize.

## Readiness / response semantics (the crux — stated honestly)

- Interactive Claude emits a TUI byte-stream, not `stream-json`. There is no
  exact "response complete" signal. We approximate with **quiescence + rendered
  screen inspection**: the stream going quiet for `QUIESCENCE_MS`, then the
  rendered input area matching the idle marker.
- **Response text is best-effort.** `output` from `POST /prompt` is the set of
  transcript lines newly rendered between the prompt being sent and the session
  settling, extracted from the headless terminal buffer and trimmed. It can
  include minor redraw artifacts; it is not a guaranteed-clean model answer.
- **Fragility is contained** in `src/claudeAdapter.js`. A Claude Code TUI change
  is a single-file update backed by refreshed fixtures. The Claude Code version
  is pinned/documented (`2.1.198`); the adapter header records the pinned range.

## Security

- Loopback bind (`127.0.0.1`) only; never `0.0.0.0`.
- Random token required on every HTTP route and the WS upgrade; compared with
  `crypto.timingSafeEqual` (length-guarded). Reach remotely via
  `ssh -L 7681:127.0.0.1:7681` only.
- This grants full interactive control of Claude (which can run tools / execute
  code) on the subscription. The token is a high-value secret; README states
  this plainly.
- Child env has `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` stripped to guarantee
  subscription auth (documented).
- README records the operator-scope caveat: drive your own session for your own
  automation; do not re-expose it as a product to other end users (Anthropic
  Agent-SDK policy).

## Error handling

- Invalid/missing token → `401`. Unknown session → `404`. Prompt to
  unspawned/exited session → `409`. Prompt settle timeout → `504` (session
  untouched; caller may retry or send keys).
- `claude` binary missing → session spawn fails fast with a clear error written
  to the browser terminal and returned by `POST /api/sessions`.
- PTY exit → state `exited`, `exit` event to browser + SSE, WS closed.
- On WS client disconnect the PTY is **kept alive** (so an app-driven flow
  survives a browser refresh); sessions are reaped by `DELETE` or process exit.

## Configuration summary

Env: `BRIDGE_TOKEN`, `HOST`, `PORT`, `CLAUDE_CMD`, `CLAUDE_ARGS` (JSON array),
`CWD`, `QUIESCENCE_MS`, `PROMPT_TIMEOUT_MS`, `COLS`, `ROWS`, `SCROLLBACK`,
`RING_BYTES`. All have defaults; none required.

## Tech choices & dependencies

- Runtime: Node 20 (verified: v20.19.2).
- `node-pty` — real PTY (prebuilt binaries for node 20 linux-x64; if the native
  build fails, fallback plan is a `tmux`-backed Session driver behind the same
  `Session` interface — documented, not built unless needed).
- `ws` — WebSocket server (pure JS).
- `@xterm/headless` — server-side terminal model for detection + clean text.
- `xterm` + `@xterm/addon-fit` — browser, vendored into `public/vendor/`.
- Test: `node:test` + `node:assert` (no extra framework).
- No CDN dependencies at runtime.

## Testing strategy

1. **Empirical spike (task 0, gates the adapter).** A throwaway script spawns
   `claude` under `node-pty` in a trusted `cwd`, sends a trivial prompt
   ("reply with exactly: PONG"), captures the raw byte stream to a fixture file,
   and records: whether the alternate screen buffer is used, what the idle input
   prompt renders as, what the submit key is, and what any startup/trust/permission
   dialog looks like. These real captures become fixtures under
   `test/fixtures/` and define `claudeAdapter` markers. No marker is written from
   assumption.
2. **Unit tests** (fixture-driven, no live Claude):
   - `terminalModel`: feeding a fixture yields expected clean lines / counts.
   - `claudeAdapter`: `isIdle` / `isAwaitingInput` / `describePrompt` classify
     the captured fixtures correctly (idle, busy-mid-stream, permission-menu,
     trust-dialog).
   - `stateDetector`: replaying a fixture chunk-timeline drives the expected
     state transitions; `waitForSettle` resolves/rejects correctly.
   - `config`: env parsing + defaults; token generation.
   - `promptQueue`: serialization ordering.
   - auth: token check accepts valid, rejects invalid/missing (timing-safe).
3. **Component smoke test** (no Claude): a `Session` driver pointed at `bash`
   (an injectable command) round-trips `POST /prompt {text:"echo hello"}` and the
   response contains `hello`; SSE emits output+state; WS relays bytes. This
   validates the whole pipeline without spending subscription usage.
4. **Live verification** (manual, minimal, run once by the orchestrator before
   sign-off): start the server, open the browser page, confirm interactive
   `claude` renders and is driveable; run one scripted `POST /prompt`
   "reply with exactly: PONG" against a real session and confirm `PONG` appears
   in `output` and `state==="idle"`. Keeps subscription usage trivial.

## Open risks

- TUI-marker fragility across Claude Code versions (mitigated: adapter + pinned
  version + fixtures).
- Best-effort response extraction may include redraw noise (documented; callers
  needing exactness must use headless, which is out of scope).
- First-run trust/onboarding dialogs can block a fresh session; surfaced as
  `awaiting_input` and answerable via `POST /key`; spike documents the exact shape.
- `node-pty` native build on this box (mitigated: tmux-backed fallback driver
  behind the same interface).

## Directory layout

```
pty-web-bridge/
  package.json
  bin/start.sh
  src/{config,session,terminalModel,claudeAdapter,stateDetector,promptQueue,httpApi,wsApi,server}.js
  public/{index.html, vendor/…}
  test/{*.test.js, fixtures/…}
  docs/superpowers/specs/2026-07-02-interactive-claude-session-bridge-design.md
  README.md
```
