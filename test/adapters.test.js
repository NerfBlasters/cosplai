// test/adapters.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getAdapter } from '../src/adapters/index.js';
import { TerminalModel } from '../src/terminalModel.js';

// ---- generic adapter ----

test('generic adapter: quiescence means idle, never awaiting input', () => {
  const a = getAdapter('generic');
  assert.equal(a.name, 'generic');
  assert.equal(a.isIdle(['anything']), true);
  assert.equal(a.isIdle([]), true);
  assert.equal(a.isAwaitingInput(['anything']), false);
  assert.equal(a.describePrompt(['anything']), null);
});

test('generic adapter: key map', () => {
  const a = getAdapter('generic');
  assert.equal(a.keySeq('enter'), '\r');
  assert.equal(a.keySeq('submit'), '\r');
  assert.equal(a.keySeq('up'), '\x1b[A');
  assert.equal(a.keySeq('down'), '\x1b[B');
  assert.equal(a.keySeq('left'), '\x1b[D');
  assert.equal(a.keySeq('right'), '\x1b[C');
  assert.equal(a.keySeq('esc'), '\x1b');
  assert.equal(a.keySeq('tab'), '\t');
  assert.equal(a.keySeq('ctrl-c'), '\x03');
  assert.equal(a.keySeq('x'), 'x');
  assert.equal(a.keySeq('hello'), 'hello');
});

// ---- claude adapter: fixture-driven ----
// Fixtures are RAW PTY bytes (test/fixtures/*.txt, see NOTES.md). They must be
// rendered through TerminalModel (backed by @xterm/headless) before matching —
// raw-byte regex matching is documented as unreliable (fragmented across
// cursor-jump escapes on incremental redraws; see NOTES.md "Critical
// architecture finding").

test('claude adapter: idle fixture classifies as idle, not awaiting input', async () => {
  const a = getAdapter('claude');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/claude-idle.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.isIdle(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isAwaitingInput(tail), false);
  assert.equal(a.describePrompt(tail), null);
});

test('claude adapter: trust dialog fixture classifies as awaiting input, not idle', async () => {
  const a = getAdapter('claude');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/claude-trust.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.isAwaitingInput(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isIdle(tail), false);
  assert.notEqual(a.describePrompt(tail), null);
  assert.ok(a.describePrompt(tail).includes('Quick safety check'));
});

test('claude adapter: completed-response fixture classifies as idle again', async () => {
  const a = getAdapter('claude');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/claude-response.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.isIdle(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isAwaitingInput(tail), false);
});

