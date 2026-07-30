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
