# Phase 5 Handoff — pty-web-bridge after copilot-headless (first-class)

**Written 2026-07-24, after `copilot-headless` was implemented, live-validated,
reviewed, and merged to local `master` (merge commit `ad25352`).** This doc lets
a fresh session resume cold. It supersedes `2026-07-24-phase-4-handoff.md`; where
they disagree, THIS one wins. (Phase 4's §5 candidate #1 — copilot — is now
DONE; the rest of its candidate list is carried forward in §5 below.)

---

## 1. Status / where things stand

- **`copilot-headless` is DONE and merged to local `master`** (merge `ad25352`,
  `--no-ff`, branch `feat/copilot-first-class` kept). It is a first-class facade
  profile mirroring `claude-headless`: exact-text turns through
  `copilot -p --output-format json`, no PTY / alt-screen extraction.
- **⚠️ NOT PUSHED.** `master` is **ahead of `origin/master`** (the copilot work
  + this handoff; `git log --oneline origin/master..master` for the exact set).
  Phases 1–3 landed via GitHub PRs; this phase was merged locally on user
  instruction. Push (or open a PR) when you want it on the remote:
  `git push origin master` — or push the branch and PR it.
- **copilot pin bumped 1.0.74 → 1.0.75** (`cli-pins.json`). npm `latest` had
  moved and the vendored platform binary had self-updated during the device
  login. Boot handshake is green: `version ok: copilot 1.0.75`.
- **237/237 offline tests** (`node --test`, zero live-CLI). **Live
  `live-acceptance.mjs copilot-headless` = 3/3 byte-exact** (`PONG`/`DONG`/`PING`,
  resume-based stickiness end-to-end). The other profiles' live status is
  unchanged from Phase 4 (not re-run this session except copilot).
