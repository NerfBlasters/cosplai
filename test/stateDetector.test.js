import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StateDetector } from '../src/stateDetector.js';
import { TerminalModel } from '../src/terminalModel.js';
import { generic } from '../src/adapters/generic.js';

function fakeSession() { const s = new EventEmitter(); s.alive = true; return s; }

test('goes busy on data then idle after quiescence (generic)', async () => {
  const session = fakeSession();
  const tm = new TerminalModel({ cols: 80, rows: 24, scrollback: 500 });
  const d = new StateDetector({ session, terminalModel: tm, adapter: generic, quiescenceMs: 50 });
  const settle = d.waitForSettle({ timeoutMs: 2000 });
  session.emit('data', 'hello');
  tm.write('hello');
  assert.equal(d.state, 'busy');
  const s = await settle;
  assert.equal(s, 'idle');
  assert.equal(d.state, 'idle');
});

test('waitForSettle rejects on exit', async () => {
  const session = fakeSession();
  const tm = new TerminalModel({ cols: 80, rows: 24, scrollback: 500 });
  const d = new StateDetector({ session, terminalModel: tm, adapter: generic, quiescenceMs: 50 });
  const settle = d.waitForSettle({ timeoutMs: 2000 });
  session.emit('exit', { exitCode: 0 });
  await assert.rejects(() => settle);
});

// ---- Phase 1: isBusy gate + periodic evaluation + dialog handler ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmOf = (tailRef) => ({ viewportTail: () => tailRef.value });

test('quiet + isBusy stays busy, then settles when isBusy clears', async () => {
  const tailRef = { value: ['working…'] };
  const session = fakeSession();
  let busy = true;
  const adapter = { isIdle: () => true, isAwaitingInput: () => false, isBusy: () => busy };
  const d = new StateDetector({ session, terminalModel: tmOf(tailRef), adapter, quiescenceMs: 40 });
  session.emit('data');
  await sleep(120); // quiet ticks elapse while isBusy is true
  assert.equal(d.state, 'busy');
  busy = false;
  await sleep(150); // markers now read idle ⇒ settles
  assert.equal(d.state, 'idle');
  session.emit('exit');
});

test('periodic evaluation reaches idle despite continuous output when markers say idle', async () => {
  const tailRef = { value: ['❯ ', 'ready'] };
  const session = fakeSession();
  const adapter = { isIdle: () => true, isAwaitingInput: () => false, isBusy: () => false };
  const d = new StateDetector({ session, terminalModel: tmOf(tailRef), adapter, quiescenceMs: 50 });
  const iv = setInterval(() => session.emit('data'), 20); // repaints, quiescence never fires
  await sleep(200);
  clearInterval(iv);
  assert.equal(d.state, 'idle', 'periodic ticks should classify idle during sustained output');
  session.emit('exit');
});

test('adapters without isBusy keep pure-quiescence behavior (no periodic interval)', async () => {
  const tailRef = { value: ['x'] };
  const session = fakeSession();
  const adapter = { isIdle: () => false, isAwaitingInput: () => false };
  const d = new StateDetector({ session, terminalModel: tmOf(tailRef), adapter, quiescenceMs: 30 });
  const iv = setInterval(() => session.emit('data'), 10);
  await sleep(120);
  clearInterval(iv);
  assert.equal(d.state, 'busy'); // no periodic path; output never went quiet
  session.emit('exit');
});

test('markBusy resets the consecutive-idle-tick counter and re-phases the interval', async () => {
  const tailRef = { value: ['ready'] };
  const session = fakeSession();
  const adapter = { isIdle: () => true, isAwaitingInput: () => false, isBusy: () => false };
  const d = new StateDetector({ session, terminalModel: tmOf(tailRef), adapter, quiescenceMs: 60 });
  const iv = setInterval(() => session.emit('data'), 20);
  await sleep(70);        // ~1 tick accumulated
  d.markBusy();           // reset — needs 2 fresh ticks from here
  await sleep(70);        // only ~1 tick since reset
  assert.equal(d.state, 'busy');
  await sleep(80);        // 2nd consecutive tick since reset
  clearInterval(iv);
  assert.equal(d.state, 'idle');
  session.emit('exit');
});

test('dialogHandler that consumes a dialog keeps the session busy (no awaiting_input leak)', async () => {
  const tailRef = { value: ['Trust this folder?'] };
  const session = fakeSession();
  const adapter = { isIdle: () => false, isAwaitingInput: () => /Trust/.test(tailRef.value.join('')), isBusy: () => false };
  let answered = 0;
  const d = new StateDetector({
    session, terminalModel: tmOf(tailRef), adapter, quiescenceMs: 30,
    dialogHandler: () => { answered += 1; return true; }, // pretend to answer
  });
  const settle = d.waitForSettle({ timeoutMs: 500 });
  session.emit('data');
  await sleep(90);                 // a couple of quiescence evaluations
  assert.ok(answered >= 1, 'handler should be consulted');
  assert.equal(d.state, 'busy', 'consumed dialog must not surface as awaiting_input');
  tailRef.value = ['done']; adapter.isIdle = () => true; // dialog dismissed, now idle
  const s = await settle;
  assert.equal(s, 'idle');
  session.emit('exit');
});

test('dialogHandler that declines lets the dialog surface as awaiting_input', async () => {
  const tailRef = { value: ['Some modal'] };
  const session = fakeSession();
  const adapter = { isIdle: () => false, isAwaitingInput: () => true, isBusy: () => false };
  const d = new StateDetector({
    session, terminalModel: tmOf(tailRef), adapter, quiescenceMs: 30,
    dialogHandler: () => false, // policy declines
  });
  const s = await d.waitForSettle({ timeoutMs: 500 });
  assert.equal(s, 'awaiting_input');
  session.emit('exit');
});
