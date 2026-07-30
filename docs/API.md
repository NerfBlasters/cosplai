# HTTP / WebSocket API reference

The bridge exposes one process on `HOST:PORT` (default `127.0.0.1:7681`). Every
route and the WebSocket upgrade require the token; `/vendor/*` static assets are
the only unauthenticated surface.

## Auth

Send the token as either:

- `Authorization: Bearer <token>` header, or
- `?token=<token>` query parameter

The token is printed at startup (or set `BRIDGE_TOKEN`). Comparison is
constant-time. A missing/invalid token returns `401`.

## Session lifecycle & states

A session wraps one interactive CLI process on a PTY, chosen by **profile**
(`claude` by default — see [README.md § Profiles](../README.md#profiles) for
the full built-in list and their trade-offs). Its detected state:

| state | meaning |
|---|---|
| `starting` | process spawned, nothing rendered yet (rarely observed) |
| `busy` | generating / redrawing (output not yet quiescent) |
| `idle` | at the input prompt, ready for the next prompt |
| `awaiting_input` | blocked on a dialog/menu — **most commonly the "trust this folder" prompt on first launch**; answer with `POST /key` |
| `exited` | the `claude` process ended |

State is detected best-effort from terminal output quiescence + rendered-screen
markers (see [ARCHITECTURE.md](ARCHITECTURE.md)). It is **not** a structured
signal from Claude.

## Endpoints

### `POST /api/sessions`
Create a session (spawns the profile's CLI). Optional body
`{cwd?, cols?, rows?, profile?}`.
→ `201 {id, state, profile}`

`profile` selects which built-in profile to spawn (default: `DEFAULT_PROFILE`,
itself `claude` unless overridden — see [Configuration](#configuration) and
[README.md § Profiles](../README.md#profiles)). If `profile` names something
that isn't usable as an interactive session — an unknown name, a
`headless`-mode profile, a profile with no command configured, or one whose
adapter isn't registered — the request fails closed:
→ `400 {error, validProfiles}` (`validProfiles` is the list of currently
enabled profile names, i.e. `Object.keys(config.profiles)`).

```bash
curl -s -XPOST http://127.0.0.1:7681/api/sessions \
  -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{}'
# {"id":"...","state":"busy","profile":"claude"}
```

### `GET /api/sessions`
List sessions. → `200 {sessions:[{id,state,createdAt,profile}]}`

### `GET /api/sessions/:id`
→ `200 {id,state,createdAt,profile}` | `404`

### `DELETE /api/sessions/:id`
Kill the PTY and drop the record. → `204`

### `POST /api/sessions/:id/prompt`
Body `{text, submit?=true, timeoutMs?}`. Writes `text` into the session, submits
(unless `submit:false`), waits until the session settles, and returns both the
raw rendered delta and a chrome-stripped extraction of it.
→ `200 {state, output, text, prompt, durationMs}`

- `state` — `idle` (response complete) or `awaiting_input` (the CLI is asking
  something; inspect `prompt`).
- `output` — the raw rendered-transcript delta produced since the prompt was
  sent (may include TUI chrome: box-drawing, footers, echoed input).
- `text` — `output` run through the profile's adapter `extractResponse`:
  chrome-stripped assistant text only. For the two **degraded (alt-screen)**
  adapters, `antigravity` and `copilot`, this extraction is best-effort (and
  empty for `copilot` since 1.0.75, re-verified on 1.0.76 — use the `copilot-headless` facade profile for
  exact output) — see
  [README.md § Profiles](../README.md#profiles) — the transcript-diff model
  the extraction relies on isn't a fully dependable scrollback across
  alt-screen repaints, so `text` may retain stray chrome or drop content on
  those two profiles. `claude`, `codex`, and `generic` are not degraded.
- `prompt` — text of what is being asked when `state==="awaiting_input"`, else `null`.
- Errors: `400` — no `text`, **or** `text` contains a newline that the
  profile's adapter can't safely submit (no bracketed-paste support and no
  `newlineKey` fallback configured); `409` (session not alive/exited); `504`
  (settle timeout — session left intact); `413` (body > 1 MiB); `401`.

Requests are serialized per session (a FIFO queue), so concurrent prompts do not
interleave.

```bash
curl -s -XPOST http://127.0.0.1:7681/api/sessions/$SID/prompt \
  -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"text":"Summarize the last 24h of failed sign-ins"}'
```

### `POST /api/sessions/:id/key`
Body `{keys:[...]}`. Sends raw keys — used to answer permission/menu dialogs.
Logical key names: `enter`, `submit`, `up`, `down`, `left`, `right`, `esc`,
`tab`, `ctrl-c`; any other string is sent through as literal characters.
→ `200 {state}`

```bash
# accept the first-launch "trust this folder" dialog
curl -s -XPOST http://127.0.0.1:7681/api/sessions/$SID/key \
  -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"keys":["enter"]}'
```

### `GET /api/sessions/:id/events`  (Server-Sent Events)
Live stream of `{"type":"output","data":"…"}` (incremental terminal output) and
`{"type":"state","state":"…"}` (state transitions). Useful for reacting in real
time instead of blocking on `POST /prompt`.

### `GET /ws?token=…&session=:id&profile=…`  (WebSocket — browser terminal)
Binds a terminal client to a session (creates one if `session` is omitted).
Server → client: raw PTY bytes (scrollback first, then live). Client → server:
text frames are keystrokes; a JSON control frame `{"type":"resize","cols":N,"rows":N}`
resizes the PTY. This is what `public/index.html` (xterm.js) uses.

`profile` selects which profile to spawn — it is consulted **only** when this
connection creates a new session with **no `session=` param at all**. Whenever
`session=` is present it wins: an existing id attaches as-is, and an unknown id
falls back to creating the server's `DEFAULT_PROFILE` — in **both** cases
`profile` is silently ignored (attaching never respawns or reconfigures, and
the create-fallback does not honor a conflicting `profile`). If the
*effective* creation profile — the explicit `?profile=` or, absent that, the
server's `DEFAULT_PROFILE` — is unknown, `headless`-mode, or has no command
configured, the upgrade is rejected **before the WebSocket handshake
completes**: a plain HTTP `400` response with body `{error, validProfiles}`,
same shape as the `POST /api/sessions` rejection.

**Same PTY, two views:** the WebSocket and the HTTP API attach to the same
terminal, so a `POST /prompt` renders live in any attached browser, and vice
versa. To point a browser at an API-created session, open
`/?token=…&session=<id>`.

**Ownership / reaping:** a session created implicitly by a WebSocket connection
(no `session=`) is killed when that socket closes. A session created via
`POST /api/sessions` (or attached to via `?session=`) persists until `DELETE`.

## Scripted round-trip (create → settle → prompt)

```bash
TOK=...; BASE=http://127.0.0.1:7681
SID=$(curl -s -XPOST $BASE/api/sessions -H "authorization: Bearer $TOK" \
        -H 'content-type: application/json' -d '{}' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

# first launch may show the trust dialog → answer it if awaiting_input
state=$(curl -s $BASE/api/sessions/$SID -H "authorization: Bearer $TOK" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)
[ "$state" = awaiting_input ] && curl -s -XPOST $BASE/api/sessions/$SID/key \
  -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"keys":["enter"]}' >/dev/null

curl -s -XPOST $BASE/api/sessions/$SID/prompt -H "authorization: Bearer $TOK" \
  -H 'content-type: application/json' -d '{"text":"your hunt prompt"}'
```

## Cloud-API facade

Four additional routes speak the OpenAI / Anthropic wire protocols, translating
requests into turns on the interactive CLIs (or the headless `claude -p` runner
for the `claude-headless` profile). Official SDKs work unmodified — errors are
provider-shaped so each SDK raises its native exception types. `model` is the
profile name; see [README.md § Cloud-API facade](../README.md#cloud-api-facade)
for the concept overview, env toggles, and SDK snippets.

**Auth per family:** OpenAI-family routes (`/v1/models`,
`/v1/chat/completions`, `/v1/responses`) take `Authorization: Bearer <token>`.
The Anthropic route (`/v1/messages`) additionally accepts
`x-api-key: <token>`. Invalid/missing → provider-shaped `401` (not the bridge's
plain 401). Facade request bodies may be up to 8 MiB (vs 1 MiB on the bridge
API) since they carry whole conversation histories.

### Conversation routing (pins & stickiness)

Every request names a profile and carries full history; the facade maps it to a
live CLI session:

1. **`X-Bridge-Conversation: <id>` header** — highest precedence, explicit pin.
2. **`previous_response_id`** (Responses API only) — pins to the conversation
   that produced that response. Unknown/expired id → `404`.
3. **`model` suffix** — `"claude#my-conv"` splits into profile `claude`, pin
   `my-conv`. Ignored when `previous_response_id` is present.
4. **Fingerprint stickiness** (no pin given) — a request whose `(profile,
   history)` equals a prior turn's `(profile, history + exact assistant
   reply)` reuses that turn's session. This makes the standard
   send-the-whole-conversation SDK loop stick automatically.

A miss on all four seeds a **new** session, replaying the client-held history
as a context preamble before the live turn. A pin bound to profile A used with
model B → `400`. Idle sessions are reaped after `FACADE_SESSION_TTL_MS`
(pinned: `FACADE_PINNED_TTL_MS`); a reaped pin transparently recovers on next
use by reseeding from the client's history. At `FACADE_MAX_SESSIONS`, the
least-recently-used idle session is evicted; if **all** are mid-turn → `429`.

**Streaming fidelity (PTY profiles).** Streamed deltas are best-effort
line-granular renders of a repainting terminal: they can occasionally include
stray TUI chrome, and after a mid-turn repaint the stream may re-emit
corrected lines (a client concatenating deltas can see duplicates — the
stream never *drops* final content). The non-streaming response text and the
fingerprint the router stores are always the clean final render. For
byte-exact streams, use a headless profile — `claude-headless` (streams from
`stream-json`) or `copilot-headless` (from `copilot -p --output-format json`)
— which read structured output rather than a terminal.

### `GET /v1/models`

Lists facade-usable profiles (enabled via `BRIDGE_PROFILES` and having a
command configured) as OpenAI model objects. Mounted when at least one
OpenAI-family dialect is enabled.

```json
{ "object": "list", "data": [
  { "id": "claude", "object": "model", "created": 1753500000, "owned_by": "bridge" },
  { "id": "claude-headless", "object": "model", "created": 1753500000, "owned_by": "bridge" } ] }
```

### `POST /v1/chat/completions`

OpenAI Chat Completions. Body: `model`, `messages` (last must be `user`;
`developer` role is treated as `system`), optional `stream`,
`stream_options.include_usage`, `n` (must be 1).

```bash
curl -s http://127.0.0.1:7681/v1/chat/completions \
  -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"model":"claude","messages":[{"role":"user","content":"reply with exactly: PONG"}]}'
```

```json
{ "id": "chatcmpl-…", "object": "chat.completion", "created": 1753500000, "model": "claude",
  "choices": [ { "index": 0, "message": { "role": "assistant", "content": "PONG" },
                 "logprobs": null, "finish_reason": "stop" } ],
  "usage": { "prompt_tokens": 7, "completion_tokens": 2, "total_tokens": 9 },
  "bridge": { "usage_estimated": true } }
```

With `"stream": true` (SSE, `data:`-only frames, closed by `data: [DONE]`):

```
data: {"id":"chatcmpl-…","object":"chat.completion.chunk",…,"choices":[{"index":0,"delta":{"role":"assistant","content":""},…,"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk",…,"choices":[{"index":0,"delta":{"content":"PONG"},…,"finish_reason":null}]}

data: {"id":"chatcmpl-…","object":"chat.completion.chunk",…,"choices":[{"index":0,"delta":{},…,"finish_reason":"stop"}]}

data: [DONE]
```

(One extra `choices: []` chunk carrying `usage` is emitted before `[DONE]` when
`stream_options.include_usage` is set.)

### `POST /v1/responses`

OpenAI Responses. Body: `model`, `input` (string, or array of message items —
only `type: "message"` items are supported), optional `instructions` (becomes
the system message), `stream`, `previous_response_id`. Non-stream responses
return a full `response` object whose `id` (`resp_…`) can be sent back as
`previous_response_id` to continue the same CLI session.

```bash
curl -s http://127.0.0.1:7681/v1/responses \
  -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"model":"claude","input":"reply with exactly: PONG"}'
```

```json
{ "id": "resp_…", "object": "response", "created_at": 1753500000, "status": "completed",
  "model": "claude", "instructions": null, "previous_response_id": null,
  "output": [ { "id": "msg_…", "type": "message", "status": "completed", "role": "assistant",
                "content": [ { "type": "output_text", "annotations": [], "logprobs": [], "text": "PONG" } ] } ],
  "usage": { "input_tokens": 7, "input_tokens_details": { "cached_tokens": 0 },
             "output_tokens": 2, "output_tokens_details": { "reasoning_tokens": 0 }, "total_tokens": 9 },
  "bridge": { "usage_estimated": true }, "…": "(full spec-shaped scaffold elided)" }
```

Streaming uses the spec's typed event sequence (each frame is
`event: <type>` + `data:` with a monotonic `sequence_number`):

```
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{…"status":"in_progress"…}}

event: response.in_progress
data: {"type":"response.in_progress","sequence_number":1,…}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{…}}

event: response.content_part.added
data: {"type":"response.content_part.added","sequence_number":3,…}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_…","delta":"PONG",…}

event: response.output_text.done
data: {"type":"response.output_text.done","sequence_number":5,…"text":"PONG",…}

event: response.content_part.done
data: {…}

event: response.output_item.done
data: {…}

event: response.completed
data: {"type":"response.completed",…,"response":{…full final response object…}}
```

### `POST /v1/messages`

Anthropic Messages. Body: `model`, `messages` (roles `user`/`assistant` only;
last must be `user` — **assistant prefill is rejected** with `400`), optional
top-level `system` (string or text blocks), `stream`. `max_tokens` is accepted
and ignored like all sampling params.

```bash
curl -s http://127.0.0.1:7681/v1/messages \
  -H "x-api-key: $TOK" -H 'content-type: application/json' \
  -d '{"model":"claude","max_tokens":100,"messages":[{"role":"user","content":"reply with exactly: PING"}]}'
```

```json
{ "id": "msg_…", "type": "message", "role": "assistant", "model": "claude",
  "content": [ { "type": "text", "text": "PING" } ],
  "stop_reason": "end_turn", "stop_sequence": null,
  "usage": { "input_tokens": 7, "output_tokens": 2 },
  "bridge": { "usage_estimated": true } }
```

Streaming uses native Anthropic event framing:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_…","type":"message","role":"assistant",…"content":[],…}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PING"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":7,"output_tokens":2},"bridge":{"usage_estimated":true}}

event: message_stop
data: {"type":"message_stop"}
```

### Facade error shapes

Errors are shaped per family so each official SDK raises its native exception
class. OpenAI-family bodies are `{"error": {"message", "type", "param",
"code"}}`; Anthropic bodies are `{"type": "error", "error": {"type",
"message"}}`. Bridge-specific diagnostics ride in a top-level `"bridge"`
object alongside, never inside, the provider shape.

| Status | When | OpenAI `type` / `code` | Anthropic `error.type` | `bridge` fields |
|---|---|---|---|---|
| 400 | validation (missing model/messages, non-text parts, trailing non-user message, prefill, pin↔model mismatch, unsubmittable multiline) | `invalid_request_error` / `null` | `invalid_request_error` | — |
| 401 | bad/missing token | `invalid_request_error` / `invalid_api_key` | `authentication_error` | — |
| 404 | unknown profile (model) | `invalid_request_error` / `model_not_found` | `not_found_error` | — |
| 404 | unknown/expired `previous_response_id` | `invalid_request_error` / `null` | `not_found_error` | — |
| 409 | CLI blocked on an interactive dialog | `invalid_request_error` / `bridge_dialog_pending` | `invalid_request_error` | `conversation_id`, `session_id`, `dialog` (the rendered prompt text) |
| 413 | body > 8 MiB | `invalid_request_error` / `null` | `invalid_request_error` | — |
| 429 | all `FACADE_MAX_SESSIONS` PTY sessions mid-turn | `rate_limit_error` / `rate_limit_exceeded` | `overloaded_error` | — |
| 500 | CLI session died mid-turn / spawn failure / headless failure | `api_error` / `null` | `api_error` | `reason: "session_exited"`, `exit_code`, `signal`, and `spawn_error` when the death carries an exec diagnostic; headless errors carry `stderr` |
| 504 | turn didn't settle within `PROMPT_TIMEOUT_MS` | `api_error` / `bridge_settle_timeout` | `api_error` | — |

**409 dialog flow:** answer the dialog out-of-band with `POST
/api/sessions/<bridge.session_id>/key`, then **retry the byte-identical
request** — the facade recognizes the retry (same fingerprint + user message)
and attaches to the still-pending turn, returning its result without
re-typing the prompt. A retry while the dialog is still up returns the same
`409`.

**Mid-stream errors** (after SSE has started): OpenAI-family streams emit a
final `data:` frame containing the provider-shaped error body, then
`data: [DONE]`; the Anthropic stream emits a native `event: error` frame,
then closes.

## Configuration

See the full env table in the [README](../README.md#configuration). Key ones:
`BRIDGE_TOKEN`, `HOST`, `PORT`, `CLAUDE_CMD`, `CLAUDE_ARGS`, `CWD`,
`QUIESCENCE_MS`, `PROMPT_TIMEOUT_MS`, `ADAPTER` (`claude` | `generic`), and
the profile-system vars below.

### Profiles

- `DEFAULT_PROFILE` (default `claude`) — the profile a bare `POST
  /api/sessions` or `GET /ws` (no `?profile=`) spawns. Rejected at boot if it
  names a `headless`-mode or command-less profile — a session default must
  always be spawnable.
- `BRIDGE_PROFILES` — comma-separated allowlist of enabled profile names
  (default: all built-ins — `claude`, `codex`, `antigravity`, `copilot`,
  `generic`, `claude-headless`, `copilot-headless`). A profile not in this list doesn't exist at
  runtime: it's absent from `validProfiles` and rejected the same as an
  unknown name.
- `PROFILE_<NAME>_*` — per-profile overrides, one set per enabled profile.
  `<NAME>` is the profile name **uppercased with `-` replaced by `_`**
  (e.g. `claude-headless` → `PROFILE_CLAUDE_HEADLESS_*`). Fields:
  - `PROFILE_<NAME>_COMMAND` — the executable to spawn.
  - `PROFILE_<NAME>_ARGS` — JSON array string, e.g. `'["--sandbox","read-only"]'`.
  - `PROFILE_<NAME>_ENV_SCRUB` — comma-separated env var names to delete from
    the child's environment before spawn.
  - `PROFILE_<NAME>_DIALOG_POLICY` — one of `startup-only` (default) |
    `auto-approve` | `never`.
  - `PROFILE_<NAME>_QUIESCENCE_MS`, `PROFILE_<NAME>_COLS`,
    `PROFILE_<NAME>_ROWS`, `PROFILE_<NAME>_CWD` — per-profile overrides of the
    matching legacy globals.

  Example: `PROFILE_GENERIC_COMMAND=bash DEFAULT_PROFILE=generic` makes a bare
  `POST /api/sessions` spawn `bash` under the `generic` adapter.

**Precedence, highest to lowest, for every resolved profile field:**

1. **Per-profile env override** — `PROFILE_<NAME>_*` (above).
2. **The profile's own table value** — the built-in `profiles` entry in
   `src/config.js`; for `claude` specifically, the legacy `CLAUDE_CMD` /
   `CLAUDE_ARGS` vars map onto this level (they override the `claude`
   profile's command/args the same as if the table shipped them directly).
3. **Legacy global env vars** — `QUIESCENCE_MS`, `COLS`, `ROWS`, `CWD` (and
   `PROMPT_TIMEOUT_MS`/`SCROLLBACK`/`RING_BYTES`, which aren't per-profile) —
   existing single-profile deployments keep their tuning untouched.
4. **Built-in defaults** baked into `BUILTIN_PROFILES` in `src/config.js`.

`adapter` and `mode` are structural identity, not tunable fields — there is no
`PROFILE_<NAME>_ADAPTER`/`_MODE`; to change them, pick a different profile.
