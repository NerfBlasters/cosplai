import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPins, validatePins, npmDepsFromPins, extractVersion } from '../src/pins.js';

test('extractVersion pulls the first x.y.z token', () => {
  assert.equal(extractVersion('2.1.219 (Claude Code)'), '2.1.219');
  assert.equal(extractVersion('codex-cli 0.134.0\n'), '0.134.0');
  assert.equal(extractVersion('no version here'), null);
  assert.equal(extractVersion(null), null);
});

test('loadPins: missing file returns empty object', () => {
  assert.deepEqual(loadPins(path.join(tmpdir(), 'nope-does-not-exist.json')), {});
});

test('loadPins: invalid JSON throws with file context', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pins-'));
  const f = path.join(dir, 'cli-pins.json');
  writeFileSync(f, '{nope');
  assert.throws(() => loadPins(f), /invalid JSON/);
});

test('validatePins rejects keys that are not bare command names', () => {
  assert.throws(() => validatePins({ '../evil': { source: 'external', version: '1.0.0' } }), /bare command name/);
  assert.throws(() => validatePins({ 'a/b': { source: 'external', version: '1.0.0' } }), /bare command name/);
  assert.throws(() => validatePins({ '.hidden': { source: 'external', version: '1.0.0' } }), /bare command name/);
});

test('validatePins rejects bad source, bad version, missing npm package', () => {
  assert.throws(() => validatePins({ x: { source: 'brew', version: '1.0.0' } }), /source/);
  assert.throws(() => validatePins({ x: { source: 'npm', package: 'p', version: '1.0' } }), /version/);
  assert.throws(() => validatePins({ x: { source: 'npm', version: '1.0.0' } }), /package/);
  assert.throws(() => validatePins([]), /object/);
});

test('validatePins accepts the shipped manifest shape; npmDepsFromPins maps npm entries only', () => {
  const pins = validatePins({
    claude: { source: 'npm', package: '@anthropic-ai/claude-code', version: '2.1.219' },
    agy: { source: 'external', version: '1.1.6' },
  });
  assert.deepEqual(npmDepsFromPins(pins), { '@anthropic-ai/claude-code': '2.1.219' });
});

test('loadPins validates the committed repo manifest', () => {
  const pins = loadPins();
  assert.ok(pins.claude && pins.claude.source === 'npm');
  assert.ok(pins.agy && pins.agy.source === 'external');
});
