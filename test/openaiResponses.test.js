import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';
import { createFacade } from '../src/facade/index.js';
import { readSse } from '../scripts/helpers/sse.mjs';

const REPL = path.resolve('scripts/helpers/fake-repl.sh');

function boot(extraEnv = {}) {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '200', PROMPT_TIMEOUT_MS: '8000', ...extraEnv,
  });
  const manager = new SessionManager(config);
  const facade = createFacade(config, manager);
  const server = createHttpServer(config, manager, facade);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    config, manager, facade, server, port: server.address().port,
    close() { facade.close(); for (const r of manager.list()) manager.remove(r.id); server.close(); },
  })));
}
const url = (port, p) => `http://127.0.0.1:${port}${p}`;
const H = { authorization: 'Bearer tok', 'content-type': 'application/json' };
const post = (port, p, body, headers = {}) => fetch(url(port, p), { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify(body) });

test('non-streaming response: shape, string input, instructions as system', async () => {
  const b = await boot();
  const r = await post(b.port, '/v1/responses', { model: 'generic', input: 'hello', instructions: 'be terse' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.id, /^resp_/);
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  assert.equal(body.output[0].type, 'message');
  assert.equal(body.output[0].content[0].type, 'output_text');
  assert.match(body.output[0].content[0].text, /reply 1 to: hello/);
  assert.equal(body.usage.total_tokens, body.usage.input_tokens + body.usage.output_tokens);
  b.close();
});

test('previous_response_id continues the conversation; unknown id 404s', async () => {
  const b = await boot();
  const r1 = await (await post(b.port, '/v1/responses', { model: 'generic', input: 'one' })).json();
  const r2 = await (await post(b.port, '/v1/responses', { model: 'generic', input: 'two', previous_response_id: r1.id })).json();
  assert.match(r2.output[0].content[0].text, /reply 2 to: two/, 'same session — only the new input forwarded');
  assert.equal(r2.previous_response_id, r1.id);
  const r3 = await post(b.port, '/v1/responses', { model: 'generic', input: 'x', previous_response_id: 'resp_nope' });
  assert.equal(r3.status, 404);
  assert.equal((await r3.json()).error.type, 'invalid_request_error');
  b.close();
});

test('streaming: exact minimum event sequence with sequence numbers', async () => {
  const b = await boot();
  const r = await post(b.port, '/v1/responses', { model: 'generic', input: 'hello', stream: true });
  assert.equal(r.status, 200);
  const frames = await readSse(r);
  const types = frames.map((f) => f.event);
  assert.deepEqual(types.slice(0, 4), ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added']);
  assert.ok(types.includes('response.output_text.delta'));
  const tail = types.slice(types.indexOf('response.output_text.done'));
  assert.deepEqual(tail, ['response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed']);
  const seqs = frames.map((f) => JSON.parse(f.data).sequence_number);
  assert.deepEqual(seqs, seqs.map((_, i) => i), 'sequence_number is 0..n monotonic');
  const deltas = frames.filter((f) => f.event === 'response.output_text.delta').map((f) => JSON.parse(f.data).delta).join('');
  const final = JSON.parse(frames.at(-1).data).response;
  assert.equal(final.status, 'completed');
  assert.equal(deltas, final.output[0].content[0].text);
  assert.match(final.id, /^resp_/);
  b.close();
});

test('array input with parts; trailing non-user item 400s; non-message item 400s', async () => {
  const b = await boot();
  const ok = await post(b.port, '/v1/responses', { model: 'generic', input: [
    { role: 'user', content: [{ type: 'input_text', text: 'part one' }] },
  ] });
  assert.equal(ok.status, 200);
  const bad1 = await post(b.port, '/v1/responses', { model: 'generic', input: [
    { role: 'user', content: 'x' }, { role: 'assistant', content: 'y' },
  ] });
  assert.equal(bad1.status, 400);
  const bad2 = await post(b.port, '/v1/responses', { model: 'generic', input: [{ type: 'function_call', name: 'f' }] });
  assert.equal(bad2.status, 400);
  b.close();
});

test('streamed responses also register their id for later continuity', async () => {
  const b = await boot();
  const r = await post(b.port, '/v1/responses', { model: 'generic', input: 'first', stream: true });
  const frames = await readSse(r);
  const rid = JSON.parse(frames.at(-1).data).response.id;
  const r2 = await (await post(b.port, '/v1/responses', { model: 'generic', input: 'second', previous_response_id: rid })).json();
  assert.match(r2.output[0].content[0].text, /reply 2 to: second/);
  b.close();
});
