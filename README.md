# cosplai

> *anything is an API if you want it to be* — interactive AI CLIs, cosplaying as cloud APIs.

(cosplai grew up as `pty-web-bridge` — the dated build records under `docs/superpowers/` keep the old name.)

A local Node service that owns real PTY-backed **interactive** AI-CLI sessions
(`claude`, `codex`, `copilot`, `antigravity` — or any REPL via the `generic`
profile) and exposes each session three ways at once: a browser `xterm.js`
terminal over WebSocket so a human can watch and type live, a token-gated
HTTP + SSE API so a program can drive the *same* session — send prompts, send
raw keys, and read back state and output — and an OpenAI/Anthropic-compatible
**cloud-API facade**, so any OpenAI or Anthropic SDK client can drive a
subscription-authenticated CLI as if it were a hosted API. All interfaces
attach to the same underlying sessions, so a script can drive a flow while a
human watches it happen in the browser.

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — module map, data flow,
  readiness detection, security model.
- **[docs/API.md](docs/API.md)** — full HTTP / SSE / WebSocket reference + curl.
- **[docs/guides/fabric-openai-endpoint.md](docs/guides/fabric-openai-endpoint.md)**
  — end-to-end guide: fabric as an OpenAI client against the copilot-backed
  facade.
- **[docs/](docs/)** — index, plus the original design spec and build plan.
- **[docs/superpowers/specs/2026-07-23-universal-cli-and-api-facade-design.md](docs/superpowers/specs/2026-07-23-universal-cli-and-api-facade-design.md)**
  — the design spec for universal (multi-CLI) profile support and the
  OpenAI/Anthropic cloud-API facade (see its as-built addendum for the two
  deviations that shipped).

Use it **standalone** (browser terminal + `curl`) or as a **building block**:
the facade speaks the OpenAI and Anthropic wire protocols, so anything that
can talk to those APIs — SDKs, agent frameworks, existing tooling — can sit
on top of the bridge without knowing it exists.

## Support tiers

