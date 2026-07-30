// Security tests for session terminal geometry (VULN-001, VULN-002).
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TerminalModel } from '../src/terminalModel.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';
import { loadConfig } from '../src/config.js';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_DIM = 1000;
const TOKEN = 'tok';
const auth = { headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } };

async function boot() {
  const config = loadConfig({
    ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]',
    BRIDGE_TOKEN: TOKEN, QUIESCENCE_MS: '100',
  });
  const manager = new SessionManager(config);
  const server = createHttpServer(config, manager, null);
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return {
    port, manager,
    teardown: async () => {
      for (const r of manager.list()) manager.remove(r.id);
      await new Promise((r) => server.close(r));
    },
  };
}

// Measure allocation in a FRESH process — RSS is a high-water mark, so
// measuring twice in one process understates the second allocation.
function rssDeltaFor(cols, rows) {
  const script = `
    import { TerminalModel } from ${JSON.stringify(path.join(ROOT, 'src/terminalModel.js'))};
    const before = process.memoryUsage().rss;
    new TerminalModel({ cols: ${cols}, rows: ${rows}, scrollback: 5000 });
    console.log(Math.round((process.memoryUsage().rss - before) / 1048576));
  `;
  return Number(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', cwd: ROOT,
  }).trim());
}

test('VULN-001: TerminalModel constructor clamps hostile geometry', () => {
  const model = new TerminalModel({ cols: 6000, rows: 6000, scrollback: 5000 });
  assert.ok(model.cols <= MAX_DIM && model.rows <= MAX_DIM,
    `constructor left geometry unclamped: ${model.cols}x${model.rows} (expected <= ${MAX_DIM})`);
});

test('VULN-001: TerminalModel.resize clamps hostile geometry', () => {
  const model = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  model.resize(6000, 6000);
  assert.ok(model.cols <= MAX_DIM && model.rows <= MAX_DIM,
    `resize left geometry unclamped: ${model.cols}x${model.rows} (expected <= ${MAX_DIM})`);
});

test('VULN-001: allocation is bounded regardless of requested geometry', () => {
  const delta = rssDeltaFor(6000, 6000);
  assert.ok(delta < 100,
    `unbounded allocation: 6000x6000 grew RSS by ${delta} MB in a fresh process (expected < 100 MB)`);
});

test('VULN-001: POST /api/sessions rejects out-of-range geometry with 400', async () => {
  const { port, teardown } = await boot();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST', ...auth, body: JSON.stringify({ cols: 6000, rows: 6000 }),
    });
    assert.equal(res.status, 400,
      `expected a coded 400 for out-of-range geometry, got ${res.status}`);
    const body = await res.json();
    assert.match(String(body.error), /geometry|INVALID_GEOMETRY|cols|rows/i,
      `400 body should name the geometry problem, got ${JSON.stringify(body)}`);
  } finally {
    await teardown();
  }
});

const liveBashPids = () => execSync(
  "ps -eo pid,args | grep 'bash -i' | grep -v grep | awk '{print $1}' || true",
  { encoding: 'utf8' },
).trim().split('\n').filter(Boolean);

const isAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const reap = (pids) => { for (const p of pids) { try { process.kill(Number(p), 9); } catch {} } };

// A post-spawn throw must not leak the PTY child. SCROLLBACK=1.5 is finite so
// config's num() accepts it, but xterm rejects it — reproducing "any throw
// between pty.spawn and record registration", which is the actual defect.
// VULN-001's geometry clamp does NOT cover this path.
function bootWithPostSpawnThrow() {
  return new SessionManager(loadConfig({
    ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]',
    BRIDGE_TOKEN: 'tok', QUIESCENCE_MS: '100',
    SCROLLBACK: '1.5',
  }));
}

test('VULN-002: a post-spawn failure must not orphan a PTY child', async () => {
  const manager = bootWithPostSpawnThrow();
  const before = liveBashPids();

  assert.throws(() => manager.create({}), 'create() should still surface the failure');

  await new Promise((r) => setTimeout(r, 400));
  const leaked = liveBashPids().filter((p) => !before.includes(p));
  const stillAlive = leaked.filter(isAlive);
  reap(leaked);

  assert.equal(manager.list().length, 0, 'no record should be registered after a failed create');
  assert.equal(stillAlive.length, 0,
    `failed create orphaned ${stillAlive.length} live PTY child(ren): [${stillAlive.join(',')}] — ` +
    'the child was spawned before the owning record was registered and nothing reaped it');
});

test('VULN-002: the leak does not accumulate across repeated failures', async () => {
  const manager = bootWithPostSpawnThrow();
  const before = liveBashPids();

  for (let i = 0; i < 3; i++) { try { manager.create({}); } catch {} }

  await new Promise((r) => setTimeout(r, 500));
  const leaked = liveBashPids().filter((p) => !before.includes(p));
  const stillAlive = leaked.filter(isAlive);
  reap(leaked);

  assert.equal(stillAlive.length, 0,
    `3 failed creates orphaned ${stillAlive.length} live child(ren): [${stillAlive.join(',')}] — leak scales with request count`);
});

// The reorder above means TerminalModel (the validating step) now throws before
// the PTY is spawned, so the SCROLLBACK case never reaches the try/catch. This
// test covers the guard itself: it forces a throw INSIDE the try block, after
// the child is live but before the record is registered, by making the shared
// adapter object throw on the first property StateDetector touches.
test('VULN-002: a throw after the spawn but before registration reaps the child', async () => {
  const { getAdapter } = await import('../src/adapters/index.js');
  const adapter = getAdapter('generic');
  const original = Object.getOwnPropertyDescriptor(adapter, 'isBusy');

  const manager = new SessionManager(loadConfig({
    ADAPTER: 'generic', CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]',
    BRIDGE_TOKEN: 'tok', QUIESCENCE_MS: '100',
  }));
  const before = liveBashPids();

  Object.defineProperty(adapter, 'isBusy', {
    configurable: true,
    get() { throw new Error('induced post-spawn failure'); },
  });
  try {
    assert.throws(() => manager.create({}), /induced post-spawn failure/,
      'the induced failure should surface to the caller');
  } finally {
    if (original) Object.defineProperty(adapter, 'isBusy', original);
    else delete adapter.isBusy;
  }

  await new Promise((r) => setTimeout(r, 400));
  const leaked = liveBashPids().filter((p) => !before.includes(p));
  const stillAlive = leaked.filter(isAlive);
  reap(leaked);

  assert.equal(manager.list().length, 0, 'no record should be registered');
  assert.equal(stillAlive.length, 0,
    `a throw between spawn and registration orphaned ${stillAlive.length} live child(ren): [${stillAlive.join(',')}] — the try/catch did not reap it`);
});
