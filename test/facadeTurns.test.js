import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { ConversationRouter } from '../src/facade/router.js';

const REPL = path.resolve('scripts/helpers/fake-repl.sh');
const DIALOG_REPL = path.resolve('scripts/helpers/fake-dialog-repl.sh');
const STUB = path.resolve('scripts/helpers/claude-stub.mjs');
const COPILOT_STUB = path.resolve('scripts/helpers/copilot-stub.mjs');

function boot(extraEnv = {}) {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '200', PROMPT_TIMEOUT_MS: '8000',
    PROFILE_CLAUDE_COMMAND: 'bash', PROFILE_CLAUDE_ARGS: JSON.stringify([DIALOG_REPL]),
    PROFILE_CLAUDE_DIALOG_POLICY: 'never', PROFILE_CLAUDE_QUIESCENCE_MS: '200', PROFILE_CLAUDE_CWD: process.cwd(),
    PROFILE_CLAUDE_HEADLESS_COMMAND: STUB, PROFILE_CLAUDE_HEADLESS_CWD: process.cwd(),
    PROFILE_COPILOT_HEADLESS_COMMAND: COPILOT_STUB, PROFILE_COPILOT_HEADLESS_CWD: process.cwd(),
    ...extraEnv,
  });
  const manager = new SessionManager(config);
  const router = new ConversationRouter({ config, manager });
  return { config, manager, router, close() { router.close(); for (const r of manager.list()) manager.remove(r.id); } };
}

const msgs = (...pairs) => pairs.map(([role, text]) => ({ role, text }));

async function drain(events) {
  const deltas = [];
  let done = null;
  for await (const ev of events) { if (ev.type === 'delta') deltas.push(ev.text); else if (ev.type === 'done') done = ev; }
  return { deltas, done };
}

test('pty turn end-to-end: deltas, done, fingerprint advances for the next turn', async () => {
  const b = boot();
  const m1 = msgs(['user', 'hello']);
  const t1 = b.router.executeTurn({ profileName: 'generic', messages: m1, timeoutMs: 8000 });
  const r1 = await drain(t1.events);
  assert.match(r1.done.text, /reply 1 to: hello/);
  assert.equal(r1.deltas.join(''), r1.done.text);
  const m2 = msgs(['user', 'hello'], ['assistant', r1.done.text], ['user', 'again']);
  const t2 = b.router.executeTurn({ profileName: 'generic', messages: m2, timeoutMs: 8000 });
  const r2 = await drain(t2.events);
  assert.equal(t2.conv, t1.conv, 'fingerprint hit routes to the same conversation');
  assert.match(r2.done.text, /reply 2 to: again/, 'same session — counter continued');
  b.close();
});

test('unknown model → model_not_found before any session spawns', () => {
  const b = boot();
  assert.throws(() => b.router.executeTurn({ profileName: 'gpt-4o', messages: msgs(['user', 'x']), timeoutMs: 1000 }),
    (e) => e.status === 404 && e.kind === 'model_not_found');
  assert.equal(b.manager.list().length, 0);
  b.close();
});

test('headless turn: stub session-id chain proves --resume continuity', async () => {
  const b = boot();
  const m1 = msgs(['user', 'first']);
  const t1 = b.router.executeTurn({ profileName: 'claude-headless', messages: m1, timeoutMs: 8000 });
  const r1 = await drain(t1.events);
  assert.equal(r1.done.text, 'turn 1 reply to: first');
  assert.deepEqual(r1.done.usage, { input: 42, output: 7, estimated: false });
  assert.equal(t1.conv.resumeSessionId, 'stub-1');
  const m2 = msgs(['user', 'first'], ['assistant', r1.done.text], ['user', 'second']);
  const t2 = b.router.executeTurn({ profileName: 'claude-headless', messages: m2, timeoutMs: 8000 });
  const r2 = await drain(t2.events);
  assert.equal(t2.conv, t1.conv);
  assert.equal(r2.done.text, 'turn 2 reply to: second');
  assert.equal(t2.conv.resumeSessionId, 'stub-2');
  b.close();
});

