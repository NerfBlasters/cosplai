# Fabric over the Copilot OpenAI Facade — Design Spec

Date: 2026-07-30
Status: Approved for implementation
Builds on: [2026-07-23 universal-cli-and-api-facade design](2026-07-23-universal-cli-and-api-facade-design.md)
and the Phase 5 handoff (`docs/superpowers/2026-07-24-phase-5-handoff.md`).

## Overview

Stand the bridge up as a working OpenAI-compatible API endpoint backed by the
already-authenticated `copilot` CLI (`copilot-headless` profile), then install
and configure [fabric](https://github.com/danielmiessler/fabric) as a real
third-party OpenAI client against it, prove the loop end-to-end, and ship a
fresh-machine instruction guide for the whole flow.

**No new bridge features are expected.** The cloud-API facade already speaks
the OpenAI wire protocols (`GET /v1/models`, `POST /v1/chat/completions`,
`POST /v1/responses` — on by default) with `model` = profile name, so
`"model": "copilot-headless"` already routes exact-text turns through
`copilot -p --output-format json` under the tool lockdown. This phase is
stand-up + integration + documentation, plus two pieces of housekeeping the
tree demands first.

## Goals

1. Bridge running locally as an OpenAI endpoint, validated at the wire level.
2. fabric installed (GitHub release binary), configured against the bridge,
   with patterns working non-stream and streamed.
3. A guide a fresh operator can follow start-to-finish:
   `docs/guides/fabric-openai-endpoint.md`, linked from the README.

Non-goals: multi-user hardening, fixing PTY-copilot alt-screen extraction
(superseded by headless), any new facade dialect work.

## Plan of record

### 1. Pre-work — commit the pending lockdown hardening

The tree carries finished, uncommitted work: `scrubToolExposureArgs()` in
`src/facade/headlessCopilotRunner.js` (strips operator-supplied tool-exposure
flags — `--available-tools`, `--allow-tool`, `--allow-all-tools`, `--yolo` —
from `profile.args` so config can't reopen the lockdown) plus its regression
test. Run the offline suite unpiped (`node --test > /tmp/suite.out 2>&1`;
expect the prior 237 + 1 new, all passing), then commit this as its own
commit before anything else. It hardens exactly the code path fabric will
exercise.

### 2. Pin bump — copilot 1.0.75 → 1.0.76

Both the vendored and host copilot binaries have self-updated to 1.0.76
(the drift mode must-know #5 predicted); the validated 1.0.75 state no longer
exists on disk and cannot be held (the binary self-updates in place). Follow
the repo's bump workflow:

- `cli-pins.json`: copilot `1.0.75` → `1.0.76` → `npm run pin` → confirm
  `vendor/node_modules/.bin/copilot --version` reports 1.0.76 (version output
  is the source of truth, not package.json).
- Live canary, controller-side, never piped:
  `node scripts/live-acceptance.mjs copilot copilot-headless`.
  **Gate: `copilot-headless` 3/3 byte-exact** (PONG / streamed DONG / resume
  PING). The streamed check deliberately re-verifies the undocumented
  `assistant.message_start.data.phase === 'final_answer'` event shape on
  1.0.76. PTY `copilot` remaining alt-screen-degraded (empty extraction) is
  expected and acceptable.
- Commit pin + any fixture/marker fixes together. If the canary fails on
  JSONL-contract drift, fixing the runner is in-scope for this phase (it
  blocks everything downstream).

### 3. Stand up the bridge

- **The underlying LLM is pinned to `gpt-5.6-terra`** (user decision; a valid
  1.0.76 name per `copilot help config`). Note the layering the guide must
  explain: on this endpoint the OpenAI `model` field is the **profile name**
  (`copilot-headless`) — the real LLM is chosen one layer down via copilot's
  `--model` flag, passed through profile args:
  `PROFILE_COPILOT_HEADLESS_ARGS='["--model","gpt-5.6-terra"]'`.
  (`scrubToolExposureArgs` only strips tool-exposure flags, so `--model`
  passes through; the step-2 canary runs on default config — its job is the
  JSONL contract, not the model pin.)
- `BRIDGE_TOKEN=<token> PROFILE_COPILOT_HEADLESS_ARGS='["--model","gpt-5.6-terra"]' node src/server.js`
  — default `127.0.0.1:7681`; facade dialects are on by default; copilot auth
  already lives in `~/.copilot` (its own device login — NOT the gh keyring).
- Wire-level smoke before fabric enters:
  - `GET /v1/models` with `Authorization: Bearer` → `copilot-headless` listed.
  - One `POST /v1/chat/completions` turn, `model: "copilot-headless"`,
    "reply with exactly: PONG" → byte-exact PONG.

### 4. Install + configure fabric

- Latest GitHub release binary (linux-amd64) → `~/.local/bin/fabric`; record
  the exact version in the guide. (Kali's apt `fabric` is the Python SSH
  deployment tool — the guide warns against it. `go install
  github.com/danielmiessler/fabric/cmd/fabric@latest` is the documented
  alternative.)
- Configure by writing `~/.config/fabric/.env` directly (no TUI):

  ```
  DEFAULT_VENDOR=OpenAI
  DEFAULT_MODEL=copilot-headless
  OPENAI_API_KEY=<bridge token>
  OPENAI_API_BASE_URL=http://127.0.0.1:7681/v1
  ```

  Fallback if direct-`.env` misbehaves: `fabric --setup` interactively.
- `fabric -U` (update patterns) to fetch the pattern library.
- Verified live rather than assumed: fabric's OpenAI vendor is
  Responses-API-compatible, so it may call `/v1/responses` rather than
  `/v1/chat/completions`. The bridge speaks both; the guide documents the
  route fabric actually takes (observable in bridge logs).

### 5. End-to-end test (kept cheap: ~2–3 fabric turns + canary ~5–6 AIU)

| Check | Exercises |
|---|---|
| `fabric --listmodels` | `GET /v1/models` through fabric's client |
| `echo <sample> \| fabric -p summarize` | non-stream completion via copilot |
| same with `-s` | SSE streaming path |

Success = fabric prints a real copilot-generated summary both ways, with no
manual cleanup of the output.

### 6. The guide — `docs/guides/fabric-openai-endpoint.md`

Fresh-machine flow, linked from the README: clone → `npm run pin` → `copilot`
device login → start bridge (with the `--model` pin) → smoke-test with curl →
install fabric → `.env` config → verify (`--listmodels`, patterns, streaming)
→ troubleshooting. A dedicated **"which model am I talking to?"** section
explains the two-layer model story: fabric's `DEFAULT_MODEL` = bridge profile
(`copilot-headless`); the actual LLM = copilot's `--model`
(`gpt-5.6-terra` here), with `copilot help config` as the way to list valid
names. Troubleshooting covers: facade error statuses (401/404/429/
504) as fabric surfaces them, the wrong-apt-fabric trap, `.env` file
permissions (token is plaintext — `chmod 600`), localhost-only bind and the
single-token trust model, and why the endpoint cannot execute tools (the
lockdown, stated as the security property fabric users inherit).

**Accuracy rule: every command in the guide is one actually executed this
session, with versions recorded** (copilot 1.0.76, fabric vX.Y.Z, bridge
commit).

## Error handling / known risks

- **1.0.76 JSONL drift** — caught at the canary gate (step 2) before fabric
  is involved; runner fixes are in-scope if needed.
- **fabric sends sampling params** (temperature etc.) — the facade accepts
  and ignores them by design; noted in the guide.
- **Slow copilot turns** — if fabric or the bridge times out, document
  `PROMPT_TIMEOUT_MS` (bridge) and fabric's timeout flag in troubleshooting.
- **Self-update drift recurring mid-session** — re-check `--version` if
  live behavior shifts; the guide's troubleshooting notes the symptom.
- **Model-name drift** — `gpt-5.6-terra` is valid on 1.0.76; a future copilot
  bump can retire names. Troubleshooting documents the symptom (turn errors
  after a bump) and the fix (`copilot help config` → update the profile arg).

## Testing

- Offline: full `node --test` suite green before each commit (redirected to a
  file, never piped — leaked-PTY hang).
- Live: the step-2 canary gate, then the step-5 fabric matrix.
- Guide: after writing, replay its command sequence in a fresh shell where
  practical (not a fresh clone; `npm run pin` re-vendoring is the slow part
  already exercised in step 2).
