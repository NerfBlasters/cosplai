import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';
import { createFacade } from '../src/facade/index.js';
import { readSse } from '../scripts/helpers/sse.mjs';

const REPL = path.resolve('scripts/helpers/fake-repl.sh');
const DIALOG_REPL = path.resolve('scripts/helpers/fake-dialog-repl.sh');

function boot(extraEnv = {}) {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '200', PROMPT_TIMEOUT_MS: '8000',
    PROFILE_CLAUDE_COMMAND: 'bash', PROFILE_CLAUDE_ARGS: JSON.stringify([DIALOG_REPL]),
    PROFILE_CLAUDE_DIALOG_POLICY: 'never', PROFILE_CLAUDE_QUIESCENCE_MS: '200', PROFILE_CLAUDE_CWD: process.cwd(),
    ...extraEnv,
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

test('dialog mid-turn → 409 with session id; POST /key answers; identical retry attaches', async () => {
  const b = await boot();
  const reqBody = { model: 'claude', messages: [{ role: 'user', content: 'DIALOG' }] };
  const r1 = await post(b.port, '/v1/chat/completions', reqBody);
  assert.equal(r1.status, 409);
  const e1 = await r1.json();
  assert.equal(e1.error.code, 'bridge_dialog_pending');
  assert.match(e1.bridge.dialog, /Quick safety check/);
  const sid = e1.bridge.session_id;
  assert.ok(sid);
  // still blocked → same dialog error on retry
  const r2 = await post(b.port, '/v1/chat/completions', reqBody);
  assert.equal(r2.status, 409);
  // operator answers through the EXISTING bridge API
  const k = await fetch(url(b.port, `/api/sessions/${sid}/key`), { method: 'POST', headers: H, body: JSON.stringify({ keys: ['enter'] }) });
  assert.equal(k.status, 200);
  await new Promise((r) => setTimeout(r, 600)); // let the detector settle idle
  // identical retry attaches to the pending turn and returns the extracted text
  const r3 = await post(b.port, '/v1/chat/completions', reqBody);
  assert.equal(r3.status, 200, JSON.stringify(await r3.clone().json().catch(() => null)));
  const done = await r3.json();
  assert.match(done.choices[0].message.content, /dialog answered/);
  b.close();
});

test('settle timeout → provider-shaped 504; conversation self-heals for the next request', async () => {
  const b = await boot({ PROMPT_TIMEOUT_MS: '400' });
  const r1 = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'SPAM' }] });
  assert.equal(r1.status, 504);
  const e1 = await r1.json();
  assert.equal(e1.error.type, 'api_error');
  assert.equal(e1.error.code, 'bridge_settle_timeout');
  // wait out the spam, then a fresh conversation on the SAME (suspect) session pool works
  await new Promise((r) => setTimeout(r, 2000));
  const r2 = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'recovered' }] });
  assert.equal(r2.status, 200);
  assert.match((await r2.json()).choices[0].message.content, /reply \d+ to: recovered/);
  b.close();
});

test('mid-stream failure framing: openai gets error frame + [DONE]; anthropic gets event:error', async () => {
  const b = await boot({ PROMPT_TIMEOUT_MS: '600' });
  const r = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'SPAM' }], stream: true });
  assert.equal(r.status, 200, 'status was already 200 when the stream started');
  const frames = await readSse(r);
  assert.equal(frames.at(-1).data, '[DONE]');
  const errFrame = JSON.parse(frames.at(-2).data);
  assert.equal(errFrame.error.type, 'api_error');
  const ra = await post(b.port, '/v1/messages', { model: 'generic', max_tokens: 5, stream: true, messages: [{ role: 'user', content: 'SPAM' }] }, { 'x-api-key': 'tok' });
  const aframes = await readSse(ra);
  assert.equal(aframes.at(-1).event, 'error');
  assert.equal(JSON.parse(aframes.at(-1).data).error.type, 'api_error');
  b.close();
});