test('headless failure drops the session id and reseeds the next turn', async () => {
  const b = boot();
  const m1 = msgs(['user', 'alpha']);
  const t1 = b.router.executeTurn({ profileName: 'claude-headless', messages: m1, timeoutMs: 8000 });
  const r1 = await drain(t1.events);
  const m2 = msgs(['user', 'alpha'], ['assistant', r1.done.text], ['user', 'now CRASH please']);
  const t2 = b.router.executeTurn({ profileName: 'claude-headless', messages: m2, timeoutMs: 8000 });
  await assert.rejects(() => drain(t2.events), (e) => e.status === 500);
  assert.equal(t2.conv.resumeSessionId, null, 'session id dropped');
  assert.equal(t2.conv.needsSeed, true, 'next turn reseeds from client-held history');
  // recovery: same history retried (fingerprint unchanged — the failed turn did not advance it)
  const t3 = b.router.executeTurn({ profileName: 'claude-headless', messages: msgs(['user', 'alpha'], ['assistant', r1.done.text], ['user', 'recover']), timeoutMs: 8000 });
  const r3 = await drain(t3.events);
  assert.equal(t3.conv, t2.conv);
  assert.equal(r3.done.text, 'turn 1 reply to: recover', 'fresh -p turn (counter restarted), seeded');
  b.close();
});

test('copilot-headless turn: assigned session id is stable across the --resume chain', async () => {
  const b = boot();
  const m1 = msgs(['user', 'first']);
  const t1 = b.router.executeTurn({ profileName: 'copilot-headless', messages: m1, timeoutMs: 8000 });
  const r1 = await drain(t1.events);
  assert.equal(r1.done.text, 'turn 1 reply to: first');
  assert.equal(r1.deltas.join(''), r1.done.text, 'streamed deltas reconstruct the final text');
  assert.equal(r1.done.usage.output, 7, 'real output-token count from the final message');
  assert.equal(r1.done.usage.estimated, true, 'input is estimated (copilot gives no input count) so the object is flagged estimated');
  const sid = t1.conv.resumeSessionId;
  assert.ok(sid, 'first turn assigned a session id');
  const m2 = msgs(['user', 'first'], ['assistant', r1.done.text], ['user', 'second']);
  const t2 = b.router.executeTurn({ profileName: 'copilot-headless', messages: m2, timeoutMs: 8000 });
  const r2 = await drain(t2.events);
  assert.equal(t2.conv, t1.conv, 'fingerprint hit routes to the same conversation');
  assert.equal(r2.done.text, 'turn 2 reply to: second', 'resumed session — turn advanced');
  assert.equal(t2.conv.resumeSessionId, sid, 'same session id resumed, not regenerated');
  b.close();
});

test('copilot-headless failure drops the session id and reseeds the next turn', async () => {
  const b = boot();
  const m1 = msgs(['user', 'alpha']);
  const t1 = b.router.executeTurn({ profileName: 'copilot-headless', messages: m1, timeoutMs: 8000 });
  const r1 = await drain(t1.events);
  const m2 = msgs(['user', 'alpha'], ['assistant', r1.done.text], ['user', 'now CRASH please']);
  const t2 = b.router.executeTurn({ profileName: 'copilot-headless', messages: m2, timeoutMs: 8000 });
  await assert.rejects(() => drain(t2.events), (e) => e.status === 500);
  assert.equal(t2.conv.resumeSessionId, null, 'session id dropped');
  assert.equal(t2.conv.needsSeed, true, 'next turn reseeds from client-held history');
  b.close();
});

test('session exit mid-turn drops the conversation mapping', async () => {
  const b = boot();
  const m1 = msgs(['user', 'EXIT']);
  const t1 = b.router.executeTurn({ profileName: 'generic', messages: m1, timeoutMs: 8000 });
  await assert.rejects(() => drain(t1.events), (e) => e.status === 500);
  assert.equal(b.router.stats().conversations, 0, 'mapping dropped so the next request reseeds');
  b.close();
});

