# Fabric over the Copilot OpenAI Facade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **THIS PLAN OVERRIDES THAT DEFAULT:** all tasks that spawn the server, PTYs, tests, or live CLI turns MUST run controller-side (inline, via superpowers:executing-plans). Subagents auto-background PTY-spawning work and stall (Phase 5 handoff §7). Dispatch subagents ONLY for the Task 8 review.

**Goal:** Stand the bridge up as an OpenAI-compatible endpoint backed by `copilot` (`copilot-headless` profile, underlying LLM pinned to `gpt-5.6-terra`), validate it end-to-end with fabric as a real third-party client, and ship a fresh-machine guide.

**Architecture:** No new bridge features. The existing cloud-API facade (`/v1/models`, `/v1/chat/completions`, `/v1/responses`) already routes `model: "copilot-headless"` through `copilot -p --output-format json` under the tool lockdown. Work = housekeeping commits (pending hardening, pin bump 1.0.76) → run server → install/configure fabric against it → guide.

**Tech Stack:** Node 20 (`node --test`), copilot CLI 1.0.76 (vendored via `npm run pin`), fabric (Go release binary), curl.

**Spec:** `docs/superpowers/specs/2026-07-30-fabric-openai-endpoint-design.md`

## Global Constraints

- **NEVER pipe `node --test`** — always `> file 2>&1`, then read the file (leaked-PTY hang).
- **Live/PTY/server work controller-side only**; subagents for review only.
- Offline suite must be green (**238 pass / 0 fail**: prior 237 + 1 new lockdown-scrub test) before every commit.
- Scratch dir (absolute, use verbatim): `/tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad` — referred to as `$SCRATCH` below; **each Bash call is a fresh shell**, so every step re-derives vars inline (no cross-step exports).
- Bridge token lives at `$SCRATCH/bridge-token` (created Task 3); read it as `TOK=$(cat $SCRATCH/bridge-token)`.
- Underlying LLM pin: `PROFILE_COPILOT_HEADLESS_ARGS='["--model","gpt-5.6-terra"]'` on every server start.
- The guide records only commands actually executed, with real versions.
- Commit messages: no Co-Authored-By trailers (user rule).
- Quota budget: canary ~5–6 AIU + ~4–5 fabric/curl live turns. Don't add speculative live runs.

---

### Task 1: Verify + commit the pending lockdown hardening

**Files:**
- Modify (already modified in tree, just commit): `src/facade/headlessCopilotRunner.js`, `test/headlessCopilotRunner.test.js`

**Interfaces:**
- Produces: committed `scrubToolExposureArgs()` behavior — operator `profile.args` are stripped of `--available-tools*`, `--allow-tool*`, `--allow-all-tools`, `--allow-all`, `--yolo` before spawn; benign args (e.g. `--model gpt-5.6-terra`) pass through. Task 3's model pin depends on this pass-through.

- [ ] **Step 1: Run the offline suite (unpiped)**

```bash
cd /home/kali/repos/pty-web-bridge && node --test > /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/suite-task1.out 2>&1; tail -5 /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/suite-task1.out
```

Expected: `# pass 238` / `# fail 0`. If it hangs >5 min: a leaked PTY — find the culprit by per-file `timeout 45 node --test <file>` runs (handoff §7), fix, re-run.

- [ ] **Step 2: Commit the hardening**

```bash
cd /home/kali/repos/pty-web-bridge && git add src/facade/headlessCopilotRunner.js test/headlessCopilotRunner.test.js && git commit -m "fix: harden copilot lockdown — scrub operator tool-exposure args from profile.args"
```

---

### Task 2: Pin bump copilot 1.0.75 → 1.0.76 + live canary

**Files:**
- Modify: `cli-pins.json` (copilot `version` field only)

**Interfaces:**
- Produces: vendored `vendor/node_modules/.bin/copilot` at 1.0.76, live-validated JSONL contract (the `assistant.message_start.data.phase === 'final_answer'` gating that streaming depends on).

- [ ] **Step 1: Edit the pin** — in `cli-pins.json`, copilot block: `"version": "1.0.75"` → `"version": "1.0.76"`.

- [ ] **Step 2: Re-vendor and verify version (source of truth = --version, not package.json)**

```bash
cd /home/kali/repos/pty-web-bridge && npm run pin && vendor/node_modules/.bin/copilot --version
```

