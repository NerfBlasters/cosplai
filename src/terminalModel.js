import pkg from '@xterm/headless';
const { Terminal } = pkg;

// Upper bound on terminal geometry. xterm allocates eagerly and in proportion
// to cols x (rows + scrollback), so an unbounded value here is an unbounded
// allocation: 6000x6000 costs ~415 MB. 1000 is far above any real terminal
// (a 4K display at a 4px font is ~960 columns) while capping the worst case at
// a few tens of MB.
export const MAX_DIMENSION = 1000;
export const MIN_DIMENSION = 1;

// Clamp one dimension into [MIN_DIMENSION, MAX_DIMENSION]. Non-finite and
// non-integer values fall back to `fallback` rather than reaching the
// allocator, so `{cols: "6000"}` / `{cols: NaN}` can't slip through either.
export function clampDimension(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.trunc(n)));
}

export class TerminalModel {
  constructor({ cols = 120, rows = 30, scrollback = 5000 }) {
    // Clamp at the model, not at the callers: every create path
    // (POST /api/sessions) and every resize path (the /ws resize frame)
    // reaches the allocator through this class, so bounding it here closes
    // the class for present and future callers alike.
    const safeCols = clampDimension(cols, 120);
    const safeRows = clampDimension(rows, 30);
    this._term = new Terminal({ cols: safeCols, rows: safeRows, scrollback, allowProposedApi: true });
    this._rows = safeRows;
  }
  get cols() { return this._term.cols; }
  get rows() { return this._rows; }
  write(chunk) { return new Promise((resolve) => this._term.write(chunk, resolve)); }
  resize(cols, rows) {
    const safeCols = clampDimension(cols, this._term.cols);
    const safeRows = clampDimension(rows, this._rows);
    this._term.resize(safeCols, safeRows);
    this._rows = safeRows;
  }
  _buf() { return this._term.buffer.active; }
  snapshotLineCount() { const b = this._buf(); return b.baseY + b.cursorY; }
  _lineText(i) { const line = this._buf().getLine(i); return line ? line.translateToString(true) : ''; }
  renderLinesSince(index) {
    const b = this._buf();
    const end = b.baseY + this._rows;
    const out = [];
    for (let i = Math.max(0, index); i < end; i++) out.push(this._lineText(i).replace(/\s+$/, ''));
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }
  viewportTail(n = 6) {
    const b = this._buf();
    const end = b.baseY + this._rows;
    const out = [];
    for (let i = end - 1; i >= 0 && out.length < n; i--) {
      const t = this._lineText(i).replace(/\s+$/, '');
      if (t !== '') out.unshift(t);
    }
    return out;
  }
}