| Tier | Profiles | What you get |
|---|---|---|
| First-class | `claude`, `codex`, `claude-headless`, `copilot-headless` | Live-verified adapters, full response extraction (`claude-headless` / `copilot-headless`: byte-exact output; `claude-headless` reports real input+output usage, `copilot-headless` real output tokens with an estimated input) |
| Best-effort | `copilot`, `antigravity` | Reliable state detection; alt-screen UIs make response extraction best-effort (`copilot`'s facade extraction is empty since 1.0.75, re-verified on 1.0.76 — use `copilot-headless` for the API) |
| Bring-your-own | `generic` | Any REPL; quiescence-based readiness only |

## Why PTY / interactive CLIs (not the vendors' SDKs)

The only reason this project drives real terminals instead of calling APIs is
**subscription auth**. Every supported CLI authenticates via a subscription
login its vendor's API SDKs cannot use: `claude` via the Max/Pro OAuth login
stored in `~/.claude/.credentials.json` (the Claude Agent SDK is
API-key-only), `codex` via a ChatGPT login, `copilot` via its own device-code
login stored under `~/.copilot` (separate from the `gh` CLI's keyring, which
is only for the `gh` tool), `agy` via a Google account. Driving the real
interactive REPL over a PTY is the only way to automate a session on those
subscriptions, so that's what this does — everything else in the design
follows from that constraint. (The one partial exception: `claude -p` and
`copilot -p` do honor the subscription login, which is what the
`claude-headless` and `copilot-headless` profiles exploit for exact-fidelity
output.)

## Subscription auth requirement

- Run this as the user who is already logged in to each CLI you enable (for
  the default `claude` profile: `claude /login` has been completed and
  `~/.claude/.credentials.json` exists). The bridge does not perform login —
  it only drives already-authenticated CLIs.
- `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` **must not** reach the child
  `claude` process, or it will use API-key auth instead of the subscription.
  The bridge handles this for you, but the mechanism is **per-profile**, not a
  single hardcoded rule: each profile carries an `envScrub` list of env var
  names deleted from the environment handed to its spawned PTY child, even if
  they're set in the parent shell. The built-in `claude` profile's list is
  `['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']`; the legacy `ADAPTER=generic`
  combination inherits the same two entries for back-compat (see
  [Env-scrub, per profile](#env-scrub-per-profile) below for the full picture,
  including the other built-in profiles). You don't need to unset these
  yourself, but be aware the stripping is silent — if you're trying to test
  API-key behavior through this tool, you can't; the child never sees those
  variables. A profile's `envScrub` array (`src/config.js`) is the source of
  truth for exactly what it blocks.

## Security

- Binds to **127.0.0.1 only** (`HOST` defaults to loopback; don't change this
  to `0.0.0.0` without adding your own network-level protection).
- **Every** HTTP route (except `/vendor/*`) and the WebSocket upgrade require a
  bearer/query token, checked with a timing-safe comparison
  (`crypto.timingSafeEqual` in `src/auth.js`).
- To reach it from another machine, use an SSH tunnel:
  `ssh -L 7681:127.0.0.1:7681 user@host`, then browse to
  `http://127.0.0.1:7681/?token=...` locally. Do not open the port directly.
- **Treat the token as a high-value secret.** It grants full interactive
  control of every enabled CLI — including whatever tools/commands those CLIs
  can run on your behalf. Anyone with the token has the same reach into your
  machine that you do through the CLIs themselves.
- The only unauthenticated surface is `GET /vendor/*` (the vendored xterm.js
  static assets needed to render the login-less page shell); everything else
  is gated.
- Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options:
  DENY`, and `Referrer-Policy: no-referrer` — the last one matters because the
  token rides in the query string, and a default referrer policy would leak it
  in the `Referer` of any outbound navigation. The terminal shell additionally
  gets a `default-src 'none'` CSP whose `connect-src 'self'` is the
  browser-enforced backstop on the WebSocket URL the page builds.
- **HSTS is emitted only over real TLS.** The bridge serves plain HTTP on
  loopback, and [RFC 6797 §7.2](https://www.rfc-editor.org/rfc/rfc6797#section-7.2)
  says a browser MUST ignore `Strict-Transport-Security` received over
  non-secure transport — so sending it here would be a no-op at best, and
  harmful at worst (an STS entry pinned for `localhost` forces `https://` on
  every other local service on that hostname). It is sent when the socket is
  genuinely encrypted, or when a TLS-terminating reverse proxy you have opted
  into trusting (`BRIDGE_TRUST_PROXY=1`) reports `X-Forwarded-Proto: https`.
  Leave `BRIDGE_TRUST_PROXY` off unless such a proxy is in front of the bridge
  *and* it overwrites that header — otherwise any client can spoof it.
- **Operator-scope only.** This is for driving your own sessions for your own
  automation on your own machine. Do not re-expose this bridge (or a service
  built on it) as a product to other end users — the CLI vendors' subscription
  terms (Anthropic's, OpenAI's, GitHub's, Google's) restrict
  subscription-authenticated access to the individual account holder.

## Quick start

```bash
npm install
npm start
# cosplai listening.
# Open: http://127.0.0.1:7681/?token=<generated-token>
```

Open the printed URL in a browser to get a live terminal. To pin the token
(and other settings) instead of getting a random one each run:

```bash
BRIDGE_TOKEN=some-long-random-string PORT=7681 npm start
```

## Profiles

A **profile** fully describes one CLI the bridge can drive: which command to
spawn, which adapter interprets its screen, which env vars to scrub from its
child process, its dialog-auto-answer policy, and its PTY sizing/cwd. Every
session belongs to exactly one profile, selected via `profile` on `POST
/api/sessions` / `?profile=` on `GET /ws`, or `DEFAULT_PROFILE` when none is
given. See [docs/API.md](docs/API.md#profiles) for the full `PROFILE_<NAME>_*`
override reference and precedence order.

Built-in profiles (`src/config.js`):

| Profile | Command | Adapter | Notes |
|---|---|---|---|
| `claude` | `claude` | `claude` | default; Claude Code, subscription OAuth |
| `codex` | `codex` | `codex` | OpenAI Codex CLI |
| `antigravity` | `agy` | `antigravity` | Google's Antigravity CLI (see below) — **degraded** |
| `copilot` | `copilot` | `copilot` | GitHub Copilot CLI — **degraded** (facade extraction empty since 1.0.75, re-verified on 1.0.76; use `copilot-headless` for the API) |
| `generic` | *(none — set `PROFILE_GENERIC_COMMAND`)* | `generic` | any line-based CLI; quiescence-only state detection |
| `claude-headless` | `claude` | *(none, `mode: headless`)* | facade-only; byte-exact `claude -p` stream-json; rejected by the session/WS API today |
| `copilot-headless` | `copilot` | *(none, `mode: headless`)* | facade-only; byte-exact `copilot -p --output-format json`, tool-locked; rejected by the session/WS API today |

`antigravity` targets Google's `agy` CLI, the supported successor to the
standalone `gemini` CLI — that CLI's individual-account OAuth was sunset, so
there is no `gemini` profile; `agy` is what actually authenticates on a
Google/Gemini subscription today.

**Degraded (alt-screen) adapters:** `antigravity` and `copilot` both draw in
the terminal's alternate screen buffer and repaint in place rather than
scrolling. State detection (idle/busy/awaiting-input) is unaffected and fully
reliable for both, but `extractResponse` (the `text` field on `POST /prompt`
— see [docs/API.md](docs/API.md)) is **best-effort**: the rendered-transcript
diff it relies on isn't a dependable scrollback across alt-screen repaints —
and since copilot 1.0.75 (re-verified on 1.0.76) it extracts **empty** (the answer paints on screen
but the line count never advances). For `copilot`, the exact-fidelity path is
the `copilot-headless` profile (byte-exact `copilot -p --output-format json`);
prefer it for API use. For `antigravity`, exact extraction remains future
work. `claude`, `codex`, and `generic` are not degraded.

**`dialogPolicy: auto-approve` — security warning.** The default policy,
`startup-only`, only auto-answers dialogs the adapter explicitly recognizes,
and always with a safe choice: claude's once-per-launch trust prompt is
accepted, and codex's startup update prompt is answered "Skip until next
version" — the bridge never lets a CLI self-update unattended, so codex
updates are the operator's to run manually. `auto-approve` goes further: it also
default-accepts (`Enter`) any *unmatched* dialog the bridge can't identify,
capped at two answers per persisting screen. This is an **explicit opt-in**
you must set yourself (`PROFILE_<NAME>_DIALOG_POLICY=auto-approve`) — it means
the bridge will blindly hit Enter on a dialog it doesn't understand, without
you seeing what it said first. Only enable it for unattended, trusted
automation where you accept that risk; leave it at `startup-only` (or
`never`) for anything you want to review interactively.

## Env-scrub, per profile

Each profile's `envScrub` list (`src/config.js`) is the **source of truth**
for which env vars are deleted from that profile's spawned child process, so
API-key auth can't silently override subscription/OAuth auth. This is
**best-effort**: it blocks the documented API-key env vars, not file-based
auth — file-based credentials are unaffected by env-scrub and remain the
operator's responsibility to manage.

| Profile | Scrubs (env vars) | File-based auth env-scrub can't reach |
|---|---|---|
| `claude` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | `~/.claude/.credentials.json` |
| `codex` | `OPENAI_API_KEY`, `CODEX_API_KEY` | `~/.codex/auth.json` |
| `antigravity` (`agy`) | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_CLOUD_LOCATION` | Google account session / gcloud Application Default Credentials files |
| `copilot` | `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, `COPILOT_ALLOW_ALL` | copilot's own device-login store in `~/.copilot` (`config.json`) |
| `copilot-headless` | `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, `COPILOT_ALLOW_ALL` | same `~/.copilot` device-login store |
| `generic` | *(none by default)* | whatever the configured command uses |

`COPILOT_ALLOW_ALL` is not a credential — it is the env form of copilot's
`--allow-all-tools`. The copilot profiles scrub it so an ambient value can't
grant a bridge-spawned copilot blanket tool autonomy; `copilot-headless`
additionally hard-locks tools in its runner (see below).

The legacy `ADAPTER=generic` combination (back-compat: `DEFAULT_PROFILE`
becomes `generic`) inherits the `claude` profile's two `ANTHROPIC_*` entries,
so an existing `ADAPTER=generic CLAUDE_CMD=<tool>` deployment doesn't
regress. A `generic` profile chosen by name (`profile: "generic"`) stays
scrub-free, matching its table entry.

## Programmatic API

All routes below (except `/vendor/*`) require the token, either as
`Authorization: Bearer <token>` or `?token=<token>` in the URL (used by the
browser page for the WebSocket upgrade, since browsers can't set arbitrary
headers on a WS handshake).

| Route | Method | Body | Response |
|---|---|---|---|
| `/api/sessions` | POST | `{cwd?, cols?, rows?, profile?}` (all optional) | `201 {id, state, profile}` or `400 {error, validProfiles}` |
| `/api/sessions` | GET | — | `200 {sessions: [{id, state, createdAt, profile}]}` |
| `/api/sessions/:id` | GET | — | `200 {id, state, createdAt, profile}` or `404` |
| `/api/sessions/:id` | DELETE | — | `204`, kills the PTY |
| `/api/sessions/:id/prompt` | POST | `{text, submit?, timeoutMs?}` | `200 {state, output, text, prompt, durationMs}` |
| `/api/sessions/:id/key` | POST | `{keys: [...]}` | `200 {state}` |
| `/api/sessions/:id/events` | GET | — | `text/event-stream` of `{type:'output',data}` / `{type:'state',state}` |
| `/ws` | GET (upgrade) | `?token=&session=&profile=` | terminal binding, or pre-upgrade `400 {error, validProfiles}` |

`state` is one of `starting`, `busy`, `idle`, `awaiting_input`, `exited`. See
[Profiles](#profiles) above for `profile`, and
[docs/API.md](docs/API.md) for full endpoint semantics.

Create a session and send a prompt:

```bash
TOKEN=your-token
ID=$(curl -s -X POST http://127.0.0.1:7681/api/sessions \
  -H "Authorization: Bearer $TOKEN" -d '{}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

curl -s -X POST http://127.0.0.1:7681/api/sessions/$ID/prompt \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"reply with exactly: PONG"}'
# {"state":"idle","output":"...PONG...","text":"PONG","prompt":null,"durationMs":1234}
```

`POST /prompt` writes `text` into the session, submits it (Enter, unless
`submit:false`), and waits for the session to settle to `idle` or
`awaiting_input` (up to `timeoutMs`, default `PROMPT_TIMEOUT_MS`). `output` is
the raw rendered-transcript delta since the prompt was sent (see caveat
below); `text` is that same delta run through the profile's adapter
`extractResponse` — chrome-stripped assistant text, best-effort for the
degraded `antigravity`/`copilot` adapters (see [Profiles](#profiles)).
`prompt` is a description of what's being asked when the session lands in
`awaiting_input` instead of `idle` (null otherwise). A multiline `text` that
the profile's adapter can't safely submit (no bracketed-paste support and no
newline-key fallback) is rejected with `400`.

`POST /key` sends raw key sequences without going through the prompt-and-wait
flow — used for menus/dialogs. Recognized names: `enter`/`submit`, `up`,
`down`, `left`, `right`, `esc`, `tab`, `ctrl-c`; anything else is sent
verbatim as literal text.

`GET /events` is a Server-Sent Events stream: `output` events carry raw PTY
bytes as they arrive, `state` events fire on every state transition. No replay
of prior output is sent on connect — only live events from the moment you
subscribe (unlike the WebSocket terminal view, which replays scrollback
first).

## Cloud-API facade

The bridge also speaks the OpenAI and Anthropic wire protocols: point any tool
that expects an OpenAI- or Anthropic-compatible endpoint at the bridge and it
drives the underlying interactive CLIs — official SDKs work unmodified,
including streaming and their native exception types. Full route reference:
[docs/API.md § Cloud-API facade](docs/API.md#cloud-api-facade).

- **Base URLs:** `http://127.0.0.1:7681/v1` for OpenAI SDKs;
  `http://127.0.0.1:7681` for the Anthropic SDK (it appends `/v1/messages`
  itself).
- **API key = the bridge token**, sent as `Authorization: Bearer <token>`
  (OpenAI family) or `x-api-key: <token>` (Anthropic family — Bearer also
  accepted).
- **`model` = profile name** (`claude`, `codex`, `claude-headless`, …). List
  what's available via `GET /v1/models`.

```python
# pip install openai
from openai import OpenAI
client = OpenAI(api_key="<bridge-token>", base_url="http://127.0.0.1:7681/v1")
r = client.chat.completions.create(model="claude",
    messages=[{"role": "user", "content": "reply with exactly: PONG"}])
print(r.choices[0].message.content)
```

```js
// npm install openai
import OpenAI from 'openai';
const client = new OpenAI({ apiKey: '<bridge-token>', baseURL: 'http://127.0.0.1:7681/v1' });
const r = await client.chat.completions.create({
  model: 'claude', messages: [{ role: 'user', content: 'reply with exactly: PONG' }],
});
console.log(r.choices[0].message.content);
```

```python
# pip install anthropic
from anthropic import Anthropic
client = Anthropic(api_key="<bridge-token>", base_url="http://127.0.0.1:7681")
m = client.messages.create(model="claude", max_tokens=100,
    messages=[{"role": "user", "content": "reply with exactly: PING"}])
print(m.content[0].text)
```

```js
// npm install @anthropic-ai/sdk
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: '<bridge-token>', baseURL: 'http://127.0.0.1:7681' });
const m = await client.messages.create({
  model: 'claude', max_tokens: 100,
  messages: [{ role: 'user', content: 'reply with exactly: PING' }],
});
console.log(m.content[0].text);
```

**Conversation continuity.** The cloud APIs are stateless (the client sends
the whole history each call) but a live CLI session is stateful. The facade
bridges the two ways:

- **Automatic (default):** requests whose message history is the previous
  turn's history + that turn's exact reply "stick" to the same CLI session —
  the normal send-back-the-whole-conversation SDK loop just works. A request
  whose history matches nothing live seeds a fresh session by replaying the
  client-held history as context.
- **Explicit pin:** suffix the model (`"model": "claude#my-conv"`) or send an
  `X-Bridge-Conversation: my-conv` header (header wins) to name the
  conversation; the same pin always routes to the same session.
- **Responses API:** `previous_response_id` continues the conversation that
  produced that response (precedence: header > `previous_response_id` > model
  suffix).

**Usage semantics.** PTY profiles can't see real token counts — `usage` is
**estimated** (chars/4) and the response carries
`"bridge": {"usage_estimated": true}`. The `claude-headless` profile
(`claude -p --output-format stream-json` under the hood, resumed per turn)
returns **real** usage and exact-fidelity text, at the cost of no live
terminal view.

**Interactive dialogs.** If the CLI blocks on a dialog mid-turn (e.g. a
permission prompt), the request fails `409` with code `bridge_dialog_pending`
and a `bridge` object naming the `session_id` and the dialog text. Answer it
out-of-band (`POST /api/sessions/<session_id>/key`), then **retry the
identical request** — the retry attaches to the still-pending turn instead of
re-typing the prompt.

**Configuration** (all optional; see [Configuration](#configuration)):

| Var | Default | Notes |
|---|---|---|
| `FACADE_OPENAI_CHAT` | `true` | serve `POST /v1/chat/completions` |
| `FACADE_OPENAI_RESPONSES` | `true` | serve `POST /v1/responses` |
| `FACADE_ANTHROPIC_MESSAGES` | `true` | serve `POST /v1/messages` |
| `FACADE_SESSION_TTL_MS` | `600000` | idle unpinned facade session lifetime |
| `FACADE_PINNED_TTL_MS` | `3600000` | idle pinned facade session lifetime |
| `FACADE_MAX_SESSIONS` | `8` | max concurrent facade PTY sessions; LRU-evicts idle, `429` when all are mid-turn |
| `FACADE_COLS` | `400` | PTY width for facade sessions (wide to minimize wrap artifacts) |

**Security.** The facade is the **same single-token trust level** as the rest
of the bridge — the API key *is* the bridge token, and anyone holding the
URL + token gets full interactive control of every enabled CLI (and whatever
those CLIs can do on your machine). Blast-radius controls: `BRIDGE_PROFILES`
(which CLIs exist at all) and the three `FACADE_*` toggles (which dialects are
served). The operator-scope-only policy above applies unchanged.

**Non-goals.** Sampling and decoding parameters (`temperature`, `top_p`,
`max_tokens` as a limit, tool definitions, …) are accepted, **ignored**, and
logged once per parameter name — the underlying CLIs don't expose them.
`n` must be 1; only text content parts are supported; assistant prefill
(Anthropic) is rejected.

**Live verification:** `node scripts/live-acceptance.mjs [profile ...]`
drives the real CLIs through both official SDKs against an in-process bridge
(default profiles: `claude claude-headless codex`). Opt-in and manual — it
consumes subscription quota and is never run in CI.

## The trust-dialog reality

Launching `claude` shows a "trust this folder?" confirmation on **every
launch** when the working directory is `$HOME` — this was verified
empirically (see `test/fixtures/NOTES.md`): trusting `$HOME` does not persist
across relaunches the way it does for a specific project directory.

Practical effect: a freshly created session may come up in state
`awaiting_input` (the trust dialog) instead of `idle`. Handle it like this:

```bash
# after POST /api/sessions, check the returned state (or poll GET /api/sessions/:id)
curl -s -X POST http://127.0.0.1:7681/api/sessions/$ID/key \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"keys":["enter"]}'
# accepts the default-selected "Yes, I trust this folder" option
```

After that, the session settles to `idle` and prompts work normally.

**Tip:** set `CWD` (or pass `cwd` when creating a session) to a specific
project directory instead of leaving it at `$HOME`. Trust for a specific
project directory *does* persist, so subsequent launches against that same
`cwd` won't show the dialog at all.

## Readiness detection is best-effort

The interactive CLIs are TUIs, not machine-readable stream protocols. This
bridge has no structured signal for "response complete" — it
infers state by feeding PTY output through a headless terminal emulator
(`@xterm/headless`) and matching rendered screen lines against markers for
idle / busy / awaiting-input (footer text `? for shortcuts` vs.
`esc to interrupt`, and the trust-dialog copy), combined with output
quiescence. `POST /prompt`'s `output` is a best-effort rendered-transcript
delta and may contain minor redraw artifacts (partial-line fragments, cursor
repositioning residue) — it is not a clean structured transcript. If you need
exact, artifact-free structured output, use headless tooling (`claude -p` /
Agent SDK with API-key auth) instead of this bridge.

Every adapter's markers are **version-pinned UI copy** (the `claude` markers
were last live-verified on Claude Code 2.1.219; see `test/fixtures/NOTES.md`
for the captured raw PTY fixtures they were derived from). There is currently no
verified marker for Claude's tool-permission menu (only the startup trust
dialog is recognized as `awaiting_input`) — this is a known, documented gap,
not an oversight. If a Claude Code update changes the TUI's footer text or
dialog copy, the state detector will misclassify state; re-capture fixtures
under `test/fixtures/` and update the marker regexes in
`src/adapters/claude.js` accordingly.

## Version pinning (decoupling from host autoupdates)

Adapter markers are version-pinned UI copy — a host CLI autoupdate can break
turn mechanics silently. `cli-pins.json` pins each CLI to the version its
adapter was verified against; `npm run pin` installs those exact versions
under `vendor/` (gitignored), and the bridge prefers `vendor/` bins over the
host `PATH` automatically (explicit command overrides still win;
`BRIDGE_USE_HOST_CLIS=1` opts back into host bins). At boot the bridge runs
`--version` on every pinned CLI and warns on drift;
`BRIDGE_STRICT_VERSIONS=1` turns the warning into a refusal to boot. Spawned
children additionally get each CLI's self-update switch where one exists
(`claude`: `DISABLE_AUTOUPDATER=1`; `copilot`: `--no-auto-update`); for the
rest, the adapters' recognized-dialog handling is the guard — the bridge
never lets a CLI self-update unattended.

### Updating a pinned CLI

1. Edit the version in `cli-pins.json`; run `npm run pin`.
2. Run the live canary: `node scripts/live-acceptance.mjs` (spends real
   quota; expect the first run after a CLI update to fail if UI copy moved).
   For copilot, canary **both** profiles — `copilot copilot-headless` — since
   the two take independent code paths; `copilot-headless` (byte-exact JSON)
   is the gate that must stay green, while the PTY `copilot` facade extraction
   is best-effort and currently empty (1.0.75–1.0.76).
3. Fix adapter markers/fixtures if drifted; update the adapter's
   verified-version comment. A `grep -rn "<old version>" README.md docs/ src/`
   sweep finds every stale version reference to walk forward.
4. Commit the manifest and adapter/fixture changes together.

A pin protects against *surprise* updates; it is not "frozen forever" —
vendors can force-obsolete old versions server-side, so expect to walk pins
forward deliberately.

## Configuration

All via environment variables (`src/config.js`):

| Var | Default | Notes |
|---|---|---|
| `BRIDGE_TOKEN` | randomly generated | pin this to avoid a new token every restart |
| `HOST` | `127.0.0.1` | loopback; see Security above before changing |
| `PORT` | `7681` | |
| `CLAUDE_CMD` | `claude` | the command to spawn |
| `CLAUDE_ARGS` | `[]` | JSON array string, e.g. `'["-i"]'` |
| `CWD` | `$HOME` (or `process.cwd()`) | working dir for spawned sessions; see trust-dialog tip above |
| `QUIESCENCE_MS` | `500` | ms of no output before evaluating idle/busy state |
| `PROMPT_TIMEOUT_MS` | `600000` | default `POST /prompt` settle timeout |
| `COLS` | `120` | PTY/terminal columns |
| `ROWS` | `30` | PTY/terminal rows |
| `SCROLLBACK` | `5000` | lines kept in the terminal model |
| `RING_BYTES` | `262144` | raw-byte ring buffer size replayed to new WS clients |
| `ADAPTER` | `claude` | `claude` or `generic` — see Testing below |
| `DEFAULT_PROFILE` | `claude` | profile a bare `POST /api/sessions`/`GET /ws` spawns; see [Profiles](#profiles) |
| `BRIDGE_USE_HOST_CLIS` | `false` | skip `vendor/` bins, spawn host-`PATH` CLIs — see [Version pinning](#version-pinning-decoupling-from-host-autoupdates) |
| `BRIDGE_STRICT_VERSIONS` | `false` | refuse to boot on a pinned-version mismatch instead of warning |
| `BRIDGE_PROFILES` | all built-ins | comma-separated allowlist of enabled profile names |
| `BRIDGE_TRUST_PROXY` | `false` | believe `X-Forwarded-Proto` from a fronting reverse proxy; gates the HSTS header — see [Security](#security) |
| `PROFILE_<NAME>_COMMAND` | *(profile's built-in)* | executable to spawn for profile `<NAME>` |
| `PROFILE_<NAME>_ARGS` | *(profile's built-in)* | JSON array string of args for profile `<NAME>` |
| `PROFILE_<NAME>_ENV_SCRUB` | *(profile's built-in)* | comma-separated env var names to scrub for profile `<NAME>` |
| `PROFILE_<NAME>_DIALOG_POLICY` | `startup-only` | `startup-only` \| `auto-approve` \| `never` for profile `<NAME>` — see the warning under [Profiles](#profiles) |
| `PROFILE_<NAME>_QUIESCENCE_MS` | *(legacy global)* | per-profile override of `QUIESCENCE_MS` |
| `PROFILE_<NAME>_COLS` | *(legacy global)* | per-profile override of `COLS` |
| `PROFILE_<NAME>_ROWS` | *(legacy global)* | per-profile override of `ROWS` |
| `PROFILE_<NAME>_CWD` | *(legacy global)* | per-profile override of `CWD` |

`<NAME>` is the profile name uppercased with `-` replaced by `_` (e.g.
`claude-headless` → `PROFILE_CLAUDE_HEADLESS_*`). Full precedence order and
per-field details: [docs/API.md § Profiles](docs/API.md#profiles).

## Testing

```bash
npm test
```

The whole pipeline (PTY session, terminal model, state detection, HTTP API,
WebSocket relay, and the end-to-end component test) is tested against plain
`bash` with `ADAPTER=generic` (or the `generic` profile), not a real CLI —
this costs no subscription usage and needs no auth. The `generic` adapter
treats output quiescence alone as the idle signal, which works for any
line-based CLI (it has no way to detect a modal dialog, so `awaiting_input`
is never reported under this adapter). The `claude`, `codex`, `antigravity`,
and `copilot` adapters' TUI-marker matching and `extractResponse` chrome
stripping are instead verified against static fixtures captured from real
sessions (`test/fixtures/*.txt`, `test/stateDetector.test.js`,
`test/adapters.test.js`) rather than by spending live subscription/API calls
in CI. The cloud-API facade is tested the same way: bash fake-REPLs, a
`claude -p` stream-json stub, and official-SDK acceptance tests
(`openai` / `@anthropic-ai/sdk` as devDependencies) all run against an
in-process bridge with zero live CLI usage; `node --test` runs the full
offline suite.
For opt-in live verification against the real CLIs, see
`scripts/live-acceptance.mjs` ([Cloud-API facade](#cloud-api-facade)).
