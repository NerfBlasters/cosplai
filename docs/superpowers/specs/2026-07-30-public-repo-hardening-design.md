# Public-repo hardening — protections, scanning, and supply chain (design)

**Date:** 2026-07-30 · **Status:** draft, pending user review
**Depends on:** PR #1 (`security/drop-docker-and-scan-findings`) open, 252/252 tests green

## 1. Problem

`cosplai` is a public repo on a personal account with **no repository-level
protections whatsoever**: no branch protection or rulesets, no CI, no git
hooks, no `.github/` directory, no license, no security policy. Every control
below is being added from zero.

Two things are already in place and worth not duplicating:

- **GitHub secret scanning and push protection are enabled** (free on public
  repos). Push protection is the only layer here that cannot be bypassed by a
  contributor, since it rejects server-side at push time.
- Nothing else. Dependabot security updates are **off**; private vulnerability
  reporting is **unset**.

The gap push protection does *not* close is the one that matters most for this
project. GitHub matches **partner patterns** — vendor-issued credentials with
recognizable shapes. The bridge's own `BRIDGE_TOKEN` is
`crypto.randomBytes(24).toString('base64url')`: generic high-entropy with no
distinguishing prefix. GitHub will not flag it. That token grants full
interactive control of every enabled CLI, which the README already calls out as
equivalent to shell access. A leaked one is the highest-impact secret this repo
can produce, and it is precisely the class server-side scanning misses.

## 2. Goals

- **Secrets caught before they leave the machine**, with a layer that
  understands generic entropy rather than only vendor patterns.
- **`master` is only reachable through a green PR** — no direct pushes, no
  force-pushes, no deletion.
- **Static analysis and supply-chain review run automatically**, not on
  someone remembering to run them.
- **Third-party CI actions cannot silently change what they execute.**
- Controls that are **honest about their own limits** — no control that
  no-ops silently and thereby manufactures false confidence.

## 3. Non-goals

- **Enforcing signed commits.** Signing will be configured so commits verify,
  but the `required_signatures` rule stays off (§4.8).
- **Required approving reviews.** Solo maintainer; GitHub forbids self-
  approval, so a non-zero count would hard-block every merge.
- Runtime/deployment hardening. The bridge's own security model (token gate,
  loopback bind, `envScrub`) is settled and out of scope here.
- Replacing the Checkmarx scan. This is repo-level hygiene, not SAST parity.

## 4. Design

### 4.1 Secret scanning — three layers

| Layer | Mechanism | Catches | Bypassable |
|---|---|---|---|
| Local | `.githooks/pre-commit` → `gitleaks protect --staged` | generic entropy + vendor patterns, **before commit** | yes (`--no-verify`, or never bootstrapping) |
| CI | `gitleaks detect` over full history | anything that reached a PR | no (required check) |
| Server | GitHub push protection *(already on)* | partner patterns only | no |

The hook is committed at `.githooks/pre-commit` and activated with
`git config core.hooksPath .githooks`, exposed as `npm run hooks:install`.
No new dependency: the repo has 3 runtime and 2 dev deps, no linter and no
build step, and neither the `pre-commit` Python framework nor husky earns its
place in that.

**The hook fails closed.** If the `gitleaks` binary is absent it exits
non-zero with install instructions rather than passing. A hook that silently
no-ops when its tool is missing is worse than no hook, because the contributor
believes they are covered. `--no-verify` remains the documented deliberate
escape hatch; the CI layer is what makes that survivable.

A `.gitleaks.toml` allowlists the two known false-positive sources:
`test/fixtures/*.txt` (captured terminal output) and the README's
illustrative `BRIDGE_TOKEN=some-long-random-string`. The allowlist is
path/pattern-scoped, never a blanket entropy-threshold reduction.

### 4.2 CI (`.github/workflows/ci.yml`)

Node 20 (matching `engines: >=20`), `npm ci`, `npm test`, on `pull_request`
and `push` to `master`. `permissions: contents: read` at workflow level.
`node-pty` compiles a native addon; `ubuntu-latest` ships python3/make/g++, so
no extra install step. The suite needs no authenticated CLIs — the live canary
(`scripts/live-acceptance.mjs`) is deliberately *not* wired in, as it spends
real subscription quota.

This job is the required status check in §4.7.

### 4.3 CodeQL (`.github/workflows/codeql.yml`)

JavaScript, **`security-extended`** query suite rather than the default — the
comprehensive tier was chosen explicitly. Runs on PR, push to `master`, and
weekly. Weekly matters: it re-runs against updated queries, so newly published
rules find old code.

### 4.4 OpenSSF Scorecard (`.github/workflows/scorecard.yml`)

