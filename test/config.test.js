import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

test('defaults apply when env empty', () => {
  const c = loadConfig({});
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 7681);
  assert.equal(c.claudeCmd, 'claude');
  assert.equal(c.adapter, 'claude');
  assert.ok(c.token && c.token.length >= 16);
  assert.equal(c.tokenGenerated, true);
});

test('env overrides and CLAUDE_ARGS parses JSON', () => {
  const c = loadConfig({ PORT: '9000', BRIDGE_TOKEN: 'abc', CLAUDE_ARGS: '["--foo"]', ADAPTER: 'generic' });
  assert.equal(c.port, 9000);
  assert.equal(c.token, 'abc');
  assert.equal(c.tokenGenerated, false);
  assert.deepEqual(c.claudeArgs, ['--foo']);
  assert.equal(c.adapter, 'generic');
});

test('config is frozen', () => {
  const c = loadConfig({});
  assert.throws(() => { c.port = 1; });
});

test('non-array JSON CLAUDE_ARGS becomes []', () => {
  const c = loadConfig({ CLAUDE_ARGS: '"--foo"' });
  assert.deepEqual(c.claudeArgs, []);
});

test('number CLAUDE_ARGS becomes []', () => {
  const c = loadConfig({ CLAUDE_ARGS: '42' });
  assert.deepEqual(c.claudeArgs, []);
});

test('empty PORT env uses default', () => {
  const c = loadConfig({ PORT: '' });
  assert.equal(c.port, 7681);
});

test('claudeArgs is frozen', () => {
  const c = loadConfig({});
  assert.throws(() => { c.claudeArgs.push('x'); });
});

// ---- profiles (Phase 1: universal CLI support) ----