Expected: pin script succeeds; version line reads `GitHub Copilot CLI 1.0.76.`

- [ ] **Step 3: Offline suite still green**

```bash
cd /home/kali/repos/pty-web-bridge && node --test > /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/suite-task2.out 2>&1; tail -5 /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/suite-task2.out
```

Expected: `# pass 238` / `# fail 0`.

- [ ] **Step 4: Live canary (GATE) — controller-side, output to file, generous timeout**

```bash
cd /home/kali/repos/pty-web-bridge && node scripts/live-acceptance.mjs copilot copilot-headless > /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/canary.out 2>&1; cat /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/canary.out
```

(Bash timeout: 600000ms.) Expected: **`copilot-headless` = 3/3 byte-exact** (PONG / streamed DONG / resume PING). PTY `copilot` empty/degraded extraction is EXPECTED and acceptable (alt-screen, handoff must-know #3). Gate rule: `copilot-headless` failures block — diagnose against the runner's JSONL parsing (`src/facade/headlessCopilotRunner.js`) before proceeding; fixing the runner for 1.0.76 contract drift is in-scope and joins this commit.

- [ ] **Step 5: Commit pin (+ any drift fixes) together**

```bash
cd /home/kali/repos/pty-web-bridge && git add cli-pins.json && git commit -m "chore: bump copilot pin 1.0.75 → 1.0.76 (binary self-updated; canary green)"
```

(If Step 4 required runner/fixture fixes, `git add` those too and say so in the message body.)

---

### Task 3: Stand up the bridge + wire-level smoke

**Files:**
- Create (runtime artifacts, not committed): `$SCRATCH/bridge-token`, `$SCRATCH/bridge.log`

**Interfaces:**
- Produces: bridge on `http://127.0.0.1:7681` with facade dialects on, `copilot-headless` pinned to `gpt-5.6-terra`. Tasks 4–6 consume the URL + token file.

- [ ] **Step 1: Generate + store the token**

```bash
openssl rand -hex 24 > /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/bridge-token && chmod 600 /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/bridge-token
```

- [ ] **Step 2: Start the server (background Bash, log to file)**

```bash
cd /home/kali/repos/pty-web-bridge && BRIDGE_TOKEN=$(cat /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/bridge-token) PROFILE_COPILOT_HEADLESS_ARGS='["--model","gpt-5.6-terra"]' node src/server.js > /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/bridge.log 2>&1
```

Run with `run_in_background: true`. Then read `$SCRATCH/bridge.log`: expect `pty-web-bridge listening.` and `Facade dialects: …` lines, no strict-version error.

- [ ] **Step 3: Smoke /v1/models**

```bash
TOK=$(cat /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/bridge-token); curl -s http://127.0.0.1:7681/v1/models -H "authorization: Bearer $TOK"
```

Expected: JSON `{"object":"list","data":[…]}` including `{"id":"copilot-headless",…}`.

- [ ] **Step 4: Smoke one live chat completion (validates the gpt-5.6-terra pin end-to-end)**

```bash
TOK=$(cat /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/bridge-token); curl -s http://127.0.0.1:7681/v1/chat/completions -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"model":"copilot-headless","messages":[{"role":"user","content":"reply with exactly: PONG"}]}'
```

Expected: `chat.completion` object, `choices[0].message.content === "PONG"`, `finish_reason: "stop"`, `bridge.usage_estimated: true`. A `500` with stderr mentioning an unknown model = the `--model` pin is wrong — re-check `copilot help config` names.

---

### Task 4: Install fabric (release binary)

**Files:**
- Create: `~/.local/bin/fabric` (host tool, not in repo)

**Interfaces:**
- Produces: `fabric` on PATH; exact version string recorded for the guide.

- [ ] **Step 1: Discover the latest release + linux-amd64 asset URL**

```bash
curl -s https://api.github.com/repos/danielmiessler/fabric/releases/latest | grep -E '"tag_name"|browser_download_url.*linux-amd64'
```

Expected: a `tag_name` (record it) and one asset URL like `…/fabric-linux-amd64`.

- [ ] **Step 2: Download to ~/.local/bin, make executable**

```bash
mkdir -p ~/.local/bin && curl -sL -o ~/.local/bin/fabric '<asset URL from Step 1>' && chmod +x ~/.local/bin/fabric
```

- [ ] **Step 3: Verify binary + PATH**

```bash
~/.local/bin/fabric --version; command -v fabric || echo "NOT on PATH — use full path in later steps and note PATH line in guide"
```

Expected: version matching Step 1's tag. If not on PATH, all later `fabric` invocations use `~/.local/bin/fabric` and the guide gains an `export PATH="$HOME/.local/bin:$PATH"` line.

---

### Task 5: Configure fabric against the bridge

**Files:**
- Create: `~/.config/fabric/.env` (host config, not in repo; contains the token → `chmod 600`)

**Interfaces:**
- Consumes: bridge URL + `$SCRATCH/bridge-token` (Task 3), `fabric` binary (Task 4).
- Produces: fabric default vendor=OpenAI, default model=`copilot-headless`, patterns installed.

- [ ] **Step 1: Write .env directly (no TUI)**

```bash
mkdir -p ~/.config/fabric && TOK=$(cat /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/bridge-token) && printf 'DEFAULT_VENDOR=OpenAI\nDEFAULT_MODEL=copilot-headless\nOPENAI_API_KEY=%s\nOPENAI_API_BASE_URL=http://127.0.0.1:7681/v1\n' "$TOK" > ~/.config/fabric/.env && chmod 600 ~/.config/fabric/.env && cat ~/.config/fabric/.env
```

- [ ] **Step 2: Fetch the pattern library**

```bash
~/.local/bin/fabric -U 2>&1 | tail -5; ls ~/.config/fabric/patterns | head -5
```

Expected: pattern download completes; `patterns/` contains entries (e.g. `summarize`).

- [ ] **Step 3: List models through fabric (exercises GET /v1/models via fabric's client)**

```bash
~/.local/bin/fabric --listmodels 2>&1 | grep -B2 -A4 -i "copilot-headless\|openai"
```

Expected: an OpenAI vendor section listing `copilot-headless` (and the other bridge profiles). Failure here = .env keys wrong → fall back to `fabric --setup` interactively (spec fallback), then re-run.

---

### Task 6: End-to-end pattern tests (non-stream, stream, route probe)

**Files:**
- Create: `$SCRATCH/sample.txt` (test input)

**Interfaces:**
- Consumes: everything above.
- Produces: proven fabric→bridge→copilot loop both non-stream and streamed; the fact of which OpenAI route fabric uses (chat vs responses) for the guide.

- [ ] **Step 1: Create sample input**

```bash
printf 'The pty-web-bridge is a local Node service that wraps interactive AI CLIs in pseudo-terminals and exposes them over HTTP, SSE, and WebSocket. Its cloud-API facade speaks the OpenAI and Anthropic wire protocols, translating chat requests into turns on the wrapped CLIs, so official SDKs and third-party tools work unmodified against subscription-authenticated CLIs. Sessions are token-protected, serialized per conversation, and reaped when idle.\n' > /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/sample.txt
```

- [ ] **Step 2: Non-stream pattern turn**

```bash
cat /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/sample.txt | ~/.local/bin/fabric -p summarize
```

Expected: a real copilot-generated summary (markdown, per the summarize pattern's format: ONE SENTENCE SUMMARY / MAIN POINTS / TAKEAWAYS). No chrome, no manual cleanup.

- [ ] **Step 3: Streamed pattern turn**

```bash
cat /tmp/claude-1000/-home-kali-repos-pty-web-bridge/ad8649af-e67f-4b82-a7cc-da79052912d3/scratchpad/sample.txt | ~/.local/bin/fabric -s -p summarize
```

Expected: same class of output, streamed incrementally.

- [ ] **Step 4: Route probe — which OpenAI route does fabric use?** Kill the background server (TaskStop on the Task 3 background shell or `pkill -f 'node src/server.js'`), restart it identically but with `FACADE_OPENAI_CHAT=false` added, run:

```bash
echo "reply with exactly: PING" | ~/.local/bin/fabric -p raw_query 2>&1 | head -5
```

- If it **succeeds** → fabric uses `/v1/responses`. If it **fails with a 404-ish error** → fabric uses `/v1/chat/completions`. Record for the guide. (If `raw_query` pattern doesn't exist in the pattern set, use `-p summarize` with the sample again.)
- Then kill + restart the server WITHOUT the toggle (back to Task 3 Step 2 form) and confirm `$SCRATCH/bridge.log` shows the listening line again.

---

### Task 7: Write the guide + README link

**Files:**
- Create: `docs/guides/fabric-openai-endpoint.md`
- Modify: `README.md` (docs list around lines 16–20 — add one link line)

**Interfaces:**
- Consumes: every recorded command/output/version from Tasks 2–6.

- [ ] **Step 1: Write `docs/guides/fabric-openai-endpoint.md`** with exactly these sections, using only commands actually executed, with the real recorded versions (copilot 1.0.76, fabric tag from Task 4, bridge commit):
  1. **What you get** — fabric talking OpenAI wire protocol to a local endpoint backed by your Copilot subscription; note the tool-lockdown security property (the endpoint cannot execute tools; prompt text is the only untrusted input that reaches copilot).
  2. **Prerequisites** — Node ≥20, a Copilot subscription, ~2 GB disk for vendoring; Kali/Debian note: **apt's `fabric` is a different project (Python SSH tool) — do not install it**.
  3. **Bridge setup** — clone, `npm run pin`, `copilot login` device flow (auth lives in `~/.copilot`, NOT the gh keyring), token generation, the exact server start line with `PROFILE_COPILOT_HEADLESS_ARGS`.
  4. **Smoke test with curl** — the Task 3 `/v1/models` + PONG commands and their real outputs.
  5. **Install fabric** — the Task 4 release-binary commands (+ PATH line if it was needed); one-line alternative for Go users: `go install github.com/danielmiessler/fabric/cmd/fabric@latest`.
  6. **Configure fabric** — the Task 5 `.env` (token redacted as `<your bridge token>`), `chmod 600`, `-U`, `--listmodels`.
  7. **Use it** — the Task 6 non-stream + streamed pattern commands with sample output (trimmed).
  8. **Which model am I talking to?** — two layers: fabric's `DEFAULT_MODEL` = bridge profile (`copilot-headless`); actual LLM = copilot's `--model` (`gpt-5.6-terra`), valid names via `copilot help config`, changed by editing `PROFILE_COPILOT_HEADLESS_ARGS`. Note which route fabric used (Task 6 Step 4 result), and that sampling params fabric sends (temperature etc.) are accepted-and-ignored by the facade by design.
  9. **Troubleshooting** — table: fabric-side symptom → cause → fix, covering 401 (bad token), 404 model_not_found (wrong DEFAULT_MODEL / profile disabled), 429 (all sessions busy), 504 + slow turns (`PROMPT_TIMEOUT_MS`), unknown `--model` name after a copilot bump (`copilot help config`), copilot self-update drift (`--version` vs pin), and `.env` permissions.
- [ ] **Step 2: Link from README** — in the docs list (README.md:16–20), add: `- **[docs/guides/fabric-openai-endpoint.md](docs/guides/fabric-openai-endpoint.md)** — end-to-end guide: fabric as an OpenAI client against the copilot-backed facade.`
- [ ] **Step 3: Full offline suite green** (same command as Task 1 Step 1, fresh out-file `suite-task7.out`). Expected `# pass 238` / `# fail 0`.
- [ ] **Step 4: Commit**

```bash
cd /home/kali/repos/pty-web-bridge && git add docs/guides/fabric-openai-endpoint.md README.md && git commit -m "docs: fresh-machine guide — fabric as OpenAI client over the copilot facade"
```

---

### Task 8: Review pass + wrap-up

**Files:**
- Possibly modify: whatever the review finds.

- [ ] **Step 1: Dispatch review subagent(s)** (this is the ONLY subagent work) via superpowers:requesting-code-review over `git log --oneline 47ceda0..HEAD` (47ceda0 = HEAD when this plan was written) — lenses: security (lockdown/token handling in guide + hardening commit), accuracy (does the guide match what was actually run), docs consistency (README/API.md claims vs guide).
- [ ] **Step 2: Fix findings** (each fix + suite re-run + commit, same rules as above). Dismissals need stated cause.
- [ ] **Step 3: Shut down the background server** (TaskStop / `pkill -f 'node src/server.js'`) and confirm nothing is listening on 7681.
- [ ] **Step 4: Update memory** — rewrite the project-status memory file: fabric guide shipped, pin now 1.0.76, gpt-5.6-terra pinned, master further ahead of origin (still unpushed — pushing stays the user's call).
