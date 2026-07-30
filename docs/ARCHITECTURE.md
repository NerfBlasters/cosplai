# Architecture

One Node process (ESM) owns a PTY running an interactive CLI — `claude` by
default, or any other built-in **profile** (`codex`, `antigravity`, `copilot`,
`generic`) — and exposes it to a browser terminal and a programmatic API. For
the full design rationale see the
[original design spec](superpowers/specs/2026-07-02-interactive-claude-session-bridge-design.md)
and the
[universal-CLI-support spec](superpowers/specs/2026-07-23-universal-cli-and-api-facade-design.md);
this is the runtime map.

```
   browser (xterm.js) ──WS───┐
                             ├─▶  Bridge (single Node process)  ──▶ node-pty ──▶ profile's CLI (claude by default, subscription/OAuth)
   your app ──HTTP/SSE───────┘        │
                                      ├─ SessionManager   owns Session records; resolves profile → command/adapter/envScrub
                                      ├─ Session          node-pty child + raw ring buffer (scrollback)
                                      ├─ TerminalModel     @xterm/headless render of the stream (for detection + clean text)
                                      ├─ StateDetector     quiescence timer + adapter markers → state machine
                                      ├─ adapters/         claude | codex | antigravity | copilot (version-pinned markers; antigravity/copilot degraded/alt-screen) | generic (quiescence=idle)
                                      ├─ PromptQueue       per-session FIFO (serializes prompts)
                                      ├─ httpApi           token-gated routes + SSE + static
                                      └─ wsApi             token-gated WS upgrade → terminal binding
```

## Modules (`src/`)