test('profiles: built-ins present with commands, adapters, scrub lists', () => {
  // NO_VENDOR: assert host-name commands even when a real vendor/ is populated
  const c = loadConfig({}, { vendorDir: path.join(tmpdir(), 'no-such-vendor') });
  assert.deepEqual(
    Object.keys(c.profiles).sort(),
    ['antigravity', 'claude', 'claude-headless', 'codex', 'copilot', 'copilot-headless', 'generic'],
  );
  assert.equal(c.profiles.claude.command, 'claude');
  assert.equal(c.profiles.claude.adapter, 'claude');
  assert.deepEqual(c.profiles.claude.envScrub, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  assert.equal(c.profiles.codex.command, 'codex');
  assert.deepEqual(c.profiles.codex.envScrub, ['OPENAI_API_KEY', 'CODEX_API_KEY']);
  // The Google CLI profile targets Antigravity (`agy`) — the `gemini` CLI's
  // OAuth was sunset for individual accounts. envScrub keeps the Google/Gemini
  // key vars as best-effort.
  assert.equal(c.profiles.antigravity.command, 'agy');
  assert.equal(c.profiles.antigravity.adapter, 'antigravity');
  assert.deepEqual(c.profiles.antigravity.envScrub, [
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_LOCATION',
  ]);
  assert.deepEqual(c.profiles.copilot.envScrub, ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_ALLOW_ALL']);
  assert.equal(c.profiles['claude-headless'].mode, 'headless');
  assert.equal(c.profiles['claude-headless'].adapter, null);
  assert.equal(c.profiles['claude-headless'].headlessRunner, 'claude');
  // copilot-headless: first-class facade profile driven by the copilot runner.
  assert.equal(c.profiles['copilot-headless'].command, 'copilot');
  assert.equal(c.profiles['copilot-headless'].mode, 'headless');
  assert.equal(c.profiles['copilot-headless'].adapter, null);
  assert.equal(c.profiles['copilot-headless'].headlessRunner, 'copilot');
  assert.deepEqual(c.profiles['copilot-headless'].envScrub, ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_ALLOW_ALL']);
  assert.equal(c.profiles.copilot.headlessRunner, null);
  assert.equal(c.profiles.generic.command, null);
  assert.equal(c.defaultProfile, 'claude');
  assert.equal(c.profiles.claude.dialogPolicy, 'startup-only');
  assert.equal(c.profiles.claude.mode, 'pty');
});

test('profiles: per-profile env override beats table; legacy global beats builtin default', () => {
  const c = loadConfig({
    PROFILE_CODEX_COMMAND: '/opt/codex/bin/codex',
    PROFILE_CODEX_ARGS: '["--sandbox","read-only"]',
    PROFILE_ANTIGRAVITY_QUIESCENCE_MS: '800',
    QUIESCENCE_MS: '650',
    COLS: '200',
  });
  assert.equal(c.profiles.codex.command, '/opt/codex/bin/codex');
  assert.deepEqual(c.profiles.codex.args, ['--sandbox', 'read-only']);
  assert.equal(c.profiles.antigravity.quiescenceMs, 800);   // level 1 beats level 3
  assert.equal(c.profiles.codex.quiescenceMs, 650);    // level 3 (legacy global)
  assert.equal(c.profiles.claude.cols, 200);           // legacy global applies to every profile
});

test('profiles: hyphenated names map to underscored env keys', () => {
  const c = loadConfig({ PROFILE_CLAUDE_HEADLESS_QUIESCENCE_MS: '900' });
  assert.equal(c.profiles['claude-headless'].quiescenceMs, 900);
});

test('profiles: legacy CLAUDE_CMD/CLAUDE_ARGS land on the claude profile at table level', () => {
  const c = loadConfig({ CLAUDE_CMD: 'bash', CLAUDE_ARGS: '["-i"]' });
  assert.equal(c.profiles.claude.command, 'bash');
  assert.deepEqual(c.profiles.claude.args, ['-i']);
  // per-profile env override still wins over the legacy mapping
  const c2 = loadConfig({ CLAUDE_CMD: 'bash', PROFILE_CLAUDE_COMMAND: 'zsh' });
  assert.equal(c2.profiles.claude.command, 'zsh');
});

test('profiles: ADAPTER=generic keeps legacy behavior (default profile + effective command)', () => {
  const noVendor = { vendorDir: path.join(tmpdir(), 'no-such-vendor') };
  const c = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash' }, noVendor);
  assert.equal(c.defaultProfile, 'generic');
  assert.equal(c.profiles.generic.command, 'bash');
  // bare ADAPTER=generic (CLAUDE_CMD unset) must also keep working: effective claude cmd defaults to 'claude'
  const c2 = loadConfig({ ADAPTER: 'generic' }, noVendor);
  assert.equal(c2.defaultProfile, 'generic');
  assert.equal(c2.profiles.generic.command, 'claude');
  // PROFILE_GENERIC_COMMAND beats the legacy mapping
  const c3 = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash', PROFILE_GENERIC_COMMAND: 'sh' });
  assert.equal(c3.profiles.generic.command, 'sh');
});

test('profiles: legacy ADAPTER=generic inherits the ANTHROPIC scrub (back-compat)', () => {
  // Existing ADAPTER=generic deployments must keep stripping ANTHROPIC_* from
  // children (spec Security back-compat). A fresh generic-by-name stays scrub-free.
  const legacy = loadConfig({ ADAPTER: 'generic', CLAUDE_CMD: 'bash' });
  assert.deepEqual(legacy.profiles.generic.envScrub, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  const fresh = loadConfig({ PROFILE_GENERIC_COMMAND: 'bash' }); // generic exists but not via legacy mapping
  assert.deepEqual(fresh.profiles.generic.envScrub, []);
});

test('profiles: a shipped table numeric value is honored above the legacy global (level 2)', () => {
  // Pins the resolver mechanism: a built-in that ships a numeric field would have
  // it honored at level 2 (above the legacy global). No built-in currently ships
  // one, so this uses claude (ships none) as the control: the legacy global wins,
  // and a per-profile env override still beats everything.
  const c = loadConfig({ QUIESCENCE_MS: '650' });
  assert.equal(c.profiles.claude.quiescenceMs, 650);
  // Override still beats everything.
  const c2 = loadConfig({ QUIESCENCE_MS: '650', PROFILE_CLAUDE_QUIESCENCE_MS: '900' });
  assert.equal(c2.profiles.claude.quiescenceMs, 900);
});

test('profiles: unknown ADAPTER fails fast', () => {
  assert.throws(() => loadConfig({ ADAPTER: 'copilot' }), /unknown ADAPTER/);
});

test('profiles: a headless or command-less DEFAULT_PROFILE is rejected at boot', () => {
  // A bare /ws or POST /api/sessions must be spawnable.
  assert.throws(() => loadConfig({ DEFAULT_PROFILE: 'claude-headless' }), /headless-mode|must be a pty/);
  assert.throws(
    () => loadConfig({ BRIDGE_PROFILES: 'generic', DEFAULT_PROFILE: 'generic' }), // generic has no command
    /no command configured/,
  );
});

test('profiles: BRIDGE_PROFILES allowlists; unknown name throws; DEFAULT_PROFILE validated', () => {
  const c = loadConfig({ BRIDGE_PROFILES: 'claude,codex' });
  assert.deepEqual(Object.keys(c.profiles).sort(), ['claude', 'codex']);
  assert.throws(() => loadConfig({ BRIDGE_PROFILES: 'claude,nope' }), /unknown profile "nope"/);
  assert.throws(() => loadConfig({ BRIDGE_PROFILES: 'codex', }), /DEFAULT_PROFILE/); // default 'claude' not enabled
  const c2 = loadConfig({ BRIDGE_PROFILES: 'codex', DEFAULT_PROFILE: 'codex' });
  assert.equal(c2.defaultProfile, 'codex');
});

test('profiles: PROFILE_<NAME>_ENV_SCRUB and _DIALOG_POLICY overrides; bad policy throws', () => {
  const c = loadConfig({ PROFILE_CODEX_ENV_SCRUB: 'FOO, BAR', PROFILE_CODEX_DIALOG_POLICY: 'never' });
  assert.deepEqual(c.profiles.codex.envScrub, ['FOO', 'BAR']);
  assert.equal(c.profiles.codex.dialogPolicy, 'never');
  assert.throws(() => loadConfig({ PROFILE_CODEX_DIALOG_POLICY: 'yolo' }), /dialogPolicy/);
});

test('profiles: frozen', () => {
  const c = loadConfig({});
  assert.throws(() => { c.profiles.claude.command = 'x'; });
  assert.throws(() => { c.profiles.claude.args.push('x'); });
});

// ---- Phase 2: facade config ----

test('facade config defaults: all dialects on, documented numbers', () => {
  const c = loadConfig({});
  assert.equal(c.facade.openaiChat, true);
  assert.equal(c.facade.openaiResponses, true);
  assert.equal(c.facade.anthropicMessages, true);
  assert.equal(c.facade.sessionTtlMs, 600000);
  assert.equal(c.facade.pinnedTtlMs, 3600000);
  assert.equal(c.facade.maxSessions, 8);
  assert.equal(c.facade.cols, 400);
});

test('facade toggles: 0/false/off/no disable, anything else stays on', () => {
  const c = loadConfig({ FACADE_OPENAI_CHAT: '0', FACADE_OPENAI_RESPONSES: 'false', FACADE_ANTHROPIC_MESSAGES: 'off' });
  assert.equal(c.facade.openaiChat, false);
  assert.equal(c.facade.openaiResponses, false);
  assert.equal(c.facade.anthropicMessages, false);
  const c2 = loadConfig({ FACADE_OPENAI_CHAT: '1', FACADE_OPENAI_RESPONSES: 'true' });
  assert.equal(c2.facade.openaiChat, true);
  assert.equal(c2.facade.openaiResponses, true);
});

test('facade numeric overrides parse', () => {
  const c = loadConfig({ FACADE_SESSION_TTL_MS: '1000', FACADE_PINNED_TTL_MS: '2000', FACADE_MAX_SESSIONS: '2', FACADE_COLS: '200' });
  assert.equal(c.facade.sessionTtlMs, 1000);
  assert.equal(c.facade.pinnedTtlMs, 2000);
  assert.equal(c.facade.maxSessions, 2);
  assert.equal(c.facade.cols, 200);
});

test('profile args are a fresh array per load, never the shared builtin', () => {
  const a = loadConfig({});
  const b = loadConfig({});
  assert.notEqual(a.profiles.codex.args, b.profiles.codex.args); // distinct frozen copies
});

// ---- vendor-first resolution + strict flag (Phase 3: version pinning) ----

function fakeVendor(relPaths) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vendor-'));
  for (const rel of relPaths) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, '#!/bin/sh\necho stub\n', { mode: 0o755 });
  }
  return dir;
}

test('vendor: command resolves to vendored bin when present', () => {
  const vendorDir = fakeVendor(['node_modules/.bin/claude', 'bin/agy']);
  const c = loadConfig({}, { vendorDir });
  assert.equal(c.profiles.claude.command, path.join(vendorDir, 'node_modules', '.bin', 'claude'));
  assert.equal(c.profiles.claude.baseCommand, 'claude');
  assert.equal(c.profiles.antigravity.command, path.join(vendorDir, 'bin', 'agy'));
  assert.equal(c.profiles.codex.command, 'codex'); // not vendored -> PATH fallback
  assert.equal(c.profiles.codex.baseCommand, 'codex');
});

test('vendor: claude-headless shares the vendored claude bin', () => {
  const vendorDir = fakeVendor(['node_modules/.bin/claude']);
  const c = loadConfig({}, { vendorDir });
  assert.equal(c.profiles['claude-headless'].command, path.join(vendorDir, 'node_modules', '.bin', 'claude'));
});

test('vendor: PROFILE_<NAME>_COMMAND override defeats vendor resolution', () => {
  const vendorDir = fakeVendor(['node_modules/.bin/claude']);
  const c = loadConfig({ PROFILE_CLAUDE_COMMAND: '/opt/other/claude' }, { vendorDir });
  assert.equal(c.profiles.claude.command, '/opt/other/claude');
  assert.equal(c.profiles.claude.baseCommand, '/opt/other/claude');
});

test('vendor: legacy CLAUDE_CMD override defeats vendor resolution', () => {
  const vendorDir = fakeVendor(['node_modules/.bin/claude']);
  const c = loadConfig({ CLAUDE_CMD: 'my-claude' }, { vendorDir });
  assert.equal(c.profiles.claude.command, 'my-claude');
});

test('vendor: BRIDGE_USE_HOST_CLIS=1 skips vendor resolution', () => {
  const vendorDir = fakeVendor(['node_modules/.bin/claude']);
  const c = loadConfig({ BRIDGE_USE_HOST_CLIS: '1' }, { vendorDir });
  assert.equal(c.profiles.claude.command, 'claude');
});

test('vendor: absent vendor dir leaves commands untouched', () => {
  const c = loadConfig({}, { vendorDir: path.join(tmpdir(), 'no-such-vendor-dir') });
  assert.equal(c.profiles.claude.command, 'claude');
  assert.equal(c.profiles.claude.baseCommand, 'claude');
});

test('envSet: claude profiles disable the autoupdater; copilot args carry --no-auto-update; frozen', () => {
  const c = loadConfig({});
  assert.deepEqual(c.profiles.claude.envSet, { DISABLE_AUTOUPDATER: '1' });
  assert.deepEqual(c.profiles['claude-headless'].envSet, { DISABLE_AUTOUPDATER: '1' });
  assert.deepEqual(c.profiles.generic.envSet, {});
  assert.deepEqual(c.profiles.codex.envSet, {});
  assert.deepEqual(c.profiles.copilot.args, ['--no-auto-update']);
  assert.throws(() => { c.profiles.claude.envSet.X = '1'; });
});

test('strictVersions flag defaults false, BRIDGE_STRICT_VERSIONS=1 enables', () => {
  assert.equal(loadConfig({}).strictVersions, false);
  assert.equal(loadConfig({ BRIDGE_STRICT_VERSIONS: '1' }).strictVersions, true);
});