test('client disconnect mid-stream: CLI finishes in background, session stays alive and idle', async () => {
  const b = await boot();
  const ac = new AbortController();
  const p = fetch(url(b.port, '/v1/chat/completions'), {
    method: 'POST', headers: H, signal: ac.signal,
    body: JSON.stringify({ model: 'generic', messages: [{ role: 'user', content: 'SPAM' }], stream: true }),
  });
  const resp = await p;
  const reader = resp.body.getReader();
  await reader.read(); // first chunk arrived — stream is live
  ac.abort();
  await new Promise((r) => setTimeout(r, 2500)); // spam finishes in background
  const sessions = b.manager.list();
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0].session.alive, 'no ESC-interrupt on disconnect');
  assert.equal(sessions[0].detector.state, 'idle');
  b.close();
});

test('session exited mid-turn → 500; next request transparently reseeds', async () => {
  const b = await boot();
  const r1 = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'EXIT' }] });
  assert.equal(r1.status, 500);
  const r2 = await post(b.port, '/v1/chat/completions', { model: 'generic', messages: [{ role: 'user', content: 'EXIT' }, { role: 'assistant', content: 'gone' }, { role: 'user', content: 'fresh' }] });
  assert.equal(r2.status, 200);
  assert.match((await r2.json()).choices[0].message.content, /reply \d+ to: fresh/);
  b.close();
});

test('listed model whose process fails to spawn → provider-shaped 500 api_error with the spawn error in bridge', async () => {
  // codex is enabled by default; point its command at a nonexistent binary.
  const b = await boot({ PROFILE_CODEX_COMMAND: '/nonexistent-cli-binary-xyz' });
  const m = await fetch(url(b.port, '/v1/models'), { headers: { authorization: 'Bearer tok' } });
  assert.ok((await m.json()).data.some((x) => x.id === 'codex'), 'still listed (command is set, just broken)');
  const r = await post(b.port, '/v1/chat/completions', { model: 'codex', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 500);
  const e = await r.json();
  assert.equal(e.error.type, 'api_error');
  // On Linux node-pty spawns then the child exec-fails asynchronously, writing
  // an exec diagnostic to the PTY. The runner reads it from the raw ring buffer
  // and surfaces it as a spawn error with the exit code — a mistyped
  // PROFILE_<NAME>_COMMAND is diagnosable, not an opaque 500.
  assert.ok(e.bridge, `bridge field present: ${JSON.stringify(e)}`);
  assert.match(e.bridge.spawn_error, /execvp|no such file/i, `spawn diagnostic: ${JSON.stringify(e.bridge)}`);
  assert.equal(e.bridge.reason, 'session_exited');
  assert.equal(typeof e.bridge.exit_code, 'number');
  b.close();
});

test('a synchronous spawn failure is reported as 500 api_error with bridge.spawn_error', async () => {
  // Deterministic, platform-independent coverage of router._create's spawn
  // catch: a manager whose create() throws (as node-pty does on platforms that
  // validate before fork) must surface as a provider-shaped 500 carrying the
  // spawn error in the bridge vendor field (spec: Models).
  const { loadConfig } = await import('../src/config.js');
  const { ConversationRouter } = await import('../src/facade/router.js');
  const config = loadConfig({ BRIDGE_TOKEN: 'tok', PROFILE_GENERIC_COMMAND: 'bash' });
  const manager = { create() { throw new Error('cwd does not exist'); }, get() {}, remove() { return false; }, list() { return []; } };
  const router = new ConversationRouter({ config, manager });
  try {
    router.executeTurn({ profileName: 'generic', messages: [{ role: 'user', text: 'x' }], timeoutMs: 1000 });
    assert.fail('expected a synchronous FacadeError');
  } catch (err) {
    assert.equal(err.status, 500);
    assert.equal(err.kind, 'api_error');
    assert.ok(err.bridge && err.bridge.spawn_error, `spawn_error missing: ${JSON.stringify(err.bridge)}`);
    assert.match(err.bridge.spawn_error, /cwd does not exist/);
  } finally {
    router.close();
  }
});
