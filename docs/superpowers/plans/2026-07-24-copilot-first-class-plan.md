# GitHub Copilot: validation workflow + first-class test plan

**Date:** 2026-07-24 · **Status:** planned, not started · **CLI:** `copilot`
1.0.74 (pinned in `cli-pins.json`; npm `@github/copilot`)

Goal: take the `copilot` profile from "best-effort tier" to *deliberately
validated*, and evaluate/build the fidelity path (`copilot-headless`) that
would make copilot output first-class the way `claude-headless` did for
claude. Two tracks — Track 1 is cheap validation of what exists; Track 2 is
the new capability. They're independent; do Track 1 first regardless.

## 0. Current state (facts, verified 2026-07-24 on this machine)

- Adapter `src/adapters/copilot.js` is **fixture-verified on 1.0.74**
  (idle `/ commands · ? help`, busy `◎ Working esc interrupt`, folder-trust
  dialog), including a full live `● PONG` round-trip capture. Degraded only
  in `extractResponse` (alt-screen repaints break transcript diffing).
- **Auth works via the `gh` keyring** (account NerfBlasters) even with
  `GH_TOKEN`/`GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN` scrubbed — that scrub is
  deliberate (forces subscription auth, not token auth).
- Spawn args now include `--no-auto-update` (Phase 3).
- CLI surface relevant to Track 2 (from `copilot --help`, 1.0.74):
  `-p/--prompt <text>` non-interactive mode; `-s/--silent` = *output only
  the agent response*; `-r/--resume[=value]`, `--continue`,
  `--session-id <id>` for session chaining; `--no-color`;
  `--log-level none`; `--stream <mode>`; `--allow-all-tools` documented as
  *required for non-interactive mode*; `--available-tools[=tools...]` /
  `--allow-tool` for restriction; sessions shareable via `--share[=path]`.

## Track 1 — validate the existing PTY profile (cheap, do first)

### 1.1 Auth + environment preflight (no quota)

```bash
gh auth status                      # expect: keyring login, active account
copilot --version                   # expect: 1.0.74 (vendored: vendor/node_modules/.bin/copilot --version)
node src/server.js                  # boot: expect "profile copilot: <vendor path>" + "version ok: copilot 1.0.74"
```

If `gh auth status` fails, stop — everything downstream is auth noise.

### 1.2 Live PTY round-trip through the session API (≈2 turns quota)

```bash
BRIDGE_TOKEN=t node src/server.js &
ID=$(curl -s -X POST http://127.0.0.1:7681/api/sessions -H 'Authorization: Bearer t' \
  -d '{"profile":"copilot"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
# trust dialog is auto-answered (startup-only policy); poll until idle:
curl -s http://127.0.0.1:7681/api/sessions/$ID -H 'Authorization: Bearer t'
curl -s -X POST http://127.0.0.1:7681/api/sessions/$ID/prompt -H 'Authorization: Bearer t' \
  -H 'content-type: application/json' -d '{"text":"reply with exactly: PONG"}'
```

PASS: settles `idle`; `text` contains `PONG` (best-effort — chrome fragments
tolerated, per tier). Record the raw `output` for fixture refresh if anything
about the chrome changed since the 1.0.74 captures.

### 1.3 Facade live acceptance (≈3 turns quota)

```bash
node scripts/live-acceptance.mjs copilot
```

The script already takes profile args; expected semantics match the other
PTY profiles: non-stream `/PONG/`, stream + history-fingerprint stickiness
`/DONG/`, anthropic dialect `/PING/`. Substring assertions only (chrome +
inherited-env banners are expected). PASS = 3/3. If markers drifted, follow
the README bump workflow (capture → fix markers/fixtures → commit together).

### 1.4 Docker keyring reality check (no quota if auth fails fast)

The documented unknown from Phase 3. Procedure:

```bash
docker run -it --rm --init \
  -v ~/.config/gh:/home/node/.config/gh \
  pty-web-bridge copilot -p "reply with exactly: PONG" -s --no-color
```

- `gh` stores keyring credentials, but on headless/keyring-less systems it
  falls back to `~/.config/gh/hosts.yml` — this machine uses the keyring, so
  **expect this to fail** unless a hosts.yml-based login is prepared:
  `docker exec -it <ctr> copilot login` (device flow) into a persistent
  volume is the likely working path.
- Outcome either way gets written into `docs/DOCKER.md` (replacing the
  current "untested/awkward" hedge with the verified procedure or a firm
  "not supported without in-container login").

### Track 1 acceptance

- [ ] Preflight green; boot handshake `version ok: copilot`.
- [ ] Session-API round-trip: idle settle + `PONG` in `text`.
- [ ] `live-acceptance.mjs copilot` 3/3.
- [ ] DOCKER.md copilot section replaced with verified facts.
- [ ] README support-tier table annotated "live-verified" for copilot's row
      (tier stays best-effort while extraction is PTY-based).

## Track 2 — `copilot-headless` profile (the fidelity path)

