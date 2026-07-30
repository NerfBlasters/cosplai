# Phase 3 Handoff — pty-web-bridge after the cloud-API facade

> **SUPERSEDED (2026-07-24):** Phase 3 shipped (PR #3 — agnostic identity +
> version pinning). Read `2026-07-24-phase-4-handoff.md` instead. Note in
> particular that this doc's §5 frames Phase 3 scope around the Defender XDR
> integration doc — that doc was deliberately REMOVED in Phase 3 (spec §8
> records the decision); the scoping discussion below is historical only.

**Written 2026-07-24, after Phase 2 (cloud-API facade) merged to `master`
(PR #2, merge commit `1360939`).** This doc lets a fresh session resume cold.
Its predecessor (`2026-07-24-phase-2-handoff.md`) is now historical — read
this one instead; anything it repeats from the old doc supersedes it.

---

## 1. Status / where things stand

- **Phases 1 AND 2 are DONE and merged to `master`.** Phase 1 = universal
  multi-CLI support (PR #1). Phase 2 = the OpenAI/Anthropic cloud-API facade
  (PR #2). `master` HEAD is `1360939`; working tree clean; local checkout is
  on `master`.
- **206/206 tests pass** (`node --test`, ~25s, zero live-CLI usage).
- **Live acceptance is 9/9**: `node scripts/live-acceptance.mjs` (opt-in,
  spends real quota, NEVER in CI) drives real `claude` 2.1.218 (interactive
  PTY), `claude-headless`, and `codex` 0.134.0 through the official `openai`
  and `@anthropic-ai/sdk` SDKs — non-stream, streaming, and conversation
  stickiness all pass.
- The original spec is **fully delivered**; there is no committed Phase 3
  spec yet. The candidate scope lives in
  `docs/integration/defender-xdr-threat-hunting.md` (see §5).

## 2. How to resume

```bash
cd /home/kali/repos/pty-web-bridge
git checkout master && git pull --ff-only
node --test > /tmp/suite.out 2>&1; tail -3 /tmp/suite.out   # expect 206/206
# then branch for whatever Phase 3 becomes:
git checkout -b feat/<phase-3-scope>
```

- **Read first:** `docs/integration/defender-xdr-threat-hunting.md` — the
  intended use and its own phased roadmap (§10 there). Phase 3 of THIS repo
  is a scoping decision, not a pre-written plan (see §5 below).
- **Recommended process** (worked for both phases): brainstorm/spec →
  `superpowers:writing-plans` → `superpowers:subagent-driven-development`
  (fresh subagent per task, two-stage review, final whole-branch review) —
  but see §8 for which tasks to keep controller-side.
- Phase 2's progress ledger: `.superpowers/sdd/progress.md` (gitignored
  scratch; may be gone). Start a fresh one.

## 3. CRITICAL must-knows

1. **Spec text says `gemini`; the code says `antigravity`** (command `agy`) —
   Google sunset the standalone gemini CLI's OAuth mid-Phase-1. The spec's
   as-built addendum (top of the spec file) records this. Trust
   `src/config.js`.
2. **`antigravity` and `copilot` are alt-screen "degraded"**: state detection
   is reliable; PTY `extractResponse` is best-effort. The headless-runner
   pattern (`src/facade/headlessClaudeRunner.js`) is the fidelity path — a
   natural Phase 3 item is an `agy -p` headless runner if Antigravity
   fidelity matters.
3. **Adapter markers are version-pinned UI copy.** claude markers verified
   live on 2.1.218; codex on 0.134.0. **codex's update-skip persists only
   until its next release** — when codex 0.146+ lands, the update dialog
   returns (the adapter now recognizes it and answers "3. Skip until next
   version"; it must NEVER auto-Enter — the default option runs
   `npm install -g`). After ANY CLI update, run the live-acceptance script
   as the drift canary before trusting the bridge.
4. **Facade streaming is best-effort** (documented in docs/API.md): deltas
   can carry stray chrome and may duplicate lines after a mid-turn repaint;
   they never DROP final content (prefix-aware `StreamRenderer.finish()`).
   Non-stream text and stored fingerprints are always the clean final
   render. Byte-exact streams = `claude-headless` only. **Don't build
   automated parsing on PTY stream deltas.**
5. **Prompt-submit timing is load-bearing.** `promptWriter.js` separates the
   text write from the submit `\r` by `SUBMIT_DELAY_MS` (50ms) — same-burst
   writes intermittently strand the prompt unsubmitted in codex's composer.
   Downstream constraints: the busy state is re-armed AFTER the submit (a
   `quiescenceMs <= 50` profile would otherwise settle mid-gap), and
   `fake-repl.sh`'s burst-drain window must stay strictly between
   `SUBMIT_DELAY_MS` and the tests' `QUIESCENCE_MS` (currently 120ms
   drain / 200ms quiescence). Change any of the three numbers together.
6. **The single-token trust model is a hard boundary.** The facade
   deliberately kept it (spec + README security sections): token = full
   control of every enabled CLI. Anything multi-user (the XDR console) must
   add authN/Z OUTSIDE the bridge — see §5.

## 4. What Phase 2 delivered — the seams Phase 3 builds on

| Piece | What it gives Phase 3 |
|---|---|
| `POST /v1/chat/completions`, `/v1/responses`, `/v1/messages`, `GET /v1/models` | Any OpenAI/Anthropic-SDK tool can drive the CLIs. Base URLs: `:7681/v1` (OpenAI SDKs), `:7681` (Anthropic SDK). Bridge token = API key. `model` = profile name. |
| `src/facade/router.js` (`ConversationRouter`) | Stateless-request → live-session mapping: pins (`X-Bridge-Conversation` > `previous_response_id` > `model#suffix`) + history-fingerprint stickiness; seeding on miss; TTL+LRU (`FACADE_SESSION_TTL_MS`/`FACADE_PINNED_TTL_MS`/`FACADE_MAX_SESSIONS`); 409 dialog-pending retry-attach; 429 at capacity. |
| `src/facade/headlessClaudeRunner.js` | `claude -p --output-format stream-json --resume` chain: REAL usage, exact text, no PTY. The template for an `agy -p` runner. |
| `src/facade/turnRunner.js` | One PTY turn: startup-settle gate, suspect gate, StreamRenderer deltas, spawn-failure diagnostics in `bridge.*` error fields. |
| `src/facade/shared.js` | Provider-shaped error maps (`FacadeError(status, kind)` → native SDK exceptions), SSE helpers, `AsyncQueue`, usage mappers. Reuse for any new dialect. |
| `scripts/live-acceptance.mjs` | The live canary (§3.3). Accepts profile args: `node scripts/live-acceptance.mjs claude`. |
| Error surface | Fully documented in docs/API.md (shape table incl. 409 `bridge_dialog_pending` flow) and enforced by `test/facadeErrors.test.js` + `test/sdkAcceptance.test.js`. |

## 5. Phase 3 scope — a decision, not a plan

`docs/integration/defender-xdr-threat-hunting.md` (its §10 roadmap) is the
destination: Defender XDR auto-triage + an analyst console. Its next step
("Phase 1 — auto-triage": Graph poller → hunt queue → hunt runner → results
store → notification) was written PRE-facade and assumed the Agent SDK for
automated hunts. Two things Phase 2 changed, one thing it didn't:

- **Changed:** any OpenAI/Anthropic-compatible tooling can now drive the
  bridge directly — the console's "embedded terminal + programmatic turns"
  no longer needs custom bridge-API clients.
- **Changed:** `claude-headless` gives structured, real-usage turns through
  the facade — the "don't parse bridge output" objection no longer applies
  to that profile.
- **NOT changed:** the XDR doc's §3/§9 position that **unattended automated
  security hunts belong on commercial API terms, not a personal
  subscription** — the facade makes automation *possible* on the
  subscription, not *appropriate*. Honor that boundary when scoping: the
  bridge/facade is the interactive-investigation surface; scheduled
  auto-triage should use the Agent SDK path.
- Also unchanged: everything in the XDR doc's hardening list (SSO in front,
  per-user isolation, TLS/reverse proxy, secrets, audit logging, host
  hardening) before any multi-user exposure.

