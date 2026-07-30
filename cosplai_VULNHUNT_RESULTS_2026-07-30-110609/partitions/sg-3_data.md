# SG-3 — WebSocket terminal (partition data)

**Target repo root (absolute):** `/home/kali/repos/cosplai`
**Scan dir:** `/home/kali/repos/cosplai/cosplai_VULNHUNT_RESULTS_2026-07-30-110609`
**Full recon output (reference only):** `<scan dir>/phase1_output.md`

## Entry points
`GET /ws` (HTTP upgrade) + the `/ws` message handler

## Assigned inputs (#36-39)

| # | Source Type | Location | Variable | Entry Point | Trust Level |
|---|---|---|---|---|---|
| 36 | WS query param | `src/wsApi.js:11` | `session` | `GET /ws` (upgrade) | authenticated |
| 37 | WS query param | `src/wsApi.js:13,15,16,27-32` | `profile` (echoed into **raw socket write**, S17) | `GET /ws` (upgrade) | authenticated |
| 38 | WS message (raw) | `src/wsApi.js:52-54` | `raw` → `session.write` (**arbitrary PTY bytes**, S6) | `/ws` message handler | authenticated |
| 39 | WS message (JSON) | `src/wsApi.js:53` | `m.cols`, `m.rows` (resize, S11) | `/ws` message handler | authenticated |

## App-specific file scope (trace these)
`src/wsApi.js`, `src/sessionManager.js`, `src/session.js`, `src/terminalModel.js`

## Shared infrastructure (reference context)

| Module | Role | Files |
|---|---|---|
| token auth | authentication (extract + timing-safe compare) | `src/auth.js` |
| adapter registry | per-CLI marker/keyseq strategy | `src/adapters/*` |

**Exception:** `src/sessionManager.js` and `src/session.js` are **NOT** shared
infrastructure — they build and execute the spawn and are in trace scope.

## Authentication branches relevant here

| Branch | Location | Credential | Verified? |
|---|---|---|---|
| F. WS upgrade | `wsApi.js:8` | same shared token, same `extractToken` | No — constant-time equality of a shared secret. Browsers cannot set headers on a WS upgrade, so the **`?token=` query-param branch is mandatory** for the shell. |
| G. Pre-auth 400 responder | `wsApi.js:25-33` — profile validation | token IS checked first (`:8`) | — |

## Threat model

| Entry-point group | App-layer auth enforcement | Caller identity binding | Per-resource authorization |
|---|---|---|---|
| `GET /ws` (upgrade + message stream) | `src/wsApi.js:8` | `NONE` | `NONE` — `?session=<id>` attaches to **any** existing session (`wsApi.js:11-12,37`) with no ownership check |

Prose in comments/README about "loopback only", "single-operator trust model", or
"operator-trusted config" is **not admissible** and is recorded as `NONE`.

**Why caller identity binding is `NONE`:** `checkToken` (`src/auth.js:3-9`) is a
constant-time comparison against a single shared secret — possession of a secret,
not a caller.

**Attacker profile:** any holder of the single bridge token, plus anyone who can
replay it. Because the token must travel in the **query string** for WS
(`auth.js:14-16`), it leaks to logs, `Referer`, and browser history; it is
**printed to stdout at boot** (`server.js:29`). **There is no `Origin` validation
on the `/ws` upgrade** (`wsApi.js:6-33`) — the classic cross-site WebSocket
hijacking shape. A **web page in the victim's browser** is therefore in the
attacker class once it learns or guesses the token.

**Attacker controls:** #36-39. Most consequentially:
- **#38 — arbitrary raw bytes to the PTY** (`wsApi.js:54`), including terminal
  control sequences and, since the child is an interactive REPL, whatever that
  REPL will do with them. No content filtering.
- **#39 — `cols`/`rows`** reaching `session.resize` / `@xterm/headless`
  `resize()` with **no numeric validation**.
- **#37 — `profile`**, echoed into a **raw `socket.write` 400 response**
  (`wsApi.js:25-33`) — evaluate response-splitting / header-injection shape.
- **#36 — `session`**, attaches to any existing session id with no ownership check.

**Attacker does NOT control:** `config.token` (unless leaked), the
`BUILTIN_PROFILES` table (`config.js:36-86`), the `envScrub` lists, response
security headers, bind host/port, the ambient credentials of the AI CLIs. Session
ids are `crypto.randomUUID()` (`session.js:8`) — unguessable.

**Gate 3 baseline (existing capability):** a bridge-token holder can attach to
sessions they created, write to the terminal, read scrollback, and resize. **NOT
in the baseline** (still findable): **hijacking or colliding with another live
session**, **splitting the raw upgrade response**, resource exhaustion via
unvalidated resize, or reaching any of this from a **cross-origin web page**
without the operator's intent.

## Cross-cutting notes
- The single-shared-token model means "authenticated" ≈ one principal; any finding
  that lets one *session* affect another is meaningful despite that.
- Server → browser: CSP `default-src 'none'` + `connect-src 'self'`,
  `frame-ancestors 'none'` (`httpApi.js:92-102`); `public/index.html:19-36` feeds
  PTY output into `term.write`, and xterm renders to canvas/DOM as text, not HTML.
- **Phase 2 must treat `vendor/` as the effective production binary source** when
  reasoning about what `pty.spawn` actually executes.
