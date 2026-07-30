# SG-1 — INJ trace results (Cloud-API façade)

**Agent**: INJ trace, partition SG-1
**Classes in scope**: SQL, command, path traversal, SSRF/URL, XSS (all), open redirect,
XXE, LDAP, API query lang, code eval/SSTI, file upload
**Repo root**: `/home/kali/repos/cosplai`

## 0. Sink sweep (what INJ sinks actually exist in the SG-1 file scope)

Grepped the whole `src/` tree for INJ sink families. Result:

| Sink family | Present in scope? | Evidence |
|---|---|---|
| SQL / ORM / query builder | **none** | no DB dependency in `package.json`, no query API anywhere in `src/` |
| LDAP / XPath / Elasticsearch / GraphQL / JQL | **none** | no such client in `src/` or `node_modules` |
| XML parsing (XXE) | **none** | no XML parser; every body is `JSON.parse` (`shared.js:74`) |
| `eval` / `new Function` / `vm.*` / template compile | **none** | grep returns 0 hits in `src/` |
| Outbound HTTP / URL construction (SSRF) | **none** | the bridge makes **no** outbound HTTP calls; `http` is used only as a *server* (`httpApi.js:1`) |
| HTML / template rendering (XSS) | **none reachable from SG-1 inputs** | every façade response is `application/json` (`shared.js:49`) or `text/event-stream` (`shared.js:140`), serialized with `JSON.stringify` (`shared.js:48,142,143`). The only HTML is the static `public/index.html` shell (`httpApi.js:186`) — no SG-1 input is interpolated into it. |
| Redirect / `Location` header | **none** | grep for `writeHead(30`, `Location`, `location.href` returns 0 hits |
| File upload / multipart | **none** | no multipart parser |
| File system path from user input | **none in SG-1** | `fs` sinks are `pins.js:39` (fixed path) and `httpApi.js:100` (`/vendor/` static, guarded at `httpApi.js:114` — *not* an SG-1 entry point) |
| **Process execution** | **YES — the only INJ sink family in scope** | `src/session.js:16` `pty.spawn(command, args, {cwd, env})`; `headlessClaudeRunner.js:25` `spawn(...)`; `headlessCopilotRunner.js:113` `spawn(...)` |

So the entire INJ surface for SG-1 reduces to **process execution** (command/argv
injection) plus **terminal control-sequence injection** into the PTY.

Key structural facts established by reading the sinks:

