# Claude Code 2.1.198 interactive TUI — observed under node-pty

Captured 2026-07-02 on this machine (`claude` 2.1.198, Node v20.19.2, node-pty).
Spawn: `pty.spawn('claude', [], { name: 'xterm-256color', cols: 120, rows: 30, cwd: process.env.HOME, env })`
with `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` deleted from the child env (subscription auth via
`~/.claude/.credentials.json`).

All fixtures below were rendered with the project's own `@xterm/headless` (pass the raw `Buffer` straight to
`term.write()` — **do not** `.toString('binary')` it, that mangles multi-byte UTF-8 glyphs like `❯`/`✻`/`─`
into garbage). Line numbers quoted below are from that render, cols=120 rows=30.

## a) Alt-screen buffer

**No.** Checked all 10 raw capture files (fixtures + intermediate scratch snapshots) byte-for-byte with
Python for `\x1b[?1049h` (enter alt-screen) and `\x1b[?1049l` (exit alt-screen): **0 occurrences of either
in any capture**, including the trust dialog, idle screen, typing, spinner/busy, and completed-response
frames. Claude Code draws directly in the normal screen buffer and repaints regions in place (cursor
absolute-column jumps, not full-screen clears). Confirmed with:

```
python3 -c "print(open('test/fixtures/claude-idle.txt','rb').read().count(b'\x1b[?1049h'))"   # -> 0
```

## b) Idle input prompt rendering

Full idle frame (`test/fixtures/claude-idle.txt`, post-trust-dialog, rendered):

```
 ▐▛███▜▌   Claude Code v2.1.198
▝▜█████▛▘  Opus 4.8 (1M context) with xhigh effort · Claude Max
  ▘▘ ▝▝    /home/kali

 ▎ Fable 5 is back.
 ▎ Until July 7, you can use up to 50% of your plan's weekly usage limit on Fable 5. If you hit your limit, you can
 ▎ continue on Fable 5 with usage credits. Fable 5 draws down usage faster than Opus 4.8. Learn more
 ▎ (https://support.claude.com/en/articles/15424964-claude-fable-5-promotional-access)
   +1 more · /status

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts · ← for agents                                                                              0 tokens
                                                                                                     ◉ xhigh · /effort
```

The banner (version/model/promo) is one-time/session-specific and will differ run to run (promo expires
July 7, token count changes, etc). The **stable structural signature of "idle"** is the 3-line input box:
a `─`-rule line, a line beginning `❯ ` (empty when idle, contains typed text while composing), another
`─`-rule line, followed immediately by a footer line containing the literal substring `? for shortcuts`
and ending with a right-aligned `<N> tokens` counter. This footer text is the single most reliable
discriminator vs. busy (see (e)) because it is *replaced wholesale* by `esc to interrupt` while generating,
and reverts to `? for shortcuts` the instant generation completes (verified in
`test/fixtures/claude-response.txt`, line 9, immediately after the response landed).

## c) Submit key

**Yes, `\r` (Enter) submits.** Verified end-to-end: wrote `reply with exactly: PONG` into the input box,
waited 600ms, sent `\r` — the footer immediately flipped from `? for shortcuts` to `esc to interrupt`, a
spinner line appeared, and ~2s later `● PONG` appeared in the transcript with the footer back to
`? for shortcuts`. See `test/fixtures/claude-response.txt`.

## d) Startup/trust dialog

**Present, every run, unexpectedly persistent.** Contrary to the initial assumption that `$HOME` would
already be a trusted folder (it has `projectOnboardingSeenCount: 22` in `~/.claude.json`), the trust
dialog reappeared on both spike runs. Checked `~/.claude.json` after accepting it in run 1:
`projects["/home/kali"].hasTrustDialogAccepted` is still `false` afterward — trusting `$HOME` specifically
does not appear to persist (plausibly a deliberate safety special-case since `$HOME` is an unusually broad
trust grant; not confirmed from source, just the observed behavior). **Any adapter/spike spawning `claude`
with `cwd: $HOME` must expect and handle this dialog on every launch.**

Captured to `test/fixtures/claude-trust.txt`, full frame:

```
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /home/kali

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
```

Handling: sent `\r` alone (no other input first) to accept the default-selected "Yes, I trust this folder"
option. **Important timing pitfall found empirically:** in run 1, the spike typed the PONG prompt text
*before* confirming this dialog — the dialog silently swallowed the free-text keystrokes (menus only
respond to digits/arrows/Enter/Esc) and the subsequent `\r` was consumed by the dialog instead of
submitting a chat message, so no PONG was captured. Run 2 fixed this by staging: wait → capture trust →
send bare `\r` → wait for idle → *then* type the prompt → wait → `\r` to submit. This staging is the
correct model for the adapter.

