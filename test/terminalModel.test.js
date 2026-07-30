// test/terminalModel.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalModel } from '../src/terminalModel.js';

test('renders plain text and strips escape codes', async () => {
  const t = new TerminalModel({ cols: 80, rows: 24, scrollback: 1000 });
  const before = t.snapshotLineCount();
  await t.write('\x1b[32mgreen line\x1b[0m\r\nsecond line\r\n');
  const lines = t.renderLinesSince(before);
  assert.ok(lines.some(l => l.includes('green line')));
  assert.ok(lines.some(l => l.includes('second line')));
  assert.ok(!lines.join('\n').includes('\x1b'));
});

test('viewportTail returns last non-empty lines', async () => {
  const t = new TerminalModel({ cols: 80, rows: 24, scrollback: 1000 });
  await t.write('alpha\r\nbeta\r\ngamma\r\n> \r\n');
  assert.deepEqual(t.viewportTail(2), ['gamma', '>']);
  const tail = t.viewportTail(10);
  assert.deepEqual(tail, ['alpha', 'beta', 'gamma', '>']);
});

test('resize keeps the model usable and in sync with new geometry', async () => {
  const t = new TerminalModel({ cols: 80, rows: 10, scrollback: 1000 });
  assert.doesNotThrow(() => t.resize(100, 30));
  await t.write('after-resize\r\n');
  const tail = t.viewportTail(5);
  assert.ok(tail.includes('after-resize'));
  assert.ok(!tail.join('\n').includes('\x1b'));
});
