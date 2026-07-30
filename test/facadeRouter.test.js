import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { ConversationRouter } from '../src/facade/router.js';
import { PromptQueue } from '../src/promptQueue.js';

function fakeManager() {
  const records = new Map();
  let n = 0;
  return {
    created: [],
    create({ profile, cols }) {
      const id = `s${++n}`;
      const rec = { id, profile, cols, queue: new PromptQueue(), createdAt: Date.now(),
        session: { alive: true, kill() { this.alive = false; } }, detector: { state: 'idle' } };
      records.set(id, rec);
      this.created.push(rec);
      return rec;
    },
    get(id) { return records.get(id); },
    remove(id) { const r = records.get(id); if (r) { r.session.kill(); records.delete(id); } return !!r; },
    list() { return [...records.values()]; },
  };
}

function makeRouter(env = {}) {
  const config = loadConfig({ BRIDGE_TOKEN: 'tok', PROFILE_GENERIC_COMMAND: 'bash', ...env });
  const manager = fakeManager();
  const router = new ConversationRouter({ config, manager });
  return { config, manager, router };
}

const msgs = (...pairs) => pairs.map(([role, text]) => ({ role, text }));

test('fingerprint miss creates a session at facade cols; hit reuses it', () => {
  const { config, manager, router } = makeRouter();
  const m1 = msgs(['user', 'hello']);
  const a1 = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: m1 });
  assert.equal(manager.created.length, 1);
  assert.equal(manager.created[0].cols, config.facade.cols);
  assert.equal(a1.seedText, ''); // no history to seed
  assert.equal(a1.userText, 'hello');
  router.completeTurn(a1.conv, m1, 'REPLY');
  const m2 = msgs(['user', 'hello'], ['assistant', 'REPLY'], ['user', 'again']);
  const a2 = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: m2 });
  assert.equal(a2.conv, a1.conv);
  assert.equal(manager.created.length, 1);
  assert.equal(a2.seedText, '');
  router.close();
});

test('edited history misses and seeds a fresh session with the exact preamble', () => {
  const { manager, router } = makeRouter();
  const m1 = msgs(['user', 'hello']);
  const a1 = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: m1 });
  router.completeTurn(a1.conv, m1, 'REPLY');
  const edited = msgs(['system', 'S'], ['user', 'hello'], ['assistant', 'EDITED'], ['user', 'again']);
  const a2 = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: edited });
  assert.notEqual(a2.conv, a1.conv);
  assert.equal(manager.created.length, 2);
  assert.equal(a2.seedText, [
    'Prior conversation context, replayed for continuity. Do not respond to it;',
    'respond only to the message after the END CONTEXT line.',
    '--- BEGIN CONTEXT ---',
    '[system] S',
    '[user] hello',
    '[assistant] EDITED',
    '--- END CONTEXT ---',
  ].join('\n'));
  router.close();
});

test('same history on different profiles never collides', () => {
  const { manager, router } = makeRouter();
  const m = msgs(['user', 'x']);
  const a = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: m });
  router.completeTurn(a.conv, m, 'R');
  const m2 = msgs(['user', 'x'], ['assistant', 'R'], ['user', 'y']);
  const b = router.acquire({ profileName: 'claude', pinId: null, respConv: null, messages: m2 });
  assert.notEqual(b.conv, a.conv);
  assert.equal(manager.created.length, 2);
  router.close();
});

test('explicit pin: unknown id seeds, known id forwards trailing only, profile mismatch 400', () => {
  const { router } = makeRouter();
  const hist = msgs(['user', 'a'], ['assistant', 'b'], ['user', 'c']);
  const a1 = router.acquire({ profileName: 'generic', pinId: 'my-conv', respConv: null, messages: hist });
  assert.equal(a1.conv.id, 'my-conv');
  assert.match(a1.seedText, /BEGIN CONTEXT/);
  // known live pin: history ignored, no seed
  const a2 = router.acquire({ profileName: 'generic', pinId: 'my-conv', respConv: null, messages: msgs(['user', 'unrelated']) });
  assert.equal(a2.conv, a1.conv);
  assert.equal(a2.seedText, '');
  assert.throws(() => router.acquire({ profileName: 'claude', pinId: 'my-conv', respConv: null, messages: msgs(['user', 'x']) }),
    (e) => e.status === 400 && /bound to model/.test(e.message));
  router.close();
});

