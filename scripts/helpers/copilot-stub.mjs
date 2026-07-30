#!/usr/bin/env node
// Fake `copilot -p <text> --output-format json ...` for headlessCopilotRunner
// tests — real enough to exercise the JSONL parser (message_start /
// message_delta / message final_answer / result), the assigned-vs-resumed
// session id, and failure modes (CRASH → nonzero exit, HANG → never results).
// It records its argv + a subset of env to $COPILOT_STUB_RECORD so tests can
// assert the tool-lockdown flags and env-scrub reach the child. Turn number is
// 1 for a new session (--session-id) and 2 when resumed (--resume=<id>), which
// is all the 2-turn continuity proof needs.
import fs from 'node:fs';

const argv = process.argv.slice(2);
const valAfter = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
const valEq = (name) => { const a = argv.find((x) => x.startsWith(`${name}=`)); return a ? a.slice(name.length + 1) : null; };

const prompt = String(valAfter('-p') ?? valAfter('--prompt') ?? '');
const resume = valEq('--resume') ?? valAfter('--resume');
const sessionId = valAfter('--session-id') ?? resume ?? 'stub-session';
const turn = resume ? 2 : 1;

const record = process.env.COPILOT_STUB_RECORD;
if (record) {
  fs.writeFileSync(record, JSON.stringify({
    argv,
    env: {
      GH_TOKEN: process.env.GH_TOKEN ?? null,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
      COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN ?? null,
      COPILOT_ALLOW_ALL: process.env.COPILOT_ALLOW_ALL ?? null,
      STUB_MARKER: process.env.STUB_MARKER ?? null,
    },
  }));
}

if (/CRASH/.test(prompt)) { process.stderr.write('copilot-stub: synthetic failure\n'); process.exit(1); }
if (/HANG/.test(prompt)) { setInterval(() => {}, 1000); }  // never results, never exits
else {
  const reply = `turn ${turn} reply to: ${prompt.split('\n').pop()}`;
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const mid = `msg-${turn}`;
  // Noise the parser must ignore, then the final-answer message + result.
  out({ type: 'session.mcp_servers_loaded', data: { servers: [] }, ephemeral: true });
  out({ type: 'assistant.turn_start', data: { turnId: '0' } });
  out({ type: 'assistant.message_start', data: { messageId: mid, phase: 'final_answer' }, ephemeral: true });
  const half = Math.ceil(reply.length / 2);
  out({ type: 'assistant.message_delta', data: { messageId: mid, deltaContent: reply.slice(0, half) }, ephemeral: true });
  out({ type: 'assistant.message_delta', data: { messageId: mid, deltaContent: reply.slice(half) }, ephemeral: true });
  out({ type: 'assistant.message', data: { messageId: mid, phase: 'final_answer', content: reply, toolRequests: [], outputTokens: 7 } });
  out({ type: 'assistant.idle', data: {}, ephemeral: true });
  // Real copilot echoes the assigned id here; COPILOT_STUB_RESULT_SID lets a
  // test force a DIVERGENT id so the runner's result.sessionId capture (vs its
  // assigned-id fallback) is actually exercised.
  out({ type: 'result', sessionId: process.env.COPILOT_STUB_RESULT_SID || sessionId, exitCode: 0, usage: { premiumRequests: 0, totalApiDurationMs: 1 } });
  process.exit(0);
}
