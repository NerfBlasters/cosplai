// src/facade/headlessCopilotRunner.js
// HeadlessCopilotRunner (mirror of headlessClaudeRunner): one facade turn = one
// non-interactive `copilot -p ...` invocation with structured JSONL output
// (`--output-format json`). Unlike claude — which DISCOVERS its session_id from
// an init event — copilot lets us ASSIGN the session id: turn 1 passes
// `--session-id <uuid>` (we generate), later turns pass `--resume=<uuid>`, so
// facade stickiness needs no id discovery. The profile's args are appended
// AFTER the fixed flags; env-scrub forces subscription auth. The final answer's
// exact text comes from the `assistant.message` (phase "final_answer") event;
// `assistant.message_delta` events feed incremental deltas; real output-token
// count comes from the final message's `outputTokens`.
//
// SECURITY — the tool lockdown here is load-bearing, do NOT relax it
// (spike-verified live against copilot 1.0.75, §2.1.6). Copilot's `-p` mode is
// agentic: with no tool filter it auto-EXECUTES the builtin `bash` tool (it ran
// `echo` on the host in testing) — `--allow-all-tools` is NOT required for that
// to happen, and an EMPTY `--available-tools=` does not filter it. The bridge
// exposes this profile as a chat responder over the cloud-API facade, where a
// prompt is untrusted, so tool execution must be impossible. The fix, per
// `copilot help permissions`:
//   --available-tools=__none__  a deliberately-BOGUS, non-empty allowlist.
//       `--available-tools` "disables all other tools", and that filter is
//       UPSTREAM of the --allow-*/--deny-* approval layer ("do not expose tools
//       filtered out by --available-tools"), so no stray --allow-all-tools can
//       re-expose a filtered tool. A non-existent name exposes ZERO real tools.
//       Verified: filters `bash`, no tool.execution events. (An empty value
//       `--available-tools=` is parsed as "no filter" and bash runs — the
//       non-empty bogus name is the point, don't "simplify" it to empty.)
//   --disable-builtin-mcps      no MCP tool surface / no implicit GitHub calls.
//   --no-ask-user               never block on a clarifying question.
// Operator-supplied profile.args are appended AFTER these flags, so a later
// --available-tools=<real> could otherwise shadow our __none__ allowlist
// (copilot's multi-value precedence for that flag is unspecified) and re-expose
// tools. scrubToolExposureArgs() strips every DOCUMENTED tool-exposure flag from
// profile.args before spawning so config can't reopen the lockdown by prepending
// its own allowlist; --deny-* is left intact (it only ever tightens). This
// hardens the lockdown against the known flags — it is NOT a proof of absolute
// non-overridability: two residual vectors rest on copilot CLI semantics not
// verified in-repo (only builtin-bash filtering by __none__ is live-verified) —
// (a) a custom-MCP-config flag (e.g. --mcp-config) is NOT in the scrub set and
// whether __none__ also gates MCP-provided tools is unverified, and (b) flag
// matching here is exact/case-sensitive, so an alternate spelling copilot's
// parser might accept could slip past. Both require operator-controlled config
// (trusted in the threat model — the untrusted PROMPT reaches copilot only as
// the single `-p <prompt>` argv value and cannot alter argv/env/FIXED_ARGS), so
// neither is a prompt-driven bypass; folding either into the guarantee needs a
// live canary. See the pin-bump checklist (README).
// The profile also scrubs COPILOT_ALLOW_ALL (the env form of --allow-all-tools).
// test/headlessCopilotRunner.test.js regression-locks these flags.
import { spawn } from 'node:child_process';
import { FacadeError, estTokens, uuid } from './shared.js';

// Appended AFTER `-p <prompt>` (which must be adjacent — it's the prompt's value).
const FIXED_ARGS = [
  '--output-format', 'json',
  '--no-color',
  '--log-level', 'none',
  '--available-tools=__none__',
  '--disable-builtin-mcps',
  '--no-ask-user',
];

// Tool-exposure flags that, if set on profile.args, would relax the lockdown.
// Value-taking flags also consume a following ` <value>` token when not `=`-joined.
const EXPOSURE_VALUE_FLAGS = new Set(['--available-tools', '--allow-tool']);
const EXPOSURE_BOOL_FLAGS = new Set(['--allow-all-tools', '--allow-all', '--yolo']);

// Drop any operator-supplied tool-exposure flag so the runner's lockdown cannot
// be re-opened from config. Everything else passes through untouched.
function scrubToolExposureArgs(args) {
  const kept = [];
  const dropped = [];
  for (let i = 0; i < args.length; i++) {
    const tok = String(args[i]);
    const name = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok;
    if (EXPOSURE_BOOL_FLAGS.has(name)) { dropped.push(tok); continue; }
    if (EXPOSURE_VALUE_FLAGS.has(name)) {
      dropped.push(tok);
      // ` --available-tools bash` form: also swallow the separate value token.
      if (!tok.includes('=') && i + 1 < args.length && !String(args[i + 1]).startsWith('-')) dropped.push(String(args[++i]));
      continue;
    }
    kept.push(args[i]);
  }
  if (dropped.length) {
    console.warn(`headlessCopilotRunner: dropped tool-exposure flag(s) from a locked profile's args: ${dropped.join(' ')}`);
  }
  return kept;
}

