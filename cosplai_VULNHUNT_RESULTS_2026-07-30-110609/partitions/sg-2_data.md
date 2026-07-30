# SG-2 — Bridge session REST API (partition data)

**Target repo root (absolute):** `/home/kali/repos/cosplai`
**Scan dir:** `/home/kali/repos/cosplai/cosplai_VULNHUNT_RESULTS_2026-07-30-110609`
**Full recon output (reference only):** `<scan dir>/phase1_output.md`

## Entry points
`POST /api/sessions`, `GET /api/sessions`, `GET/DELETE /api/sessions/:id`,
`POST /api/sessions/:id/prompt`, `POST /api/sessions/:id/key`,
`GET /api/sessions/:id/events`

## Assigned inputs (#26-35, #45)

| # | Source Type | Location | Variable | Entry Point | Trust Level |
|---|---|---|---|---|---|
| 26 | HTTP body field | `src/httpApi.js:194` → `sessionManager.js:41` | `profile` | `POST /api/sessions` | authenticated |
| 27 | HTTP body field | `src/httpApi.js:194` → `sessionManager.js:41,76` | **`cwd`** (→ `pty.spawn` cwd, S1) | `POST /api/sessions` | authenticated |
| 28 | HTTP body field | `src/httpApi.js:194` → `sessionManager.js:41,78,80` | `cols` (→ `pty.spawn`/xterm) | `POST /api/sessions` | authenticated |
| 29 | HTTP body field | `src/httpApi.js:194` → `sessionManager.js:41,78,80` | `rows` (→ `pty.spawn`/xterm) | `POST /api/sessions` | authenticated |
| 30 | no-input endpoint | `src/httpApi.js:203` | N/A (lists all sessions) | `GET /api/sessions` | authenticated |
| 31 | HTTP path segment | `src/httpApi.js:206-207` | `parts[2]` (session id) | `GET/DELETE /api/sessions/:id`, `/prompt`, `/key`, `/events` | authenticated |
| 32 | HTTP body field | `src/httpApi.js:219,222` | `text` (**typed into live CLI**, S7) | `POST /api/sessions/:id/prompt` | authenticated |
| 33 | HTTP body field | `src/httpApi.js:222` | `submit` | `POST /api/sessions/:id/prompt` | authenticated |
| 34 | HTTP body field | `src/httpApi.js:221` | `timeoutMs` | `POST /api/sessions/:id/prompt` | authenticated |
| 35 | HTTP body field | `src/httpApi.js:235` | `keys[]` (→ `adapter.keySeq`, S8) | `POST /api/sessions/:id/key` | authenticated |
| 45 | PTY output (LLM-generated) | `session.js:17-22` → `terminalModel.write` → `renderLinesSince` | terminal screen text → response `text`/deltas | all PTY turns | internal (LLM-influenced) |

