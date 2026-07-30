# Universal CLI Support & Cloud-API Facade — Design Spec

Date: 2026-07-23
Status: Approved for implementation
Builds on: [2026-07-02 interactive-claude-session-bridge design](2026-07-02-interactive-claude-session-bridge-design.md)

> **Addendum (2026-07-24, Phase 1 as-built):** the `gemini` profile described
> below shipped as **`antigravity`** (command `agy`, adapter `antigravity`) —
> Google sunset the standalone gemini CLI's OAuth for individual accounts
> mid-implementation. Wherever this spec says `gemini`, read `antigravity`.
> The `copilot` adapter shipped **fully verified** (gh-keyring auth), not as
> the anticipated stub. `antigravity` and `copilot` are alt-screen "degraded":
> state detection is fixture-verified but PTY `extractResponse` is
> best-effort — the headless runner is the fidelity path for such CLIs.

## Overview

Two extensions to the existing bridge, implemented in two phases on one design:

1. **Universal CLI support (Phase 1).** The bridge currently runs exactly one
   kind of CLI per process (`claude`, or `generic`). It becomes a multi-CLI
   host: named **profiles** describe how to run each of Claude Code, Codex CLI,
   Gemini CLI, and GitHub Copilot CLI (plus `generic`), selectable per session.
2. **Cloud-API facade (Phase 2).** The bridge additionally speaks the wire
   formats of real AI cloud APIs — OpenAI Chat Completions, OpenAI Responses,
   and Anthropic Messages — so an off-the-shelf tool that wants an
   "OpenAI API key + endpoint" can be pointed at the bridge and drive a
   subscription-authenticated CLI, largely indiscernibly from `api.openai.com`.

Example target scenario: an enterprise has GitHub Copilot seats but must use a
tool that requires an OpenAI-compatible endpoint. The tool is configured with
`base_url = http://127.0.0.1:7681/v1`, `api_key = <bridge token>`, and its
requests are answered by the Copilot CLI running under the bridge.

## Decisions made during brainstorming

| Question | Decision |
|---|---|
| Conversation↔session mapping | **Hybrid**: explicit pinning (model suffix / header) when the client provides it; history-prefix fingerprint stickiness as the default |
| Facade surfaces | OpenAI Chat Completions (stream + non-stream), OpenAI Responses, Anthropic Messages — **each toggleable**, all enabled by default |
| CLI dialogs during a facade request | **Configurable per profile, safe default**: auto-answer known startup dialogs only; anything else fails the request with a structured error naming the dialog |
| Copilot CLI (no seat on this machine) | Install now; capture pre-auth fixtures (boot/login screens); authenticated-session markers ship as a marked best-effort stub until a seat is available |
| Facade backend architecture | **A + headless-claude runner**: PTY-backed turn runner for all CLIs behind a narrow `TurnRunner` seam, plus a headless runner (`claude -p --output-format stream-json --include-partial-messages --resume`) shipped now as a second implementation |
| Acceptance proof | Official `openai` and `anthropic` SDKs pointed at the bridge (streaming + non-streaming), scriptable as integration tests |

## Goals

- One bridge process hosts sessions of different CLIs simultaneously, selected
  per session (`POST /api/sessions {"profile":"codex"}`, `/ws?profile=…`).
- Fixture-verified state-detection adapters for `claude`, `codex`, `gemini`;
  best-effort (pre-auth-fixture) adapter for `copilot`; `generic` retained.
- Per-profile environment policy pushes each CLI onto its subscription/OAuth
  login by scrubbing the **documented env-var auth paths** (each profile's
  `envScrub` list is authoritative; see the profiles table — including
  `CODEX_API_KEY` for codex, `GOOGLE_APPLICATION_CREDENTIALS` and Vertex vars
  for gemini, `COPILOT_GITHUB_TOKEN` for copilot). This is best-effort by
  nature: auth configured in files (`~/.gemini/.env`, gcloud ADC files, CLI
  config) is outside env-scrub's reach and remains the operator's
  responsibility.
- Clean assistant-text extraction (`extractResponse`) per adapter — required by
  the facade, and immediately exposed on `POST /prompt` as a new `text` field.
- Facade endpoints that unmodified official SDKs accept, including SSE
  streaming, provider-shaped errors, and `GET /v1/models`.
