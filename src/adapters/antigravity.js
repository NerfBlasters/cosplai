// src/adapters/antigravity.js
//
// Google's subscription coding CLI, `agy` (Antigravity 1.1.6) — the supported
// successor to the sunset `gemini` CLI. Markers derived from
// test/fixtures/antigravity-*.txt (see NOTES.md §"Antigravity CLI (agy)"),
// matched against RENDERED lines only.
//
// DEGRADED (alt-screen): agy uses the alternate screen buffer and repaints in
// place, so viewportTail-based state detection is reliable (idle/busy/awaiting
// markers verified against fixtures) but `extractResponse` is BEST-EFFORT — the
// renderLinesSince transcript-diff is not a dependable scrollback across
// alt-screen repaints. Exact-fidelity extraction is the Phase-2 headless
// `agy -p`/`--print` runner (agy also has --continue/--conversation for resume).
import { cleanTranscript } from './extract.js';

const KEYS = {
  enter: '\r', submit: '\r', up: '\x1b[A', down: '\x1b[B',
  left: '\x1b[D', right: '\x1b[C', esc: '\x1b', tab: '\t', 'ctrl-c': '\x03',
};

// Idle: the `? for shortcuts` footer (present only when not generating).
const IDLE_MARKERS = [/\?\s*for shortcuts/];
// Busy: a `Generating...` line during generation (reverts to the idle footer
// on completion — it is a negative gate for idle, mirroring claude's footer).
const BUSY_MARKERS = [/Generating/];
// Awaiting: the every-launch project-trust dialog.
const AWAITING_INPUT_MARKERS = [/Do you trust the contents of this project|Yes, I trust this folder/];

// Best-effort chrome strip for extractResponse (adapter is DEGRADED — see header).
const CHROME = [
  /[│─╭╰╮╯▀▄]/,                                                                 // box art / banner blocks / rules
  /\?\s*for shortcuts/,                                                          // idle footer
  /Generating/,                                                                  // busy line
  /^\s*>/,                                                                       // input box / echoed prompt
  /Antigravity Starter Quota|Gemini 3\.\d|Navigate · enter|↑\/↓/,               // banner / status
  /Do you trust|trust this folder|No, exit|requires permission/,                 // trust dialog
  /Accessing workspace/,                                                         // trust preamble
];

const anyMatch = (tail, res) => res.some((re) => tail.some((l) => re.test(l)));

export const antigravity = {
  name: 'antigravity',
  isAwaitingInput(tail) { return anyMatch(tail, AWAITING_INPUT_MARKERS); },
  isBusy(tail) { return anyMatch(tail, BUSY_MARKERS); },
  isIdle(tail) {
    if (this.isAwaitingInput(tail)) return false;
    if (anyMatch(tail, BUSY_MARKERS)) return false;
    return anyMatch(tail, IDLE_MARKERS);
  },
  describePrompt(tail) { return this.isAwaitingInput(tail) ? tail.join('\n') : null; },
  extractResponse(lines) {
    return cleanTranscript(lines, { chrome: CHROME });
  },
  startupDialogs: [
    {
      matcher: (tail) => tail.some((l) => /Do you trust the contents of this project|Yes, I trust this folder/.test(l)),
      answerKeys: ['enter'],
    },
  ],
  keySeq(name) {
    return Object.prototype.hasOwnProperty.call(KEYS, name) ? KEYS[name] : String(name);
  },
};
