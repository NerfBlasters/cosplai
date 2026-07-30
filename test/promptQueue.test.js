import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromptQueue } from '../src/promptQueue.js';

test('runs in FIFO order, serialized', async () => {
  const q = new PromptQueue();
  const order = [];
  const mk = (n, ms) => () => new Promise(r => setTimeout(() => { order.push(n); r(n); }, ms));
  const p1 = q.enqueue(mk(1, 30));
  const p2 = q.enqueue(mk(2, 5));
  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2]);
});