- Reviewed by an adversarial multi-lens pass: 3 low findings fixed, 2 dismissed
  with cause (see the plan doc's EXECUTED section).

## 2. How to resume

```bash
cd /home/kali/repos/pty-web-bridge
git checkout master
npm run pin          # vendor/ is gitignored — every fresh clone/worktree needs this
node --test > /tmp/suite.out 2>&1; tail -3 /tmp/suite.out   # expect 237/237
```

- To push the merged work: `git push origin master` (currently 5 ahead).
- Recommended process (worked for all phases): brainstorm/spec →
  `superpowers:writing-plans` → execute with per-task commits + a review
  subagent pass — but run heavy PTY/test/live work controller-side (§7);
  dispatch subagents for review only.

## 3. CRITICAL must-knows

1. **copilot's tool lockdown is a load-bearing security boundary — do not
   relax it.** `copilot -p` is agentic: with no `--allow-all-tools` and an
   EMPTY `--available-tools=`, copilot 1.0.75 STILL auto-executed the builtin
   `bash` tool on the host (verified live). The facade exposes copilot as a
   chat responder over untrusted prompts, so tool execution must be impossible.
   The working lockdown (hardcoded in `src/facade/headlessCopilotRunner.js`
   `FIXED_ARGS`, regression-locked by `test/headlessCopilotRunner.test.js`):
   `--available-tools=__none__` (a **non-empty BOGUS allowlist** — exposes zero
   real tools; per `copilot help permissions` this filter is UPSTREAM of
   `--allow-*`/`--deny-*` approval, so nothing re-exposes `bash`) +
   `--disable-builtin-mcps` + `--no-ask-user`, never `--allow-all-tools`. The
   profiles also scrub `COPILOT_ALLOW_ALL` (env form of `--allow-all-tools`).
   **The empty `--available-tools=` form does NOT filter — the non-empty bogus
   name is the point.**
2. **copilot auth = its OWN device-code login under `~/.copilot` (config.json),
   NOT the `gh` keyring.** The Phase 3/4 "rides the gh keyring" note was WRONG
   (that keyring is only for the `gh` tool) and is now corrected in README,
   DOCKER.md, and the copilot adapter header. Scrubbing
   GH_TOKEN/GITHUB_TOKEN/COPILOT_GITHUB_TOKEN just removes ambient PATs so
   copilot falls back to its stored subscription login. Docker: mount
   `~/.copilot` (or `docker exec -it <ctr> copilot login`).
3. **The PTY `copilot` profile's facade extraction is EMPTY on 1.0.75.** Cause
   is alt-screen repaint-in-place: the `● PONG` answer renders on screen but the
   line count never advances, so `renderLinesSince` finds nothing. This is the
   pre-documented DEGRADED behavior, now fully empty — NOT marker drift (idle
   `/ commands · ? help` + the `● <answer>` block still match on 1.0.75). Use
   `copilot-headless` for the facade; the PTY `copilot` profile is still fine
   for interactive session/WS use (a human sees the screen). Do not spend effort
   fixing alt-screen extraction — the headless path supersedes it.
4. **copilot-headless session identity is ASSIGNED, not discovered.** Turn 1
   passes `--session-id <uuid>` (we generate); turn 2+ passes `--resume=<uuid>`.
   `result.sessionId` echoes it back. Contrast claude-headless, which DISCOVERS
   its id from the init event. The shared router slot was renamed
   `conv.claudeSessionId → conv.resumeSessionId` (agnostic).
5. **The pinning system is live — respect the bump workflow** (unchanged from
   Phase 3/4): edit `cli-pins.json` → `npm run pin` → live canary → fix
   markers/fixtures → commit together. For copilot, canary BOTH profiles
   (`copilot copilot-headless`); `copilot-headless` is the gate that must stay
   green. Escape hatch `BRIDGE_USE_HOST_CLIS=1`; strict boot
   `BRIDGE_STRICT_VERSIONS=1`. **A self-updating vendored binary can drift the
   pin silently** (copilot did — npm package.json read 1.0.74 while the platform
   binary bytes were 1.0.75); `--version` is the source of truth, not
   package.json.
6. **Single-token trust model is a hard boundary** (unchanged): token = full
   control of every enabled CLI, and `copilot-headless` inherits copilot's `-p`
   agentic nature (locked down per must-know #1). Multi-user anything needs
   authN/Z OUTSIDE the bridge (generic hardening list in ARCHITECTURE.md).
7. **Facade usage is a soft guarantee.** `claude-headless` reports real
   input+output tokens; `copilot-headless` reports real OUTPUT tokens but
   estimates input (copilot exposes no per-turn input count), so its usage
   object is flagged `estimated:true`. PTY profiles are chars/4 for both.

## 4. What this phase added — the new seams

| Piece | What it gives future work |
|---|---|
| `src/facade/headlessCopilotRunner.js` | JSONL runner for `copilot -p`: parses `assistant.message_delta` (deltas) / `assistant.message` final_answer (text) / `result` (sessionId); hardcoded tool lockdown; assign-then-resume session identity |
| `headlessRunner` discriminator on `mode:'headless'` profiles (`config.js`) + `HEADLESS_RUNNERS` dispatch in `router._runTurn` | Adding another headless CLI = one profile entry + one runner + a map entry; no router surgery |
| `conv.resumeSessionId` (was `claudeSessionId`) | Agnostic resume-id slot shared by all headless runners |
| `scripts/helpers/copilot-stub.mjs` (`COPILOT_STUB_RECORD`, `COPILOT_STUB_RESULT_SID`) | Offline test stub mirroring copilot's JSONL contract; records argv/env for lockdown + scrub assertions |
| `scratch/render-fixture.mjs` (existing) + a throwaway PTY capture pattern | How to diagnose alt-screen marker/extraction issues without live turns beyond one PONG |

## 5. Next-work candidates (no order committed)

1. **Push / PR the merged copilot work** (see §1 — `master` is ahead of
   origin, unpushed). If PR: the branch `feat/copilot-first-class` still exists.
2. **`agy -p` headless runner** — same shape as copilot-headless, IF Antigravity
   has a non-interactive mode (check `agy --help` first). `antigravity` PTY
   extraction is also alt-screen-degraded, so a headless path is the fidelity fix.
3. **PTY copilot facade extraction** — currently empty (must-know #3). Only worth
   it if interactive-copilot-over-facade is needed; would require adapter-specific
   full-screen (not `renderLinesSince`) extraction in turnRunner. Low priority —
   headless supersedes.
4. **Carried Phase 2 follow-ups** (still open): dedup triplicated dialect
   validation into `facade/shared.js`; `router._attachPending` sync-read race;
   headless `is_error`+exit-0 message; per-test `afterEach` PTY-cleanup sweep
   (the class that hangs suites — see §7); minor test gaps (role-required 400,
   headless HTTP e2e).
5. **Phase 3 follow-ups:** couple vendor resolution to the manifest / auto-prune
   stale bins (stale-vendor caveat); multi-stage Dockerfile (drop node-pty
   toolchain from runtime, pin base by digest); **now also**: guard against the
   self-updating-vendored-binary drift (must-know #5) — e.g. a pin check that
   compares `--version` not package.json.
6. **Team hardening** (reverse proxy, per-user isolation, audit logging) if the
   bridge ever fronts more than one operator.

## 6. Environment facts (this machine, 2026-07-24)

- Node v20.19.2, npm 9.2.0. Docker available.
- Pinned & live-validated: claude 2.1.219 (npm), codex 0.134.0, **copilot 1.0.75**
  (npm), agy 1.1.6 (external, sha256 in manifest). Host claude self-updates
  (native installer; irrelevant to the bridge).
- **Quota:** ~20 copilot AIU spent this session (spike ~9.3, headless live ~5.6,
  PTY live ~5.6, one diagnostic capture). Copilot total quota not baselined — the
  JSON `session.usage_checkpoint.totalNanoAiu` gives per-session credits, and the
  text-mode stderr footer shows `AI Credits`/`Session: … AIC used`. codex weekly
  was ~93% before Phase 3 (untouched this session — re-check before a codex live
  pass).
- Inherited-env noise: bridges launched from inside a Claude Code session make
  spawned children print safeguards/transcript banners — keep live assertions
  substring-based.

## 7. Process gotchas (accumulated — still all true)

- **NEVER pipe the test suite** (`node --test | grep` hangs on a leaked PTY
  write-end). Always `> file 2>&1`, then read the file.
- **A test that throws before its cleanup leaks its server/PTY and hangs
  `node --test` at teardown** (all tests may show `ok`, then the run stalls).
  Hit this phase in `facadeMount.test.js` when the new profile broke a
  `deepEqual` before `b.close()`. Diagnose by running each file in isolation
  (`for f in test/*.test.js; do timeout 45 node --test "$f"; done`) to find the
  non-exiting one. `sessionManager.test.js` is an intermittent leaker too.
- **Don't run concurrent PTY-spawning suites.** Pure-fs single-file runs are
  fine alongside.
- **Subagents auto-background server/PTY-spawning test tasks and stall.** Run
  PTY/test/live work controller-side; subagents for review (worked well — the
  review subagents found the real usage-flag bug).
- **Live verification is not optional for PTY-facing changes**; expect the first
  live run after any CLI bump to fail on marker drift (or, for copilot, empty
  alt-screen extraction).
- **Shell is zsh:** unquoted `$var` does NOT word-split. Use arrays
  (`FILES=(...); node --test $FILES`) or `${(f)var}`, not `node --test $FILES`
  from a newline string.
- **node-pty / capture scripts resolve modules from the repo root** — put ad-hoc
  capture scripts under `scratch/` (or run from the repo dir), not the scratchpad.
- GitHub ops right after a repo rename can 500 — check githubstatus.com first.

## 8. Key artifacts

- Copilot plan + **executed spike results / go-no-go security finding**:
  `docs/superpowers/plans/2026-07-24-copilot-first-class-plan.md` (EXECUTED
  section at the end)
- This phase's commits on `master`: `2fab8c2` (pin bump), `ca47877` (feature),
  `934243b` (docs), `bb73393` (review fixes), `ad25352` (merge)
- Live canary: `scripts/live-acceptance.mjs [profile ...]` (copilot needs
  `copilot copilot-headless`)
- Runner: `src/facade/headlessCopilotRunner.js` · stub:
  `scripts/helpers/copilot-stub.mjs` · dispatch: `src/facade/router.js`
  (`HEADLESS_RUNNERS`, `_runTurn`)
- Docs: README (support tiers, profiles, env-scrub, bump workflow) ·
  docs/API.md (models, usage) · docs/DOCKER.md (copilot `~/.copilot` auth) ·
  docs/ARCHITECTURE.md
- Prior handoffs (historical): `2026-07-24-phase-4-handoff.md` (and phases 2–3)
- This handoff: `docs/superpowers/2026-07-24-phase-5-handoff.md`