test('claude adapter: mid-generation (busy) frame is not idle and not awaiting input', async () => {
  // Derived from the checked-in claude-response.txt fixture (not a fabricated
  // marker): the raw capture spans typing -> submit -> busy/spinner -> completed
  // response. NOTES.md documents the "esc to interrupt" footer fragment as
  // occurring within this file's byte stream while the spinner is active
  // (offsets ~1289/~3749 of 4478 bytes), before the footer reverts back to
  // "? for shortcuts" near the end of the file (offset ~4352). Truncating the
  // real bytes to a prefix that ends inside that window renders the genuine
  // mid-generation footer without inventing any new marker text.
  const a = getAdapter('claude');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  const full = fs.readFileSync('test/fixtures/claude-response.txt');
  const busyPrefix = full.subarray(0, 4000); // ends before the "? for shortcuts" revert at ~4352
  await t.write(busyPrefix);
  const tail = t.viewportTail(8);
  assert.ok(tail.some(l => /esc to interrupt/.test(l)), `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isIdle(tail), false, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isAwaitingInput(tail), false);
});

test('claude adapter: key map matches generic base, submit is \\r', () => {
  const a = getAdapter('claude');
  assert.equal(a.name, 'claude');
  assert.equal(a.keySeq('enter'), '\r');
  assert.equal(a.keySeq('submit'), '\r');
  assert.equal(a.keySeq('up'), '\x1b[A');
  assert.equal(a.keySeq('down'), '\x1b[B');
  assert.equal(a.keySeq('esc'), '\x1b');
  assert.equal(a.keySeq('tab'), '\t');
  assert.equal(a.keySeq('ctrl-c'), '\x03');
  assert.equal(a.keySeq('hello'), 'hello');
});

// ---- getAdapter ----

test('getAdapter: strict registry — known names resolve, unknown names throw', () => {
  assert.equal(getAdapter('generic').name, 'generic');
  assert.equal(getAdapter('claude').name, 'claude');
  assert.throws(() => getAdapter('unknown-thing'), /unknown adapter "unknown-thing"/);
});

// ---- Phase 1 contract growth ----

test('claude adapter: isBusy true on busy frame, false on idle frame', async () => {
  const a = getAdapter('claude');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  const full = fs.readFileSync('test/fixtures/claude-response.txt');
  await t.write(full.subarray(0, 4000)); // mid-generation window (see busy test above)
  assert.equal(a.isBusy(t.viewportTail(8)), true);
  const t2 = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t2.write(fs.readFileSync('test/fixtures/claude-idle.txt'));
  assert.equal(a.isBusy(t2.viewportTail(8)), false);
});

test('claude adapter: startupDialogs matches the trust dialog, answers with enter', async () => {
  const a = getAdapter('claude');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/claude-trust.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.startupDialogs.length >= 1, true);
  const hit = a.startupDialogs.find((d) => d.matcher(tail));
  assert.ok(hit, `no startupDialogs entry matched: ${JSON.stringify(tail)}`);
  assert.deepEqual(hit.answerKeys, ['enter']);
  // idle screen must NOT match
  const t2 = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t2.write(fs.readFileSync('test/fixtures/claude-idle.txt'));
  assert.equal(a.startupDialogs.some((d) => d.matcher(t2.viewportTail(8))), false);
});

test('claude adapter: extractResponse strips chrome, keeps the assistant reply', async () => {
  const a = getAdapter('claude');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/claude-response.txt'));
  const lines = t.renderLinesSince(0);
  const text = a.extractResponse(lines);
  assert.ok(text.includes('PONG'), `text was: ${JSON.stringify(text)}`);
  assert.ok(!/\? for shortcuts|esc to interrupt/.test(text), `text was: ${JSON.stringify(text)}`);
  assert.ok(!text.includes('❯'), `text was: ${JSON.stringify(text)}`);
  assert.ok(!/^\s*─+\s*$/m.test(text), `text was: ${JSON.stringify(text)}`);
});

test('generic adapter: extractResponse = identity minus echoed first line; multiline raw', () => {
  const a = getAdapter('generic');
  assert.equal(a.multiline, 'raw');
  assert.equal(a.extractResponse(['echo hi', 'hi', 'prompt$']), 'hi\nprompt$');
  assert.equal(a.extractResponse(['only-line']), 'only-line');
  assert.equal(a.extractResponse([]), '');
});

// ---- codex adapter: fixture-driven (see NOTES.md "Codex CLI") ----

test('codex adapter: idle fixture classifies as idle', async () => {
  const a = getAdapter('codex');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/codex-idle.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.isIdle(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isAwaitingInput(tail), false);
  assert.equal(a.isBusy(tail), false);
});

test('codex adapter: busy frame is busy, not idle', async () => {
  const a = getAdapter('codex');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/codex-busy.txt')); // or the NOTES-recorded response-prefix
  const tail = t.viewportTail(8);
  assert.equal(a.isBusy(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isIdle(tail), false);
});

test('codex adapter: completed response classifies idle and extractResponse strips chrome', async () => {
  const a = getAdapter('codex');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/codex-response.txt'));
  assert.equal(a.isIdle(t.viewportTail(8)), true);
  const text = a.extractResponse(t.renderLinesSince(0));
  assert.ok(text.includes('PONG'), `text was: ${JSON.stringify(text)}`);
  // Negative assertions must use CODEX-fixture chrome recorded in NOTES §Codex —
  // NOT copied claude glyphs (a claude '❯' check passes vacuously if codex uses a
  // different input marker, letting an empty-CHROME adapter slip through). Replace
  // the two placeholders below with the exact idle-footer text and input-box
  // marker Task 9 verified for codex; assert the extracted reply contains neither.
  assert.ok(!/·\s+Ready\s+·/.test(text), `text was: ${JSON.stringify(text)}`);
  assert.ok(!/^›/m.test(text), `text was: ${JSON.stringify(text)}`);
});

test('codex adapter: update dialog classifies as awaiting_input with a safe skip answer', async () => {
  // Observed live 2026-07-24 (codex 0.134.0 prompting to update to 0.145.0):
  // the dialog blocks the whole session at startup and its DEFAULT option runs
  // `npm install -g` — so it must (a) read as awaiting_input, never busy/idle,
  // and (b) be auto-answerable ONLY with the skip-until-next-version option,
  // never a bare Enter that would trigger the install.
  const a = getAdapter('codex');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/codex-update-dialog.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.isAwaitingInput(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isIdle(tail), false);
  assert.ok(a.describePrompt(tail), 'dialog must be describable for the 409 bridge.dialog field');
  const entry = (a.startupDialogs || []).find((d) => d.matcher(tail));
  assert.ok(entry, 'startupDialogs must recognize the update dialog');
  assert.deepEqual(entry.answerKeys, ['3'], 'answer must be "3. Skip until next version", never Enter');
});

test('codex adapter: update-dialog markers do not false-positive on other fixtures', async () => {
  const a = getAdapter('codex');
  for (const fx of ['codex-idle.txt', 'codex-busy.txt', 'codex-response.txt', 'codex-boot.txt']) {
    const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
    await t.write(fs.readFileSync(`test/fixtures/${fx}`));
    const tail = t.viewportTail(8);
    const entry = (a.startupDialogs || []).filter((d) => d.matcher(tail));
    // codex-boot.txt legitimately matches the trust dialog entry; no fixture
    // may match the update entry (answerKeys ['3']).
    assert.ok(!entry.some((d) => d.answerKeys && d.answerKeys[0] === '3'),
      `${fx} must not match the update dialog`);
  }
});

test('codex adapter: key map baseline', () => {
  const a = getAdapter('codex');
  assert.equal(a.name, 'codex');
  assert.equal(a.keySeq('enter'), '\r');
  assert.equal(a.keySeq('submit'), '\r'); // adjust ONLY if NOTES recorded a different submit key
  assert.equal(a.keySeq('esc'), '\x1b');
  assert.equal(a.keySeq('hello'), 'hello');
});

// ---- antigravity adapter (agy): fixture-driven, DEGRADED/alt-screen (NOTES §Antigravity) ----

test('antigravity adapter: idle fixture classifies as idle', async () => {
  const a = getAdapter('antigravity');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/antigravity-idle.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.isIdle(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isAwaitingInput(tail), false);
  assert.equal(a.isBusy(tail), false);
});

test('antigravity adapter: mid-generation (Generating) frame is busy, not idle', async () => {
  // Gemini Flash is fast, so the busy frame lives only mid-stream: render a
  // PREFIX of the span capture up to the Generating window (see NOTES §Antigravity).
  const a = getAdapter('antigravity');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  const full = fs.readFileSync('test/fixtures/antigravity-busy.txt');
  await t.write(full.subarray(0, 5897));
  const tail = t.viewportTail(8);
  assert.equal(a.isBusy(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isIdle(tail), false);
});

test('antigravity adapter: completed response classifies idle; extractResponse (best-effort) finds PONG', async () => {
  const a = getAdapter('antigravity');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/antigravity-response.txt'));
  assert.equal(a.isIdle(t.viewportTail(8)), true);
  const text = a.extractResponse(t.renderLinesSince(0));
  assert.ok(text.includes('PONG'), `text was: ${JSON.stringify(text)}`);
  // best-effort chrome strip: no idle footer, no echoed input-box line
  assert.ok(!/\?\s*for shortcuts/.test(text), `text was: ${JSON.stringify(text)}`);
  assert.ok(!text.split('\n').some((l) => l.startsWith('>')), `text was: ${JSON.stringify(text)}`);
});

test('antigravity adapter: trust dialog classifies as awaiting_input, answerKeys enter', async () => {
  const a = getAdapter('antigravity');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/antigravity-boot.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.isAwaitingInput(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isIdle(tail), false);
  const hit = a.startupDialogs.find((d) => d.matcher(tail));
  assert.ok(hit, 'trust dialog should match a startupDialogs entry');
  assert.deepEqual(hit.answerKeys, ['enter']);
});

test('antigravity adapter: key map baseline', () => {
  const a = getAdapter('antigravity');
  assert.equal(a.name, 'antigravity');
  assert.equal(a.keySeq('enter'), '\r');
  assert.equal(a.keySeq('submit'), '\r');
  assert.equal(a.keySeq('esc'), '\x1b');
  assert.equal(a.keySeq('hello'), 'hello');
});

// ---- copilot adapter: fixture-driven, VERIFIED (gh-keyring auth), DEGRADED/alt-screen (NOTES §Copilot) ----

test('copilot adapter: idle fixture classifies as idle', async () => {
  const a = getAdapter('copilot');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/copilot-idle.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.isIdle(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isAwaitingInput(tail), false);
  assert.equal(a.isBusy(tail), false);
});

test('copilot adapter: busy frame is busy, not idle', async () => {
  const a = getAdapter('copilot');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/copilot-busy.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.isBusy(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isIdle(tail), false);
});

test('copilot adapter: completed response classifies idle; extractResponse (best-effort) finds PONG', async () => {
  const a = getAdapter('copilot');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/copilot-response.txt'));
  assert.equal(a.isIdle(t.viewportTail(8)), true);
  const text = a.extractResponse(t.renderLinesSince(0));
  assert.ok(text.includes('PONG'), `text was: ${JSON.stringify(text)}`);
  assert.ok(!/\/ commands · \? help/.test(text), `text was: ${JSON.stringify(text)}`);
  assert.ok(!text.split('\n').some((l) => l.trim().startsWith('❯')), `text was: ${JSON.stringify(text)}`);
});

test('copilot adapter: folder-trust dialog classifies as awaiting_input, answerKeys enter', async () => {
  const a = getAdapter('copilot');
  const t = new TerminalModel({ cols: 120, rows: 30, scrollback: 5000 });
  await t.write(fs.readFileSync('test/fixtures/copilot-boot.txt'));
  const tail = t.viewportTail(8);
  assert.equal(a.isAwaitingInput(tail), true, `tail was: ${JSON.stringify(tail)}`);
  assert.equal(a.isIdle(tail), false);
  const hit = a.startupDialogs.find((d) => d.matcher(tail));
  assert.ok(hit, 'trust dialog should match a startupDialogs entry');
  assert.deepEqual(hit.answerKeys, ['enter']);
});

test('copilot adapter: key map baseline and full contract present', () => {
  const a = getAdapter('copilot');
  assert.equal(a.name, 'copilot');
  assert.equal(a.keySeq('enter'), '\r');
  assert.equal(a.keySeq('submit'), '\r');
  assert.equal(a.keySeq('esc'), '\x1b');
  assert.equal(typeof a.isBusy, 'function');
  assert.equal(typeof a.extractResponse, 'function');
});

// ---- Phase 2 Task 1: blank-line-preserving extractResponse ----

test('claude extractResponse preserves paragraph breaks', () => {
  const a = getAdapter('claude');
  const lines = [
    '> do the thing',
    '',
    '● First paragraph line one',
    '  still first paragraph',
    '',
    '  second paragraph',
    '',
    '',
    '  third paragraph after a double blank',
    '',
    '  ? for shortcuts · ← for agents',
  ];
  const out = a.extractResponse(lines);
  assert.equal(out,
    'First paragraph line one\n  still first paragraph\n\n  second paragraph\n\n  third paragraph after a double blank');
});

test('claude extractResponse: chrome between paragraphs does not add blanks', () => {
  const a = getAdapter('claude');
  const out = a.extractResponse(['para one', '', 'esc to interrupt', '', 'para two']);
  assert.equal(out, 'para one\n\npara two');
});

test('codex extractResponse preserves paragraph breaks and strips block marker', () => {
  const a = getAdapter('codex');
  const out = a.extractResponse(['› ping', '• first', '', 'second', '']);
  assert.equal(out, 'first\n\nsecond');
});

test('antigravity extractResponse preserves paragraph breaks', () => {
  const a = getAdapter('antigravity');
  const out = a.extractResponse(['first', '', 'second', '  ? for shortcuts']);
  assert.equal(out, 'first\n\nsecond');
});

test('copilot extractResponse preserves paragraph breaks', () => {
  const a = getAdapter('copilot');
  const out = a.extractResponse(['● first', '', 'second', '/ commands · ? help · tab next tab']);
  assert.equal(out, 'first\n\nsecond');
});
