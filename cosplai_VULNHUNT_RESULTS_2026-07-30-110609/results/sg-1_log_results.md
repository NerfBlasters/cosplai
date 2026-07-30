# SG-1 — LOG class-group trace results

Repo root: `/home/kali/repos/cosplai`
Class group: Race conditions, cache/state isolation, credential scope, resource
exhaustion, prototype pollution, crypto, integer overflow.

## Disposition table

| # | Input | Disposition | Note |
|---|---|---|---|
| 5 | `model` (chat) | CANDIDATE → VULN-001 | selects `mode:'headless'` profile ⇒ bypasses `_ensureCapacity`; profile lookup itself SAFE (see notes) |
| 6 | `messages[].role` | NO-MATCH | free-form string; only reaches `_fp()` JSON and the seed preamble text (INJ surface, not LOG) |
| 7 | `messages[].content` (prompt) | CROSS-CLASS (INJ) | `shared.js:111` → `router.js:38-47` → `promptWriter.js:9-18` / `headlessCopilotRunner.js:96` argv / `headlessClaudeRunner.js:85` stdin. Prompt-into-agentic-CLI is the app's purpose (Gate 0) but the *content* sink is INJ, not LOG. Unbounded `messages` array → see VULN-005 |
| 8 | `n` | SAFE | `body.n != null && body.n !== 1` → strict-equality allowlist, `openaiChat.js:27` |
| 9 | `stream` | SAFE | `=== true` boolean coercion |
| 10 | `stream_options.include_usage` | SAFE | `!!(...)` boolean coercion |
| 11 | `x-bridge-conversation` (pin id) | CANDIDATE → VULN-002 | arbitrary string becomes `conv.id` and `_convs` key; shares the key space with server `crypto.randomUUID()` conv ids |
| 12 | `model` `#<pin>` suffix | CANDIDATE → VULN-002 | same sink, `openaiChat.js:13-15` |
| 13 | `model` (responses) | CANDIDATE → VULN-001 | same as #5 |
| 14 | `instructions` | NO-MATCH | becomes a `{role:'system'}` message; INJ surface |
| 15 | `input` (prompt) | CROSS-CLASS (INJ) | as #7 |
| 16 | `input[].role/.type/.content` | SAFE (LOG) | `type` allowlisted to `null`/`'message'` (`openaiResponses.js:26`); rest as #6/#7 |
| 17 | `previous_response_id` | SAFE (LOG) | read-only `Map.get` on `_byResp` (`router.js:227`); keys are `resp_<uuid>` (unguessable, `router.js:142`); no write, no growth from this input. Registration-side growth folded into VULN-005 |
| 18 | `stream` | SAFE | `=== true` |
| 19 | `model` (messages) | CANDIDATE → VULN-001 | same as #5 |
| 20 | `system` | NO-MATCH | INJ surface |
| 21 | `messages[].role`/`.content` | CROSS-CLASS (INJ) | `role` strictly allowlisted to `user`/`assistant` here (`anthropicMessages.js:28`) |
| 22 | `stream` | SAFE | `=== true` |
| 23 | `x-api-key` | SAFE | `auth.js:3-9` constant-time compare; both operands type-checked; fails closed when absent (`index.js:45`). Length-inequality early return leaks only token length (24 random bytes → no practical gain) |
| 24 | arbitrary body keys → `console.warn` | CANDIDATE → VULN-003 | unbounded module-global `Set` + attacker-controlled log line, `shared.js:124-133` |
| 25 | `GET /v1/models` | NO-MATCH | no input; iterates `config.profiles` only (`models.js:11-13`) |
| 42 | claude child stdout (`j.session_id`, `j.result`, `j.usage`) | CANDIDATE → VULN-004 (unbounded `buf`/`stderr`); CROSS-CLASS (INJ) for `j.session_id` → `--resume <id>` argv (`headlessClaudeRunner.js:17`) | |
| 43 | copilot child stdout | CANDIDATE → VULN-004 | `j.sessionId` is `=`-joined (`headlessCopilotRunner.js:97`), so no argv-split there |
| 44 | child stderr → API client | CANDIDATE → VULN-006 | `stderr.slice(-2000)` echoed in the error body |
| G4 | copilot tool-lockdown scrub | DESIGN-INTENT (operator-config-gated) | `--mcp-config` and case/spelling variants are outside `EXPOSURE_*_FLAGS` (`headlessCopilotRunner.js:65-66`), but only `profile.args` (operator config, trusted per threat model) can reach them; the untrusted prompt is a single `-p` argv value and cannot alter argv. See note below |
| G5 | conversation identity classification | CANDIDATE → VULN-002 | |