Mirror of `claude-headless`: real turns through the facade with exact text,
no PTY, no alt-screen extraction problem. Prereq: Track 1 green.

### 2.1 Spike: probe the non-interactive contract (manual, ~4-6 turns quota)

Answer these with exact commands before writing any code; record results in
this file (or a NOTES addendum) with the CLI version:

1. **Clean output:** `copilot -p "reply with exactly: PONG" -s --no-color`
   → is stdout exactly the response text? Exit code on success/error? What
   lands on stderr (`--log-level none` to silence)?
2. **Session id discovery:** after a `-p` run, how do we learn the session
   id for chaining? Candidates: stdout/stderr banner without `-s`;
   `~/.copilot/` session store (ls before/after); `--share=path` markdown
   header. A resume chain is REQUIRED for facade stickiness — if the id is
   not programmatically discoverable, test `--continue` (most recent
   session) as the chaining mechanism and document its concurrency hazard
   (two live conversations would cross-talk; may force
   `FACADE_MAX_SESSIONS=1`-style serialization for this profile).
3. **Resume correctness:** `copilot -p "reply with exactly: DONG" -s
   --resume <id>` (or `--continue`) → does it remember the first turn?
4. **Streaming:** does `--stream` affect `-p` mode stdout, or is
   non-interactive always buffered? (Buffered is fine — synthesize a single
   terminal delta like non-stream claude-headless fallback.)
5. **Usage:** is token/credit usage reported anywhere parseable (stdout,
   `--share` output, session store)? If not: usage stays estimated.
6. **Tool permissions:** `-p` docs say `--allow-all-tools` is required. For
   the bridge's chat-responder use we do NOT want blanket tool execution.
   Test whether `-p` works with `--available-tools=` (empty) or a minimal
   allowlist; find the flag combination closest to "answer in text, run
   nothing". **This is the go/no-go security question**: if non-interactive
   mode cannot run without full tool autonomy, `copilot-headless` ships
   default-disabled (`BRIDGE_PROFILES` opt-in) with the risk documented, or
   not at all.

### 2.2 Runner implementation (mirror `headlessClaudeRunner.js`)

- New `src/facade/headlessCopilotRunner.js`:
  `copilot -p <text> -s --no-color --log-level none [--resume <id>|--continue] [tool-restriction flags per 2.1.6]`
  + profile args appended; envScrub + envSet applied identically to the
  claude runner; timeout → kill → `FacadeError(504)`; nonzero exit →
  `FacadeError(500, 'api_error')` with stderr tail.
- Config: `copilot-headless` BUILTIN profile — `command: 'copilot'`,
  `adapter: null`, `mode: 'headless'`, same envScrub as `copilot`,
  `envSet` per 2.1 findings. Wire the mode dispatch where turnRunner picks
  the claude runner today (`src/facade/turnRunner.js` seam / facade index).
- `GET /v1/models` picks it up via the profiles table automatically —
  verify, don't assume.

### 2.3 Offline test plan (CI-safe, zero quota — the fake-copilot stub)

Follow the existing `claude -p` stub pattern (see how
`test/headlessRunner.test.js` fakes stream-json):

- A stub script that mimics the spike-verified stdout contract (response
  text on stdout, configurable exit code/stderr/delay, records its argv +
  env to a file for assertions).
- Unit tests (`test/headlessCopilotRunner.test.js`): success turn; resume
  arg threading (turn 2 carries the id/`--continue` per 2.1 findings);
  nonzero-exit → 500 with stderr tail; timeout → 504; envScrub/envSet
  reach the child (assert via recorded env); tool-restriction flags always
  present (regression-lock the 2.1.6 security decision).
- Facade e2e: extend `test/sdkAcceptance.test.js`/`test/facadeTurns.test.js`
  with the stub-backed `copilot-headless` profile — non-stream, stream
  (synthesized delta), stickiness via resume chaining, error mapping.
- Suite stays `node --test > file 2>&1`, never piped; no live CLI in CI.

### 2.4 Live gate (≈3 turns quota)

```bash
node scripts/live-acceptance.mjs copilot-headless
```

PASS = 3/3 with EXACT-match semantics (like claude-headless: `text` should
be byte-clean, so tighten expectations manually: response is exactly `PONG`
etc., not substring). Then a combined `copilot copilot-headless` run to
confirm the two profiles coexist.

### Track 2 acceptance

- [ ] Spike questions 1-6 answered and recorded with exact commands/outputs.
- [ ] Security decision (2.1.6) made and regression-locked by a unit test.
- [ ] Runner + profile land with the offline stub suite green (no live CLI).
- [ ] Live gate 3/3 exact-match; coexistence run green.
- [ ] README: `copilot-headless` added to profiles + support tiers
      (first-class row) with the tool-permission posture documented;
      docs/API.md models list touched if it enumerates profiles.
- [ ] `cli-pins.json` untouched (same binary) — but bump-workflow doc gains
      a line that copilot pin bumps now gate on BOTH profiles' live checks.

## Quota + process notes

