# SG-3 — LOG trace results (WebSocket terminal, inputs #36-39)

Class group: Race conditions, cache isolation, credential scope, resource
exhaustion, prototype pollution, crypto, integer overflow.

Files read: `src/wsApi.js`, `src/sessionManager.js`, `src/session.js`,
`src/terminalModel.js`, `src/auth.js`, `src/server.js`, `src/config.js`,
`src/facade/router.js`.

## Disposition table

| # | Input | Disposition |
|---|---|---|
| 36 | `?session=` (WS query) | **CROSS-CLASS** (NAV, CWE-639) + contributes to **VULN-LOG-002**; TOCTOU sub-path → SAFE |
| 37 | `?profile=` (WS query, raw `socket.write` 400) | **SAFE** (JSON.stringify neutralizes CR/LF) + contributes to **VULN-LOG-002** |
| 38 | raw WS message → `session.write` | **CROSS-CLASS** (INJ, `wsApi.js:54`) — no LOG-class sink |
| 39 | `m.cols` / `m.rows` (resize) | **CANDIDATE — VULN-LOG-001** (CWE-400/CWE-1284) |

---

## [VULN-LOG-001] Unvalidated `resize` cols/rows → unbounded allocation, OOM of the whole bridge

- **Input**: #39 — WS JSON message `{"type":"resize","cols":N,"rows":M}`
- **Class**: CWE-400 Uncontrolled Resource Consumption (via CWE-1284 improper validation of a quantity)
- **Severity**: **High**
- **Location**: `/home/kali/repos/cosplai/src/wsApi.js:53` → `/home/kali/repos/cosplai/src/terminalModel.js:10`

**Gate 0 (intended behavior?)** — Terminal resize is an intended feature, but the
designed purpose is to match a client viewport (tens–hundreds of cells). Accepting
a 5,000,000-column geometry is not a feature; there is no code path in the repo
that requires unbounded dimensions. Gate 0 does not exempt.

**Gate 1 (reachable?)** — `attachWss` is called unconditionally at
`/home/kali/repos/cosplai/src/server.js:27`; the message handler is registered for
every accepted `/ws` upgrade (`wsApi.js:51`). 1 production call site, no dev guard.

**Gate 2a (attacker-controlled?)** — `m` is `JSON.parse(raw.toString())` of the raw
WebSocket frame (`wsApi.js:52-53`). `m.cols`/`m.rows` are passed straight through.
Origin is the network client. Additionally, `wsApi.js:6-33` performs **no `Origin`
validation** on the upgrade, so any web page that learns the shared bridge token
(printed to stdout at `server.js:29`, and carried in the query string per
`auth.js:14-16`) can drive this.

**Gate 2b (sanitization?)** — **None.** Empirically verified, not assumed:
- `Session.resize` (`session.js:26`) has its own `try/catch`, so a node-pty rejection
  is swallowed and execution continues to the xterm call.
- `TerminalModel.resize` (`terminalModel.js:10`) calls `Terminal.resize(cols, rows)`
  directly. The only guard inside `@xterm/headless` is an integer type check
  (`"This API only accepts integers"` — confirmed to fire for `'a'`/`undefined`);
  **magnitude is not bounded.**
- The enclosing `try { ... } catch { /* fallthrough */ }` at `wsApi.js:53` catches
  the type error, but cannot catch heap exhaustion.

Measured against the repo's own `@xterm/headless`:

```
new Terminal({cols:80,rows:24,scrollback:5000})   → RSS  55 MB
  .resize(1000000, 24)                            → RSS 372 MB
  .resize(80, 200000)                             → RSS 365 MB
  .resize(5000000, 24)                            → RSS 1621 MB   (single call)
```

`--max-old-space-size=512` did **not** contain it — xterm's cell buffers are
allocated outside the V8 old space, so the process grows past the heap cap until
the OS OOM-killer or allocation failure ends it.

**Gate 3 (new capability?)** — The SG-3 baseline grants a token holder the ability
to write to, read scrollback from, and resize **their own** session. It does **not**
include terminating the bridge process. A single ~40-byte WS frame allocates >1.6 GB;
two or three frames (or one larger `cols`) OOM-kill `node`, which destroys **every**
live PTY session in `SessionManager._records` — including sessions belonging to the
facade (`src/facade/router.js`) and to other operators/clients — and loses their
scrollback and in-flight `PromptQueue` work. That is a cross-session outcome the
attacker cannot reach from the baseline. No existing path in the repo lets a `/ws`
client kill the parent process (`Session.kill` at `session.js:27` kills only the
child PTY). Not eliminated.