Absent-input analysis: the only security-gating input in this partition is the
credential (#23 / `Authorization`). `index.js:41-48` calls `checkToken` with
whatever `extractToken` returned (possibly `null`) and `auth.js:4` returns
`false` for non-strings — **fails closed**, no CVB. All other inputs are
optional feature parameters whose absence takes the default path.

---

## Candidates

#### [VULN-001] Headless profiles bypass the facade's concurrency cap — unbounded conversation and child-process creation (CWE-400)
- **Input**: #5 / #13 / #19 (`model` selecting `claude-headless` or `copilot-headless`), amplified by #11/#12 (a fresh pin id per request forces a fresh conversation)
- **Class**: CWE-400: Uncontrolled Resource Consumption
- **Severity**: High
- **Location**: `src/facade/router.js:59` (`if (profile.mode === 'pty') this._ensureCapacity();`), `src/facade/router.js:49-55`, `src/facade/router.js:73-75`
- **Gate 0 (intended behavior?)**: No. The facade *has* a concurrency control —
  `FACADE_MAX_SESSIONS` (default 8), documented in `README.md:356` as "max
  concurrent facade PTY sessions", enforced by `_ensureCapacity()` with LRU
  eviction and a `429` when everything is mid-turn. The headless branch skips
  that control entirely. This is a control that exists and is not applied on one
  branch — Gate 0 does not exempt a security/availability control being
  conditionally skipped.
- **Gate 1 (reachable?)**: Reachable from all three façade POST routes.
  `_create` is called at `router.js:115` and `router.js:121`; `mode:'headless'`
  profiles `claude-headless` and `copilot-headless` are in the default
  `BRIDGE_PROFILES` allow-list (`config.js:103-105`, `config.js:67-81`) and are
  listed by `GET /v1/models` (`models.js:11-13`). Not test-only.
- **Gate 2a (attacker-controlled?)**: Yes. `profileName` comes from `body.model`
  (`openaiChat.js:37` → `parsePin` → `router.js:220-221`); `pinId` comes from the
  `x-bridge-conversation` header or the `#` suffix (`openaiChat.js:12-17`). Both
  are raw request-controlled strings.
- **Gate 2b (sanitization?)**: `profileName` is validated to exist in
  `config.profiles` and to have a `command` (`router.js:222`). That is an
  allow-list on *which* profile, not a cap on *how many*. There is no counter,
  semaphore, or queue shared across headless conversations: each conv gets its
  own `PromptQueue` (`router.js:74`), so serialization is per-conversation only.
  Grep for `maxSessions|_ensureCapacity|concurren` over `src/` returns only
  `router.js:49,51,59` and `config.js:225` — no other limiter exists.
- **Gate 3 (new capability?)**: Yes, concretely. Baseline for a bridge-token
  holder is at most `FACADE_MAX_SESSIONS` (8) concurrent CLI children plus the
  bridge API's own sessions. Via this branch, N concurrent
  `POST /v1/chat/completions` requests with `model: "claude-headless#<uuid_N>"`
  produce N distinct conversations (`router.js:114-118`) and therefore N
  simultaneous `spawn('claude', …)` / `spawn('copilot', …)` children
  (`headlessClaudeRunner.js:25`, `headlessCopilotRunner.js:113`), each held for
  up to `promptTimeoutMs` = **600 000 ms** (`config.js:210`). The attacker gets
  arbitrary-multiplicity process creation on the operator's host — a fork bomb
  and memory/PID exhaustion that the 8-session cap was written to prevent.
- **Entry Point**: `POST /v1/chat/completions`, `POST /v1/responses`,
  `POST /v1/messages`
- **Data Flow**:
  `body.model` (`openaiChat.js:21,37`) → `parsePin()` (`openaiChat.js:12-17`) →
  `norm.profileName`/`norm.pinId` (`openaiChat.js:39`) →
  `ctx.router.executeTurn()` (`openaiChat.js:62-65`) →
  `router.executeTurn` profile lookup (`router.js:221`) →
  `acquire()` (`router.js:230`) → `_create({profileName, id: pinId, pinned:true})`
  (`router.js:115`) → `router.js:59` capacity check **skipped** for
  `mode:'headless'` → `conv.queue = new PromptQueue()` (`router.js:74`) →
  `conv.queue.enqueue` (`router.js:238`) → `_runTurn` (`router.js:177-183`) →
  `runHeadlessClaudeTurn` → `spawn(profile.command, args, …)`
  (`headlessClaudeRunner.js:25`) / `headlessCopilotRunner.js:113`
- **Root Cause**: The capacity guard is keyed on `profile.mode === 'pty'`
  (`router.js:59`) because it was written around PTY session count, but the
  headless path also spawns a real OS process per turn. No counterpart limit was
  added for it.
- **Exploitability**: Trivial for any bridge-token holder — a loop of POSTs with
  a random pin id each. No race, no timing, single request per child. Reaping
  (`router.js:150-155`) only fires every 30 s and only for `busy === 0` convs, so
  in-flight children are never reclaimed early.

#### [VULN-002] Client-chosen conversation pin shares the key space with server-generated conversation ids (CWE-694 / cache-key collision)
- **Input**: #11 `x-bridge-conversation`, #12 `model` `#<pin>` suffix (G5)
- **Class**: CWE-694: Use of Multiple Resources with Duplicate Identifier (cache/state key collision; see LOG class file "Cache key collision resistance")
- **Severity**: Medium
- **Location**: `src/facade/router.js:57-78` (`_create`, `id = pinId`, `this._convs.set(conv.id, conv)` at `:76`), reached from `router.js:114-118`
- **Gate 0 (intended behavior?)**: Pinning a conversation by a client-chosen name
  is an intended feature. What is *not* intended is that the client-chosen name
  is written into `_convs`, the same map that holds server-generated
  `crypto.randomUUID()` conversation ids (`router.js:61`), with no namespace
  prefix and no collision check. `Map.set` silently replaces.
- **Gate 1 (reachable?)**: `_create` with `id` is called at `router.js:115` from
  `acquire`, which is called from `executeTurn` (`router.js:230`) — reached by all
  three façade dialects (`openaiChat.js:63`, `openaiResponses.js:76`,
  `anthropicMessages.js:57`). Production.
- **Gate 2a (attacker-controlled?)**: Fully. `parsePin` (`openaiChat.js:12-17`)
  performs no character-set, length, or format validation on either the header
  value or the `#` suffix; the string is used verbatim as `pinId`
  (`openaiChat.js:39`, `openaiResponses.js:39`, `anthropicMessages.js:37`).
- **Gate 2b (sanitization?)**: None. The only check on the pin path is *profile
  agreement* (`router.js:110-113`) — never id-shape, never ownership. Note the
  ownership gap is separately **CROSS-CLASS (NAV, CWE-639)**: `_pins.get(pinId)`
  hands back a live, already-authenticated CLI session to whoever names it.
- **Gate 3 (new capability?)**: Two outcomes the baseline does not give:
  (a) *Orphaned, immortal PTY sessions.* If `pinId` equals an existing
  conversation's UUID, `this._convs.set(conv.id, conv)` (`router.js:76`)
  evicts the original from `_convs`. `reap()` (`router.js:151`) and `close()`
  (`router.js:263`) both iterate `this._convs.values()`, so the evicted
  conversation's `record` is never destroyed and `manager.remove` is never
  called — the `node-pty` child (`session.js:16`) lives until process exit, and
  it no longer counts toward `_ensureCapacity`'s `pty.length` tally
  (`router.js:50-51`), so the 8-session cap can be walked past indefinitely.
  (b) *Cross-conversation aliasing.* The pin namespace grants access to the
  conversation object itself, i.e. a live CLI in the operator's shell — the
  threat model explicitly lists "hijacking or colliding with another
  conversation's live session" as outside the Gate 3 baseline.
- **Entry Point**: all three façade POST routes
- **Data Flow**: `req.headers['x-bridge-conversation']` (`openaiChat.js:16`) or
  `model.slice(hash+1)` (`openaiChat.js:15`) → `headerPin || suffixPin`
  (`openaiChat.js:39`) → `executeTurn({pinId})` (`router.js:220`) →
  `acquire` (`router.js:108-118`) → `_create({id: pinId})` (`router.js:57`) →
  `conv.id = pinId` (`router.js:61`) → `this._convs.set(conv.id, conv)`
  (`router.js:76`) and `this._pins.set(pinId, conv)` (`router.js:117`)
- **Root Cause**: Conversation identity is derived in four independent places
  with four different rules (`_fp` at `:32-36`, raw `pinId` at `:113-118`,
  `previous_response_id` at `:226-229`, and two different header/suffix
  precedence orders in `openaiChat.js:12-18` vs `openaiResponses.js:38-40`), and
  three of those identities are deposited into one `_convs` map without a
  per-source namespace.
- **Exploitability**: Outcome (b) needs only a guessed/known pin string and is
  immediate. Outcome (a) additionally needs a server-generated conv UUID; that
  value is disclosed to the client in the dialog error body
  (`router.js:160-162`, `conversation_id: conv.id`), so it is obtainable, not
  merely brute-forceable. Rated Medium rather than High for that dependency.

#### [VULN-003] Unbounded attacker-keyed `Set` growth and unsanitized log write in `noteIgnoredParams` (CWE-400 / CWE-117)
- **Input**: #24 — arbitrary top-level JSON body keys
- **Class**: CWE-400 (unbounded memory), CWE-117 (log injection)
- **Severity**: Medium
- **Location**: `src/facade/shared.js:124-133`
- **Gate 0 (intended behavior?)**: Logging an ignored parameter once per name is
  intentional (spec, "non-goal params are accepted, ignored, and logged once").
  Doing so with an **unbounded, never-evicted, process-lifetime** `Set` keyed on
  an attacker-supplied string is not — the de-dup cache is the bug, not the log.
- **Gate 1 (reachable?)**: Called on every façade POST:
  `openaiChat.js:55`, `openaiResponses.js:68`, `anthropicMessages.js:50`.
- **Gate 2a (attacker-controlled?)**: `body` is the parsed request JSON
  (`shared.js:74`); `Object.keys(body)` (`shared.js:126`) enumerates keys the
  client chose. Anything not in the ~4-6 entry `KNOWN` array reaches the sink.
- **Gate 2b (sanitization?)**: None. `k` is interpolated straight into the
  template at `shared.js:131` (no newline/CR stripping, no length clamp) and
  into `tag` at `shared.js:128` before `ignoredLogged.add(tag)` at `:130`.
  There is no size bound, TTL, or LRU on `ignoredLogged` — grep shows it is
  declared `const ignoredLogged = new Set()` at module scope (`shared.js:124`)
  and is only ever added to.
- **Gate 3 (new capability?)**: Yes. One 8 MiB request body
  (`MAX_BODY`, `shared.js:60`) of distinct short keys retains on the order of
  10^5-10^6 permanent `Set` entries plus one `console.warn` line each; repeated
  requests grow the heap without bound until the bridge OOMs — an availability
  outcome no documented bridge capability provides. Independently, embedding
  `\n` in a key forges arbitrary lines in the operator's stdout log
  (`server.js` prints the token to that same stream), which is the audit-trail
  manipulation the LOG class calls out.
- **Entry Point**: all three façade POST routes
- **Data Flow**: request body → `readJsonBody` `JSON.parse` (`shared.js:74`) →
  `body` (`openaiChat.js:50`) → `noteIgnoredParams(body, KNOWN, 'chat.completions')`
  (`openaiChat.js:55`) → `Object.keys(body)` (`shared.js:126`) →
  `` tag = `${dialect}.${k}` `` (`shared.js:128`) → `ignoredLogged.add(tag)`
  (`shared.js:130`) and `console.warn(...)` (`shared.js:131`)
- **Root Cause**: A "log once per name" de-dup set was implemented with an
  unbounded cache keyed on untrusted input, and the same untrusted input is
  written to the log verbatim.
- **Exploitability**: A single POST with a large key-only JSON object. No
  preconditions beyond the bridge token.

#### [VULN-004] Unbounded stdout/stderr accumulation from headless child processes (CWE-400)
- **Input**: #42 / #43 (child stdout), #44 (child stderr) — content steerable by the attacker's prompt (#7/#15/#21)
- **Class**: CWE-400: Uncontrolled Resource Consumption
- **Severity**: Medium
- **Location**: `src/facade/headlessClaudeRunner.js:34,49,52-53`;
  `src/facade/headlessCopilotRunner.js:123,138,141-142`
- **Gate 0 (intended behavior?)**: Buffering the child's JSONL is intended;
  buffering it without any ceiling is not.
- **Gate 1 (reachable?)**: Both handlers are attached unconditionally on every
  headless turn (`router.js:178-181` → `HEADLESS_RUNNERS`). Production.
- **Gate 2a (attacker-controlled?)**: Indirectly but genuinely. The prompt text
  reaching the child (`headlessClaudeRunner.js:85` stdin,
  `headlessCopilotRunner.js:96` `-p` argv) is verbatim client input; asking the
  CLI to emit a very large answer, or a very long single line, controls the size
  of what lands in `buf`/`stderr`. Per the partition's own note, the child is an
  untrusted return path.
- **Gate 2b (sanitization?)**: None. `stderr += d` (`headlessClaudeRunner.js:49`,
  `headlessCopilotRunner.js:138`) has no cap — only the *read* is truncated to
  `slice(-2000)`. `buf += d` (`headlessClaudeRunner.js:52`,
  `headlessCopilotRunner.js:141`) is only drained at a `\n`
  (`headlessClaudeRunner.js:54`), so a newline-free stream accumulates without
  limit. Contrast `session.js:19-20`, which *does* bound its ring buffer to
  `ringBytes` — the bound exists elsewhere in the codebase and is simply absent
  here.
- **Gate 3 (new capability?)**: Heap growth proportional to child output with no
  ceiling, per concurrent turn. Combined with VULN-001 (N concurrent headless
  children) this multiplies into a practical OOM of the bridge process. Nothing
  in the documented baseline lets a token holder allocate unbounded server heap.
- **Entry Point**: façade POST routes with a headless `model`
- **Data Flow**: prompt (#7/#15/#21) → `fullPrompt` (`headlessCopilotRunner.js:95`)
  / stdin write (`headlessClaudeRunner.js:85`) → child → `child.stdout`/`child.stderr`
  `'data'` handlers → `buf`/`stderr` string concatenation, unbounded
- **Root Cause**: No maximum-bytes guard on either accumulator, and no
  line-length guard before the `indexOf('\n')` drain loop.
- **Exploitability**: Requires the child to actually emit large output, so it is
  a step less direct than VULN-003 — hence Medium.

#### [VULN-005] Unbounded request-body collections and unbounded response-id registration (CWE-400)
- **Input**: #7 `messages[]`, #15/#16 `input[]`, #21 `messages[]`; #17-adjacent `_byResp`/`respIds` growth
- **Class**: CWE-400: Uncontrolled Resource Consumption
- **Severity**: Low
- **Location**: `src/facade/dialects/openaiChat.js:24,30`;
  `src/facade/dialects/openaiResponses.js:24-29`;
  `src/facade/dialects/anthropicMessages.js:19,27`;
  `src/facade/router.js:141-146`
- **Gate 0 (intended behavior?)**: Accepting a conversation history is the
  feature; accepting an unbounded number of elements is not a stated feature.
- **Gate 1 (reachable?)**: Every façade POST.
- **Gate 2a (attacker-controlled?)**: Yes — the arrays are raw body fields.
- **Gate 2b (sanitization?)**: The mandatory collection-size check fails: there
  is no `maxItems`/length validation on `body.messages` or `body.input`
  anywhere. The only bound is the 8 MiB `MAX_BODY` byte cap (`shared.js:60`),
  which is a byte bound, not an element bound; each element is walked at least
  four times (dialect `map`, `_fp` `map`+`JSON.stringify`+sha256 at
  `router.js:32-35`, `historyKey` a second full digest at `router.js:103`, and
  `_buildSeed` `map`+`join` at `router.js:38-47`). Separately,
  `registerResponse` (`router.js:141-146`) adds an entry to `_byResp` and to
  `conv.respIds` on **every** `/v1/responses` call — including the streaming
  path (`openaiResponses.js:96`) — with no cap; entries are released only when
  the conversation is destroyed (`router.js:85`), and a pinned conversation's
  TTL is 1 h (`config.js:224`).
- **Gate 3 (new capability?)**: CPU amplification (three-plus passes plus two
  SHA-256 digests over the entire history, per request) and steady heap growth
  in `_byResp`. Real but bounded per request by the byte cap — hence Low.
- **Entry Point**: all three façade POST routes; `/v1/responses` for the id map
- **Data Flow**: `body.messages`/`body.input` → dialect `normalize` →
  `executeTurn` → `acquire` → `_fp` ×2 (`router.js:102-103`) → `_buildSeed`
  (`router.js:124`); `registerResponse` (`openaiResponses.js:86,96`) →
  `_byResp.set` (`router.js:143`)
- **Root Cause**: Byte-level body capping was implemented in place of
  element-level collection capping; response-id registration has no eviction.
- **Exploitability**: Straightforward but low-yield on its own; meaningful as an
  amplifier for VULN-001.

#### [VULN-006] `_attachPending` runs off the per-conversation serialization queue (CWE-362)
- **Input**: #11/#12 (pin) + #7/#21 (message set) — the attach predicate is `fpKey` + `userText`
- **Class**: CWE-362: Race Condition (check-then-act / concurrent access to shared state)
- **Severity**: Low
- **Location**: `src/facade/router.js:191-218`, dispatched at `router.js:232-235`
- **Gate 0 (intended behavior?)**: Attaching a retry to a dialog-blocked turn is
  intended (spec, Error handling). Doing so *outside* `conv.queue`, the very
  mechanism that guarantees one turn at a time per CLI, is not.
- **Gate 1 (reachable?)**: `_attachPending` is called from `executeTurn`
  (`router.js:233`) whenever `conv.pending` matches; `conv.pending` is set at
  `router.js:243` on any PTY dialog outcome (`turnRunner.js:50-52,73,115`).
  Production, PTY profiles only (headless runners never return `dialog`, so
  `conv.record` is never null on this path).
- **Gate 2a (attacker-controlled?)**: The client chooses both the pin that
  selects the conversation and the exact `messages`/`userText` that satisfy the
  `conv.pending.fpKey === fpKey && conv.pending.userText === userText` predicate
  at `router.js:232`.
- **Gate 2b (sanitization?)**: None applicable — this is a serialization defect,
  not a data-validation one. Every other turn goes through
  `conv.queue.enqueue` (`router.js:238`); this branch returns at `router.js:234`
  before reaching it, and instead fires a bare async IIFE (`router.js:194`).
- **Gate 3 (new capability?)**: A concurrent request on the same conversation
  runs `runPtyTurn` (typing into the shared PTY, `turnRunner.js:88`) while the
  attached reader is inside `det.waitForSettle` (`router.js:199`). The reader
  then renders `renderLinesSince(sinceIndex)` (`router.js:205`) over a viewport
  that now contains the *other* turn's output, returns it as this request's
  answer (`router.js:208`), and calls `completeTurn` (`router.js:207`) — which
  performs a read-modify-write on `_byFp` (`router.js:133-135`) that can be lost
  or can overwrite the concurrent turn's own `completeTurn`. Outcome: one
  conversation's response text is served to a different request, and the
  fingerprint index is left pointing at a conversation whose real state does not
  match it.
- **Entry Point**: façade POST routes against a PTY profile whose CLI raised a
  dialog
- **Data Flow**: dialog outcome (`turnRunner.js:73`/`:115`) →
  `conv.pending = {fpKey, userText, sinceIndex}` (`router.js:243`) → next
  matching request (`router.js:232`) → `_attachPending` off-queue
  (`router.js:191-218`) ∥ any other request → `conv.queue.enqueue` →
  `runPtyTurn` writes to the same `record.session`
- **Root Cause**: The pending-attach fast path was added as an early return
  before the enqueue, so it does not inherit the queue's mutual exclusion.
- **Exploitability**: Requires the CLI to be sitting on a dialog and two
  overlapping requests — a genuine but narrow window; Low per the "race/chain
  required" adjustment.

#### [VULN-007] Child-process stderr echoed to the API client (CWE-209)
- **Input**: #44
- **Class**: CWE-209: Information Exposure Through an Error Message
- **Severity**: Low
- **Location**: `src/facade/headlessClaudeRunner.js:45,74,75`;
  `src/facade/headlessCopilotRunner.js:134,191,192`
- **Gate 0 (intended behavior?)**: The `bridge` diagnostic field is deliberate
  (spec: "the bridge field should describe the failure"). What is not deliberate
  is that the diagnostic is the raw last 2000 bytes of a child that runs with the
  operator's ambient credentials.
- **Gate 1 (reachable?)**: `FacadeError.bridge` is spread into the wire body by
  `errorBody` (`shared.js:39,41,44`) and sent by `sendError` (`shared.js:55`),
  which every dialect calls (`openaiChat.js:53,68,80`, etc.).
- **Gate 2a (attacker-controlled?)**: The *trigger* is (a timeout or non-zero
  exit is prompt-inducible); the *content* is the child's, i.e. tool output,
  file paths, home directory, and any credential the CLI prints on failure.
- **Gate 2b (sanitization?)**: None — `stderr.slice(-2000)` is a length trim, not
  a redaction. No key/token/secret filtering anywhere on this path.
- **Gate 3 (new capability?)**: For a **headless** profile the client has no
  other read channel into the child process — unlike PTY profiles, where the
  documented baseline already grants reading rendered terminal output. So this
  is a genuinely new read primitive on the headless path, though limited to
  stderr and to the same single-token principal.
- **Entry Point**: façade POST routes with a headless `model`
- **Data Flow**: child stderr → `stderr += d` (`headlessClaudeRunner.js:49`) →
  `new FacadeError(..., { stderr: stderr.slice(-2000) })`
  (`headlessClaudeRunner.js:45,74,75`) → `errorBody` (`shared.js:44`) →
  `jsonRes` (`shared.js:55`) → HTTP response
- **Root Cause**: Raw child diagnostics are forwarded to a remote client without
  redaction.
- **Exploitability**: Needs the child to fail or time out and to have printed
  something sensitive; the failure itself is easy to induce.

---

## Cross-class referrals

- **CROSS-CLASS (#7, #15, #21 → INJ)** — prompt text reaches
  `promptWriter.js:9-18` → `session.write` → `pty.spawn` (`session.js:16`), and
  `headlessCopilotRunner.js:96` as a raw `-p` argv value. Prompt-injection /
  command-surface analysis belongs to INJ.
- **CROSS-CLASS (#42 → INJ)** — `j.session_id` read from the claude child's
  stdout (`headlessClaudeRunner.js:60,66`) is stored on `conv.resumeSessionId`
  (`router.js:182`) and re-emitted on the next turn as a *separate* argv token
  `args.push('--resume', resumeSessionId)` (`headlessClaudeRunner.js:17`). An
  LLM-influenced value entering argv as its own token is argument injection
  (CWE-88). The copilot mirror uses `--resume=${id}` (`headlessCopilotRunner.js:97`)
  and is not split.
- **CROSS-CLASS (#11, #12, #17 → NAV, CWE-639)** — `_pins.get(pinId)`
  (`router.js:109`) and `_byResp.get(previousResponseId)` (`router.js:227`) hand
  back a live authenticated CLI conversation on a caller-supplied identifier
  with **no ownership check** — only a profile-agreement check
  (`router.js:110-113`). Confirms the partition's `NONE` per-resource
  authorization rating.
- **CROSS-CLASS (all body DTOs → NAV, CWE-915)** — none of the three
  `normalize()` functions applies field-level authorization filtering to the
  request body; unknown fields are merely logged (`shared.js:125-133`).

## Notable SAFE / near-miss findings (recorded, not reported)

- **Prototype-pollution near-miss.** `profileName` is an unvalidated
  attacker string used as a property key on a normal-prototype object:
  `this._config.profiles[profileName]` (`router.js:221`, `router.js:58`) and
  `c.profiles[name]` (`sessionManager.js:44`). `profiles` is built as
  `const profiles = {}` (`config.js:107`), so `__proto__`, `constructor`, and
  `toString` all resolve to truthy inherited values. The finding is neutralized
  only by the follow-on `|| !profile.command` guard (`router.js:222`) and
  `if (p.mode !== 'pty')` / `if (!p.command)` (`sessionManager.js:51,57`), which
  reject every inherited value. **SAFE today, one refactor away from a bug** —
  `Object.create(null)` or `Object.hasOwn` would make it robust. No recursive
  merge/`$.extend`/`lodash.merge` exists anywhere in scope (grep for
  `Object.assign|merge|__proto__` returns only `session.js:15`,
  `headlessClaudeRunner.js:21`, `headlessCopilotRunner.js:108` — all merging
  operator-controlled `profile.envSet`, never request data), so CWE-1321 does
  not apply.
- **Crypto.** `crypto.randomUUID()` for conversation and response ids
  (`router.js:61,142`), `crypto.randomBytes(24)` for the generated token
  (`config.js:91`), SHA-256 for the routing fingerprint (`router.js:33`), and
  `crypto.timingSafeEqual` for the token compare (`auth.js:8`). No MD5/SHA-1,
  no `Math.random`, no `rejectUnauthorized:false` / `NODE_TLS_REJECT_UNAUTHORIZED`
  / `verify=False` anywhere in scope. No hardcoded key. SAFE.
- **Integer overflow.** The only arithmetic on user-controlled magnitudes is
  `estTokens = (chars) => Math.max(1, Math.ceil(chars / 4))` (`shared.js:135`),
  used for reporting only; `usageOpenaiChat`'s `u.input + u.output`
  (`shared.js:156`) is IEEE-754 double arithmetic on values bounded by the 8 MiB
  body cap. No allocation size, array index, or loop bound derives from user
  arithmetic. SAFE.
- **Token in query string.** `extractToken` accepts `?token=` (`auth.js:15`),
  so the credential leaks to access logs / `Referer` / browser history. This is
  shared infrastructure (`src/auth.js`), already recorded in the partition
  threat model, and belongs to the module that owns it rather than to SG-1.
- **G4 copilot tool lockdown.** `EXPOSURE_VALUE_FLAGS` / `EXPOSURE_BOOL_FLAGS`
  (`headlessCopilotRunner.js:65-66`) use exact, case-sensitive `Set.has`
  matching and omit `--mcp-config`. Both gaps are real, but the only writer of
  `profile.args` is `PROFILE_<NAME>_ARGS` (`config.js:137`) — operator config,
  trusted in this threat model. The untrusted prompt reaches copilot solely as
  the `-p` argv value (`headlessCopilotRunner.js:96`) and cannot alter argv,
  env, or `FIXED_ARGS`. Recorded as **DESIGN-INTENT (operator-config-gated)**,
  matching the file's own SECURITY note; worth a hardening ticket, not a
  vulnerability.
- **Fingerprint key-space overlap (`router.js:98-104`).** Investigated the
  claimed "two key spaces share one map" collision. Keys stored at creation
  (`router.js:123`) always end in a `user` message; keys stored by
  `completeTurn` (`router.js:132`) always end in an `assistant` message. Both
  dialects reject a trailing non-`user` message (`openaiChat.js:34`,
  `openaiResponses.js:33`, `anthropicMessages.js:33`), so a client cannot
  construct a lookup key in the `assistant`-terminated space. The two spaces are
  therefore disjoint in practice and **SAFE**. Conversation takeover by
  replaying a known history is possible but requires knowing the exact prior
  text, and is the NAV ownership gap already referred above.
- **`AsyncQueue`** (`shared.js:83-106`) — `push`/`end`/`fail` after settle are
  no-ops and the iterator drains buffered values before throwing; no lost-event
  or double-settle race. **SAFE.**
- **`checkToken` length short-circuit** (`auth.js:7`) — leaks token length only;
  the generated token is 24 random bytes. **SAFE.**
