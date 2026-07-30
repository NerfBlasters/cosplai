# Fabric as an OpenAI client over the copilot facade

End-to-end guide: stand the bridge up as a local **OpenAI-compatible API
endpoint** backed by your GitHub Copilot subscription (the `copilot-headless`
profile), then point [fabric](https://github.com/danielmiessler/fabric) at it
and run patterns against it.

Every command below was executed as written on 2026-07-30 (input filenames
and the repo URL generalized) with: bridge on Node v20.19.2, **copilot CLI
1.0.76** (vendored pin), **fabric v1.4.465**, Kali Linux (Debian-family).

## What you get

- fabric (or any OpenAI-protocol client) talks to `http://127.0.0.1:7681/v1`.
- The bridge translates each request into a turn on `copilot -p
  --output-format json` — your Copilot subscription answers; no OpenAI API key
  or account is involved anywhere.
- **Security property you inherit:** the facade's copilot runner hardcodes a
  tool lockdown (`--available-tools=__none__` + `--disable-builtin-mcps` +
  `--no-ask-user`, operator tool-exposure args scrubbed), so the endpoint
  behaves as a pure chat responder — prompt text is the only untrusted input
  that reaches copilot, and it cannot execute tools on the host.

## Prerequisites

- Node ≥ 20, git, curl, openssl, ~2 GB disk for CLI vendoring.
- A GitHub Copilot subscription.
- **Debian/Kali warning:** `apt install fabric` installs a *different*
  project (a Python SSH deployment tool). Don't. Use the release binary or
  `go install` below.

## 1. Bridge setup

```bash
git clone <repo-url> pty-web-bridge && cd pty-web-bridge
npm install
npm run pin        # vendors the pinned CLIs (vendor/ is gitignored; every fresh clone needs this)
```

Authenticate copilot once (device-code flow; credentials land in
`~/.copilot`, **not** the `gh` keyring — `gh auth login` does not help here):

```bash
vendor/node_modules/.bin/copilot login
```

Generate a token and start the bridge. `PROFILE_COPILOT_HEADLESS_ARGS` pins
which LLM copilot uses under the hood (see [§6](#6-which-model-am-i-talking-to)):

```bash
(umask 077; openssl rand -hex 24 > ~/.bridge-token)
BRIDGE_TOKEN=$(cat ~/.bridge-token) \
PROFILE_COPILOT_HEADLESS_ARGS='["--model","gpt-5.6-terra"]' \
  node src/server.js
```

Startup must show `version ok: copilot 1.0.76 (…)`, `pty-web-bridge
listening.` and `Facade dialects: openai-chat, openai-responses,
anthropic-messages`. **The server runs in the foreground — leave it running
and do the rest of this guide in a second terminal.**

## 2. Smoke test with curl (before fabric enters)

```bash
TOK=$(cat ~/.bridge-token)
curl -s http://127.0.0.1:7681/v1/models -H "authorization: Bearer $TOK"
# → {"object":"list","data":[…{"id":"copilot-headless","object":"model",…}…]}

curl -s http://127.0.0.1:7681/v1/chat/completions \
  -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"model":"copilot-headless","messages":[{"role":"user","content":"reply with exactly: PONG"}]}'
# → {"object":"chat.completion",…"content":"PONG"…"finish_reason":"stop"…}
```

Note `"model"` here is the **bridge profile name**, not an LLM name — see §6.

## 3. Install fabric

Release binary (checksum-verified). `v1.4.465` was current when written —
substitute the latest tag from
`https://github.com/danielmiessler/fabric/releases/latest`:

```bash
cd "$(mktemp -d)"
curl -sL -O https://github.com/danielmiessler/Fabric/releases/download/v1.4.465/fabric_Linux_x86_64.tar.gz
curl -sL -O https://github.com/danielmiessler/Fabric/releases/download/v1.4.465/fabric_1.4.465_checksums.txt
grep Linux_x86_64 fabric_1.4.465_checksums.txt | sha256sum -c -   # must print: OK
mkdir -p ~/.local/bin && tar -xzf fabric_Linux_x86_64.tar.gz fabric && mv fabric ~/.local/bin/
fabric --version   # → 1.4.465
```

If `fabric` isn't found, add `export PATH="$HOME/.local/bin:$PATH"` to your
shell rc. Go users can instead run:
`go install github.com/danielmiessler/fabric/cmd/fabric@latest` (installs to
`~/go/bin`).

## 4. Configure fabric against the bridge

No interactive setup needed — write the config directly:

```bash
mkdir -p ~/.config/fabric
umask 077
cat > ~/.config/fabric/.env <<EOF
DEFAULT_VENDOR=OpenAI
DEFAULT_MODEL=copilot-headless
OPENAI_API_KEY=$(cat ~/.bridge-token)
OPENAI_API_BASE_URL=http://127.0.0.1:7681/v1
EOF
chmod 600 ~/.config/fabric/.env    # the bridge token is plaintext in here
```

Fetch the pattern library and confirm fabric sees the bridge:

```bash
fabric -U            # → "Downloaded 254 patterns …"
fabric --listmodels
# → Available models:
#      [1] OpenAI|antigravity
#      …
#    * [6] OpenAI|copilot-headless      ← the * marks your default
```

`--listmodels` is fabric calling the bridge's `GET /v1/models` — if it lists
the profiles, auth and base URL are correct.

## 5. Use it — patterns require `-r`

**The one non-obvious incantation: always pass `-r` (`--raw`).** By default
fabric folds the pattern *and* your piped input into a single **system**
message with no user message. OpenAI's own endpoints accept that; this facade
does not — its contract requires the final message to be a `user` turn, so
default-mode patterns fail with:

```
POST "http://127.0.0.1:7681/v1/responses": 400 Bad Request
{"message":"the final input item must be a user message",…}
```

`-r` sends the pattern + input as a single **user** message, which the
facade accepts. Working invocations (both executed for this guide):

```bash
# non-streaming
cat article.txt | fabric -r -p summarize

# streaming
cat article.txt | fabric -s -r -p summarize
```

Both produced the summarize pattern's full formatted output (ONE SENTENCE
SUMMARY / MAIN POINTS / TAKEAWAYS) generated by copilot.

**Which route does fabric use?** By default fabric calls `POST
/v1/responses`. `fabric --disable-responses-api` switches it to `POST
/v1/chat/completions` — both work against the bridge (verified byte-exact
with a PING turn), so the flag is only needed if you disable a dialect
server-side.

## 6. Which model am I talking to?

Two layers, easy to conflate:

| Layer | Set by | Value in this guide |
|---|---|---|
| OpenAI-protocol `model` field | fabric's `DEFAULT_MODEL` / `-m` | `copilot-headless` — a **bridge profile name**, the only names `/v1/models` serves |
| The actual LLM | copilot's own `--model` flag, via `PROFILE_COPILOT_HEADLESS_ARGS` at bridge start | `gpt-5.6-terra` |

Sending a real LLM name (`"gpt-5.6-terra"`, `"gpt-4o"`, …) as the OpenAI
`model` field returns `404 model_not_found` — that field selects a bridge
profile, nothing else.

To change the underlying LLM: list valid names with
`vendor/node_modules/.bin/copilot help config` (the `model:` block — e.g.
`claude-opus-5`, `gpt-5.6-terra`, `gemini-3.1-pro-preview`), then restart the
bridge with the new value in `PROFILE_COPILOT_HEADLESS_ARGS`. Omit the arg
entirely to use your Copilot subscription's default.

Sampling parameters fabric sends (temperature 0.7, top_p 0.9, …) are
**accepted and ignored** by design — the CLI owns its own sampling. Token
`usage` in responses is flagged `bridge.usage_estimated: true` (copilot
exposes no per-turn input count).

## 7. Troubleshooting

| Symptom (fabric side) | Cause | Fix |
|---|---|---|
| `400 … must be a user message` (both dialects phrase it slightly differently) | fabric's default system-only message construction | add `-r` (§5) |
| `401 Unauthorized` | `OPENAI_API_KEY` ≠ bridge token — commonly: the bridge was restarted without `BRIDGE_TOKEN` set, so it minted a fresh random token | restart the bridge with `BRIDGE_TOKEN=$(cat ~/.bridge-token)`, or re-copy the current token into `~/.config/fabric/.env` |
| `404 model_not_found` | `DEFAULT_MODEL` isn't a bridge profile, or profile disabled via `BRIDGE_PROFILES` | `fabric --listmodels`; use a listed name |
| `429 rate_limit` | all `FACADE_MAX_SESSIONS` sessions mid-turn | wait, or raise `FACADE_MAX_SESSIONS` |
| `504` / very slow turns | copilot turn exceeded the bridge prompt timeout (default 600 s) | raise `PROMPT_TIMEOUT_MS` on the bridge |
| turn errors right after a copilot update mentioning the model | pinned `--model` name retired by new copilot | `copilot help config` → update `PROFILE_COPILOT_HEADLESS_ARGS` |
| startup logs `VERSION MISMATCH` instead of `version ok` (the bridge still boots; it refuses to start only with `BRIDGE_STRICT_VERSIONS=1`) | copilot binary self-updated past the pin (it does this) | re-run `npm run pin`; if drift persists, bump `cli-pins.json` and re-run the live canary (`node scripts/live-acceptance.mjs copilot copilot-headless`) |
| anything touching the token | — | keep `~/.bridge-token` and `~/.config/fabric/.env` at mode `600`; the bridge binds `127.0.0.1` only, and one token = full control of every enabled CLI |
