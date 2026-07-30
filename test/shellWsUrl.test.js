// public/index.html builds the WebSocket URL from attacker-supplyable query
// params (anyone can hand a user a crafted link to the shell). This runs the
// page's own inline script in a vm with stubbed browser globals and asserts
// the resulting socket URL can never leave this document's origin, and that
// junk params are dropped rather than forwarded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SHELL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');
const html = fs.readFileSync(SHELL, 'utf8');
// The two vendor tags carry src= attributes, so the bare <script> is the page's own.
const INLINE = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Returns the URL the page hands to `new WebSocket(...)` for a given query string.
function socketUrlFor(search, { protocol = 'http:', host = '127.0.0.1:7681' } = {}) {
  let captured = null;
  const sandbox = {
    URL, URLSearchParams,
    location: { search, protocol, host, href: `${protocol}//${host}/${search}` },
    document: { getElementById: () => ({}) },
    addEventListener: () => {},
    Terminal: class { loadAddon() {} open() {} onData() {} write() {} get cols() { return 80; } get rows() { return 24; } },
    FitAddon: { FitAddon: class { fit() {} activate() {} dispose() {} } },
    WebSocket: class { constructor(u) { captured = u; this.readyState = 0; } },
  };
  vm.runInNewContext(INLINE, sandbox);
  return new URL(captured);
}

test('a well-formed link produces a same-origin /ws URL with the params intact', () => {
  const u = socketUrlFor('?token=tok&session=abc123&profile=codex');
  assert.equal(u.protocol, 'ws:');
  assert.equal(u.host, '127.0.0.1:7681');
  assert.equal(u.pathname, '/ws');
  assert.equal(u.searchParams.get('token'), 'tok');
  assert.equal(u.searchParams.get('session'), 'abc123');
  // ?profile= is ignored when attaching to an existing session (matches wsApi).
  assert.equal(u.searchParams.get('profile'), null);
});

test('https documents upgrade the socket to wss', () => {
  const u = socketUrlFor('?token=tok', { protocol: 'https:', host: 'bridge.example:8443' });
  assert.equal(u.protocol, 'wss:');
  assert.equal(u.host, 'bridge.example:8443');
});

test('params cannot redirect the socket at another host, port, or path', () => {
  const hostile = [
    '?token=tok&session=' + encodeURIComponent('x&foo=bar'),
    '?token=tok&session=' + encodeURIComponent('../../evil'),
    '?token=tok&profile=' + encodeURIComponent('//evil.example/'),
    '?token=' + encodeURIComponent('a b#@evil.example/'),
    '?token=tok&profile=' + encodeURIComponent('x\r\nHost: evil.example'),
  ];
  for (const search of hostile) {
    const u = socketUrlFor(search);
    assert.equal(u.host, '127.0.0.1:7681', search);
    assert.equal(u.pathname, '/ws', search);
    assert.equal(u.protocol, 'ws:', search);
  }
});

test('session/profile failing the charset check are dropped, not forwarded', () => {
  const u = socketUrlFor('?token=tok&session=' + encodeURIComponent('has space'));
  assert.equal(u.searchParams.get('session'), null);
  // With no valid session, a valid profile does come through.
  const v = socketUrlFor('?token=tok&profile=' + encodeURIComponent('NOT-a-profile!'));
  assert.equal(v.searchParams.get('profile'), null);
  const w = socketUrlFor('?token=tok&profile=claude-headless');
  assert.equal(w.searchParams.get('profile'), 'claude-headless');
});

test('an over-long token is capped rather than passed through whole', () => {
  const u = socketUrlFor('?token=' + 'a'.repeat(9000));
  assert.equal(u.searchParams.get('token').length, 512);
});

test('the shell never string-concatenates location.host into the socket URL', () => {
  assert.doesNotMatch(INLINE, /\$\{[^}]*location\.host/);
  assert.match(INLINE, /new URL\('\/ws', location\.href\)/);
});