test('dialog mid-turn: pending buffered, retry attaches after POST-/key-style answer', async () => {
  const b = boot();
  const m = msgs(['user', 'DIALOG']);
  const t1 = b.router.executeTurn({ profileName: 'claude', messages: m, timeoutMs: 8000 });
  let dialogErr;
  try { await drain(t1.events); } catch (e) { dialogErr = e; }
  assert.equal(dialogErr.status, 409);
  assert.equal(dialogErr.kind, 'dialog');
  assert.match(dialogErr.bridge.dialog, /Quick safety check/);
  assert.equal(dialogErr.bridge.conversation_id, t1.conv.id);
  assert.equal(dialogErr.bridge.session_id, t1.conv.record.id);
  assert.ok(t1.conv.pending, 'pending turn buffered');
  // a retry while still blocked gets the same dialog error, and does NOT type
  const t2 = b.router.executeTurn({ profileName: 'claude', messages: m, timeoutMs: 3000 });
  await assert.rejects(() => drain(t2.events), (e) => e.kind === 'dialog');
  // operator answers (what POST /key does), then wait for the detector to
  // genuinely re-settle to idle. waitForSettle can't be used here: it treats
  // awaiting_input as already-settled and would return the stale pre-answer
  // state synchronously, before the answer's output is ever processed.
  const det = t1.conv.record.detector;
  const idle = new Promise((resolve) => {
    if (det.state === 'idle') return resolve();
    det.on('state', function onIdle(s) { if (s === 'idle') { det.off('state', onIdle); resolve(); } });
  });
  t1.conv.record.session.write(t1.conv.record.adapter.keySeq('enter'));
  await idle;
  // identical retry now attaches and returns the extracted text
  const t3 = b.router.executeTurn({ profileName: 'claude', messages: m, timeoutMs: 8000 });
  const r3 = await drain(t3.events);
  assert.match(r3.done.text, /dialog answered/);
  assert.equal(t3.conv.pending, null);
  b.close();
});

test('at-capacity with all sessions mid-turn → 429; after settle, eviction works', async () => {
  const b = boot({ FACADE_MAX_SESSIONS: '1' });
  const t1 = b.router.executeTurn({ profileName: 'generic', messages: msgs(['user', 'SPAM']), timeoutMs: 8000 });
  await new Promise((r) => setTimeout(r, 250)); // let the turn start (busy=1)
  assert.throws(() => b.router.executeTurn({ profileName: 'generic', messages: msgs(['user', 'other']), timeoutMs: 8000 }),
    (e) => e.status === 429 && e.kind === 'rate_limit');
  await drain(t1.events); // spam finishes, conv idle
  const t2 = b.router.executeTurn({ profileName: 'generic', messages: msgs(['user', 'other']), timeoutMs: 8000 });
  const r2 = await drain(t2.events);
  assert.match(r2.done.text, /reply 1 to: other/, 'LRU idle conversation evicted, fresh session spawned');
  b.close();
});

test('abort signal stops delta emission but the turn still completes and advances', async () => {
  const b = boot();
  const ac = new AbortController();
  const m1 = msgs(['user', 'SPAM']);
  const t1 = b.router.executeTurn({ profileName: 'generic', messages: m1, signal: ac.signal, timeoutMs: 8000 });
  const seen = [];
  let ended = false;
  (async () => { try { for await (const ev of t1.events) seen.push(ev); } catch { /* ignored */ } ended = true; })();
  await new Promise((r) => setTimeout(r, 300));
  ac.abort(); // client disconnects mid-stream
  await new Promise((r) => setTimeout(r, 2500)); // let the CLI finish in background
  assert.equal(t1.conv.busy, 0, 'turn completed in background');
  assert.ok(t1.conv.record.session.alive, 'no ESC-interrupt: session left consistent');
  const countAfterAbort = seen.filter((e) => e.type === 'delta').length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(seen.filter((e) => e.type === 'delta').length, countAfterAbort, 'no deltas after abort');
  b.close();
});
