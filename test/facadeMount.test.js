import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';
import { createFacade } from '../src/facade/index.js';

function boot(extraEnv = {}) {
  const config = loadConfig({ BRIDGE_TOKEN: 'tok', PROFILE_GENERIC_COMMAND: 'bash', ...extraEnv });
  const manager = new SessionManager(config);
  const facade = createFacade(config, manager);
  const server = createHttpServer(config, manager, facade);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    config, manager, facade, server, port: server.address().port,
    close() { facade.close(); for (const r of manager.list()) manager.remove(r.id); server.close(); },
  })));
}
const url = (port, path) => `http://127.0.0.1:${port}${path}`;

test('GET /v1/models: 401 without token is OpenAI-shaped', async () => {
  const b = await boot();
  const r = await fetch(url(b.port, '/v1/models'));
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.error.code, 'invalid_api_key');
  assert.equal(body.error.type, 'invalid_request_error');
  b.close();
});

test('GET /v1/models lists facade-usable profiles (command resolves), incl. claude-headless + copilot-headless', async () => {
  const b = await boot();
  const r = await fetch(url(b.port, '/v1/models'), { headers: { authorization: 'Bearer tok' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.object, 'list');
  const ids = body.data.map((m) => m.id).sort();
  // all built-ins have commands here (generic got one via PROFILE_GENERIC_COMMAND)
  assert.deepEqual(ids, ['antigravity', 'claude', 'claude-headless', 'codex', 'copilot', 'copilot-headless', 'generic']);
  for (const m of body.data) { assert.equal(m.object, 'model'); assert.equal(m.owned_by, 'bridge'); assert.ok(m.created > 0); }
  b.close();
});

test('command-less generic is absent from /v1/models', async () => {
  const b = await boot({ PROFILE_GENERIC_COMMAND: '' });
  const r = await fetch(url(b.port, '/v1/models'), { headers: { authorization: 'Bearer tok' } });
  const ids = (await r.json()).data.map((m) => m.id);
  assert.ok(!ids.includes('generic'), `generic should be hidden, got ${ids}`);
  b.close();
});

test('models endpoint 404s when both OpenAI-family dialects are disabled', async () => {
  const b = await boot({ FACADE_OPENAI_CHAT: '0', FACADE_OPENAI_RESPONSES: '0' });
  const r = await fetch(url(b.port, '/v1/models'), { headers: { authorization: 'Bearer tok' } });
  assert.equal(r.status, 404); // falls through to the bridge 404
  b.close();
});

test('facade routes do not shadow the bridge API', async () => {
  const b = await boot();
  const r = await fetch(url(b.port, '/api/sessions'), { headers: { authorization: 'Bearer tok' } });
  assert.equal(r.status, 200);
  b.close();
});