- Conversation continuity across stateless requests via the hybrid router.
- Backward compatibility: documented values of existing env vars
  (`CLAUDE_CMD`, `CLAUDE_ARGS`, `ADAPTER`, and the legacy globals — see
  Profiles) and every existing endpoint keep working unchanged. One deliberate
  exception: an *unknown* `ADAPTER` value now fails fast at boot instead of
  silently running claude.

## Non-goals

- Honoring sampling/tooling parameters (`temperature`, `tools`,
  `response_format`, `logprobs`, …). They are accepted, ignored, and logged
  once per parameter name.
- Perfect token accounting on the PTY path. `usage` is estimated (`chars/4`)
  there and flagged as estimated in a vendor extension field; the headless
  runner reports real usage.
- Multi-user auth / public exposure. The security model stays
  single-operator, localhost, one token.
- Embeddings, images, audio, fine-tuning, or any endpoint other than the three
  chat surfaces listed.
- Completing browser-based OAuth onboarding flows programmatically. These
  always surface as dialog errors for an operator.

## Phase 1 — Universal CLI support

### Profiles (config.js)

`config.js` grows a `profiles` table; every entry fully describes one CLI:

```js
profiles: {
  claude:  { command: 'claude',  args: [], adapter: 'claude',
             envScrub: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
             quiescenceMs: 500, dialogPolicy: 'startup-only',
             mode: 'pty', cols: 120, rows: 30 },
  codex:   { command: 'codex',   adapter: 'codex',
             envScrub: ['OPENAI_API_KEY', 'CODEX_API_KEY'], … },
  gemini:  { command: 'gemini',  adapter: 'gemini',
             envScrub: ['GEMINI_API_KEY', 'GOOGLE_API_KEY',
                        'GOOGLE_APPLICATION_CREDENTIALS',
                        'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT',
                        'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_LOCATION'], … },
  copilot: { command: 'copilot', adapter: 'copilot',
             envScrub: ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN'], … },
  'claude-headless': { command: 'claude', adapter: null,
             envScrub: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
             mode: 'headless' },
  generic: { command: null /* PROFILE_GENERIC_COMMAND, required to use */,
             adapter: 'generic', … },
}
```

- **One total precedence order** for every profile field, highest first:
  1. per-profile env override (`PROFILE_CODEX_ARGS='["--sandbox","read-only"]'`,
     `PROFILE_GEMINI_QUIESCENCE_MS=800`);
  2. the profile's own `profiles`-table value (for `claude`, the legacy
     `CLAUDE_CMD`/`CLAUDE_ARGS` mapping lands at this level);
  3. the legacy global env vars (`QUIESCENCE_MS`, `COLS`, `ROWS`, `CWD`,
     `PROMPT_TIMEOUT_MS`, `SCROLLBACK`, `RING_BYTES`) — existing deployments
     keep their tuning;
  4. built-in defaults (the `claude` profile's values stand in for fields
     elided as `…` above).
  Commands/args live **only** in this system — adapters carry no command
  defaults. Each adapter's fixture spike revises the *shipped table values*
  (level 2) for `quiescenceMs`/`cols`/`rows` at development time; spikes are
  not a runtime layer, and the resolver must therefore honor a shipped table
  value where a profile provides one (level 2 sits between the env override
  and the legacy global). `adapter` and `mode` are the **structural identity**
  of a built-in profile, not tunable fields: you change them by selecting a
  different profile, so there is no `PROFILE_<NAME>_ADAPTER`/`_MODE` override.
- `BRIDGE_PROFILES` (comma-separated allowlist, default: all built-ins)
  controls which profiles exist at runtime: unlisted profiles are rejected by
  the session/WS API and are absent from the facade (`404 model_not_found`).
  This plus the dialect toggles are the blast-radius controls.
- `DEFAULT_PROFILE` (default `claude`) is what a bare `POST /api/sessions` or
  `/ws` connection spawns.
- **Back-compat mapping**: `CLAUDE_CMD`/`CLAUDE_ARGS` override the `claude`
  profile's command/args; `ADAPTER=generic` maps to `DEFAULT_PROFILE=generic`
  and, in that legacy combination, the **effective** claude command/args
  config values (which default to `claude`/`[]` when `CLAUDE_CMD`/`CLAUDE_ARGS`
  are unset) populate the `generic` profile's command/args — preserving both
  today's `ADAPTER=generic CLAUDE_CMD=bash` and today's bare `ADAPTER=generic`
  behavior.