## e) Spinner / busy line + footer

While generating, an extra line appears above the input box with a rotating glyph + verb + elapsed time,
e.g. (verbatim, two different real observations from the same session):

```
✻ Swooping… (1s)
```
```
✶ Generating… (3s · ↑ 94 tokens · thinking with xhigh effort)
```

The glyph (`✻` U+273B vs `✶` U+2736) and the verb ("Swooping" vs "Generating") both vary between calls —
Claude Code rotates through a set of playful status verbs/glyphs, so **neither the glyph nor the verb is a
stable regex anchor**. What *is* stable and was true in both observations: the line matches the shape
`<glyph> <Word>… (<N>s...)`, and — far more importantly — **the footer line's leading segment switches from
`? for shortcuts` to the literal string `esc to interrupt`** for the entire busy duration:

```
  esc to interrupt · ← for agents                                                                             0 tokens
```

After generation completes, the spinner line is replaced by a static (non-animating, past-tense) summary
like `✻ Crunched for 2s` while the footer has *already* reverted to `? for shortcuts` — so completion
detection should key off the footer text, not the presence/absence of a `✻`/`✶`-prefixed line (that line
can linger briefly post-completion as a summary).

## Permission menu — not captured

Attempted to trigger one by asking `run the shell command: ls`. It executed immediately via the `Bash`
tool with **no confirmation prompt at all** — `● Bash(ls)` ran straight through to output. This is almost
certainly because this machine's `~/.claude/settings.json` has `"skipAutoPermissionPrompt": true` and
`"skipDangerousModePermissionPrompt": true` set (pre-existing user config, not something this spike set),
and/or `ls` is on Claude Code's built-in always-allowed read-only command list. No `claude-menu.txt` fixture
was produced. **Do not infer a menu-marker regex from the trust dialog** — it is visually similar
(numbered `❯ 1./2.` options, `Enter to confirm` footer) but is a different, unverified code path; Task 6
should treat tool-permission-menu detection as a best-effort/deferred heuristic, not a verified marker.

## Bonus (unverified as primary signal, but observed): OSC window title

`\x1b]0;...` title-set sequences also track busy/idle, independent of screen content:
- Idle: `✳ Claude Code` (U+2733), static.
- Busy: cycles through braille spinner glyphs `⠂`/`⠐` (U+2802/U+2810) prefixed to the (possibly
  auto-renamed) conversation title, e.g. `⠐ Reply with pong message`.
- Settles back to `✳ Reply with pong message` on completion.
Not needed given the footer-text signal above is simpler and doesn't require OSC-sequence parsing, but
could be a useful secondary/cross-check signal for Task 6 if title tracking is already available.

No MCP-server startup notice text was observed in the boot/idle capture window (searched raw bytes of the
boot+idle captures for `MCP`, `mcp`, `clawdwars`, `server` — zero matches), despite `~/.claude/config.json`
defining an MCP server (`clawdwars`) for this user. Either it connects silently, too fast for our ~3.5s
snapshot, or outside the captured window.

## Critical architecture finding: raw-byte regex matching is unreliable — render first

The same logical footer line is **not always written as one contiguous byte run**. On a full-screen
initial draw (e.g. the idle screen right after boot) it *is* contiguous:

```
...\x1b[38;2;153;153;153mesc to interrupt \xc2\xb7 \xe2\x86\x90 for agents...   (NOT what we found below)
```

But on an incremental/animated redraw (e.g. mid-spinner), the *identical conceptual line* is fragmented
across many `\x1b[<N>G` (cursor-absolute-column) jumps, one per word — confirmed via raw byte dump of
`test/fixtures/claude-response.txt`:

```
\x1b[3Gesc\x1b[7Gto\x1b[10Ginterrupt\x1b[20G·\x1b[22G←\x1b[24Gfor\x1b[28Gagents\x1b[111G0\x1b[113Gtokens
```

i.e. `esc`, `to`, `interrupt`, `·`, `←`, `for`, `agents`, `0`, `tokens` are each separate writes positioned
by absolute column, not one string. A raw-byte substring/regex search for `esc to interrupt` on the PTY
stream **fails** on this frame (verified: `data.count(b'esc to interrupt')` == 0 in every capture that
contains a busy frame, while `? for shortcuts` — written as one contiguous run on full-redraws — does
occasionally match raw bytes but not reliably either, e.g. it also gets fragmented on some frames).
**Conclusion: Task 6's adapter must feed bytes through a terminal emulator (this repo already depends on
`@xterm/headless` for exactly this) and run marker regexes against the reconstructed rendered lines
(`buffer.getLine(i).translateToString(true)`), never against the raw PTY byte stream directly.**

