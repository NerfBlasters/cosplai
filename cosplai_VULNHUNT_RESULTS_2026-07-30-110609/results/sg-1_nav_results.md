# SG-1 — NAV trace results (Cloud-API façade)

Class group: CSRF, IDOR, auth bypass, conditional validation bypass, identity
spoofing, confused deputy, security signal spoofing, mass assignment,
parameter pollution.

Repo root: `/home/kali/repos/cosplai`. All paths below are repo-relative.

---

## Disposition table (all assigned inputs)

| # | Input | Disposition |
|---|---|---|
| 5 | `model` (chat) | **CANDIDATE** → VULN-005 (profile/scope selection bypasses copilot tool lockdown); also VULN-001 |
| 6 | `messages[].role` (chat) | SAFE (Gate 3) — arbitrary role string is concatenated into the seed preamble (`router.js:44`), but the caller already controls the entire prompt body via `content`; no new capability. Feeds conversation identity → see VULN-003 |
| 7 | `messages[].content` (chat) | **CROSS-CLASS** (#7, `turnRunner.js:88` → `promptWriter.js:9-18` → `session.write`; `headlessCopilotRunner.js:96` argv; `headlessClaudeRunner.js:85` stdin — suspected class: INJ). NAV-relevant only via VULN-001/VULN-003 |
| 8 | `n` | SAFE — validated `n==1` or 400 (`openaiChat.js:27-29`); no sink |
| 9 | `stream` (chat) | SAFE — strict `=== true` boolean, selects response framing only |
| 10 | `stream_options.include_usage` | SAFE — coerced to boolean, gates a usage SSE frame only |
| 11 | `x-bridge-conversation` (pin id) | **CANDIDATE** → VULN-002 (CWE-639) |
| 12 | `model` `#<pin>` suffix | **CANDIDATE** → VULN-002 (CWE-639) — same sink, same fix; recorded as one finding |
| 13 | `model` (responses) | **CANDIDATE** → VULN-005; also VULN-001 |
| 14 | `instructions` | SAFE (Gate 3) — becomes a `system` turn in the normalized sequence; caller already controls all prompt text. Feeds identity → VULN-003 |
| 15 | `input` (prompt) | **CROSS-CLASS** (#15, same sinks as #7 — suspected class: INJ). NAV via VULN-001/003 |
| 16 | `input[].role` / `.type` / `.content` | SAFE (Gate 3) — `.type` is whitelisted to `message`/null (`openaiResponses.js:26`); role/content as #6/#7 |
| 17 | `previous_response_id` | **CANDIDATE** → VULN-004 (CWE-863: profile-agreement check skipped on this path) + residual IDOR: no ownership check at `router.js:227`, bounded only by `resp_<uuid>` unguessability |
| 18 | `stream` (responses) | SAFE — strict `=== true` |
| 19 | `model` (messages) | **CANDIDATE** → VULN-005; also VULN-001 |
| 20 | `system` (anthropic) | SAFE (Gate 3) — as #14 |
| 21 | `messages[].role` / `.content` | SAFE for `role` (whitelisted `user`/`assistant`, `anthropicMessages.js:28`); `.content` **CROSS-CLASS** (INJ) as #7 |
| 22 | `stream` (messages) | SAFE — strict `=== true` |
| 23 | `x-api-key` | SAFE as an auth-bypass vector — `checkToken` (`auth.js:3-9`) is length-checked + `timingSafeEqual`; a null/absent credential fails closed (`index.js:45`). BUT the sibling accessor `extractToken` also accepts the credential in the **query string** (`auth.js:14-16`), which is the enabling precondition for VULN-001 |
| 24 | arbitrary body keys → `console.warn` | **CROSS-CLASS** (#24, `src/facade/shared.js:131`, suspected class: LOG — CWE-117 log injection via attacker-controlled JSON key, plus unbounded growth of the module-global `ignoredLogged` Set at `shared.js:124,129`). No NAV sink: unknown keys are logged and discarded, never copied into a model or downstream payload |
| 25 | `GET /v1/models` (no input) | SAFE — authenticated at `index.js:45`; returns operator-enabled profile names only (`models.js:11-13`); no principal-scoped data |
| 42 | claude JSONL `session_id` / `result` / `usage` | **CANDIDATE** → VULN-006 (`j.session_id` → `--resume` argv). `j.result`/`j.usage` are response payload only → SAFE |
| 43 | copilot JSONL `sessionId` / `content` / `phase` / `outputTokens` | **CANDIDATE** → VULN-006 (`j.sessionId` → `--resume=` argv). `content`/`phase`/`outputTokens` → SAFE (response framing / usage numbers only) |
| 44 | child `stderr.slice(-2000)` → API client | **CROSS-CLASS** (#44, `headlessClaudeRunner.js:74-75`, `headlessCopilotRunner.js:191-192`, suspected class: LOG — information disclosure of child-process diagnostics, host paths, env-derived errors) |

### Gate-logic entries

- **G4** (copilot tool lockdown, `headlessCopilotRunner.js:70-89`) — **SAFE at Gate 2a.**
  `scrubToolExposureArgs` operates on `profile.args`, which is sourced only from
  `PROFILE_<NAME>_ARGS` / `CLAUDE_ARGS` (`config.js:120,137`). No façade input
  reaches argv other than the `-p <prompt>` value. The residual weaknesses the
  file itself documents (exact/case-sensitive `Set` matching, `--mcp-config`
  absent from the scrub set) are **operator-config-gated**, not prompt-driven.
  **However** the lockdown's stated guarantee is defeated by an
  attacker-selectable sibling path — see **VULN-005**.
- **G5** (conversation identity, `router.js:32-36,89-126`) — **CANDIDATE** →
  VULN-003 (shared `_byFp` key space) and VULN-002 (raw pin id as map key).
- `openaiChat.js:13` model→profile classification — **CANDIDATE** → VULN-005.
  Prototype-key abuse checked and rejected: `profileName = "__proto__"` /
  `"constructor"` / `"toString"` resolves to a non-profile object whose
  `.command` is undefined, so `executeTurn` (`router.js:222`) throws 404 before
  `_create`. SAFE.
- `facade/index.js:38` route-ordering — **SAFE.** `canHandle` matching before the
  bridge token gate is not a bypass: `facade.handle` performs its own
  `checkToken` at `index.js:45` for every family. Verified non-matching variants
  (`//v1/chat/completions`, trailing slash, `%2f`/`%20`-suffixed paths) do not
  satisfy the exact `routes.has()` match and therefore fall through to the
  bridge gate at `httpApi.js:129` → 401. A disabled dialect's route is simply
  absent → 401/404 behind the bridge gate.

### Absent-input analysis (mandatory)

- Omit `Authorization` **and** `x-api-key`: `extractToken` returns `null`,
  `checkToken(null, ...)` returns `false` at `auth.js:4` → 401. **Fails closed.**
- Omit `x-bridge-conversation`: falls back to model suffix, then fingerprint
  routing. Not a security check being skipped — but see VULN-003 for the
  fingerprint fallback's cross-conversation behaviour.
- Omit `previous_response_id` while supplying a header pin: `openaiResponses.js:40`
  nulls `previousResponseId`, which skips the "response id not found or expired"
  check at `router.js:228`. Not security-critical on its own; the *security*
  consequence of the twin-path asymmetry is VULN-004.
- Supplying both `pinId` and `previousResponseId` skips the response-id
  existence check (`router.js:226`). Unreachable through the dialects
  (`openaiResponses.js:39-40` makes them mutually exclusive). SAFE.

### Mandatory post-trace audit: authorization helper coverage

All four routes (`GET /v1/models`, `POST /v1/chat/completions`,
`POST /v1/responses`, `POST /v1/messages`) are dispatched through the single
`handle()` in `src/facade/index.js:39-55`, which invokes `checkToken` at line 45
before any handler runs. **No sibling handler skips the auth call.** No gap to
report under CWE-306/862 for helper omission. (The authorization *content* —
`checkToken` proves possession of one shared secret and produces no principal —
is the premise of VULN-002/003, not a separate omission finding.)

### Request Body Gate (CWE-915) — completed, no mass-assignment finding

(a) Three endpoints deserialize distinct body shapes; `parsePin` is the only
shared consumer (`openaiChat.js:12`, imported by `openaiResponses.js:9` and
`anthropicMessages.js:11`). (b)/(c) Every consumed field is explicitly named and
individually validated in each dialect's `normalize()`; the `KNOWN` lists
(`openaiChat.js:10`, `openaiResponses.js:11`, `anthropicMessages.js:13`) are used
only for logging. (d) **There is no catch-all mapper**: `executeTurn` is called
with an explicit five/six-argument object (`openaiChat.js:62-65`,
`openaiResponses.js:75-78`, `anthropicMessages.js:56-59`) — no spread of `body`,
no `Object.assign` from `body`, no persistence model. Unknown keys reach only
`console.warn`. (e) No sensitive field is overridden in one endpoint and not
another. **No CWE-915 candidate.** Parameter-pollution/role-confusion check: the
only role-ish field is `messages[].role`, dispositioned at #6/#16/#21.

---

## Candidates

### [VULN-001] No CSRF defence on any state-changing façade route; credential accepted in the query string makes cross-origin form POST sufficient
- **Input**: #5-#22 (all façade POST bodies), enabled by #23 / `auth.js:14-16`
- **Class**: CWE-352 (Cross-Site Request Forgery), enabled by CWE-598 (credential in query string)
- **Severity**: High
- **Location**: `src/facade/index.js:39-55`; `src/auth.js:14-16`; `src/facade/shared.js:62-78`
- **Gate 0 (intended behavior?)**: No. Gate 0 does not apply — this is the
  *absence* of a security check, not a feature. The partition's Gate-3 baseline
  explicitly excludes "reaching any of this from a cross-origin web page without
  operator intent."
- **Gate 1 (reachable?)**: `createFacade` is mounted unconditionally at
  `src/server.js:25` and dispatched at `httpApi.js:127`. All three POST dialects
  default to **enabled** (`config.js:220-222`, `flag(..., true)`). Production.
- **Gate 2a (attacker-controlled?)**: The request is issued by the victim's
  browser; the attacker controls method, target, and body. The bearer credential
  is supplied by the attacker in the URL query, so no ambient-cookie
  prerequisite is even needed — only knowledge of `config.token`, which is
  printed to stdout at boot (`server.js:29`), embedded in the operator's
  bookmarked/history URL (`?token=`), and forwarded in `Referer`.
- **Gate 2b (sanitization?)**: **None.** `grep -rn "origin|Origin|sec-fetch|csrf|content-type']" src/` returns **zero** matches. There is no
  `Origin`/`Sec-Fetch-Site` check, no CSRF token, no CORS policy, and — critically —
  `readJsonBody` (`shared.js:62-78`) **never inspects `Content-Type`**; it
  `JSON.parse`s whatever bytes arrive. A `<form enctype="text/plain">` therefore
  produces a CORS-*simple* request (no preflight) whose body parses as JSON via
  the standard `name=value` split trick. The `x-api-key`/`Authorization` header
  paths would be preflighted, but the query-string path is not.
- **Gate 3 (new capability?)**: The attacker obtains **prompt execution inside a
  live, agentic AI coding CLI running with the operator's shell and credentials**
  (`turnRunner.js:88` → `promptWriter.js:9-18` → `session.write` → `pty.spawn`;
  or `headlessCopilotRunner.js:96`), from an arbitrary web page the operator
  visits, with no operator interaction beyond page load. Explicitly outside the
  documented baseline.
- **Entry Point**: `POST /v1/chat/completions?token=…`, `POST /v1/responses?token=…`, `POST /v1/messages?token=…`
- **Data Flow**: attacker page `<form enctype="text/plain" action="http://127.0.0.1:7681/v1/chat/completions?token=T" method="POST">` → `httpApi.js:127` `facade.canHandle` → `facade/index.js:41` `extractToken` → `auth.js:15` query-string token accepted → `index.js:45` `checkToken` passes → `openaiChat.js:50` `readJsonBody` (no Content-Type check, `shared.js:74`) → `normalize` → `router.executeTurn` (`openaiChat.js:62`) → `turnRunner.runPtyTurn` → `session.write`.
- **Root Cause**: State-changing endpoints perform no request-origin
  verification, and the authentication accessor accepts the secret from a
  location a cross-origin form can populate.
- **Exploitability**: Practical. Requires the attacker to learn/guess the token;
  the token's placement in URLs, shell history, and boot stdout makes that a
  realistic disclosure, and the bind default `127.0.0.1` is reachable from the
  victim's own browser. Response body is not readable cross-origin, but the
  side effect (a prompt executed in the operator's CLI) is the payload.

### [VULN-002] Conversation pins are attacker-chosen map keys with no ownership binding — cross-conversation session hijack
- **Input**: #11 `x-bridge-conversation` header; #12 `model` `#<pin>` suffix
- **Class**: CWE-639 (Authorization Bypass Through User-Controlled Key); CWE-306
- **Severity**: High
- **Location**: `src/facade/router.js:108-118` (`this._pins.get(pinId)` / `this._pins.set(pinId, conv)`); parsed at `src/facade/dialects/openaiChat.js:12-18`
- **Gate 0**: NAV-exempt. Even under "pins are a feature," pin *lookup without an
  ownership check* is a missing authorization decision, not the feature.
- **Gate 1 (reachable?)**: `parsePin` is imported by all three dialects
  (`openaiChat.js:37`, `openaiResponses.js:36`, `anthropicMessages.js:36`), each
  passing `pinId` into `router.executeTurn`. All production, all default-enabled.
- **Gate 2a (attacker-controlled?)**: Fully. `pinId` is the raw header string or
  the raw substring after `#` in `model`, with no charset, length, or format
  constraint (`openaiChat.js:14-17`).
- **Gate 2b (sanitization?)**: None. The **only** check is profile agreement
  (`router.js:110-113`) — it compares the pin's bound `profileName`, never the
  caller. `checkToken` (`auth.js:3-9`) produces no principal, claim, or subject,
  so there is nothing to bind a pin to.
- **Gate 3 (new capability?)**: On a pin hit, `created` is false and
  `needsSeed` is false, so `seedText` is `''` (`router.js:124`) — the caller's
  own `messages` history is **discarded** and their `userText` is typed straight
  into the *existing* conversation's live CLI session
  (`router.js:238-241` → `turnRunner.js:88`). The attacker therefore (a) injects
  a prompt into another conversation's live authenticated session and (b) reads
  its accumulated context back in the response. The partition's Gate-3 baseline
  explicitly lists "hijacking or colliding with another conversation's live
  session" as **not** in the baseline.
- **Entry Point**: all three façade POST routes
- **Data Flow**: `x-bridge-conversation: chat-1` → `openaiChat.js:16-17` `headerPin` → `openaiChat.js:39` `pinId` → `router.js:230` `acquire` → `router.js:109` `this._pins.get('chat-1')` → existing `conv` → `router.js:241` `_runTurn` → `turnRunner.js:88` `writeAndSubmitPrompt(conv.record.session, …)`.
- **Root Cause**: The conversation namespace is a global map keyed by an
  unauthenticated caller-supplied string; first claimant owns the key and any
  later caller who supplies the same string is treated as the same conversation.
- **Exploitability**: High. Pin ids in real client integrations are short,
  human-chosen, and enumerable (`chat-1`, `default`, a UUID copied from a URL).
  A single request with a guessed pin both hijacks and exfiltrates.

### [VULN-003] `_byFp` mixes two fingerprint key spaces — a request whose *history* equals another conversation's *full message list* attaches to that conversation's live session
- **Input**: #6/#7 (chat `messages`), #14/#15/#16 (responses `instructions`/`input`), #20/#21 (anthropic `system`/`messages`) — i.e. G5
- **Class**: CWE-639 / CWE-290 (identity confusion in conversation routing)
- **Severity**: Medium
- **Location**: `src/facade/router.js:102-104, 120-123`
- **Gate 0**: Not applicable — the collision is not the documented retry
  semantics. The comment at `router.js:92-101` justifies the *primary-key* hit
  (`_byFp.get(fpKey)`) as retry attachment; it does **not** justify the
  *secondary* lookup (`_byFp.get(historyKey)`) reaching into the primary space.
- **Gate 1 (reachable?)**: `acquire` is the sole conversation-resolution path for
  every non-pinned, non-`previous_response_id` façade request — the default path
  for all three dialects.
- **Gate 2a (attacker-controlled?)**: Fully — `_fp` hashes `[profileName,
  messages.map(m => [m.role, m.text])]` (`router.js:32-35`), every component of
  which is request body content.
- **Gate 2b (sanitization?)**: None. Both key spaces are stored in the same
  `Map` with no namespace prefix distinguishing "full message list" from
  "history".
- **Gate 3 (new capability?)**: Conversation A is created for messages `[u1]`;
  its primary key `fp([u1])` is live in `_byFp` until `completeTurn`
  (`router.js:123`, replaced at `router.js:133-135`). Attacker B sends messages
  `[u1, X]`: `fpKey = fp([u1,X])` misses, `historyKey = fp([u1])` **hits A**
  (`router.js:120`). B's prompt `X` is then enqueued on A's live session with
  `seedText = ''`, and A's session context is returned to B. Same
  outside-baseline capability as VULN-002, reached without knowing any pin.
- **Entry Point**: all three façade POST routes
- **Data Flow**: `body.messages` → `normalize` (`openaiChat.js:30-33`) → `router.js:230` `acquire` → `router.js:103` `historyKey = this._fp(profileName, messages.slice(0,-1))` → `router.js:120` `this._byFp.get(historyKey)` → foreign `conv` → `router.js:238-241` turn executed on it.
- **Root Cause**: Two semantically different key spaces share one `Map`, so a
  fingerprint computed under one meaning matches an entry stored under the other.
- **Exploitability**: Requires knowing the exact text (and role sequence) of
  another conversation's opening message and racing its in-flight turn — narrow,
  but no secret is involved and the window widens with the CLI's response
  latency. The post-`completeTurn` history-stickiness path
  (`router.js:130-135`) offers the same attach with no race for any caller who
  knows a full transcript.

### [VULN-004] Profile-agreement check enforced on the pin path but absent on the `previous_response_id` path
- **Input**: #17 `previous_response_id`
- **Class**: CWE-863 (Incorrect Authorization) / conditional validation bypass; residual CWE-639
- **Severity**: Medium
- **Location**: `src/facade/router.js:106-107` vs `router.js:110-113`; resolution at `router.js:226-229`
- **Gate 0**: Not applicable — a check present on one branch and missing on its
  sibling is a validation gap, not a feature.
- **Gate 1 (reachable?)**: `POST /v1/responses` is enabled by default
  (`config.js:221`) and `previousResponseId` is threaded through
  `openaiResponses.js:76` → `router.js:220`.
- **Gate 2a (attacker-controlled?)**: `previous_response_id` is taken verbatim
  from the body (`openaiResponses.js:37`). The id itself is `resp_<uuid>`
  (`router.js:142`), unguessable — but any holder of one (the client that
  received it, anything that logged it, VULN-001's cross-origin page cannot read
  it, but VULN-002's hijack can surface it) can replay it with a *different*
  `model`.
- **Gate 2b (sanitization?)**: The `respConv` branch (`router.js:106-107`)
  assigns `conv = respConv` and **returns without any check**. The immediately
  adjacent `pinId` branch performs
  `if (conv.profileName !== profileName) throw FacadeError(400, …)`
  (`router.js:110-113`). `executeTurn` validates only that the *requested*
  `profileName` exists (`router.js:221-224`) — it never compares it to
  `respConv.profileName`. There is likewise no ownership check on the id
  (`router.js:227` is a bare `Map.get`).
- **Gate 3 (new capability?)**: The turn executes against `conv.profile`
  (`router.js:178-185`), not the requested model, while the response echoes
  `model: body.model` (`openaiResponses.js:47`). A caller can therefore route a
  turn into a backend/profile the request did not name, and receive a response
  that misattributes which model produced it — including routing a turn into a
  `pty`-mode conversation while nominally requesting a `headless` one. Under the
  Gate-3 exemption for CWE-639/306 with all-NONE auth fields, the missing
  ownership check on `_byResp` cannot be pre-authorized by the baseline.
- **Entry Point**: `POST /v1/responses`
- **Data Flow**: `body.previous_response_id` → `openaiResponses.js:37` → `:40` `previousResponseId` → `:76` → `router.js:226-228` `this._byResp.get(...)` → `router.js:106` `conv = respConv` (no profile or ownership check) → `router.js:178` `HEADLESS_RUNNERS[conv.profile.headlessRunner]` / `runPtyTurn`.
- **Root Cause**: The three conversation-resolution branches in `acquire`
  received inconsistent validation; only the pin branch got the binding check.
- **Exploitability**: Requires possession of a valid `resp_<uuid>`, which the
  legitimate client holds. Most impactful as a chained step after VULN-002/003.

### [VULN-005] The `copilot` pty profile is façade-selectable and receives none of the headless runner's tool lockdown
- **Input**: #5 / #13 / #19 (`model`)
- **Class**: CWE-863 (Incorrect Authorization) — authorization-scope selection defeating a security control by choosing an equivalent unprotected path
- **Severity**: Medium
- **Location**: `src/config.js:60-66` (profile `copilot`, `mode: 'pty'`, `args: ['--no-auto-update']`) vs `src/facade/headlessCopilotRunner.js:54-61` (`FIXED_ARGS` lockdown, applied only in the headless runner); selection at `src/facade/router.js:221`, `src/facade/dialects/openaiChat.js:13-14`
- **Gate 0 (intended behavior?)**: **No.** The runner's own SECURITY note
  (`headlessCopilotRunner.js:13-19`) states the design intent explicitly: *"The
  bridge exposes this profile as a chat responder over the cloud-API facade,
  where a prompt is untrusted, so tool execution must be impossible."* The pty
  `copilot` profile is exposed over the same façade and does not satisfy that
  stated invariant, so this is the application failing its own designed
  guarantee.
- **Gate 1 (reachable?)**: `copilot` is in `BUILTIN_PROFILES` (`config.js:60`)
  and, absent `BRIDGE_PROFILES`, **all** built-ins are enabled
  (`config.js:103-105`). It is advertised by `GET /v1/models`
  (`models.js:11-13`, filter is only `p.command`) and accepted by
  `executeTurn` (`router.js:221-224`) exactly like `copilot-headless`.
- **Gate 2a (attacker-controlled?)**: The profile is chosen by the caller's
  `model` string, split at the first `#` (`openaiChat.js:13-14`) and used as the
  `config.profiles` key. A façade caller picks `"copilot"` instead of
  `"copilot-headless"` with a one-character change.
- **Gate 2b (sanitization?)**: The lockdown flags (`--available-tools=__none__`,
  `--disable-builtin-mcps`, `--no-ask-user`) and the unconditional
  `delete env.COPILOT_ALLOW_ALL` (`headlessCopilotRunner.js:107`) exist **only**
  inside `runHeadlessCopilotTurn`. The pty path spawns through
  `sessionManager.create` → `Session` → `pty.spawn` (`session.js:16`) with
  `args = [...p.args]` = `['--no-auto-update']` (`sessionManager.js:76`) — none
  of the lockdown flags, and `COPILOT_ALLOW_ALL` removed only via the profile's
  `envScrub` list (`config.js:64`), which
  `PROFILE_COPILOT_ENV_SCRUB` can override (`config.js:157-159`) — precisely the
  override the headless runner defends against unconditionally and the pty path
  does not.
- **Gate 3 (new capability?)**: An untrusted façade prompt reaches an
  interactive, tool-capable `copilot` with no tool filter, in the operator's
  `cwd` with the operator's stored subscription credentials. Partial mitigation
  that I verified rather than assumed: `dialogPolicy` defaults to
  `'startup-only'` (`config.js:65`), and the copilot adapter's `startupDialogs`
  matches **only** the folder-trust screen (`src/adapters/copilot.js:70-77`), so
  a tool-approval prompt is not auto-answered. But that mitigation is
  operator-defeatable in one env var: `PROFILE_COPILOT_DIALOG_POLICY=auto-approve`
  (`config.js:153`) makes `makeDialogHandler` default-accept `enter` on any
  unmatched screen (`sessionManager.js:34`) — i.e. auto-approve tool execution —
  whereas the headless path's lockdown is *upstream of the approval layer* by
  construction and cannot be reopened that way.
- **Entry Point**: `POST /v1/chat/completions` (or `/v1/responses`, `/v1/messages`) with `{"model":"copilot", …}`
- **Data Flow**: `body.model = "copilot"` → `openaiChat.js:13-14` `profileName` → `openaiChat.js:63` → `router.js:221` `this._config.profiles['copilot']` (mode `pty`) → `router.js:67` `manager.create({profile:'copilot'})` → `sessionManager.js:75-79` `new Session({command, args:['--no-auto-update'], …})` → `session.js:16` `pty.spawn` → prompt typed at `turnRunner.js:88`.
- **Root Cause**: The tool lockdown is implemented in one runner rather than as
  a property of the profile, so the sibling profile that spawns the same binary
  over PTY inherits none of it, while both are equally selectable by the
  untrusted `model` field.
- **Exploitability**: Depends on interactive copilot's own approval behaviour
  for the specific tool (not verifiable from this repo — per Gate 2b rules I do
  not credit an unreadable external defense) and, for the fully-unattended
  variant, on the operator having set `auto-approve`. Reported as Medium on that
  basis. The adapter is also documented as extraction-DEGRADED
  (`adapters/copilot.js:14-24`), which makes accidental operator selection of
  this profile *more* likely to look like a benign misconfiguration than an
  attack.

### [VULN-006] LLM-influenced child stdout supplies the `--resume` session identifier with no validation
- **Input**: #42 `j.session_id` (`headlessClaudeRunner.js:60,66`); #43 `j.sessionId` (`headlessCopilotRunner.js:181`)
- **Class**: CWE-290 (spoofing of a session identity) / CWE-88 (argument injection, claude path only)
- **Severity**: Medium
- **Location**: `src/facade/headlessClaudeRunner.js:17` (`args.push('--resume', resumeSessionId)`), `:60`, `:66`; `src/facade/headlessCopilotRunner.js:97`, `:181`, `:196`; stored at `src/facade/router.js:182`
- **Gate 0**: Not applicable — session-id capture is a feature; accepting it
  unvalidated from an untrusted return path is not.
- **Gate 1 (reachable?)**: `runHeadlessClaudeTurn` and `runHeadlessCopilotTurn`
  are wired into `HEADLESS_RUNNERS` (`router.js:16`) and dispatched at
  `router.js:178-181` for the default-enabled `claude-headless` /
  `copilot-headless` profiles (`config.js:67-81`).
- **Gate 2a (attacker-controlled?)**: Indirectly but per the partition's own
  framing — "Child process → application is an **untrusted return path**:
  JSONL/raw PTY bytes emitted by an LLM-driven process." The value survives
  across turns: `conv.resumeSessionId = out.resumeSessionId` (`router.js:182`)
  → next turn's argv.
- **Gate 2b (sanitization?)**: **None whatsoever** — no UUID regex, no length
  bound, no leading-`-` rejection, no charset check at any of
  `headlessClaudeRunner.js:60/66/17` or `headlessCopilotRunner.js:181/97`.
  The JSONL is parsed with `JSON.parse` + `catch { continue }`
  (`headlessClaudeRunner.js:59`), which tolerates rather than rejects malformed
  input. Per Gate 2b rules I do not credit the vendored CLI's line-framing as a
  defense: its source is not readable in this repo, so it is treated as
  ineffective rather than assumed to escape embedded newlines.
- **Gate 3 (new capability?)**: For claude, `args.push('--resume', <value>)`
  passes the value as a **separate argv token**, so a value beginning with `-`
  is presented to the child's flag parser (e.g. a permission-relaxing flag) —
  this is the only place in the façade where a non-`FIXED_ARGS` token is
  appended from a non-operator source. Absent flag parsing, a substituted id
  resumes a *different* stored claude session from the operator's home
  directory, i.e. reads another conversation's context — again outside the
  documented baseline. The copilot path is `=`-joined
  (`--resume=${resumeSessionId}`, `headlessCopilotRunner.js:97`) so it cannot
  become a separate flag, but the session-substitution concern is identical.
- **Entry Point**: `POST /v1/chat/completions|/v1/responses|/v1/messages` with `model: "claude-headless"` / `"copilot-headless"` (second and subsequent turns of a conversation)
- **Data Flow**: prompt (#7/#15/#21) → `headlessClaudeRunner.js:85` child stdin → child stdout JSONL → `:59` `JSON.parse` → `:60` `sessionId = j.session_id` (or `:66` from the `result` event) → `:77` `resumeSessionId` → `router.js:182` `conv.resumeSessionId` → next turn `headlessClaudeRunner.js:17` `args.push('--resume', sessionId)` → `:25` `spawn(profile.command, args, …)`.
- **Root Cause**: A value crossing back from an untrusted, LLM-driven child
  process is used directly as a process argument and as a session identity with
  no format validation.
- **Exploitability**: Requires the prompt to influence the child's *structured
  stdout framing*, not merely its message text — a meaningful hurdle, and the
  reason this is Medium rather than High. It is nonetheless the cheapest
  possible fix (a `/^[A-Za-z0-9._-]{1,128}$/` guard at capture) and the code
  currently has zero defence in depth here.

---

## Summary

- **CANDIDATE**: VULN-001 (CSRF, High), VULN-002 (pin IDOR, High),
  VULN-003 (fingerprint key-space collision, Medium), VULN-004 (missing
  profile/ownership check on `previous_response_id`, Medium), VULN-005 (pty
  `copilot` escapes the tool lockdown, Medium), VULN-006 (unvalidated
  `--resume` identity from untrusted child stdout, Medium).
- **CROSS-CLASS**: #7 / #15 / #21 (prompt → CLI, INJ); #24
  (`shared.js:131` `console.warn` with attacker-controlled key, LOG); #44
  (`headlessClaudeRunner.js:74`, `headlessCopilotRunner.js:191` stderr echoed to
  client, LOG). Also noted for LOG/availability: `router.js:49-55`
  `_ensureCapacity` lets any caller evict another conversation's idle pty
  session (including pinned ones) by opening `facade.maxSessions` conversations.
- **SAFE / NO-MATCH**: #6, #8, #9, #10, #14, #16, #18, #20, #22, #23, #25, and the
  non-identity fields of #42/#43 — see the disposition table for per-input reasons.
- **No CWE-915 mass-assignment finding**: Request Body Gate steps (a)-(e)
  completed; the dialects use explicit field extraction with no catch-all mapper.
- **No authorization-helper omission finding**: every route passes through the
  single `checkToken` call at `facade/index.js:45`.
