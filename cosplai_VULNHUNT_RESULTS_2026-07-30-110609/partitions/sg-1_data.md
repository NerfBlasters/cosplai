# SG-1 — Cloud-API façade (partition data)

**Target repo root (absolute):** `/home/kali/repos/cosplai`
**Scan dir:** `/home/kali/repos/cosplai/cosplai_VULNHUNT_RESULTS_2026-07-30-110609`
**Full recon output (reference only):** `<scan dir>/phase1_output.md`

## Entry points
`POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`, `GET /v1/models`

## Assigned inputs (#5-25, #42-44)

| # | Source Type | Location | Variable | Entry Point | Trust Level |
|---|---|---|---|---|---|
| 5 | HTTP body field | `src/facade/dialects/openaiChat.js:21,37` | `model` | `POST /v1/chat/completions` | authenticated (bridge token) |
| 6 | HTTP body field | `openaiChat.js:24,30-33` | `messages[].role` | `POST /v1/chat/completions` | authenticated |
| 7 | HTTP body field | `openaiChat.js:32` → `shared.js:111` | `messages[].content` (**the prompt**) | `POST /v1/chat/completions` | authenticated |
| 8 | HTTP body field | `openaiChat.js:27` | `n` | `POST /v1/chat/completions` | authenticated |
| 9 | HTTP body field | `openaiChat.js:40` | `stream` | `POST /v1/chat/completions` | authenticated |
| 10 | HTTP body field | `openaiChat.js:41` | `stream_options.include_usage` | `POST /v1/chat/completions` | authenticated |
| 11 | HTTP header | `openaiChat.js:16` | `x-bridge-conversation` (pin id) | all 3 façade POST routes | authenticated |
| 12 | HTTP body field (derived) | `openaiChat.js:13-15` | `model` `#<pin>` suffix | all 3 façade POST routes | authenticated |
| 13 | HTTP body field | `openaiResponses.js:14` | `model` | `POST /v1/responses` | authenticated |
| 14 | HTTP body field | `openaiResponses.js:19-21` | `instructions` (system prompt) | `POST /v1/responses` | authenticated |
| 15 | HTTP body field | `openaiResponses.js:22-32` | `input` (string or items; **the prompt**) | `POST /v1/responses` | authenticated |
| 16 | HTTP body field | `openaiResponses.js:26-28` | `input[].role` / `.type` / `.content` | `POST /v1/responses` | authenticated |
| 17 | HTTP body field | `openaiResponses.js:37` | `previous_response_id` | `POST /v1/responses` | authenticated |
| 18 | HTTP body field | `openaiResponses.js:40` | `stream` | `POST /v1/responses` | authenticated |
| 19 | HTTP body field | `anthropicMessages.js:16` | `model` | `POST /v1/messages` | authenticated |
| 20 | HTTP body field | `anthropicMessages.js:23-26` | `system` | `POST /v1/messages` | authenticated |
| 21 | HTTP body field | `anthropicMessages.js:27-32` | `messages[].role` / `.content` (**the prompt**) | `POST /v1/messages` | authenticated |
| 22 | HTTP body field | `anthropicMessages.js:37` | `stream` | `POST /v1/messages` | authenticated |
| 23 | HTTP header | `src/facade/index.js:42` | `x-api-key` | `POST /v1/messages` | **unauth** (it *is* the credential) |
| 24 | HTTP body (arbitrary keys) | `src/facade/shared.js:125-133` | unknown params → `console.warn` | all 3 façade POST routes | authenticated |
| 25 | no-input endpoint | `src/facade/models.js:9` | N/A | `GET /v1/models` | authenticated |
| 42 | Child-process stdout | `headlessClaudeRunner.js:51-68` | `j.session_id`, `j.result`, `j.usage` (JSONL) | headless claude turn | internal (LLM-influenced) |
| 43 | Child-process stdout | `headlessCopilotRunner.js:140-186` | `j.data.content`, `j.data.phase`, `j.sessionId`, `outputTokens` | headless copilot turn | internal (LLM-influenced) |
| 44 | Child-process stderr | `headlessClaudeRunner.js:49,74`; `headlessCopilotRunner.js:138,191` | `stderr.slice(-2000)` → echoed to API client | façade error path | internal |

