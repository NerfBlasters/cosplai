// src/adapters/claude.js
//
// Pinned to Claude Code 2.x (built against 2.1.198; last live-verified on
// 2.1.219 — the version pinned in cli-pins.json). Markers below are derived
// from the empirically-captured fixtures in test/fixtures/*.txt (see
// test/fixtures/NOTES.md for the full spike writeup). They are matched
// against RENDERED terminal lines (TerminalModel#viewportTail /
// #renderLinesSince, i.e. @xterm/headless output), never against raw PTY
// bytes: NOTES.md documents that the same logical line (e.g. the footer) is
// sometimes written as one contiguous byte run and sometimes fragmented
// across many `\x1b[<N>G` cursor-absolute-column jumps (one per word) on
// incremental/animated redraws, so a raw-byte substring/regex search is
// unreliable. The rendered line is always whole.
import { cleanTranscript } from './extract.js';

const KEYS = {
  enter: '\r', submit: '\r', up: '\x1b[A', down: '\x1b[B',
  left: '\x1b[D', right: '\x1b[C', esc: '\x1b', tab: '\t', 'ctrl-c': '\x03',
};

// Idle marker: rendered footer line contains "? for shortcuts" (only true
// when not generating). Verified against test/fixtures/claude-idle.txt
// (rendered tail line 6, viewportTail(8)):
//   "  ? for shortcuts · ← for agents                                                                              0 tokens"
// and the completed-response state in test/fixtures/claude-response.txt.
const IDLE_MARKERS = [/\?\s*for shortcuts/];

// Busy marker: rendered footer line contains "esc to interrupt" for the
// entire generation. Verified by truncating the real bytes of
// test/fixtures/claude-response.txt to a prefix that lands inside the
// mid-generation window (before the footer reverts back to
// "? for shortcuts" near the end of that file) and rendering it, giving:
//   "  esc to interrupt · ← for agents                                                                             0 tokens"
// This is a negative gate for idle, not a positive "awaiting input" signal —
// Claude is actively working, not waiting on the user.
const BUSY_MARKERS = [/esc to interrupt/];

// Awaiting-input marker: the startup/trust dialog. Verified against
// test/fixtures/claude-trust.txt (rendered tail lines 1 and 5,
// viewportTail(8)):
//   " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source"
//   " ❯ 1. Yes, I trust this folder"
// NOTES.md documents this dialog as appearing on every launch even when the
// cwd has previously been trusted.
//
// There is NO captured fixture for Claude Code's tool-permission menu
// (test/fixtures/NOTES.md, "Permission menu — not captured": the spike's
// attempt to trigger one ran the tool straight through with no prompt, likely
// due to this machine's skipAutoPermissionPrompt/skipDangerousModePermission
// settings). NOTES.md explicitly warns not to infer a menu marker from the
// trust dialog's shape (numbered `❯ 1./2.` options + "Enter to confirm"
// footer) since it's a different, unverified code path. So MENU_MARKERS is
// intentionally omitted here — only the verified trust-dialog marker is used
// for isAwaitingInput. This means a real permission menu will currently be
// misclassified (most likely as idle, since it doesn't carry the idle/busy
// footer at all, so isIdle would also read false) — flagged as a known gap,
// not silently guessed at.
const AWAITING_INPUT_MARKERS = [/Quick safety check:|Yes, I trust this folder/];

// Chrome lines to strip when extracting the assistant reply from a rendered
// transcript delta (spec: adapter contract, extractResponse). Derived from the
// same fixtures as the markers above. Best-effort by design.
const CHROME = [
  /^\s*─+\s*$/,          // input-box horizontal rules
  /\?\s*for shortcuts/,  // idle footer
  /esc to interrupt/,    // busy footer
  /^\s*◉/,               // effort/status footer line
  /^\s*❯/,               // input box (typed text before submit)
  /^\s*>\s/,             // submitted-prompt echo in the transcript
  /^\s*[✻✶✳]\s/,        // spinner / post-run summary lines ("✻ Crunched for 2s")
  /^\s*\+\d+ more ·/,    // banner overflow line
];

const anyMatch = (tail, res) => res.some((re) => tail.some((l) => re.test(l)));

export const claude = {
  name: 'claude',
  isAwaitingInput(tail) { return anyMatch(tail, AWAITING_INPUT_MARKERS); },
  isBusy(tail) { return anyMatch(tail, BUSY_MARKERS); },
  isIdle(tail) {
    if (this.isAwaitingInput(tail)) return false;
    if (anyMatch(tail, BUSY_MARKERS)) return false;
    return anyMatch(tail, IDLE_MARKERS);
  },
  describePrompt(tail) { return this.isAwaitingInput(tail) ? tail.join('\n') : null; },
  extractResponse(lines) {
    return cleanTranscript(lines, { chrome: CHROME, blockMarker: /^●\s?/gm });
  },
  startupDialogs: [
    {
      // The every-launch trust dialog (test/fixtures/claude-trust.txt).
      matcher: (tail) => tail.some((l) => /Quick safety check:|Yes, I trust this folder/.test(l)),
      answerKeys: ['enter'],
    },
  ],
  keySeq(name) {
    return Object.prototype.hasOwnProperty.call(KEYS, name) ? KEYS[name] : String(name);
  },
};
