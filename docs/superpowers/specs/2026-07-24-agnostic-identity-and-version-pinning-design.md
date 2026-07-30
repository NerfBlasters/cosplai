# Phase 3 — Agnostic identity + CLI version pinning (design)

**Date:** 2026-07-24 · **Status:** draft, pending user review
**Depends on:** Phases 1–2 merged (`master` @ `1360939`, 206/206 tests, 9/9 live)

## 1. Problem

Two accumulated debts, both about long-term maintainability rather than
features:

1. **Identity.** The repo began as "shared interactive `claude` session for a
   team using an AI-driven CLI investigation tool" and pivoted to "generic
   bridge that exposes any subscription-authed AI CLI as an OpenAI/Anthropic-
   compatible API." The code completed the pivot (profiles, adapters, facade
   dialects); the living docs did not. The README headline, intro, and
   "intended use" still describe a claude-only tool aimed at a Microsoft
   Defender XDR threat-hunting platform, and the GitHub repo is named
   `interactive-claude-bridge`.
2. **Version drift.** Adapter markers are version-pinned UI copy (claude
   verified on 2.1.218, codex on 0.134.0), but the bridge spawns whatever CLI
   the host `PATH` resolves. Host autoupdates silently change that. This is
   not hypothetical: the host `claude` has already moved to 2.1.219 since the
   Phase 2 live verification. A host update the operator didn't connect to
   the bridge can break turn mechanics with no warning.

## 2. Goals

- Every living doc and name reads as an **agnostic CLI-to-API bridge**,
  usable standalone or as a building block. No mention of XDR/Defender/
  threat-hunting as the intended use anywhere outside dated historical
  archives and git history.
- The bridge can run **pinned copies of the CLIs, decoupled from the host's**,
  so a host autoupdate cannot change what the bridge spawns.
- The bridge **detects and reports** version drift between the CLI it spawns
  and the version its adapter was verified against.
- A documented, low-friction **bump workflow** (pin → live canary → commit),
  because subscription CLIs can force-obsolete old versions server-side — a
  pin protects against *surprise* updates, it is not "frozen forever."

## 3. Non-goals

- No rewriting of dated historical documents (`docs/superpowers/specs/`,
  `plans/`, handoffs). They are process records; the pivot is part of the
  history they exist to record. This phase's own docs supersede their framing.
- No multi-user auth, TLS, or team-console hardening (unchanged boundary:
  single-token trust model; hardening lives outside the bridge).
- No per-CLI repo split. Decision recorded in §8: one universal repo.
- Docker is a **stretch** deliverable (Part C), not required for the phase to
  land. The pinning fix (Part B) must work on a bare host without it.
- No new facade features, no adapter behavior changes.

## 4. Part A — Identity reframe

### A1. Remove the XDR integration doc

- Delete `docs/integration/defender-xdr-threat-hunting.md` (and the
  `docs/integration/` directory, which then becomes empty).
- It stays recoverable in git history; its content belongs to the future
  auto-triage service, which was always scoped as a separate repo.
- **Preserve the §8 hardening list** by porting it, stripped of XDR context,
  into ARCHITECTURE.md's security section as a short generic "before exposing
  this beyond one operator" list: SSO/reverse-proxy in front, per-user
  isolation, TLS, secrets handling, audit logging, host hardening.

### A2. Rewrite living docs as the agnostic tool

Files: `README.md`, `docs/README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`
(reference sweep only — grep found no XDR text in API.md).

- **README.md** (main rewrite):
  - Title/intro: a local Node service that owns PTY-backed interactive AI CLI
    sessions (`claude`, `codex`, `copilot`, `antigravity`, or any REPL via
    `generic`) and exposes them three ways at once: browser terminal (WS),
    raw HTTP+SSE session API, and an OpenAI/Anthropic-compatible API facade.
    `claude` becomes one profile among peers, used in examples but not in the
    identity.
  - "Why PTY" section: generalize the subscription-auth rationale — every
    supported CLI authenticates via a subscription login its vendor's API
    SDKs cannot use; driving the real REPL over a PTY is what makes the
    subscription usable programmatically. Keep the honest trade-offs.
  - Replace the XDR "intended use" doc link with a short **"use it as a
    building block"** paragraph: standalone (browser terminal + curl), or as
    the API layer under a larger system (any OpenAI/Anthropic SDK client).
    No named example integration.
  - Add a short **support-tier table** (maintainability honesty, already true
    in code): first-class = `claude`, `codex`, `claude-headless`
    (live-verified, full extraction); best-effort = `copilot`, `antigravity`
    (alt-screen "degraded": reliable state detection, best-effort extraction);
    `generic` = bring-your-own REPL.
