# SG-4 — LOG class-group trace results

**Partition:** SG-4 (Static serving & transport hardening)
**Class group:** LOG (race conditions, cache isolation, credential scope,
resource exhaustion, prototype pollution, crypto, integer overflow)
**Repo root:** `/home/kali/repos/cosplai`

---

## ⚠ Recon drift notice (affects input #2 and several cited line numbers)

The partition data file (and `phase1_output.md`) cite `src/httpApi.js:92-102`
(`SHELL_CSP`), `:108-139` (`applySecurityHeaders` / `isSecureRequest` /
`x-forwarded-proto` / `referrer-policy`), `:135`, `:147`, `:156`, `:168-186`,
`:252`. **None of these exist in the checked-out source.**

Verified:

```
$ grep -rn "applySecurityHeaders|isSecureRequest|x-forwarded-proto|SHELL_CSP|BRIDGE_TRUST_PROXY|referrer-policy" src/ public/
(no matches — hits occur only inside the VULNHUNT results directory itself)
```

`src/httpApi.js` is 204 lines. `createHttpServer` begins at :111 and the whole
request handler is :112-203. There is **no security-header path, no CSP, no
`x-forwarded-proto` trust, and no `BRIDGE_TRUST_PROXY` consumer** anywhere in
`src/`. The recon appears to have been performed against the *design spec*
(`docs/`, commit `fce99bd "docs: design spec for public-repo hardening"`) rather
than the implementation.

Actual line mapping used below:
| Recon cite | Actual |
|---|---|
| `httpApi.js:171,175` (`u.pathname`, vendor) | `httpApi.js:114,117,118` |
| `httpApi.js:176` (G1 containment) | `httpApi.js:119` |
| `httpApi.js:184-186` (G2 route order) | `httpApi.js:127,129` |
| `httpApi.js:111` (`x-forwarded-proto`) | **does not exist** |
| `auth.js:12,15,3-9` | correct as cited |

---

## Dispositions

