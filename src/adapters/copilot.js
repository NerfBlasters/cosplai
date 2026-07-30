// src/adapters/copilot.js
//
// GitHub Copilot CLI (`copilot`, v1.0.76). Markers derived from
// test/fixtures/copilot-*.txt (see NOTES.md §"GitHub Copilot CLI"), matched
// against RENDERED lines only. Idle/busy/awaiting markers re-verified on 1.0.75
// (2026-07-24): the idle footer `/ commands · ? help` and the `● <text>` answer
// block are unchanged from 1.0.74. Still matching on 1.0.76 (2026-07-30 live
// canary — turns settle via these markers; extraction unchanged, see below).
//
// AUTH: copilot authenticates via its OWN device-code login, stored under
// `~/.copilot` (config.json) — NOT the `gh` CLI's keyring (that keyring belongs
// to the `gh` tool). Scrubbing GH_TOKEN/GITHUB_TOKEN/COPILOT_GITHUB_TOKEN just
// removes ambient PATs so copilot falls back to that stored subscription login.
//
// DEGRADED (alt-screen), and effectively empty since 1.0.75 (re-verified on
// 1.0.76): copilot draws in the
// alternate screen buffer and repaints in place, so viewportTail state
// detection is reliable but `extractResponse` is not — the `renderLinesSince`
// transcript-diff finds nothing new across repaints (the `● PONG` answer paints
// on screen, but the line count never advances), so a facade turn through this
// PTY profile extracts EMPTY. For exact-fidelity copilot output over the
// facade, use the `copilot-headless` profile (src/facade/headlessCopilotRunner:
// `copilot -p --output-format json`), which avoids the PTY entirely.
import { cleanTranscript } from './extract.js';

const KEYS = {
  enter: '\r', submit: '\r', up: '\x1b[A', down: '\x1b[B',
  left: '\x1b[D', right: '\x1b[C', esc: '\x1b', tab: '\t', 'ctrl-c': '\x03',
};

// Idle: the `/ commands · ? help · tab next tab` footer (only when not working).
const IDLE_MARKERS = [/\/ commands · \? help/];
// Busy: the `◎ Working esc interrupt` footer during generation.
const BUSY_MARKERS = [/Working esc interrupt|◎ Working/];
// Awaiting: the every-launch folder-trust dialog.
const AWAITING_INPUT_MARKERS = [/Do you trust the files in this folder|Yes, and remember this folder/];

// Best-effort chrome strip for extractResponse (adapter is DEGRADED — see header).
const CHROME = [
  /[│─╭╰╮╯▔█▝▘]/,                                                       // box art / banner / rules
  /\/ commands · \? help|@ files · # issues/,                            // footer (idle / input mode)
  /Working esc interrupt|◎ Working/,                                     // busy footer
  /^\s*❯/,                                                               // input box / echoed prompt
  /Tip:|Initialize Copilot|Prefer a visual|github\.com\/features/,       // tip block
  /Session:.*AIC used/,                                                  // usage status
  /^\s*~/,                                                               // cwd status line
  /Do you trust|remember this folder|No \(Esc\)|read files in this folder|navigate · enter/, // trust dialog
  /Copilot v[\d.]+ uses AI|Check for mistakes|Session   Issues/,         // banner
];

const anyMatch = (tail, res) => res.some((re) => tail.some((l) => re.test(l)));

export const copilot = {
  name: 'copilot',
  isAwaitingInput(tail) { return anyMatch(tail, AWAITING_INPUT_MARKERS); },
  isBusy(tail) { return anyMatch(tail, BUSY_MARKERS); },
  isIdle(tail) {
    if (this.isAwaitingInput(tail)) return false;
    if (anyMatch(tail, BUSY_MARKERS)) return false;
    return anyMatch(tail, IDLE_MARKERS);
  },
  describePrompt(tail) { return this.isAwaitingInput(tail) ? tail.join('\n') : null; },
  extractResponse(lines) {
    return cleanTranscript(lines, { chrome: CHROME, blockMarker: /^\s*●\s?/gm });
  },
  startupDialogs: [
    {
      // Folder-trust dialog (default-selected "1. Yes"). This is a local file-
      // trust prompt, not an auth flow — safe to auto-answer like the other CLIs.
      matcher: (tail) => tail.some((l) => /Do you trust the files in this folder|Yes, and remember this folder/.test(l)),
      answerKeys: ['enter'],
    },
  ],
  keySeq(name) {
    return Object.prototype.hasOwnProperty.call(KEYS, name) ? KEYS[name] : String(name);
  },
};