Candidate Phase 3 scopes, roughly independent: (a) the auto-triage pipeline
(Agent SDK side, mostly a NEW service beside this repo); (b) the analyst
console (web UI embedding the existing WS terminal + facade calls); (c)
bridge hardening for team use (the list above); (d) fidelity work —
`agy -p` headless runner, §6 follow-ups. Scope with the user before
planning.

## 6. Follow-ups carried forward (triaged, non-blocking)

From Phase 2's per-task reviews and the final review:

1. **Dialect validation scaffolding is triplicated** — a shared
   `validateMessagesShape()` in `facade/shared.js` would dedup
   `openaiChat`/`openaiResponses`/`anthropicMessages` (plan mandated
   verbatim structure; cleanup deferred).
2. **`router._attachPending` reads `det.state` synchronously** — inherits
   the awaiting_input-is-settled shortcut; untested busy-wait branch and a
   ~quiescenceMs retry race window.
3. **Headless runner edge:** a `result` event with `is_error: true` but exit
   0 reports a misleading "no result event" message.
4. **Test-harness fragility:** a facade test that throws before its cleanup
   leaks a PTY child, which HANGS the whole run (see §8). A per-test
   `afterEach`/try-finally cleanup sweep would fix the class.
5. **Generic/raw seeding limitation** (documented KNOWN LIMITATION in
   turnRunner.js): seeded turns on `generic` echo the preamble into
   returned text; real coalescing CLIs are unaffected.
