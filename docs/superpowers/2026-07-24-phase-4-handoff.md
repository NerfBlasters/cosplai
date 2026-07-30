# Phase 4 Handoff — pty-web-bridge after agnostic identity + version pinning

**Written 2026-07-24, after Phase 3 merged to `master` (PR #3, merge commit
`35b0c63`).** This doc lets a fresh session resume cold. Its predecessor
(`2026-07-24-phase-3-handoff.md`) is now historical — read this one instead;
where they disagree, this one wins.

---

## 1. Status / where things stand

- **Phases 1-3 are DONE and merged.** Phase 1 = universal multi-CLI (PR #1),
  Phase 2 = OpenAI/Anthropic cloud-API facade (PR #2), Phase 3 = agnostic
  identity + CLI version pinning + Docker (PR #3). `master` HEAD `35b0c63`.
- **The repo is now `NerfBlasters/pty-web-bridge`** (renamed from
  `interactive-claude-bridge`; old URLs redirect). Package, banner, and all
  living docs are CLI-agnostic; the XDR/Defender framing is gone by user
  decision — do not reintroduce it (its hardening list lives on,
  genericized, in ARCHITECTURE.md).
- **227/227 offline tests** (`node --test`, zero live-CLI usage).
  **Live acceptance 9/9 on the VENDORED binaries** (claude 2.1.219,
  claude-headless, codex 0.134.0, both SDKs, stream + stickiness).
  **Docker image builds + smoke-passes** (generic/bash session over the
  published port; runs as uid-1000 `node` user; vendored CLIs on PATH).
- **There is no committed Phase 4 spec.** Next-work candidates are in §5;
  the copilot plan (§5.1) is written and ready to execute.

## 2. How to resume

```bash
cd /home/kali/repos/pty-web-bridge
git checkout master && git pull --ff-only
npm run pin          # vendor/ is gitignored — every fresh clone/worktree needs this
node --test > /tmp/suite.out 2>&1; tail -3 /tmp/suite.out   # expect 227/227
git checkout -b feat/<phase-4-scope>
```

- Recommended process (worked for all three phases): brainstorm/spec →
  `superpowers:writing-plans` → execute with per-task commits and a
  review-subagent pass — but run heavy PTY/test/live work controller-side
  (§7); dispatch subagents for review only.

## 3. CRITICAL must-knows

1. **The pinning system is live — respect the bump workflow.** The bridge
   spawns `vendor/` binaries (exact versions from `cli-pins.json`), NOT the
   host CLIs. Any CLI version bump: edit manifest → `npm run pin` →
   `node scripts/live-acceptance.mjs` (drift canary; expect first run after
   a bump to fail if UI copy moved) → fix markers/fixtures → commit
   together. README "Updating a pinned CLI" is the reference. Escape hatch:
   `BRIDGE_USE_HOST_CLIS=1`; strict boot: `BRIDGE_STRICT_VERSIONS=1`.
2. **Vendored claude is the npm dist (`@anthropic-ai/claude-code@2.1.219`),
   which declares node>=22 but runs on host node v20** (EBADENGINE warning
   at pin time is expected and harmless — live-validated). The HOST claude
   is the native installer and updates itself; that's fine, the bridge no
   longer cares.
3. **codex's update-skip still expires at its next release** (adapter
   answers "3. Skip until next version"; must NEVER auto-Enter — default
   runs `npm install -g`). With codex pinned at 0.134.0 the dialog stays
   dormant, but the moment the PIN is bumped to 0.146+, expect the dialog
   fixture (`test/fixtures/codex-update-dialog.txt`, reconstructed) to be
   re-capturable and the adapter path to exercise live.
4. **Stale-vendor caveat (known follow-up):** vendor-first resolution is
   directory-based; the handshake is manifest-based. A `vendor/bin` binary
   whose pin was REMOVED from the manifest still shadows the host silently
   at boot (pin script warns at pin time only). Don't "clean up" a manifest
   entry without also deleting its vendor bin.
5. **Prompt-submit timing is load-bearing** (unchanged from Phase 2):
   `SUBMIT_DELAY_MS` (50ms) between text write and `\r`; busy re-arms after
   submit; fake-repl drain (120ms) must stay strictly between the delay and
   the tests' `QUIESCENCE_MS` (200ms). Change all three together or none.
6. **Facade streaming is best-effort on PTY profiles** (deltas may carry
   chrome / duplicate lines after repaints; final text authoritative).
   Byte-exact = `claude-headless` only, so far. Don't build parsing on PTY
   stream deltas.
7. **Single-token trust model is a hard boundary** (unchanged): token =
   full control of every enabled CLI. Multi-user anything needs authN/Z
   OUTSIDE the bridge — the generic hardening list is in ARCHITECTURE.md's
   security section.

## 4. What Phase 3 added — the new seams

| Piece | What it gives future work |
|---|---|
| `cli-pins.json` + `src/pins.js` + `scripts/pin-clis.mjs` (`npm run pin`, `--npm-only`) | Reproducible CLI set; add a new pinned CLI = one manifest entry (npm or external+sha256) |
| Vendor-first resolution in `loadConfig` (`profile.baseCommand`, `vendorDir` opt for tests) | Tests inject fake vendor dirs; `baseCommand` keys manifest lookups |
| `src/versionCheck.js` (`checkVersions`, `applyStrict`) | Boot drift detection, dedup per (baseCommand, resolved path); reusable for any health surface |
| Per-profile `envSet` (config → Session + headlessClaudeRunner) | Declarative child-env injection; how autoupdaters stay off (`DISABLE_AUTOUPDATER=1`, copilot `--no-auto-update` via args) |
| `Dockerfile` + `docs/DOCKER.md` | Manifest-built image, `node` uid-1000 user, vendored PATH; copilot keyring is the documented gap |

## 5. Next-work candidates (no order committed)

1. **Copilot validation + `copilot-headless`** — the detailed workflow/test
   plan is WRITTEN and fact-checked against copilot 1.0.74's actual flag
   surface: `docs/superpowers/plans/2026-07-24-copilot-first-class-plan.md`.
   Track 1 (validate existing PTY profile live, ~5 turns) then Track 2
   (headless runner via `copilot -p -s --resume`, mirroring
   headlessClaudeRunner; go/no-go hinges on the tool-permission spike).
2. **`agy -p` headless runner** — same shape, if Antigravity fidelity
   matters (check whether `agy` has a non-interactive mode first).
3. **Carried code follow-ups** (from Phase 2 reviews, still open): dedup the
   triplicated dialect validation into `facade/shared.js`;
   `router._attachPending` sync-read race; headless `is_error`+exit-0
   message; per-test `afterEach` PTY-cleanup sweep (the class that hangs
   suites — see §7); minor test gaps (role-required 400, headless HTTP e2e).
4. **New Phase 3 follow-ups:** couple vendor resolution to the manifest (or
   auto-prune stale bins) — closes §3.4; multi-stage Dockerfile (drop the
   node-pty toolchain from runtime, pin base by digest).
5. **Team hardening** (reverse proxy, per-user isolation, audit logging) if
   the bridge ever fronts more than one operator.

## 6. Environment facts (this machine, 2026-07-24)

- Node v20.19.2, npm 9.2.0. Docker available and working.
- Pinned (and live-validated): claude 2.1.219 (npm), codex 0.134.0,
  copilot 1.0.74, agy 1.1.6 (external, sha256 in manifest). Host claude is
  the native installer (self-updates; irrelevant to the bridge now).
- `gh` authenticated via keyring, account NerfBlasters — copilot rides this
  even with token env vars scrubbed.
- **Quota:** codex weekly was at 93% BEFORE Phase 3's live run (~9 more
  small turns since). Check the codex footer before the next live pass.
  Copilot quota ("AIC used" footer / `copilot help billing`) not yet
  baselined — do that before executing the copilot plan.
- Inherited-env noise: bridges launched from inside a Claude Code session
  make spawned `claude` children print safeguards/transcript banners —
  keep live assertions substring-based (`/PONG/`).

## 7. Process gotchas (accumulated, all phases — still all true)

- **NEVER pipe the test suite** (`node --test | grep` hangs on a leaked PTY
  write-end). Always `> file 2>&1`, then read the file.
- **Suites can hang even unpiped**: a test that throws before cleanup leaks
  a PTY child and stalls the whole run. Witnessed this phase in
  `sessionManager.test.js` on an UNTOUCHED master baseline (leaked bash
  child, 4+ min stall). Diagnose with
  `ps --ppid <node --test pid>`; kill the specific PIDs (bracket trick:
  `pgrep -f '[f]ake-repl'`), re-run. Never broad-pkill during a run.
- **Don't run concurrent suites.** Single-file runs of pure-fs tests are
  fine alongside; anything PTY-spawning is not.
- **Subagents auto-background server-spawning test tasks and stall.** Run
  PTY/test/live work controller-side; subagents for review. Worked well
  this phase (review subagent found the two real Docker bugs).
- **Live verification is not optional for PTY-facing changes**, and expect
  the first live run after any CLI bump to fail on marker drift.
- GitHub ops right after a repo rename can 500 for a while (PR creation
  did, during an actual GitHub PR-service outage — check
  githubstatus.com before debugging yourself).

## 8. Key artifacts

- Phase 3 spec:
  `docs/superpowers/specs/2026-07-24-agnostic-identity-and-version-pinning-design.md`
  (§8 records the decisions: no new repo, no per-CLI split, uv rejected,
  Docker optional; don't relitigate)
- Phase 3 plan: `docs/superpowers/plans/2026-07-24-agnostic-identity-and-pinning.md`
- Copilot plan (next): `docs/superpowers/plans/2026-07-24-copilot-first-class-plan.md`
- Merged PRs: [#1](https://github.com/NerfBlasters/pty-web-bridge/pull/1)
  (universal CLI), [#2](https://github.com/NerfBlasters/pty-web-bridge/pull/2)
  (facade), [#3](https://github.com/NerfBlasters/pty-web-bridge/pull/3)
  (identity + pinning)
- Live canary: `scripts/live-acceptance.mjs [profile ...]`
- Docs: README (identity, pinning, bump workflow) · docs/ARCHITECTURE.md
  (modules incl. pins/versionCheck, hardening list) · docs/API.md ·
  docs/DOCKER.md
- This handoff: `docs/superpowers/2026-07-24-phase-4-handoff.md`