- All three spawns are **argv-array** form. `node:child_process.spawn` and
  `node-pty.spawn` are invoked **without** `shell:true` and without a `sh -c`
  wrapper, so no shell metacharacter (`;`, `|`, `` ` ``, `$()`, newline) in any
  attacker string is ever interpreted. Classic OS command injection is
  structurally impossible on all three paths.
- `command`, `cwd`, `envScrub`, `envSet` and `profile.args` come **exclusively**
  from `loadConfig` (`config.js:90-229`), i.e. the `BUILTIN_PROFILES` table plus
  `PROFILE_*` / `CLAUDE_CMD` / `ADAPTER` env vars. No SG-1 input writes any of
  them. (Gate 2a fails for every operator-config-derived spawn field.)
- The attacker's only influence on the spawn is **which profile name is looked
  up** (`model`, #5/#13/#19) and **the prompt bytes** (#7/#15/#21, plus #6/#14/#16/#20
  which are folded into the same prompt string).

---

## 1. Per-input dispositions

### #5 `model` — `POST /v1/chat/completions` (`openaiChat.js:21,37`)
**SAFE.**
`model` is type-guarded to a non-empty string (`openaiChat.js:21`), split at the
first `#` (`openaiChat.js:13-15`), and the left part becomes `profileName`. Its
only uses:
1. `config.profiles[profileName]` (`router.js:221`, `router.js:58`) — a **lookup key**, not a
   command. `executeTurn` rejects anything that does not resolve to an object
   carrying `.command` with a 404 (`router.js:222-224`). I checked the
   prototype-chain keys an attacker would reach for: `config.profiles` is a plain
   object literal (`config.js:107`) frozen at `config.js:217`, so
   `profiles['__proto__']` → `Object.prototype`, `profiles['constructor']` →
   `Object`, `profiles['toString']` → a function — **none has a `.command`
   property**, so all fall through to the 404 at `router.js:223`. The reachable
   value set is exactly the enabled `BUILTIN_PROFILES` keys (`config.js:36-86`).
   `profile.command` is therefore never attacker-derived at `session.js:16` /
   `headlessClaudeRunner.js:25` / `headlessCopilotRunner.js:113`.
2. `_fp()` hash input (`router.js:34`) — sha256, no sink.
3. Echoed back as `model: body.model` inside `JSON.stringify` responses
   (`openaiChat.js:74,86,97`) with `content-type: application/json`
   (`shared.js:49`). Not an HTML context → **not XSS**. JSON string escaping
   handles `<`, `"`, and control bytes.
4. Reflected into the 404 message `` `The model \`${profileName}\` does not exist` ``
   (`router.js:223`) → `errorBody` → `JSON.stringify` (`shared.js:44,48`). Same
   reasoning: JSON body, not HTML.

### #6 `messages[].role` (`openaiChat.js:24,30-33`)
**DESIGN-INTENT.** Type-guarded to a string (`openaiChat.js:31`), `developer`
canonicalized to `system`, then interpolated into the seed preamble as
`` `[${m.role}] ${m.text}` `` (`router.js:44`) and written into the CLI as prompt
text. It reaches no sink other than the prompt itself; the prompt content is the
application's product (see #7).

### #7 `messages[].content` — **the prompt** (`openaiChat.js:32` → `shared.js:111`)
### #14 `instructions` (`openaiResponses.js:19-21`)
### #15/#16 `input` / `input[].role|.type|.content` (`openaiResponses.js:22-32`)
### #20 `system` (`anthropicMessages.js:23-26`)
### #21 `messages[].role|.content` (`anthropicMessages.js:27-32`)

All six normalize through `flattenContent` (`shared.js:111-121`, which only
*concatenates* text parts — no escaping, by design) into the same
`messages[{role,text}]` array, then into one of three prompt sinks. Traced each:

**(a) PTY path** — `router.js:185` → `turnRunner.js:84` builds
`full = seedText + '\n\n' + userText` → `turnRunner.js:88`
`writeAndSubmitPrompt` → `promptWriter.js:9-18` → `session.write` →
`session.js:25` `this._pty.write(data)`.
→ **DESIGN-INTENT (INJ), with a CWE-150 sub-finding eliminated at Gate 3** — see §2.1.

**(b) headless claude** — `headlessClaudeRunner.js:85`
`child.stdin.write(...)`. Prompt goes on **stdin**, never argv, never a shell.
→ **DESIGN-INTENT.** No injection sink: stdin bytes cannot alter `args`
(`headlessClaudeRunner.js:16-18`, built purely from `FIXED_ARGS` + `profile.args`)
or `env` (`:19-21`).

**(c) headless copilot** — `headlessCopilotRunner.js:95-96`
`args = ['-p', fullPrompt, ...FIXED_ARGS]`, spawned at `:113`.
Prompt is a **single argv element**. → **CANDIDATE (Low)**, see §2.2.

Gate 0 on the prompt itself: relaying caller-supplied prompt text to a coding CLI
is the bridge's entire product ("If I removed this input, the application loses
its only feature"). Gate 3: the partition threat model's existing-capability
baseline already includes *"type text into [PTY sessions] and read rendered
output"*, delivered through the **identical** code path
(`httpApi.js:161` `POST /api/sessions/:id/prompt` → `httpApi.js:22`
`writeAndSubmitPrompt` → same `promptWriter.js:9`). Same secret (`config.token`),
same outcome. Eliminated.

### #8 `n` (`openaiChat.js:27`)
**SAFE.** `if (body.n != null && body.n !== 1) throw 400` — strict-equality
allowlist of exactly one value; never propagates.

### #9/#10 `stream`, `stream_options.include_usage` (`openaiChat.js:40-41`)
### #18 `stream` (`openaiResponses.js:40`) · #22 `stream` (`anthropicMessages.js:37`)
**SAFE.** Coerced to booleans (`body.stream === true`, `!!(...)`); used only as
branch predicates (`openaiChat.js:70,95`). No sink.

### #11 `x-bridge-conversation` header · #12 `model` `#<pin>` suffix · #17 `previous_response_id`
**NO-MATCH for INJ** + **CROSS-CLASS (NAV)**.
Traced all uses. `pinId` is used exclusively as (i) a **`Map` key** —
`_pins.get/set` (`router.js:109,117`), never a plain-object key, so no prototype
pollution; (ii) `conv.id` (`router.js:61` via `_create({id: pinId})`) then
`_convs.set(conv.id, conv)` (`router.js:76`); (iii) interpolated into a 400 error
message (`router.js:112`) that lands in a JSON body. `previousResponseId` →
`_byResp.get()` (`router.js:227`, `Map`). **No INJ sink on any path.**

> **CROSS-CLASS (#11/#12/#17, `src/facade/router.js:61,76,109-118`, suspected class: NAV.)**
> `pinId` is an *arbitrary attacker string* used as the conversation identity with
> **no ownership check** — `acquire` (`router.js:108-118`) validates only *profile
> agreement* (`:110`), never who owns the pin. It is also assigned verbatim to
> `conv.id` and inserted into `_convs` (`router.js:61,76`), the same key space as
> server-generated `crypto.randomUUID()` ids (`router.js:61`), so a pin equal to an
> existing conversation's UUID silently **overwrites** that map entry, orphaning the
> live PTY record (its `_manager.remove` at `router.js:81` will then never run for
> the displaced conversation). This is the recon's **G5** item and matches the
> partition's explicitly non-baseline outcome *"hijacking or colliding with another
> conversation's live session"*. CWE-639 / CWE-843. Belongs to NAV.

### #13 `model` (`openaiResponses.js:14`) · #19 `model` (`anthropicMessages.js:16`)
**SAFE.** Identical to #5 — same `parsePin` (`openaiChat.js:12-18`, imported at
`openaiResponses.js:9` and `anthropicMessages.js:11`), same
`config.profiles[profileName]` allowlist lookup, same JSON-only reflection
(`openaiResponses.js:46,101`; `anthropicMessages.js:68,82`).

### #23 `x-api-key` header (`src/facade/index.js:42`)
**SAFE (INJ).** Reaches exactly one sink: `checkToken(token, config.token)`
(`index.js:45` → `auth.js:3-9`), a length-check + `crypto.timingSafeEqual`. Never
logged, never spawned, never interpolated. Absent-input check: when both
`Authorization` and `x-api-key` are missing, `token` is `null`, `checkToken`
returns `false` at `auth.js:4` (`typeof provided !== 'string'`) → 401 at
`index.js:46`. **Fails closed.** The `x-api-key` fallback is guarded by
`token == null` (`index.js:42`), so a *wrong* Bearer token cannot be re-tried via
`x-api-key`. No CVB.

### #24 arbitrary body keys → `console.warn` (`src/facade/shared.js:125-133`)
**NO-MATCH for INJ** + **CROSS-CLASS (LOG)**.
Not an INJ sink (stdout, not HTML/SQL/shell/URL).

> **CROSS-CLASS (#24, `src/facade/shared.js:131`, suspected class: LOG.)**
> ``console.warn(`facade: parameter "${k}" (${dialect}) is accepted but ignored…`)``
> where `k` is `Object.keys(body)` — an attacker-chosen **JSON object key**, which
> may contain `\n`, `\r` and ANSI escapes and is written with **zero** neutralization.
> Log-injection / forged-log-line, CWE-117. Secondary: the `ignoredLogged` `Set`
> (`shared.js:124`) is a module-level, never-evicted global keyed on
> `${dialect}.${k}` — unbounded attacker-driven memory growth (one entry per novel
> key, 8 MiB body cap at `shared.js:60`). Belongs to LOG.

### #25 `GET /v1/models` (`src/facade/models.js:9`)
**NO-MATCH.** The handler takes no request input at all — it maps over
`ctx.config.profiles` (`models.js:11-13`) and emits JSON. Nothing to trace.

### #42 child stdout JSONL — `j.session_id`, `j.result`, `j.usage` (`headlessClaudeRunner.js:51-68`)
**SAFE (INJ), with a hardening note.**
Three consumers traced independently:
- **`j.session_id`** (`:60,66`) → `conv.resumeSessionId` (`router.js:182`) → next
  turn's `args.push('--resume', resumeSessionId)` (`headlessClaudeRunner.js:17`).
  This *is* a separate argv token, so a value like `--dangerously-skip-permissions`
  would land as its own flag on an agentic CLI. **Gate 2a eliminates it**: the
  origin is the `claude` CLI's own `system/init` and `result` events, i.e. a
  CLI-generated UUID — framework/internal metadata, not attacker input. The
  attacker-influenced field in that stream is `j.result`, and it is emitted
  **inside a JSON string**, so model output containing `\n{"type":"system",…}`
  is JSON-escaped by the producer and can never become a new JSONL line for the
  `buf.indexOf('\n')` splitter at `:54`. No attacker-reachable write path exists.
  *Hardening note (not a finding):* `resumeSessionId` receives **no format
  validation** before becoming argv. A one-line UUID regex at
  `headlessClaudeRunner.js:17` would make this robust against any future upstream
  change that ever echoes prompt-influenced text into `session_id`.
- **`j.result`** (`:64`) → `outcome.text` → `events.push({type:'done', text})`
  (`router.js:247`) → dialect JSON/SSE (`openaiChat.js:75`, `openaiResponses.js:116`,
  `anthropicMessages.js:69`). Every one goes through `JSON.stringify`
  (`shared.js:48,142,143`) into an `application/json` / `text/event-stream`
  response. No HTML sink in this repo consumes it → not XSS here.
- **`j.usage`** (`:65,79-81`) → numeric arithmetic (`shared.js:156-162`). No sink.

### #43 child stdout JSONL — copilot (`headlessCopilotRunner.js:140-186`)
**SAFE (INJ).**
- **`j.sessionId`** (`:181`) → `resultSessionId` → `args.push(\`--resume=${…}\`)`
  (`:97`). Because it is **`=`-joined into a single argv element** and `spawn` is
  argv-array (no shell), a value such as `x --available-tools=bash` is delivered
  to copilot as one literal token `--resume=x --available-tools=bash`, not two
  flags. It cannot add an argv element. Structurally safe — and notably *safer*
  than the claude runner's space-separated form above.
- **`j.data.content` / `j.data.phase` / `j.data.deltaContent`** (`:162,165,175`) →
  `finalText` / delta events → JSON responses. Same JSON-only egress as #42.
- **`outputTokens`** (`:176`) → `typeof === 'number'` guarded → arithmetic.

### #44 child stderr tail echoed to the API client (`headlessClaudeRunner.js:49,74`; `headlessCopilotRunner.js:138,191`)
**NO-MATCH for INJ** + **CROSS-CLASS (LOG).**
`stderr.slice(-2000)` becomes `err.bridge` (`headlessClaudeRunner.js:74,75`;
`headlessCopilotRunner.js:191,192`) → `errorBody` spreads it into the response
(`shared.js:39,41,44`) → `JSON.stringify`. JSON-encoded, so no injection into the
response format.

> **CROSS-CLASS (#44, `src/facade/headlessClaudeRunner.js:74` and
> `src/facade/headlessCopilotRunner.js:191`, suspected class: LOG.)**
> 2 KiB of raw child stderr is returned verbatim to any bridge-token holder.
> Child stderr from a coding CLI routinely carries absolute host paths, `$HOME`,
> config locations and auth-failure detail. Information disclosure (CWE-209),
> reachable on demand by sending a prompt that makes the child exit non-zero.
> Same applies to `spawn_error: String(e.message)` (`headlessClaudeRunner.js:28,48`,
> `headlessCopilotRunner.js:116,137`), which leaks `profile.command`'s resolved
> **absolute filesystem path** from `config.js:147-150` vendor resolution.

### G4 — copilot tool lockdown / `profile.args` (`headlessCopilotRunner.js:70-89`)
**DESIGN-INTENT for the operator channel; see §2.2 for the prompt channel.**
`scrubToolExposureArgs` operates on `profile.args`, which is sourced only from
`BUILTIN_PROFILES` (`config.js:36-86`) or `PROFILE_<NAME>_ARGS` /
`CLAUDE_ARGS` (`config.js:137,120`) — **operator config, not an SG-1 input**.
Gate 2a therefore fails for the recon's two noted residuals (`--mcp-config` absent
from `EXPOSURE_VALUE_FLAGS` at `:65`; exact/case-sensitive `Set.has` at `:76,77`):
an attacker holding only the bridge token cannot reach `profile.args`. The file's
own comment (`:44-47`) reaches the same conclusion. Recorded as operator-config
hardening, not an attacker-reachable INJ finding.

### G5 — conversation identity derivation (`router.js:32-36,89-126`)
**CROSS-CLASS (NAV)** — folded into the #11/#12/#17 note above.
INJ-relevant sub-check performed and cleared: `_fp` (`router.js:32-36`) hashes
`JSON.stringify([profileName, messages.map(m => [m.role, m.text])])`. Because the
structure is serialized as nested JSON arrays before hashing, an attacker cannot
craft a `role`/`text` value that shifts a delimiter to forge another
conversation's digest (the classic hash-concatenation ambiguity does **not**
apply here). The `${profileName}\n` prefix at `:35` is redundant but harmless.
The exploitable part of G5 is the missing *ownership* check, which is NAV.

