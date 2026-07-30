# SG-2 — NAV class results (Bridge session REST API)

**Repo root:** `/home/kali/repos/cosplai`
**Class group:** CSRF, IDOR, auth bypass, conditional validation bypass, identity
spoofing, confused deputy, security signal spoofing, mass assignment, parameter pollution

> **Line-number note:** the partition data file cites `src/httpApi.js:194/203/206-207/219-222/235`.
> The live file is shorter; the same code is at **`httpApi.js:133-137` (create),
> `:146` (list), `:149-151` (id dispatch), `:158-165` (prompt), `:174-181` (key),
> `:183-191` (events)**. All findings below cite verified live line numbers.

---

## Disposition table

| # | Input | Disposition | Anchor |
|---|---|---|---|
| 26 | `profile` | DESIGN-INTENT (+ contributes to VULN-001) | `sessionManager.js:41-50` |
| 27 | `cwd` | **CANDIDATE** VULN-002 | `sessionManager.js:76` → `session.js:16` |
| 28 | `cols` | CROSS-CLASS (LOG) | `sessionManager.js:78,80` |
| 29 | `rows` | CROSS-CLASS (LOG) | `sessionManager.js:78,80` |
| 30 | `GET /api/sessions` (no input) | SAFE | `httpApi.js:146-147` |
| 31 | `parts[2]` session id | **CANDIDATE** VULN-003 | `httpApi.js:149-151` |
| 32 | `text` | DESIGN-INTENT for NAV (sink of VULN-001); CROSS-CLASS (INJ) | `httpApi.js:162-165` |
| 33 | `submit` | SAFE | `httpApi.js:165` |
| 34 | `timeoutMs` | CROSS-CLASS (LOG) | `httpApi.js:164` |
| 35 | `keys[]` | **CANDIDATE** VULN-004; CROSS-CLASS (INJ) | `httpApi.js:178` |
| 45 | PTY output → response | NO-MATCH for NAV; CROSS-CLASS (INJ) | `session.js:17-22` → `httpApi.js:33-39,185` |

Additional structural finding from the absent-input pass: **VULN-005** (`readBody`
fails open on malformed JSON, `httpApi.js:67`).

---

## [VULN-001] No CSRF / origin control on any state-changing bridge endpoint