Weekly plus push to `master`, SARIF uploaded to code scanning,
`publish_results: true`. Some Scorecard checks (notably branch-protection
introspection) need a PAT to read settings and will report as inconclusive
with the default `GITHUB_TOKEN`. Accepted — the remaining checks still cover
pinning, dangerous workflow patterns, and maintenance signals.

### 4.5 Supply chain

Every **third-party** action is pinned to a full 40-character commit SHA with
the human-readable version in a trailing comment. A tag is a mutable pointer;
a SHA is not.

Pinning alone rots, so `.github/dependabot.yml` registers **two** ecosystems:
`npm` and `github-actions`, both weekly. Dependabot rewrites SHA pins and
updates the version comment. Dependabot security updates and vulnerability
alerts are enabled via API.

### 4.6 Repository metadata

- **`SECURITY.md`** — supported versions, reporting route, expectations.
- **Private vulnerability reporting enabled via API**, so reports land in
  GitHub's workflow instead of an email address published in a file.
- **`LICENSE` — MIT.** Adds a `license` field to `package.json` to match.
  The README's "operator-scope only, do not re-expose as a product" warning is
  about the **CLI vendors' subscription terms**, which no license of this
  repo's code can grant or revoke. A short note makes that distinction
  explicit so the two do not read as contradictory.
- **`CODEOWNERS`** — `* @NerfBlasters`. **Documentation only.** "Require review
  from code owners" needs `required_approving_review_count >= 1`, which §3
  rules out. Recorded here so nobody later mistakes it for an active control.
- **`deleteBranchOnMerge: true`.**

### 4.7 Branch protection — ruleset on `master`

A **repository ruleset**, not classic branch protection: rulesets model bypass
actors explicitly, evaluate composably, and are the API GitHub is building
forward on.

| Rule | Setting |
|---|---|
| `pull_request` | required, `required_approving_review_count: 0` |
| `required_status_checks` | the §4.2 CI job, `strict_required_status_checks_policy: true` |
| `non_fast_forward` | blocks force-push |
| `deletion` | blocks branch deletion |
| Bypass actors | `RepositoryRole` admin, `always` |

Admin bypass is retained deliberately: it preserves an emergency direct push
without dismantling and rebuilding the ruleset under pressure. The trade is
real and stated plainly — the ruleset is a guardrail against mistakes, not a
control that constrains the repo owner.

### 4.8 Commit signing — configured, not enforced

Git is configured for SSH signing against the existing `~/.ssh/id_ed25519`
(`gpg.format=ssh`, `user.signingkey`, `commit.gpgsign=true`). Commits then
show **Verified** once the public key is added to GitHub as a *Signing* key —
a separate entry from the same key's Authentication use, and a **manual step
only the account owner can perform**.

`required_signatures` stays **off** until that upload is confirmed working.
Enabling it first would reject every subsequent push, including the one that
fixes it.

## 5. Commit authorship correction

`4dc607b` is authored `Test User <test@example.com>` — a local git default
that leaked in; the two prior commits use
`NerfBlasters <151085967+NerfBlasters@users.noreply.github.com>`. Author
identity is permanent and public once merged.

