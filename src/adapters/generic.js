// src/adapters/generic.js
// Fallback adapter for any process that isn't a specifically-modeled tool.
// Quiescence (no output arriving for the poll interval, decided upstream by
// the caller) is treated as the only signal: once quiet, the process is
// considered idle. There is no way to detect a modal prompt generically, so
// isAwaitingInput is always false and describePrompt is always null.
const KEYS = {
  enter: '\r', submit: '\r', up: '\x1b[A', down: '\x1b[B',
  left: '\x1b[D', right: '\x1b[C', esc: '\x1b', tab: '\t', 'ctrl-c': '\x03',
};

export const generic = {
  name: 'generic',
  multiline: 'raw', // legacy pass-through: newlines submit per line (spec exception)
  isIdle() { return true; },
  isAwaitingInput() { return false; },
  describePrompt() { return null; },
  extractResponse(lines) {
    // Identity minus the echoed first line (spec: adapter contract table).
    return (lines.length > 1 ? lines.slice(1) : lines).join('\n').trim();
  },
  keySeq(name) {
    return Object.prototype.hasOwnProperty.call(KEYS, name) ? KEYS[name] : String(name);
  },
};
