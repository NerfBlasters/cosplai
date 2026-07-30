import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';

function boot() {
  const config = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]',
    BRIDGE_TOKEN: 'tok', QUIESCENCE_MS: '150', PROMPT_TIMEOUT_MS: '8000' });
  const manager = new SessionManager(config);
  const server = createHttpServer(config, manager);
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ config, manager, server, port: server.address().port })));
}
const url = (port, path) => `http://127.0.0.1:${port}${path}`;

test('GET / with token serves the terminal page', async () => {
  const { server, port } = await boot();
  const r = await fetch(url(port, '/?token=tok'));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  const body = await r.text();
  assert.ok(/id="t"/.test(body) || /xterm/.test(body));
  server.close();
});

test('GET / without token is unauthorized', async () => {
  const { server, port } = await boot();
  const r = await fetch(url(port, '/'));
  assert.equal(r.status, 401);
  server.close();
});

test('GET /vendor/xterm.js without token is public', async () => {
  const { server, port } = await boot();
  const r = await fetch(url(port, '/vendor/xterm.js'));
  assert.equal(r.status, 200);
  server.close();
});
