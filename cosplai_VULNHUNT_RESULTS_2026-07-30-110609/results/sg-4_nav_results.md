# SG-4 — NAV trace results (static serving & transport hardening)

**Class group:** CSRF, IDOR, auth bypass, conditional validation bypass, identity
spoofing, confused deputy, security signal spoofing, mass assignment, parameter
pollution.

**Target:** `/home/kali/repos/cosplai` @ `fce99bd` (branch `chore/repo-hardening`).

---

## ⚠ RECON DRIFT — read this before consuming any disposition below

`sg-4_data.md` describes a `src/httpApi.js` of ~262 lines containing
`applySecurityHeaders`, `isSecureRequest`, `SHELL_CSP`, `BRIDGE_TRUST_PROXY`,
HSTS, `referrer-policy: no-referrer`, `x-frame-options`, and a
`content-security-policy` header on the shell response.

**None of that code exists in the checked-out tree.** Verified:

```
$ wc -l src/httpApi.js                       -> 204
$ grep -c isSecureRequest src/httpApi.js     -> 0
$ grep -rn "setHeader|x-forwarded|content-security|frame-options|referrer-policy|Origin|Sec-Fetch" src/ bin/
                                             -> (no matches)
$ grep -rn trustProxy . --exclude-dir=node_modules
                                             -> (no matches)
```

That hardening lives on a **different, unmerged branch**:

```
$ git branch -a --contains 4dc607b
  security/drop-docker-and-scan-findings
  remotes/origin/security/drop-docker-and-scan-findings
$ git rev-parse --abbrev-ref HEAD -> chore/repo-hardening   (does NOT contain it)
```

All dispositions below are traced against the **checked-out tree**, which is the
authoritative audit target. Consequences: input **#2 does not exist**, and the
mitigations the partition data credits (`referrer-policy: no-referrer` for the
query-string token, CSP `frame-ancestors 'none'`) are **absent**, so findings the
recon pre-mitigated are live here.

---

## Dispositions — assigned inputs

| # | Input | Disposition |
|---|---|---|
| 1 | `u.pathname` → vendor path resolution (`httpApi.js:117-121`) | **SAFE** — containment empirically verified |
| 2 | `x-forwarded-proto` (`httpApi.js:111` per recon) | **NO-MATCH** — header is not read anywhere in the tree |
| 3 | `authorization` header (`auth.js:12`) | **CANDIDATE** ×1 (VULN-403) |
| 4 | `token` query param (`auth.js:15`) | **CANDIDATE** ×2 (VULN-402, VULN-403) |
| G1 | vendor path-containment gate (`httpApi.js:119`) | **SAFE** |
| G2 | facade route-ordering gate (`httpApi.js:127`) | **SAFE** — facade re-authenticates |
| G3 | `checkToken` (`auth.js:3-9`) | **CANDIDATE** (VULN-403); no null-bypass |

Plus two structural NAV findings discovered by the mandatory absent-input /
state-changing-endpoint audit: **VULN-401** (CSRF) and **VULN-404** (clickjacking).

---

### #1 / G1 — `u.pathname` → `path.resolve(PUBLIC, '.' + u.pathname)` — **SAFE**

`httpApi.js:117-121`

```js
if (req.method === 'GET' && u.pathname.startsWith('/vendor/')) {
  const f = path.resolve(PUBLIC, `.${u.pathname}`);
  if (f !== VENDOR && !f.startsWith(VENDOR + path.sep)) return json(res, 403, {...});
```

**Resource ID Gate (CWE-639) applied.** `u.pathname` is a resource selector read
pre-authentication, so it must clear the gate.

