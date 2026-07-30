#!/usr/bin/env node
// Fake `claude -p --output-format stream-json --include-partial-messages`
// for headless-runner tests (spec Testing §3): real enough to exercise the
// parser — init/session_id, incremental text_delta stream_events, a result
// with usage — plus failure modes (--resume rejection, CRASH → nonzero exit).
// The session-id chain stub-1 → stub-2 → … proves --resume is passed through.
const args = process.argv.slice(2);
const ri = args.indexOf('--resume');
const resumed = ri === -1 ? null : args[ri + 1];
let turn = 1;
if (resumed != null) {
  const m = /^stub-(\d+)$/.exec(resumed);
  if (!m) { process.stderr.write(`No conversation found with session ID: ${resumed}\n`); process.exit(1); }
  turn = Number(m[1]) + 1;
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const prompt = input.trim();
  if (/CRASH/.test(prompt)) { process.stderr.write('stub: synthetic failure\n'); process.exit(1); }
  if (/HANG/.test(prompt)) { setInterval(() => {}, 1000); return; } // never results, never exits
  const sid = `stub-${turn}`;
  const reply = `turn ${turn} reply to: ${prompt.split('\n').pop()}`;
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'stub' });
  const half = Math.ceil(reply.length / 2);
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(0, half) } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(half) } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sid, usage: { input_tokens: 42, output_tokens: 7 } });
  process.exit(0);
});
