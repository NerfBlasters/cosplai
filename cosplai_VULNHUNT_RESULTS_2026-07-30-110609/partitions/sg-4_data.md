# SG-4 — Static serving & transport hardening (partition data)

**Target repo root (absolute):** `/home/kali/repos/cosplai`
**Scan dir:** `/home/kali/repos/cosplai/cosplai_VULNHUNT_RESULTS_2026-07-30-110609`
**Full recon output (reference only):** `<scan dir>/phase1_output.md`

> **Priority 1 partition.** This is the only *unauthenticated* surface in the
> application.

## Entry points
`GET /vendor/*`, `GET /`, `GET /index.html`, and the security-header path that
runs on **every** response.

## Assigned inputs (#1-#4)

| # | Source Type | Location | Variable | Entry Point | Trust Level |
|---|---|---|---|---|---|
| 1 | HTTP URL path | `src/httpApi.js:171,175` | `u.pathname` | `GET /vendor/*` | **unauth** |
| 2 | HTTP header | `src/httpApi.js:111` | `x-forwarded-proto` | all HTTP routes | **unauth** |
| 3 | HTTP header | `src/auth.js:12` | `authorization` | all routes (auth gate) | **unauth** |
| 4 | HTTP query param | `src/auth.js:15` | `token` | all routes (auth gate) | **unauth** |

## Gate-logic entries in scope

| # | Type | Location | Variable | Trust |
|---|---|---|---|---|
| G1 | authorization gate | `src/httpApi.js:176` | `f` (resolved vendor path) | unauth |
| G2 | authorization gate (route ordering) | `src/httpApi.js:184-186` | `u.pathname` | unauth |
| G3 | authorization gate | `src/auth.js:3-9` | `provided` vs `expected` | unauth |

Recon notes carried forward:
- **G1** — `f.startsWith(VENDOR + path.sep)` is a path-containment gate on a
  String. Correct *shape* (post-`path.resolve`, `path.sep` appended, exact-equality
  escape for the dir itself). **CANDIDATE**: `fs.promises.stat` **follows
  symlinks** and there is **no `realpath`** → symlink escape; and
  `path.resolve(PUBLIC, '.' + u.pathname)` with a `%2e`-encoded or backslash
  pathname on non-POSIX.
- **G2** — `facade/index.js:38` `routes.has('${method} ${pathname}')` matches on
  the **raw** pathname. A request to `/v1/messages/` or `/V1/messages` misses the
  façade table and falls through to the bridge token gate (a different auth
  family); `/v1/messages` matched there **bypasses the bridge token gate at
  `httpApi.js:186`** by design (`httpApi.js:184`). **Route ordering is the
  security control.** **CANDIDATE.**
- **G3** — `extractToken` returns `null` on a malformed header and
  `checkToken(null, …)` returns `false` (`auth.js:4`) — no null-bypass.
  `checkToken` returns early on **length mismatch** (`auth.js:7`) before
  `timingSafeEqual`, so **token length is observable**. Low severity.

## App-specific file scope (trace these)
`src/httpApi.js` — specifically `sendFile`, `applySecurityHeaders`,
`isSecureRequest`, and vendor path resolution (`:108-139`, `:147`, `:156`,
`:168-186`, `:252`); `src/auth.js`; `public/index.html`

## Shared infrastructure
None used by this partition (it *is* the transport-hardening layer). `src/auth.js`
is in trace scope here because G3 is an assigned gate.

## Threat model

| Entry-point group | App-layer auth enforcement | Caller identity binding | Per-resource authorization |
|---|---|---|---|
| `GET /vendor/*` | **`NONE`** — `src/httpApi.js:174-179` returns **before** the gate at `:186` | `NONE` | `NONE` |
| `GET /`, `GET /index.html` | `src/httpApi.js:186` | `NONE` | `NONE` |

Prose in comments/README about "loopback only", "single-operator trust model", or
"operator-trusted config" is **not admissible** and is recorded as `NONE`.

**Attacker profile for `GET /vendor/*` (all three `NONE`):** **any party that can
reach the listening socket** — no credential at all. Default bind is
`127.0.0.1:7681` (`config.js:202-203`), but `HOST`/`PORT` are env-configurable
(#40) and the code applies **no bind-address restriction of its own**.

**Attacker controls:** #1-#4, G1, G2, G3.
- **#1 — the `/vendor/` path, pre-authentication.**
- **#2 — `x-forwarded-proto`**, believed when `BRIDGE_TRUST_PROXY` is set
  (`httpApi.js:108-114`). Note `config.js:17` `flag()` treats **any unrecognized
  string as `true`** (e.g. `BRIDGE_TRUST_PROXY=maybe` → `true`).
- **#3/#4 — the credential material itself**, including the query-string branch
  that puts the token in logs/`Referer`/history (mitigated only by
  `referrer-policy: no-referrer`, `httpApi.js:135`).

**Attacker does NOT control:** `config.token` (unless leaked), `SHELL_CSP`
(`httpApi.js:92-102`), the response security headers, the bind host/port, or the
contents of the operator's filesystem.

**Gate 3 baseline (existing capability):** for the all-`NONE` `/vendor/*` row the
baseline is **"can reach the endpoint" — nothing more**. Per the all-NONE
constraint, **no read or write capability is presumed**; CWE-306 / CWE-22
evaluation of this route is fully open. Any file read outside `vendor/`, and any
pre-auth capability beyond fetching a vendored asset, is a new capability.

## Cross-cutting notes
- Trust boundary — network → HTTP server (`httpApi.js:168-171`): `new URL(req.url,
  'http://x')`; **security headers are applied before any auth** (`:170`).
- Trust boundary — application → filesystem (`httpApi.js:147,156,175-176`):
  `path.resolve` + `startsWith(VENDOR + sep)`, **no `realpath`**.
- Server → browser: CSP `default-src 'none'` + `connect-src 'self'`,
  `frame-ancestors 'none'` (`httpApi.js:92-102`, `:132-139`);
  `public/index.html:19-36` feeds PTY output into `term.write` (canvas/DOM text,
  not HTML).
- **No CSRF defense on state-changing routes** and no `Origin`/`Sec-Fetch-Site`
  check anywhere in the codebase.