export function runHeadlessCopilotTurn({ profile, resumeSessionId, userText, seedText = '', emit, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // Assign our own session id on the first turn; resume it thereafter.
    const assignedId = resumeSessionId || uuid();
    const fullPrompt = seedText ? `${seedText}\n\n${userText}` : userText;
    const args = ['-p', fullPrompt, ...FIXED_ARGS];
    if (resumeSessionId) args.push(`--resume=${resumeSessionId}`);
    else args.push('--session-id', assignedId);
    args.push(...scrubToolExposureArgs(profile.args));

    const env = { ...process.env };
    for (const k of profile.envScrub) delete env[k];
    // The profile table scrubs COPILOT_ALLOW_ALL (env form of --allow-all-tools),
    // but PROFILE_<NAME>_ENV_SCRUB can override that list from config — so delete
    // it unconditionally here, mirroring the argv scrub above: the lockdown must
    // not be reopenable from config in either channel.
    delete env.COPILOT_ALLOW_ALL;
    Object.assign(env, profile.envSet || {});

    let child;
    try {
      // stdin ignored: the prompt is an argv element, not piped (copilot -p).
      child = spawn(profile.command, args, { cwd: profile.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new FacadeError(500, 'api_error', `failed to spawn "${profile.command}": ${e.message}`,
        { spawn_error: String(e.message || e) }));
    }

    let finalText = null;
    let resultSessionId = null;
    let outputTokens = null;
    let inFinal = false;
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
    const timer = setTimeout(() => fail(new FacadeError(504, 'timeout', 'headless copilot turn timed out',
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
        switch (j.type) {
          case 'assistant.message_start':
            // Streaming deltas below are gated on this `final_answer` phase so
            // pre-answer (reasoning/tool) messages don't leak into the stream.
            // NOTE: this rides on `message_start.data.phase` — an event-shape
            // detail verified live on 1.0.75, re-verified on 1.0.76 (live-acceptance's streamed `DONG`
            // check exercises it) but NOT documented in the copilot spike. A bump
            // that changes THIS event's phase specifically leaves `inFinal` false,
            // so streaming clients get EMPTY content while the non-stream path
            // still works (it re-checks phase on `assistant.message` below). A
            // GLOBAL rename of the phase field/value instead breaks BOTH paths
            // (non-stream's finalText stays null → reject). Either way the offline
            // stub keeps passing, so re-verify the streamed canary on a pin bump.
            if (j.data && j.data.phase === 'final_answer') inFinal = true;
            break;
          case 'assistant.message_delta':
            if (inFinal && j.data && typeof j.data.deltaContent === 'string' && j.data.deltaContent.length) {
              emit({ type: 'delta', text: j.data.deltaContent });
            }
            break;
          case 'assistant.message':
            if (j.data && j.data.phase === 'final_answer') {
              // An absent/empty `content` yields '' (a valid empty turn) rather
              // than null, so the close handler's `finalText == null` guard still
              // distinguishes "answered emptily" from "never produced an answer"
              // — mirrors headlessClaudeRunner's `j.result ?? ''`.
              finalText = j.data.content ?? '';
              if (typeof j.data.outputTokens === 'number') outputTokens = j.data.outputTokens;
              inFinal = false;
            }
            break;
          case 'result':
            if (j.sessionId) resultSessionId = j.sessionId;
            break;
          default: break;
        }
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new FacadeError(500, 'api_error', `headless copilot exited with code ${code}`, { stderr: stderr.slice(-2000) }));
      if (finalText == null) return reject(new FacadeError(500, 'api_error', 'headless copilot produced no final_answer message', { stderr: stderr.slice(-2000) }));
      resolve({
        text: finalText,
        // Prefer the id the child reported; fall back to the one we assigned.
        resumeSessionId: resultSessionId || assignedId,
        // copilot reports a REAL output-token count (assistant.message.outputTokens)
        // but no per-turn INPUT count, so `input` is always a chars/4 estimate.
        // `estimated` is a single boolean over the whole usage object (dialects
        // surface bridge.usage_estimated only when it's truthy), so it stays TRUE:
        // unlike claude-headless — whose result event carries both real counts —
        // this object is never fully real. `output` keeps the real value when present.
        // Deliberate tradeoff: the flag is object-wide, not per-field, so a client
        // sees bridge.usage_estimated even though `output` is exact. Keeping one
        // boolean matches claude-headless's usage contract rather than splitting it.
        usage: {
          input: estTokens(fullPrompt.length),
          output: outputTokens != null ? outputTokens : estTokens(finalText.length),
          estimated: true,
        },
      });
    });
  });
}