## Candidate marker regexes (match against `@xterm/headless`-rendered lines, one line at a time)

**Idle marker** — footer line contains `? for shortcuts` (only true when not generating):
```js
/\?\s*for shortcuts/
```
Source line (rendered, `test/fixtures/claude-idle.txt` line 13 / `claude-response.txt` line 9):
`"  ? for shortcuts · ← for agents                                                                              0 tokens"`
Verified programmatically: matches both idle-footer captures, does not match either busy-footer capture.

**Busy/spinner marker** — footer line contains `esc to interrupt` (true for the entire generation, both
simple-reply and tool-use/thinking turns):
```js
/esc to interrupt/
```
Source line (rendered, `scratch/snap-04-busy.txt` line 17 and the tool-use turn `scratch/snap-06-*` frame):
`"  esc to interrupt · ← for agents                                                                             0 tokens"`
Verified programmatically: matches both busy-footer captures, does not match either idle-footer capture.

Secondary/best-effort spinner-line shape (do not rely on the glyph or verb, both vary):
```js
/^[✻✶]\s+\S+…/
```
Source lines: `"✻ Swooping… (1s)"` and `"✶ Generating… (3s · ↑ 94 tokens · thinking with xhigh effort)"`.

**Trust/startup dialog marker**:
```js
/Quick safety check:|Yes, I trust this folder/
```
Source lines (`test/fixtures/claude-trust.txt` lines 6 and 13):
`" Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source"`
`" ❯ 1. Yes, I trust this folder"`

**Menu marker**: none captured — no regex to offer. Defer to a best-effort heuristic in Task 6 (e.g. reuse
the numbered-`❯ N.`-options + `Enter to confirm` footer shape as a starting point) and flag it explicitly
as unverified against a real permission-menu capture.

## Files in this directory

- `claude-trust.txt` — raw PTY bytes, boot → trust dialog (before any input sent).
- `claude-idle.txt` — raw PTY bytes, post-trust-accept, settled idle screen (before typing anything).
- `claude-response.txt` — raw PTY bytes from the moment `reply with exactly: PONG` was typed through
  submit → busy/spinner → completed `● PONG` response → idle again.

---

# Codex CLI 0.134.0 (gpt-5.5) — observed under node-pty

Captured 2026-07-23 via `scratch/capture-codex.mjs` (`codex` 0.134.0, ChatGPT
login, `OPENAI_API_KEY`/`CODEX_API_KEY` deleted from the child env). Spawn
120x30. Same rendering rule as the claude spike: match RENDERED lines
(`TerminalModel.viewportTail`/`renderLinesSince`), never raw PTY bytes.

## a) Alt-screen buffer

**No.** All 5 codex fixtures have 0 occurrences of `\x1b[?1049h`. Codex draws
in the normal buffer and repaints in place (a bordered input box + a status
footer line), so the viewportTail/renderLinesSince transcript model applies —
the adapter is NOT degraded.

## b) Startup/trust dialog

**Present on first launch in an untrusted dir.** `test/fixtures/codex-boot.txt`
renders:

```
> You are in /home/kali
  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt
  injection. Trusting the directory allows project-local config, hooks, and exec policies to load.
› 1. Yes, continue
  2. No, quit
  Press enter to continue
```

Answered with bare Enter (`\r`) — the default-selected option is "1. Yes,
continue". This is a startupDialogs entry with `answerKeys: ['enter']`.

## c) Submit key

`\r` (Enter). Verified: typing `reply with exactly: PONG` then `\r` flipped the
status line from `Ready` to `Working` and produced a `• Working (…)` spinner.

## d) Idle vs busy (the discriminator)

Codex renders a single status footer line, e.g. (idle):
`  gpt-5.5 high · ~ · gpt-5.5 · Ready · Workspace · on-request · Context 100% left · …`
and (busy):
`  gpt-5.5 high · ~ · gpt-5.5 · Working · Workspace · … `
plus, while working, a spinner line `• Working (1s • esc to interrupt)`.

The stable idle signature is the ` · Ready · ` segment of the status line; the
stable busy signature is ` · Working · ` and/or `esc to interrupt`. Note: the
"typed but not yet submitted" frame is still **idle** (`Ready`) — correct, the
CLI is waiting on the user; sendPrompt types then submits then awaits.