**Entry Point**: `GET /ws` upgrade, then the `/ws` message stream.

**Data Flow**
1. `src/wsApi.js:51` — `ws.on('message', raw => ...)`
2. `src/wsApi.js:52` — `const s = raw.toString()`
3. `src/wsApi.js:53` — `const m = JSON.parse(s)`; `m.type === 'resize'`
4. `src/wsApi.js:53` — `rec.session.resize(m.cols, m.rows)` → `src/session.js:26` → `node-pty` (throw swallowed)
5. `src/wsApi.js:53` — `rec.terminalModel.resize(m.cols, m.rows)` → `src/terminalModel.js:10`
6. `src/terminalModel.js:10` — `this._term.resize(cols, rows)` → `@xterm/headless` buffer reallocation (**sink**)

**PoC sketch**
```js
const ws = new WebSocket('ws://127.0.0.1:PORT/ws?token=<bridge-token>');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'resize', cols: 50000000, rows: 30 }));
});
// server RSS climbs into the GBs and the node process is OOM-killed;
// all other live PTY sessions die with it.
```

**Root Cause**: `m.cols`/`m.rows` are forwarded from an untrusted WebSocket frame to
an allocating terminal-geometry API with no range clamp (no min/max, no integer
sanity bound), and the only surrounding defense is a `try/catch` that cannot
intercept memory exhaustion.

**Fix direction**: clamp before use, e.g.
`const clamp=(v,lo,hi)=>Number.isInteger(v)?Math.min(hi,Math.max(lo,v)):null;` with
`cols` in `[1, 1000]` and `rows` in `[1, 1000]`; drop the message when either is
`null` rather than falling through to `session.write(s)`.

**Exploitability**: Trivial — one authenticated WS frame, no race, no timing, no
user interaction. Amplified by the absent `Origin` check on the upgrade
(`wsApi.js:6-33`), which makes a cross-origin browser page a viable delivery vector
once it holds the shared token.

---

## [VULN-LOG-002] Unbounded session (PTY child-process) creation over `/ws` — the `maxSessions` cap is not applied

- **Input**: #36 (`?session=` absent or naming an unknown id) and #37 (`?profile=`)
- **Class**: CWE-400 Uncontrolled Resource Consumption (process/FD/memory exhaustion)
- **Severity**: **Medium**
- **Location**: `/home/kali/repos/cosplai/src/wsApi.js:37` → `/home/kali/repos/cosplai/src/sessionManager.js:41-93` → `/home/kali/repos/cosplai/src/session.js:16`

**Gate 0 (intended behavior?)** — Creating a session on connect is intended; creating
an *unbounded number* of them is not. The codebase demonstrates the opposite intent
for the sibling path: `src/config.js:225` defines `facade.maxSessions` (default 8)
and `src/facade/router.js:51` (`_ensureCapacity`) enforces it before
`this._manager.create(...)` at `router.js:~68`. `SessionManager.create` itself
(`sessionManager.js:41`) has **no** cap, and `wsApi.js:37` calls it directly, so the
`/ws` path bypasses the only capacity control in the repo. A cap that exists on one
branch and is absent on a parallel branch is a finding, not a design choice.

**Gate 1 (reachable?)** — `wsApi.js:37` runs inside the `handleUpgrade` callback for
every `/ws` connection; `attachWss` is wired unconditionally at `server.js:27`.
Production-reachable.

**Gate 2a (attacker-controlled?)** — The attacker controls the number of `/ws`
connections and, per connection, whether `?session=` is present. Two paths reach
`create`:
- no `?session=` → `manager.create({ profile: profileParam })` (`wsApi.js:37`);
- `?session=<unknown-id>` → `existing` is `null` (`wsApi.js:12`), so `create({})`
  runs with the **default profile** — and note this path also skips the pre-upgrade
  profile validation, which is guarded by `if (!providedSid)` at `wsApi.js:25`.

**Gate 2b (sanitization?)** — None. `SessionManager._records` is a plain `Map`
(`sessionManager.js:40`) with no size check anywhere in `create` (lines 41-93).
Each successful `create` performs `pty.spawn` (`session.js:16`), allocating a child
process, a PTY master FD pair, a 256 KB ring buffer (`config.js:214`), and an
`@xterm/headless` Terminal with 5000 lines of scrollback (`config.js:213`), plus a
`StateDetector` and `PromptQueue`.

