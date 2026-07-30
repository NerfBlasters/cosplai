import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writePromptText, writeAndSubmitPrompt, SUBMIT_DELAY_MS, MultilineUnsupportedError } from '../src/promptWriter.js';

const fakeSession = () => { const w = []; return { writes: w, write: (d) => w.push(d) }; };

test('writeAndSubmitPrompt: submit keystroke is a separate, delayed write', async () => {
  // Codex 0.134.0, observed live 2026-07-24: text and \r delivered in the
  // same write burst are intermittently treated as one pasted blob — the \r
  // becomes a composer newline instead of a submit and the prompt strands
  // unsent (0 tokens in/out). A short gap between the text write and the
  // submit write makes the TUI process them as type-then-Enter.
  const stamped = [];
  const session = { write: (d) => stamped.push({ d, t: Date.now() }) };
  const adapter = { keySeq: (n) => (n === 'submit' ? '\r' : n) };
  await writeAndSubmitPrompt(session, adapter, 'hello');
  assert.deepEqual(stamped.map((w) => w.d), ['hello', '\r']);
  const gap = stamped[1].t - stamped[0].t;
  assert.ok(gap >= SUBMIT_DELAY_MS - 10, `submit must be delayed; gap was ${gap}ms`);
});

test('writeAndSubmitPrompt: submit=false writes only the text', async () => {
  const s = fakeSession();
  await writeAndSubmitPrompt(s, { keySeq: () => '\r' }, 'hello', false);
  assert.deepEqual(s.writes, ['hello']);
});

test('single-line text writes verbatim regardless of adapter', () => {
  const s = fakeSession();
  writePromptText(s, {}, 'hello');
  assert.deepEqual(s.writes, ['hello']);
});

test('multiline wraps in bracketed paste by default', () => {
  const s = fakeSession();
  writePromptText(s, {}, 'a\nb');
  assert.deepEqual(s.writes, ['\x1b[200~a\nb\x1b[201~']);
});

test('multiline raw passes through unchanged', () => {
  const s = fakeSession();
  writePromptText(s, { multiline: 'raw' }, 'a\nb');
  assert.deepEqual(s.writes, ['a\nb']);
});

test('paste opt-out with newlineKey joins lines with the key sequence', () => {
  const s = fakeSession();
  writePromptText(s, { supportsBracketedPaste: false, newlineKey: '\x1b\r' }, 'a\nb\nc');
  assert.deepEqual(s.writes, ['a\x1b\rb\x1b\rc']);
});

test('paste opt-out without newlineKey throws MultilineUnsupportedError', () => {
  const s = fakeSession();
  assert.throws(() => writePromptText(s, { supportsBracketedPaste: false }, 'a\nb'), MultilineUnsupportedError);
  assert.deepEqual(s.writes, []); // nothing partial written
});
