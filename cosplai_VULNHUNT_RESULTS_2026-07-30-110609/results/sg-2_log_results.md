# SG-2 — LOG trace results (Bridge session REST API)

Class group: Race conditions, cache isolation, credential scope, resource
exhaustion, prototype pollution, crypto, integer overflow.

Target root: `/home/kali/repos/cosplai`
Gate 1 (global): `src/server.js:24,26` wires `new SessionManager(config)` and
`createHttpServer(config, manager, facade)` — all sinks below are production
reachable. No dev-only guard anywhere in `httpApi.js` / `sessionManager.js` /
`session.js` / `terminalModel.js`.

---

## Disposition table

| # | Input | Disposition |
|---|---|---|
| 26 | `profile` | CANDIDATE (VULN-003, unbounded session creation) + SAFE (prototype-key lookup, see notes) |
| 27 | `cwd` | CROSS-CLASS (`session.js:16`, suspected NAV/INJ) |
| 28 | `cols` | **CANDIDATE** VULN-001, VULN-002 |
| 29 | `rows` | **CANDIDATE** VULN-001, VULN-002 |
| 30 | `GET /api/sessions` (no input) | NO-MATCH |
| 31 | `parts[2]` session id | SAFE for LOG (`Map.get`, prototype-safe); CROSS-CLASS (`httpApi.js:150`, NAV — no owner recorded) |
| 32 | `text` | SAFE for LOG (1 MiB cap at `httpApi.js:48/54`); CROSS-CLASS (`promptWriter.js:9-18` → `session.js:25`, INJ); contributes to VULN-004/005 |
| 33 | `submit` | NO-MATCH (`b.submit !== false`, boolean coercion, no LOG sink) |
| 34 | `timeoutMs` | **CANDIDATE** VULN-006 |
| 35 | `keys[]` | **CANDIDATE** VULN-004, VULN-005; CROSS-CLASS (`httpApi.js:178`, INJ — `keySeq` falls through to `String(name)`) |
| 45 | PTY output | **CANDIDATE** VULN-007 (SSE backpressure); otherwise SAFE (ring capped at `session.js:20`; adapter regexes have no nested quantifiers) |

---

## Candidates

