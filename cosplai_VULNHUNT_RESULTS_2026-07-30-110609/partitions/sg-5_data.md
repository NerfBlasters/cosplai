# SG-5 — Boot-time config, pinning & version handshake (partition data)

**Target repo root (absolute):** `/home/kali/repos/cosplai`
**Scan dir:** `/home/kali/repos/cosplai/cosplai_VULNHUNT_RESULTS_2026-07-30-110609`
**Full recon output (reference only):** `<scan dir>/phase1_output.md`

> **Review-only partition.** The baseline attacker capability here is *total*
> (anyone who can set the process environment or write `cli-pins.json` already has
> local code execution as the service user). Per Gate 3, nothing that merely
> re-derives that capability is a finding. SG-5's value is **defensive-control
> review**: does the pin/version handshake actually constrain what gets spawned,
> and can a *non-privileged* actor influence any of it?

## Entry points
process boot; `npm run pin`

## Assigned inputs (#40, #41, #46)

| # | Source Type | Location | Variable | Entry Point | Trust Level |
|---|---|---|---|---|---|
| 40 | Env vars (~40) | `src/config.js:90-235` | `BRIDGE_TOKEN`, `HOST`, `PORT`, `CWD`, `CLAUDE_CMD`, `CLAUDE_ARGS`, `ADAPTER`, `BRIDGE_PROFILES`, `DEFAULT_PROFILE`, `PROFILE_<N>_{COMMAND,ARGS,CWD,ENV_SCRUB,DIALOG_POLICY,QUIESCENCE_MS,COLS,ROWS}`, `BRIDGE_TRUST_PROXY`, `BRIDGE_USE_HOST_CLIS`, `BRIDGE_STRICT_VERSIONS`, `FACADE_*` | process boot | privileged (operator) |
| 41 | File content | `src/pins.js:36-43` (`cli-pins.json`) | `pins[cmd].{source,version,package,sha256}`; **keys become exec'd bin names** | process boot | privileged (operator) |
| 46 | CLI argv | `scripts/pin-clis.mjs:14-18` | `--npm-only`, `positional[0]` (pins path) | `npm run pin` | local/operator |

Merged per the undersized-partition rule (`npm run pin` alone was 1 input / 1 file).

## Gate-logic entries in scope

| # | Type | Location | Variable | Trust |
|---|---|---|---|---|
| G6 | classification gate | `src/config.js:147` | `command` | privileged |

Recon notes carried forward:
- **G6** — `!command.includes('/')` gates vendor-first path resolution. It checks
  `/` **only**: a Windows `\` separator or a `..`-containing bare name would pass.
  `command` here can be operator-set. **CANDIDATE (latent)**, low severity.
- `config.js:17` — `['0','false','no','off'].includes(...)` boolean parsing means
  **any unrecognized value is truthy** (e.g. `BRIDGE_TRUST_PROXY=maybe` → `true`).
  **Minor CANDIDATE.**
- `pins.js:25,27,28` — bin-name regex is **anchored** `^[A-Za-z0-9][A-Za-z0-9._-]*$`
  and `['npm','external'].includes(source)`. Assessed **safe** in recon; re-verify.
- `config.js:20,154` `DIALOG_POLICIES.includes(dialogPolicy)` — safe.
- `config.js:99` `env.ADAPTER !== 'generic' && !== 'claude'` — safe.

## App-specific file scope (trace these)
`src/config.js`, `src/pins.js`, `src/versionCheck.js`, `src/server.js`,
`scripts/pin-clis.mjs`

## Sinks reached
S4 (`execVersion` — boot-time process execution via `versionCheck.js`),
S5 (`scripts/pin-clis.mjs` process execution), S14, S15.
Call chain: `loadConfig` → `loadPins` → `validatePins` → `checkVersions` →
`execVersion` → `applyStrict` → `createHttpServer` → `attachWss` → `createFacade`.

## Shared infrastructure
None — this partition *is* the config/bootstrap layer.

## Threat model

| Entry-point group | App-layer auth enforcement | Caller identity binding | Per-resource authorization |
|---|---|---|---|
| process boot / `npm run pin` | `NONE` (execution boundary = local shell) | `NONE` | `NONE` |

Prose in comments/README about "loopback only", "single-operator trust model", or
"operator-trusted config" is **not admissible** and is recorded as `NONE`.

**Attacker profile:** any party who can set the process environment or write
`cli-pins.json` — i.e. **local code execution as the service user**.

**Attacker controls (at this boundary):** #40, #41, #46, G6.

**Attacker does NOT control:** nothing meaningful at this boundary — the baseline
is total. Note for cross-partition reasoning: `config.token` is either
`BRIDGE_TOKEN` or a per-boot random (`config.js:91`) **printed to stdout with the
URL** (`server.js:29`).

**Gate 3 baseline:** **total**. Nothing in SG-5 is a finding against an attacker
who already has it. Report a CANDIDATE only when:
1. a **lower-privileged** actor (an unauthenticated caller, or a bridge-token
   holder from SG-1/2/3) can influence one of these values or their effect; or
2. a defensive control here **fails to constrain** what a lower-privileged actor
   can later reach (e.g. the version handshake not actually gating the spawned
   binary, or `strict` mode failing open); or
3. the control's failure mode is **fail-open** rather than fail-closed.

Everything else is a Code Smell at most.

## Cross-cutting notes — build-time / binary provenance (from Step 4)
- `pin-clis.mjs:62-64` acknowledges the **stale-bin shadowing hazard** as a
  *warning only*.
- **Phase 2 must treat `vendor/` as the effective production binary source** when
  reasoning about what `pty.spawn` / `child_process.spawn` actually executes.
- Trust boundary — application → filesystem at boot: `src/pins.js:39` and
  `src/config.js:147-150` `existsSync` probes, guarded by the anchored bin-name
  regex (`pins.js:25`).
- `flag()` (`config.js:17`) treats any unrecognized string as `true` — check every
  security-relevant flag (`BRIDGE_TRUST_PROXY`, `BRIDGE_USE_HOST_CLIS`,
  `BRIDGE_STRICT_VERSIONS`, `FACADE_*`) for fail-open behavior.
