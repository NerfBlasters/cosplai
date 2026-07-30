// src/adapters/codex.js
//
// Pinned to Codex CLI 0.134.0 (gpt-5.5). Markers derived from
// test/fixtures/codex-*.txt (see NOTES.md §Codex), matched against RENDERED
// lines only (TerminalModel#viewportTail / #renderLinesSince), never raw PTY
// bytes — same rendering rule as the claude adapter. Alt-screen verdict: NONE
// — codex draws in the normal buffer and repaints in place, so it is NOT
// degraded; the viewportTail/renderLinesSince transcript model applies.
import { cleanTranscript } from './extract.js';

const KEYS = {
  enter: '\r', submit: '\r', up: '\x1b[A', down: '\x1b[B',
  left: '\x1b[D', right: '\x1b[C', esc: '\x1b', tab: '\t', 'ctrl-c': '\x03',
};

// Idle marker: the status footer's " · Ready · " segment. Verified against
// all 5 fixtures' viewportTail(8): matches on idle/response/typed, not on
// boot/busy (NOTES.md §Codex "Verified candidate marker regexes").
const IDLE_MARKERS = [/·\s+Ready\s+·/];

// Busy marker: status footer's " · Working · " segment and/or the spinner
// line's "esc to interrupt". Verified: matches only on the busy fixture.
const BUSY_MARKERS = [/·\s+Working\s+·/, /esc to interrupt/];

// Awaiting-input marker: the first-launch trust dialog (codex-boot.txt).
// Verified: matches only on the boot fixture.
const TRUST_DIALOG_RE = /Do you trust the contents of this directory\?|Yes, continue/;
const AWAITING_INPUT_MARKERS = [TRUST_DIALOG_RE];

// The startup update prompt (codex-update-dialog.txt, observed live
// 2026-07-24 on 0.134.0 → 0.145.0). All three lines must be present — the
// matcher fires on every settle for the session's lifetime, and a transcript
// merely DISCUSSING the dialog could echo one or two of them. Its DEFAULT
// option runs `npm install -g @openai/codex`, so the only safe unattended
// answer is "3. Skip until next version" (never a bare Enter).
const isUpdateDialog = (tail) =>
  tail.some((l) => /Update available!/.test(l))
  && tail.some((l) => /Press enter to continue/.test(l))
  && tail.some((l) => /Skip until next version/.test(l));

// Chrome lines to strip when extracting the assistant reply from a rendered
// transcript delta. Verified to reduce codex-response.txt to exactly "PONG"
// (NOTES.md §Codex).
const CHROME = [
  /[│╭╰╮╯]/,                                 // box-drawing borders
  /·.*Context.*used|weekly \d+%/,             // status footer line
  /^\s*Tip:/,                                 // tip line
  /^\s*›/,                                    // input placeholder / echoed prompt
  /esc to interrupt/,                         // busy spinner line
  /^\s*•\s*Working/,                          // spinner (active/summary)
  /OpenAI Codex|^\s*model:|^\s*directory:/,   // banner
  /You are in/,                               // boot/trust line
];

const anyMatch = (tail, res) => res.some((re) => tail.some((l) => re.test(l)));

export const codex = {
  name: 'codex',
  isAwaitingInput(tail) { return anyMatch(tail, AWAITING_INPUT_MARKERS) || isUpdateDialog(tail); },
  isBusy(tail) { return anyMatch(tail, BUSY_MARKERS); },
  isIdle(tail) {
    if (this.isAwaitingInput(tail)) return false;
    if (anyMatch(tail, BUSY_MARKERS)) return false;
    return anyMatch(tail, IDLE_MARKERS);
  },
  describePrompt(tail) { return this.isAwaitingInput(tail) ? tail.join('\n') : null; },
  extractResponse(lines) {
    return cleanTranscript(lines, { chrome: CHROME, blockMarker: /^•\s?/gm });
  },
  startupDialogs: [
    {
      // The first-launch trust dialog (test/fixtures/codex-boot.txt). Default
      // option is "1. Yes, continue" — answered with bare Enter.
      matcher: (tail) => tail.some((l) => TRUST_DIALOG_RE.test(l)),
      answerKeys: ['enter'],
    },
    {
      // The startup update prompt (codex-update-dialog.txt). "3" selects
      // "Skip until next version" immediately (verified live: codex settles
      // to the Ready footer a few seconds later). Enter would run the
      // npm install — never auto-answer that.
      matcher: isUpdateDialog,
      answerKeys: ['3'],
    },
  ],
  keySeq(name) {
    return Object.prototype.hasOwnProperty.call(KEYS, name) ? KEYS[name] : String(name);
  },
};