### [VULN-001] Unvalidated `cols`/`rows` → multi-hundred-MB allocation per request (memory exhaustion)
- **Input**: #28 `cols`, #29 `rows` — HTTP body fields of `POST /api/sessions`
- **Class**: CWE-1284 (improper validation of specified quantity) → CWE-400 (uncontrolled resource consumption)
- **Severity**: High (single unauthenticated-shape request per unit of damage; single shared token; whole bridge process dies, killing every operator session and every spawned agentic CLI). Adjustment: single request → higher.
- **Location**: `/home/kali/repos/cosplai/src/sessionManager.js:78,80` → `/home/kali/repos/cosplai/src/terminalModel.js:6` and `/home/kali/repos/cosplai/src/session.js:16`
- **Gate 0 (intended behavior?)**: No. Terminal geometry is a rendering hint, not a caller-owned resource budget. Nothing in the documented contract lets the caller choose the server's allocation size. A cap does not remove any feature.
- **Gate 1 (reachable?)**: `manager.create(b)` at `httpApi.js:137`, reached from `server.js:26`. Also `facade/router.js:67`, but that path hardcodes `cols: config.facade.cols` — only the bridge route passes caller-controlled geometry. 1 production call site with attacker input.
- **Gate 2a (attacker-controlled?)**: Yes. `httpApi.js:134 readBodyOr413(req,res)` → `b` → `manager.create(b)` (`httpApi.js:137`) → destructured `{ profile, cwd, cols, rows }` (`sessionManager.js:41`). Raw JSON body value, no intermediate store.
- **Gate 2b (sanitization?)**: **None.** The only transform is `cols || p.cols` (`sessionManager.js:78,80`) — a falsy-fallback, not a validator. `grep -n "Number|parseInt|isInteger|Math.min|Math.max"` over `httpApi.js` returns only the `timeoutMs` check (line 164) and the `/key` sleep clamp (line 180); neither touches geometry. `@xterm/headless`'s own `_sanitizeAndValidateOption` rejects only `NaN`/non-numeric — it accepts arbitrarily large integers (verified empirically, below).
- **Gate 2b — empirical verification** (run against the repo's own `node_modules/@xterm/headless`, not from training knowledge):

  ```
  baseline rss             58 MB
  cols=120     rows=30     rss  60 MB     7 ms
  cols=100000  rows=30     rss 102 MB    48 ms
  cols=1000000 rows=30     rss 491 MB   384 ms
  cols=120     rows=200000 rss 805 MB   519 ms
  ```

  One `POST /api/sessions {"cols":1000000}` costs ~430 MB and 384 ms of
  blocked event loop. A handful of requests OOM-kills the Node process. The
  memory is never reclaimed for the life of the session, and `SessionManager`
  has no reaper (see VULN-003).
- **Gate 3 (new capability?)**: Yes, affirmatively. Baseline (per partition data) is "create/list/delete PTY sessions, type text, read output, send keys". Nothing in the baseline lets a caller allocate ~0.5 GB of server heap per request or terminate the bridge process. The attacker gains: **remote termination of the bridge, killing every concurrently running agentic CLI session belonging to other work in flight** — i.e. one session destroying all others, which the partition threat model explicitly calls out as meaningful under the single-token model. No existing path (`/prompt`, `/key`, `/events`, `DELETE`) produces process death.
- **Entry Point**: `POST /api/sessions` (`httpApi.js:133`)
- **Data Flow**:
  1. `src/httpApi.js:134` — `const b = await readBodyOr413(req, res)` (JSON body, 1 MiB cap only)
  2. `src/httpApi.js:137` — `manager.create(b)`
  3. `src/sessionManager.js:41` — `create({ profile, cwd, cols, rows } = {})` — no validation
  4a. `src/sessionManager.js:78` — `cols: cols || p.cols, rows: rows || p.rows` → `new Session(...)` → `src/session.js:16` `pty.spawn(command, args, { cols, rows, ... })`
  4b. `src/sessionManager.js:80` — `new TerminalModel({ cols: cols || p.cols, rows: rows || p.rows, scrollback: c.scrollback })` → `src/terminalModel.js:6` `new Terminal({ cols, rows, scrollback, allowProposedApi: true })` ← **allocation sink**
- **Root Cause**: `cols`/`rows` are forwarded from the request body to an allocation-sizing constructor with only a falsy-fallback (`||`) between source and sink. There is no integer check, no lower bound, and no upper bound.
- **Exploitability**: Trivial. Single request, no timing, no race. `curl -H 'authorization: Bearer $T' -d '{"cols":1000000}' http://127.0.0.1:7681/api/sessions`, repeated ~4x. Note the partition threat model: no `Origin`/`Sec-Fetch-Site` check exists anywhere, so this is reachable as a no-preflight cross-site `fetch` from a web page that learns the token (which is accepted in the query string, `auth.js:14-16`, and printed to stdout at boot, `server.js:29`).
- **Amplifier (same root cause, same fix — not a separate finding)**: adapter markers such as `/·.*Context.*used|weekly \d+%/` (`adapters/codex.js:46`) and `/Session:.*AIC used/` (`adapters/copilot.js:45`) are `.*X.*Y` patterns evaluated by `StateDetector._evaluate`/`_periodicCheck` (`stateDetector.js:69,83`) against every rendered line. Rendered line length equals `cols`. At `cols=1000000` these degrade to O(n²) backtracking on a non-matching line, blocking the event loop. Bounding `cols` fixes this too, so it is folded in rather than filed separately.

---

### [VULN-002] Non-integer `rows` orphans a spawned agentic-CLI child process (untracked, unkillable)
- **Input**: #29 `rows` (equivalently #28 `cols`)
- **Class**: CWE-404 (improper resource shutdown/release) → CWE-400. Distinct fix from VULN-001 (this is constructor **ordering / cleanup**, not range validation) — bounding the range would still leave the ordering bug for any other constructor throw.
- **Severity**: High (each request permanently leaks an agentic AI CLI process running with the operator's ambient credentials; the process is invisible to `GET /api/sessions` and cannot be reached by `DELETE /api/sessions/:id`).
- **Location**: `/home/kali/repos/cosplai/src/sessionManager.js:75-91`
- **Gate 0 (intended behavior?)**: No. Leaking a child process on an error path is not a feature.
- **Gate 1 (reachable?)**: Same as VULN-001 — `httpApi.js:137` → `server.js:26`. The `RangeError` is not in the coded-error allowlist at `httpApi.js:140`, so it rethrows to the outer `catch` (`httpApi.js:200`) and surfaces as a generic 500 — no cleanup runs anywhere.
- **Gate 2a (attacker-controlled?)**: Yes — identical flow to VULN-001, direct from the JSON body.
- **Gate 2b (sanitization?)**: None. Confirmed no integer/range check anywhere between `httpApi.js:134` and `sessionManager.js:80`.
- **Gate 2b — empirical verification** (real `SessionManager` + real `node-pty`, profile command `sleep 300` standing in for the CLI binary; 5 sequential `create({profile:'generic', cols:120, rows:30.5})` calls):

  ```
  sleep procs before:                     1
  threw: RangeError Invalid array length   (x5)
  records in manager:                     0      <-- nothing tracked
  sleep procs after 5 bad requests:       6      <-- 5 orphans
  ```

  `new Session(...)` at `sessionManager.js:75` calls `pty.spawn` (`session.js:16`)
  and **succeeds** — node-pty accepts `rows: 30.5`. `new TerminalModel(...)` at
  `sessionManager.js:80` then throws `RangeError: Invalid array length` from
  xterm's buffer allocation. `this._records.set(...)` (`sessionManager.js:91`)
  is never reached, so the only reference to the live PTY is discarded. There
  is no `try/finally`, no `session.kill()` on the error path.
- **Gate 3 (new capability?)**: Yes. Baseline sessions are enumerable via `GET /api/sessions` (`httpApi.js:146`) and killable via `DELETE` (`httpApi.js:153` → `sessionManager.js:96`). These orphans are neither. The attacker gains **unbounded creation of hidden, non-reapable agentic-CLI child processes** — process-table/fork exhaustion plus persistent unaccounted CLI processes holding the operator's credentials, with no operator-visible trace and no API to clean them up. No baseline path produces an untracked child.
- **Entry Point**: `POST /api/sessions` (`httpApi.js:133`)
- **Data Flow**:
  1. `src/httpApi.js:134` → `b`
  2. `src/httpApi.js:137` → `manager.create(b)`
  3. `src/sessionManager.js:41` → `rows` destructured, unvalidated
  4. `src/sessionManager.js:75-79` → `new Session({..., rows: rows || p.rows, ...})` → `src/session.js:16` `pty.spawn(...)` — **child process created, `this._pty` held only by the local `session` binding**
  5. `src/sessionManager.js:80` → `new TerminalModel({..., rows: rows || p.rows, ...})` → `src/terminalModel.js:6` — **throws `RangeError`**
  6. `src/sessionManager.js:91` `this._records.set(...)` — **never executed**; `session` goes out of scope, child survives
  7. `src/httpApi.js:139-144` — `RangeError.code` is undefined, not in the allowlist → rethrown → `src/httpApi.js:200-202` → 500. No cleanup.
- **Root Cause**: The PTY child is spawned before the remaining (throwing) construction steps, and `SessionManager.create` has no `try/finally` to `kill()` the session when a later step fails.
- **Exploitability**: Trivial and repeatable. `for i in $(seq 200); do curl -d '{"rows":30.5}' ...; done` leaks 200 CLI processes. Same cross-site reachability note as VULN-001 (no `Origin`/`Sec-Fetch-Site` check).

---

### [VULN-003] No cap or TTL on concurrent bridge sessions (the façade has one; the bridge does not)
- **Input**: #26 `profile` / `POST /api/sessions` request itself
- **Class**: CWE-770 (allocation without limits) → CWE-400. Also matches the class file's *per-branch consistency* rule: two branches create sessions from the same `SessionManager`, only one enforces the invariant.
- **Severity**: Medium (repeated requests required; impact is process/memory exhaustion of the host, plus starvation of the façade's own capacity budget)
- **Location**: `/home/kali/repos/cosplai/src/sessionManager.js:39-93` (no capacity check) vs. `/home/kali/repos/cosplai/src/facade/router.js:51`
- **Gate 0 (intended behavior?)**: Creating sessions is intended; creating them **without bound** is not. The codebase itself declares the invariant — `config.js:225` defines `maxSessions: num(env.FACADE_MAX_SESSIONS, 8)` and `facade/router.js:51` enforces `if (pty.length < this._config.facade.maxSessions) return;` with an eviction/429 path. The bridge route reaches the same `SessionManager` and skips that gate entirely. A branch that skips a limit its sibling branch enforces is a finding, not a feature.
- **Gate 1 (reachable?)**: Two production callers of `SessionManager.create`: `httpApi.js:137` (uncapped) and `facade/router.js:67` (capped via `_ensureCapacity()` at `router.js:66`). Exhausting all callers as required: **1 of 2 callers omits the limit** → candidate stands.
- **Gate 2a (attacker-controlled?)**: Yes — the attacker controls how many `POST /api/sessions` requests they send, and `profile` selects which binary is spawned (`sessionManager.js:44-45`).
- **Gate 2b (sanitization?)**: `grep -rn "maxSessions|MAX_SESSIONS|_records.size"` over `src/` returns exactly two hits, both in the façade (`config.js:225`, `router.js:51`). `SessionManager` holds an unbounded `Map` (`sessionManager.js:40`) with no size check, no TTL, and no reaper — `remove` (`sessionManager.js:96`) is only ever called by explicit `DELETE`.
- **Gate 3 (new capability?)**: Yes. Each session is a real agentic-CLI child process (`session.js:16`) plus an xterm buffer with `scrollback: 5000` (`terminalModel.js:6`) plus a 256 KiB ring (`config.js:214`). N requests → N processes. Beyond the resource cost, the attacker **starves `facade/router.js:51`'s capacity accounting**: `_ensureCapacity` counts only `this._convs`, so bridge-created sessions consume host resources that the façade's budget never sees, and can drive the façade's own `_destroy` eviction of legitimate idle conversations. No baseline path gives a caller the ability to exceed the system's declared session budget.
- **Entry Point**: `POST /api/sessions` (`httpApi.js:133`)
- **Data Flow**: `src/httpApi.js:133` (route) → `src/httpApi.js:137` `manager.create(b)` → `src/sessionManager.js:75` `new Session(...)` → `src/session.js:16` `pty.spawn(...)` → `src/sessionManager.js:91` `this._records.set(session.id, record)` — unbounded `Map` growth, no eviction.
- **Root Cause**: The capacity invariant is enforced at the façade layer (`router.js:51`) instead of in `SessionManager.create`, so the sibling bridge route bypasses it.
- **Exploitability**: Straightforward loop. Compounds with VULN-001 (each session's footprint is attacker-sized) and VULN-002 (leaked sessions are not even counted).

---

### [VULN-004] Unbounded `keys[]` collection — no size constraint on a request-body array
- **Input**: #35 `keys[]` — HTTP body field of `POST /api/sessions/:id/key`
- **Class**: CWE-400 (uncontrolled resource consumption). Mandatory request-DTO-collection check from the class file: every collection-typed request-body field must have a size constraint.
- **Severity**: Medium (event-loop stall + PTY flood; bounded by the 1 MiB body cap, so not unbounded in bytes — but unbounded in iterations)
- **Location**: `/home/kali/repos/cosplai/src/httpApi.js:178`
- **Gate 0 (intended behavior?)**: Sending *a few* named keys is the feature. Sending ~250,000 in one request is not — a `maxItems` cap removes no functionality.
- **Gate 1 (reachable?)**: `httpApi.js:174-182`, reached from `server.js:26`. Production.
- **Gate 2a (attacker-controlled?)**: Yes. `httpApi.js:176` `readBodyOr413` → `b.keys` → iterated at `httpApi.js:178`. Raw body array.
- **Gate 2b (sanitization?)**: None. `for (const k of (b.keys || []))` — no `Array.isArray` check, no length check. The 1 MiB `MAX_BODY` (`httpApi.js:48,54`) is the *only* bound; `{"keys":["a","a",...]}` fits ~250k entries. Each iteration performs a synchronous `rec.session.write(...)` (`session.js:25` → `this._pty.write`), so the whole burst runs in one uninterrupted event-loop turn.
- **Gate 3 (new capability?)**: Yes — a single request that stalls the event loop (blocking *all* other sessions' state detection and SSE streams) and floods the target PTY with a quarter-million keystrokes. The baseline "send named key sequences" contemplates individual keys, not a bulk write amplifier. Note also that `b.keys` is not type-checked: a non-iterable (`{"keys":5}`) throws `TypeError` at `httpApi.js:178` → 500 via `httpApi.js:200`, and a string iterates per-character.
- **Entry Point**: `POST /api/sessions/:id/key` (`httpApi.js:174`)
- **Data Flow**: `src/httpApi.js:176` `readBodyOr413` → `b.keys` → `src/httpApi.js:178` `for (const k of (b.keys || [])) rec.session.write(rec.adapter.keySeq(k))` → `src/adapters/claude.js:96` (etc.) `keySeq` → `src/session.js:25` `this._pty.write(data)`
- **Root Cause**: No `maxItems`/length validation on a request-body collection, and no type check that it is an array.
- **Exploitability**: Single request, no race. Amplified per session (VULN-003 gives the attacker as many sessions as they want to hit in parallel).
- **Note (CROSS-CLASS, INJ)**: `keySeq` falls through to `String(name)` for any unrecognized key (`adapters/claude.js:97`, `codex.js:87`, `copilot.js:75`, `antigravity.js:62`, `generic.js:23`), so `keys` is an arbitrary-bytes write into the live PTY — see CROSS-CLASS section.

---

### [VULN-005] `POST /:id/key` bypasses the per-session serialization queue — concurrent write race with an in-flight prompt turn
- **Input**: #35 `keys[]` (racing #32 `text`)
- **Class**: CWE-362 (race condition / concurrent execution using shared resource without proper synchronization); check-then-act on `snapshotLineCount` / `renderLinesSince`
- **Severity**: Medium (response-integrity corruption of an AI coding CLI turn: the caller can be returned output that is not the answer to their prompt, and the CLI can be made to execute a caller-chosen menu selection during another turn)
- **Location**: `/home/kali/repos/cosplai/src/httpApi.js:178` (unqueued) vs. `/home/kali/repos/cosplai/src/httpApi.js:165` (queued)
- **Gate 0 (intended behavior?)**: No. The codebase declares the serialization invariant itself — `PromptQueue` exists (`src/promptQueue.js`) and `/prompt` uses it (`httpApi.js:165 rec.queue.enqueue(...)`). Gate 0 does not cover a synchronization control that one sibling branch simply skips.
- **Gate 1 (reachable?)**: Both routes are production (`server.js:26`). Both operate on the same `rec` from `manager.get(parts[2])` (`httpApi.js:150`).
- **Gate 2a (attacker-controlled?)**: Yes. Both the prompt text and the racing key sequence come from attacker request bodies, and the attacker controls request timing — no coordination with a victim is needed, since a single token holder (or a cross-site page with the token) can issue both.
- **Gate 2b (synchronization?)**: **Absent on the `/key` path.** `httpApi.js:165` wraps `sendPrompt` in `rec.queue.enqueue`; `httpApi.js:178` writes directly to `rec.session` with no `enqueue`, no lock, and no `rec.detector` interaction. It then `await`s an unqueued `setTimeout` (`httpApi.js:180`). `PromptQueue` (`promptQueue.js:3-7`) is a promise-chain serializer that only orders what is explicitly enqueued — it provides no mutual exclusion over `rec.session`.
- **Gate 3 (new capability?)**: Yes, affirmatively — this is a business-logic invariant violation, which the class file's LOG-specific Gate 3 rule says not to dismiss:
  1. `sendPrompt` captures `const before = record.terminalModel.snapshotLineCount()` (`httpApi.js:20`) and, after settle, returns `record.terminalModel.renderLinesSince(before)` (`httpApi.js:33`). A concurrent `/key` burst injects lines between the check and the read, so the returned `text`/`output` is attributed to the wrong turn — the caller receives content that is not the CLI's response to their prompt.
  2. `sendPrompt` calls `record.detector.markBusy()` (`httpApi.js:21,25`) to arm the settle window. An unqueued `/key` write emits `data`, re-arming quiescence (`stateDetector.js:45-54`) and shifting when the turn is judged settled — the attacker controls when another turn's `waitForSettle` resolves, and can force it to resolve on a mid-generation screen.
  3. Because `keySeq` falls through to `String(name)`, `/key` can deliver `enter`/digit selections into whatever dialog the *other* turn's agentic CLI is currently showing — i.e. answering a tool-permission or trust prompt that belongs to a different turn.
  None of this is achievable through the serialized `/prompt` path, which is the whole reason `PromptQueue` exists.
- **Entry Point**: `POST /api/sessions/:id/key` racing `POST /api/sessions/:id/prompt`
- **Data Flow**:
  - Turn A: `src/httpApi.js:165` `rec.queue.enqueue(() => sendPrompt(rec, {...}))` → `src/httpApi.js:20` `before = snapshotLineCount()` → `src/httpApi.js:22` `writeAndSubmitPrompt` → `src/httpApi.js:28` `await waitForSettle` → `src/httpApi.js:33` `renderLinesSince(before)`
  - Turn B (concurrent, unsynchronized): `src/httpApi.js:178` `rec.session.write(rec.adapter.keySeq(k))` → `src/session.js:25` `this._pty.write` → `src/session.js:21` `emit('data')` → `src/sessionManager.js:81` `terminalModel.write(d)` and `src/stateDetector.js:15` `_onData()` — both mutating state that Turn A's `before`/`waitForSettle` depend on.
- **Root Cause**: The `/key` handler writes to the shared PTY and terminal model without going through `rec.queue`, so the queue's serialization guarantee only covers one of the two write paths.
- **Exploitability**: Two overlapping HTTP requests, no precise timing needed — the prompt turn's settle window is typically seconds long, giving a wide race window.

---

### [VULN-006] `timeoutMs` accepts negative and >2³¹ values; large values silently invert into a ~1 ms timeout
- **Input**: #34 `timeoutMs` — HTTP body field of `POST /api/sessions/:id/prompt`
- **Class**: CWE-1284 (improper validation of specified quantity) / CWE-190-adjacent (32-bit truncation in the `setTimeout` sink)
- **Severity**: Low (degrades the shared session; does not cross a trust boundary on its own)
- **Location**: `/home/kali/repos/cosplai/src/httpApi.js:164` → `/home/kali/repos/cosplai/src/stateDetector.js:103`
- **Gate 0 (intended behavior?)**: A caller-chosen timeout is a legitimate feature (generic Gate 0 would normally clear it), **but** the failure mode here is not "the caller waits as long as they asked" — the value is silently transformed into its opposite by an integer limit in the sink, and the resulting failure sets persistent session state (`record.suspect`). That is a validation defect, not a feature.
- **Gate 1 (reachable?)**: `httpApi.js:164-165` → `sendPrompt` (`httpApi.js:12`) → `waitForSettle({ timeoutMs })` at `httpApi.js:17` and `httpApi.js:28` → `stateDetector.js:103` `setTimeout(..., timeoutMs)`. Production, `server.js:26`.
- **Gate 2a (attacker-controlled?)**: Yes — raw body field, `httpApi.js:160` → `b.timeoutMs`.
- **Gate 2b (sanitization?)**: Partial and insufficient. `Number.isFinite(b.timeoutMs)` (`httpApi.js:164`) rejects `NaN`, `Infinity`, strings and objects — but accepts **any negative number and any finite number above 2³¹−1**. No `Math.max(0, ...)`, no upper clamp.
- **Gate 2b — empirical verification** (Node v20, the runtime in this repo):

  ```
  setTimeout(fn, 1e12) -> TimeoutOverflowWarning: 1000000000000 does not fit
                          into a 32-bit signed integer. Timeout duration was
                          set to 1.   fired after 14 ms
  setTimeout(fn, -1)   -> fired after 14 ms
  ```

  So `{"timeoutMs": 1e12}` — which reads as "wait ~31 years" — actually times
  out in ~1 ms, and `{"timeoutMs": -1}` does the same.
- **Gate 3 (new capability?)**: Marginal but non-empty. The 1 ms timeout fires **after** `writeAndSubmitPrompt` has already typed and submitted the text into the live agentic CLI (`httpApi.js:22` precedes `httpApi.js:28`), so the turn is abandoned mid-generation and `record.suspect = true` is latched (`httpApi.js:30`). Every subsequent prompt on that session then first pays `await record.detector.waitForSettle({ timeoutMs })` at `httpApi.js:17` — with the *new* request's `timeoutMs`. A caller who repeats the malformed value keeps the session permanently in the suspect state while still driving the CLI. The attacker gets **fire-and-forget prompt injection into a running agentic CLI plus a latched degraded state on a shared session**, without the response-wait that the design assumes. This does not cross a trust boundary by itself, hence Low.
- **Entry Point**: `POST /api/sessions/:id/prompt` (`httpApi.js:158`)
- **Data Flow**: `src/httpApi.js:160` `readBodyOr413` → `src/httpApi.js:164` `Number.isFinite(b.timeoutMs) ? b.timeoutMs : config.promptTimeoutMs` → `src/httpApi.js:165` `sendPrompt(rec, { ..., timeoutMs })` → `src/httpApi.js:17` / `src/httpApi.js:28` `record.detector.waitForSettle({ timeoutMs })` → `src/stateDetector.js:103` `to = setTimeout(() => { cleanup(); reject(new Error('settle timeout')); }, timeoutMs)`
- **Root Cause**: `Number.isFinite` validates the *type* but not the *range*; the sink (`setTimeout`) truncates to a 32-bit signed integer and treats out-of-range and negative values as `1`.
- **Exploitability**: Single request. Low impact on its own.

---

### [VULN-007] SSE `/events` writes without backpressure — LLM-driven output buffered unboundedly for a stalled client
- **Input**: #45 (PTY output, LLM-influenced), driven by #32 `text`
- **Class**: CWE-400 (uncontrolled resource consumption)
- **Severity**: Low (requires the attacker to hold a stalled socket; memory grows at the child's output rate)
- **Location**: `/home/kali/repos/cosplai/src/httpApi.js:185-186`
- **Gate 0 (intended behavior?)**: Streaming output is the feature; ignoring the write-buffer signal is not.
- **Gate 1 (reachable?)**: `httpApi.js:183-191`, production via `server.js:26`.
- **Gate 2a (attacker-controlled?)**: Yes, on both ends — the attacker chooses the prompt that makes the CLI emit large output (`httpApi.js:165` → `promptWriter.js:31` → `session.js:25`) *and* is the SSE client that can stop reading. Second-order: child bytes → `session.js:21` `emit('data')` → SSE `onData`.
- **Gate 2b (sanitization?)**: None. `const onData = (d) => res.write(...)` (`httpApi.js:185`) discards `res.write`'s boolean return value; there is no `drain` handling, no `res.writableLength` check, and no cap on the number of concurrent `/events` subscribers per session. (The ring buffer at `session.js:19-20` *is* capped at `ringBytes`, so the ring itself is safe — the leak is in the HTTP write queue.) Listener cleanup on `req.on('close')` (`httpApi.js:189`) is correct and does not mitigate a socket that stays open but unread.
- **Gate 3 (new capability?)**: The attacker converts a slow/stalled TCP receive window into unbounded Node heap growth on the server, without needing the geometry trick of VULN-001. Modest incremental capability over VULN-001/003; recorded at Low.
- **Entry Point**: `GET /api/sessions/:id/events` (`httpApi.js:183`)
- **Data Flow**: `src/session.js:17` `this._pty.onData` → `src/session.js:21` `this.emit('data', d)` → `src/httpApi.js:187` `rec.session.on('data', onData)` → `src/httpApi.js:185` `res.write(...)` (return value ignored)
- **Root Cause**: Backpressure signal from `res.write` is discarded, and there is no subscriber cap.
- **Exploitability**: Requires the attacker to keep a socket open and not read it — easy, but slower than VULN-001.

---

## CROSS-CLASS

- **CROSS-CLASS (#27, `src/session.js:16`, suspected NAV/INJ)** — `cwd` flows `httpApi.js:134` → `sessionManager.js:41` → `sessionManager.js:76` (`cwd: cwd || p.cwd`) → `session.js:16` `pty.spawn(..., { cwd })` with **zero validation** — no `path.resolve` containment, no allowlist, no `existsSync` check. The caller chooses the working directory of an agentic AI CLI running with the operator's ambient credentials. Not a LOG sink; routing to NAV/INJ.
- **CROSS-CLASS (#35, `src/httpApi.js:178`, suspected INJ)** — `rec.adapter.keySeq(k)` returns `String(name)` verbatim for any key not in the adapter's `KEYS` table (`adapters/claude.js:96-98`, `codex.js:86-88`, `copilot.js:74-76`, `antigravity.js:61-63`, `generic.js:22-24`), so `keys` is an **arbitrary control-byte write into the live PTY** (e.g. bracketed-paste sequences, `\x03`, cursor/OSC sequences). It also bypasses `promptWriter.writePromptText`'s multiline handling and `MultilineUnsupportedError` gate (`promptWriter.js:9-18`). Byte-for-byte equivalent capability to #32 for a *quiescent* session (so Gate 3 is weak in isolation), but it is the mechanism that makes VULN-005 exploitable. Routing to INJ for the escape-sequence/prompt-injection analysis.
- **CROSS-CLASS (#31, `src/httpApi.js:150`, suspected NAV)** — `manager.get(parts[2])` is an existence check only; `sessionManager.js:82-86` records no owner, so there is no per-resource authorization on `GET`/`DELETE`/`/prompt`/`/key`/`/events`. Already stated in the partition threat model; recorded here for completeness.
- **CROSS-CLASS (`src/httpApi.js:127`, suspected NAV)** — `if (facade && facade.canHandle(...)) return facade.handle(...)` executes **before** the bridge token gate at `httpApi.js:129`. Façade routes therefore never see `checkToken`. Routing to NAV.

## SAFE / NO-MATCH (with reasons)

- **#26 `profile` — prototype-key lookup: SAFE.** `c.profiles[name]` (`sessionManager.js:44`) indexes a plain (frozen) object built at `config.js:107`, so inherited keys resolve: `profile: "__proto__"` → `Object.prototype`, `"constructor"` → `Object`, `"toString"` → a function — all truthy, so the `if (!p)` guard at `sessionManager.js:45` is bypassed. Verified this does **not** escalate: every inherited value has `mode === undefined`, so `p.mode !== 'pty'` at `sessionManager.js:51` throws `PROFILE_NOT_PTY` → 400 (`httpApi.js:140`). No inherited property can yield `mode === 'pty'` with a `command`. This is a read-only lookup — no merge, assign, or recursive-write reaches `__proto__`, so **no prototype pollution (CWE-1321)**. `manager._records` is a `Map` (`sessionManager.js:40`), immune by construction; `config.profiles[rec.profile]` (`httpApi.js:179`) uses the already-validated `rec.profile`. Recorded as a hardening note (`Object.create(null)` or `hasOwnProperty` guard at `sessionManager.js:44`), not a finding.
- **#30 — NO-MATCH.** `GET /api/sessions` (`httpApi.js:146`) takes no input and maps over an in-memory list. No LOG sink.
- **#31 — SAFE for LOG.** `manager.get(parts[2])` is `Map.get` (`sessionManager.js:94`); no prototype exposure, no allocation sized by the id, no cache. Session ids are `crypto.randomUUID()` (`session.js:8`) — CSPRNG, unguessable, so no ID-prediction issue. (NAV concern routed above.)
- **#32 `text` — SAFE for LOG.** Bounded by `MAX_BODY = 1024*1024` (`httpApi.js:48`) enforced at `httpApi.js:54`, which correctly drains rather than destroys the socket. No LOG-class allocation is sized by it. (INJ concern routed above; it also feeds VULN-005/VULN-007.)
- **#33 `submit` — NO-MATCH.** `b.submit !== false` (`httpApi.js:165`) coerces to boolean and reaches only the `if (!submit) return;` branch at `promptWriter.js:29`. No LOG sink.
- **#45 — partially SAFE.** The scrollback ring is correctly capped: `session.js:20` truncates to `ringBytes` on every chunk. Adapter marker regexes (`adapters/*.js`) were reviewed for catastrophic backtracking — **no nested quantifiers and no overlapping alternation**; the only mildly quadratic patterns are `.*X.*Y` forms (`codex.js:46`, `copilot.js:45`), which are benign at sane `cols` and are folded into VULN-001 as an amplifier. The remaining #45 issue is the SSE write path (VULN-007).

## Crypto review (class-group sweep — no findings)

- `src/auth.js:3-9` `checkToken` — `crypto.timingSafeEqual` with an explicit pre-check on `typeof` and length. Constant-time comparison is correct. **SAFE.**
- `src/config.js:91` — token default is `crypto.randomBytes(24).toString('base64url')` (192 bits, CSPRNG). No hardcoded secret. **SAFE.**
- `src/session.js:8` — `crypto.randomUUID()` for session ids (CSPRNG v4). **SAFE.**
- No `Math.random`, no MD5/SHA1-for-security, no DES/RC4, no `rejectUnauthorized: false` / `NODE_TLS_REJECT_UNAUTHORIZED` / `verify=False` anywhere in the traced scope.
- Non-LOG note (routed to NAV): `extractToken` (`auth.js:14-16`) accepts the token from the **query string**, so a correct constant-time comparison still leaks the secret to access logs, `Referer`, and browser history.

## Absent-input analysis (mandatory pass — no LOG-class CVB)

Re-checked every assigned input for fail-open behavior when omitted:

| Omitted input | Behavior | Verdict |
|---|---|---|
| bridge token | `checkToken(null, ...)` → `typeof null !== 'string'` → `false` (`auth.js:4`) → 401 (`httpApi.js:129`) | **fails closed** |
| `b.text` | `typeof b.text !== 'string'` → 400 (`httpApi.js:162`) | fails closed |
| `b.keys` | `(b.keys \|\| [])` → empty loop, 200 (`httpApi.js:178`) | no security check skipped |
| `b.timeoutMs` | falls back to `config.promptTimeoutMs` (`httpApi.js:164`) | safe default |
| `cols`/`rows` | fall back to `p.cols`/`p.rows` (`sessionManager.js:78,80`) | safe default |
| `profile` | falls back to `c.defaultProfile` (`sessionManager.js:43`), validated at boot to be pty-mode with a command (`config.js:194-199`) | fails closed |
| `cwd` | falls back to `p.cwd` (`sessionManager.js:76`) | safe default |
| `submit` | `b.submit !== false` → `true` | safe default |

No conditional-validation-bypass in this class group. The one adjacent fail-open
is the `facade`-before-token ordering at `httpApi.js:127`, routed to NAV above.

## Notes

- **`readBody` swallows JSON parse errors** (`httpApi.js:67`: `try { resolve(d ? JSON.parse(d) : {}) } catch { resolve({}) }`), where the façade rejects with 400 (`facade/shared.js:74`). Traced to disposition: a malformed body to `POST /api/sessions` silently creates a **default-profile** session instead of erroring. **Eliminated at Gate 3** — the caller can already achieve the identical outcome by posting `{}`, so no new capability. Recorded as a robustness/consistency defect, not a vulnerability.
- **Adjacent to VULN-001, outside this partition's input list:** `wsApi.js:53` calls `rec.terminalModel.resize(m.cols, m.rows)` from a WebSocket message. `Session.resize` wraps its `_pty.resize` in `try/catch` (`session.js:26`), but `TerminalModel.resize` (`terminalModel.js:10`) is **unguarded** — a non-integer `cols`/`rows` throws out of the WS message handler. Same missing-geometry-validation root cause as VULN-001/002; flagged for whichever partition owns the WS inputs.
