import pkg from '@xterm/headless';
const { Terminal } = pkg;

export class TerminalModel {
  constructor({ cols = 120, rows = 30, scrollback = 5000 }) {
    this._term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this._rows = rows;
  }
  write(chunk) { return new Promise((resolve) => this._term.write(chunk, resolve)); }
  resize(cols, rows) { this._term.resize(cols, rows); this._rows = rows; }
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
