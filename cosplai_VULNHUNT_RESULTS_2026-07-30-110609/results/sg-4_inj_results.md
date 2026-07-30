# SG-4 — INJ trace results

**Agent:** INJ trace agent, partition SG-4 (static serving & transport hardening)
**Class group:** SQL, command, path traversal, SSRF/URL injection, XSS, open redirect, XXE, LDAP, API query lang, code eval/SSTI, file upload
**Repo root:** `/home/kali/repos/cosplai`
**Files traced:** `src/httpApi.js`, `src/auth.js`, `public/index.html`, `src/facade/index.js` (route-match confirmation only)

## Summary

**0 CANDIDATEs.** All four assigned inputs and all three gate-logic entries were
traced to completion. The only INJ-class sink in this partition is the static-file
read in `sendFile` (`src/httpApi.js:147,156`), reached from input #1. It is
empirically proven non-traversable. Inputs #2–#4 do not reach any INJ-class sink.

| # | Disposition |
|---|---|
| 1 | **SAFE** — path traversal blocked (WHATWG URL normalization + `path.resolve` + `startsWith(VENDOR + path.sep)`) |
| 2 | **NO-MATCH** (INJ) → CROSS-CLASS (NAV) |
| 3 | **NO-MATCH** (INJ) |
| 4 | **NO-MATCH** (INJ) |
| G1 | **SAFE** (with recorded residual, non-attacker-reachable) |
| G2 | **CROSS-CLASS (NAV)** — and no bypass exists (facade self-authenticates) |
| G3 | **CROSS-CLASS (LOG / crypto side-channel)** |

---

## Input #1 — HTTP URL path `u.pathname`, `GET /vendor/*` (unauth)

**Source:** `src/httpApi.js:171` `new URL(req.url, 'http://x')`
**Guard:** `src/httpApi.js:174` `u.pathname.startsWith('/vendor/')`
**Sink chain:** `src/httpApi.js:175` `path.resolve(PUBLIC, '.' + u.pathname)`
→ `:176` containment check → `:178` `sendFile(res, f, type)`
→ `:147` `fs.promises.stat(file)` → `:156` `fs.createReadStream(file)` → `:162` `pipe(res)`

**Disposition: SAFE (CWE-22 not exploitable).**

### Gate 2b — empirical sanitizer verification (option (b): runnable test)

The "sanitizer" here is two-part: (1) WHATWG `URL` path normalization, (2) the
`path.resolve` + `startsWith(VENDOR + path.sep)` containment gate. Both were
tested against the sink's dangerous character set (`..`, `/`, `\`, `%2e`, `%2f`,
`%5c`, `%00`, drive letters) rather than assumed:

```
node -e 'const path=require("path");
const P="/repo/public", V=path.join(P,"vendor");
for (const x of [...]) { const u=new URL(x,"http://x");
  const f=path.posix.resolve(P,"."+u.pathname);
  console.log(x,"->",u.pathname,"|",f,"| allowed:",(f===V||f.startsWith(V+"/"))); }'
```

Results (posix resolve / win32 resolve both checked):