- Budget: Track 1 ≈5 turns, Track 2 spike ≈4-6, live gates ≈6 — roughly 15-17
  copilot premium requests end-to-end. Copilot quota is separate from
  claude/codex; check `copilot` session footer ("AIC used") or
  `copilot help billing` before starting.
- Never pipe the test suite; capture live outputs to files. Alt-screen
  captures go through the existing `scratch/capture-*.mjs` tooling; commit
  only cleaned fixtures under `test/fixtures/` with NOTES.md entries.
- Expect the first live run after ANY copilot version bump to fail (marker
  drift is normal) — that's the bump workflow, not a bug.

## Risks / open unknowns

1. **Session-id discovery under `-s`** (2.1.2) — if unavailable,
   `--continue` chaining constrains concurrency; design must serialize.
2. **Tool permissions in `-p` mode** (2.1.6) — potential go/no-go, see above.
3. Copilot ships fast; 1.0.74 pins the plan's facts. Re-verify the flag
   surface (`copilot --help`) at whatever version is pinned when this
   executes.
4. Container auth stays best-effort until 1.4 produces a verified recipe.

---

## EXECUTED 2026-07-24 (copilot 1.0.75) — results

Pin bumped 1.0.74 → 1.0.75 first (npm `latest` had moved and the vendored
platform binary had self-updated to 1.0.75 during the device-login flow, while
its npm `package.json` still read 1.0.74). Boot handshake now `version ok:
copilot 1.0.75`.

### Track 2 spike answers (§2.1), ~9 AIU over 5 live `copilot -p` calls

1. **Clean output** — YES. `--output-format json` emits JSONL on stdout, stderr
   quiet. Authoritative text = `assistant.message` event, `data.phase ==
   "final_answer"`, `data.content`. `assistant.message_delta.data.deltaContent`
   gives streaming deltas.
2. **Session id** — we ASSIGN it: `--session-id <uuid>` on turn 1 (echoed back
   in the terminal `result` event's `sessionId`); no discovery needed.
3. **Resume** — YES. `--resume=<uuid>` recalls prior context (verified a
   codeword recalled across two turns), exact.
4. **Streaming** — YES (`assistant.message_delta`); buffered final also present.
5. **Usage** — real `outputTokens` on the final message; credits as
   `session.usage_checkpoint.totalNanoAiu`; no clean per-turn input tokens.
6. **Tool permissions — SECURITY-CRITICAL, resolved GO with a mandatory
   lockdown.** `-p` mode is agentic and *auto-executed* the builtin `bash` tool
   (ran `echo` on the host) even with NO `--allow-all-tools`, `--no-ask-user`,
   `--disable-builtin-mcps`, and an EMPTY `--available-tools=`. The fix (per
   `copilot help permissions`, verified): a **non-empty bogus allowlist**
   `--available-tools=__none__` exposes zero real tools and its filter is
   upstream of `--allow-*`/`--deny-*` approval, so nothing can re-expose `bash`.
   Verified: no `tool.execution` events, model replies it cannot run tools.

### Delivered

- `copilot-headless` first-class facade profile (mirror of `claude-headless`):
  `src/facade/headlessCopilotRunner.js`, `copilot-headless` BUILTIN profile, a
  `headlessRunner` discriminator + `router._runTurn` dispatch, and the agnostic
  rename `conv.claudeSessionId → resumeSessionId`.
- Runner lockdown flags are FIXED/hardcoded (`--available-tools=__none__
  --disable-builtin-mcps --no-ask-user --output-format json --no-color
  --log-level none`), profile scrubs `COPILOT_ALLOW_ALL`; regression-locked by
  `test/headlessCopilotRunner.test.js`.
- Offline suite green (236/236) incl. copilot stub + facade e2e.
- **Live gate:** `live-acceptance.mjs copilot-headless` → **3/3, byte-exact**
  (`PONG`/`DONG`/`PING`; resume-based stickiness end-to-end).

### Track 1 outcome (PTY `copilot` on 1.0.75) — degraded, documented

`live-acceptance.mjs copilot` → 3/3 **FAIL (empty text)**. Root cause is NOT
marker drift (idle `/ commands · ? help` and the `● <answer>` block still render
and match on 1.0.75) — it's the alt-screen extraction: copilot repaints in
place, so `renderLinesSince(sinceIndex)` never sees new lines and
`extractResponse` returns empty. This is the pre-documented DEGRADED behavior,
now fully empty. Not chased further — `copilot-headless` is the first-class
facade path and sidesteps the PTY. Documented in the adapter header, README
tiers/profiles/degraded/scrub tables, DOCKER.md, and API.md.

### Doc corrections (auth)

Copilot authenticates via its **own** device-code login under `~/.copilot`
(config.json), NOT the `gh` keyring (that was wrong in Phase 3/4 notes — the
`gh` keyring is only for the `gh` tool). Corrected in README, DOCKER.md, and the
copilot adapter header. Docker auth = mount `~/.copilot` or in-container
`copilot login` (§1.4 resolved).