- `dialogPolicy` ∈ `startup-only` (default) | `auto-approve` | `never`,
  defined precisely (consumed by StateDetector at spawn and by the facade
  turn runner mid-turn):
  - `never` — nothing is ever auto-answered; every dialog, including launch
    trust prompts, surfaces as `awaiting_input` (sessions API) or a dialog
    error (facade).
  - `startup-only` — dialogs matching the adapter's `startupDialogs` table are
    auto-answered with their `answerKeys`. Loop guard: a matched dialog is
    answered **at most twice per persisting screen** — if the same
    awaiting-input screen (identical rendered tail) is still present after two
    answers it surfaces instead of being re-answered forever; the counter
    resets once the session leaves `awaiting_input` (a genuinely dismissed
    dialog changes the screen and never trips the cap). Anything not matched
    surfaces.
  - `auto-approve` — table-matched dialogs as above; an *unmatched* dialog is
    answered with the adapter's default-accept key (`keySeq('enter')`) under
    the same at-most-twice-per-persisting-screen cap; if it persists it
    surfaces as a dialog error (prevents loops). Because the cap is
    per-persisting-screen, successfully dismissing one dialog does not consume
    the budget for a later, different dialog.
- Auto-answering happens **before** the detector settles the turn: a dialog
  consumed by the policy keeps the session `busy` and is never reported as
  `awaiting_input` to an in-flight `sendPrompt`/facade turn (only a dialog the
  policy declines to answer surfaces).
- `mode` ∈ `pty` (default) | `headless` (Phase 2; non-PTY profiles are
  facade-only and rejected by session/WS endpoints with a clear error). A
  non-PTY value for `DEFAULT_PROFILE`, or a command-less default profile, is
  rejected at boot (a bare `/ws`/`POST /api/sessions` must always be spawnable).

### Per-session profile selection

- `SessionManager.create({profile, cwd, cols, rows})` resolves the profile and
  binds `{command, args, adapter, envScrub, quiescenceMs, dialogPolicy, mode}`
  to the session record. Session records and all session-listing responses gain a `profile`
  field.
- `POST /api/sessions` accepts optional `profile` (unknown name → `400` listing
  valid profiles). `/ws` accepts `?profile=`; an unknown profile rejects the
  upgrade with HTTP `400` and the same body. `?profile=` is consulted **only**
  when the connection creates a session (no `?session=`): when `?session=`
  names an existing session, attachment proceeds and `?profile=` is ignored —
  attachment never respawns or reconfigures a session.
- Env-scrub moves from the hardcoded lines in `session.js` to the profile's
  `envScrub` list, applied at spawn.

### Adapter registry & contract

`adapters/index.js` becomes a name→module map: `claude`, `codex`, `gemini`,
`copilot`, `generic`. Unknown adapter names **throw** — the current silent
default-to-claude fallback is removed (and the test pinning that behavior is
updated).

The adapter contract keeps the existing five members (four methods plus
`name`) and grows:

