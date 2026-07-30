import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkToken, extractToken } from '../src/auth.js';

test('checkToken accepts equal, rejects unequal/null/length-mismatch', () => {
  assert.equal(checkToken('secret', 'secret'), true);
  assert.equal(checkToken('secret', 'secretx'), false);
  assert.equal(checkToken('wrong0', 'secret'), false); // same length, differ
  assert.equal(checkToken(null, 'secret'), false);
  assert.equal(checkToken('secret', null), false);
});

test('extractToken reads header then query', () => {
  assert.equal(extractToken({ headers: { authorization: 'Bearer xyz' }, url: '/x' }), 'xyz');
  assert.equal(extractToken({ headers: {}, url: '/x?token=qq' }), 'qq');
  assert.equal(extractToken({ headers: {}, url: '/x' }), null);
});
