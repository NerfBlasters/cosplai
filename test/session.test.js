import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/session.js';

const once = (em, ev) => new Promise(r => em.once(ev, r));

test('spawns, echoes input, buffers scrollback, exits', async () => {
  const s = new Session({ command: 'cat', args: [], cwd: process.cwd() });
  assert.ok(s.id);
  assert.equal(s.alive, true);
  let out = '';
  s.on('data', d => { out += d; });
  s.write('hello\n');
  await new Promise(r => setTimeout(r, 200));
  assert.match(out, /hello/);
  assert.match(s.scrollback(), /hello/);
  const exited = once(s, 'exit');
  s.kill();
  await exited;
  assert.equal(s.alive, false);
});

test('envScrub option strips the listed key (was hardcoded ANTHROPIC scrub)', async () => {
  const s = new Session({ command: 'bash', args: ['-lc', 'echo KEY=[$ANTHROPIC_API_KEY]'],
    cwd: process.cwd(), env: { ...process.env, ANTHROPIC_API_KEY: 'sk-should-be-gone' },
    envScrub: ['ANTHROPIC_API_KEY'] });
  let out = '';
  s.on('data', d => { out += d; });
  await once(s, 'exit');
  assert.match(out, /KEY=\[\]/);
});

test('without envScrub, env passes through unchanged', async () => {
  const s = new Session({ command: 'bash', args: ['-lc', 'echo TOK=[$ANTHROPIC_AUTH_TOKEN]'],
    cwd: process.cwd(), env: { ...process.env, ANTHROPIC_AUTH_TOKEN: 'kept' } });
  let out = '';
  s.on('data', d => { out += d; });
  await once(s, 'exit');
  assert.match(out, /TOK=\[kept\]/);
});

// ADD (new envScrub-mechanism test, unrelated to ANTHROPIC naming):
test('envScrub option removes an arbitrary listed key from the child env', async () => {
  const s = new Session({
    command: 'bash', args: ['-lc', 'echo V=[${SCRUB_ME:-gone}]'],
    cwd: process.cwd(), env: { ...process.env, SCRUB_ME: 'leaky' }, envScrub: ['SCRUB_ME'],
  });
  let out = '';
  s.on('data', d => { out += d; });
  await once(s, 'exit');
  assert.match(out, /V=\[gone\]/);
});

test('ring buffer is bounded to ringBytes and keeps the tail', async () => {
  const s = new Session({ command: 'bash', args: ['-lc', 'printf "%s" 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    cwd: process.cwd(), ringBytes: 8 });
  await once(s, 'exit');
  await new Promise(r => setTimeout(r, 50));
  const sb = s.scrollback();
  assert.ok(Buffer.byteLength(sb) <= 8, `scrollback ${Buffer.byteLength(sb)} bytes > cap`);
  assert.ok(sb === 'TUVWXYZ' || 'STUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.endsWith(sb), `tail was ${JSON.stringify(sb)}`);
});

test('write/resize/kill after exit do not throw', async () => {
  const s = new Session({ command: 'bash', args: ['-lc', 'true'], cwd: process.cwd() });
  await once(s, 'exit');
  assert.equal(s.alive, false);
  assert.doesNotThrow(() => { s.write('x'); s.resize(10, 10); s.kill(); });
});

test('envSet lands in the child env after scrub', async () => {
  const s = new Session({
    command: 'bash', args: ['-lc', 'echo "AU=${DISABLE_AUTOUPDATER:-unset}"'],
    cwd: process.cwd(), envScrub: [], envSet: { DISABLE_AUTOUPDATER: '1' },
  });
  let out = '';
  s.on('data', d => { out += d; });
  await once(s, 'exit');
  assert.match(out, /AU=1/);
});
