# SG-3 — NAV trace results (WebSocket terminal)

Class group: CSRF, IDOR, auth bypass, conditional validation bypass, identity
spoofing, confused deputy, security signal spoofing, mass assignment, parameter
pollution.

Files read: `src/wsApi.js`, `src/sessionManager.js`, `src/session.js`,
`src/terminalModel.js`, `src/auth.js`, `src/httpApi.js`.

## Disposition summary

| # | Input | Disposition |
|---|---|---|
| 36 | `session` query param (`wsApi.js:11`) | **CANDIDATE** — VULN-301 (CWE-639 IDOR) |
| 37 | `profile` query param (`wsApi.js:13,15,27-32`) | **SAFE** — see below |
| 38 | WS message `raw` → `session.write` (`wsApi.js:52-54`) | **CANDIDATE** — VULN-302 (CWE-1385 CSWSH); direct write by token holder is DESIGN-INTENT |
| 39 | WS message `m.cols`/`m.rows` (`wsApi.js:53`) | **CROSS-CLASS** (LOG/DoS) — `wsApi.js:53` |
| — | Structural audit of `attachWss` handlers | **CANDIDATE** — VULN-303 (CWE-862) |

---

#### [VULN-301] `?session=` attaches to ANY live session with no ownership check (IDOR)
- **Input**: #36 — WS upgrade query param `session`
- **Class**: CWE-639: Authorization Bypass Through User-Controlled Key
- **Severity**: High
- **Location**: `/home/kali/repos/cosplai/src/wsApi.js:11-12`, consumed at `:37,46,48,54`
- **Gate 0 (intended behavior?)**: Re-attachment to one's *own* session is the
  feature. Attaching to a session created by a *different* connection is not
  gated by anything. Per NAV Gate-0 exemption for CWE-639 and per the partition's
  own Gate-3 baseline ("hijacking or colliding with another live session" is
  explicitly NOT in the baseline), not dismissible.
- **Gate 1 (reachable?)**: Production. `attachWss` is the sole `/ws` upgrade
  handler; `manager.get(providedSid)` at `wsApi.js:12` is the only lookup. No
  test-only guard.
- **Gate 2a (attacker-controlled?)**: Fully. Raw query string of the upgrade URL,
  parsed at `wsApi.js:7,11`. No transformation.
- **Gate 2b (sanitization?)**: None. The only check upstream is
  `checkToken(extractToken(req), config.token)` (`wsApi.js:8` →
  `auth.js:3-9`), a `timingSafeEqual` against a *single shared secret*. That
  proves possession of a secret, not identity, and performs **no per-session
  authorization**. There is no owner field on the session record
  (`sessionManager.js:82-86` — `{id, session, terminalModel, adapter, queue,
  createdAt, profile, dialogPolicy}`; no principal/owner), so ownership cannot
  be checked even in principle.
- **Gate 3 (new capability?)**: Concretely, the attacker gets: (1) full
  **scrollback replay** of another connection's session — `ws.send(rec.session.
  scrollback())` at `wsApi.js:46` returns up to `ringBytes` of prior PTY output
  (`session.js:28`), i.e. another operator's AI-CLI transcript, file contents,
  and any secrets echoed there; (2) a **live output tap** via the `data`
  listener (`wsApi.js:47-48`); (3) **write access to another session's PTY**
  (`wsApi.js:54`), interleaving keystrokes into a REPL someone else is driving.
  Session IDs are `crypto.randomUUID()` (`session.js:8`) but are **enumerated
  wholesale** by `GET /api/sessions`, which returns `{id, state, createdAt,
  profile}` for every record (`httpApi.js:146-147`), so the ID is not a secret
  guarding this — no additional privilege is needed beyond the same bridge token.
- **Entry Point**: `GET /ws?token=…&session=<id>` (HTTP upgrade)
- **Data Flow**: upgrade URL → `new URL(req.url)` `wsApi.js:7` →
  `u.searchParams.get('session')` `wsApi.js:11` → `manager.get(providedSid)`
  `wsApi.js:12` → `sessionManager.js:94` `this._records.get(id)` → `existing`
  used as `rec` `wsApi.js:37` → `rec.session.scrollback()` `wsApi.js:46` /
  `rec.session.on('data')` `wsApi.js:48` / `rec.session.write(s)` `wsApi.js:54`
  → `session.js:25` `this._pty.write(data)`.
- **Root Cause**: Session records carry no owner/principal, and the upgrade
  handler treats "holds the shared token" as authorization for *every* session
  ID. Resource-ID Gate step (a) fails outright.
- **Exploitability**: Single request. `GET /api/sessions` (`httpApi.js:146`) to
  list IDs, then `wss://host/ws?token=T&session=<victim-id>`. Immediate
  scrollback dump on connect.

#### [VULN-302] No `Origin` validation on the `/ws` upgrade (cross-site WebSocket hijacking)
- **Input**: #38 — WS message stream (`wsApi.js:51-55`), reachable from any web origin
- **Class**: CWE-1385: Missing Origin Validation in WebSockets (CSRF family, CWE-352)
- **Severity**: Medium
- **Location**: `/home/kali/repos/cosplai/src/wsApi.js:6-34` (upgrade handler)
- **Gate 0 (intended behavior?)**: No. The bridge ships a first-party UI
  (`public/index.html`) that is the intended WS client; serving arbitrary
  third-party origins is not a designed feature. Gate 0 also does not apply to a
  missing security check.
