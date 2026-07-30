import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVersions, applyStrict } from '../src/versionCheck.js';

const profiles = {
  claude: { name: 'claude', command: '/v/claude', baseCommand: 'claude' },
  'claude-headless': { name: 'claude-headless', command: '/v/claude', baseCommand: 'claude' },
  codex: { name: 'codex', command: 'codex', baseCommand: 'codex' },
  generic: { name: 'generic', command: null, baseCommand: null },
};
const pins = {
  claude: { source: 'npm', package: 'x', version: '2.1.219' },
  codex: { source: 'npm', package: 'y', version: '0.134.0' },
};
const silent = { log: () => {}, warn: () => {} };

test('handshake: match ok, mismatch flagged, one exec per shared binary', async () => {
  const calls = [];
  const exec = async (p) => { calls.push(p); return { err: null, out: p === '/v/claude' ? '2.1.219 (Claude Code)' : 'codex-cli 0.999.0' }; };
  const r = await checkVersions(profiles, pins, { exec, log: silent });
  assert.equal(calls.length, 2); // claude execs once despite two profiles sharing it
  assert.equal(r.results.find((x) => x.command === 'claude').ok, true);
  assert.deepEqual(r.results.find((x) => x.command === 'claude').profiles.sort(), ['claude', 'claude-headless']);
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0].command, 'codex');
  assert.equal(r.mismatches[0].got, '0.999.0');
});

test('handshake: same baseCommand resolved to different paths checks both binaries', async () => {
  const split = {
    claude: { name: 'claude', command: 'claude', baseCommand: 'claude' },          // explicit host override
    'claude-headless': { name: 'claude-headless', command: '/v/claude', baseCommand: 'claude' }, // vendored
  };
  const calls = [];
  const exec = async (p) => { calls.push(p); return { err: null, out: p === '/v/claude' ? '2.1.219' : '2.1.300' }; };
  const r = await checkVersions(split, pins, { exec, log: silent });
  assert.deepEqual(calls.sort(), ['/v/claude', 'claude']);
  assert.equal(r.results.length, 2);
  assert.equal(r.mismatches.length, 1);          // the host one drifted
  assert.equal(r.mismatches[0].path, 'claude');
});

test('handshake: exec failure tolerated -> mismatch with got=null', async () => {
  const exec = async () => ({ err: new Error('ENOENT'), out: '' });
  const r = await checkVersions(profiles, pins, { exec, log: silent });
  assert.equal(r.mismatches.length, 2);
  assert.ok(r.mismatches.every((m) => m.got === null));
});

test('handshake: commands without a pin are skipped', async () => {
  const r = await checkVersions(profiles, {}, { exec: async () => { throw new Error('must not exec'); }, log: silent });
  assert.deepEqual(r.results, []);
  assert.deepEqual(r.mismatches, []);
});

test('applyStrict throws listing every mismatch; passes on clean report', () => {
  assert.throws(
    () => applyStrict({ mismatches: [{ command: 'codex', wanted: '0.134.0', got: '0.999.0', path: 'codex' }] }),
    /codex: wanted 0\.134\.0, got 0\.999\.0/,
  );
  applyStrict({ mismatches: [] }); // no throw
});
