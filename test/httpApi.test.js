import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
const auth = { headers: { authorization: 'Bearer tok', 'content-type': 'application/json' } };

test('401 without token', async () => {
  const { server, port } = await boot();
  const r = await fetch(url(port, '/api/sessions'), { method: 'POST' });
  assert.equal(r.status, 401);
  server.close();
});

test('create session, prompt echoes output, delete', async () => {
  const { server, port, manager } = await boot();
  const c = await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' });
  assert.equal(c.status, 201);
  const { id } = await c.json();
  assert.ok(id);
  const p = await fetch(url(port, `/api/sessions/${id}/prompt`), { method: 'POST', ...auth,
    body: JSON.stringify({ text: 'echo hello-there' }) });
  assert.equal(p.status, 200);
  const body = await p.json();
  assert.equal(body.state, 'idle');
  assert.match(body.output, /hello-there/);
  const d = await fetch(url(port, `/api/sessions/${id}`), { method: 'DELETE', ...auth });
  assert.equal(d.status, 204);
  server.close();
});

test('two sequential prompts each return their own echoed output', async () => {
  const { server, port } = await boot();
  const A = { headers: { authorization: 'Bearer tok', 'content-type': 'application/json' } };
  const { id } = await (await fetch(url(port, '/api/sessions'), { method: 'POST', ...A, body: '{}' })).json();
  const p1 = await (await fetch(url(port, `/api/sessions/${id}/prompt`), { method: 'POST', ...A, body: JSON.stringify({ text: 'echo FIRST_XYZ' }) })).json();
  assert.match(p1.output, /FIRST_XYZ/);
  const p2 = await (await fetch(url(port, `/api/sessions/${id}/prompt`), { method: 'POST', ...A, body: JSON.stringify({ text: 'echo SECOND_XYZ' }) })).json();
  assert.match(p2.output, /SECOND_XYZ/, `p2.output was ${JSON.stringify(p2.output)}`);
  assert.ok(!/FIRST_XYZ/.test(p2.output), 'p2 must not echo p1 output');
  await fetch(url(port, `/api/sessions/${id}`), { method: 'DELETE', ...A });
  server.close();
});

test('oversized request body is rejected with 413', async () => {
  const { server, port } = await boot();
  const big = 'x'.repeat(1024 * 1024 + 10);
  const r = await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: big });
  assert.equal(r.status, 413);
  server.close();
});

test('key endpoint returns state', async () => {
  const { server, port } = await boot();
  const c = await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' });
  const { id } = await c.json();
  const k = await fetch(url(port, `/api/sessions/${id}/key`), { method: 'POST', ...auth,
    body: JSON.stringify({ keys: ['x', 'ctrl-c'] }) });
  assert.equal(k.status, 200);
  assert.ok((await k.json()).state);
  // Without this the bash -i child stays alive and its pty read stream
  // keeps the event loop (and `node --test`) from ever exiting.
  await fetch(url(port, `/api/sessions/${id}`), { method: 'DELETE', ...auth });
  server.close();
});

// ---- Phase 1: profiles + text field + multiline 400 ----

test('POST /api/sessions with unknown profile returns 400 listing valid profiles', async () => {
  const { server, port } = await boot();
  const r = await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: JSON.stringify({ profile: 'nope' }) });
  assert.equal(r.status, 400);
  const b = await r.json();
  assert.ok(Array.isArray(b.validProfiles) && b.validProfiles.length > 0);
  server.close();
});

test('POST /api/sessions with headless profile returns 400 with validProfiles', async () => {
  const { server, port } = await boot();
  const r = await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: JSON.stringify({ profile: 'claude-headless' }) });
  assert.equal(r.status, 400);
  const b = await r.json();
  assert.ok(Array.isArray(b.validProfiles) && b.validProfiles.length > 0); // all four profile-error codes carry validProfiles
  server.close();
});