**Gate 3 (new capability?)** — Baseline: a token holder may create *a* session and
work in it. New capability: hold N concurrent `/ws` sockets and force N concurrent
AI-CLI child processes, exhausting PIDs/FDs/RAM on the host and denying service to
the facade's own pool — the facade's `_ensureCapacity` counts only `this._convs`
(`router.js:50`), so `/ws`-created records are invisible to it and cannot be
reclaimed by its idle-eviction. The attacker also drives the ambient credentials of
each spawned CLI. Not achievable from the baseline, which assumes the cap applies.

**Entry Point**: `GET /ws` upgrade.

**Data Flow**
1. `src/wsApi.js:11-12` — `providedSid` read; `existing = providedSid ? manager.get(providedSid) : null`
2. `src/wsApi.js:25-33` — profile pre-validation, **skipped entirely when `?session=` is present**
3. `src/wsApi.js:37` — `manager.create(...)` (no capacity check on this path)
4. `src/sessionManager.js:75-79` — `new Session({...})`
5. `src/session.js:16` — `pty.spawn(command, args, {...})` (**sink**)

**Root Cause**: The session-capacity invariant is enforced in the facade router
rather than in `SessionManager.create`, so the second creator (`wsApi.js:37`) is
unbounded.

**Fix direction**: move the cap into `SessionManager.create` (reject with a coded
error past `maxSessions`) so both creators inherit it, and apply the profile
pre-validation regardless of whether `?session=` was supplied.

**Exploitability**: Straightforward but requires many concurrent connections and the
shared token; sockets are cleaned on `close` (`wsApi.js:56-60`, `ownedByWs` true for
both create paths), so the attacker must hold the connections open.

---

## SAFE / CROSS-CLASS dispositions

### #37 — `?profile=` echoed into a raw `socket.write` 400 response — **SAFE**
`wsApi.js:14-18`. The parameter reaches the response only inside `msg`, which is
embedded via `JSON.stringify({ error: msg, ... })` at `wsApi.js:15`. Verified
empirically rather than assumed: with `profile = 'x\r\nHTTP/1.1 200 OK\r\n\r\n<script>'`,
`JSON.stringify` emits `\r` and `\n` as the two-character escapes `\\r`/`\\n` —
`/[\r\n]/.test(body)` is `false`. No attacker byte reaches the status line or the
header block, and `content-length` is computed as `Buffer.byteLength(body)` at
`wsApi.js:16` from the *final* body, so it stays consistent for multi-byte input.
Response splitting / header injection is not achievable. (Sanitizer-sink match: the
sink is an HTTP message framing context whose dangerous characters are CR and LF;
JSON string escaping neutralizes exactly those. Match confirmed.)
- *CROSS-CLASS note*: the response-splitting shape belongs to INJ; recorded here as
  SAFE so INJ need not re-derive it, but the disposition is theirs to confirm.