| File | Responsibility |
|---|---|
| `config.js` | env → frozen config, including the **profiles table** (`BUILTIN_PROFILES` merged with `PROFILE_<NAME>_*` / `BRIDGE_PROFILES` / `DEFAULT_PROFILE` env, four-level precedence — see [API.md § Profiles](API.md#profiles)) and **vendor-first command resolution** (a pinned bin under `vendor/` beats host `PATH` unless the command was explicitly overridden or `BRIDGE_USE_HOST_CLIS=1`) |
| `pins.js` | `cli-pins.json` manifest: load/validate, `npm` dependency derivation, version-token extraction (shared by the pin script and the handshake) |
| `versionCheck.js` | boot handshake: `--version` every pinned binary the enabled profiles would spawn, warn on drift (`applyStrict` makes it fatal under `BRIDGE_STRICT_VERSIONS=1`) |
| `auth.js` | timing-safe token check + extraction (header or `?token=`) |
| `session.js` | `Session`: spawns the PTY child, **strips the profile's `envScrub` list** from the child env (profile-driven; the legacy `ADAPTER=generic` combination still scrubs `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` for back-compat), emits `data`/`exit`, bounded ring buffer via `scrollback()` |
| `terminalModel.js` | `@xterm/headless` terminal fed the raw stream; `snapshotLineCount` / `renderLinesSince` (clean text) / `viewportTail` (for markers) |
| `adapters/` | `claude` \| `codex` \| `antigravity` \| `copilot` \| `generic` — each with idle/busy/awaiting markers + `extractResponse` derived from real captured fixtures (`index.js` is the strict name→module registry, throws on an unknown name). `antigravity` and `copilot` are **degraded (alt-screen)**: both draw in the alternate screen buffer, so state-marker detection is reliable but `extractResponse` is best-effort; `claude`, `codex`, `generic` are not degraded |
| `stateDetector.js` | on each chunk: set `busy` + re-arm a quiescence timer; on quiet, classify `viewportTail` via the adapter → `idle`/`awaiting_input`; for adapters with an `isBusy` marker, also runs a periodic tick (see Readiness detection below); `waitForSettle()` |
| `promptQueue.js` | per-session FIFO so concurrent prompts never interleave |
| `sessionManager.js` | creates/holds/reaps session records `{id, session, terminalModel, detector, adapter, queue, createdAt, profile, dialogPolicy}`; resolves the requested/default profile, wires `data → terminalModel.write`, and builds each record's `dialogHandler` (`makeDialogHandler`, applying the profile's `dialogPolicy` to auto-answer `startupDialogs` before the detector settles a turn) and passes it into the `StateDetector` |
| `httpApi.js` | `createHttpServer` — session CRUD (`profile` param, `400 {error, validProfiles}` on an unusable profile), `sendPrompt` (snapshot → write+submit → `waitForSettle` → `renderLinesSince` → `adapter.extractResponse` for `text`), `/key`, SSE, static (`/vendor` unauthenticated) |
| `wsApi.js` | `attachWss` — token-checked WS upgrade; validates the effective creation profile pre-upgrade (`400` before the handshake) when `?profile=` or the default would spawn a new session; binds a browser terminal to a session; **reaps sessions it auto-created** on socket close |
| `server.js` | composition root: config → resolved-path log + version handshake → manager → http → ws → listen, prints the URL+token |

## Data flow (a prompt)

`POST /prompt` → PromptQueue → `snapshotLineCount()` → `markBusy()` → write text +
submit key → StateDetector observes the new output, re-arms quiescence, settles
to `idle`/`awaiting_input` → `renderLinesSince(before)` returns the cleaned
transcript delta. The browser, attached to the **same PTY**, renders the whole
thing live.

## Readiness detection (the hard part, honestly)

The interactive CLIs are full-screen TUIs, not `stream-json` streams, so there
is no exact "response complete" signal. State is inferred from **output
quiescence** (no bytes for `QUIESCENCE_MS`) plus **rendered-screen markers**
read from the headless terminal (e.g. the `? for shortcuts` footer = idle,
`esc to interrupt` = busy, the trust-dialog text = awaiting_input). This is
**best-effort** and the markers are **version-pinned** — the single fragile
surface, isolated per-CLI under `src/adapters/` and backed by fixtures under
`test/fixtures/`. `sendPrompt` calls `markBusy()` before writing so a settle
can't short-circuit on the pre-prompt idle screen. For CLIs that repaint a
spinner/status footer continuously and so never go output-quiescent (any
adapter exposing `isBusy`), `StateDetector` also runs a periodic re-evaluation
of the markers on every `quiescenceMs` tick while output keeps flowing,
classifying the session `idle` once two consecutive ticks see `isIdle` and
not `isBusy` — this is what lets those CLIs settle at all, since quiescence
alone never fires for them.

## Security model

- Binds `127.0.0.1` only. Every HTTP route and the WS upgrade require the token
  (`crypto.timingSafeEqual`); `/vendor/*` static libs are the only
  unauthenticated surface, path-traversal-guarded.
- Child PTY env has the profile's `envScrub` list stripped (moved off a
  hardcoded `ANTHROPIC_*` delete onto per-profile lists in `config.js` —
  `claude` scrubs `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, other built-ins
  scrub their own provider's key vars) → uses subscription/OAuth login, not
  API billing. This is **best-effort**: it blocks the documented env-var
  auth paths only — file-based auth (e.g. `~/.claude/.credentials.json`,
  `~/.codex/auth.json`, gcloud ADC files, the `gh` keyring) is out of scrub's
  reach and stays the operator's responsibility (per-profile detail in the
  [README](../README.md#env-scrub-per-profile)).
- The token grants full interactive control of the spawned CLIs (which can run
  tools / execute code). Single-operator/localhost by design. Before exposing
  the bridge beyond one operator (any team console or shared deployment), add
  — outside the bridge:
  - real per-user authN/Z (SSO/OIDC) in front; never hand the raw bridge
    token/port to multiple users' browsers;
  - per-user isolation — separate sessions per user at least; for true
    isolation, a separate bridge process per user with that user's own CLI
    login;
  - TLS termination + network policy (it binds loopback; front it with an
    authenticating reverse proxy on an internal network/VPN);
  - secrets management for the bridge token(s);
  - audit logging of who drove which session and what prompts ran;
  - host hardening — the host runs CLIs with tool/exec access; treat it as
    sensitive and egress-controlled.

## Testing

`node --test` runs the full offline suite. The whole HTTP/PTY/WS pipeline is exercised against
`bash` + the `generic` profile (no subscription usage); the `claude`, `codex`,
`antigravity`, and `copilot` adapters are verified against captured fixtures
(`test/adapters.test.js`, `test/stateDetector.test.js`); the interactive
`claude` session itself was verified live end-to-end (prompt round-trip +
browser render).
