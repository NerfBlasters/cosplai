# SG-3 — INJ trace results (WebSocket terminal)

Class group: SQL, command, path traversal, SSRF/URL, XSS, open redirect, XXE, LDAP,
API query lang, code eval/SSTI, file upload.

Files read: `src/wsApi.js`, `src/sessionManager.js`, `src/session.js`,
`src/terminalModel.js`, `src/auth.js`, `src/config.js`, `public/index.html`,
`src/httpApi.js` / `src/facade/*` (second-order readers only).

**No INJ-class candidates.** All four inputs resolve SAFE / DESIGN-INTENT for this
class group, with three CROSS-CLASS referrals.

---

## Dispositions

### #36 — WS query param `session` (`src/wsApi.js:11`)

**SAFE (INJ)** — `providedSid` flows only to `manager.get(providedSid)`
(`wsApi.js:12`), which is `Map.prototype.get` (`sessionManager.js:94`,
`_records` is a `Map` per `sessionManager.js:40`). A `Map` key lookup is not a
property access, so `__proto__` / `constructor` / `toString` cannot be used to
retrieve a non-record object. The value never reaches any SQL, command, path,
URL, HTML, template, or query-language sink. Miss → `existing = null` → the
create-fallback at `wsApi.js:37`, which passes `{}` (no attacker data).