### #38 — raw WS message → `session.write` — **CROSS-CLASS (INJ)**
`wsApi.js:54` writes arbitrary attacker bytes (including terminal control sequences)
into the PTY of an interactive AI REPL, with no content filtering. This is a
command/control-sequence injection sink, not a LOG-class sink.
- **CROSS-CLASS (input #38, `src/wsApi.js:54`, suspected class: INJ)**
- No LOG-class sink on this path: the bytes land in `Session.write` (`session.js:25`)
  and the ring buffer (`session.js:19-20`), which is hard-capped at `ringBytes`
  (`session.js:20`, default 262144 from `config.js:214`) — the `Buffer.concat` is
  O(n) per chunk but bounded, so no unbounded-allocation finding here.

### #36 — `?session=` attaches to any live session — **CROSS-CLASS (NAV)**
`wsApi.js:11-12,37`. `manager.get(providedSid)` performs no ownership or scope check
before the connection is bound to an existing record and begins receiving its `data`
events (`wsApi.js:46-48`) and writing to it (`wsApi.js:54`). Session ids are
`crypto.randomUUID()` (`session.js:8`), so they are unguessable — but they are
handed to clients and appear in the HTTP API, making this a classic missing
object-level authorization check rather than a LOG-class issue.
- **CROSS-CLASS (input #36, `src/wsApi.js:11-12`, suspected class: NAV, CWE-639)**

### #36 — TOCTOU between `manager.get` and the upgrade callback — **SAFE (no new capability)**
`existing` is resolved synchronously at `wsApi.js:12`, but it is consumed inside the
asynchronous `wss.handleUpgrade` callback at `wsApi.js:37`. A concurrent
`ws.on('close')` handler (`wsApi.js:59`) can call `manager.remove(rec.id)`
(`sessionManager.js:96`) in that window, which kills the PTY and deletes the map
entry while the new connection still holds the stale `rec`. This is a genuine
check-then-act window, but the resulting state is a *zombie attachment*: `alive` is
`false`, so `Session.write` (`session.js:25`) and `Session.resize` (`session.js:26`)
become no-ops, `scrollback()` returns bytes the attacher was already entitled to
read via the same `?session=` id one tick earlier, and `ownedByWs` is `false` so no
second `remove`/`kill` occurs. **Gate 3 eliminates**: the attacker gains no data,
privilege, or invariant violation they did not already have from winning the race —
only a retained reference to a dead record. Recorded for completeness; not a finding.

---

## Absent-input analysis (mandatory)

| Omitted input | Behavior | Verdict |
|---|---|---|
| `token` (Authorization header **and** `?token=`) | `extractToken` returns `null` (`auth.js:17`); `checkToken` returns `false` on the `typeof provided !== 'string'` guard (`auth.js:4`) → `401` + `socket.destroy()` (`wsApi.js:9`) | **Fails closed** — no CVB |
| `?session=` | Falls through to the create path; profile pre-validation at `wsApi.js:25-33` **does** run | Fails closed for profile validation |
| `?profile=` | `effective = config.defaultProfile` (`wsApi.js:26`), still validated | Fails closed |
| `?session=` **present but unknown** | `existing = null`, so the `if (!providedSid)` guard at `wsApi.js:25` is **skipped** and `manager.create({})` runs unvalidated | Validation bypass — but the throw is contained by the `try/catch` at `wsApi.js:38-44` (`ws.close(1011, ...)`), so no crash. Folded into **VULN-LOG-002** rather than a separate CVB |
| `Origin` header | **Never read anywhere in `wsApi.js:6-33`** — the upgrade is accepted regardless of origin | **CROSS-CLASS (NAV/INJ, `src/wsApi.js:6-33`, cross-site WebSocket hijacking, CWE-1385)**. Not a LOG-class sink, but it is the delivery vector that raises VULN-LOG-001's practical severity |
| `m.type` / `m.cols` / `m.rows` in a `{`-prefixed message | `JSON.parse` succeeds but `m.type !== 'resize'`, or `resize` throws on non-integers → `catch` falls through to `rec.session.write(s)` (`wsApi.js:54`), sending the raw JSON to the PTY | Not a security-check bypass; the fall-through belongs to #38's INJ surface |

## Classes checked and not found

- **Prototype pollution (CWE-1321)**: `JSON.parse` output (`wsApi.js:53`) is only
  property-read (`m.type`, `m.cols`, `m.rows`); no recursive merge/extend/assign,
  no `lodash.merge`, no computed-key writes anywhere in the traced files.
- **Crypto**: the only crypto in scope is `crypto.randomUUID()` (`session.js:8`,
  CSPRNG) and `crypto.timingSafeEqual` (`auth.js:8`). No weak algorithms, no
  hardcoded keys, no disabled TLS validation in the traced files. Note for the auth
  reviewer: `auth.js:6` returns early on length mismatch, which is a token-*length*
  oracle — outside SG-3's input scope, not claimed here.
- **Integer overflow (CWE-190)**: no arithmetic is performed on `m.cols`/`m.rows`
  before the sink; they are passed through unmodified. The issue is magnitude
  (VULN-LOG-001), not wraparound.
- **Deserialization**: `JSON.parse` only — no pickle/YAML/object reconstruction.
- **ReDoS**: the only regexes in scope are `/-/g` (`sessionManager.js:7`, literal,
  applied to a config-derived profile name) and `/\s+$/` (`terminalModel.js:18,27`,
  applied to rendered line text). Neither has nested quantifiers or overlapping
  alternation; `/\s+$/` is a single quantifier with a linear anchor. No catastrophic
  backtracking.
- **Cache/state isolation**: `SessionManager._records` is keyed on
  `crypto.randomUUID()` (`session.js:8`, `sessionManager.js:91`) — full-entropy,
  no concatenation, no collision surface, no TTL/revocation window.
- **Credential/policy scope**: no IAM policies, scoped tokens, or OAuth scopes are
  generated on any `/ws` path.
