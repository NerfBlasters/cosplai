import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { runPtyTurn } from '../src/facade/turnRunner.js';

const REPL = path.resolve('scripts/helpers/fake-repl.sh');
const SLOW_REPL = path.resolve('scripts/helpers/fake-slow-start-repl.sh');

function boot(extraEnv = {}) {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '200', ...extraEnv,
  });
  const manager = new SessionManager(config);
  return { config, manager };
}

test('runPtyTurn: deltas + done text, estimated usage', async () => {
  const { manager } = boot();
  const rec = manager.create({});
  const deltas = [];
  const out = await runPtyTurn({ record: rec, userText: 'hello', emit: (e) => deltas.push(e.text), timeoutMs: 8000 });
  assert.match(out.text, /reply 1 to: hello/);
  assert.equal(out.usage.estimated, true);
  assert.ok(out.usage.input >= 1 && out.usage.output >= 1);
  assert.equal(deltas.join(''), out.text, 'delta concatenation reproduces done text');
  manager.remove(rec.id);
});

test('runPtyTurn: seedText is written before the user text in the same turn', async () => {
  const { manager } = boot();
  const rec = manager.create({});
  const out = await runPtyTurn({ record: rec, userText: 'real question', seedText: 'context line A\ncontext line B', emit: () => {}, timeoutMs: 8000 });
  // The seed + user text are written as one turn (the fake REPL models a
  // coalescing CLI: it treats the burst as a single prompt and replies once to
  // the last line). The PTY echoes the whole write, so a later seed line and
  // the user text both appear — in order — proving the multi-line seed reached
  // the process before the user text (production contract: full = seed +
  // '\n\n' + userText). ("context line A" is the echoed first line, which the
  // generic identity extractResponse drops by design, so we check line B.)
  const iB = out.text.indexOf('context line B');
  const iQ = out.text.indexOf('real question');
  assert.ok(iB >= 0 && iQ >= 0, `seed line + question present: ${JSON.stringify(out.text)}`);
  assert.ok(iB < iQ, 'the seed was written before the user text');
  assert.match(out.text, /reply 1 to: real question/);
  manager.remove(rec.id);
});

test('runPtyTurn: waits for startup settle before typing (slow-start CLI)', async () => {
  // Live-CLI failure mode (claude 2.1.218 / codex 0.134.0): the facade runs
  // the first turn immediately after spawn, while the CLI is still starting
  // up. The startup screen (trust dialog) consumes the buffered submit Enter,
  // stranding the prompt in the composer where neither the busy nor the idle
  // marker renders — the turn then never settles. The slow-start REPL models
  // exactly that: input typed before its idle footer first appears is
  // swallowed. The turn must still produce the reply, proving runPtyTurn
  // waited for a confirmed settle before its first keystroke.
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'claude',
    PROFILE_CLAUDE_COMMAND: 'bash', PROFILE_CLAUDE_ARGS: JSON.stringify([SLOW_REPL]),
    PROFILE_CLAUDE_CWD: process.cwd(), PROFILE_CLAUDE_QUIESCENCE_MS: '200',
  });
  const manager = new SessionManager(config);
  const rec = manager.create({});
  const out = await runPtyTurn({ record: rec, userText: 'hello', emit: () => {}, timeoutMs: 8000 });
  assert.match(out.text, /reply to: hello/);
  manager.remove(rec.id);
});

test('runPtyTurn: re-arms markBusy after the delayed submit, before waiting for settle', async () => {
  // The SUBMIT_DELAY_MS gap goes quiet after the text echo: a profile with
  // quiescenceMs <= the gap can evaluate and settle to idle before the \r
  // lands, and waitForSettle would resolve instantly with no reply. The
  // second markBusy (after the submit write) closes that window; this pins
  // the call order.
  const events = [];
  const record = {
    suspect: false,
    detector: {
      state: 'idle',
      markBusy: () => events.push('markBusy'),
      waitForSettle: async () => { events.push('waitForSettle'); return 'idle'; },
    },
    terminalModel: { snapshotLineCount: () => 0, renderLinesSince: () => ['ok'], viewportTail: () => [] },
    adapter: { keySeq: (n) => (n === 'submit' ? '\r' : n), extractResponse: (ls) => ls.join('\n') },
    session: { write: (d) => events.push(`write:${d}`) },
  };
  const out = await runPtyTurn({ record, userText: 'hello', emit: () => {}, timeoutMs: 1000 });
  assert.equal(out.text, 'ok');
  assert.deepEqual(events, ['markBusy', 'write:hello', 'write:\r', 'markBusy', 'waitForSettle']);
});

test('runPtyTurn: settle timeout flags the record suspect; next turn self-heals', async () => {
  const { manager } = boot();
  const rec = manager.create({});
  await assert.rejects(
    () => runPtyTurn({ record: rec, userText: 'SPAM', emit: () => {}, timeoutMs: 400 }),
    (e) => e.status === 504 && e.kind === 'timeout');
  assert.equal(rec.suspect, true);
  // next turn waits out the spam instead of typing into it
  const out = await runPtyTurn({ record: rec, userText: 'after', emit: () => {}, timeoutMs: 8000 });
  assert.equal(rec.suspect, false);
  assert.match(out.text, /reply \d+ to: after/);
  assert.ok(!/spam \d/.test(out.text), 'second turn must not swallow the first turn\'s spam');
  manager.remove(rec.id);
});

test('runPtyTurn: session exit mid-turn throws with sessionExited marker', async () => {
  const { manager } = boot();
  const rec = manager.create({});
  await assert.rejects(
    () => runPtyTurn({ record: rec, userText: 'EXIT', emit: () => {}, timeoutMs: 8000 }),
    (e) => e.status === 500 && e.sessionExited === true);
  manager.remove(rec.id);
});

test('runPtyTurn: dialog surfaced when session is awaiting_input at turn start', async () => {
  // Fake detector/record — no PTY needed to exercise the guard.
  const record = {
    suspect: false,
    detector: { state: 'awaiting_input' },
    terminalModel: { viewportTail: () => ['Quick safety check: trust?', '❯ 1. Yes'], snapshotLineCount: () => 42 },
    adapter: { describePrompt: (tail) => tail.join('\n') },
  };
  const out = await runPtyTurn({ record, userText: 'x', emit: () => {}, timeoutMs: 1000 });
  assert.ok(out.dialog);
  assert.match(out.dialog.promptText, /Quick safety check/);
  assert.equal(out.dialog.sinceIndex, 42);
});
