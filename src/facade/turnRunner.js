// src/facade/turnRunner.js
// The PTY TurnRunner (spec "TurnRunner seam"): enqueueing happens in the
// router; this function runs ONE turn against an already-acquired session
// record. markBusy → multiline-safe write + submit → StreamRenderer emits
// newly-stabilized cleaned lines as deltas on a fixed tick → on settle,
// resolve with the full cleaned text and chars/4-estimated usage.
//
// The suspect gate (spec Error handling): a settle timeout leaves the CLI in
// an unknown mid-turn state, so the record is flagged and the NEXT turn (here
// and in httpApi.sendPrompt) must wait for a confirmed settle before typing —
// this is what stops a timed-out prompt's successor interleaving into a
// still-busy CLI.
import { writeAndSubmitPrompt, MultilineUnsupportedError } from '../promptWriter.js';
import { StreamRenderer } from './streamRenderer.js';
import { FacadeError, estTokens } from './shared.js';

const TICK_MS = 100;

function settleError(e, record) {
  if (/settle timeout/.test(String((e && e.message) || e))) {
    record.suspect = true;
    return new FacadeError(504, 'timeout', 'the CLI did not settle within the bridge prompt timeout');
  }
  // Session exited mid-turn. Carry a real diagnostic (spec: Models / Error
  // handling — the bridge field should describe the failure), reading from the
  // raw ring buffer, which is updated synchronously on each data chunk (no
  // render race). node-pty writes an exec diagnostic to the PTY when the
  // command itself can't be run — a process that dies carrying such a message
  // never started, so surface it as a spawn error (a mistyped
  // PROFILE_<NAME>_COMMAND is then diagnosable) rather than an opaque exit.
  const exit = record.session.exitInfo || {};
  const raw = typeof record.session.scrollback === 'function' ? record.session.scrollback() : '';
  // Only scan the tail: a startup/spawn failure's exec diagnostic is the
  // dying output, right before exit. Scanning the whole session-lifetime ring
  // would false-positive if an earlier turn's transcript incidentally echoed a
  // shell error ("no such file", "command not found").
  const tail = raw.length > 2048 ? raw.slice(-2048) : raw;
  const bridge = { reason: 'session_exited', exit_code: exit.exitCode ?? null, signal: exit.signal ?? null };
  const m = /execvp\(\d+\) failed[^\r\n]*|exec[^\r\n]* failed[^\r\n]*|command not found[^\r\n]*|no such file[^\r\n]*|cannot execute[^\r\n]*/i.exec(tail);
  let message = 'the CLI session exited mid-turn';
  if (m) {
    bridge.spawn_error = m[0].trim();
    message = `the CLI process failed to start: ${bridge.spawn_error}`;
  }
  const err = new FacadeError(500, 'api_error', message, bridge);
  err.sessionExited = true;
  return err;
}

function dialogOutcome(record, sinceIndex) {
  const tail = record.terminalModel.viewportTail(8);
  return { dialog: { promptText: record.adapter.describePrompt(tail) || tail.join('\n'), sinceIndex } };
}

export async function runPtyTurn({ record, userText, seedText = '', emit, timeoutMs }) {
  const det = record.detector;
  if (record.suspect) {
    try { await det.waitForSettle({ timeoutMs }); } catch (e) { throw settleError(e, record); }
    record.suspect = false;
  }
  // A freshly spawned CLI is still starting up (banner, trust dialog): typing
  // now races the startup screen — a dialog consumes the buffered submit
  // Enter, stranding the prompt in the composer, where neither the busy nor
  // the idle marker renders, so the turn can never settle (observed live
  // against claude 2.1.219 and codex 0.134.0). Wait for a confirmed settle
  // before the first keystroke; a dialog the session's policy doesn't
  // auto-answer then surfaces through the awaiting_input path below.
  if (det.state !== 'idle' && det.state !== 'awaiting_input') {
    try { await det.waitForSettle({ timeoutMs }); } catch (e) { throw settleError(e, record); }
  }
  if (det.state === 'awaiting_input') {
    // A surfaced dialog is blocking this session; never type into it.
    return dialogOutcome(record, record.terminalModel.snapshotLineCount());
  }
  // KNOWN LIMITATION (multiline:'raw' profiles): the seed preamble is
  // multi-line, and writePromptText delivers it verbatim. Facade seeding
  // assumes a coalescing CLI — one whose line editor absorbs a bracketed-paste
  // block as a single prompt (the real claude/codex/etc. binaries do this;
  // that assumption is not exercised by the bash fixtures here). Such a CLI
  // answers the seed+question once, which is the supported path. A genuinely
  // line-oriented `generic`/raw CLI instead submits each seed line as its own
  // command — so the `generic` profile is a poor stateful-conversation backend
  // (to be documented in the README, Task 14).
  const full = seedText ? `${seedText}\n\n${userText}` : userText;
  const sinceIndex = record.terminalModel.snapshotLineCount();
  det.markBusy();
  try {
    await writeAndSubmitPrompt(record.session, record.adapter, full);
  } catch (e) {
    if (e instanceof MultilineUnsupportedError) throw new FacadeError(400, 'invalid_request', String(e.message));
    throw e;
  }
  // Re-arm after the submit: during the SUBMIT_DELAY_MS gap the echoed text
  // goes quiet, and a profile with quiescenceMs <= the gap can evaluate and
  // settle to idle (composer text keeps codex's Ready footer visible) before
  // the \r lands — waitForSettle would then resolve instantly with no reply.
  det.markBusy();

  const renderer = new StreamRenderer({ terminalModel: record.terminalModel, adapter: record.adapter, sinceIndex });
  let first = true;
  const flush = (lines) => {
    for (const l of lines) { emit({ type: 'delta', text: (first ? '' : '\n') + l }); first = false; }
  };
  const iv = setInterval(() => flush(renderer.tick()), TICK_MS);

  let state;
  try {
    state = await det.waitForSettle({ timeoutMs });
  } catch (e) {
    throw settleError(e, record);
  } finally {
    clearInterval(iv);
  }

  if (state === 'awaiting_input') return dialogOutcome(record, sinceIndex);

  const { text, rest } = renderer.finish();
  if (rest.length) flush(rest.length === 1 ? rest : [rest.join('\n')]);
  return { text, usage: { input: estTokens(full.length), output: estTokens(text.length), estimated: true } };
}
