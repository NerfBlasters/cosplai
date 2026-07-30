import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { attachWss } from '../src/wsApi.js';
import { createHttpServer } from '../src/httpApi.js';

test('ws relays pty output for a bash session', async () => {
  const config = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]', BRIDGE_TOKEN: 'tok' });
  const manager = new SessionManager(config);
  const server = http.createServer((_q, s) => s.end());
  attachWss(server, config, manager);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const rec = manager.create();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok&session=${rec.id}`);
  let got = '';
  ws.on('message', m => { got += m.toString(); });
  await new Promise(r => ws.on('open', r));
  ws.send('echo relayed-ok\n');
  await new Promise(r => setTimeout(r, 400));
  assert.match(got, /relayed-ok/);
  ws.close(); server.close(); manager.remove(rec.id);
});

test('ws rejects bad token', async () => {
  const config = loadConfig({ BRIDGE_TOKEN: 'tok' });
  const manager = new SessionManager(config);
  const server = http.createServer((_q, s) => s.end());
  attachWss(server, config, manager);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=WRONG`);
  const closed = await new Promise(r => { ws.on('close', c => r(c)); ws.on('error', () => {}); });
  assert.ok(closed);
  server.close();
});

test('resize control frame calls session.resize and is not written as keystrokes', async () => {
  const config = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]', BRIDGE_TOKEN: 'tok' });
  const manager = new SessionManager(config);
  const server = http.createServer((_q, s) => s.end());
  attachWss(server, config, manager);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const rec = manager.create();
  const resizeCalls = []; const writes = []; const modelResizeCalls = [];
  const origResize = rec.session.resize.bind(rec.session);
  rec.session.resize = (c, r) => { resizeCalls.push([c, r]); return origResize(c, r); };
  const origWrite = rec.session.write.bind(rec.session);
  rec.session.write = (d) => { writes.push(d); return origWrite(d); };
  const origModelResize = rec.terminalModel.resize.bind(rec.terminalModel);
  rec.terminalModel.resize = (c, r) => { modelResizeCalls.push([c, r]); return origModelResize(c, r); };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok&session=${rec.id}`);
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'resize', cols: 55, rows: 15 }));
  await new Promise(r => setTimeout(r, 150));
  assert.deepEqual(resizeCalls.at(-1), [55, 15]);
  assert.deepEqual(modelResizeCalls.at(-1), [55, 15], 'terminalModel.resize must be called in lockstep with session.resize');
  assert.ok(!writes.some(w => String(w).includes('resize')), 'resize frame must not be written as keystrokes');
  ws.close(); server.close(); manager.remove(rec.id);
});

test('unknown or missing session id falls back to create', async () => {
  const config = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]', BRIDGE_TOKEN: 'tok' });
  const manager = new SessionManager(config);
  const server = http.createServer((_q, s) => s.end());
  attachWss(server, config, manager);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  assert.equal(manager.list().length, 0);
  const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok&session=does-not-exist`);
  await new Promise(r => ws1.on('open', r));
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok`);
  await new Promise(r => ws2.on('open', r));
  await new Promise(r => setTimeout(r, 80));
  assert.equal(manager.list().length, 2, 'each unmatched connect creates a session');
  ws1.close(); ws2.close(); for (const rr of manager.list()) manager.remove(rr.id); server.close();
});

test('ws-created session is reaped when the socket closes', async () => {
  const config = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]', BRIDGE_TOKEN: 'tok' });
  const manager = new SessionManager(config);
  const server = http.createServer((_q, s) => s.end());
  attachWss(server, config, manager);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  assert.equal(manager.list().length, 0);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok`);
  await new Promise(r => ws.on('open', r));
  assert.equal(manager.list().length, 1);
  ws.close();
  await new Promise(r => setTimeout(r, 150));
  assert.equal(manager.list().length, 0, 'ws-created session should be reaped on close');
  server.close();
});

