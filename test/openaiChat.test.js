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

test('non-streaming completion: shape, estimated usage, bridge flag', async () => {
  const b = await boot();
  const r = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.id, /^chatcmpl-/);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, 'generic');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.match(body.choices[0].message.content, /reply 1 to: hello/);
  assert.equal(body.usage.total_tokens, body.usage.prompt_tokens + body.usage.completion_tokens);
  assert.deepEqual(body.bridge, { usage_estimated: true });
  b.close();
});

test('multi-turn fingerprint stickiness reuses the session', async () => {
  const b = await boot();
  const r1 = await (await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'hello' }] })).json();
  const text1 = r1.choices[0].message.content;
  const r2 = await (await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [
    { role: 'user', content: 'hello' }, { role: 'assistant', content: text1 }, { role: 'user', content: 'again' },
  ] })).json();
  assert.match(r2.choices[0].message.content, /reply 2 to: again/, 'counter continued — same session');
  assert.equal(b.manager.list().length, 1);
  b.close();
});

test('streaming: role chunk, content deltas, stop chunk, [DONE]; concat matches', async () => {
  const b = await boot();
  const r = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'PARA' }], stream: true, stream_options: { include_usage: true } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const frames = await readSse(r);
  assert.equal(frames.at(-1).data, '[DONE]');
  const chunks = frames.slice(0, -1).map((f) => JSON.parse(f.data));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  const content = chunks.map((c) => c.choices[0]?.delta?.content || '').join('');
  assert.match(content, /first paragraph\n\nsecond paragraph/);
  const stop = chunks.find((c) => c.choices[0]?.finish_reason === 'stop');
  assert.ok(stop, 'finish_reason stop chunk present');
  const usageChunk = chunks.find((c) => c.usage);
  assert.ok(usageChunk, 'include_usage chunk present');
  assert.deepEqual(usageChunk.choices, []);
  b.close();
});

test('explicit pin via model suffix; header wins over suffix', async () => {
  const b = await boot();
  const r1 = await (await post(b.port, '/v1/chat/completions', { model: 'generic#alpha', messages: [{ role: 'user', content: 'one' }] })).json();
  assert.match(r1.choices[0].message.content, /reply 1 to: one/);
  assert.equal(r1.model, 'generic#alpha', 'model echoed as requested');
  // no history at all — the pin alone routes to the same session
  const r2 = await (await post(b.port, '/v1/chat/completions', { model: 'generic#alpha', messages: [{ role: 'user', content: 'two' }] })).json();
  assert.match(r2.choices[0].message.content, /reply 2 to: two/);
  // header pin 'beta' overrides the suffix 'alpha' → different (new) conversation
  const r3 = await (await post(b.port, '/v1/chat/completions', { model: 'generic#alpha', messages: [{ role: 'user', content: 'three' }] },
    { 'x-bridge-conversation': 'beta' })).json();
  assert.match(r3.choices[0].message.content, /reply 1 to: three/);
  b.close();
});

test('validation 400s are OpenAI-shaped', async () => {
  const b = await boot();
  for (const [body, re] of [
    [{ messages: [{ role: 'user', content: 'x' }] }, /model/],
    [{ model: 'generic', messages: [] }, /messages/],
    [{ model: 'generic', messages: [{ role: 'user', content: 'x' }], n: 2 }, /n=1/],
    [{ model: 'generic', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }, /text content parts/],
    [{ model: 'generic', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }, /final message/],
  ]) {
    const r = await post(b.port, '/v1/chat/completions', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    const e = await r.json();
    assert.equal(e.error.type, 'invalid_request_error');
    assert.match(e.error.message, re);
  }
  b.close();
});

test('unknown model → 404 model_not_found', async () => {
  const b = await boot();
  const r = await post(b.port, '/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 404);
  const e = await r.json();
  assert.equal(e.error.code, 'model_not_found');
  b.close();
});

test('disabled chat dialect 404s while models stays up', async () => {
  const b = await boot({ FACADE_OPENAI_CHAT: '0' });
  const r = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 404);
  const m = await fetch(url(b.port, '/v1/models'), { headers: { authorization: 'Bearer tok' } });
  assert.equal(m.status, 200);
  b.close();
});