| Member | Required | Purpose |
|---|---|---|
| `name`, `isIdle(tail)`, `isAwaitingInput(tail)`, `describePrompt(tail)`, `keySeq(name)` | yes (existing) | unchanged |
| `isBusy(tail)` | optional | positive busy marker (spinner/footer). When present, StateDetector (a) treats "quiet + isBusy" as still-busy, and (b) runs a periodic marker evaluation even while output keeps flowing — see StateDetector changes — so spinner-animated CLIs that never go quiescent can still be classified idle |
| `extractResponse(lines)` | yes for the four real CLIs | strip echoed input, spinner residue, borders, footers from a rendered transcript delta; return only assistant text. `generic` uses an identity implementation (delta passed through minus the echoed first line), which is also what the facade integration tests exercise |
| `startupDialogs` | optional | array of `{matcher(tail), answerKeys[]}` for launch-time dialogs (claude trust prompt, other CLIs' onboarding), consumed per the session's `dialogPolicy` |
| `supportsBracketedPaste` | optional (default true) | opt-out for CLIs whose line editor mishandles it |
| `newlineKey` | optional | key sequence that inserts a literal newline without submitting; the multiline fallback when bracketed paste is off |
| `multiline` | optional | `'raw'` opts out of all multiline handling: text is written unchanged, one submit per newline (legacy behavior; `generic` only) |

Commands and args do **not** live in adapters — the profiles table is the
single source of truth (per-profile env override wins). Headless-mode profiles
(`adapter: null`) bypass the adapter contract entirely; their runner owns the
fixed CLI flags.

**Multiline input**: prompt text containing `\n` is written wrapped in
bracketed paste (`\x1b[200~…\x1b[201~`) before the submit key, in one shared
writer used by `sendPrompt` and the facade — fixes the existing bug where
embedded newlines submit partial prompts. Fallback when
`supportsBracketedPaste: false`: interior newlines are sent as the adapter's
`newlineKey` if defined; otherwise multiline input is rejected with a clear
error (`400` on `/prompt`, provider-shaped on the facade). Exception:
`generic` declares `multiline: 'raw'` — text passes through unchanged,
newlines and all, exactly today's behavior — so existing `generic`
deployments see no compatibility break (for a line-based CLI, one submit per
line *is* the native semantics).

**StateDetector changes**: per-session `quiescenceMs` (from profile).
On quiet-tick, consult `adapter.isBusy` before classifying idle/awaiting.
Additionally, when the adapter provides `isBusy`, the detector evaluates
markers on a periodic tick (every `quiescenceMs`) even while output keeps
flowing: if `isIdle(tail)` matches and `isBusy(tail)` does not for two
consecutive ticks, the session is classified idle despite ongoing repaints —
this, not quiescence alone, is the mechanism for spinner-animated CLIs.
Startup-dialog handling: when a session settles into `awaiting_input`
matching a `startupDialogs` entry, the detector's owner (SessionManager)
applies the session's `dialogPolicy` (definitions in Profiles) — auto-answer
with `answerKeys` and re-arm, or surface.

### `POST /prompt` gains `text`

The existing endpoint's response adds a `text` field —
`adapter.extractResponse` applied to the transcript delta — alongside the raw
`output`. This is a Phase 1 deliverable (it depends only on adapters) and is
asserted in both the adapter fixture tests and the generic-profile
integration tests.

### Fixture-first adapter development

Each new adapter starts as a capture spike per `test/fixtures/NOTES.md`:
spawn the real CLI under node-pty at the profile's cols×rows, capture raw
bytes at boot / dialog / idle / busy / response checkpoints, render through
TerminalModel, derive marker regexes from **rendered lines**, record the CLI
version the fixtures pin.

- `codex` (0.134.0, ChatGPT login) and `gemini` (0.33.1, Google OAuth) are
  installed and authenticated: full fixture sets, verified adapters.
- `copilot`: install now (`npm install -g @github/copilot`); capture pre-auth
  screens (boot, login prompt) as real fixtures; authenticated-session markers
  ship as a clearly-marked best-effort stub (`verified: false` note in the
  adapter header) until a seat is available.
- Every spike explicitly records whether the CLI enters the alternate screen
  buffer (`\x1b[?1049h`) or repaints in place. The transcript-delta model
  assumes append-only main-buffer rendering; a CLI that violates it has its
  PTY transcript marked **degraded** in the adapter header — state detection
  still works, `extractResponse` is best-effort, and the long-term answer for
  such a CLI is a headless runner (Phase 2 seam).

## Phase 2 — Cloud-API facade

### Module layout

```
src/facade/
  index.js                    mount(config, manager): registers enabled dialect routes
  router.js                   ConversationRouter: request → conversation → session
  turnRunner.js               TurnRunner interface + PtyTurnRunner
  headlessClaudeRunner.js     HeadlessClaudeRunner (claude -p stream-json)
  streamRenderer.js           incremental clean-text deltas from TerminalModel
  models.js                   GET /v1/models (shared; mounted when any OpenAI-family dialect is on)
  dialects/openaiChat.js      POST /v1/chat/completions (+SSE)
  dialects/openaiResponses.js POST /v1/responses (+SSE)
  dialects/anthropicMessages.js POST /v1/messages (+SSE, x-api-key accepted)
```

Mounted by `server.js` on the same HTTP server, behind the same token gate.
Toggles `FACADE_OPENAI_CHAT`, `FACADE_OPENAI_RESPONSES`,
`FACADE_ANTHROPIC_MESSAGES` — all default **on**; a disabled dialect's routes
404. The bridge token is the API key (`Authorization: Bearer` everywhere;
the Anthropic dialect also accepts `x-api-key`). All error responses use the
respective provider's error JSON shape so official SDKs raise their native
exception types.

### Models

`model` = profile name. `GET /v1/models` is mounted whenever at least one
OpenAI-family dialect is enabled (it is shared, not owned by the Chat dialect)
and lists **facade-usable** profiles: those on the `BRIDGE_PROFILES` allowlist
whose command resolves (`generic` appears only once `PROFILE_GENERIC_COMMAND`
or the legacy mapping gives it a command). `claude-headless` is facade-usable
but not usable via the session/WS API. Requests naming an unknown, unlisted,
or command-less model → provider-shaped `404 model_not_found`; a listed model
whose process fails to spawn → provider-shaped `500 api_error` with the spawn
error in a `bridge` vendor field.

### Conversation routing (the hybrid)

1. **Explicit pin** — model suffix `<profile>#<conversation-id>` or header
   `X-Bridge-Conversation: <id>`; if both are present and disagree, the header
   wins. The router keeps a conversation-id→session map. Semantics mirror the
   fingerprint path exactly: an unknown id (including one whose session was
   reaped by TTL) spawns a session and **seeds** it from all messages except
   the trailing user message; a known live id forwards only the trailing user
   message. A reaped pin therefore recovers automatically from client-held
   history on the next request.
2. **History-prefix stickiness (default)** — fingerprint = SHA-256 over the
   normalized `(role, content-as-text)` sequence of all messages **except the
   trailing user message**. Hit → forward only that trailing user message to
   the mapped live session. Miss → spawn a session and **seed** it: prior
   system/user/assistant messages are flattened into one clearly-delimited
   context preamble prepended to the first prompt. After each completed turn
   the router stores the next expected fingerprint (received history + user
   message + the exact assistant text returned), so turn N+1 matches. An
   edited history simply misses and gets a fresh seeded session — correct,
   just slower.
3. **Lifecycle** — facade-created sessions carry an idle TTL
   (`FACADE_SESSION_TTL_MS`, default 10 min; explicit pins get
   `FACADE_PINNED_TTL_MS`, default 60 min) and an LRU cap
   (`FACADE_MAX_SESSIONS`, default 8). Reaping kills the PTY and drops
   mappings. At the cap, a new conversation evicts the least-recently-used
   **idle** facade session; if every session is mid-turn, the request is
   rejected with a provider-shaped 429 (`rate_limit_exceeded` /
   `overloaded_error`) rather than killing an in-flight turn.
   Same-conversation requests serialize on the session's existing
   FIFO PromptQueue; distinct conversations parallelize on separate sessions.
   Facade PTY sessions default to very wide terminals
   (`FACADE_COLS`, default 400) to minimize hard-wrap damage to code blocks.

### TurnRunner seam

```js
runTurn({record, userText, seedText, signal})
  → async iterable of events:
      {type:'delta', text}                                   // zero or more
      {type:'done', text, finishReason, usage?}              // terminal
    | {type:'dialog', promptText}                            // terminal
```

- **PtyTurnRunner** (every `mode:'pty'` profile): enqueue on the session's
  queue → `markBusy` → bracketed-paste write + submit → `StreamRenderer`
  re-renders on data events and emits newly-stabilized rendered lines through
  `adapter.extractResponse` as `delta` events (line-granularity streaming —
  honest but coarse) → on settle, `done` with the full cleaned text. On
  `awaiting_input`: handled per the profile's `dialogPolicy` (definitions in
  Profiles); whatever the policy does not auto-answer emits `dialog`.