test('attaching to an existing session is NOT reaped on close', async () => {
  const config = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]', BRIDGE_TOKEN: 'tok' });
  const manager = new SessionManager(config);
  const server = http.createServer((_q, s) => s.end());
  attachWss(server, config, manager);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const rec = manager.create();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok&session=${rec.id}`);
  await new Promise(r => ws.on('open', r));
  ws.close();
  await new Promise(r => setTimeout(r, 150));
  assert.ok(manager.get(rec.id), 'API-owned session should survive the ws close');
  manager.remove(rec.id);
  server.close();
});

test('scrollback is sent before live data', async () => {
  const config = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'cat', CLAUDE_ARGS: '[]', BRIDGE_TOKEN: 'tok' });
  const manager = new SessionManager(config);
  const server = http.createServer((_q, s) => s.end());
  attachWss(server, config, manager);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const rec = manager.create();
  rec.session.write('PRESEED_MARK\n');
  await new Promise(r => setTimeout(r, 200));
  const chunks = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok&session=${rec.id}`);
  ws.on('message', m => chunks.push(m.toString()));
  await new Promise(r => ws.on('open', r));
  await new Promise(r => setTimeout(r, 80));
  assert.match(chunks[0] || '', /PRESEED_MARK/, 'first ws message is the scrollback');
  rec.session.write('LIVE_MARK\n');
  await new Promise(r => setTimeout(r, 200));
  const all = chunks.join('');
  assert.ok(all.indexOf('PRESEED_MARK') < all.indexOf('LIVE_MARK') && all.indexOf('LIVE_MARK') !== -1, 'scrollback precedes live');
  ws.close(); server.close(); manager.remove(rec.id);
});

// ---- Phase 1: profile param ----
// Boot a server whose DEFAULT profile is 'claude' (bash) but which ALSO enables
// 'generic' (bash) — so `?profile=generic` selecting a NON-default profile is a
// real, observable choice (not vacuously equal to the default).
function bootProfiles() {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', QUIESCENCE_MS: '120',
    DEFAULT_PROFILE: 'claude', PROFILE_CLAUDE_COMMAND: 'bash', PROFILE_CLAUDE_ARGS: '["-i"]',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: '["-i"]',
  });
  const manager = new SessionManager(config);
  const server = createHttpServer(config, manager); // real REST + static
  attachWss(server, config, manager);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ config, manager, server, port: server.address().port })));
}
const wsUrl = (port, qs) => `ws://127.0.0.1:${port}/ws?token=tok&${qs}`;

test('ws upgrade with unknown profile is rejected 400 pre-upgrade', async () => {
  const { server, port } = await bootProfiles();
  const status = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl(port, 'profile=nope'));
    ws.on('unexpected-response', (_req, res2) => resolve(res2.statusCode));
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => {}); // unexpected-response resolves first
  });
  assert.equal(status, 400);
  server.close();
});

test('ws upgrade with headless profile is rejected 400 pre-upgrade', async () => {
  const { server, port } = await bootProfiles();
  const status = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl(port, 'profile=claude-headless'));
    ws.on('unexpected-response', (_req, res2) => resolve(res2.statusCode));
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => {});
  });
  assert.equal(status, 400);
  server.close();
});

test('ws bare connection creates the DEFAULT profile; ?profile= selects a non-default one', async () => {
  const { server, port, manager } = await bootProfiles();
  // bare connection → default profile 'claude'
  const bare = new WebSocket(wsUrl(port, 'x=1'));
  await new Promise((resolve, reject) => { bare.on('open', resolve); bare.on('error', reject); });
  assert.ok(manager.list().some((r) => r.profile === 'claude'), 'bare connection uses DEFAULT_PROFILE');
  // ?profile=generic → the non-default profile actually applied
  const chosen = new WebSocket(wsUrl(port, 'profile=generic'));
  await new Promise((resolve, reject) => { chosen.on('open', resolve); chosen.on('error', reject); });
  assert.ok(manager.list().some((r) => r.profile === 'generic'), '?profile= applied at creation');
  bare.close(); chosen.close();
  await new Promise((r) => setTimeout(r, 300)); // ws-owned sessions reaped on close
  server.close();
});

test('ws attaching to an existing session ignores a conflicting profile param', async () => {
  const { server, port, manager } = await bootProfiles();
  const existing = manager.create({ profile: 'generic' }); // pre-existing session
  const ws = new WebSocket(wsUrl(port, `session=${existing.id}&profile=nope`));
  const opened = await new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('unexpected-response', () => resolve(false));
    ws.on('error', () => resolve(false));
  });
  assert.equal(opened, true); // attachment proceeds; ?profile= ignored, not validated
  assert.equal(manager.get(existing.id).profile, 'generic'); // unchanged
  ws.close(); manager.remove(existing.id); server.close();
});
