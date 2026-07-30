import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FacadeError, errorBody, AsyncQueue, flattenContent, estTokens, usageOpenaiChat, usageResponses, usageAnthropic } from '../src/facade/shared.js';

test('errorBody: openai shape', () => {
  const e = new FacadeError(404, 'model_not_found', 'nope');
  assert.deepEqual(errorBody('openai', e), {
    error: { message: 'nope', type: 'invalid_request_error', param: null, code: 'model_not_found' },
  });
});

test('errorBody: anthropic shape with bridge vendor field', () => {
  const e = new FacadeError(409, 'dialog', 'answer the dialog', { conversation_id: 'c1', session_id: 's1', dialog: 'Trust?' });
  assert.deepEqual(errorBody('anthropic', e), {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'answer the dialog' },
    bridge: { conversation_id: 'c1', session_id: 's1', dialog: 'Trust?' },
  });
});

test('errorBody: auth maps per family', () => {
  const e = new FacadeError(401, 'auth', 'bad key');
  assert.equal(errorBody('openai', e).error.code, 'invalid_api_key');
  assert.equal(errorBody('anthropic', e).error.type, 'authentication_error');
});

test('AsyncQueue: yields pushed values then ends', async () => {
  const q = new AsyncQueue();
  q.push(1); q.push(2);
  setTimeout(() => { q.push(3); q.end(); }, 10);
  const got = [];
  for await (const v of q) got.push(v);
  assert.deepEqual(got, [1, 2, 3]);
});

test('AsyncQueue: fail() drains buffered values first, then throws', async () => {
  const q = new AsyncQueue();
  q.push('a');
  q.fail(new Error('boom'));
  const got = [];
  await assert.rejects(async () => { for await (const v of q) got.push(v); }, /boom/);
  assert.deepEqual(got, ['a']);
});

test('AsyncQueue: push after end/fail is ignored', async () => {
  const q = new AsyncQueue();
  q.end(); q.push('late');
  const got = [];
  for await (const v of q) got.push(v);
  assert.deepEqual(got, []);
});

test('flattenContent: string, text parts, input_text parts', () => {
  assert.equal(flattenContent('hi', 'x'), 'hi');
  assert.equal(flattenContent([{ type: 'text', text: 'a' }, { type: 'input_text', text: 'b' }], 'x'), 'ab');
  assert.equal(flattenContent(null, 'x'), '');
});

test('flattenContent: non-text part throws provider-shaped 400', () => {
  assert.throws(() => flattenContent([{ type: 'image_url', image_url: { url: 'http://x' } }], 'messages[0].content'),
    (e) => e instanceof FacadeError && e.status === 400 && /messages\[0\]\.content\[0\]/.test(e.message));
});

test('usage mappers', () => {
  const u = { input: 10, output: 5, estimated: true };
  assert.deepEqual(usageOpenaiChat(u), { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.deepEqual(usageAnthropic(u), { input_tokens: 10, output_tokens: 5 });
  assert.equal(usageResponses(u).total_tokens, 15);
  assert.equal(estTokens(9), 3);
  assert.equal(estTokens(0), 1);
});
