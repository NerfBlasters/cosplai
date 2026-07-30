# SG-2 — INJ trace results (Bridge session REST API)

Class group: SQL, command, path traversal, SSRF/URL, XSS, open redirect, XXE,
LDAP, API query lang, code eval/SSTI, file upload.

Files read: `src/httpApi.js`, `src/sessionManager.js`, `src/session.js`,
`src/promptWriter.js`, `src/config.js`, `src/terminalModel.js`, `src/auth.js`,
`src/adapters/*.js`, `public/index.html`.

## Disposition table

| # | Variable | Disposition | Sink / reason |
|---|---|---|---|
| 26 | `profile` | SAFE | config-table lookup only |
| 27 | `cwd` | **CANDIDATE** | `session.js:16` `pty.spawn(..., {cwd})` — CWE-73 |
| 28 | `cols` | CROSS-CLASS (LOG) | `session.js:16`, `terminalModel.js:6` |
| 29 | `rows` | CROSS-CLASS (LOG) | `session.js:16`, `terminalModel.js:6` |
| 30 | (none) | NO-MATCH | no input |
| 31 | `parts[2]` | NO-MATCH + CROSS-CLASS (NAV) | `sessionManager.js:94` Map lookup |
| 32 | `text` | DESIGN-INTENT | `promptWriter.js:10` — the product's purpose |
| 33 | `submit` | NO-MATCH | boolean coercion |
| 34 | `timeoutMs` | NO-MATCH | `Number.isFinite` gate |
| 35 | `keys[]` | SAFE (Gate 3) | `httpApi.js:178` — outcome duplicated by #32 |
| 45 | PTY/LLM output | SAFE | JSON-encoded on every egress path |

---

## Candidates

### [VULN-SG2-INJ-001] Unvalidated `cwd` body field controls the spawned AI-CLI working directory

- **Input**: #27 — HTTP body field `cwd` on `POST /api/sessions`
- **Class**: CWE-73 (External Control of File Name or Path); related CWE-22
- **Severity**: Medium
- **Location**: `/home/kali/repos/cosplai/src/session.js:16`
- **Entry Point**: `POST /api/sessions` (`src/httpApi.js:133-137`)
- **Gate 0 (intended behavior?)**: **Contested.** `README.md:212` and
  `docs/API.md:39` document the body as `{cwd?, cols?, rows?, profile?}`, so a
  caller-supplied cwd is nominally a feature. However the partition threat model
  explicitly places "controlling the child process's **working directory**"
  *outside* the Gate 3 baseline, and there is **no constraining mechanism at
  all** — no allowlist env var, no root-prefix containment, no existence/type
  check. Flagged for Phase 2b adjudication rather than silently dismissed.
- **Gate 1 (reachable?)**: Reachable. `manager.create(b)` at `httpApi.js:137`
  is the production `POST /api/sessions` handler; `SessionManager.create` is
  also reached from the WS path. Not dev-gated.
- **Gate 2a (attacker-controlled?)**: Yes. Raw JSON body field, parsed at
  `httpApi.js:67`, destructured at `sessionManager.js:41`, passed verbatim as
  `cwd || p.cwd` at `sessionManager.js:76`, then `pty.spawn(command, args,
  {... cwd ...})` at `session.js:16`. No transformation on the path.
- **Gate 2b (sanitization?)**: **None.** No `path.resolve` containment, no
  `..` stripping, no base-directory prefix check, no `fs.statSync` type check,
  no string-type check anywhere between `httpApi.js:134` and `session.js:16`.
- **Gate 3 (new capability?)**: The operator configures the intended working
  directory via `CWD` / `PROFILE_<NAME>_CWD` (`config.js:94`, `config.js:183`).
  A body field silently overrides that operator setting for every session. The
  spawned child is an **agentic AI coding CLI running with the operator's
  ambient credentials**, and these CLIs resolve *project-scoped* configuration
  from their cwd (e.g. `CLAUDE.md`, `.claude/settings.json` — which supports
  hooks that execute commands). Choosing the cwd therefore selects which
  on-disk project config and instruction files the agent loads, and it does so
  with `dialogPolicy: 'startup-only'` (`config.js:41`) auto-answering the
  trust/onboarding dialog that would otherwise gate an untrusted directory
  (`sessionManager.js:18-37`). That is a capability the documented baseline
  (create/list/delete sessions, type text, read output, send keys) does not
  confer.