- **docs/README.md**: drop the XDR entry ("Start here for the intended use"),
  re-point to the reframed README.
- **docs/ARCHITECTURE.md**: replace the XDR §8 pointer with the ported
  generic hardening list (A1). Fix the stale "109 tests" count while in
  there: drop the literal number in favor of "the full offline suite
  (`node --test`)" so the sentence can't rot again.

### A3. Rename

- GitHub repo: `NerfBlasters/interactive-claude-bridge` → **`pty-web-bridge`**
  (matches the local checkout, mechanism-descriptive, CLI-agnostic; GitHub
  redirects the old URL so existing PR links keep working). Done via
  `gh repo rename`, then update the local `origin` remote URL.
- `package.json` `name` → `pty-web-bridge`.
- Sweep living docs for the old name.

## 5. Part B — CLI version pinning

### B1. Pin manifest — `cli-pins.json` (repo root, committed)

Keyed by **command name** (profiles reference commands; `claude` and
`claude-headless` share one binary):

```json
{
  "claude":  { "source": "npm", "package": "@anthropic-ai/claude-code", "version": "<verified>" },
  "codex":   { "source": "npm", "package": "@openai/codex",             "version": "<verified>" },
  "copilot": { "source": "npm", "package": "@github/copilot",           "version": "<verified>" },
  "agy":     { "source": "external", "version": "<verified>", "sha256": "<recorded by pin script>" }
}
```

- `source: "npm"` — installable at an exact version from the registry.
  (Host install method is irrelevant: the host `claude` uses the native
  installer, but `@anthropic-ai/claude-code` is the same CLI on npm, which
  gives us uniform pinning.)
- `source: "external"` — no public registry (`agy` is a single ~190 MB
  binary). Pinning = snapshot the host binary after verifying its
  `--version` matches the manifest; record its sha256.
- Initial pinned versions = whatever passes a **live-acceptance run at
  implementation time** (host claude is already 2.1.219; if it passes, pin
  it and update the adapter's verified-version note; if not, pin npm
  2.1.218).

### B2. Pin script — `scripts/pin-clis.mjs`

- Reads the manifest. For npm entries: writes `vendor/package.json` with
  exact versions and runs `npm install --prefix vendor` (bins land in
  `vendor/node_modules/.bin/`). For external entries: resolves the command
  on the host `PATH`, verifies `--version` output contains the manifest
  version (abort with a clear error if not), copies it to
  `vendor/bin/<cmd>`, records/checks sha256.
- Idempotent; `vendor/` is gitignored. Exposed as `npm run pin`.
- After install, runs `--version` on every vendored bin and prints a
  pin-report table (command, wanted, got, path).

### B3. Vendor-first command resolution (`config.js`)

For each profile whose `command` has no path separator, resolution order:

1. `PROFILE_<NAME>_COMMAND` env override (unchanged, still absolute winner).
2. Vendored bin: `vendor/node_modules/.bin/<cmd>` or `vendor/bin/<cmd>`, if
   present → absolute path.
3. Host `PATH` (current behavior — a checkout with no `vendor/` behaves
   exactly as today; zero friction for dev).

- `BRIDGE_USE_HOST_CLIS=1` skips step 2 (escape hatch / A-B debugging).
- The resolved path is logged per enabled profile at boot so the operator can
  see which binary will be spawned.

### B4. Autoupdate suppression

Spawned child env sets each CLI's documented no-self-update switch where one
exists (`claude`: `DISABLE_AUTOUPDATER=1`; others: confirm at implementation
time). Where no switch exists, the adapters' recognized-dialog handling
remains the universal backstop (codex's "Skip until next version" answer,
which must never auto-Enter). Both layers stay: the env switch prevents,
the dialog handling survives.

### B5. Version handshake at boot

- At server boot, for each enabled profile with a manifest entry, run
  `<resolvedCommand> --version` (short timeout; failure tolerated and
  logged, never fatal by default), extract the version token, compare to the
  manifest.
- Match → info log. Mismatch or unparseable → **warning** naming the spawned
  and verified versions and pointing at the bump workflow.
- `BRIDGE_STRICT_VERSIONS=1` → mismatches make boot **fail** with one clear
  error listing every mismatched profile (operator can trim
  `BRIDGE_PROFILES` or re-run the pin script). Default stays warn-only.
- Commands without a manifest entry (e.g. `generic`) are skipped.

### B6. Bump workflow (documented in README maintenance section)

1. Edit the version in `cli-pins.json`; run `npm run pin`.
2. Run `node scripts/live-acceptance.mjs` (the drift canary) against the
   affected profile(s). Expect the first run after a CLI update to fail.