test('session create/list/get responses carry the profile name', async () => {
  const { server, port } = await boot();
  const created = await (await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' })).json();
  assert.equal(created.profile, 'generic'); // boot() uses ADAPTER=generic
  const list = await (await fetch(url(port, '/api/sessions'), { headers: auth.headers })).json();
  assert.equal(list.sessions.find((s) => s.id === created.id).profile, 'generic');
  const one = await (await fetch(url(port, `/api/sessions/${created.id}`), { headers: auth.headers })).json();
  assert.equal(one.profile, 'generic');
  await fetch(url(port, `/api/sessions/${created.id}`), { method: 'DELETE', headers: auth.headers });
  server.close();
});

test('POST /prompt returns a cleaned text field alongside raw output', async () => {
  const { server, port } = await boot();
  const { id } = await (await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' })).json();
  const p = await fetch(url(port, `/api/sessions/${id}/prompt`), { method: 'POST', ...auth,
    body: JSON.stringify({ text: 'echo BRIDGE_TEXT_FIELD' }) });
  assert.equal(p.status, 200);
  const b = await p.json();
  assert.equal(typeof b.text, 'string');
  assert.ok(b.text.includes('BRIDGE_TEXT_FIELD'), `text was: ${JSON.stringify(b.text)}`);
  assert.notEqual(b.text, b.output); // generic extractResponse drops the echoed first line
  await fetch(url(port, `/api/sessions/${id}`), { method: 'DELETE', headers: auth.headers });
  server.close();
});

test('POST /prompt with multiline text on a no-paste/no-newlineKey adapter returns 400', async () => {
  // Exercises the MultilineUnsupportedError→400 mapping end-to-end. The generic
  // profile is multiline:'raw' (never rejects), so monkeypatch the created
  // record's adapter to the reject path (mirrors how test/wsApi.test.js patches
  // record members). manager is returned by boot().
  const { server, port, manager } = await boot();
  const { id } = await (await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' })).json();
  const rec = manager.get(id);
  rec.adapter = { ...rec.adapter, multiline: undefined, supportsBracketedPaste: false }; // no newlineKey → reject
  const p = await fetch(url(port, `/api/sessions/${id}/prompt`), { method: 'POST', ...auth,
    body: JSON.stringify({ text: 'line one\nline two' }) });
  assert.equal(p.status, 400);
  const b = await p.json();
  assert.match(String(b.error), /multiline/i);
  await fetch(url(port, `/api/sessions/${id}`), { method: 'DELETE', headers: auth.headers });
  server.close();
});

test('a timed-out /prompt flags the session; the next /prompt waits instead of interleaving', async () => {
  const REPL2 = path.resolve('scripts/helpers/fake-repl.sh');
  const config = loadConfig({ BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL2]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '200' });
  const manager = new SessionManager(config);
  const server = createHttpServer(config, manager);
  const port = await new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
  const { id } = await (await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' })).json();
  const p1 = await fetch(url(port, `/api/sessions/${id}/prompt`), { method: 'POST', ...auth,
    body: JSON.stringify({ text: 'SPAM', timeoutMs: 400 }) });
  assert.equal(p1.status, 504);
  const p2 = await (await fetch(url(port, `/api/sessions/${id}/prompt`), { method: 'POST', ...auth,
    body: JSON.stringify({ text: 'after' }) })).json();
  assert.match(p2.output, /after/);
  assert.ok(!/spam \d/.test(p2.output), `second prompt swallowed the first turn's output: ${JSON.stringify(p2.output)}`);
  await fetch(url(port, `/api/sessions/${id}`), { method: 'DELETE', ...auth });
  server.close();
});

test('POST /key waits on the session profile quiescence, not the global', async () => {
  // Global 400ms would make /key wait min(800,1000)=800ms; the generic
  // profile override of 50ms must make it wait min(100,1000)=100ms.
  const config = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]',
    BRIDGE_TOKEN: 'tok', QUIESCENCE_MS: '400', PROFILE_GENERIC_QUIESCENCE_MS: '50', PROMPT_TIMEOUT_MS: '8000' });
  const manager = new SessionManager(config);
  const server = createHttpServer(config, manager);
  const port = await new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
  const { id } = await (await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' })).json();
  const t0 = Date.now();
  const k = await fetch(url(port, `/api/sessions/${id}/key`), { method: 'POST', ...auth, body: JSON.stringify({ keys: ['x'] }) });
  assert.equal(k.status, 200);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0}ms — still using the global quiescence`);
  await fetch(url(port, `/api/sessions/${id}`), { method: 'DELETE', ...auth });
  server.close();
});
