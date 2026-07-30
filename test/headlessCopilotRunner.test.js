import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runHeadlessCopilotTurn } from '../src/facade/headlessCopilotRunner.js';
import { estTokens } from '../src/facade/shared.js';

const STUB = path.resolve('scripts/helpers/copilot-stub.mjs');

// Each call gets a fresh record file; the stub writes its argv + a subset of env
// there (via COPILOT_STUB_RECORD, injected through the profile's envSet).
function makeProfile({ envScrub = [], envSet = {}, args = [] } = {}) {
  const rec = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-stub-')), 'rec.json');
  const profile = { command: STUB, args, envScrub, cwd: process.cwd(), envSet: { COPILOT_STUB_RECORD: rec, ...envSet } };
  return { profile, rec };
}
const readRec = (rec) => JSON.parse(fs.readFileSync(rec, 'utf8'));

test('first turn: assigns a session id, streams deltas, reports real output tokens', async () => {
  const { profile, rec } = makeProfile();
  const deltas = [];
  const out = await runHeadlessCopilotTurn({ profile, resumeSessionId: null, userText: 'hello', emit: (e) => deltas.push(e.text), timeoutMs: 5000 });
  assert.equal(out.text, 'turn 1 reply to: hello');
  assert.equal(deltas.join(''), out.text);
  // output is copilot's REAL count (7); input is a chars/4 estimate, so the
  // whole usage object is flagged estimated:true (copilot gives no input count).
  assert.deepEqual(out.usage, { input: estTokens('hello'.length), output: 7, estimated: true });
  assert.ok(out.resumeSessionId && out.resumeSessionId.length > 0, 'returned an assigned session id');
  const { argv } = readRec(rec);
  const si = argv.indexOf('--session-id');
  assert.ok(si !== -1, '--session-id present on the first turn');
  assert.equal(argv[si + 1], out.resumeSessionId, 'assigned id echoed back');
  assert.ok(!argv.some((a) => a.startsWith('--resume')), 'no --resume on the first turn');
});

test('resume: threads --resume=<id> and omits --session-id', async () => {
  const { profile, rec } = makeProfile();
  const out = await runHeadlessCopilotTurn({ profile, resumeSessionId: 'sess-xyz', userText: 'again', emit: () => {}, timeoutMs: 5000 });
  assert.equal(out.text, 'turn 2 reply to: again');
  assert.equal(out.resumeSessionId, 'sess-xyz');
  const { argv } = readRec(rec);
  assert.ok(argv.includes('--resume=sess-xyz'), 'resume id threaded');
  assert.ok(!argv.includes('--session-id'), 'no --session-id when resuming');
});

test('returns the session id from the child result event, not just the assigned one', async () => {
  // Force the child to report an id different from the one the runner assigned,
  // proving the runner reads result.sessionId (its resultSessionId path) rather
  // than blindly echoing its own uuid.
  const { profile } = makeProfile({ envSet: { COPILOT_STUB_RESULT_SID: 'child-reported-99' } });
  const out = await runHeadlessCopilotTurn({ profile, resumeSessionId: null, userText: 'x', emit: () => {}, timeoutMs: 5000 });
  assert.equal(out.resumeSessionId, 'child-reported-99');
});

test('SECURITY: tool-lockdown flags always present; nothing enables tools', async () => {
  const { profile, rec } = makeProfile();
  await runHeadlessCopilotTurn({ profile, resumeSessionId: null, userText: 'x', emit: () => {}, timeoutMs: 5000 });
  const { argv } = readRec(rec);
  for (const f of ['--available-tools=__none__', '--disable-builtin-mcps', '--no-ask-user']) {
    assert.ok(argv.includes(f), `lockdown flag ${f} must be present`);
  }
  assert.equal(argv[0], '-p', 'prompt flag first');
  assert.equal(argv[1], 'x', 'prompt value adjacent to -p');
  const oi = argv.indexOf('--output-format');
  assert.equal(argv[oi + 1], 'json', 'structured JSONL output');
  for (const danger of ['--allow-all-tools', '--allow-all', '--yolo', '--allow-tool']) {
    assert.ok(!argv.includes(danger), `must never pass ${danger}`);
  }
});