- **Gate 1 (reachable?)**: Production — the only upgrade path.
  `grep -rni "origin|csrf" src/` → **zero hits**; no `verifyClient`, no
  `handleProtocols`, no origin allowlist anywhere in `src/`.
- **Gate 2a (attacker-controlled?)**: The connecting origin is attacker-chosen.
  WebSocket handshakes are exempt from the same-origin policy and from the
  page's own CSP; the server's `connect-src 'self'` header
  (`httpApi.js:92-102`) constrains only the bridge's *own* page, never an
  attacker's page.
- **Gate 2b (sanitization?)**: The only handshake check is the token
  (`wsApi.js:8`). The token is not a cookie, so this is not a pure zero-knowledge
  CSRF — but the token is carried **in the query string** for WS
  (`auth.js:14-16`), so it lands in browser history, `Referer`, and process
  listings, and is printed to stdout at boot. Any script running in the
  operator's browser (extension, XSS on another localhost port, a page that
  reads history/an open UI tab's URL) obtains it and can then connect from an
  arbitrary origin. `Sec-WebSocket-Protocol`/header-based auth is never required.
- **Gate 3 (new capability?)**: A remote web page gains a bidirectional channel
  into a local interactive AI-CLI PTY: it can write arbitrary bytes including
  control sequences (`wsApi.js:54` → `session.js:25`), and read all PTY output
  including live scrollback (`wsApi.js:46-48`) back out to the attacker's
  origin. Neither the localhost bind nor the CSP prevents this; a browser can
  always open a WS to `127.0.0.1`. This is not in the Gate-3 baseline (partition
  explicitly lists "reaching any of this from a cross-origin web page without
  the operator's intent" as out of baseline).
- **Entry Point**: `GET /ws` upgrade + `/ws` message handler
- **Data Flow**: attacker page `new WebSocket('ws://127.0.0.1:PORT/ws?token=T')`
  → `server.on('upgrade')` `wsApi.js:6` → token-only check `wsApi.js:8` → no
  origin check → `wss.handleUpgrade` `wsApi.js:34` → `ws.on('message')`
  `wsApi.js:51` → `rec.session.write(s)` `wsApi.js:54` → `session.js:25`.
- **Root Cause**: The upgrade handler authenticates the *credential* but never
  authenticates the *requesting origin*, and the credential travels in a URL
  that browsers persist.
- **Exploitability**: Requires the attacker to learn the token; realistic given
  it is a boot-time stdout print and a permanent query-string component of the
  UI URL. Chains directly with VULN-301 for cross-session read.

#### [VULN-303] No per-session authorization helper exists or is invoked on the WS path (CWE-862)
- **Input**: structural audit of `attachWss` vs. sibling handlers
- **Class**: CWE-862: Missing Authorization
- **Severity**: High
- **Location**: `/home/kali/repos/cosplai/src/wsApi.js:34-61`;
  `/home/kali/repos/cosplai/src/sessionManager.js:94`
- **Gate 0**: Not applicable — a missing authorization check is never design intent.
- **Gate 1 (reachable?)**: Production; `manager.get` is called from `wsApi.js:12`
  and `httpApi.js:150`, both production.
- **Gate 2a**: N/A — structural absence.
- **Gate 2b**: `grep` for authorization helpers (`can*`, `has*Permission`,
  `check*Access`, `require*Role`, `authorize*`) across `src/` returns only
  `checkToken` (`auth.js:3`), a credential comparison. **No authorization layer
  exists at all** — `SessionManager.get(id)` (`sessionManager.js:94`) is a bare
  `Map.get` with no caller argument, so every consumer (`wsApi.js:12`,
  `httpApi.js:150`) is structurally incapable of enforcing per-session authz.
- **Gate 3 (new capability?)**: Same outcome set as VULN-301, but reported
  separately per the class-file rule that CWE-862 must not be subsumed into a
  co-located CWE-639: the fix differs. VULN-301 is fixed by binding a session to
  its creating connection; VULN-303 is fixed by introducing an ownership/
  principal model that `SessionManager.get` and both callers consult. Also
  covered by the Gate-3 exemption for all-NONE auth baselines.
- **Entry Point**: `GET /ws`, and by extension `GET/POST/DELETE /api/sessions/:id`
- **Data Flow**: n/a (absence finding).
- **Root Cause**: The threat model assumes one principal per shared token, so no
  principal is ever recorded on a session record (`sessionManager.js:82-86`).
  Any multi-tab/multi-agent use, or any token leak, collapses the boundary.
- **Exploitability**: Trivially exercised via VULN-301's PoC.

---

## SAFE

**#37 — `profile` query param → raw `socket.write` 400 response (`wsApi.js:13-18,25-33`).**
Evaluated specifically for HTTP response splitting / header injection, which is
the shape the partition data flags (S17). The attacker-controlled `profileParam`
reaches `socket.write` only inside `msg`, and `msg` is embedded via
`JSON.stringify({ error: msg, ... })` at `wsApi.js:15`. `JSON.stringify` escapes
`\r` → `\r` and `\n` → `\n` as two-character literals per ECMA-262 QuoteJSONString,
so no raw CRLF can reach the byte stream and the header block cannot be
terminated early. The value is placed only in the **body**, after the `\r\n\r\n`
separator — never in a header name or value. `content-length` is computed from
the already-escaped body with `Buffer.byteLength` (`wsApi.js:15-16`), so the
framing stays consistent and no smuggled second response is possible.
Content-type is a fixed `application/json` literal, so the reflection is not
rendered as HTML. Reflection of the caller's own input back to the caller in a
pre-upgrade 400 is not a cross-boundary leak. `Object.keys(config.profiles)` is
server-controlled (`config.js` BUILTIN_PROFILES), not attacker input.
`profileParam` also flows to `manager.create({profile})` (`wsApi.js:37` →
`sessionManager.js:41-49`), where it is used only as a **lookup key into the
server-defined `config.profiles` map** — an unknown key throws `UNKNOWN_PROFILE`
rather than selecting anything. Per Authorization-Scope Selection: the set of
selectable profiles is entirely operator-defined at boot and every entry is
equally available to the single principal, so no per-value authorization
boundary is crossed. SAFE for NAV.

## CROSS-CLASS

**CROSS-CLASS (input #39, `/home/kali/repos/cosplai/src/wsApi.js:53`, suspected
class: LOG — resource exhaustion / DoS, CWE-1284 improper validation of
specified quantity).** `m.cols`/`m.rows` come straight from
`JSON.parse(raw.toString())` with **no type, range, or integer check**, and reach
two sinks: `rec.session.resize(m.cols, m.rows)` → `session.js:26` →
`this._pty.resize()` (wrapped in try/catch, so it degrades quietly), and
`rec.terminalModel.resize(m.cols, m.rows)` → `terminalModel.js:10` →
`@xterm/headless` `Terminal.resize()`, which allocates buffer rows/columns
proportional to the requested geometry. A single `{"type":"resize","cols":
1e9,"rows":1e9}` message drives an unbounded allocation in-process. Note the
resize calls sit inside the `try { … } catch { /* fallthrough */ }` at
`wsApi.js:53`, so a throw is swallowed and the message falls through to
`rec.session.write(s)` — no crash, but also no rejection and no error surfaced
to the client. Not a NAV sink (no authorization or identity boundary is crossed);
routing to the LOG/availability partition.

## Absent-input analysis (mandatory)

| Omitted input | Behavior | Verdict |
|---|---|---|
| `token` (both header and query) | `extractToken` returns `null` (`auth.js:16`); `checkToken` rejects non-strings (`auth.js:4`) → `401` + `socket.destroy()` (`wsApi.js:9`). | **Fails closed.** Not a CVB. |
| `Authorization` header only | Falls back to `?token=` (`auth.js:14-15`); if neither present → `null` → 401. | **Fails closed.** Not a CVB. |
| `session` | `providedSid` falsy → `existing = null` → a *new* session is created (`wsApi.js:12,37`). No security check is skipped. | Not a CVB. |
| `profile` | `effective = config.defaultProfile` (`wsApi.js:26`), still validated by the same `!p / mode / command` chain (`wsApi.js:27-32`). | Not a CVB. |
| `session` present ⇒ profile pre-validation block skipped (`wsApi.js:25`) | This is *input* validation, not a security check; an unknown sid still falls back to `manager.create({})`, which re-validates inside `sessionManager.js:45-62` and closes the socket with 1011 on throw (`wsApi.js:42`). No authorization decision is bypassed. | Not a CVB. |
| Message not starting with `{` | Skips the JSON/resize branch and writes raw to the PTY (`wsApi.js:52-54`) — the designed passthrough. | Not a CVB. |

No companion-input pattern found: the token check at `wsApi.js:8` is
unconditional and runs before every other branch in the handler.

## Mass Assignment (Request Body Gate) — not applicable to this partition

The `/ws` path deserializes only `{type, cols, rows}` (`wsApi.js:53`) and reads
`m.type` against a literal, so there is no DTO whose fields are copied into a
persistence model. `manager.create` is called from `wsApi.js:37` with a
hand-built `{profile}` object only — the WS path never forwards a caller-supplied
object into `SessionManager.create`'s `{profile, cwd, cols, rows}` destructure.
(By contrast `httpApi.js:137` passes the parsed body `b` straight into
`manager.create(b)`, reaching `cwd` at `sessionManager.js:76`; that entry point
belongs to another partition and is noted here only as a pointer.)

## Confused deputy / identity spoofing / security-signal spoofing

No outbound HTTP calls, no identity or security-signal headers are constructed
anywhere in the WS path. `src/session.js` spawns a local PTY inheriting
`process.env` minus `envScrub` (`session.js:13-16`); no caller-supplied value
reaches an identity assertion. **NO-MATCH** for these subclasses.