- **Data Flow**:
  `POST /api/sessions` body → `readBody` (`src/httpApi.js:67`) →
  `manager.create(b)` (`src/httpApi.js:137`) →
  `create({profile, cwd, cols, rows})` (`src/sessionManager.js:41`) →
  `new Session({... cwd: cwd || p.cwd ...})` (`src/sessionManager.js:76`) →
  `pty.spawn(command, args, {name, cols, rows, cwd, env})`
  (`src/session.js:16`)
- **Root Cause**: `SessionManager.create` accepts the caller's `cwd` verbatim
  and lets it override the operator-configured profile cwd, with no allowlist,
  containment, or type validation.
- **Exploitability**: Single unauthenticated-shaped request for anyone holding
  the single shared bridge token (which is printed to stdout at boot and
  accepted in the query string, `auth.js:14-16`). No `Origin` /
  `Sec-Fetch-Site` check exists, so a cross-site `fetch`/`<form>` from a page in
  the operator's browser can issue it. Note the token holder must also know or
  plant the target directory's contents to reach code execution, so this is a
  chain rather than a one-shot RCE — hence Medium, not High.

---

## Non-candidates (with reasoning)

**#26 `profile` — SAFE.** Used only as a key into the frozen built-in profile
table: `c.profiles[name]` (`sessionManager.js:44`). It never reaches a spawn
argument directly — `command`/`args` come from the table entry
(`config.js:161-184`). Prototype-chain keys were checked: `profile:
"constructor"` / `"__proto__"` return a truthy non-profile object, but
`p.mode !== 'pty'` (`sessionManager.js:51`) then throws `PROFILE_NOT_PTY` → 400,
and `p.command` is likewise absent. No command-injection path. Selecting which
allowlisted binary spawns is Gate 0 design intent (`config.js:36-86`).

**#28 `cols` / #29 `rows` — CROSS-CLASS (LOG).** No numeric validation:
`cols || p.cols` (`sessionManager.js:78,80`) reaches `pty.spawn` cols/rows
(`session.js:16`) and `new Terminal({cols, rows, scrollback})`
(`terminalModel.js:6`). Values like `1e9`, negatives, or non-numeric types are
passed through to native/`@xterm/headless` allocation. This is a
resource-exhaustion / unhandled-crash concern, not an injection sink.
→ CROSS-CLASS (#28/#29, `src/session.js:16` and `src/terminalModel.js:6`,
suspected class: LOG).

**#30 `GET /api/sessions` — NO-MATCH.** No input; response is built from
server-generated fields (`httpApi.js:147`).