| Payload | `u.pathname` after URL parse | Resolved | Gate allows? | Escapes? |
|---|---|---|---|---|
| `/vendor/../../../etc/passwd` | `/etc/passwd` | `/repo/public/etc/passwd` | **no (403)** | no |
| `/vendor/%2e%2e/%2e%2e/etc/passwd` | `/etc/passwd` | `/repo/public/etc/passwd` | **no (403)** | no |
| `/vendor/.%2e/.%2e/etc/passwd` | `/etc/passwd` | `/repo/public/etc/passwd` | **no (403)** | no |
| `/vendor//../../etc/passwd` | `/etc/passwd` | `/repo/public/etc/passwd` | **no (403)** | no |
| `//vendor/../../etc/passwd` | `/etc/passwd` | `/repo/public/etc/passwd` | **no (403)** | no |
| `/vendor/a/../../../etc/passwd` | `/etc/passwd` | `/repo/public/etc/passwd` | **no (403)** | no |
| `/vendor/\../\../etc/passwd` | `/vendor/etc/passwd` | `/repo/public/vendor/etc/passwd` | yes | **no** (backslash→slash pre-normalized) |
| `/vendor/..%2f..%2fetc/passwd` | `/vendor/..%2f..%2fetc/passwd` | `/repo/public/vendor/..%2f..%2fetc/passwd` | yes | **no** (literal filename; `path.*` never percent-decodes) |
| `/vendor/%2e%2e%2f%2e%2e%2fetc/passwd` | unchanged | literal under `vendor/` | yes | **no** |
| `/vendor/..%5c..%5cwindows/win.ini` | unchanged | literal under `vendor/` (posix **and** win32) | yes | **no** |
| `/vendor/%252e%252e/etc` | unchanged | literal under `vendor/` | yes | **no** |
| `/vendor/....//....//etc/passwd` | unchanged | `…/vendor/..../..../etc/passwd` | yes | **no** (`....` is a normal name) |
| `/vendor/.../.../etc/passwd` | unchanged | under `vendor/` | yes | **no** |
| `/vendor/..;/etc/passwd` | unchanged | under `vendor/` | yes | **no** |
| `/vendor/%00../etc/passwd` | unchanged | literal `%00` name | yes | **no** (no real NUL byte) |
| `/vendor/..%00/../etc/passwd` | `/vendor/etc/passwd` | under `vendor/` | yes | **no** |
| `/vendor/C:/windows/win.ini` | unchanged | `C:\repo\public\vendor\C:\windows\win.ini` on win32 | yes | **no** (`path.win32.resolve` only honours a drive root at argument start) |
| `/vendor/%c0%ae%c0%ae/etc` | unchanged | literal under `vendor/` | yes | **no** |

Two independent properties make this hold, and both were verified rather than assumed:

