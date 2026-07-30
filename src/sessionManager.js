import { Session } from './session.js';
import { TerminalModel } from './terminalModel.js';
import { StateDetector } from './stateDetector.js';
import { PromptQueue } from './promptQueue.js';
import { getAdapter } from './adapters/index.js';

const envKey = (name) => name.toUpperCase().replace(/-/g, '_');

// Startup-dialog policy as a pure per-tail decision (spec "Profiles"), consulted
// by the detector BEFORE it settles a turn (so an answered dialog never surfaces
// as awaiting_input). Returns true when it answered/consumed the dialog.
//   never        — decline everything (dialogs always surface)
//   startup-only — answer startupDialogs-matched screens
//   auto-approve — matched as above; plus default-accept 'enter' for unmatched
// Loop guard (both matched and unmatched): at most TWO answers per persisting
// screen (identical rendered tail); a different awaiting screen resets the cap,
// so a genuinely dismissed dialog frees the budget for the next one.
export function makeDialogHandler(record) {
  let answers = 0;
  let lastKey = null;
  const MAX = 2;
  return (tail) => {
    if (record.dialogPolicy === 'never') return false;
    const key = tail.join('\n');
    if (key !== lastKey) { answers = 0; lastKey = key; }
    const entry = (record.adapter.startupDialogs || []).find((d) => d.matcher(tail));
    const answer = (keys) => {
      if (answers >= MAX) return false;
      for (const k of keys) record.session.write(record.adapter.keySeq(k));
      answers += 1;
      return true;
    };
    if (entry) return answer(entry.answerKeys);
    if (record.dialogPolicy === 'auto-approve') return answer(['enter']);
    return false;
  };
}

export class SessionManager {
  constructor(config) { this._config = config; this._records = new Map(); }
  create({ profile, cwd, cols, rows } = {}) {
    const c = this._config;
    const name = profile || c.defaultProfile;
    const p = c.profiles[name];
    if (!p) {
      const err = new Error(`unknown profile "${name}"`);
      err.code = 'UNKNOWN_PROFILE';
      err.validProfiles = Object.keys(c.profiles);
      throw err;
    }
    if (p.mode !== 'pty') {
      const err = new Error(`profile "${name}" is ${p.mode}-mode and cannot back an interactive session`);
      err.code = 'PROFILE_NOT_PTY';
      err.validProfiles = Object.keys(c.profiles);
      throw err;
    }
    if (!p.command) {
      const err = new Error(`profile "${name}" has no command configured (set PROFILE_${envKey(name)}_COMMAND)`);
      err.code = 'PROFILE_NO_COMMAND';
      err.validProfiles = Object.keys(c.profiles);
      throw err;
    }
    // Registry may not yet carry this profile's adapter (transient window before
    // Tasks 10/12/13). Translate the registry throw into a coded, 400-able error
    // instead of letting a raw Error surface as a 500.
    let adapter;
    try {
      adapter = getAdapter(p.adapter);
    } catch {
      const err = new Error(`profile "${name}" uses adapter "${p.adapter}", which is not registered`);
      err.code = 'ADAPTER_UNAVAILABLE';
      err.validProfiles = Object.keys(c.profiles);
      throw err;
    }
    const session = new Session({
      command: p.command, args: [...p.args], cwd: cwd || p.cwd,
      env: process.env, envScrub: p.envScrub, envSet: p.envSet,
      cols: cols || p.cols, rows: rows || p.rows, ringBytes: c.ringBytes,
    });
    const terminalModel = new TerminalModel({ cols: cols || p.cols, rows: rows || p.rows, scrollback: c.scrollback });
    session.on('data', (d) => terminalModel.write(d));
    const record = {
      id: session.id, session, terminalModel, adapter,
      queue: new PromptQueue(), createdAt: Date.now(),
      profile: name, dialogPolicy: p.dialogPolicy,
    };
    // Build the dialog handler over the record, then hand it to the detector so
    // an auto-answered dialog keeps the session busy rather than surfacing.
    const dialogHandler = makeDialogHandler(record);
    record.detector = new StateDetector({ session, terminalModel, adapter, quiescenceMs: p.quiescenceMs, dialogHandler });
    this._records.set(session.id, record);
    return record;
  }
  get(id) { return this._records.get(id); }
  list() { return [...this._records.values()]; }
  remove(id) { const r = this._records.get(id); if (r) { r.session.kill(); this._records.delete(id); } return !!r; }
}
