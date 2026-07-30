import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runHeadlessClaudeTurn } from '../src/facade/headlessClaudeRunner.js';

const STUB = path.resolve('scripts/helpers/claude-stub.mjs');
const profile = { command: STUB, args: [], envScrub: [], cwd: process.cwd() };

test('first turn: init session id, streamed deltas, result text, REAL usage', async () => {
  const deltas = [];
  const out = await runHeadlessClaudeTurn({ profile, resumeSessionId: null, userText: 'hello', emit: (e) => deltas.push(e.text), timeoutMs: 5000 });
  assert.equal(out.text, 'turn 1 reply to: hello');
  assert.equal(out.resumeSessionId, 'stub-1');
  assert.deepEqual(out.usage, { input: 42, output: 7, estimated: false });
  assert.equal(deltas.join(''), out.text);
});

test('resume chains the session id', async () => {
  const out = await runHeadlessClaudeTurn({ profile, resumeSessionId: 'stub-1', userText: 'again', emit: () => {}, timeoutMs: 5000 });
  assert.equal(out.text, 'turn 2 reply to: again');
  assert.equal(out.resumeSessionId, 'stub-2');
});

test('seed text is prepended; the reply answers the trailing user line', async () => {
  const out = await runHeadlessClaudeTurn({ profile, resumeSessionId: null, userText: 'the question', seedText: 'ctx a\nctx b', emit: () => {}, timeoutMs: 5000 });
  assert.equal(out.text, 'turn 1 reply to: the question');
});

test('rejected --resume fails provider-shaped with stderr captured', async () => {
  await assert.rejects(
    () => runHeadlessClaudeTurn({ profile, resumeSessionId: 'bogus', userText: 'x', emit: () => {}, timeoutMs: 5000 }),
    (e) => e.status === 500 && e.kind === 'api_error' && /No conversation found/.test(e.bridge.stderr));
});

test('nonzero exit fails provider-shaped', async () => {
  await assert.rejects(
    () => runHeadlessClaudeTurn({ profile, resumeSessionId: null, userText: 'please CRASH now', emit: () => {}, timeoutMs: 5000 }),
    (e) => e.status === 500 && /exited with code 1/.test(e.message));
});

test('timeout kills the child and fails 504', async () => {
  await assert.rejects(
    () => runHeadlessClaudeTurn({ profile, resumeSessionId: null, userText: 'please HANG forever', emit: () => {}, timeoutMs: 300 }),
    (e) => e.status === 504 && e.kind === 'timeout');
});