test('LRU cap: evicts least-recently-used idle conversation; all-busy → 429', () => {
  const { manager, router } = makeRouter({ FACADE_MAX_SESSIONS: '2' });
  const a = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'a']) });
  const b = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'b']) });
  a.conv.lastUsed = Date.now() - 5000; // a is LRU
  const c = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'c']) });
  assert.equal(router.stats().conversations, 2);
  assert.equal(manager.get(a.conv.record.id), undefined, 'LRU idle session was killed');
  b.conv.busy = 1; c.conv.busy = 1;
  assert.throws(() => router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'd']) }),
    (e) => e.status === 429 && e.kind === 'rate_limit');
  router.close();
});

test('TTL reap: default TTL for unpinned, longer for pinned, busy conversations survive', () => {
  const { manager, router } = makeRouter({ FACADE_SESSION_TTL_MS: '1000', FACADE_PINNED_TTL_MS: '5000' });
  const plain = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'a']) });
  const pinned = router.acquire({ profileName: 'generic', pinId: 'keep', respConv: null, messages: msgs(['user', 'b']) });
  const busy = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'c']) });
  busy.conv.busy = 1;
  router.reap(Date.now() + 2000);
  assert.equal(manager.get(plain.conv.record.id), undefined, 'unpinned reaped at session TTL');
  assert.ok(manager.get(pinned.conv.record.id), 'pinned survives session TTL');
  assert.ok(manager.get(busy.conv.record.id), 'busy survives');
  router.reap(Date.now() + 6000);
  assert.equal(manager.get(pinned.conv.record.id), undefined, 'pinned reaped at pinned TTL');
  // reaped pin recovers by reseeding on next request
  const again = router.acquire({ profileName: 'generic', pinId: 'keep', respConv: null, messages: msgs(['user', 'x'], ['assistant', 'y'], ['user', 'z']) });
  assert.match(again.seedText, /BEGIN CONTEXT/);
  router.close();
});

test('response-id registry: register, resolve, dropped on destroy', () => {
  const { router } = makeRouter();
  const a = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: msgs(['user', 'a']) });
  const rid = router.registerResponse(a.conv);
  assert.match(rid, /^resp_/);
  assert.equal(router.resolveResponseId(rid), a.conv);
  router.reap(Date.now() + 10 * 60 * 1000 + 1);
  assert.equal(router.resolveResponseId(rid), undefined);
  router.close();
});

test('headless profile conversations get their own queue and no PTY record', () => {
  const { manager, router } = makeRouter();
  const a = router.acquire({ profileName: 'claude-headless', pinId: null, respConv: null, messages: msgs(['user', 'a']) });
  assert.equal(a.conv.mode, 'headless');
  assert.equal(a.conv.record, null);
  assert.ok(a.conv.queue);
  assert.equal(manager.created.length, 0);
  router.close();
});

test('needsSeed: a failed headless turn forces reseeding on the next hit', () => {
  const { router } = makeRouter();
  const m1 = msgs(['user', 'hello']);
  const a1 = router.acquire({ profileName: 'claude-headless', pinId: null, respConv: null, messages: m1 });
  router.completeTurn(a1.conv, m1, 'REPLY');
  a1.conv.resumeSessionId = null; // simulate what _failTurn does…
  a1.conv.needsSeed = true;
  const m2 = msgs(['user', 'hello'], ['assistant', 'REPLY'], ['user', 'again']);
  const a2 = router.acquire({ profileName: 'claude-headless', pinId: null, respConv: null, messages: m2 });
  assert.equal(a2.conv, a1.conv);
  assert.match(a2.seedText, /BEGIN CONTEXT/, 'hit still reseeds when needsSeed is set');
  router.completeTurn(a2.conv, m2, 'R2');
  assert.equal(a2.conv.needsSeed, false);
  router.close();
});

test('acquire is stable for an identical retry: same conv, same fpKey, no new session', () => {
  const { manager, router } = makeRouter();
  const m = msgs(['user', 'hello']);
  const a1 = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: m });
  const a2 = router.acquire({ profileName: 'generic', pinId: null, respConv: null, messages: m });
  assert.equal(a2.conv, a1.conv, 'identical in-flight request attaches to the same conversation');
  assert.equal(a2.fpKey, a1.fpKey, 'fpKey deterministic — Task 8 pending-attach depends on this');
  assert.equal(manager.created.length, 1, 'no duplicate session spawned');
  router.close();
});
