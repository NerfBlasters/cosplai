// Response security headers (src/httpApi.js applySecurityHeaders / SHELL_CSP).
// Covers the scan findings this branch closes: the terminal shell's CSP is the
// browser-enforced backstop on the WebSocket URL it builds, and HSTS is
// emitted only on genuinely-TLS requests rather than uselessly on loopback
// plain HTTP (RFC 6797 §7.2).
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
    server, port: server.address().port,
    close() { facade.close(); for (const r of manager.list()) manager.remove(r.id); server.close(); },
  })));
}
const url = (port, path) => `http://127.0.0.1:${port}${path}`;

test('every response carries the baseline security headers', async () => {
  const b = await boot();
  for (const path of ['/?token=tok', '/vendor/xterm.css', '/api/sessions?token=tok', '/nope?token=tok']) {
    const r = await fetch(url(b.port, path));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', path);
  }
  b.close();
});

test('facade dialect routes inherit the baseline headers (incl. the 401)', async () => {
  const b = await boot();
  const r = await fetch(url(b.port, '/v1/messages'), { method: 'POST', body: '{}' });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  b.close();
});

test('the terminal shell ships a CSP that pins connect-src to same origin', async () => {
  const b = await boot();
  const r = await fetch(url(b.port, '/?token=tok'));
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
  b.close();
});

test('no HSTS on plain-HTTP requests (a UA would ignore it anyway)', async () => {
  const b = await boot();
  const r = await fetch(url(b.port, '/?token=tok'));
  assert.equal(r.headers.get('strict-transport-security'), null);
  b.close();
});

test('x-forwarded-proto: https is ignored unless BRIDGE_TRUST_PROXY is set', async () => {
  const b = await boot();
  const r = await fetch(url(b.port, '/?token=tok'), { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(r.headers.get('strict-transport-security'), null);
  b.close();
});

test('BRIDGE_TRUST_PROXY=1 + x-forwarded-proto: https emits HSTS', async () => {
  const b = await boot({ BRIDGE_TRUST_PROXY: '1' });
  const r = await fetch(url(b.port, '/?token=tok'), { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(r.headers.get('strict-transport-security') || '', /max-age=31536000/);
  // ...and still not for a proxied plain-HTTP hop.
  const plain = await fetch(url(b.port, '/?token=tok'), { headers: { 'x-forwarded-proto': 'http' } });
  assert.equal(plain.headers.get('strict-transport-security'), null);
  b.close();
});

test('a comma-joined x-forwarded-proto chain is read left-to-right', async () => {
  const b = await boot({ BRIDGE_TRUST_PROXY: '1' });
  const r = await fetch(url(b.port, '/?token=tok'), { headers: { 'x-forwarded-proto': 'https, http' } });
  assert.match(r.headers.get('strict-transport-security') || '', /max-age=/);
  b.close();
});