test('SECURITY: operator tool-exposure args on the locked profile are stripped; __none__ survives', async () => {
  // The lockdown must be non-overridable even by profile.args (appended after
  // the fixed flags). An operator-set --available-tools=<real> could otherwise
  // shadow our __none__ allowlist and re-expose tools to an untrusted prompt.
  const { profile, rec } = makeProfile({
    // Both value forms: `=`-joined AND space-separated (the pair `--available-tools bash`).
    args: ['--available-tools=zsh', '--available-tools', 'bash', '--allow-all-tools', '--allow-tool', 'shell', '--yolo', '--foo', 'bar'],
  });
  await runHeadlessCopilotTurn({ profile, resumeSessionId: null, userText: 'x', emit: () => {}, timeoutMs: 5000 });
  const { argv } = readRec(rec);
  // Our canonical lockdown survives exactly once; nothing re-exposes tools.
  assert.equal(argv.filter((a) => a.startsWith('--available-tools')).length, 1, 'only our --available-tools remains');
  assert.ok(argv.includes('--available-tools=__none__'), 'canonical lockdown present');
  for (const danger of ['--available-tools=zsh', '--allow-all-tools', '--allow-tool', 'shell', 'bash', '--yolo']) {
    assert.ok(!argv.includes(danger), `operator tool-exposure arg ${danger} must be stripped`);
  }
  // Benign, non-tool operator args still pass through unchanged.
  assert.ok(argv.includes('--foo') && argv.includes('bar'), 'non-tool args pass through');
});

test('seed text is prepended into the -p prompt; reply answers the trailing line', async () => {
  const { profile, rec } = makeProfile();
  const out = await runHeadlessCopilotTurn({ profile, resumeSessionId: null, userText: 'the question', seedText: 'ctx a\nctx b', emit: () => {}, timeoutMs: 5000 });
  assert.equal(out.text, 'turn 1 reply to: the question');
  const { argv } = readRec(rec);
  assert.equal(argv[1], 'ctx a\nctx b\n\nthe question', 'seed + blank line + user text');
});

test('envScrub removes and envSet injects the child environment', async () => {
  const { profile, rec } = makeProfile({ envScrub: ['GH_TOKEN'], envSet: { STUB_MARKER: 'injected' } });
  const prev = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'leaky';
  try {
    await runHeadlessCopilotTurn({ profile, resumeSessionId: null, userText: 'x', emit: () => {}, timeoutMs: 5000 });
  } finally {
    if (prev === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prev;
  }
  const { env } = readRec(rec);
  assert.equal(env.GH_TOKEN, null, 'GH_TOKEN scrubbed from the child');
  assert.equal(env.STUB_MARKER, 'injected', 'envSet reached the child');
});

test('SECURITY: COPILOT_ALLOW_ALL is scrubbed even when the profile envScrub list is emptied', async () => {
  // PROFILE_<NAME>_ENV_SCRUB can override the table's scrub list from config;
  // the runner deletes COPILOT_ALLOW_ALL unconditionally so the env channel
  // can't reopen the lockdown any more than the argv channel can.
  const { profile, rec } = makeProfile({ envScrub: [] });
  const prev = process.env.COPILOT_ALLOW_ALL;
  process.env.COPILOT_ALLOW_ALL = '1';
  try {
    await runHeadlessCopilotTurn({ profile, resumeSessionId: null, userText: 'x', emit: () => {}, timeoutMs: 5000 });
  } finally {
    if (prev === undefined) delete process.env.COPILOT_ALLOW_ALL; else process.env.COPILOT_ALLOW_ALL = prev;
  }
  const { env } = readRec(rec);
  assert.equal(env.COPILOT_ALLOW_ALL, null, 'COPILOT_ALLOW_ALL never reaches the child');
});

test('nonzero exit fails provider-shaped with the stderr tail', async () => {
  const { profile } = makeProfile();
  await assert.rejects(
    () => runHeadlessCopilotTurn({ profile, resumeSessionId: null, userText: 'please CRASH now', emit: () => {}, timeoutMs: 5000 }),
    (e) => e.status === 500 && e.kind === 'api_error' && /exited with code 1/.test(e.message) && /synthetic failure/.test(e.bridge.stderr));
});

test('timeout kills the child and fails 504', async () => {
  const { profile } = makeProfile();
  await assert.rejects(
    () => runHeadlessCopilotTurn({ profile, resumeSessionId: null, userText: 'please HANG forever', emit: () => {}, timeoutMs: 300 }),
    (e) => e.status === 504 && e.kind === 'timeout');
});
