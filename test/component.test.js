// End-to-end component test: exercises the full stack — SessionManager,
// StateDetector, TerminalModel, and the HTTP+SSE API — against a real PTY
// running `bash -i` under the `generic` adapter (no subscription usage; see
// README "Testing note"). Mirrors the boot helper pattern from
// test/httpApi.test.js (Task 8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';

function boot() {
  const config = loadConfig({
    ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]',
    BRIDGE_TOKEN: 'tok', QUIESCENCE_MS: '150',
  });
  const manager = new SessionManager(config);
  const server = createHttpServer(config, manager);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ config, manager, server, port: server.address().port })));
}
const url = (port, p) => `http://127.0.0.1:${port}${p}`;
const auth = { headers: { authorization: 'Bearer tok', 'content-type': 'application/json' } };

test('end-to-end: prompt over HTTP returns echoed output (bash/generic)', async () => {
  const { server, port, manager } = await boot();
  const c = await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' });
  assert.equal(c.status, 201);
  const { id } = await c.json();

  const r = await fetch(url(port, `/api/sessions/${id}/prompt`), {
    method: 'POST', ...auth, body: JSON.stringify({ text: 'echo COMPONENT_OK' }),
  });
  const b = await r.json();
  assert.match(b.output, /COMPONENT_OK/);
  assert.equal(b.state, 'idle');

  server.close();
  manager.remove(id);
});

test('end-to-end: SSE stream delivers state and output events for a prompt', async () => {
  const { server, port, manager } = await boot();
  const c = await fetch(url(port, '/api/sessions'), { method: 'POST', ...auth, body: '{}' });
  const { id } = await c.json();

  const ac = new AbortController();
  const evtRes = await fetch(url(port, `/api/sessions/${id}/events`), {
    headers: { authorization: 'Bearer tok' }, signal: ac.signal,
  });
  assert.equal(evtRes.status, 200);
  assert.match(evtRes.headers.get('content-type') || '', /text\/event-stream/);

  const reader = evtRes.body.getReader();
  const decoder = new TextDecoder();
  const seen = { state: false, output: false };
  let buf = '';

  const collectUntilBothSeen = (async () => {
    while (!(seen.state && seen.output)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        const evt = JSON.parse(dataLine.slice('data: '.length));
        if (evt.type === 'state') seen.state = true;
        if (evt.type === 'output') seen.output = true;
      }
    }
  })();

  const r = await fetch(url(port, `/api/sessions/${id}/prompt`), {
    method: 'POST', ...auth, body: JSON.stringify({ text: 'echo SSE_OK' }),
  });
  assert.equal(r.status, 200);

  await Promise.race([
    collectUntilBothSeen,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for SSE events')), 5000)),
  ]);

  assert.ok(seen.state, 'expected at least one SSE "state" event');
  assert.ok(seen.output, 'expected at least one SSE "output" event');

  ac.abort();
  server.close();
  manager.remove(id);
});