- **HeadlessClaudeRunner** (`claude-headless`): first turn spawns
  `claude -p --output-format stream-json --verbose
  --include-partial-messages` (the partial-messages flag is required — without
  it stream-json emits only whole-message events, not incremental deltas),
  captures Claude's own `session_id` from the `init` event and stores it on
  the conversation; later turns add `--resume <session_id>`. Events parsed:
  `init` → session_id; `stream_event`-wrapped `content_block_delta`
  `text_delta`s → `delta` events; the final `result` event → exact full text
  and **real token usage**. Same env-scrub
  (subscription auth), profile cwd; the profile's `args` are appended after
  the runner's fixed flags. Not browser-observable — documented trade-off,
  chosen per model name. Headless conversations need no seeding after the
  first turn because `--resume` carries real context; the seeding path still
  exists for them and is how recovery works after a resume failure (see Error
  handling).

### Translation rules (uniform across dialects)

- Prompt extraction: the trailing user message is the turn's input; earlier
  messages participate only in fingerprinting/seeding. A changed system prompt
  mid-conversation changes the fingerprint and correctly starts a fresh
  seeded session.
- Message content may be a string or the array-of-parts form; text parts are
  concatenated, non-text parts rejected with a provider-shaped 400.
- `finish_reason`/`stop_reason`: settle → `stop` / `end_turn`. Timeout →
  provider-shaped error (see below), not a truncated success.