## Gate-logic entries in scope
- **G4** authorization gate (tool lockdown) — `src/facade/headlessCopilotRunner.js:70-89`, `profile.args`. Recon note: `EXPOSURE_*_FLAGS.has(name)` is a Set with **exact, case-sensitive** matching; the file's own comment (lines 40-47) admits alternate spellings may slip past, and `--mcp-config` is **not** in the scrub set. CANDIDATE (operator-config-gated).
- **G5** classification gate — `src/facade/router.js:32-36,89-126`, `fpKey`/`pinId`/`respId`. Recon note: conversation identity is derived in **four** different places with **four** different rules: `_fp()` sha256 over `[profileName, messages]` (`router.js:32-36`); explicit `pinId` raw attacker string as map key (`router.js:113-118`); `previous_response_id` → `_byResp` (`router.js:226-229`, `:141-148`); `parsePin()` precedence header > suffix (`openaiChat.js:12-18`) vs a **different** precedence in `openaiResponses.js:39-40` (header > `previous_response_id` > suffix, nulling `previousResponseId` when a header pin is present). `_fp` prefixes the digest with `${profileName}\n` though the digest already covers `profileName`, and **two key spaces (full messages vs history-only) share the same map** (`router.js:98-104`). CANDIDATE — collision/confusion in conversation routing identity.
- `openaiChat.js:13` `model.indexOf('#')` splits `model` into profile + pin; `profileName` is looked up in `config.profiles` (`router.js:221`) — classification of an attacker string into a spawn profile. CANDIDATE.
- `facade/index.js:38` `routes.has('${method} ${pathname}')` — exact raw-pathname match; `/v1/messages` matched here **bypasses the bridge token gate at `httpApi.js:186`** by design (`httpApi.js:184`). Route ordering **is** the security control.

## App-specific file scope (trace these)
`src/facade/index.js`, `src/facade/router.js`, `src/facade/turnRunner.js`,
`src/facade/headlessClaudeRunner.js`, `src/facade/headlessCopilotRunner.js`,
`src/facade/streamRenderer.js`, `src/facade/models.js`,
`src/facade/dialects/openaiChat.js`, `src/facade/dialects/openaiResponses.js`,
`src/facade/dialects/anthropicMessages.js`, `src/sessionManager.js`,
`src/session.js`, `src/promptWriter.js`, `src/config.js`

Marker: **DEPTH-SPLIT** from SG-2 (both families reach `SessionManager.create` →
`pty.spawn`, but with structurally different input shapes; SG-1 supplies prompt
text with fixed profile/cols).

## Shared infrastructure (reference context — read, but findings belong to the module that calls them)

| Module | Role | Files |
|---|---|---|
| token auth | authentication (extract + timing-safe compare); used by 100% of gated entry points | `src/auth.js` |
| security headers / TLS detection | response hardening, `x-forwarded-proto` trust | `src/httpApi.js:108-139` |
| body readers | deserialization + size caps (1 MiB bridge / 8 MiB façade) | `src/httpApi.js:48-83`, `src/facade/shared.js:60-78` |
| error shaping / SSE plumbing | `FacadeError`, `errorBody`, `sendError`, `jsonRes`, `sseInit/sseFrame/sseEventFrame`, `writeIfOpen`, `AsyncQueue`, `estTokens` | `src/facade/shared.js` |
| config reader | env/profile resolution, vendor-first command resolution | `src/config.js` |
| pins/version handshake | boot-time integrity check | `src/pins.js`, `src/versionCheck.js` |
| serialization queue | per-session turn serialization | `src/promptQueue.js` |
| terminal state | screen model + busy/idle detection | `src/terminalModel.js`, `src/stateDetector.js` |
| adapter registry | per-CLI marker/keyseq strategy | `src/adapters/*` |