| # | Input | Disposition |
|---|---|---|
| 1 | `u.pathname` → vendor path (`httpApi.js:114,117,118`) | **CROSS-CLASS** (NAV) + SAFE for all LOG sinks |
| 2 | `x-forwarded-proto` | **NO-MATCH** — the reading code does not exist (see drift notice) |
| 3 | `authorization` header (`auth.js:12`) | **CANDIDATE** ×2 (VULN-L01, VULN-L02) |
| 4 | `token` query param (`auth.js:15`) | **CANDIDATE** (same sink as #3) + CROSS-CLASS (NAV/INJ, CWE-598) |
| G1 | `f` containment gate (`httpApi.js:119`) | **CROSS-CLASS** (NAV) — SAFE for LOG (see below) |
| G2 | route ordering (`httpApi.js:127`) | **SAFE** — recon note is incorrect; facade self-authenticates |
| G3 | `provided` vs `expected` (`auth.js:3-9`) | **CANDIDATE** → VULN-L01 |

---

## Input #1 — vendor URL path — LOG analysis

Full LOG sink sweep of the `/vendor/*` path:

1. **Race / TOCTOU (`sendFile`, `httpApi.js:90-106`).** There *is* a genuine
   stat-then-open TOCTOU: `fs.promises.stat(file)` at :91 and
   `fs.createReadStream(file)` at :100 are separate syscalls on the same path.
   The code acknowledges it in the comment at :96-99 and handles the *crash*
   consequence (`headersSent` guard, deferred `writeHead(200)` on `'open'`).
   **SAFE for LOG:** winning this race requires the attacker to mutate the
   operator's filesystem between the two calls. Per the partition threat model
   the attacker does **not** control "the contents of the operator's
   filesystem", so Gate 2a fails — the swapped path is not attacker-controlled.
   (The *symlink* variant — a pre-existing symlink under `public/vendor/`, which
   `fs.stat` follows because there is no `realpath` — is a path-containment
   escape, i.e. NAV/CWE-59, not a race. Cross-classed below.)

2. **Prototype pollution (`httpApi.js:120`).**
   `VENDOR_TYPES[path.extname(f)]` is an attacker-influenced object *read*
   (not a write) on an object literal. **SAFE:** `path.extname` returns either
   `''` or a string beginning with `.`, so `__proto__` / `constructor` /
   `prototype` are structurally unreachable as keys (`'.__proto__' !==
   '__proto__'`), and `VENDOR_TYPES['']` is `undefined` → falls to the
   `application/octet-stream` default. A read cannot pollute regardless.

3. **Resource exhaustion.** No user-controlled size/count/limit, no regex
   matched against `u.pathname`, no recursion, no allocation proportional to
   input. `path.resolve` / `path.extname` / `String.startsWith` are all linear
   and bounded by the URL length, itself bounded by Node's default
   `maxHeaderSize` (16 KiB). **SAFE.**

4. **Integer overflow / crypto.** No arithmetic and no crypto on this path.
   **SAFE.**

**CROSS-CLASS (input #1, `src/httpApi.js:119` → `:91`, suspected class: NAV)**
`f.startsWith(VENDOR + path.sep)` is a *string* containment gate applied to the
`path.resolve` output. `fs.promises.stat` (:91) and `fs.createReadStream` (:100)
both **follow symlinks**, and there is no `fs.promises.realpath` anywhere in
`src/`. A symlink placed under `public/vendor/` therefore passes the gate and
serves arbitrary operator-readable files pre-authentication. CWE-59 / CWE-22.
(Note the *encoded*-traversal variant from the recon does **not** work: Node's
`new URL()` does not percent-decode `pathname`, so `%2e%2e` stays literal,
`path.resolve` normalizes real `..` *before* the `startsWith` check, and the
resulting literal path simply 404s. Route this to NAV for the symlink case.)

**CROSS-CLASS (input #1, `src/httpApi.js:117`, suspected class: NAV, CWE-306)**
`GET /vendor/*` returns at :121 **before** the token gate at :129 — the only
unauthenticated surface. In scope for NAV's Missing Auth Assessment.

---

## Input #2 — `x-forwarded-proto`

**NO-MATCH (input #2).** Not a class-group mismatch — the input **does not
exist in the codebase**. There is no `req.headers['x-forwarded-proto']` read, no
`isSecureRequest`, no `applySecurityHeaders`, and no `config.trustProxy` /
`BRIDGE_TRUST_PROXY` consumer in `src/`. `src/config.js` never defines a
trust-proxy flag. Gate 1 (reachability) eliminates it outright: zero production
call sites because zero call sites of any kind.

**Downstream consequence worth recording for the report author:** the *absence*
of `applySecurityHeaders` means the responses from `httpApi.js` carry **no CSP,
no `referrer-policy: no-referrer`, no `frame-ancestors`, no
`x-content-type-options`**. `json()` (:42-46) and `sendFile()` (:105) set only
`content-type`. This invalidates two mitigations the partition data file relies
on elsewhere — in particular the claim that the `?token=` query-param branch is
"mitigated only by `referrer-policy: no-referrer`". That mitigation is **not
present**, which is why VULN-L03 below is filed against input #4.

---

## Inputs #3 / #4 + G3 — the credential comparison

Both inputs converge on the same sink: `extractToken` (`auth.js:11-17`) →
`checkToken` (`auth.js:3-9`). Three production call sites, all unauthenticated
entry points:

- `src/httpApi.js:129` — bridge token gate (all REST routes)
- `src/wsApi.js:8` — WebSocket upgrade gate
- `src/facade/index.js:45` — cloud-API facade gate (plus the `x-api-key`
  alternate at `:42-44`)

**Authentication-branch enumeration** (mandatory, multi-auth endpoint). Four
branches, all terminating in the same `checkToken(provided, config.token)`:

| Branch | Source | Credential | Verified? | Identity produced | Scope |
|---|---|---|---|---|---|
| A | `Authorization: Bearer <t>` (`auth.js:13`) | shared bridge token | yes, `timingSafeEqual` | none (binary allow/deny) | full |
| B | `?token=<t>` (`auth.js:14-15`) | same token | same | none | full |
| C | `x-api-key: <t>` (`facade/index.js:42-44`) | same token | same | none | full (facade only) |
| D | WS upgrade (`wsApi.js:8`) | same token | same | none | full |

No branch accepts a *weaker* credential than any other — all four require the
identical secret and run the identical check. **No weaker-credential branch
finding.** (Branch C is reached only when `token == null`, i.e. neither A nor B
supplied, and only for `family === 'anthropic'`.)

**Absent-input analysis (mandatory).** If `authorization` is absent *and*
`?token=` is absent, `extractToken` returns `null` (`auth.js:16`), and
`checkToken(null, …)` hits `typeof provided !== 'string'` at `auth.js:4` and
returns `false`. All three call sites are written as `if (!checkToken(...))
return <401>` — an unconditional gate with no `if (header)` wrapper. The gate
**fails closed** on every absent-input combination. **No Conditional Validation
Bypass.** Same for a malformed header (`h.startsWith('Bearer ')` false at :13 →
falls through to the query branch → `null`).

**Token entropy (crypto check).** `src/config.js:91`:
`const token = env.BRIDGE_TOKEN || crypto.randomBytes(24).toString('base64url');`
CSPRNG, 192 bits. **SAFE** — no hardcoded secret, no `Math.random`, no weak
algorithm. `crypto.timingSafeEqual` (`auth.js:8`) is the correct primitive for
the content comparison.

---

### [VULN-L01] Token **length** is disclosed by a non-constant-time early return in `checkToken`

- **Input**: #3 (`authorization` header, `auth.js:12`) and #4 (`?token=`,
  `auth.js:15`); gate **G3**
- **Class**: CWE-208 (Observable Timing Discrepancy) / CWE-203 (Observable
  Discrepancy), in the "Cryptographic Issues" class
- **Severity**: **Low**
- **Location**: `src/auth.js:7`
- **Gate 0 (intended behavior?)**: No. The function's evident purpose is a
  constant-time credential comparison — `crypto.timingSafeEqual` at :8 is chosen
  precisely to avoid a side channel. A length oracle at :7 is a defect in that
  control, not a feature. Gate 0 explicitly does not apply to a security check
  that is partially skipped. **Passes.**
- **Gate 1 (reachable?)**: `grep -rn "checkToken" src/` → 3 production call
  sites (`httpApi.js:129`, `wsApi.js:8`, `facade/index.js:45`), plus the
  definition. All three are on unauthenticated request paths reached before any
  other gate. **Not dead code. Passes.**
- **Gate 2a (attacker-controlled?)**: Yes, fully. `provided` originates directly
  from the request — `req.headers.authorization` (`auth.js:12`) or the raw query
  string (`auth.js:14`). The attacker chooses its exact byte length with no
  intervening transformation; `h.slice(7)` at :13 is the only edit. **Passes.**
- **Gate 2b (sanitization?)**: None applicable and none present. There is no
  padding, no fixed-width normalization (e.g. hashing both sides to a fixed
  digest before comparing), and no rate limiter to blunt sampling. Read the
  whole of `auth.js` — 17 lines, nothing between source and sink. **Passes.**
- **Gate 3 (new capability?)**: **Weak — record honestly.** What the attacker
  affirmatively gets is the **byte length of `config.token`**, learnable in ≤N
  probes by varying the submitted length and observing which requests return
  early (:7) versus which reach `timingSafeEqual` (:8). Note the discrepancy
  here is *structural*, not merely a timing microsecond: the length-mismatch
  path performs no crypto at all, so the signal is one full `timingSafeEqual`
  call wide and is remotely observable without co-residency.
  What it does **not** get: any information about the token's *contents* —
  `timingSafeEqual` at :8 is genuinely constant-time over equal-length buffers.
  Against the default token (`config.js:91`, 24 random bytes → a fixed 32-char
  base64url string) the length is a constant an attacker already knows from
  reading the source, so the oracle yields **zero** new information. It yields
  real information only when the operator pins a custom `BRIDGE_TOKEN`, and even
  then only its length. **This proves a mechanism, not an outcome**, and by the
  shared Gate 3 rule ("if you cannot articulate a concrete outcome the attacker
  could not already achieve, the finding is a Code Smell") it should be expected
  to fall in Phase 2b **unless** it is chained with VULN-L02 — the pair is what
  makes it material: length disclosure collapses the keyspace an unthrottled
  brute-forcer must cover when the operator has pinned a short token.
- **Entry Point**: every route on the server — `httpApi.js:129`, `wsApi.js:8`,
  `facade/index.js:45`. Unauthenticated by definition (this *is* the auth gate).
- **Data Flow**:
  1. `req.headers.authorization` — `src/auth.js:12`
     (or `req.url` query string — `src/auth.js:14`)
  2. `h.slice(7)` / `p.get('token')` → return — `src/auth.js:13,15`
  3. `checkToken(extractToken(req), config.token)` — `src/httpApi.js:129`
     (also `src/wsApi.js:8`, `src/facade/index.js:45`)
  4. `const a = Buffer.from(provided)` — `src/auth.js:5`
  5. **SINK** `if (a.length !== b.length) return false;` — `src/auth.js:7`
     (returns *before* the constant-time comparison at :8)
- **Root Cause**: `checkToken` short-circuits on length inequality to satisfy
  `crypto.timingSafeEqual`'s requirement that both buffers be the same size,
  but does so with an observable early return instead of a length-independent
  construction (e.g. comparing fixed-size SHA-256 digests of both inputs).
- **Exploitability**: Low. Remote and unauthenticated, and the branch is
  trivially distinguishable, but the recovered secret material is one integer.
  Practical impact exists only in the pinned-weak-`BRIDGE_TOKEN` configuration,
  and only in combination with VULN-L02.

---

### [VULN-L02] No rate limit, attempt counter, or backoff on any of the four unauthenticated credential-check surfaces, and no minimum-entropy validation on an operator-pinned token

- **Input**: #3 (`authorization` header) and #4 (`?token=`) — unbounded
  resubmission of the credential
- **Class**: CWE-307 (Improper Restriction of Excessive Authentication
  Attempts); contributing CWE-521 (Weak Password Requirements) at
  `src/config.js:91`
- **Severity**: **Medium**
- **Location**: `src/httpApi.js:129`, `src/wsApi.js:8`,
  `src/facade/index.js:45`, `src/facade/index.js:42-44`; entropy gap at
  `src/config.js:91`
- **Gate 0 (intended behavior?)**: No. This is the *absence* of a control on the
  authentication path, not a caller-serving feature. The class file's
  "Rate-limit/counter scope bypass" entry treats a bypassable attempt counter as
  an authentication bypass (CWE-307) rather than a mere race; a counter that
  does not exist at all is the limiting case of bypassable. **Passes.**
- **Gate 1 (reachable?)**: All four checks sit on live unauthenticated request
  paths (see VULN-L01 Gate 1). `grep -rniE "rate.?limit|throttle|attempts|
  backoff|lockout" src/` → **0 hits**. There is no middleware layer, no
  `server.maxConnections` setting in `src/server.js`, and no per-IP state
  anywhere in the codebase. **Passes.**
- **Gate 2a (attacker-controlled?)**: Yes — the attacker controls both the
  credential value and the request rate. Per the partition threat model the
  attacker profile is "any party that can reach the listening socket", with
  `HOST`/`PORT` env-configurable (`config.js:202-203`) and **no bind-address
  restriction applied by the code itself**. **Passes.**
- **Gate 2b (sanitization?)**: No compensating control exists in the audited
  code. Explicitly **not** counted, per the shared "speculated defenses" rule:
  the default `127.0.0.1` bind (an env-overridable default, not an enforcement),
  any reverse proxy or WAF, and README prose about a "loopback only" or
  "single-operator trust model" — the partition data file records such prose as
  inadmissible and the auth fields as `NONE`. **Passes.**
- **Gate 3 (new capability?)**: A successful guess yields the **full bridge
  token**, which is the *only* credential in the system: it unlocks
  `POST /api/sessions/:id/prompt` (`httpApi.js:158-173`) and
  `POST /api/sessions/:id/key` (`httpApi.js:174-182`), both of which write
  attacker-chosen bytes into a live PTY, plus the WebSocket stream
  (`wsApi.js:8`) and all facade dialects. That is arbitrary command execution in
  the operator's shell from a starting position of "can reach the socket and has
  no credential at all" — squarely a new capability against the partition's
  stated Gate 3 baseline for the all-`NONE` rows ("can reach the endpoint —
  nothing more"; no read or write capability is presumed). **Passes.**
- **Entry Point**: `httpApi.js:129` (REST), `wsApi.js:8` (WS upgrade),
  `facade/index.js:45` and `:42-44` (facade Bearer and `x-api-key`) — four
  independent surfaces, none of which shares state with the others, so an
  attacker can also parallelize across all four.
- **Data Flow**:
  1. Attacker submits candidate token — `src/auth.js:12` or `:14`
  2. `checkToken` returns `false` — `src/auth.js:7` or `:8`
  3. `return json(res, 401, { error: 'unauthorized' })` —
     `src/httpApi.js:129` — **no counter incremented, no delay, no lockout, no
     record of the attempt**
  4. Attacker repeats from step 1 at line rate, indefinitely
- **Root Cause**: A single static shared secret guards the entire application,
  and the failure path records nothing. Compounding it, `src/config.js:91`
  (`env.BRIDGE_TOKEN || crypto.randomBytes(24)...`) accepts an operator-supplied
  `BRIDGE_TOKEN` of **any** length or composition with no minimum-entropy check
  — `BRIDGE_TOKEN=1` is accepted silently. The strong CSPRNG default protects
  only operators who never pin a token.
- **Exploitability**: **Configuration-dependent, and that is the whole finding.**
  Against the generated default (192 bits, `config.js:91`) brute force is
  infeasible and this is theoretical. Against a pinned short `BRIDGE_TOKEN` —
  which the code invites and never validates — it is straightforward, and
  VULN-L01 hands the attacker the exact length to target first, removing the
  need to search across lengths. Severity is set at Medium rather than High
  because the default configuration is safe; it is not lower because the
  unsafe configuration is one env var away, is nowhere warned against, and the
  payoff is full RCE from an unauthenticated position.

---

### [VULN-L03] Bridge token accepted in the query string, with the mitigating header absent

- **Input**: #4 (`?token=` query param, `auth.js:15`)
- **Class**: CWE-598 (Use of GET Request Method With Sensitive Query Strings);
  adjacent to CWE-532
- **Severity**: **Low**
- **Location**: `src/auth.js:14-15`; propagated by `src/server.js:31,36` and
  `public/index.html:9,16`
- **Disposition**: **CROSS-CLASS (input #4, `src/auth.js:15`, suspected class:
  NAV)** — credential-transport exposure is a NAV-family concern. Recorded here
  because the LOG trace is what disproved the mitigation the partition data file
  assumed, and because CWE-532 (sensitive data in log output) is a LOG class.
- **Findings**: The token is placed in the URL by design —
  `src/server.js:31` prints `http://host:port/?token=<token>` at boot, and
  `public/index.html:9` reads it back out of `location` and re-sends it on the
  WS query string (`index.html:16`). The partition data file states this is
  "mitigated only by `referrer-policy: no-referrer`, `httpApi.js:135`".
  **That header does not exist** (see drift notice). `json()`
  (`httpApi.js:42-46`) and `sendFile()` (`httpApi.js:105`) emit only
  `content-type`. So the token reaches browser history, the `Referer` sent to
  any third-party origin the page later references, and any intermediary access
  log — with no `referrer-policy` counter-measure in the served response.
- **LOG-class sub-check (CWE-532), cleared**: the application itself never logs
  request URLs. `grep -rn "console\.(log|error|warn)" src/ bin/` → 8 hits, none
  in a request handler; the only token-bearing one is `server.js:36`, a boot
  banner printing the operator's own token to the operator's own terminal —
  **DESIGN-INTENT**, that banner is how the operator obtains the URL.
- **Note for the NAV agent**: the exposure is real but the *reachable* leak
  channels depend on the browser and on `public/index.html` referencing no
  external origin (verified: `public/vendor/` holds local copies of
  `xterm.js`, `xterm.css`, `addon-fit.js` — no CDN references), which
  substantially narrows the `Referer` vector. Severity is Low on that basis.

---

## Gate G2 — route ordering — **SAFE** (recon note is incorrect)

The partition data file asserts that `/v1/messages` matched by the façade
"**bypasses the bridge token gate**" and that "route ordering is the security
control", marking it a CANDIDATE. **This is wrong**, and I am recording SAFE
rather than carrying the candidate forward.

`facade.handle` performs its **own** token check at `src/facade/index.js:45`:

```js
if (!checkToken(token, config.token)) {
  return sendError(res, family, new FacadeError(401, 'auth', ...));
}
```

It calls the identical `checkToken` against the identical `config.token`
(`auth.js:3`) before dispatching to any handler (`:50`). The façade is matched
before the bridge gate (`httpApi.js:127` vs `:129`) so that 401s can be
*provider-shaped* — the reason is stated in the header comment at
`facade/index.js:2-6` — not so that they can be skipped. Route ordering is a
response-formatting decision here, not the security control.

The near-miss cases the recon raises are also safe, in the opposite direction
from what it claims: `canHandle` (`:38`) matches on the raw pathname, so
`/v1/messages/` (trailing slash) or `/V1/messages` (case) **miss** the façade
table and fall through to `httpApi.js:129` — the bridge token gate. Falling
through lands on a gate that is *at least as strict* (same secret, same
function); it does not skip one. Both branches require the same credential, so
there is no reachable path to a handler without a valid token.

Residual LOG observation, not a finding: `facade/index.js:40` does
`routes.get(...)` immediately after `canHandle` returned true, with no re-check.
Both calls key the same `Map` with the same `${method} ${pathname}` string and
the map is built once at startup (`:20-34`) and never mutated, so there is no
check-then-act window. **SAFE.**

---

## LOG sinks confirmed absent from this partition

Swept and clear, recorded so the absence is not mistaken for an untraced gap:

- **Cache / state isolation**: no cache of authorization decisions, credentials,
  or sessions keyed by user-controlled data anywhere in the SG-4 scope. The
  token check is recomputed per request (`httpApi.js:129`) with no memoization,
  so there is no cache-key-completeness, key-collision, or revocation-window
  question to answer.
- **Credential/policy scope over-permissioning**: the application generates no
  authorization artifacts — no IAM policies, no scoped tokens, no OAuth scopes,
  no capability grants. `checkToken` is binary allow/deny and produces no
  identity (see the branch-enumeration table), so there is no scope to
  over-permission and no `requestType` discriminator to leak across.
- **Integer overflow**: no arithmetic on any of inputs #1-#4. (`MAX_BODY` at
  `httpApi.js:48` and the `len` accumulator at `:53` are the only size
  arithmetic in the file and are driven by body bytes, not by these inputs.)
- **Deserialization**: `JSON.parse` (`httpApi.js:67`) is body-driven, not
  reachable from inputs #1-#4, and JSON reconstructs no prototypes.
- **ReDoS**: no regex is applied to any SG-4 input. The two regexes in the file
  (`httpApi.js:170`, and `:30` in `sendPrompt`) match error message strings.

## Out-of-partition observations (not my inputs — forwarded, not traced)

- **CWE-400, `src/httpApi.js:178`**: `for (const k of (b.keys || []))` iterates
  an unbounded request-body collection with no `@Size`-equivalent cap, each
  element writing to the PTY. Bounded only by `MAX_BODY` (1 MiB, `:48`), which
  still permits ~10^5 key writes per request. This is the mandatory
  request-DTO-collection check firing, but `b.keys` is a body field belonging to
  another partition's input set — flagging for whichever agent owns it.
- **CWE-400, `src/httpApi.js:183-191`**: the SSE `events` route registers
  listeners per connection with no concurrent-stream cap. Authenticated;
  another partition's surface.