3. Fix adapter markers / fixtures if drifted; update the adapter's
   verified-version note.
4. Commit manifest + adapter/fixture changes together.

### B7. Testing (CI stays hermetic — no live CLIs, no network)

- `config.test.js`: resolution-precedence units (env override > vendor >
  PATH; `BRIDGE_USE_HOST_CLIS` skip; no-vendor fallback) against a temp
  vendor dir with stub scripts.
- Handshake units: version-token extraction, match/mismatch/warn paths,
  strict-mode boot failure — driven by a stub command that prints a
  version (fake-repl or a two-line script fixture).
- Manifest schema validation unit (bad source, missing version → clear
  error).
- The pin script's npm-install path is exercised manually / in the live lane,
  not in CI (network). Its external-copy + verify logic is unit-testable with
  a stub binary.
- One **live-acceptance run gates the initial pin set** (§B1) — budget it.

## 6. Part C — Docker packaging (stretch)

Optional layer over Part B, for deployments wanting full host isolation.
Droppable without affecting A/B.

- `Dockerfile`: `node:20` base, copy bridge + `cli-pins.json`, run the pin
  script at build (npm entries resolve inside the image; `agy` is COPY'd or
  bind-mounted — image-size trade-off documented), non-root user,
  `HOST=0.0.0.0` inside with the published port mapped to loopback by
  default in the compose example.
- Auth state via volumes: `~/.claude`, `~/.codex`, copilot/gh config. One-time
  interactive logins documented as `docker exec -it <ctr> claude` etc.
- **Documented known limitation:** copilot authenticates via the `gh`
  keyring, which is awkward headless — investigate a file-based fallback at
  implementation time; if none exists, copilot is documented as
  degraded-in-container. PTY itself is fine (node-pty works in containers).

## 7. Success criteria

1. `grep -riE 'xdr|defender|threat.hunt' -r . --exclude-dir=superpowers --exclude-dir=node_modules --exclude-dir=.git`
   → zero hits (dated archives under `docs/superpowers/` exempt by decision
   §8.2).
2. README/docs present an agnostic multi-CLI bridge; `claude` appears only as
   a profile/example; support tiers and the generic hardening list present.
3. GitHub repo + `package.json` renamed; local remote updated; old PR links
   still resolve (redirect).
4. With `vendor/` populated, boot logs show vendored paths for pinned
   profiles, and updating/removing a host CLI does not change what the
   bridge spawns.
5. Handshake: mismatch produces the warning (unit-tested); strict mode fails
   boot (unit-tested).
6. Full offline suite passes (≥206) with zero live-CLI usage; one live-
   acceptance pass validates the initial pins.
7. Bump workflow documented and reachable from the README.

## 8. Decisions recorded (so they aren't relitigated)

1. **No new repo.** The code is already the generic tool; the identity debt
   is in docs. History (marker provenance, review context, 206 tests) is
   worth more than a clean slate. The future auto-triage service is the
   thing that gets a new repo.
2. **Historical docs stay as-is.** Dated specs/plans/handoffs under
   `docs/superpowers/` keep their XDR mentions; rewriting dated records
   falsifies history. The Phase 3 handoff written at the end of this phase
   supersedes the old framing.
3. **One universal repo, not per-CLI repos.** Per-CLI code is ~20% of `src/`
   (adapters of 64–98 lines + one headless runner); a split duplicates the
   other 80% or forces cross-repo core versioning. One instance already
   serves all profiles through one endpoint (`model` = profile), which is a
   real feature. Maintainability pressure is answered with support tiers
   (README), not repo fission.
4. **XDR doc deleted, not relocated.** Recoverable via git history; will be
   resurrected in the auto-triage service repo if/when that exists.
5. **uv/virtualenv rejected** — Python tooling; this is a Node bridge with
   npm-distributed (or binary) CLIs. The Node-native equivalent is the
   vendored pin (`npm install --prefix vendor pkg@version`).
6. **Vendored pinning is the fix; Docker is packaging.** The breakage vector
   is CLI-binary version vs adapter markers, which Part B closes on a bare
   host. Docker adds host isolation and reproducible deployment later, at
   the cost of auth-state friction (§6).
7. **Name: `pty-web-bridge`** — matches the local checkout, agnostic,
   describes the mechanism. (Runner-up `cli-api-bridge` describes the facade
   but hides the terminal half.)

## 9. Sequencing

Part A (docs, rename) and Part B (pinning) are independent; either can land
first, but A is pure-docs and fast — do A, then B, then C if appetite
remains. Each part is a separately reviewable unit on one
`feat/agnostic-identity-and-pinning` branch (or two branches if preferred at
plan time).
