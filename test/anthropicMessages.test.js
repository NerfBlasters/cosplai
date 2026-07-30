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
const post = (port, body, headers) => fetch(url(port, '/v1/messages'), {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('x-api-key auth works; missing auth is anthropic-shaped 401', async () => {
  const b = await boot();
  const ok = await post(b.port, { model: 'generic', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] },
    { 'x-api-key': 'tok' });
  assert.equal(ok.status, 200);
  const bad = await post(b.port, { model: 'generic', messages: [{ role: 'user', content: 'x' }] }, {});
  assert.equal(bad.status, 401);
  const e = await bad.json();
  assert.equal(e.type, 'error');
  assert.equal(e.error.type, 'authentication_error');
  b.close();
});

test('non-streaming message shape', async () => {
  const b = await boot();
  const r = await post(b.port, { model: 'generic', max_tokens: 50, messages: [{ role: 'user', content: 'ping' }] }, { 'x-api-key': 'tok' });
  const body = await r.json();
  assert.match(body.id, /^msg_/);
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.stop_reason, 'end_turn');
  assert.equal(body.content[0].type, 'text');
  assert.match(body.content[0].text, /reply \d+ to: ping/);
  assert.ok(body.usage.input_tokens >= 1 && body.usage.output_tokens >= 1);
  assert.deepEqual(body.bridge, { usage_estimated: true });
  b.close();
});

test('system param participates in continuity: same system+history sticks, changed system reseeds', async () => {
  const b = await boot();
  const mk = (msgs) => ({ model: 'generic', max_tokens: 50, system: 'be terse', messages: msgs });
  const r1 = await (await post(b.port, mk([{ role: 'user', content: 'one' }]), { 'x-api-key': 'tok' })).json();
  const t1 = r1.content[0].text;
  const r2 = await (await post(b.port, mk([
    { role: 'user', content: 'one' }, { role: 'assistant', content: t1 }, { role: 'user', content: 'two' },
  ]), { 'x-api-key': 'tok' })).json();
  assert.match(r2.content[0].text, /reply 2 to: two/, 'sticky with unchanged system');
  const r3 = await (await post(b.port, { model: 'generic', max_tokens: 50, system: 'DIFFERENT', messages: [
    { role: 'user', content: 'one' }, { role: 'assistant', content: t1 }, { role: 'user', content: 'three' },
  ] }, { 'x-api-key': 'tok' })).json();
  assert.ok(!/reply 3 to: three/.test(r3.content[0].text), 'changed system must reseed a fresh session');
  b.close();
});

test('assistant prefill rejected 400', async () => {
  const b = await boot();
  const r = await post(b.port, { model: 'generic', max_tokens: 50, messages: [
    { role: 'user', content: 'x' }, { role: 'assistant', content: 'The answer is' },
  ] }, { 'x-api-key': 'tok' });
  assert.equal(r.status, 400);
  const e = await r.json();
  assert.equal(e.error.type, 'invalid_request_error');
  assert.match(e.error.message, /prefill/);
  b.close();
});

test('streaming frame sequence', async () => {
  const b = await boot();
  const r = await post(b.port, { model: 'generic', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'PARA' }] }, { 'x-api-key': 'tok' });
  assert.equal(r.status, 200);
  const frames = await readSse(r);
  const types = frames.map((f) => f.event);
  assert.equal(types[0], 'message_start');
  assert.equal(types[1], 'content_block_start');
  assert.ok(types.includes('content_block_delta'));
  assert.deepEqual(types.slice(-3), ['content_block_stop', 'message_delta', 'message_stop']);
  const text = frames.filter((f) => f.event === 'content_block_delta').map((f) => JSON.parse(f.data).delta.text).join('');
  assert.match(text, /first paragraph\n\nsecond paragraph/);
  const md = JSON.parse(frames[types.indexOf('message_delta')].data);
  assert.equal(md.delta.stop_reason, 'end_turn');
  assert.ok(md.usage.output_tokens >= 1);
  b.close();
});

test('unknown model → anthropic not_found_error', async () => {
  const b = await boot();
  const r = await post(b.port, { model: 'claude-sonnet-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }, { 'x-api-key': 'tok' });
  assert.equal(r.status, 404);
  const e = await r.json();
  assert.equal(e.error.type, 'not_found_error');
  b.close();
});