**#31 session id `parts[2]` — NO-MATCH for INJ.** Used solely as a
`Map.get` key (`sessionManager.js:94`) — no filesystem path, no query string, no
URL construction. It is never concatenated into any INJ sink. However, per the
shared file's resource-ID rule: no owner is recorded on the record
(`sessionManager.js:82-86`) and `manager.get(parts[2])` (`httpApi.js:150`) is an
existence check only, so `GET`/`DELETE`/`prompt`/`key`/`events` on any session id
are unauthorized-by-identity. IDs are `crypto.randomUUID()` (`session.js:8`), so
unguessable — bounded, but the authorization gap is real.
→ CROSS-CLASS (#31, `src/httpApi.js:150`, suspected class: NAV, CWE-639).

**#32 `text` — DESIGN-INTENT.** `b.text` (`httpApi.js:162,165`) →
`writeAndSubmitPrompt` → `writePromptText` → `session.write(text)`
(`promptWriter.js:10,13,16`) → `pty.write` (`session.js:25`). Raw, unfiltered
bytes into the live CLI, including ANSI/control sequences. Gate 0: typing
caller-supplied text into the attached CLI **is** the application's entire
purpose and the documented contract (`README.md:212`, `docs/API.md`); removing
this input removes the product. The interesting question here — that the text is
consumed by an agentic LLM with the operator's credentials — is prompt-injection
/ trust-boundary design, not an INJ-class sink.

**#33 `submit` — NO-MATCH.** `b.submit !== false` (`httpApi.js:165`) collapses
to a boolean used only as a branch in `writeAndSubmitPrompt`
(`promptWriter.js:29`). No sink.

**#34 `timeoutMs` — NO-MATCH.** Gated by `Number.isFinite(b.timeoutMs)`
(`httpApi.js:164`) with a config fallback; used only as a `setTimeout` duration
in the settle wait. Type-constrained to a finite number; no INJ sink. (A
negative/zero value shortens the settle window — a LOG-class robustness nit at
most, not injection.)

**#35 `keys[]` — SAFE (eliminated at Gate 3).** Real mechanism: every adapter's
`keySeq` falls through to `String(name)` for an unrecognized key
(`adapters/claude.js:96-98`, `codex.js:86-88`, `copilot.js:74-76`,
`antigravity.js:61-63`, `generic.js:22-24`), so
`rec.session.write(rec.adapter.keySeq(k))` (`httpApi.js:178`) writes arbitrary
attacker bytes straight into the PTY. But the identical outcome — arbitrary raw
bytes into the same PTY — is already reachable via #32: single-line `text` is
written verbatim by `session.write(text)` at `promptWriter.js:10`, with no
bracketed-paste wrapping and no filtering. Fixing one would not be required to
fix the other's *outcome*; the attacker gains nothing new. Gate 3 eliminates.
Worth noting for LOG: a non-iterable `b.keys` (e.g. a number) makes the
`for...of` at `httpApi.js:178` throw → 500.

**#45 PTY output (LLM-generated) — SAFE for INJ.** Traced every egress:
`session.on('data')` → `terminalModel.write` (`sessionManager.js:81`) →
`renderLinesSince` / `viewportTail` (`terminalModel.js:14,22`) →
`sendPrompt` return (`httpApi.js:33-39`) → `json(res, 200, out)`
(`httpApi.js:44`, `JSON.stringify`, `content-type: application/json`). The SSE
path `data: ${JSON.stringify({type:'output', data:d})}\n\n`
(`httpApi.js:185-186`) is also JSON-encoded, so embedded `\n`/`\r` are escaped
to `\\n`/`\\r` and cannot forge SSE frame boundaries. The only in-repo browser
consumer, `public/index.html`, pipes bytes to `term.write()` on an
`@xterm/headless`/xterm canvas (`public/index.html:21`) — no `innerHTML`,
`insertAdjacentHTML`, `document.write`, `eval`, `new Function`, or navigation
sink exists anywhere in `public/`. No HTML/template rendering of this text in
the audited code. (Second-order caveat outside INJ: this text is an untrusted
LLM-controlled return path for API clients that *do* render HTML.)

---

## Incidental observation (input not in this partition's inventory)

`GET /vendor/*` static handler (`httpApi.js:117-121`): `path.resolve(PUBLIC,
'.' + u.pathname)` followed by `f !== VENDOR && !f.startsWith(VENDOR +
path.sep)` → 403. This is a correct post-resolution containment check
(`path.resolve` normalizes `..` before the prefix test, and the `+ path.sep`
guards the `vendor-evil/` sibling-prefix bypass). **Not a traversal candidate.**

## Absent-input analysis (mandatory)

- Token omitted → `extractToken` returns `null` (`auth.js:16`) → `checkToken`
  returns `false` on the `typeof provided !== 'string'` guard (`auth.js:4`) →
  401. **Fails closed.**
- Body omitted / malformed JSON → `readBody` swallows the parse error and
  resolves `{}` (`httpApi.js:67`) → `create({})` → all four fields `undefined` →
  every `x || p.x` falls back to operator config. **Fails closed** for #26-29.
  (The swallow itself is a robustness/consistency defect versus the façade's 400
  at `facade/shared.js:74` — LOG-class, not INJ.)
- `text` omitted → `typeof b.text !== 'string'` → 400 (`httpApi.js:162`).
  **Fails closed.**
- `keys` omitted → `(b.keys || [])` → empty loop (`httpApi.js:178`). No writes.
- No Conditional Validation Bypass found: the token gate at `httpApi.js:129` is
  unconditional for every `/api/*` route and has no input-presence predicate.
