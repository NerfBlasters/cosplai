import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalModel } from '../src/terminalModel.js';
import { StreamRenderer } from '../src/facade/streamRenderer.js';
import { getAdapter } from '../src/adapters/index.js';

test('emits stabilized lines incrementally; finish returns full text + remainder', async () => {
  const tm = new TerminalModel({ cols: 120, rows: 30 });
  const generic = getAdapter('generic');
  const sr = new StreamRenderer({ terminalModel: tm, adapter: generic, sinceIndex: tm.snapshotLineCount() });
  await tm.write('echoed-input\r\n');
  assert.deepEqual(sr.tick(), []); // only the echoed line (dropped by generic) + partial
  await tm.write('line one\r\nline two\r\n');
  const t1 = sr.tick();
  assert.deepEqual(t1, ['line one']); // 'line two' is the last cleaned line — not stable yet
  await tm.write('line three\r\n');
  assert.deepEqual(sr.tick(), ['line two']);
  const { text, rest } = sr.finish();
  assert.equal(text, 'line one\nline two\nline three');
  assert.deepEqual(rest, ['line three']);
});

test('tick is idempotent when nothing new stabilized', async () => {
  const tm = new TerminalModel({ cols: 120, rows: 30 });
  const generic = getAdapter('generic');
  const sr = new StreamRenderer({ terminalModel: tm, adapter: generic, sinceIndex: tm.snapshotLineCount() });
  await tm.write('in\r\nonly line\r\n');
  const first = sr.tick();
  assert.deepEqual(sr.tick(), []);
  assert.deepEqual(sr.tick(), []);
  assert.deepEqual(first, []);
  const { text } = sr.finish();
  assert.equal(text, 'only line');
});

test('finish() never drops final content when mid-turn emissions diverge (repaint)', async () => {
  // Live claude failure (2026-07-24): a mid-turn repaint frame leaked chrome
  // through the incremental clean, inflating the emitted-line count; the
  // final clean render was SHORTER, so finish() sliced past the real reply
  // and the streamed deltas never contained it. finish() must emit the
  // authoritative tail from the first divergence point instead of slicing
  // blindly by count.
  const tm = new TerminalModel({ cols: 120, rows: 30 });
  const generic = getAdapter('generic');
  const sr = new StreamRenderer({ terminalModel: tm, adapter: generic, sinceIndex: tm.snapshotLineCount() });
  await tm.write('in\r\nchrome noise\r\npartial');
  assert.deepEqual(sr.tick(), ['chrome noise']); // diverging mid-turn emission
  await tm.write('\x1b[H\x1b[J');                // CLI repaints in place
  await tm.write('in\r\nREAL REPLY\r\n');
  const { text, rest } = sr.finish();
  assert.equal(text, 'REAL REPLY');
  assert.ok(['chrome noise', ...rest].join('\n').includes('REAL REPLY'),
    `stream must contain the authoritative reply; rest was ${JSON.stringify(rest)}`);
});

test('works through a chrome-stripping adapter', async () => {
  const tm = new TerminalModel({ cols: 120, rows: 30 });
  const claude = getAdapter('claude');
  const sr = new StreamRenderer({ terminalModel: tm, adapter: claude, sinceIndex: tm.snapshotLineCount() });
  await tm.write('● first paragraph\r\n\r\nsecond paragraph\r\n  ? for shortcuts\r\n');
  const { text } = sr.finish();
  assert.equal(text, 'first paragraph\n\nsecond paragraph');
});