6. Minor test gaps: `messages[i].role`-required 400 has no dedicated test;
   headless HTTP-level error paths aren't e2e (unit-tested only);
   StreamRenderer `_cleanLines` re-cleans per tick (fine at 100ms cadence).

## 7. Environment facts (this machine, 2026-07-24)

- Node v20.19.2. CLIs: `claude` 2.1.218 (subscription), `codex` 0.134.0
  (ChatGPT login; **update dialog will return at 0.146+**, see §3.3),
  `agy` 1.1.6, `copilot` 1.0.74 (gh keyring). Standalone `gemini` is dead.
- **Quota:** codex footer showed "weekly 93%" during live acceptance; each
  live-acceptance run costs ~9 small turns across three CLIs.
- **Inherited-env noise:** when the bridge is launched from inside a Claude
  Code session, spawned `claude` CLIs inherit the `CLAUDE_CODE_CHILD_SESSION`
  marker — replies carry a "Transcript saving is off" banner and safeguards
  notices. Environment-specific; absent for a normally-launched bridge. Keep
  live-acceptance assertions substring-based (`/PONG/`) for this reason.
- Capture/fixture tooling: `scratch/` (gitignored); committed fixtures under
  `test/fixtures/` with markers documented in `test/fixtures/NOTES.md`.
  `test/fixtures/codex-update-dialog.txt` is RECONSTRUCTED from a live
  rendered capture (the skip persisted, so it can't be re-captured until
  codex's next release).

## 8. Process gotchas (accumulated, both phases)

- **NEVER pipe the test suite** (`node --test | grep` hangs): a leaked
  fake-repl PTY child holds the pipe write-end open. Always
  `node --test > file 2>&1`, then read the file.
- **Kill leaked PIDs with the bracket trick** (`pgrep -f '[f]ake-repl'`) —
  a plain `pgrep -f`/`pkill -f` matches your own wrapper shell and kills the
  controller (exit 144). Never broad-pkill during a live suite run — it
  kills that run's workers and fakes a failure.
- **Don't run concurrent suites.**
- **Subagents auto-background server-spawning test tasks and stall.** Both
  phases hit this. Run heavy integration tasks controller-side; dispatch
  subagents for review. If dispatching implementers anyway, put "run tests
  foreground; do NOT background" in the prompt.
- **Live verification is not optional for PTY-facing changes.** Phase 2's
  offline suite was 205/205 green while FOUR live-only bugs existed
  (startup race, codex update dialog, stream content loss, submit
  coalescing) — all invisible to instantly-ready fake REPLs. Budget a live
  pass into any phase that touches turn mechanics, and expect the first
  live run to fail.
- Fake-REPL fixtures model real-CLI behavior only as faithfully as their
  timing knobs (§3.5). When a fixture and a real CLI disagree, capture the
  real behavior first, then adjust the fixture to model it.

## 9. Key artifacts

- Delivered spec (with as-built addendum):
  `docs/superpowers/specs/2026-07-23-universal-cli-and-api-facade-design.md`
- Phase 2 plan (workflow/style reference):
  `docs/superpowers/plans/2026-07-24-cloud-api-facade.md`
- Intended use / Phase 3 destination:
  `docs/integration/defender-xdr-threat-hunting.md`
- API reference incl. facade: `docs/API.md` · Concept docs: `README.md`
- Merged PRs: [#1](https://github.com/NerfBlasters/interactive-claude-bridge/pull/1)
  (universal CLI), [#2](https://github.com/NerfBlasters/interactive-claude-bridge/pull/2)
  (facade)
- Live canary: `scripts/live-acceptance.mjs`
- This handoff: `docs/superpowers/2026-07-24-phase-3-handoff.md`