**CROSS-CLASS (#36, `src/wsApi.js:11-12,37,45,54`, suspected class: NAV)** —
CWE-639. `?session=<id>` attaches to **any** live record with no ownership or
per-resource authorization check; `ownedByWs = !existing` (`wsApi.js:45`) only
governs teardown, not access. Attaching grants full scrollback read
(`wsApi.js:46`), a live data feed (`wsApi.js:47-48`), and write into the other
session's PTY (`wsApi.js:54`). Mitigating factor for NAV to weigh:
`session.id = crypto.randomUUID()` (`session.js:8`) is unguessable, so the id
must first leak (it is returned by the session-create API and appears in the
browser query string / `Referer` / history).

---

### #37 — WS query param `profile` (`src/wsApi.js:13,15,16,25-32,37`)

Two independent sinks traced.

**Sink A — raw `socket.write` 400 response (`src/wsApi.js:14-18`) — SAFE.**
Response-splitting / header-injection was the shape to disprove. The only
attacker-controlled text is `profileParam`, and it reaches the wire **only after
`JSON.stringify`** (`wsApi.js:15`), which escapes every control character
< 0x20 — including CR and LF — into the two-character sequences `\r` / `\n`.
Empirically verified (Gate 2b option (b)):

```
$ node -e 'console.log(JSON.stringify({error:"x\r\nHTTP/1.1 200 OK\r\n\r\nPWNED"}))'
{"error":"x\r\nHTTP/1.1 200 OK\r\n\r\nPWNED"}      # literal backslash-r/n, no real CRLF
```

No raw CRLF survives, so the status line and the two headers cannot be split or
appended to. `content-length` is computed with `Buffer.byteLength(body)`
(`wsApi.js:16`), so the framing matches the escaped body exactly — no smuggling
via a short/long length either.

Reflected-XSS in that body was also considered and rejected: the response is
served `content-type: application/json` (`wsApi.js:16`), and — decisively — this
code runs inside `server.on('upgrade', ...)` (`wsApi.js:6`), which Node only
fires for requests carrying `Connection: Upgrade`. A browser top-level
navigation or `<img>`/`<iframe>` load never triggers it, so there is no browsing
context in which the bytes are rendered. Not reachable as an HTML sink.

**Sink B — profile name → `pty.spawn` (`src/session.js:16`) — SAFE (no command
injection).** `profileParam` is used strictly as a **lookup key**, never as
command text:
`wsApi.js:26-27` (`config.profiles[effective]`) → `wsApi.js:37`
(`manager.create({ profile: profileParam })`) → `sessionManager.js:42-44`
(`c.profiles[name]`) → `sessionManager.js:76` (`command: p.command,
args: [...p.args]`) → `session.js:16` `pty.spawn(command, args, {...})`.
`p.command` / `p.args` originate solely from the `BUILTIN_PROFILES` table and
`PROFILE_*` env vars (`config.js:36-86`, `config.js:~120+`) — operator-controlled,
not request-controlled. `pty.spawn` is invoked with an argv array and no shell,
so even a hypothetical tainted `command` would not get shell metacharacter
interpretation.

Prototype-key abuse of the two `profiles[...]` property accesses was checked and
does not reach `spawn`: `profiles` is a plain `{}` (`config.js:~107`), so
`profiles['__proto__']` yields `Object.prototype` and `profiles['constructor']`
yields `Object`. Both are truthy and therefore skip the `!p` branch, but both
have `mode === undefined`, so `p.mode !== 'pty'` at `wsApi.js:29` fires and
`reject400` aborts before `handleUpgrade`. The same guard is duplicated at
`sessionManager.js:51-56`, with `!p.command` (`sessionManager.js:57-62`) as a
third backstop. No inherited key yields a `mode === 'pty'` object with a string
`command`.

`cwd` is likewise untainted: `sessionManager.js:76` uses `cwd || p.cwd`, and
`wsApi.js:37` never supplies a `cwd` — no path-traversal vector into the spawn
working directory.

---

### #38 — WS message raw bytes → `session.write` (`src/wsApi.js:52-54`)

**DESIGN-INTENT (INJ)** — `raw.toString()` → `rec.session.write(s)`
(`wsApi.js:54`) → `this._pty.write(data)` (`session.js:25`). Relaying operator
keystrokes verbatim into the PTY is the entire purpose of a terminal bridge;
Gate 0 applies (remove the input and the product ceases to exist), and the
partition's own Gate 3 baseline already grants a token holder "write to the
terminal". `pty.write` is a file-descriptor write to an already-spawned child,
not a shell/command-construction sink, so this is not CWE-78 — the child REPL
interpreting its own stdin is that program's contract, not an injection.

Second-order flow exhausted (store = `Session._ring`, `session.js:19-20`, which
captures the echo of attacker bytes). Every reader was traced:
- `session.scrollback()` → `ws.send` (`wsApi.js:46`) → `public/index.html:21`
  `term.write(...)`. xterm renders to canvas/DOM **as text**; there is no
  `innerHTML`, `insertAdjacentHTML`, `document.write`, or navigation sink
  anywhere in `public/index.html` (grepped). No DOM XSS.
- `session.scrollback()` → `src/facade/turnRunner.js:32` — substring scan for a
  spawn diagnostic, result returned as JSON.
- `terminalModel` renders (`terminalModel.js:14-31`) → `httpApi.js:33,38`,
  `facade/router.js:201,205`, `facade/streamRenderer.js:17`,
  `stateDetector.js:69,83`, adapter matchers — all consumed as plain strings and
  emitted in JSON API responses (returning the child CLI's output is the product's
  purpose). No reader interpolates terminal text into SQL, a command line, a file
  path, an outbound URL, HTML, or a template.

**CROSS-CLASS (#38, `src/wsApi.js:6-33`, suspected class: NAV)** — the `/ws`
upgrade performs **no `Origin` validation** before `wss.handleUpgrade`
(`wsApi.js:34`). Combined with the mandatory `?token=` query-param branch
(`auth.js:14-16`) and the token being printed to stdout at boot
(`server.js:29`), this is the cross-site WebSocket hijacking shape: an attacker
web page in the operator's browser that learns the token drives #38's arbitrary
PTY writes with no operator intent. Authorization/CSRF class, not INJ.

---

### #39 — WS message JSON `m.cols` / `m.rows` (`src/wsApi.js:53`)

**NO-MATCH (INJ)** — both values flow to `rec.session.resize(m.cols, m.rows)`
(`wsApi.js:53` → `session.js:26` → `node-pty` `TIOCSWINSZ` ioctl) and
`rec.terminalModel.resize(m.cols, m.rows)` (`terminalModel.js:10` → `@xterm/headless`
`Terminal.resize`). Both are numeric-parameter APIs; neither constructs a
command, query, path, URL, or markup. No sink in this class group is reached.

**CROSS-CLASS (#39, `src/wsApi.js:53` / `src/terminalModel.js:10`, suspected
class: NAV)** — noted while tracing, outside INJ scope. There is **no numeric
validation** on `m.cols` / `m.rows` (no `Number.isInteger`, no bounds, no
clamp). `session.resize` swallows throws in its own `try/catch`
(`session.js:26`), but `terminalModel.resize` (`terminalModel.js:10`) is
**unguarded** and is called from inside the `ws.on('message')` handler, which
has no surrounding `try/catch` at `wsApi.js:51-55` — a throw from
`Terminal.resize` propagates out of an EventEmitter callback as an uncaught
exception (process crash / DoS for all sessions). A large-but-valid `rows` also
inflates `end = b.baseY + this._rows` in `renderLinesSince`/`viewportTail`
(`terminalModel.js:16,24`), driving unbounded loops on every state-detector tick.
Availability/resource-exhaustion, not injection.

---

## Summary table

| # | Disposition (INJ) | Sink evaluated | Referral |
|---|---|---|---|
| 36 | SAFE — `Map.get`, no INJ sink | `sessionManager.js:94` | CROSS-CLASS NAV, CWE-639 (`wsApi.js:11-12,37`) |
| 37 | SAFE — `JSON.stringify` neutralizes CRLF; profile is a lookup key, argv-array spawn | `wsApi.js:16`; `session.js:16` | — |
| 38 | DESIGN-INTENT — PTY relay is the product; all second-order readers non-INJ | `session.js:25` | CROSS-CLASS NAV, CSWSH (`wsApi.js:6-33`) |
| 39 | NO-MATCH — numeric resize APIs only | `terminalModel.js:10` | CROSS-CLASS NAV, unvalidated resize → uncaught throw (`wsApi.js:53`) |