1. **WHATWG `URL` normalizes before the app sees the path.** Per the URL spec's
   double-dot-path-segment rule, `..`, `.%2e`, `%2e.`, and `%2e%2e` are all
   collapsed at parse time (ASCII case-insensitive), and for special schemes `\`
   is converted to `/` before segmentation. So `u.pathname` cannot contain a
   live `..` segment.
2. **`path.resolve` never percent-decodes.** Any surviving `%2f` / `%5c` / `%00`
   stays a literal character in a filename, so it cannot become a separator or a
   string terminator. The containment check is therefore evaluated on the same
   byte string the filesystem will see.

The containment gate itself is correctly shaped: it runs **after** `path.resolve`
(not on the raw input), appends `path.sep` so `/public/vendor-evil` is rejected,
and has an exact-equality escape for the directory itself.

### Residual (recorded, not a finding) — symlink following

`sendFile` uses `fs.promises.stat` (follows symlinks) and `fs.createReadStream`
(follows symlinks) with **no `fs.realpath`** anywhere in `src/`
(`grep -rn "realpath\|lstat" src/` → 0 hits). A symlink placed inside
`public/vendor/` would therefore be dereferenced and its target streamed to an
unauthenticated caller.

**Eliminated at Gate 2a (not attacker-controlled).** Exploitation requires the
attacker to create a symlink under `public/vendor/`:
- `ls -laR public/` → `public/vendor/` contains exactly three regular files
  (`xterm.js`, `xterm.css`, `addon-fit.js`); `find public -type l` → no symlinks.
- `grep -rn "writeFile\|createWriteStream\|mkdir\|symlink\|rename" src/ scripts/`
  → **0 hits**. The application has no file-write sink of any kind, so no request
  input can plant a symlink.
- The SG-4 threat model explicitly records that the attacker does **not** control
  the contents of the operator's filesystem.

Hardening note for the report (defense-in-depth, not a vulnerability): adding
`const real = await fs.promises.realpath(f)` and re-applying the
`VENDOR + path.sep` check to `real` would close this residual and remove the
stat→open TOCTOU window acknowledged in the comment at `src/httpApi.js:155`.

### Other INJ sub-classes checked on #1

- **Content-type / XSS via served asset:** `VENDOR_TYPES` (`:165`) is a two-entry
  allowlist (`.js`, `.css`); everything else falls back to
  `application/octet-stream`, and `x-content-type-options: nosniff` (`:133`) is
  set on every response before dispatch. No `text/html` can be induced. **SAFE.**
- **Open redirect / SSRF:** `u.pathname` reaches no outbound HTTP client and no
  `Location` header. **NO-MATCH.**

---

## Input #2 — HTTP header `x-forwarded-proto` (unauth, all routes)

**Source:** `src/httpApi.js:111` → `isSecureRequest` (`:108-114`)
**Full use:** the value is lowercased, first comma-segment taken, and compared
`=== 'https'` (`:113`). The boolean result is used at `:136` solely to decide
whether to emit `strict-transport-security`.

**Disposition: NO-MATCH (INJ).** The header value is never reflected into a
response header value, never concatenated into HTML, a URL, a query, a command,
a file path, or a template. The only thing that crosses the boundary is a
`boolean`, so no injection sink is reachable — the value is type-collapsed before
any use. No CRLF concern: the raw string is never written with `setHeader`.

**CROSS-CLASS (input #2, `src/httpApi.js:111-113` / `:136`, suspected class: NAV).**
Two transport-hardening observations for the NAV agent, both outside my class group:
- When `BRIDGE_TRUST_PROXY` is set, an unauthenticated client on a plain-HTTP hop
  fully controls whether HSTS is emitted — including **suppressing** it behind a
  genuinely TLS-terminating proxy by simply omitting the header.
- `src/config.js:17` `flag()` treats any unrecognized string as `true`, so
  `BRIDGE_TRUST_PROXY=maybe` silently enables the trust path. This is a
  config-parsing weakness feeding an unauth trust decision.

---

## Input #3 — HTTP header `authorization` (unauth, auth gate)

**Source:** `src/auth.js:12` `req.headers?.authorization`
**Sink chain:** `:13` `h.startsWith('Bearer ')` → `h.slice(7)` →
`src/httpApi.js:186` / `src/facade/index.js` `checkToken(provided, expected)` →
`src/auth.js:5-8` `Buffer.from` + length compare + `crypto.timingSafeEqual`.

**Disposition: NO-MATCH (INJ).** The value terminates in a constant-time byte
comparison. It is not interpolated into any query, command, path, URL, header, or
template, and it is not stored — `grep` confirms `extractToken` has exactly two
production callers (`src/httpApi.js:186`, `src/facade/index.js`), both of which
pass the result only to `checkToken`. No second-order flow.

---

## Input #4 — HTTP query param `token` (unauth, auth gate)

**Source:** `src/auth.js:14-15` — `(req.url || '').split('?')[1]` →
`new URLSearchParams(q).get('token')`
**Sink:** same `checkToken` terminus as #3.

**Disposition: NO-MATCH (INJ).** Same reasoning as #3: value terminates in
`timingSafeEqual`.

**Second-order check (store boundary — completed, not stopped at):** the token
value is not written to any store. It does, however, appear in the browser under
the operator's own control; `public/index.html` was traced as the downstream
consumer:
- `public/index.html:8-9` reads `token` from `location.search`;
- `:16` `new URLSearchParams({ token })` — the value is **percent-encoded by
  `URLSearchParams.toString()`**, so `&`, `=`, `?`, `#` cannot break out of the
  query;
- `:19` `` new WebSocket(`${proto}://${location.host}/ws?${q.toString()}`) `` —
  scheme is derived from `location.protocol` (`:15`) and host from
  `location.host`, **neither attacker-controllable**, so the URL authority is
  fixed. Additionally `connect-src 'self'` in `SHELL_CSP` (`src/httpApi.js:98`)
  is a browser-enforced backstop on the socket destination.
- `:21` `term.write(...)` writes PTY bytes into xterm.js, which renders to
  canvas/DOM text, **not** HTML. No `innerHTML`, `outerHTML`,
  `document.write`, `insertAdjacentHTML`, `eval`, `Function`, `location.href`,
  `location.assign`, `location.replace`, or `window.open` exist anywhere in
  `public/index.html` — a full per-file navigation/HTML sink sweep returned zero
  sinks. **SAFE** (no DOM XSS, no client-side URL injection, no open redirect).

The `session` and `profile` query params (`:10-11`, same file, in trace scope)
follow the identical encoded-`URLSearchParams` path with the same fixed authority
— **SAFE** for the same reason.