## e) Response / transcript shape (for extractResponse)

The assistant reply is a `• `-prefixed transcript line: `• PONG`. The input box
placeholder/echo is a `› `-prefixed line (`› Implement {feature}` when empty,
`› reply with exactly: PONG` echoing typed text). Box borders are
`│ ╭ ╰ ─ ╮ ╯`. The busy spinner line is `• Working (…)`.

## Verified candidate marker regexes (match against rendered lines)

Checked against all 5 fixtures' viewportTail(8): matches only where the state
holds, zero matches elsewhere (boot / busy / idle / response / typed):

- **Idle**: `/·\s+Ready\s+·/` — Y on idle,response,typed; `.` on boot,busy.
- **Busy**: `/·\s+Working\s+·/` and `/esc to interrupt/` — Y on busy only.
- **Awaiting (trust dialog)**: `/Do you trust the contents of this directory\?|Yes, continue/` — Y on boot only.

**Chrome (for extractResponse), verified to reduce codex-response.txt to exactly
`"PONG"`:**
```js
const CHROME = [
  /[│╭╰╮╯]/,                                  // box-drawing borders
  /·.*Context.*used|weekly \d+%/,              // status footer line
  /^\s*Tip:/,                                  // tip line
  /^\s*›/,                                     // input placeholder / echoed prompt
  /esc to interrupt/,                          // busy spinner line
  /^\s*•\s*Working/,                           // spinner (active/summary)
  /OpenAI Codex|^\s*model:|^\s*directory:/,    // banner
  /You are in/,                                // boot/trust line
];
// then: kept.join('\n').replace(/^•\s?/gm,'').trim()  →  "PONG"
```
Idle-footer text for Task 10's negative assertion: the ` · Ready · ` status
segment. Input-box marker for the other negative assertion: a line starting `›`.

## Files

- `codex-boot.txt` — boot → trust dialog (before any input).
- `codex-idle.txt` — after Enter-accepting trust, settled Ready screen.
- `codex-typed.txt` — prompt typed, not yet submitted (still Ready).
- `codex-busy.txt` — mid-generation (`Working` + `esc to interrupt`).
- `codex-response.txt` — completed `• PONG`, back to Ready.

---

# Antigravity CLI (`agy`) 1.1.6 — observed under node-pty  [replaces gemini]

**Why not `gemini`:** the standalone `gemini` CLI's OAuth was sunset for
individual accounts (spike hit "This client is no longer supported for Gemini
Code Assist for individuals ... migrate to the Antigravity suite" and
"Authentication consent could not be obtained"). Google's supported successor
is **Antigravity** (`agy`), installed and subscription-authenticated on this
machine. The Phase-1 "gemini" profile therefore targets `agy` with adapter
`antigravity`. Captured 2026-07-23 via `scratch/capture-antigravity.mjs`
(Google/Gemini API-key env vars deleted), 120x30.

## a) Alt-screen buffer — YES → adapter is DEGRADED

**Alt-screen: yes** (`\x1b[?1049h` present in all 5 captures). Unlike
claude/codex, agy repaints in the ALTERNATE buffer. Consequence per the spec's
fixture-spike rule: **state detection still works** (markers matched against
the rendered `viewportTail`), but `extractResponse` is **best-effort** — the
renderLinesSince transcript-diff is not a reliable scrollback across alt-screen
in-place repaints. The exact-fidelity path for agy is its `-p`/`--print`
headless mode (Phase 2; agy also has `--continue`/`--conversation` for resume,
like claude-headless).

## b) Startup/trust dialog

`antigravity-boot.txt`:
```
Do you trust the contents of this project?
Antigravity CLI requires permission to read, edit, and execute files here.
> Yes, I trust this folder
  No, exit
  ↑/↓ Navigate · enter Confirm
```
startupDialogs entry: matcher on the trust text, `answerKeys: ['enter']`
(default-selected "Yes, I trust this folder").

## c) Submit key

`\r` (Enter). Verified: typing then `\r` produced a `Generating...` line and
then the reply.

## d) Idle vs busy (verified markers)

agy's TUI mirrors Claude Code closely: a `? for shortcuts` idle footer and a
`>` input box between `─` rules.
- **Idle**: `/\? for shortcuts/` — Y on idle, response; `.` on boot, typed, busy.
- **Busy**: `/Generating/` (renders as a `Generating...` line during
  generation, reverts to `? for shortcuts` on completion) — Y on the busy frame.
  Gemini Flash is fast, so the busy frame lives only mid-stream: the busy test
  renders a **prefix** of `antigravity-busy.txt` up to byte ~5897 (the
  `Generating` window), same technique as the claude busy test.