**Exception:** `src/config.js`, `src/sessionManager.js`, `src/session.js` are
**NOT** shared infrastructure — they build and execute the spawn (S1-S3) and are
in trace scope. `src/facade/shared.js` and `src/auth.js` are reference context.

## Threat model

| Entry-point group | App-layer auth enforcement | Caller identity binding | Per-resource authorization |
|---|---|---|---|
| `POST /v1/chat/completions`, `POST /v1/responses` | `src/facade/index.js:45` | `NONE` | `NONE` |
| `POST /v1/messages` | `src/facade/index.js:45` (also accepts `x-api-key`, `:42-44`) | `NONE` | `NONE` — conversation pins (`router.js:110-118`) check only *profile* agreement, never ownership |
| `GET /v1/models` | `src/facade/index.js:45` | `NONE` | `NONE` |

Prose in comments/README about "loopback only", "single-operator trust model", or
"operator-trusted config" is **not admissible** and is recorded as `NONE`.

**Why caller identity binding is `NONE`:** `checkToken` (`src/auth.js:3-9`) is a
constant-time comparison against a single shared secret. It authenticates
possession of a secret, not a caller. No principal, claim, or subject is produced.

**Attacker profile:** any holder of the single bridge token, plus anyone who can
replay it. The token is accepted in the **query string** (`auth.js:14-16`) so it
leaks to logs, `Referer`, and history; it is **printed to stdout at boot**
(`server.js:29`). No `Origin` check exists on any POST, so a **web page in the
victim's browser** is in this class once it learns or guesses the token.

**Attacker controls:** #5-25, #42-44, G4, G5. Most consequentially **#7 / #15 /
#21 — the prompt text**, written verbatim (after a fixed seed preamble,
`router.js:38-47`) into a **live, agentic AI coding CLI** running in the
operator's shell with the operator's credentials (`turnRunner.js:84-91` →
`promptWriter.js:9-18` → `session.write` → `pty.spawn`), or passed as
`-p <fullPrompt>` argv (`headlessCopilotRunner.js:95-96`), or on stdin
(`headlessClaudeRunner.js:85`). Also **#11/#12/#17 — conversation pin
identifiers**, arbitrary strings used as map keys and as the identity for reusing
a live authenticated CLI session. **#5/#13/#19 — `model`** selects which binary is
spawned from the built-in table, including `generic` (operator-set command, may be
`bash`, `config.js:123-133`).

**Attacker does NOT control:** `config.token` (unless leaked), the
`BUILTIN_PROFILES` table (`config.js:36-86`), `FIXED_ARGS` in both headless
runners (`headlessClaudeRunner.js:12`, `headlessCopilotRunner.js:54-61`), the
`envScrub` lists, `SHELL_CSP`, response security headers, `cli-pins.json`
contents, `PROFILE_*` env values, bind host/port, the ambient credentials of the
AI CLIs. Response ids are `resp_<uuid>` (`router.js:142`) — unguessable.

**Gate 3 baseline (existing capability):** a bridge-token holder can, per the
documented contract, create/list/delete PTY sessions, type text into them and read
rendered output, send named key sequences, stream output over SSE/WS, and drive
conversations through the three cloud-API dialects. **NOT in the baseline** (still
findable): controlling the child's **working directory**, escaping the vendor
directory, **hijacking or colliding with another conversation's live session**,
**reopening the copilot tool lockdown**, splitting the raw upgrade response, or
reaching any of this from a **cross-origin web page** without operator intent.

## Cross-cutting notes
- The single-shared-token model means "authenticated" ≈ one principal; any finding
  that lets one *conversation/session* affect another is meaningful despite that.
- **Phase 2 must treat `vendor/` as the effective production binary source** when
  reasoning about what `pty.spawn`/`spawn` actually executes.
- Child process → application is an **untrusted return path**: JSONL/raw PTY bytes
  emitted by an LLM-driven process, parsed with `JSON.parse` + `catch{continue}`;
  **stderr tails are echoed to the API client** (`headlessClaudeRunner.js:74`,
  `headlessCopilotRunner.js:191`).