---

## Gate-logic entries

### G1 — `f.startsWith(VENDOR + path.sep)` (`src/httpApi.js:176`)

**SAFE.** Covered in full under input #1. The containment gate is correctly
shaped (post-`resolve`, `path.sep`-terminated, exact-equality escape) and the
`%2e`/backslash bypasses flagged in recon were **tested and do not work** — WHATWG
`URL` normalizes `%2e`-family sequences and converts `\`→`/` before the app sees
the path, and `path.resolve` never percent-decodes. The recon-flagged
`realpath`/symlink gap is real as code but fails Gate 2a (no attacker-reachable
write path exists in the codebase to plant a symlink). Recorded above as a
hardening item.

### G2 — route ordering, `src/httpApi.js:184-186`

**CROSS-CLASS (G2, `src/httpApi.js:184`, suspected class: NAV.)** Not an
injection sink. Traced far enough to confirm it is **not an auth bypass**: the
recon note reads `facade.canHandle` matching `/v1/messages` as bypassing the
bridge token gate at `:186`, but `src/facade/index.js` `handle()` performs its own
`checkToken(extractToken(req), config.token)` against the **same**
`config.token` before dispatching, returning a provider-shaped 401 on failure.
Non-matching variants (`/v1/messages/`, `/V1/messages`) fall through to `:186`
and hit the bridge gate. Both branches require the same secret, so no
weaker-credential authentication branch exists. The residual for the NAV agent is
the `x-api-key` acceptance path (`src/facade/index.js`), which is an alternate
*transport* for the identical secret, not a weaker credential.

### G3 — `checkToken` length short-circuit (`src/auth.js:7`)

**CROSS-CLASS (G3, `src/auth.js:7`, suspected class: LOG / crypto side-channel.)**
Not an injection class. Confirmed as read: `if (a.length !== b.length) return false;`
executes **before** `crypto.timingSafeEqual`, so token *length* is observable to an
unauthenticated attacker via response timing / early return. Byte content remains
constant-time. Low severity, and it is an unavoidable consequence of
`timingSafeEqual` requiring equal-length buffers — the standard mitigation is to
hash both sides to a fixed width before comparing. Routed to the LOG agent.

Null-safety confirmed (no fail-open): `extractToken` returns `null` on a malformed
or absent header (`src/auth.js:16`), and `checkToken(null, …)` returns `false` at
`src/auth.js:4` via the `typeof provided !== 'string'` guard.

---

## Absent-input analysis (mandatory)

Each assigned input was re-examined for fail-open behaviour when **omitted**:

| Input | Omitted → behaviour | Fails |
|---|---|---|
| #1 `u.pathname` | Always present; a non-`/vendor/` path simply skips the static branch and falls through to the token gate at `:186`. | closed |
| #2 `x-forwarded-proto` | `isSecureRequest` returns `false` (`:110`/`:113` — `String(undefined \|\| '')` never equals `'https'`) → HSTS omitted. Weakens a response header but grants no access. | closed (for access) |
| #3 `authorization` | `extractToken` falls through to the query branch, then returns `null` (`:16`) → `checkToken` returns `false` (`:4`) → 401. | **closed** |
| #4 `token` query | Same as #3 → `null` → 401. | **closed** |
| #3 **and** #4 both omitted | `extractToken` → `null` → `checkToken(null, …)` → `false` → 401 at `:186` and in the facade. | **closed** |

No **Conditional Validation Bypass** found: there is no `if (credential) { validate(); }`
pattern in this partition — `checkToken` is called **unconditionally** at
`src/httpApi.js:186` and in `src/facade/index.js`, and it is written to return
`false` (deny) on null/undefined/non-string input rather than skipping validation.
The `/vendor/*` route returns before `:186`, but that is an explicitly
unauthenticated static-asset route, not a skipped check — and #1 proves it cannot
serve anything outside `public/vendor/`.

## Completeness

All 4 assigned inputs and all 3 gate entries have a recorded disposition. No input
was left at a store boundary (input #4's only downstream consumer,
`public/index.html`, was traced to its terminal sinks). No CANDIDATEs to forward
to Phase 2b from this class group.