- `usage`: real (headless) or estimated (PTY) with a
  `"bridge": {"usage_estimated": true}` vendor field. Estimate:
  `prompt_tokens` = chars/4 of the text actually written to the PTY (seed
  preamble included), `completion_tokens` = chars/4 of the extracted assistant
  text, `total_tokens` = sum.
- Anthropic's top-level `system` parameter canonicalizes to a leading
  `(system, text)` tuple in the fingerprint/seed sequence — two conversations
  differing only in system prompt never collide.
- A trailing non-user message (Anthropic assistant prefill) is rejected with a
  provider-shaped 400: prefill is unsupported.
- **Responses API continuity**: every response's `resp_<uuid>` id is stored as
  a conversation handle; a request carrying `previous_response_id` is treated
  as an explicit pin to that conversation (only the new `input` is forwarded).
  Unknown/expired ids → provider-shaped 404. `store` is accepted and ignored
  (mappings live in memory until TTL, regardless).
- Streaming: correct SSE framing per dialect. Chat:
  `chat.completion.chunk` frames + `data: [DONE]`. Responses, minimum event
  sequence for SDK compatibility: `response.created` →
  `response.in_progress` → `response.output_item.added` →
  `response.content_part.added` → `response.output_text.delta`× →
  `response.output_text.done` → `response.content_part.done` →
  `response.output_item.done` → `response.completed`. Anthropic:
  `message_start` → `content_block_start` → `content_block_delta`× →
  `content_block_stop` → `message_delta` (stop_reason/usage) →
  `message_stop`.
- IDs: `chatcmpl-<uuid>` / `resp_<uuid>` / `msg_<uuid>`; `created` from clock.
- **Errors after streaming has begun** (status line already sent): OpenAI
  dialects emit a final `data: {"error": {…}}` frame followed by
  `data: [DONE]`, then close; the Anthropic dialect emits its native
  `event: error` frame, then closes.

## Error handling

- **Settle timeout (PTY)**: provider-shaped error to the caller; the session is
  flagged `suspect` so the queue refuses to type the next prompt until the
  detector reaches a confirmed idle again (self-healing; `DELETE` always
  works). This also fixes the existing hazard where a timed-out prompt's
  successor interleaves into a still-busy CLI.
- **Dialog mid-turn**: provider-shaped error carrying the dialog text and the
  conversation id; session left intact and answerable via `POST /key`.
  Precise retry semantics: the interrupted turn does **not** advance the
  fingerprint; the conversation is marked dialog-blocked and its pending turn
  stays buffered. A retry with the identical fingerprint and trailing user
  message does not re-type — it attaches to the pending turn, returning the
  extracted text if the operator's answer let the session settle, or the same
  dialog error if still blocked. Any other request routes normally.
- **Session exited mid-turn**: provider-shaped error; the router drops the
  mapping so the next request reseeds a fresh session from client-held history.
- **Client disconnect during streaming**: detach the renderer, let the CLI
  finish its turn in the background so session state stays consistent (no
  automatic ESC-interrupt; documented).
