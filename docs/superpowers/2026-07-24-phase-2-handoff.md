# Phase 2 Handoff — pty-web-bridge cloud-API facade

> **SUPERSEDED (2026-07-24):** Phase 2 shipped (PR #2). Read
> [`2026-07-24-phase-3-handoff.md`](2026-07-24-phase-3-handoff.md) instead;
> this doc is kept as history of the pre-facade state.

**Written 2026-07-24, after Phase 1 (universal CLI support) merged to `master`.**
This doc lets a fresh session resume cold. Read it, then read the spec's Phase 2
sections. Everything below is current as of merge commit `5495623`.

---

## 1. Status / where things stand

- **Phase 1 is DONE and merged to `master`** (PR #1, merged). `master` HEAD is
  `5495623` (the merge). Working tree is clean.
- **109/109 tests pass** (`npm test`, i.e. `node --test`). Baseline was 46.
- Phase 1 turned the single-CLI bridge into a **multi-CLI host**: per-session
  **profiles** with fixture-verified state-detection adapters, profile-driven
  env-scrub, a dialog-policy handler, a shared multiline-safe prompt writer, a
  redesigned `StateDetector`, and `profile` params + a cleaned `text` field on
  the HTTP/WS APIs.
- **Phase 2 is the cloud-API facade** and has NOT been started. It branches
  fresh from `master`.

## 2. How to resume

```bash
cd /home/kali/repos/pty-web-bridge
git checkout master && git pull --ff-only
npm test            # expect 109/109; ~60-90s (spawns real bash PTYs)
git checkout -b feat/cloud-api-facade   # Phase 2 branch off master
```

- **Spec (authoritative):** `docs/superpowers/specs/2026-07-23-universal-cli-and-api-facade-design.md`.
  Phase 2 is the sections under "## Phase 2 — Cloud-API facade" plus the shared
  Error handling / Security / Testing / Translation-rules sections. That spec
  was already hardened by two adversarial review rounds (subagent workflow +
  Codex) and Codex APPROVED it — its Phase 2 SSE event sequences, routing rules,
  and error shapes are spelled out concretely; trust them.
- **Phase 1 plan (reference for the workflow/style):**
  `docs/superpowers/plans/2026-07-23-universal-cli-support.md`.
- **Recommended process** (what Phase 1 used, worked well): brainstorm only if
  scope is unclear → `superpowers:writing-plans` to produce a Phase 2 plan from
  the spec → `superpowers:subagent-driven-development` to execute
  (fresh subagent per task + two-stage review + final whole-branch review).
- **Progress ledger** from Phase 1 (gitignored scratch, may be gone after a
  clean): `.superpowers/sdd/progress.md`. Start a fresh one for Phase 2.

## 3. CRITICAL must-knows (things the spec/plan text will mislead you on)

1. **There is NO `gemini` profile.** The spec and Phase-1 plan TEXT still say
   "gemini", but during execution Google sunset the standalone `gemini` CLI's
   OAuth for individual accounts. The profile was pivoted (user-approved) to
   **Antigravity**: profile `antigravity`, command `agy`, adapter `antigravity`.
   **Trust the CODE (`src/config.js`, `src/adapters/index.js`), not the spec's
   "gemini" wording.** When Phase 2 says model `gemini` → it means `antigravity`.
   The spec doc was left as-is (out of Phase-1 scope); reconcile it in Phase 2 if
   you touch it.
2. **`copilot` is a fully verified adapter, not a stub.** It authenticates via
   this machine's `gh` keyring (account NerfBlasters) even with the token env
   vars scrubbed. Full prompt round-trip captured.
3. **Two adapters are DEGRADED (alt-screen):** `antigravity` and `copilot` use
   the alternate screen buffer. State detection is reliable, but
   **`extractResponse` is best-effort** — the PTY transcript-diff is not a clean
   scrollback across alt-screen repaints. This is exactly why the spec's Phase 2
   **headless runner** matters for fidelity. `claude`, `codex`, `generic` are
   NOT degraded.
4. **`extractResponse` collapses blank lines** (a Phase-1 follow-up): the
   adapters' `extractResponse` filters out ALL blank lines, so a multi-paragraph
   assistant reply becomes a run-on block. The raw `output` field is unaffected.
   **This affects facade fidelity — fix it early in Phase 2** (see §6).

## 4. What Phase 1 delivered — the seams Phase 2 builds on

Everything the spec's Phase 2 design assumed now exists:

| File | What it gives Phase 2 |
|---|---|
| `src/config.js` | `loadConfig(env)` → frozen `{profiles, defaultProfile, …}`. `profiles[name]` = `{name, command, args, adapter, envScrub, dialogPolicy, mode, quiescenceMs, cols, rows, cwd}`. Built-ins: `claude`, `codex`, `antigravity`, `copilot`, `generic`, `claude-headless` (`mode:'headless'`, `adapter:null`). `BRIDGE_PROFILES` allowlist; `PROFILE_<NAME>_*` overrides; 4-level precedence. |
| `src/sessionManager.js` | `SessionManager.create({profile?,cwd?,cols?,rows?})` → record `{id, session, terminalModel, detector, adapter, queue: PromptQueue, createdAt, profile, dialogPolicy}`. Throws coded errors `UNKNOWN_PROFILE`/`PROFILE_NOT_PTY`/`PROFILE_NO_COMMAND`/`ADAPTER_UNAVAILABLE` (all carry `.validProfiles`). Also exports `makeDialogHandler(record)`. Rejects `mode:'headless'` profiles (`PROFILE_NOT_PTY`) — the facade's headless path does NOT go through `create`. |
| `src/httpApi.js` | `createHttpServer(config, manager)`; **exports `sendPrompt(record, {text, submit, timeoutMs})`** → `{state, output, text, prompt, durationMs}` — the synchronous prompt primitive the facade's PtyTurnRunner wraps. Flat route table is where `/v1/*` routes mount (or mount a sibling module in `server.js`). |
| `src/wsApi.js` | `attachWss(server, config, manager)` — pattern for a sibling facade module mounted on the same server + token gate. |
| `src/stateDetector.js` | `StateDetector` with `state`, `markBusy()`, `waitForSettle({timeoutMs})`, `'state'` event, `isBusy` periodic evaluation, and a `dialogHandler` hook. `waitForSettle` resolves `'idle'`/`'awaiting_input'`, rejects `'session exited'`/`'settle timeout'`. |
| `src/promptWriter.js` | `writePromptText(session, adapter, text)` + `MultilineUnsupportedError` — multiline-safe writing (bracketed paste / `newlineKey` / `raw` / reject). Reuse in the facade. |
| `src/adapters/*.js` | Contract: `name, isIdle, isBusy, isAwaitingInput, describePrompt, extractResponse, startupDialogs, keySeq`. Registry in `index.js` (`getAdapter` throws on unknown). |
| `src/auth.js` | `checkToken`/`extractToken` — accepts `Authorization: Bearer` (the facade's API-key form). The Anthropic dialect must ALSO accept `x-api-key` (add in Phase 2). |
| `src/terminalModel.js` | `@xterm/headless` render: `snapshotLineCount`, `renderLinesSince`, `viewportTail`. |

**The `text` field on `POST /prompt`** already gives you chrome-stripped
assistant text per adapter (best-effort for degraded adapters) — the facade's
non-streaming response content builds on the same `adapter.extractResponse`.

## 5. Phase 2 scope (from the spec — read it, this is a summary)

- **`src/facade/`** new module (spec §"Module layout"): `index.js` (mount enabled
  dialects), `router.js` (`ConversationRouter`), `turnRunner.js`
  (`TurnRunner` interface + `PtyTurnRunner`), `headlessClaudeRunner.js`,
  `streamRenderer.js`, `models.js` (`GET /v1/models`, shared), and
  `dialects/{openaiChat,openaiResponses,anthropicMessages}.js`.
- **Three dialects, each toggleable, all default on:** OpenAI Chat Completions
  (`FACADE_OPENAI_CHAT`), OpenAI Responses (`FACADE_OPENAI_RESPONSES`), Anthropic
  Messages (`FACADE_ANTHROPIC_MESSAGES`). Provider-shaped errors so official SDKs
  raise native exceptions. `model` = profile name. `GET /v1/models` lists
  facade-usable profiles.
- **Hybrid conversation router:** explicit pin (model suffix `<profile>#<id>` or
  `X-Bridge-Conversation` header; header wins) + history-prefix fingerprint
  stickiness as default; seed a fresh session from prior messages on miss. TTL +
  LRU reaping. Same-conversation requests serialize on the existing
  `PromptQueue`; distinct conversations parallelize. (Full rules incl.
  `previous_response_id` continuity, Anthropic `system`/prefill handling, at-cap
  429 — all in the spec.)
- **`TurnRunner` seam:** `PtyTurnRunner` (wraps `sendPrompt`/`StreamRenderer` over
  any `mode:'pty'` profile) + **`HeadlessClaudeRunner`**
  (`claude -p --output-format stream-json --include-partial-messages --resume` —
  verified this flag set exists on the installed claude; parses `init`→session_id,
  `stream_event` text deltas, `result`→final text + real usage).
- **Acceptance:** official `openai` and `anthropic` SDKs pointed at the bridge,
  streaming + non-streaming, as integration tests.
- **Dialog policy during a facade turn:** already implemented at the detector/
  handler level in Phase 1; the facade maps an un-answered dialog to a
  provider-shaped error (spec Error-handling).

## 6. Phase 1 follow-ups (non-blocking; triaged by the final review)

Consider folding the first two into early Phase 2 work:

1. **`extractResponse` blank-line collapse** (all adapters) — collapses
   multi-paragraph replies. **Fix before facade response fidelity depends on it.**
   Same root affects the `•`/`●` per-line strip (only single-line responses
   tested).
2. **`httpApi` `/key` uses the global `quiescenceMs`**, not the session's
   per-profile `detector._quiescenceMs` (best-effort, capped 1000ms).
3. `config.js` `let args = base.args` should be `[...base.args]` (inert today —
   all built-in `args: []`, freezes a shared module constant).
4. Test gaps: `PROFILE_<NAME>_ADAPTER`/`_MODE` are ignored (untested); the
   `wsApi` post-upgrade `manager.create` `try/catch` (1011 close) is untested.
5. `wsApi` duplicates SessionManager's 3 profile-validation checks; its "no
   command" message omits the `(set PROFILE_<NAME>_COMMAND)` hint.

## 7. Environment facts (this machine)

- **Node v20.19.2.** (`@github/copilot` docs say Node 22+, but it installed and
  runs fine on 20 — engines was advisory.)
- Installed + authenticated CLIs: `claude` 2.1.218 (subscription),
  `codex` 0.134.0 (ChatGPT login), `agy` 1.1.6 (Antigravity, Google
  subscription), `copilot` 1.0.74 (via `gh` keyring). The standalone `gemini`
  0.33.1 is installed but its OAuth is DEAD — do not use it.
- **Headless-runner-relevant flags (verified):** `claude` has
  `-p/--print --output-format stream-json --include-partial-messages
  --resume/--continue`. `agy` has `-p/--print --continue --conversation
  --from-pr` (a natural second headless runner if Phase 2 wants Antigravity
  fidelity — currently degraded on the PTY path). `codex` has `codex exec`
  (non-interactive) and honors `CODEX_API_KEY` only in exec mode.
- Capture/fixture tooling lives in `scratch/` (**gitignored**):
  `render-fixture.mjs`, `capture-{codex,gemini,antigravity,copilot}.mjs`. Real
  fixtures are committed under `test/fixtures/<cli>-*.txt`; per-CLI marker
  writeups are in `test/fixtures/NOTES.md`.

## 8. Process gotchas learned in Phase 1

- **Subagents auto-background long PTY-spawning test suites.** On the two
  heaviest integration tasks (HTTP + WS APIs), general-purpose implementer
  subagents kept launching `node --test` in the background and ending their turn
  to "wait," stalling. Workaround used: the controller implemented those two
  directly, then dispatched independent reviewers. For Phase 2's SDK integration
  tests (which spawn servers + real CLIs), either tell subagents explicitly to
  run tests foreground and NOT background them, or run the heavy integration
  tasks controller-side and review via subagent.
- **Live-CLI capture spikes were run controller-side**, not delegated — they need
  real authenticated CLIs and iterative marker verification against rendered
  output. Phase 2's headless-runner work against a real `claude -p` is similar;
  a stub `claude` shim script (per the spec's Testing §3) keeps most of it in CI.
- Adapter markers are **version-pinned UI copy** — every fixture-derived marker
  was empirically re-verified (matches only the frames where the state holds).
  Hold Phase 2's stream-json parsing to the same "grounded in a real capture or a
  faithful stub" bar.

## 9. Key artifacts

- Spec: `docs/superpowers/specs/2026-07-23-universal-cli-and-api-facade-design.md`
- Phase 1 plan: `docs/superpowers/plans/2026-07-23-universal-cli-support.md`
- Adapters + fixtures + `NOTES.md`: `src/adapters/`, `test/fixtures/`
- Merged PR: https://github.com/NerfBlasters/interactive-claude-bridge/pull/1
- This handoff: `docs/superpowers/2026-07-24-phase-2-handoff.md`
