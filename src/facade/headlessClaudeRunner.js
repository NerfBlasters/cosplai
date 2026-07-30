// src/facade/headlessClaudeRunner.js
// HeadlessClaudeRunner (spec "TurnRunner seam"): one facade turn = one
// `claude -p --output-format stream-json --verbose --include-partial-messages`
// invocation (the partial-messages flag is required for incremental deltas).
// First turn captures Claude's own session_id from the init event; later
// turns pass --resume <id>, so no seeding is needed while resume works. The
// profile's args are appended AFTER the fixed flags; env-scrub forces
// subscription auth. Real token usage comes from the result event.
import { spawn } from 'node:child_process';
import { FacadeError } from './shared.js';

const FIXED_ARGS = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

export function runHeadlessClaudeTurn({ profile, resumeSessionId, userText, seedText = '', emit, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [...FIXED_ARGS];
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    args.push(...profile.args);
    const env = { ...process.env };
    for (const k of profile.envScrub) delete env[k];
    Object.assign(env, profile.envSet || {});

    let child;
    try {
      child = spawn(profile.command, args, { cwd: profile.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new FacadeError(500, 'api_error', `failed to spawn "${profile.command}": ${e.message}`,
        { spawn_error: String(e.message || e) }));
    }

    let sessionId = null;
    let resultText = null;
    let usage = null;
    let stderr = '';
    let buf = '';
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      reject(err);
    };
    const timer = setTimeout(() => fail(new FacadeError(504, 'timeout', 'headless claude turn timed out',
      { stderr: stderr.slice(-2000) })), timeoutMs);

    child.on('error', (e) => fail(new FacadeError(500, 'api_error', `failed to spawn "${profile.command}": ${e.message}`,
      { spawn_error: String(e.message || e) })));
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; } // tolerate noise; a missing result is caught at exit
        if (j.type === 'system' && j.subtype === 'init' && j.session_id) sessionId = j.session_id;
        else if (j.type === 'stream_event' && j.event && j.event.type === 'content_block_delta'
                 && j.event.delta && j.event.delta.type === 'text_delta') emit({ type: 'delta', text: j.event.delta.text });
        else if (j.type === 'result') {
          resultText = j.is_error ? null : (j.result ?? '');
          usage = j.usage || null;
          if (j.session_id) sessionId = j.session_id;
        }
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new FacadeError(500, 'api_error', `headless claude exited with code ${code}`, { stderr: stderr.slice(-2000) }));
      if (resultText == null) return reject(new FacadeError(500, 'api_error', 'headless claude produced no result event', { stderr: stderr.slice(-2000) }));
      resolve({
        text: resultText,
        resumeSessionId: sessionId,
        usage: usage
          ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, estimated: false }
          : { input: 0, output: 0, estimated: true },
      });
    });
    child.stdin.on('error', () => { /* child died before reading stdin; close handler reports it */ });
    child.stdin.write(seedText ? `${seedText}\n\n${userText}` : userText);
    child.stdin.end();
  });
}