- **Headless runner failures**: `--resume` rejected (Claude-side session
  expired/invalid), malformed or truncated stream-json, or nonzero exit →
  provider-shaped error; the conversation's stored `session_id` is dropped, so
  the next request reseeds a fresh first `-p` turn from client-held history
  (the same seeding path the PTY runner uses).
- **Malformed requests**: validated per dialect; native provider 400 shapes.
- **Unknown/unusable model**: facade requests → 404 `model_not_found` (see
  Models); a headless profile requested via the session/WS API → 400 with an
  explanatory body.

## Security

Unchanged model, restated explicitly: loopback bind, one token, timing-safe
compare, no new unauthenticated surface (every facade route sits behind the
gate). Handing a tool the bridge URL + token grants full interactive control
of whichever CLIs are enabled — same trust level as the existing API; the
facade toggles and the `BRIDGE_PROFILES` allowlist (see Profiles) are the
blast-radius controls.
Profile env-scrub blocks the documented env-var API-key paths so traffic uses
subscription auth — best-effort, not a guarantee: file-based auth
(`~/.gemini/.env`, gcloud ADC files, CLI config files) is outside env-scrub's
reach and must be managed by the operator (documented per profile in the
README). **Legacy back-compat:** today the bridge unconditionally strips
`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from *every* spawned child, and the
README promises this for the documented `ADAPTER=generic CLAUDE_CMD=<tool>`
combination. Moving scrub to per-profile lists must not silently regress that:
when the legacy `ADAPTER=generic` mapping is active, the `generic` profile
inherits the two `ANTHROPIC_*` scrub entries (a fresh `generic` profile chosen
by name stays scrub-free, as its table entry specifies). Browser-based OAuth
onboarding is never auto-answered.
`dialogPolicy: auto-approve` is an explicit opt-in with a security warning in
the README.

## Testing

Extends the existing `node --test` suite (46 tests):

1. **Unit** — router fingerprinting (hit / miss / edited history / explicit
   pin / post-turn fingerprint advance), TTL+LRU reaping, dialect translators
   via golden request→response JSON pairs including SSE chunk framing,
   bracketed-paste writer, profile resolution + env-scrub + back-compat
   mapping, provider error shapes.
2. **Adapter fixtures** — codex/gemini/copilot fixture sets captured per the
   NOTES.md protocol, rendered via TerminalModel; markers and
   `extractResponse` asserted against them; CLI version pins recorded.
3. **Integration without subscription usage** — a scripted bash fake-REPL
   behind the `generic` profile exercises the full pipeline; official
   `openai` and `anthropic` SDKs point at an in-process bridge (streaming and
   non-streaming, multi-turn stickiness, explicit pinning); the
   `POST /prompt` `text` field is asserted here too; the headless
   runner is tested against a stub `claude` shim script that speaks
   stream-json.
4. **Live acceptance (opt-in, manual)** — a checked-in script drives real
   claude/codex/gemini through both SDKs end-to-end; excluded from default
   CI (consumes subscription quota).

## Phasing

- **Phase 1 (universal)** is fully shippable alone: profiles, registry,
  adapters, fixtures, multiline writer, detector changes, API `profile`
  params, the `POST /prompt` `text` field.
- **Phase 2 (facade)** lands on top: facade module, router, runners,
  dialects, SDK integration tests.
- Each phase gets its own implementation plan from this spec.

## Known risks & mitigations

| Risk | Mitigation |
|---|---|
| New CLIs' markers are version-pinned UI copy | Same discipline as claude: fixtures + version pins per adapter; single fragile file per CLI |
| A CLI uses alt-screen / in-place repaint, breaking transcript diffs | Detected in the fixture spike; adapter marked degraded; headless-runner seam is the escape hatch |
| Spinner-animated CLIs never go quiescent | periodic `isIdle`/`isBusy` marker evaluation during sustained output (see StateDetector changes) + per-profile `quiescenceMs` |
| PTY hard-wrap mangles long code lines | `FACADE_COLS=400` default for facade sessions; headless runner for exact fidelity |
| Client HTTP timeouts vs long generations | Streaming keeps the socket alive; non-streaming documented to need generous client timeouts |
| Copilot adapter unverified without a seat | Shipped as marked stub; pre-auth fixtures real; verification task queued for when a seat exists |
| Fingerprint misses on clients that rewrite history | Falls back to fresh seeded session — degraded latency, correct behavior |
