// src/facade/streamRenderer.js
// Incremental clean-text deltas from a TerminalModel transcript delta (spec
// "streamRenderer.js"). Each tick re-renders lines since the turn started,
// cleans them via adapter.extractResponse, and reports newly-STABILIZED
// cleaned lines — all but the last, which the CLI may still be repainting.
// Streaming is line-granular and best-effort: on a mid-turn repaint an
// already-emitted line can differ from the final render; finish().text (the
// full final clean render) is authoritative and is what the router stores.
export class StreamRenderer {
  constructor({ terminalModel, adapter, sinceIndex }) {
    this._tm = terminalModel;
    this._adapter = adapter;
    this._since = sinceIndex;
    this._lines = []; // lines emitted so far, verbatim
  }
  _cleanLines() {
    const text = this._adapter.extractResponse(this._tm.renderLinesSince(this._since));
    return text === '' ? [] : text.split('\n');
  }
  tick() {
    const stable = this._cleanLines().slice(0, -1);
    if (stable.length <= this._lines.length) return [];
    const out = stable.slice(this._lines.length);
    this._lines.push(...out);
    return out;
  }
  finish() {
    const lines = this._cleanLines();
    // The emitted lines are only a best-effort prefix of the final render: a
    // mid-turn repaint can leak chrome through the incremental clean, so
    // slicing by count alone can skip past real content. Emit the
    // authoritative tail from the first divergence point — identical to a
    // count slice whenever the emissions did match, and never drops final
    // content when they didn't (already-sent divergent lines can't be
    // retracted; duplication is the accepted cost).
    let match = 0;
    while (match < this._lines.length && match < lines.length && this._lines[match] === lines[match]) match += 1;
    return { text: lines.join('\n'), rest: lines.slice(match) };
  }
}