**Sibling-input rule:** every destructured field at `sessionManager.js:41`
(`{profile, cwd, cols, rows}`) is inventoried (#26-29), including the ones that
look benign.

## App-specific file scope (trace these)
`src/httpApi.js`, `src/sessionManager.js`, `src/session.js`,
`src/promptWriter.js`, `src/config.js`

## Shared infrastructure (reference context — read, but findings belong to the module that calls them)

| Module | Role | Files |
|---|---|---|
| token auth | authentication (extract + timing-safe compare) | `src/auth.js` |
| body readers | deserialization + size caps (1 MiB bridge / 8 MiB façade) | `src/httpApi.js:48-83`, `src/facade/shared.js:60-78` |
| serialization queue | per-session turn serialization | `src/promptQueue.js` |
| terminal state | screen model + busy/idle detection | `src/terminalModel.js`, `src/stateDetector.js` |
| adapter registry | per-CLI marker/keyseq strategy | `src/adapters/*` |

**Exception:** `src/config.js`, `src/sessionManager.js`, `src/session.js` are
**NOT** shared infrastructure — they build and execute the spawn (S1) and are in
trace scope. `src/auth.js` is reference context.

**Note on body readers:** `httpApi.readBody` **swallows JSON parse errors and
resolves `{}`** (`httpApi.js:67`), whereas the façade rejects with 400
(`shared.js:74`) — inconsistent.

## Threat model

| Entry-point group | App-layer auth enforcement | Caller identity binding | Per-resource authorization |
|---|---|---|---|
| `POST /api/sessions`, `GET /api/sessions` | `src/httpApi.js:186` | `NONE` | `NONE` |
| `GET/DELETE /api/sessions/:id`, `POST /api/sessions/:id/{prompt,key}`, `GET /api/sessions/:id/events` | `src/httpApi.js:186` | `NONE` | `NONE` — `manager.get(parts[2])` (`httpApi.js:207`) is an existence check only; **no owner is recorded on the record** (`sessionManager.js:82-86`) |

Prose in comments/README about "loopback only", "single-operator trust model", or
"operator-trusted config" is **not admissible** and is recorded as `NONE`.

**Why caller identity binding is `NONE`:** `checkToken` (`src/auth.js:3-9`) is a
constant-time comparison against a single shared secret — possession of a secret,
not a caller. No principal, claim, or subject is produced.

**Attacker profile:** any holder of the single bridge token, plus anyone who can
replay it. Token is accepted in the **query string** (`auth.js:14-16`) so it leaks
to logs, `Referer`, and history; it is **printed to stdout at boot**
(`server.js:29`). **No `Origin` / `Sec-Fetch-Site` check exists anywhere**, so a
cross-site `<form>`/`fetch` to `http://127.0.0.1:7681/api/sessions?token=…` is a
same-token, no-preflight request — a **web page in the victim's browser** is in
this class once it learns or guesses the token. Default bind is `127.0.0.1:7681`
(`config.js:202-203`) but `HOST`/`PORT` are env-configurable and the code applies
no bind-address restriction of its own.

**Attacker controls:** #26-35, #45. Most consequentially:
- **#27 — `cwd`** for `pty.spawn` (`httpApi.js:194` → `sessionManager.js:76` →
  `session.js:16`): an **unvalidated, unconstrained absolute path**.
- **#26 — `profile`**: selects *which binary* is spawned from the built-in table,
  including `generic` (operator-set command, may be `bash`, `config.js:123-133`).
- **#32 — `text`**, written into a **live, agentic AI coding CLI** running in the
  operator's shell with the operator's credentials (`promptWriter.js:9-18` →
  `session.write` → `pty.spawn`). Bracketed-paste wrapping for multiline; **no
  content filtering**.
- **#28/#29 — `cols`/`rows`** reaching `pty.spawn` and `@xterm/headless`
  `resize()` with **no numeric validation**.
- **#35 — `keys[]`** → `adapter.keySeq(k)`; behavior for unknown `k` must be
  checked per adapter.

**Attacker does NOT control:** `config.token` (unless leaked), the
`BUILTIN_PROFILES` table (`config.js:36-86`), the `envScrub` lists, `SHELL_CSP`
(`httpApi.js:92-102`), response security headers, `cli-pins.json` contents,
`PROFILE_*` env values, bind host/port, the ambient credentials of the AI CLIs.
Session ids are `crypto.randomUUID()` (`session.js:8`) — unguessable.

**Gate 3 baseline (existing capability):** a bridge-token holder can, per the
documented contract, create/list/delete PTY sessions, type text into them and read
rendered output, send named key sequences, and stream terminal output over SSE.
**NOT in the baseline** (still findable): controlling the child process's
**working directory**, escaping the vendor directory, hijacking or colliding with
another session, or reaching any of this from a **cross-origin web page** without
the operator's intent.

## Cross-cutting notes
- The single-shared-token model means "authenticated" ≈ one principal; any finding
  that lets one *session* affect another is meaningful despite that.
- **Phase 2 must treat `vendor/` as the effective production binary source** when
  reasoning about what `pty.spawn` actually executes.
- Child process → application is an **untrusted return path**: raw PTY bytes
  emitted by an LLM-driven process flow through `@xterm/headless` into a screen
  model and back out to the API client.
