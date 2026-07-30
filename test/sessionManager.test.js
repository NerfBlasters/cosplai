import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SessionManager, makeDialogHandler } from '../src/sessionManager.js';

// Profile-resolution tests use bash via the generic profile: no real AI CLI,
// no subscription usage (same approach as test/component.test.js).
const cfg = (extra = {}) => loadConfig({ QUIESCENCE_MS: '100', ...extra });

test('create resolves the requested profile and records it', async () => {
  const m = new SessionManager(cfg({ PROFILE_GENERIC_COMMAND: 'bash' }));
  const rec = m.create({ profile: 'generic' });
  assert.equal(rec.profile, 'generic');
  assert.equal(rec.dialogPolicy, 'startup-only');
  assert.equal(rec.adapter.name, 'generic');
  m.remove(rec.id);
});

test('create with unknown profile throws UNKNOWN_PROFILE with validProfiles', () => {
  const m = new SessionManager(cfg());
  assert.throws(() => m.create({ profile: 'nope' }), (e) => {
    assert.equal(e.code, 'UNKNOWN_PROFILE');
    assert.ok(e.validProfiles.includes('claude'));
    return true;
  });
});

test('create with headless profile throws PROFILE_NOT_PTY', () => {
  const m = new SessionManager(cfg());
  assert.throws(() => m.create({ profile: 'claude-headless' }), (e) => e.code === 'PROFILE_NOT_PTY');
});

test('create with command-less generic throws PROFILE_NO_COMMAND', () => {
  const m = new SessionManager(cfg()); // no PROFILE_GENERIC_COMMAND, no ADAPTER=generic
  assert.throws(() => m.create({ profile: 'generic' }), (e) => e.code === 'PROFILE_NO_COMMAND');
});

test('create with the codex profile succeeds now that the codex adapter is registered', () => {
  // Task 10 registered the codex adapter, closing the transient window where
  // this profile existed in config but getAdapter('codex') threw.
  const m = new SessionManager(cfg({ PROFILE_CODEX_COMMAND: 'bash' }));
  const rec = m.create({ profile: 'codex' });
  assert.equal(rec.profile, 'codex');
  assert.equal(rec.adapter.name, 'codex');
  m.remove(rec.id);
});

test('create with a profile whose adapter name is not registered throws ADAPTER_UNAVAILABLE', () => {
  // antigravity/copilot still exercise this path today (Tasks 12/13 not yet
  // landed), but that coverage disappears once they register their own
  // adapters. Hand-build a profile with a bogus adapter name so the
  // ADAPTER_UNAVAILABLE branch in sessionManager.js never goes dead.
  const c = cfg({ PROFILE_GENERIC_COMMAND: 'bash' });
  const bogusProfile = Object.freeze({ ...c.profiles.generic, name: 'bogus', adapter: 'nonexistent' });
  const m = new SessionManager({ ...c, profiles: Object.freeze({ ...c.profiles, bogus: bogusProfile }) });
  assert.throws(() => m.create({ profile: 'bogus' }), (e) => {
    assert.equal(e.code, 'ADAPTER_UNAVAILABLE');
    assert.ok(Array.isArray(e.validProfiles));
    return true;
  });
});

test('per-profile quiescenceMs reaches the detector (not the global default)', () => {
  const m = new SessionManager(cfg({           // cfg sets the GLOBAL QUIESCENCE_MS=100
    PROFILE_GENERIC_COMMAND: 'bash',
    PROFILE_GENERIC_QUIESCENCE_MS: '777',       // per-profile override
  }));
  const rec = m.create({ profile: 'generic' });
  // White-box: proves SessionManager passes the resolved per-profile value, not
  // c.quiescenceMs (100). If the detector's private field is named differently
  // in the final source, assert against that name — the value 777 is the point.
  assert.equal(rec.detector._quiescenceMs, 777);
  m.remove(rec.id);
});

test('profile envScrub removes listed vars from the child env', async () => {
  process.env.BRIDGE_TEST_SENTINEL = 'leaky';
  try {
    const m = new SessionManager(cfg({
      PROFILE_GENERIC_COMMAND: 'bash',
      PROFILE_GENERIC_ARGS: '["-c","echo -n SCRUB:${BRIDGE_TEST_SENTINEL:-gone}; sleep 30"]',
      PROFILE_GENERIC_ENV_SCRUB: 'BRIDGE_TEST_SENTINEL',
    }));
    const rec = m.create({ profile: 'generic' });
    let out = '';
    rec.session.on('data', (d) => { out += d; });
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(out.includes('SCRUB:gone'), `output was: ${JSON.stringify(out)}`);
    m.remove(rec.id);
  } finally {
    delete process.env.BRIDGE_TEST_SENTINEL;
  }
});

// ---- makeDialogHandler: pure function, deterministic (no timers) ----

function fakeRecord({ dialogPolicy, startupDialogs = [] }) {
  const writes = [];
  return {
    writes,
    dialogPolicy,
    session: { write: (d) => writes.push(d) },
    adapter: { startupDialogs, keySeq: (n) => (n === 'enter' ? '\r' : String(n)) },
  };
}

test('makeDialogHandler startup-only: matched answered once, unmatched declined', () => {
  const rec = fakeRecord({
    dialogPolicy: 'startup-only',
    startupDialogs: [{ matcher: (t) => t.some((l) => l.includes('trust')), answerKeys: ['enter'] }],
  });
  const h = makeDialogHandler(rec);
  assert.equal(h(['please trust this']), true);
  assert.deepEqual(rec.writes, ['\r']);
  // a different (unmatched) screen: declined, no write
  assert.equal(h(['some other modal']), false);
  assert.deepEqual(rec.writes, ['\r']);
});

test('makeDialogHandler never: declines everything', () => {
  const rec = fakeRecord({ dialogPolicy: 'never', startupDialogs: [{ matcher: () => true, answerKeys: ['enter'] }] });
  const h = makeDialogHandler(rec);
  assert.equal(h(['trust prompt']), false);
  assert.deepEqual(rec.writes, []);
});

test('makeDialogHandler caps a persisting screen at two answers, then surfaces', () => {
  const rec = fakeRecord({ dialogPolicy: 'auto-approve', startupDialogs: [] });
  const h = makeDialogHandler(rec);
  assert.equal(h(['stuck modal']), true);   // 1
  assert.equal(h(['stuck modal']), true);   // 2 (same screen)
  assert.equal(h(['stuck modal']), false);  // capped → surface
  assert.deepEqual(rec.writes, ['\r', '\r']);
});

test('makeDialogHandler resets the cap when the awaiting screen changes', () => {
  const rec = fakeRecord({ dialogPolicy: 'auto-approve', startupDialogs: [] });
  const h = makeDialogHandler(rec);
  assert.equal(h(['dialog A']), true);
  assert.equal(h(['dialog A']), true);
  assert.equal(h(['dialog B']), true);      // different screen → counter reset, answered again
  assert.deepEqual(rec.writes, ['\r', '\r', '\r']);
});