- **Awaiting (trust)**: `/Do you trust the contents of this project|Yes, I trust this folder/` — Y on boot only.
- Note: the "typed but not submitted" frame shows neither `? for shortcuts` nor
  `Generating` (footer collapses to the model status line) — correctly non-idle.

## e) Response shape (extractResponse, best-effort — DEGRADED)

The reply renders as an indented plain line (`  PONG`) after the echoed
`> reply with exactly: PONG`. Best-effort CHROME (verified to reduce
`antigravity-response.txt`'s current viewport to exactly `"PONG"`):
```js
const CHROME = [
  /[│─╭╰╮╯▀▄]/,                                        // box art + banner blocks + rules
  /\? for shortcuts/,                                   // idle footer
  /Generating/,                                         // busy line
  /^\s*>/,                                              // input box / echoed prompt
  /Antigravity Starter Quota|Gemini 3\.\d|Navigate · enter|↑\/↓/, // banner/status
  /Do you trust|trust this folder|No, exit|requires permission/,               // trust dialog
  /Accessing workspace/,                                // trust preamble
];
```
Because the adapter is degraded, treat extracted text as best-effort; exact
output belongs to the Phase-2 headless `agy -p` runner.

## Files

- `antigravity-boot.txt` — trust dialog.
- `antigravity-idle.txt` — settled idle (`? for shortcuts`).
- `antigravity-typed.txt` — prompt typed, not submitted.
- `antigravity-busy.txt` — span capture; `Generating` at prefix ~5897, completed `PONG` at end.
- `antigravity-response.txt` — completed `PONG`, back to idle (byte-identical to busy).

---

# GitHub Copilot CLI (`copilot`) 1.0.74 — observed under node-pty

Installed 2026-07-23 via `npm install -g @github/copilot` (installed and RAN on
Node v20.19.2 despite the docs' Node-22 recommendation — the engines check was
advisory). Captured via `scratch/capture-copilot.mjs` with
`GH_TOKEN`/`GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN` deleted from the child env.

**VERIFIED (not a stub):** the plan scoped copilot as best-effort/no-seat, but
this machine's `gh` CLI is authenticated (keyring, account NerfBlasters) and
copilot picks that up even with the token env vars scrubbed — so it reaches a
real idle prompt and a full prompt round-trip (`● PONG`) was captured. All
idle/busy/awaiting markers are fixture-verified.

## a) Alt-screen buffer — YES → adapter DEGRADED

Alt-screen present in all captures. State detection reliable via viewportTail;
`extractResponse` best-effort (same treatment as antigravity).

## b) Startup/trust dialog

`copilot-boot.txt`:
```
Do you trust the files in this folder?
❯ 1. Yes
  2. Yes, and remember this folder for future sessions
  3. No (Esc)
  ↑/↓ to navigate · enter to select · esc to cancel
```
startupDialogs entry: matcher on the trust text, `answerKeys: ['enter']`
(default-selected "1. Yes"). This is a local file-trust prompt, not an auth
flow — auth is handled by `gh` — so it is safe to auto-answer like the others.

## c) Submit key

`\r` (Enter).

## d) Idle vs busy (verified markers, checked against all 5 fixtures)

- **Idle**: `/\/ commands · \? help/` (footer `/ commands · ? help · tab next tab`) — Y on idle, response; `.` on boot, typed, busy.
- **Busy**: `/Working esc interrupt|◎ Working/` (footer `◎ Working esc interrupt`) — Y on busy only.
- **Awaiting (trust)**: `/Do you trust the files in this folder|Yes, and remember this folder/` — Y on boot only.
- The "typed" frame shows an `@ files · # issues` input-mode footer (neither idle nor busy) — correctly non-idle.

## e) Response shape (extractResponse, best-effort — DEGRADED)

Reply renders as a `●`-prefixed line (` ● PONG`). Verified CHROME (see
`src/adapters/copilot.js`) reduces `copilot-response.txt` to exactly `"PONG"`
(strip chrome + `.replace(/^\s*●\s?/gm,'')` — note the leading space before the
bullet, unlike claude's column-0 `●`).

## Files

- `copilot-boot.txt` — folder-trust dialog.
- `copilot-idle.txt` — settled idle (`/ commands · ? help`).
- `copilot-typed.txt` — prompt typed, not submitted (`@ files · # issues`).
- `copilot-busy.txt` — mid-generation (`◎ Working esc interrupt`).
- `copilot-response.txt` — completed `● PONG`, back to idle.