- **Input**: #26/#27/#28/#29 (`POST /api/sessions` body), #32/#33/#34 (`POST /api/sessions/:id/prompt` body), #35 (`POST /api/sessions/:id/key` body)
- **Class**: CWE-352 (Cross-Site Request Forgery)
- **Severity**: **High**
- **Location**: `src/httpApi.js:112-199` (whole request handler — no `Origin` / `Sec-Fetch-Site` / `Sec-Fetch-Mode` check anywhere), auth at `src/httpApi.js:129`, token-from-query at `src/auth.js:14-16`
- **Gate 0 (intended behavior?)**: NO. Gate 0 does not apply — the missing control *is* the security check. The partition Gate-3 baseline explicitly excludes "reaching any of this from a cross-origin web page without the operator's intent."
- **Gate 1 (reachable?)**: Production. `createHttpServer` is mounted unconditionally at `src/server.js:26` and `server.listen` at `:28`. No dev guard.
- **Gate 2a (attacker-controlled?)**: Yes. The request method, `Content-Type`, body bytes and the `?token=` query string are all fully controlled by any web page loaded in the operator's browser. The bearer token is the only prerequisite; it is placed in the top-level page URL (`server.js:29`, `public/index.html:9,16`), printed to stdout at boot, and accepted in the query string (`auth.js:14-16`), so it reaches shell history, browser history, and any process/log capture. Per shared-file rules, infrastructure ("it's only on 127.0.0.1") is not an admissible defense — and `HOST`/`PORT` are env-configurable (`config.js:202-203`) with no bind restriction in code.
- **Gate 2b (sanitization?)**: **None.** Grep across `src/` and `public/` for `Origin`, `Sec-Fetch`, `cors`, `Access-Control` returns zero hits in application code (only an unrelated comment in `public/vendor/xterm.css`). There is no CSRF token, no double-submit cookie, no `SameSite` cookie (auth is not cookie-based, but that does not help — the token travels in the URL the attacker supplies). Content-Type is never inspected: `readBody` (`httpApi.js:49-71`) parses the raw body regardless of `Content-Type`, so a **simple request** — `fetch(url, {method:'POST', mode:'no-cors', headers:{'Content-Type':'text/plain'}, body:'{"cwd":"/"}'})` or `<form enctype="text/plain">` — is preflight-free and reaches the handler with a fully attacker-chosen JSON body. The class-file exemption for "JSON-only bodies with strict Content-Type checking" therefore does **not** apply.
- **Gate 3 (new capability?)**: New. The attacker gains the ability to spawn agentic AI-CLI child processes carrying the operator's ambient credentials (`session.js:16`, `env: process.env` at `sessionManager.js:77`) in an attacker-chosen working directory, and to drive an existing session (`/prompt`, `/key`) — **from a web page, with no operator action beyond visiting it**. Nothing in the baseline grants a remote web origin that reach. `DELETE` and non-simple content types are preflighted and thus blocked, but every high-value operation here is a `POST`.
- **Entry Point**: `POST /api/sessions`, `POST /api/sessions/:id/prompt`, `POST /api/sessions/:id/key`
- **Data Flow**: attacker page `fetch`/`<form>` → `http.createServer` handler `httpApi.js:112` → `checkToken(extractToken(req))` `httpApi.js:129` (passes on the query-string token) → `readBody` `httpApi.js:49-71` (no Content-Type check) → `manager.create(b)` `httpApi.js:137` / `sendPrompt` `httpApi.js:165` / `rec.session.write(...)` `httpApi.js:178` → `pty` `session.js:16,25`
- **Root Cause**: The server treats possession of a bearer token in the URL as sufficient authorization and never verifies request provenance. A browser will attach that URL-borne credential on behalf of any origin.
- **Exploitability**: Practical once the token is known or replayed. Response bodies are not readable cross-origin (no CORS headers are emitted), so `POST /api/sessions` is blind — the attacker cannot read back the returned session id. Impact is therefore: unbounded blind session creation with attacker-chosen `cwd`/`profile` (chains with VULN-002), plus full `/prompt` and `/key` control once any session id leaks. **Related, same root cause, other partition:** `src/wsApi.js:8` performs the identical token-only check with no `Origin` verification — browser WebSockets are exempt from CORS entirely, so `/ws` is a *readable* cross-site channel. Flagging for whoever owns `wsApi.js`.

---

## [VULN-002] Client-controlled `cwd` overrides the operator-configured working directory of the spawned AI CLI

- **Input**: #27 — HTTP body field `cwd` on `POST /api/sessions`
- **Class**: CWE-915 (mass assignment / improperly controlled modification of object attributes); secondary CWE-668 (exposure of resource to wrong sphere)
- **Severity**: **High**
- **Location**: `src/sessionManager.js:76` (`cwd: cwd || p.cwd`) → `src/session.js:16` (`pty.spawn(command, args, { … cwd … })`)
- **Request Body Gate (CWE-915) — executed in full:**
  - **(a) All endpoints deserializing this body type.** Grep for `manager.create(` / `.create({`: `src/httpApi.js:137` (`POST /api/sessions`, raw body `b`), `src/wsApi.js` (WS connect), and `src/facade/router.js` (facade-managed sessions). The bridge REST path is the *lowest-trust* consumer and the only one that forwards a raw client object.
  - **(b) Field classification** (`sessionManager.js:41` destructure `{profile, cwd, cols, rows}`): `cols`/`rows` = legitimately client-owned (terminal geometry). `profile` = operator-owned but whitelist-bounded. **`cwd` = operator-owned, unbounded** — it has a dedicated operator configuration path (`PROFILE_<NAME>_CWD` → `config.js:183`, global `CWD`/`HOME` → `config.js:94`), i.e. the designers established `cwd` as *deployment* configuration, then let the request override it.
  - **(c) Fields overridden/stripped before the service layer**: **none.** `httpApi.js:137` passes the parsed body straight through with no field filtering, no allow-list, and no schema. There is not even a `typeof` check.
  - **(d) Mapper**: `sessionManager.js:75-79` copies `cwd` verbatim into the `Session` constructor; `session.js:16` copies it verbatim into `pty.spawn`. No `path.resolve`, no prefix containment, no `existsSync`, no realpath check anywhere on this value (grep for `cwd` across `src/` confirms `session.js:16` is the only consumer).
  - **(e) Cross-endpoint comparison**: the config layer restricts `cwd` to an operator-set value (`config.js:183`); the REST endpoint does not. A field constrained in the higher-trust channel and unconstrained in the lower-trust one is exactly the CWE-915 pattern.
