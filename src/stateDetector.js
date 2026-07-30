import { EventEmitter } from 'node:events';

export class StateDetector extends EventEmitter {
  constructor({ session, terminalModel, adapter, quiescenceMs = 500, dialogHandler = null }) {
    super();
    this._tm = terminalModel;
    this._adapter = adapter;
    this._quiescenceMs = quiescenceMs;
    this._dialogHandler = dialogHandler;
    this._hasBusy = typeof adapter.isBusy === 'function';
    this._timer = null;
    this._idleTicks = 0;
    this._interval = null;
    this.state = 'starting';
    session.on('data', () => this._onData());
    session.on('exit', () => { this._clearTimers(); this._setState('exited'); });
    // Spinner-animated CLIs never go quiescent: when the adapter offers a
    // positive busy signal, ALSO evaluate markers on a periodic tick during
    // sustained output (spec "StateDetector changes").
    if (this._hasBusy) this._startInterval();
    this._onData(); // arm initial quiescence so a quiet startup can settle
  }
  _setState(s) { if (this.state !== s) { this.state = s; this.emit('state', s); } }
  _startInterval() {
    this._interval = setInterval(() => this._periodicCheck(), this._quiescenceMs);
    if (this._interval.unref) this._interval.unref();
  }
  _clearTimers() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }
  _armQuiescence() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._evaluate(), this._quiescenceMs);
  }
  markBusy() {
    if (this.state === 'exited') return;
    this._idleTicks = 0;
    this._setState('busy');
    // Re-phase the periodic interval so both confirming idle-ticks post-date
    // this prompt write by a full quiescence period (no stale pre-prompt frame).
    if (this._hasBusy) { clearInterval(this._interval); this._startInterval(); }
    this._armQuiescence();
  }
  _onData() {
    if (this.state === 'exited') return;
    // Pure-quiescence adapters: every chunk means busy (legacy behavior).
    // isBusy adapters: data arrival must NOT demote an established idle/awaiting
    // — marker evaluation owns downward transitions, so continuous spinner
    // repaints can't trap the session in busy.
    if (!this._hasBusy) this._setState('busy');
    else if (this.state === 'starting') this._setState('busy');
    this._armQuiescence();
  }
  // Returns true if the dialog policy consumed the awaiting-input screen (stay
  // busy); false if it surfaced as awaiting_input.
  _handleAwaiting(tail) {
    if (this._dialogHandler && this._dialogHandler(tail)) {
      this._idleTicks = 0;
      this._setState('busy');
      this._armQuiescence();
      return true;
    }
    this._setState('awaiting_input');
    return false;
  }
  _evaluate() {
    if (this.state === 'exited') return;
    const tail = this._tm.viewportTail(8);
    if (this._adapter.isAwaitingInput(tail)) { this._handleAwaiting(tail); return; }
    if (this._hasBusy && this._adapter.isBusy(tail)) {
      // Quiet but still painting a busy footer (long silent tool run): stay
      // busy and re-arm so the next quiet gap re-checks.
      this._setState('busy');
      this._armQuiescence();
      return;
    }
    if (this._adapter.isIdle(tail)) this._setState('idle');
    else this._setState('busy'); // not settled — a later chunk re-arms; else stays busy
  }
  _periodicCheck() {
    if (this.state === 'exited' || this.state === 'awaiting_input') return;
    const tail = this._tm.viewportTail(8);
    if (this._adapter.isAwaitingInput(tail)) { this._handleAwaiting(tail); return; }
    if (this._adapter.isBusy(tail)) { this._idleTicks = 0; return this._setState('busy'); }
    if (this._adapter.isIdle(tail)) {
      this._idleTicks += 1;
      if (this._idleTicks >= 2) { this._idleTicks = 0; this._setState('idle'); }
    } else {
      this._idleTicks = 0;
    }
  }
  waitForSettle({ timeoutMs = 600000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.state === 'idle' || this.state === 'awaiting_input') return resolve(this.state);
      if (this.state === 'exited') return reject(new Error('session exited'));
      let to = null;
      const onState = (s) => {
        if (s === 'idle' || s === 'awaiting_input') { cleanup(); resolve(s); }
        else if (s === 'exited') { cleanup(); reject(new Error('session exited')); }
      };
      const cleanup = () => { this.off('state', onState); if (to) clearTimeout(to); };
      to = setTimeout(() => { cleanup(); reject(new Error('settle timeout')); }, timeoutMs);
      this.on('state', onState);
    });
  }
}
