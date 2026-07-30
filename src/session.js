import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import pty from 'node-pty';

export class Session extends EventEmitter {
  constructor({ command, args = [], cwd, env = process.env, cols = 120, rows = 30, ringBytes = 262144, envScrub = [], envSet = {} }) {
    super();
    this.id = crypto.randomUUID();
    this.alive = true;
    this.exitInfo = null;
    this._ringBytes = ringBytes;
    this._ring = Buffer.alloc(0);
    const childEnv = { ...env };
    for (const k of envScrub) delete childEnv[k];
    Object.assign(childEnv, envSet);
    this._pty = pty.spawn(command, args, { name: 'xterm-256color', cols, rows, cwd, env: childEnv });
    this._pty.onData(d => {
      const b = Buffer.from(d, 'utf8');
      this._ring = Buffer.concat([this._ring, b]);
      if (this._ring.length > this._ringBytes) this._ring = this._ring.subarray(this._ring.length - this._ringBytes);
      this.emit('data', d);
    });
    this._pty.onExit(e => { this.alive = false; this.exitInfo = { exitCode: e.exitCode, signal: e.signal }; this.emit('exit', { exitCode: e.exitCode, signal: e.signal }); });
  }
  write(data) { if (this.alive) this._pty.write(data); }
  resize(cols, rows) { if (this.alive) { try { this._pty.resize(cols, rows); } catch { /* ignore */ } } }
  kill() { if (this.alive) { try { this._pty.kill(); } catch { /* ignore */ } } }
  scrollback() { return this._ring.toString('utf8'); }
}