The commit is amended to the correct identity and the branch force-pushed
(PR #1 updates in place). Safe: unmerged feature branch, sole author, no
downstream forks. Repo-local `user.name`/`user.email` are set so it cannot
recur, and — signing being configured by then — the rewritten commit is signed.

## 6. Rollout order

Ordering is load-bearing. Enabling the ruleset before the CI workflow exists
on `master` makes **PR #1 permanently unmergeable**: it would require a status
check that never runs on its base.

1. Fix git identity + configure SSH signing (local only).
2. Amend `4dc607b`, force-push `security/drop-docker-and-scan-findings`.
3. Land all hardening files as PR #2 off `master` — **no ruleset yet**, so it
   can merge normally.
4. Enable ruleset, Dependabot, private vulnerability reporting,
   delete-branch-on-merge via API.
5. Rebase PR #1 onto the new `master` so CI runs and the check reports.

## 7. Verification

Claims about controls are only worth what was actually observed:

- Install gitleaks (`apt`, 8.26.0). Stage a **synthetic** secret shaped like a
  real `BRIDGE_TOKEN` and confirm the hook **blocks** the commit; confirm a
  clean commit passes; confirm the missing-binary path exits non-zero.
- Run `gitleaks detect` over full history and confirm it is clean against
  `.gitleaks.toml` — if it is not, the allowlist is wrong or there is a real
  finding.
- Confirm every workflow's YAML parses and every `uses:` is a 40-char SHA.
- After the ruleset is applied, confirm via API that a direct push to `master`
  is refused.
- Report anything that could not be verified as unverified, explicitly.

## 8. Accepted limitations

- The pre-commit hook is bypassable and requires a manual bootstrap. CI is the
  backstop; this is stated in the README rather than papered over.
- CODEOWNERS enforces nothing at 0 required approvals (§4.6).
- Admin bypass means the ruleset does not constrain the owner (§4.7).
- Scorecard's branch-protection check will be inconclusive without a PAT
  (§4.4).
- Signing is not enforced, and depends on a manual key upload (§4.8).

---

## 9. As-built addendum (2026-07-30)

Shipped in PRs #2 and #7. Five deviations from the design above, one claim
that could not be verified as written, and one incident.

### 9.1 Deviations

1. **gitleaks-action replaced by the upstream binary** (§4.5). The action is
   proprietary — "Gitleaks LLC, All Rights Reserved", commercial EULA — while
   the gitleaks CLI is MIT. CI now downloads the MIT release pinned by
   **sha256** and verifies it before use. Fewer third-party dependencies, no
   EULA, and a stronger pin than a tag or even a SHA-pinned action.

2. **The allowlist is not rule-scoped** (§4.1). `targetRules` is unsupported
   on gitleaks 8.26, the version Debian/Kali ships — and when present it causes
   the *entire allowlist to be silently ignored* rather than erroring. Scoping
   as designed would have produced a config that passed CI (8.30) and failed on
   every contributor's machine. Path-scoping alone behaves identically on both.

3. **The allowlist is narrower than specced** (§4.1). The design predicted
   false positives from `test/fixtures/*.txt` and the README's
   `BRIDGE_TOKEN=some-long-random-string`. A baseline scan flagged **neither**
   — the only finding was `t.FourKeyMap=` in the minified vendored xterm.js.
   Allowlisting is therefore limited to `public/vendor/`. Evidence over
   prediction.

4. **Rollout order changed** (§6). PR #1 was merged before the hardening PR, at
   the maintainer's direction. Both merge orders were dry-run in-memory
   (`git merge-tree`) and confirmed conflict-free despite both branches editing
   `README.md`. This order is strictly better: the hardening CI then ran
   against a `master` that already contained PR #1, so the first CI run
   validated the real merged state. The constraint that actually mattered —
   the ruleset goes last — was preserved.

5. **Three required checks, not one** (§4.7). `test`, `secret-scan`, and
   `analyze` are all required, rather than only the CI test job.

### 9.2 Verified

- Hook **blocks** a staged synthetic `BRIDGE_TOKEN` (HEAD unchanged after).
- Hook **fails closed** when gitleaks is absent: `exit=1` with install
  instructions, not a silent pass. Tested with a sandboxed `PATH` containing
  bash and git but not gitleaks — an earlier attempt using `PATH=/nonexistent`
  proved nothing, since it broke the `env bash` shebang itself.
- Full history scans clean under `.gitleaks.toml`.
- All workflow YAML parses; zero unpinned `uses:` (all 40-char SHAs).
- 252/252 tests pass against the merged state, locally and in CI.
- All four checks green on GitHub; ruleset confirmed active via
  `GET /repos/{owner}/{repo}/rules/branches/master`.
- SSH signing works end to end: commits verify locally (`%G?` = `G`) and
  GitHub reports `verified: true` once the key was added with
  `gh ssh-key add --type signing`.

### 9.3 Not verified — and why

§7 called for confirming that **a direct push to `master` is refused**. This
cannot be demonstrated by the repository owner: admin bypass is `always` by
design (§4.7), so a push by the owner is *expected* to succeed and proves
nothing either way. The rules are confirmed present and active via the API;
their effect on a non-bypassing actor is untested, because this repo currently
has no such actor. Stated rather than quietly dropped.

### 9.4 Incident: scan artifacts committed to a public repo

18 files under `cosplai_VULNHUNT_RESULTS_*/` — output from a separate scan run
writing into the working tree — were swept into `321bedf` and `1711652` by a
`git add -A` and reached `master`.

Reviewed before removal: no tokens, keys, or credentials (checked for
`BRIDGE_TOKEN=`, `gho_`/`ghp_`, PEM headers, `~/.ssh` paths). 476K of
vulnerability analysis of already-public code, plus the local path
`/home/kali/repos/cosplai`. Clutter and a prematurely-public unverified
analysis; not a credential exposure.

Fixed in PR #7: `*_VULNHUNT_RESULTS_*/` added to `.gitignore`, files untracked
with `git rm --cached` so the still-running scan was undisturbed. **Left in
history**, on the grounds that force-pushing a public `master` is
disproportionate when no secret is involved. Admin bypass means that decision
is still reversible.

Root cause: `git add -A` in a working tree containing foreign files. Staging
explicitly would have prevented it.