- **Gate 0 (intended behavior?)**: No. The documented Gate-3 baseline names "controlling the child process's working directory" and "escaping the vendor directory" as *outside* the baseline. Per the class file, DESIGN-INTENT must not be recorded for body inputs.
- **Gate 1 (reachable?)**: Production — `SessionManager.create` is called at `httpApi.js:137`, `wsApi.js`, and `facade/router.js`. Three production call sites, zero dev guards.
- **Gate 2a (attacker-controlled?)**: Yes, verbatim from the request body; via VULN-001 also from a cross-origin page.
- **Gate 2b (sanitization?)**: None (see (d)). `cwd || p.cwd` only falls back on falsy — any non-empty string wins. A relative path, `/`, `/root`, `/etc`, another user's home, or the repo's own `vendor/` directory are all accepted.
- **Gate 3 (new capability?)**: New and concrete. The spawned process is an **agentic coding CLI holding the operator's live credentials** (`env: process.env`, `sessionManager.js:77`; only a short per-profile `envScrub` list is removed, `config.js:39,45,55,64`). Its file-access scope is its `cwd`. By choosing `cwd`, the caller relocates that agent into any directory readable/writable by the operator account and then drives it via `/prompt` (#32). No existing path in the baseline lets a caller do this — `config.js:183` is the only other writer and it is operator-only env.
- **Entry Point**: `POST /api/sessions`
- **Data Flow**: request body `cwd` → `readBody` `httpApi.js:134` → `manager.create(b)` `httpApi.js:137` → destructure `sessionManager.js:41` → `cwd: cwd || p.cwd` `sessionManager.js:76` → `new Session(...)` → `pty.spawn(command, args, {cwd})` `session.js:16`
- **Root Cause**: A deployment-configuration field is accepted from the request body and given precedence over the operator's configured value, with no containment check.
- **Exploitability**: Single unauthenticated-by-origin request. Trivially chained with VULN-001 (create the session cross-origin) and #32 (drive it). **CROSS-CLASS (#27, `session.js:16`, suspected INJ)** for the process-spawn sink itself — INJ should evaluate whether the `cwd` value can influence command resolution or shell startup-file execution for the chosen profile.

---

## [VULN-003] Session id is an existence check only — no ownership/authorization binding on any per-session route

- **Input**: #31 — HTTP path segment `parts[2]`
- **Class**: CWE-639 (authorization bypass through user-controlled key / IDOR)
- **Severity**: **Medium** (flagged at default severity per the class file; Phase 2b should apply the Authorization Delegation Rule — see "Honest bounding" below)
- **Location**: `src/httpApi.js:149-151` (`manager.get(parts[2])`; `if (!rec) return 404`), record construction `src/sessionManager.js:82-86`
- **Resource ID Gate (CWE-639) — executed in full:**
  - **(a) Does the code verify the caller owns THIS id?** No. `SessionManager.get` (`sessionManager.js:94`) is a bare `Map.get`. The record built at `sessionManager.js:82-86` contains `{id, session, terminalModel, adapter, queue, createdAt, profile, dialogPolicy}` — **no owner, principal, subject, or creator field exists on it**, so ownership cannot be checked anywhere. `checkToken` (`auth.js:3-9`) is a constant-time compare against one shared secret and produces no principal.
  - **(b) Downstream credential**: the downstream is a local child process spawned with `env: process.env` (`sessionManager.js:77`) — the operator's ambient credentials, with **no** end-user identity forwarded through any channel. Classic missing-identity-propagation shape; the child cannot enforce per-caller authorization.
  - **(c) Multiple IDs?** Only one resource id per route; `parts[3]` is a fixed action verb (`prompt`/`key`/`events`), not an id.