---

## 2. Findings

### 2.1 Eliminated at Gate 3 — terminal control-sequence injection into the PTY (CWE-150)

Recording the analysis because it is the strongest INJ mechanism in the partition,
and it is **eliminated on outcome, not on mechanism**.

- **Mechanism (real):** `promptWriter.js:12-15` wraps multi-line prompt text in
  bracketed paste, `` session.write(`\x1b[200~${text}\x1b[201~`) ``, with **no
  filtering of `text`**. An attacker prompt containing a literal `\x1b[201~`
  terminates the paste early; the remaining bytes are delivered to the CLI's line
  editor as **raw keystrokes** — including `\r` (submit) and arrow/escape
  sequences — instead of as pasted content. Reaches `session.js:25`
  `this._pty.write(data)`. Confirmed: no adapter or caller strips `\x1b`; the
  `generic` adapter (`generic.js:14`, `multiline: 'raw'`) skips the wrapper
  entirely and writes every newline through as a submit.
- **Gate 0:** partially applies (relaying prompt text is the product) but is not
  relied on.
- **Gate 1:** reachable — `writePromptText` has 2 production call sites
  (`promptWriter.js:28` from `turnRunner.js:88` and from `httpApi.js:22`).
- **Gate 2a:** attacker-controlled (#7/#15/#21, verbatim).
- **Gate 2b:** **no sanitization whatsoever.** Escape bytes pass through untouched.
- **Gate 3 — ELIMINATES.** The same outcome (arbitrary raw byte sequences,
  including escapes and submits, into a PTY-hosted CLI) is already available to
  the same principal via `POST /api/sessions/:id/prompt`
  (`httpApi.js:157-166`), whose `b.text` is passed to the **identical**
  `writeAndSubmitPrompt` at `httpApi.js:22` with the identical absence of
  filtering. Both endpoints are gated by the same single `config.token`
  (`httpApi.js:120` / `index.js:45`). The partition's stated baseline
  ("type text into them and read rendered output") covers it exactly. No new
  capability, no crossed authorization boundary, no bypassed control — the PTY
  profiles carry no tool lockdown for this to defeat (`config.js:36-66`;
  `copilot.js:66-73` auto-answers only the folder-trust dialog, so a tool-approval
  dialog still surfaces as `awaiting_input` → 409 at `router.js:160`).
- **Disposition:** eliminated. If the bridge API and the façade are ever split
  onto different credentials, this becomes a live finding and should be re-opened.

### 2.2 [VULN-INJ-001] Untrusted prompt is delivered as an argv element to the tool-locked copilot child

- **Input**: #7 / #15 / #21 — the prompt text, on the `copilot-headless` profile
- **Class**: CWE-88 (argument injection) — argv delivery of untrusted data to a
  child whose security posture is entirely argv-defined
- **Severity**: **Low** (theoretical: no in-repo proof the mechanism fires; see
  Exploitability)
- **Location**: `src/facade/headlessCopilotRunner.js:96` (`args = ['-p', fullPrompt, ...FIXED_ARGS]`), spawned at `:113`
- **Gate 0 (intended behavior?)**: Passing the prompt to copilot is intended.
  Gate 0 does **not** clear this, because the property at stake is the *tool
  lockdown* (`:54-61`) — a security control the file itself declares load-bearing
  ("tool execution must be impossible", `:19-20`) — not the prompt relay.
- **Gate 1 (reachable?)**: reachable. `runHeadlessCopilotTurn` is registered at
  `router.js:16` (`HEADLESS_RUNNERS.copilot`) and dispatched at `router.js:178`
  for any profile with `headlessRunner: 'copilot'` — i.e. `copilot-headless`
  (`config.js:77-81`), which is enabled by default (`config.js:103-105`,
  `BRIDGE_PROFILES` unset ⇒ all builtins) and advertised by `GET /v1/models`
  (`models.js:11-13`). Selected by `{"model":"copilot-headless"}` on any of the
  three façade POSTs. Not test-only.
- **Gate 2a (attacker-controlled?)**: **Yes, verbatim.** `body.messages[].content`
  → `flattenContent` (`shared.js:111`, concatenation only) → `norm.messages` →
  `router.acquire` → `userText` (`router.js:91`) → `fullPrompt` (`:95`) → `args[1]`
  (`:96`). Zero transformation along the path.
- **Gate 2b (sanitization?)**: **None in the audited codebase.** The only thing
  standing between the prompt and the flag namespace is copilot's own argv parser
  treating the token after `-p` as that option's value. Per the INJ Gate-2b
  methodology, I attempted empirical verification of that defense:
  - **(a) read the source** — not possible. `@github/copilot` is **not installed**:
    there is no `vendor/` directory in the repo, and `node_modules` contains no
    copilot package (`cli-pins.json` pins `@github/copilot@1.0.76` but nothing is
    vendored). The binary that `config.js:147-150` would resolve is absent.
  - **(b) construct a test** — not possible for the same reason; the CLI cannot be
    executed to probe whether `-p` consumes a leading-`-` token.
  - **(c)** → per the stated rule, the defense is recorded as **unverified and
    therefore treated as ineffective**, and the finding proceeds intact. I am
    flagging this explicitly rather than assuming the common
    commander/yargs behaviour (both of which *do* unconditionally consume the next
    token for a required option value, which would make this a non-issue).
  Note this is precisely the gap the file's own SECURITY comment asserts away at
  `:44-45` ("the untrusted PROMPT reaches copilot only as the single `-p <prompt>`
  argv value and cannot alter argv/env/FIXED_ARGS") — an in-repo *claim* about
  third-party parser semantics, with no canary or test backing it
  (`test/headlessCopilotRunner.test.js` locks the flag list, not the parse).
- **Gate 3 (new capability?)**: **Passes.** If the mechanism fires, the attacker
  obtains **arbitrary tool execution (including the builtin `bash` tool) inside
  the operator's shell with the operator's ambient credentials**, by re-exposing
  tools past `--available-tools=__none__` (`:58`). The partition's baseline
  explicitly lists *"reopening the copilot tool lockdown"* as **NOT** in the
  existing-capability set. The PTY `copilot` profile does not give the same
  outcome: it has no lockdown, but its tool-approval dialog surfaces as
  `awaiting_input` and returns a 409 (`turnRunner.js:71-73` → `router.js:159-163`)
  rather than executing — the copilot adapter auto-answers only the folder-trust
  dialog (`copilot.js:66-73`).
- **Entry Point**: `POST /v1/chat/completions`, `POST /v1/responses`, or
  `POST /v1/messages` with `{"model":"copilot-headless"}`
- **Data Flow**:
  `body.messages[].content` (`openaiChat.js:32`) → `flattenContent` (`shared.js:111-121`)
  → `norm.messages` (`openaiChat.js:39`) → `router.executeTurn` (`openaiChat.js:62`)
  → `acquire` → `userText` (`router.js:91`) → `_runTurn` (`router.js:180`)
  → `runHeadlessCopilotTurn` → `fullPrompt` (`headlessCopilotRunner.js:95`)
  → `args[1]` (`:96`) → `spawn(profile.command, args, …)` (`:113`)
- **Root Cause**: A security control implemented purely as trailing argv flags is
  placed in the same namespace as fully untrusted data, and the separation is
  delegated to an unverified third-party argv parser. There is no defensive
  measure on the bridge side (e.g. inserting a `--` end-of-options terminator
  before the prompt, or moving the prompt off argv as the claude runner does with
  stdin at `headlessClaudeRunner.js:85`).
- **Exploitability**: **Low / speculative.** Requires copilot's parser to treat a
  leading-`-` value after `-p` as a new option. Cannot be confirmed or refuted
  from this checkout (no binary present). Prerequisite is only a bridge token;
  exploitation would be a single unauthenticated-by-identity HTTP POST. The cheap,
  parser-independent fix is to place `--` (or move the prompt to stdin/an env-free
  channel) so no prompt byte can ever be read as a flag.

---

## 3. Absent-input analysis (mandatory)

Checked every SG-1 input that gates a security-critical block:

| Input | Omitted ⇒ | Fails |
|---|---|---|
| `Authorization` **and** `x-api-key` (#23) | `extractToken` → `null` (`auth.js:16`); `checkToken` returns `false` on `typeof provided !== 'string'` (`auth.js:4`) → 401 (`index.js:45-48`) | **closed** |
| `Authorization` present-but-wrong, `x-api-key` correct | fallback is gated on `token == null` (`index.js:42`), so the wrong Bearer is *not* replaced → 401 | **closed** |
| `model` (#5/#13/#19) | 400 before any routing (`openaiChat.js:21`, `openaiResponses.js:14`, `anthropicMessages.js:16`) | **closed** |
| `messages` / `input` (#7/#15/#21) | 400 (`openaiChat.js:24`, `openaiResponses.js:30-32`, `anthropicMessages.js:19`) | **closed** |
| pin header / `#` suffix / `previous_response_id` (#11/#12/#17) | falls through to the fingerprint path (`router.js:119-122`); no security check is skipped | **closed** |
| `stream`, `n`, `stream_options` (#8/#9/#10/#18/#22) | default to `false` / `1`; no security block gated | n/a |
| `profile.args` empty (G4) | `scrubToolExposureArgs` still runs unconditionally (`headlessCopilotRunner.js:99`); `FIXED_ARGS` lockdown always present (`:96`) | **closed** |

**No Conditional Validation Bypass found in the SG-1 INJ scope.**

---

## 4. Disposition summary

| Input | Disposition |
|---|---|
| #5 | SAFE — allowlist map lookup + JSON-only reflection; prototype keys lack `.command` (`router.js:222`) |
| #6 | DESIGN-INTENT — prompt content only |
| #7 | DESIGN-INTENT (PTY/stdin) · **CANDIDATE VULN-INJ-001** (copilot-headless argv) |
| #8 | SAFE — strict `!== 1` allowlist |
| #9 | SAFE — boolean coercion |
| #10 | SAFE — boolean coercion |
| #11 | NO-MATCH (INJ) · **CROSS-CLASS** `router.js:61,76,109-118` → NAV |
| #12 | NO-MATCH (INJ) · **CROSS-CLASS** `router.js:61,76,109-118` → NAV |
| #13 | SAFE — same as #5 |
| #14 | DESIGN-INTENT — prompt content |
| #15 | DESIGN-INTENT · **CANDIDATE VULN-INJ-001** (copilot-headless argv) |
| #16 | DESIGN-INTENT — prompt content |
| #17 | NO-MATCH (INJ) · **CROSS-CLASS** `router.js:227` → NAV |
| #18 | SAFE — boolean coercion |
| #19 | SAFE — same as #5 |
| #20 | DESIGN-INTENT — prompt content |
| #21 | DESIGN-INTENT · **CANDIDATE VULN-INJ-001** (copilot-headless argv) |
| #22 | SAFE — boolean coercion |
| #23 | SAFE — reaches only `crypto.timingSafeEqual` (`auth.js:3-9`); fails closed when absent |
| #24 | NO-MATCH (INJ) · **CROSS-CLASS** `shared.js:131` → LOG (CWE-117 + unbounded `Set`) |
| #25 | NO-MATCH — handler consumes no request input |
| #42 | SAFE — `session_id` is CLI-generated (Gate 2a); `result`/`usage` egress is JSON-only. Hardening note on unvalidated `--resume` argv token (`headlessClaudeRunner.js:17`) |
| #43 | SAFE — `sessionId` is `=`-joined into one argv token (`headlessCopilotRunner.js:97`); content egress is JSON-only |
| #44 | NO-MATCH (INJ) · **CROSS-CLASS** `headlessClaudeRunner.js:74`, `headlessCopilotRunner.js:191` → LOG (CWE-209) |
| G4 | DESIGN-INTENT for the operator channel (Gate 2a: `profile.args` is config-only) · prompt channel → **VULN-INJ-001** |
| G5 | NO-MATCH (INJ) — `_fp` JSON-structured hashing is not delimiter-forgeable · **CROSS-CLASS** → NAV |

**Candidates raised: 1** (VULN-INJ-001, Low).
**Cross-class referrals: 3 NAV** (#11/#12/#17 + G5), **3 LOG** (#24, #44).