(a) There is no per-caller ownership check — but the selected resource set is
bounded to `public/vendor/`, which holds only committed third-party assets
(`xterm.js`, `xterm.css`, `addon-fit.js`). These are not scoped to any principal,
so per the Missing-Auth Assessment ("returns public information not scoped to any
principal") this is not a CWE-306/639 finding.

(b) No downstream call, no credential forwarding — N/A.

Containment verified **empirically**, not from memory (11 payloads, run under
Node against the real `PUBLIC`/`VENDOR` values):

| payload | `u.pathname` | escapes? |
|---|---|---|
| `/vendor/../index.html` | `/index.html` | no — prefix check fails, falls to auth gate |
| `/vendor/%2e%2e/index.html` | `/index.html` | no — WHATWG URL normalizes `%2e%2e` as a double-dot segment |
| `/vendor/./../index.html` | `/index.html` | no |
| `//vendor/../index.html` | `/index.html` | no |
| `/vendor\../index.html` | `/index.html` | no — `\` → `/` for special schemes |
| `/vendor/..%2f..%2fetc/passwd` | unchanged | no — `%2f` stays encoded; literal filename inside vendor |
| `/vendor/%2e%2e%2f%2e%2e%2fetc/passwd` | unchanged | no — same |
| `/vendor/%00../index.html` | unchanged | no — `%00` is not a real NUL to `path.resolve` |
| `/vendor/.../index.html` | unchanged | no |
| `/vendor//../index.html` | `/vendor/index.html` | no — still inside VENDOR |

Every allowed resolution landed inside `VENDOR`. Combination of WHATWG dot-segment
normalization (which runs *before* `startsWith('/vendor/')`) and the post-`resolve`
`startsWith(VENDOR + path.sep)` check is sound on POSIX.

**Symlink note (recon's CANDIDATE, not reproduced):** `fs.promises.stat`
(`httpApi.js:91`) does follow symlinks and there is no `realpath`, so a symlink
inside `public/vendor/` would be followed out of the sandbox. However Gate 2a
fails: `public/vendor/` contains three regular files and no symlinks
(`ls -la public/vendor/`), it is a committed directory, and the partition threat
model states the attacker does not control the operator's filesystem. There is no
attacker-reachable write path into `public/vendor/` anywhere in the codebase
(`scripts/pin-clis.mjs` writes to `<repo>/vendor/`, a *different* directory that
is never served). Recorded as a latent hardening gap (add `fs.promises.realpath`
before the containment check), not a NAV candidate.

**Windows note:** `path.sep` is `\` on Win32 and WHATWG URL already folds `\`→`/`,
so the non-POSIX concern the recon raised does not materialize either.

---

### #2 — `x-forwarded-proto` — **NO-MATCH**

The header is never read. `grep -rn "x-forwarded" src/ bin/` returns nothing;
`isSecureRequest`, `applySecurityHeaders`, `config.trustProxy` and
`BRIDGE_TRUST_PROXY` do not exist in this tree. No sink of any class. The
`flag()`-treats-unknown-strings-as-true observation (`config.js:17`) is real but
has no `BRIDGE_TRUST_PROXY` consumer to feed.

*(On branch `security/drop-docker-and-scan-findings` this input would be live; if
that branch is the intended target, re-run this input.)*

---

### G2 — facade route ordering — **SAFE**

`httpApi.js:127` dispatches to the facade **before** the bridge token gate at
`:129`. Traced into the facade: `src/facade/index.js:39-48` performs its own
`checkToken(token, config.token)` against the **same** `config.token`, and every
route in the table (`GET /v1/models`, `POST /v1/chat/completions`,
`POST /v1/responses`, `POST /v1/messages`) is dispatched through that single
`handle()` chokepoint (`index.js:40`). There is no facade route that reaches a
handler without the check. The pre-gate dispatch is therefore not an auth bypass —
it is a 401-shaping decision.

Path-variant probes fail **closed**, not open: `canHandle` matches
`` `${method} ${pathname}` `` against a `Map`, so `/v1/messages/` (trailing slash)
and `/V1/messages` (case) miss the table and fall through to the *stricter* bridge
gate at `:129` → 401. Correct direction.

The `x-api-key` alternative (`index.js:42-44`) is a second credential *channel*,
not a second credential — the value is still `checkToken`'d against `config.token`.
Not a weaker-credential auth branch.

---

## Candidates

### [VULN-401] No CSRF defense on any state-changing endpoint

- **Input**: #4 (`token` query param, `src/auth.js:15`) — the query-string token
  branch is what makes the forgery mechanically possible
- **Class**: CWE-352 (Cross-Site Request Forgery), with CWE-1275 / CWE-346 (no
  `Origin` / `Sec-Fetch-Site` / `Host` validation) as the underlying gap
- **Severity**: **Medium**
- **Location**: `src/httpApi.js:133` (`POST /api/sessions`), `:153`
  (`DELETE /api/sessions/:id`), `:158` (`POST /api/sessions/:id/prompt`), `:174`
  (`POST /api/sessions/:id/key`); `src/facade/index.js:25,29,33`
  (`POST /v1/chat/completions`, `/v1/responses`, `/v1/messages`)
- **Gate 0 (intended behavior?)**: Not exempt. The class file's exemption is
  "endpoints that accept JSON-only bodies **with strict Content-Type checking**."
  `readBody` (`httpApi.js:49-71`) never inspects `content-type` — it `JSON.parse`s
  whatever bytes arrive and, on parse failure, **resolves `{}`** (`:67`) rather
  than erroring. A cross-origin `<form enctype="text/plain">` therefore reaches
  every handler with an attacker-chosen body. No exemption applies.
- **Gate 1 (reachable?)**: All seven routes are the application's production API
  surface, registered unconditionally in `createHttpServer` (facade routes gated
  only on `config.facade.*` toggles). Not dead code.
- **Gate 2a (attacker-controlled?)**: The victim's browser issues the request;
  the attacker controls method, path, body, and — critically — the **query
  string**, which is where `extractToken` (`auth.js:14-15`) looks for the
  credential. A cross-site page cannot set an `Authorization` header, but it
  *can* put `?token=…` in a form `action` or `fetch` URL. The token branch in
  `extractToken` converts an otherwise header-bound credential into an
  ambient-authority one for forgery purposes.
- **Gate 2b (sanitization?)**: **No defense exists at any layer.**
  `grep -rn "Origin|Sec-Fetch|req.headers.host|csrf" src/ bin/` → zero matches.
  No CSRF token, no `SameSite` cookie (no cookies at all), no `Origin` allowlist,
  no `Host` allowlist, no `Content-Type` enforcement. The `referrer-policy` and
  CSP `form-action 'none'` headers the recon credited **do not exist in this tree**
  (see Recon Drift). Per the shared rules I may not credit an unverified upstream
  defense, and there is none to verify.
- **Gate 2b (secondary — does the token itself defend?)**: Partially. Unknown
  `config.token` blocks blind forgery. But (i) the token is 24 random bytes only
  when `BRIDGE_TOKEN` is unset (`config.js:91`) — an operator-supplied
  `BRIDGE_TOKEN` may be trivially guessable, and there is **no rate limiting on
  `checkToken`** anywhere, so a hostile page can grind candidates from the
  victim's browser with `mode:'no-cors'`; and (ii) the token is routinely placed
  in URLs by design (`public/index.html:9` reads `?token=`), so it reaches browser
  history, shell history, and proxy logs — see VULN-402. VULN-401 is the payload
  for a token learned via VULN-402.
- **Gate 3 (new capability?)**: **Yes — network position.** The server binds
  `127.0.0.1:7681` by default (`config.js:200-201`). A remote attacker holding the
  token still cannot reach loopback. A malicious page loaded by the operator's
  browser *can*, and each forged request drives a real PTY:
  `POST /api/sessions` spawns a CLI child process; `POST /api/sessions/:id/prompt`
  types attacker text into it (`httpApi.js:165` → `sendPrompt` →
  `writeAndSubmitPrompt`); `POST /api/sessions/:id/key` writes raw key sequences
  into the PTY (`:178`). That is remote-attacker → local-agent command execution,
  an outcome unavailable without the CSRF. Not eliminable under Gate 3.
- **Entry Point**: any state-changing HTTP route; simplest PoC is
  `POST /api/sessions?token=…` from an off-origin page.
- **Data Flow**: attacker page → victim browser cross-origin `fetch`/form POST →
  `httpApi.js:112` handler → `extractToken(req)` reads `?token=`
  (`auth.js:14-15`) → `checkToken` passes (`httpApi.js:129`) → no origin check →
  `readBody` accepts any Content-Type (`httpApi.js:49-71`) → `manager.create(b)`
  (`:137`) / `rec.session.write(...)` (`:178`).
- **Root Cause**: State-changing routes rely solely on a bearer token that
  `extractToken` also accepts from the URL query string, with no origin, referer,
  Host, or Content-Type validation to distinguish a same-origin call from a
  cross-site one.
- **Exploitability**: Conditional on token knowledge. Trivial once VULN-402
  leaks it; otherwise blocked by 192-bit entropy on a default install, and
  materially easier against a weak operator-set `BRIDGE_TOKEN` given the absent
  rate limiting. Also worth noting: with no `Host` validation, DNS rebinding gives
  a hostile page **same-origin read** access to the loopback listener, upgrading
  blind forgery to full request/response interaction.

---

### [VULN-402] Bridge token accepted from — and by design placed in — the URL query string

- **Input**: #4 (`token` query param, `src/auth.js:15`)
- **Class**: CWE-598 (use of GET/query string with sensitive data), enabling
  CWE-522 / CWE-352
- **Severity**: **Medium**
- **Location**: `src/auth.js:14-15`; consumed by `src/httpApi.js:129` and
  `src/facade/index.js:41`; produced by `public/index.html:9,16,19`
- **Gate 0 (intended behavior?)**: The query-string branch is deliberate — the
  browser shell has no other way to pass the credential to `new WebSocket(...)`
  (`index.html:19`), since the WebSocket API cannot set request headers. But
  Gate 0's exemption covers *feature parameters*, and the class file is explicit
  that Gate 0 does not shield a credential-handling weakness. The recon itself
  treated this as needing mitigation (`referrer-policy: no-referrer`) — that
  mitigation is absent here, so the accepted risk is unmitigated.
- **Gate 1 (reachable?)**: `extractToken` has 2 production call sites
  (`httpApi.js:129`, `facade/index.js:41`) plus the WS path; `index.html:9`
  actively depends on the query form. Live.
- **Gate 2a (attacker-controlled?)**: The attacker does not control the token
  value; they control whether the *exposure surfaces* are reachable. The exposure
  is created by the application placing a long-lived credential into a URL.
- **Gate 2b (sanitization?)**: **None.** The compensating control the recon
  credited — `referrer-policy: no-referrer` at `httpApi.js:135` — **does not
  exist in this tree** (verified: zero `setHeader` calls in `src/`). With no
  referrer policy, the default (`strict-origin-when-cross-origin`) applies; a
  same-origin subresource request from `/?token=X` sends the **full URL including
  the token** in `Referer`. `public/index.html:2,5,6` issues three same-origin
  subresource loads from exactly that page. Any future off-origin resource,
  redirect, or user-followed link leaks the credential outright. There is also no
  CSP `form-action`/`base-uri` in this tree to constrain where the page can send
  data.
- **Gate 3 (new capability?)**: Yes. A token in the URL persists in browser
  history, the shell's own history if launched via `curl`/`open`, reverse-proxy
  and CDN access logs, and `Referer`. Any party reading those logs — who has no
  API access at all — obtains a credential granting full PTY control, and can
  spend it via VULN-401 from the victim's browser. Nothing else in the codebase
  grants that.
- **Entry Point**: `GET /?token=…` (`httpApi.js:195`), and every route via
  `extractToken`.
- **Data Flow**: `config.token` (`config.js:91`) → operator pastes
  `http://127.0.0.1:7681/?token=…` → `httpApi.js:195` serves the shell →
  `index.html:9` `params.get('token')` → `index.html:16,19` re-embeds it in the
  WebSocket URL query → concurrently the browser sends `Referer: …?token=…` on
  `index.html:2,5,6` subresource loads (no referrer-policy to suppress it).
- **Root Cause**: A long-lived, non-expiring bearer credential is transported in
  the URL, and the response headers that would contain the resulting leakage
  (`referrer-policy`, CSP) are not emitted.
- **Exploitability**: No active exploitation needed — passive collection from
  logs/history. Highest-value fix in this partition: emit
  `referrer-policy: no-referrer`, and prefer a short-lived one-time handoff
  ticket for the WebSocket rather than the master token.

---

### [VULN-403] `checkToken` length short-circuit defeats the constant-time comparison

- **Input**: #3 (`authorization` header, `auth.js:12`) and #4 (`token` query
  param, `auth.js:15`)
- **Class**: CWE-208 (observable timing discrepancy) / CWE-203 (observable
  behavioral discrepancy)
- **Severity**: **Low**
- **Location**: `src/auth.js:7`
- **Gate 0 (intended behavior?)**: No — the function's entire purpose is
  constant-time credential comparison (`crypto.timingSafeEqual`, `:8`). A branch
  that leaks a credential property before reaching it is a defect in the defense,
  not a feature. Gate 0 explicitly does not apply to a security check being
  weakened.
- **Gate 1 (reachable?)**: 3 production call sites — `httpApi.js:129`,
  `facade/index.js:45`, plus the WS path. Live on every request.
- **Gate 2a (attacker-controlled?)**: Fully. Any unauthenticated party reaching
  the socket submits arbitrary-length candidates via `Authorization: Bearer …` or
  `?token=…`, unlimited — there is **no rate limiting or lockout** on failed
  attempts anywhere in the codebase.
- **Gate 2b (sanitization?)**: `timingSafeEqual` at `:8` is the correct primitive,
  but `:7` returns **before** it whenever lengths differ. Node's `timingSafeEqual`
  throws on unequal-length buffers, so the guard is necessary — the flaw is that
  it is unpadded. The fix is to hash both sides to a fixed width (e.g. compare
  `sha256(provided)` vs `sha256(expected)`) so every comparison is the same length.
- **Gate 3 (new capability?)**: Marginal but real. The attacker learns the
  **byte length** of `config.token`, which is not otherwise disclosed. That
  distinguishes a default install (24 random bytes → 32 base64url chars,
  `config.js:91`) from a short operator-set `BRIDGE_TOKEN`, letting an attacker
  decide whether brute force is worth attempting and bound the keyspace. Given
  no rate limiting, that targeting information has practical value. It does not
  by itself yield the token.
- **Entry Point**: every route — `httpApi.js:129`, `facade/index.js:45`.
- **Data Flow**: `authorization` / `?token=` → `extractToken` (`auth.js:11-17`) →
  `checkToken(provided, expected)` (`auth.js:3`) → `a.length !== b.length` early
  return (`auth.js:7`), bypassing `timingSafeEqual` (`auth.js:8`).
- **Root Cause**: The length guard required by `timingSafeEqual`'s contract was
  implemented as an early return rather than by normalizing both inputs to a
  fixed length first.
- **Exploitability**: Requires many samples over a noisy network; trivial over
  loopback. Low impact in isolation; it is a precondition-improver for brute force
  rather than a break.

**Null-bypass explicitly ruled out (G3):** `extractToken` returns `null` on a
missing or malformed header (`auth.js:16`), and `checkToken(null, …)` hits the
`typeof provided !== 'string'` guard at `:4` and returns `false`. Fails closed. A
non-`Bearer ` prefix (`:13`) falls through to the query branch rather than being
accepted. Confirmed no bypass.

---

### [VULN-404] Shell page has no framing or content-security policy

- **Input**: #3/#4 (the authenticated shell response at `httpApi.js:196`); raised
  by the mandatory absent-input / response-header audit
- **Class**: CWE-1021 (improper restriction of rendered UI layers) / CWE-693
  (protection mechanism failure)
- **Severity**: **Low**
- **Location**: `src/httpApi.js:196` (`sendFile(res, …, 'text/html')` with no
  extra headers); `sendFile` at `:85-107` accepts no header argument at all
- **Gate 0 (intended behavior?)**: No. The absence of a protection mechanism is
  not a feature; the parallel branch on
  `security/drop-docker-and-scan-findings` adds exactly these headers, confirming
  they were intended.
- **Gate 1 (reachable?)**: `GET /` and `GET /index.html` are the primary UI
  entry points (`httpApi.js:195`). Live.
- **Gate 2a (attacker-controlled?)**: The attacker controls a page that frames
  the shell origin. Note framing succeeds regardless of the token — the frame
  loads whatever the victim's browser is authorized for.
- **Gate 2b (sanitization?)**: **None.** No `x-frame-options`, no CSP
  `frame-ancestors`, no CSP at all — `sendFile` (`:85`) sets only `content-type`
  (`:105`). Verified by zero `setHeader` matches across `src/`.
- **Gate 3 (new capability?)**: The framed page is an interactive terminal wired
  to a live PTY (`index.html:21-25`): `term.onData(d => ws.send(d))` forwards
  every keystroke. A clickjacking or keystroke-redirection overlay against a
  framed, already-authenticated shell reaches a command interpreter — an outcome
  a cross-origin page cannot otherwise obtain. The absent CSP additionally
  removes the `connect-src 'self'` backstop on the WebSocket URL the page
  assembles from `location.host` at `index.html:19`.
- **Entry Point**: `GET /` / `GET /index.html` (`httpApi.js:195-197`).
- **Data Flow**: attacker page `<iframe src="http://127.0.0.1:7681/?token=…">` →
  `httpApi.js:196` → `sendFile` emits only `content-type` (`:105`) → browser
  renders framed → `index.html:23` relays keystrokes into the PTY.
- **Root Cause**: `sendFile` has no mechanism for response headers beyond
  `content-type`, and no security-header middleware runs on any response.
- **Exploitability**: Requires the victim to visit a hostile page while holding a
  valid session URL, plus UI-redressing interaction. Low on its own; compounds
  VULN-401 and VULN-402 (all three are fixed by the same missing header layer).

---

## Absent-input analysis (mandatory) — no Conditional Validation Bypass found

Attacker controls which inputs are sent, so each was tested by omission:

| Omitted input | Code path | Result |
|---|---|---|
| `authorization` header | `auth.js:12` → falsy → falls to query branch `:14` | continues; no skip |
| both `authorization` and `?token=` | `auth.js:16` returns `null` → `checkToken` `:4` returns `false` | **fails closed** → 401 (`httpApi.js:129`) |
| `authorization` present but not `Bearer `-prefixed | `auth.js:13` false → query branch | **fails closed** |
| `?token=` present but empty | `p.get('token')` falsy (`auth.js:15`) → `null` | **fails closed** |
| `x-api-key` omitted on anthropic facade route | `facade/index.js:42` guard false → `token` stays `null` → `checkToken` false | **fails closed** |
| request body omitted entirely | `readBody` `:67` resolves `{}` | reaches handler with empty object — **not a security-check skip**; see cross-class note |

No security-critical block in this partition is gated on the mere *presence* of an
input. There is no companion-input pattern (no credential used unconditionally
whose validation is conditioned on a second input). The one `if (present)` shape —
`facade/index.js:42` — only *adds* a credential channel and still routes through
`checkToken`. **No CVB candidate.**

---

## Authorization-helper coverage audit (mandatory structural check)

Comparing auth invocations across every handler in `createHttpServer`:

| Handler | Auth |
|---|---|
| `GET /vendor/*` (`:117`) | none — **exempt**: public static assets, not principal-scoped |
| facade routes (`:127`) | `checkToken` at `facade/index.js:45` |
| `POST/GET /api/sessions` (`:133`,`:146`) | `checkToken` at `:129` |
| `GET/DELETE /api/sessions/:id` (`:152`,`:153`) | `checkToken` at `:129` |
| `POST …/prompt` (`:158`), `POST …/key` (`:174`), `GET …/events` (`:183`) | `checkToken` at `:129` |
| `GET /`, `GET /index.html` (`:195`) | `checkToken` at `:129` |

`checkToken` at `httpApi.js:129` is a single **chokepoint** — every handler below
it is unconditionally covered, and the facade branch above it has its own
equivalent chokepoint. **No handler lacks an auth call while a sibling has one.**
No CWE-862 gap.

**IDOR on `parts[2]` (session id, `httpApi.js:149-150`) — SAFE, and out of
partition.** Resource ID Gate: there is no ownership check binding a session to a
caller, but the deployment has exactly **one** principal — a single global
`config.token` (`config.js:91`) with no user records, no accounts, and no
per-session ownership field anywhere. Every holder of the token is the same
principal, so there is no cross-principal boundary to cross. Noted for the
partition that owns session-id inputs, in case a multi-token model is ever added.

---

## Cross-class / out-of-partition observations

- **CROSS-CLASS (NAV — CWE-915, out of my input set):** `POST /api/sessions` at
  `httpApi.js:137` passes the **entire unfiltered request body** straight into
  `manager.create(b)`. No field is extracted, overridden, stripped, or
  allowlisted at the handler. Whichever partition owns that body input must run
  the Request Body Gate against `manager.create` — the handler side provides
  zero field-level filtering, so every field `manager.create` honors is
  caller-controlled.
- **CROSS-CLASS (INJ):** `httpApi.js:178`
  `rec.session.write(rec.adapter.keySeq(k))` writes caller-supplied key names
  into a live PTY, and `:165` `sendPrompt(rec, { text: b.text })` writes
  caller-supplied text. Terminal/control-sequence injection — INJ class, not mine.
- **Hardening, not a candidate:** add `fs.promises.realpath` before the
  containment check at `httpApi.js:119` (see #1 symlink note).
- **Hardening, not a candidate:** no rate limiting or lockout on `checkToken`
  failures on any route. Not independently exploitable against a 192-bit default
  token, but it is the multiplier behind VULN-401's brute-force variant and
  VULN-403's length oracle.

---

## Summary

**4 candidates:** VULN-401 (CWE-352, Medium), VULN-402 (CWE-598, Medium),
VULN-403 (CWE-208, Low), VULN-404 (CWE-1021, Low).
**Safe:** #1/G1 (path containment empirically proven), G2 (facade
re-authenticates), G3 null-bypass.
**No-match:** #2 (`x-forwarded-proto` is not read in this tree).
**No CVB.** **No authorization-helper coverage gap.**

VULN-401, -402 and -404 share one root cause: **this branch emits no security
response headers and performs no origin validation**, and it pairs that with a
credential that travels in the URL. All three are largely closed by the header
layer already written on `security/drop-docker-and-scan-findings` — which is the
single most useful action here. Phase 2b should first confirm which branch is the
intended audit target.