- **Gate 0 (intended behavior?)**: Exempt. The class file forbids dismissing CWE-639 as "passthrough by design," and forbids DESIGN-INTENT based on caller trust level.
- **Gate 1 (reachable?)**: Production — `httpApi.js:149` covers `GET`, `DELETE`, `POST …/prompt`, `POST …/key`, `GET …/events`. Five production operations.
- **Gate 2a (attacker-controlled?)**: Yes — raw URL path segment.
- **Gate 2b (sanitization?)**: Only a Map-membership test. No format validation, and format validation would not satisfy (a) regardless.
- **Gate 3 (new capability?)**: `GET /api/sessions` (`httpApi.js:146-147`) returns **every** session id, so any token holder enumerates and then acts on sessions created by any other channel — including sessions created by the facade router (`src/facade/router.js`) and by WebSocket clients, which the REST caller never created. `DELETE` kills them (`httpApi.js:154`), `/prompt` types into them, `/events` streams their raw output.
- **Entry Point**: `GET/DELETE /api/sessions/:id`, `POST /api/sessions/:id/prompt`, `POST /api/sessions/:id/key`, `GET /api/sessions/:id/events`
- **Data Flow**: URL path → `u.pathname.split('/')` `httpApi.js:131` → `parts[2]` → `manager.get()` `httpApi.js:150` → `_records.get(id)` `sessionManager.js:94` → `rec.session.write` / `rec.session.kill` / SSE attach
- **Root Cause**: The session record has no owner attribute, so per-resource authorization is not merely un-enforced — it is unrepresentable.
- **Honest bounding for Phase 2b**: the deployment uses one shared token, so today all REST callers are the same principal, and ids are `crypto.randomUUID()` (`session.js:8`, unguessable). The cross-principal edge that *does* exist is REST ↔ facade ↔ WebSocket sessions sharing one `SessionManager` while only the facade tracks its own session lifecycle. Phase 2b may reasonably land this at Medium or Informational. It is reported because the class file mandates the gate and forbids clearing on "authentication alone."

---

## [VULN-004] `POST /:id/key` writes arbitrary attacker bytes to the PTY, bypassing every guard its sibling `/prompt` handler enforces

- **Input**: #35 — HTTP body field `keys[]`
- **Class**: CWE-863 / CWE-20 — conditional validation bypass via sibling handler (guards enforced on one path to the same sink, absent on another)
- **Severity**: **Medium**
- **Location**: `src/httpApi.js:178` — `for (const k of (b.keys || [])) rec.session.write(rec.adapter.keySeq(k));`
- **Gate 0 (intended behavior?)**: Not exempt as designed behavior. The documented contract (and the partition's Gate-3 baseline) is "send **named** key sequences." Every adapter's `keySeq` instead falls through to `String(name)` for **unrecognized** names — `adapters/generic.js:22-24`, `claude.js:96-98`, `codex.js:86-88`, `copilot.js:74-76`, `antigravity.js:61-63` all read `hasOwnProperty(KEYS, name) ? KEYS[name] : String(name)`. So `{"keys":["<anything>"]}` is a raw PTY write, not a named key. Gate 0 does not cover a validation gap.
- **Gate 1 (reachable?)**: Production — `httpApi.js:174-181`, no guard.
- **Gate 2a (attacker-controlled?)**: Yes. `b.keys` is unvalidated: no `Array.isArray` check (a string value iterates per character), no element type check, no membership check against the adapter's `KEYS` table.
- **Gate 2b (sanitization?)**: None — verified by reading all five adapter `keySeq` implementations. `String(name)` is a coercion, not a sanitizer.
- **Gate 3 (new capability?)**: Yes, three distinct guards are skipped that `/prompt` enforces on the identical `session.write` sink:
  1. **Turn serialization.** `/prompt` runs inside `rec.queue.enqueue(...)` (`httpApi.js:165`, `promptQueue.js:3-7`); `/key` writes directly at `:178`. An attacker can interleave keystrokes into another caller's in-flight turn — answering a tool-approval or destructive-action confirmation dialog that `dialogPolicy: 'startup-only'`/`'never'` (`config.js:41,46,58,65,84`; `sessionManager.js:23`) was specifically designed to surface to a human rather than auto-answer. The dialog handler's two-answers-per-screen loop guard (`sessionManager.js:30`) does not constrain `/key` at all.
  2. **Multiline safety.** `/prompt` routes through `writeAndSubmitPrompt` → `writePromptText` (`promptWriter.js:9-18`), which bracketed-paste-wraps `\n` or raises `MultilineUnsupportedError`. `/key` writes `\n`/`\r` raw, so an attacker submits arbitrary multi-command input to profiles that explicitly declare bracketed paste unsupported.
  3. **Type validation.** `/prompt` requires `typeof b.text === 'string'` (`httpApi.js:162`); `/key` requires nothing.
  This is exactly the class-file "companion input" shape: the same dangerous sink, guarded on one path and unguarded on another.
- **Entry Point**: `POST /api/sessions/:id/key`
- **Data Flow**: body `keys[]` → `httpApi.js:176` `readBodyOr413` → `httpApi.js:178` loop → `adapter.keySeq(k)` → `String(k)` (adapter fallback branch) → `rec.session.write` `session.js:25` → `pty.write`
- **Root Cause**: The keyseq lookup fails open (`: String(name)`) instead of rejecting unknown key names, and the handler does not reuse the prompt path's queue/type/multiline guards.
- **Exploitability**: One request, and CSRF-reachable via VULN-001 (simple `text/plain` POST). **CROSS-CLASS (#35, `httpApi.js:178` → `session.js:25`, suspected INJ)** — INJ owns the arbitrary-bytes-into-a-live-agentic-CLI sink itself.

---

## [VULN-005] `readBody` fails open on malformed JSON, silently substituting `{}`

- **Input**: absent/malformed request body (absent-input analysis, all POST routes)
- **Class**: CWE-636 (failure to a permissive state) — CSRF/validation enabler
- **Severity**: **Low** on its own; it is the mechanism that makes VULN-001 a *fully* controllable simple-request CSRF, so its real weight is carried there.
- **Location**: `src/httpApi.js:67` — `try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); }`
- **Gate 0**: Not applicable — this is error handling around a security-relevant parse, not a feature.
- **Gate 1 (reachable?)**: Production — `readBodyOr413` (`httpApi.js:76-83`) is called at `httpApi.js:134`, `:160`, `:176`.
- **Gate 2a/2b**: The body bytes are attacker-controlled and never Content-Type-checked; the `catch` discards the error.
- **Gate 3 (new capability?)**: `POST /api/sessions` with an unparsable body still **succeeds**, creating a default-profile PTY session (`sessionManager.js:41-42`, `name = profile || c.defaultProfile`). This is precisely what makes a bare cross-site `<form>` submission (whose `application/x-www-form-urlencoded` body is never valid JSON) a working session-spawn primitive without any `enctype`/`fetch` trickery. The peer implementation rejects with 400 (`src/facade/shared.js:74`) — the bridge is the inconsistent one.
- **Absent-input results for the rest of the inventory** (all fail closed, recorded for completeness): missing `Authorization` header → falls back to the query token → `null` → `checkToken` returns false on the `typeof` guard (`auth.js:4`) → 401 (`httpApi.js:129`). Missing `text` → 400 (`httpApi.js:162`). Missing `keys` → `|| []` no-op (`:178`). Missing `timeoutMs` → config default (`:164`). Missing `submit` → defaults to submitting (`b.submit !== false`, `:165`) — documented default, not a security gate. Missing `profile`/`cols`/`rows` → config defaults (`sessionManager.js:42,78`). Missing `cwd` → operator default `p.cwd` (`:76`) — the *presence* of `cwd` is the problem (VULN-002), not its absence.

---

## SAFE / DESIGN-INTENT / CROSS-CLASS dispositions

**#26 `profile` — DESIGN-INTENT.** Resource-ID-Gate treatment as an authorization-scope
selector was performed: the value indexes `c.profiles` (`sessionManager.js:43`), whose
entire membership is operator-controlled via `BRIDGE_PROFILES` (`config.js:103-105`) and
whose commands come from the frozen `BUILTIN_PROFILES` table or explicit `PROFILE_*_COMMAND`
env (`config.js:36-86,136`). Unknown → coded 400 (`sessionManager.js:45-50` → `httpApi.js:140-142`);
non-pty → 400 (`:51-56`); command-less `generic` → 400 (`:57-62`). Every reachable value is a
profile the operator deliberately enabled, and no *finer* authorization scope exists to be
selected (single principal). Recorded as DESIGN-INTENT on the value set, **not** on caller
trust level. It remains an amplifier of VULN-001 (a CSRF request picks the profile) and of
VULN-002 (profile + `cwd` together choose which agent runs where).

**#28 `cols` / #29 `rows` — CROSS-CLASS (LOG).** `sessionManager.js:78,80` → `session.js:16`
`pty.spawn` and `new TerminalModel` → `@xterm/headless`. `cols || p.cols` accepts any truthy
value with zero numeric validation: negative, `1e9`, a string, an array. This is a
resource-exhaustion / crash concern, not an authorization one. **CROSS-CLASS (#28/#29,
`src/session.js:16` and `src/terminalModel.js` constructor, suspected LOG.)** No NAV sink.

**#30 `GET /api/sessions` — SAFE for NAV.** Token-gated at `httpApi.js:129`; no input to
trace. Noted (not filed separately): it discloses **all** session ids, which is the
enumeration primitive feeding VULN-003. Not cross-origin readable — no CORS headers are
emitted anywhere.

**#32 `text` — DESIGN-INTENT for NAV; CROSS-CLASS (INJ).** Typing operator text into the
attached CLI is the product's core purpose and is inside the stated Gate-3 baseline, so it
is not an authorization defect in itself. Its NAV weight is entirely as the *sink* of
VULN-001 (cross-origin reachability). **CROSS-CLASS (#32, `src/promptWriter.js:10,13,16` →
`src/session.js:25`, suspected INJ)** — unfiltered content into a live agentic AI CLI,
including the bracketed-paste wrapping at `promptWriter.js:13`.

**#33 `submit` — SAFE.** Used only as `b.submit !== false` (`httpApi.js:165`) → a strict
boolean decision on whether to append `adapter.keySeq('submit')`. Never reaches a NAV sink;
no type confusion possible (strict inequality against a literal).

**#34 `timeoutMs` — CROSS-CLASS (LOG).** `Number.isFinite(b.timeoutMs)` (`httpApi.js:164`)
constrains the *type* but not the *range*: `0`, negatives, and values above `2**31-1` all
pass and land in `setTimeout` at `stateDetector.js:103`, where Node clamps out-of-range
delays to `1ms`. Effect: the prompt text is written and submitted (`httpApi.js:165` →
`promptWriter.js:27-32`) and *then* the turn immediately reports `settle timeout`, setting
`record.suspect = true` (`httpApi.js:30`) which degrades every subsequent turn on that
session (`httpApi.js:16-19`). Availability/state-corruption, not authorization.
**CROSS-CLASS (#34, `src/stateDetector.js:103`, suspected LOG.)**

**#45 PTY output → response — NO-MATCH for NAV; CROSS-CLASS (INJ).** Traced fully:
`session.js:17-22` → `terminalModel.write` (`sessionManager.js:81`) → `renderLinesSince`
(`httpApi.js:33`) → `adapter.extractResponse` (`httpApi.js:35-37`) → JSON response
`text`/`output`/`prompt` (`httpApi.js:39`, `:166`), and the raw byte stream → SSE
`httpApi.js:185`. Store-boundary rule applied: all readers of the terminal model and of the
`session 'data'` event were enumerated (`httpApi.js:185`, `stateDetector.js`,
`sessionManager.js:81`, `facade/router.js`, `wsApi.js`). **No NAV sink** — this data never
becomes an identity value, an authorization decision, an outbound security-signal header, or
a resource selector. **CROSS-CLASS (#45, `src/httpApi.js:185` and the SSE/`text` consumers in
`public/index.html`, suspected INJ)** — LLM-generated terminal bytes rendered client-side.

---

## Mandatory post-trace audit: authorization helper coverage

Every bridge route in `src/httpApi.js` is dispatched **after** the single gate at
`httpApi.js:129` (`if (!checkToken(extractToken(req), config.token)) return 401`), which
precedes the `parts` split at `:131` and therefore covers `/api/sessions` create/list, all
five `/api/sessions/:id/*` operations, and the HTML shell. **No handler-level gap found.**

Two routes are matched before that gate; both were verified rather than assumed:
- `GET /vendor/*` (`httpApi.js:117-122`) — intentionally public static assets. Contained by
  `path.resolve(PUBLIC, '.'+pathname)` plus a `f !== VENDOR && !f.startsWith(VENDOR + path.sep)`
  prefix check at `:119`, evaluated after the `URL` constructor has already percent-decoded
  the path, so `%2e%2e%2f` normalizes before the check. Not a NAV gap.
- Facade `/v1/*` (`httpApi.js:127`) — `canHandle` is an exact `"METHOD /path"` Map membership
  test (`facade/index.js:38`) over a fixed table (`facade/index.js:20-34`), so it cannot shadow
  any `/api/sessions` path, and `facade.handle` performs its own `checkToken` before
  dispatching (`facade/index.js:41-48`). Not a NAV gap. (Facade findings belong to its own partition.)

No `Can*`/`Has*Permission`/`check*Access`/`require*Role`/`authorize*` helpers exist in the
codebase — there is no authorization layer to be inconsistently invoked. That absence is the
substance of VULN-003 rather than a separate CWE-862 finding: with no owner recorded on the
session record (`sessionManager.js:82-86`), no handler *could* call such a helper.
