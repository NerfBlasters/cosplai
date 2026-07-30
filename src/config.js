import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function num(v, d) { if (v == null || String(v).trim() === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; }

function jsonArray(v, d = []) {
  if (!v) return d;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : d; } catch { return d; }
}

function flag(v, d) {
  if (v == null || String(v).trim() === '') return d;
  return !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());
}

const DIALOG_POLICIES = ['startup-only', 'auto-approve', 'never'];

// Built-in profile table (spec "Profiles (config.js)"). Numeric/cwd fields are
// OPTIONAL here: a profile that omits them resolves through the legacy globals
// (QUIESCENCE_MS/COLS/ROWS/CWD) so existing deployments keep their tuning
// (precedence level 3); a profile that DOES ship one (a fixture spike may add a
// tuned `quiescenceMs`/`cols`/`rows` to a built-in entry) has it honored as
// level 2, above the legacy global. No built-in currently ships one — the
// resolver's `base.<field> ?? <global>` handles both cases.
// Autoupdate suppression (spec B4), so a spawned child can't drift off its
// pinned version mid-flight: claude honors DISABLE_AUTOUPDATER=1 (documented
// kill-switch, applied via envSet); copilot has a --no-auto-update flag
// (applied via args). codex and agy expose only a manual `update` subcommand
// (checked `--help` 2026-07-24, codex 0.134.0 / agy 1.1.6) — for those the
// adapters' recognized-dialog handling is the guard (codex's update dialog is
// answered "Skip until next version", never auto-Enter).
const BUILTIN_PROFILES = {
  claude: {
    command: 'claude', args: [], adapter: 'claude',
    envScrub: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    envSet: { DISABLE_AUTOUPDATER: '1' },
    dialogPolicy: 'startup-only', mode: 'pty',
  },
  codex: {
    command: 'codex', args: [], adapter: 'codex',
    envScrub: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    dialogPolicy: 'startup-only', mode: 'pty',
  },
  // Google's subscription coding CLI. The standalone `gemini` CLI's OAuth was
  // sunset for individual accounts (it errors "no longer supported ... migrate
  // to the Antigravity suite"), so this profile targets Antigravity (`agy`),
  // the supported successor. envScrub keeps the Google/Gemini API-key vars as a
  // best-effort force onto subscription auth (agy has no API-key env of its own).
  antigravity: {
    command: 'agy', args: [], adapter: 'antigravity',
    envScrub: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_LOCATION'],
    dialogPolicy: 'startup-only', mode: 'pty',
  },
  copilot: {
    command: 'copilot', args: ['--no-auto-update'], adapter: 'copilot',
    // COPILOT_ALLOW_ALL is the env form of --allow-all-tools; scrub it so an
    // ambient value can't hand a bridge-spawned copilot blanket tool autonomy.
    envScrub: ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_ALLOW_ALL'],
    dialogPolicy: 'startup-only', mode: 'pty',
  },
  'claude-headless': {
    command: 'claude', args: [], adapter: null,
    envScrub: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    envSet: { DISABLE_AUTOUPDATER: '1' },
    dialogPolicy: 'startup-only', mode: 'headless', headlessRunner: 'claude',
  },
  // First-class copilot facade profile: exact-text turns through `copilot -p`
  // with structured JSONL, no PTY / alt-screen extraction. The runner
  // (headlessCopilotRunner) hardcodes a tool lockdown; the COPILOT_ALLOW_ALL
  // scrub below is defense-in-depth for it (see that file's SECURITY note).
  'copilot-headless': {
    command: 'copilot', args: [], adapter: null,
    envScrub: ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_ALLOW_ALL'],
    dialogPolicy: 'startup-only', mode: 'headless', headlessRunner: 'copilot',
  },
  generic: {
    command: null, args: [], adapter: 'generic',
    envScrub: [], dialogPolicy: 'startup-only', mode: 'pty',
  },
};

const envKey = (name) => name.toUpperCase().replace(/-/g, '_');

export function loadConfig(env = process.env, { vendorDir = path.join(REPO_ROOT, 'vendor') } = {}) {
  const token = env.BRIDGE_TOKEN || crypto.randomBytes(24).toString('base64url');
  const claudeCmd = env.CLAUDE_CMD || 'claude';
  const claudeArgs = Object.freeze(jsonArray(env.CLAUDE_ARGS));
  const cwd = env.CWD || env.HOME || process.cwd();
  const quiescenceMs = num(env.QUIESCENCE_MS, 500);
  const cols = num(env.COLS, 120);
  const rows = num(env.ROWS, 30);

  if (env.ADAPTER && env.ADAPTER !== 'generic' && env.ADAPTER !== 'claude') {
    throw new Error(`unknown ADAPTER "${env.ADAPTER}" (valid: claude, generic)`);
  }

  const allow = env.BRIDGE_PROFILES
    ? env.BRIDGE_PROFILES.split(',').map((s) => s.trim()).filter(Boolean)
    : Object.keys(BUILTIN_PROFILES);

  const profiles = {};
  for (const name of allow) {
    const base = BUILTIN_PROFILES[name];
    if (!base) {
      throw new Error(`unknown profile "${name}" in BRIDGE_PROFILES (valid: ${Object.keys(BUILTIN_PROFILES).join(', ')})`);
    }
    const P = (field) => env[`PROFILE_${envKey(name)}_${field}`];

    // Precedence level 2 (table), including the legacy mappings that land here.
    let command = base.command;
    let args = [...base.args];
    if (name === 'claude') {
      if (env.CLAUDE_CMD) command = env.CLAUDE_CMD;
      if (env.CLAUDE_ARGS) args = [...claudeArgs];
    }
    let envScrubBase = [...base.envScrub];
    if (name === 'generic' && env.ADAPTER === 'generic') {
      // Effective claude command/args (defaults 'claude'/[]), preserving both
      // ADAPTER=generic CLAUDE_CMD=bash and bare ADAPTER=generic behavior.
      command = claudeCmd;
      args = [...claudeArgs];
      // Legacy back-compat (spec Security): today Session unconditionally
      // strips ANTHROPIC_* from every child, and the README promises it for
      // exactly this ADAPTER=generic combo. Inherit the scrub so existing
      // deployments don't start leaking Anthropic creds to the child. A fresh
      // `generic` profile chosen by name keeps its scrub-free table entry.
      envScrubBase = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
    }
    // Precedence level 1 (per-profile env override) wins over level 2.
    if (P('COMMAND') != null) command = P('COMMAND');
    if (P('ARGS') != null) args = jsonArray(P('ARGS'));

    // Vendor-first resolution (spec B3): a pinned bin under vendor/ wins over
    // host PATH, but an operator's explicit command (per-profile env override
    // or legacy CLAUDE_CMD) is always used verbatim. BRIDGE_USE_HOST_CLIS=1
    // is the escape hatch back to host binaries.
    const explicit = P('COMMAND') != null
      || (name === 'claude' && !!env.CLAUDE_CMD)
      || (name === 'generic' && env.ADAPTER === 'generic' && !!env.CLAUDE_CMD);
    const baseCommand = command;
    if (!explicit && command && !command.includes('/') && !flag(env.BRIDGE_USE_HOST_CLIS, false)) {
      for (const cand of [path.join(vendorDir, 'node_modules', '.bin', command), path.join(vendorDir, 'bin', command)]) {
        if (existsSync(cand)) { command = cand; break; }
      }
    }

    const dialogPolicy = P('DIALOG_POLICY') != null ? P('DIALOG_POLICY') : base.dialogPolicy;
    if (!DIALOG_POLICIES.includes(dialogPolicy)) {
      throw new Error(`invalid dialogPolicy "${dialogPolicy}" for profile "${name}" (valid: ${DIALOG_POLICIES.join(', ')})`);
    }
    const envScrub = P('ENV_SCRUB') != null
      ? P('ENV_SCRUB').split(',').map((s) => s.trim()).filter(Boolean)
      : envScrubBase;

    profiles[name] = Object.freeze({
      name,
      command,
      baseCommand,
      args: Object.freeze(args),
      adapter: base.adapter,
      envScrub: Object.freeze(envScrub),
      envSet: Object.freeze({ ...(base.envSet || {}) }),
      dialogPolicy,
      mode: base.mode,
      // Which headless runner drives a mode:'headless' profile (router._runTurn
      // dispatch). null for pty/generic profiles.
      headlessRunner: base.headlessRunner ?? null,
      // Precedence for numerics/cwd: level 1 (PROFILE_<NAME>_*) → level 2
      // (a shipped table value if the profile provides one — most don't) →
      // level 3 (legacy global) → level 4 (built-in default). `?? quiescenceMs`
      // etc. supplies levels 3/4 when the table omits the field; a fixture
      // spike that ships e.g. `quiescenceMs: 800` in BUILTIN_PROFILES.antigravity is
      // then honored here as level 2.
      quiescenceMs: num(P('QUIESCENCE_MS'), base.quiescenceMs ?? quiescenceMs),
      cols: num(P('COLS'), base.cols ?? cols),
      rows: num(P('ROWS'), base.rows ?? rows),
      cwd: P('CWD') != null ? P('CWD') : (base.cwd ?? cwd),
    });
  }

  const defaultProfile = env.ADAPTER === 'generic' ? 'generic' : (env.DEFAULT_PROFILE || 'claude');
  if (!profiles[defaultProfile]) {
    throw new Error(`DEFAULT_PROFILE "${defaultProfile}" is not an enabled profile (enabled: ${Object.keys(profiles).join(', ')})`);
  }
  // A bare POST /api/sessions or /ws must always be spawnable (spec Profiles):
  // reject a headless or command-less default at boot rather than crashing on
  // first connection.
  if (profiles[defaultProfile].mode !== 'pty') {
    throw new Error(`DEFAULT_PROFILE "${defaultProfile}" is ${profiles[defaultProfile].mode}-mode; a session default must be a pty profile`);
  }
  if (!profiles[defaultProfile].command) {
    throw new Error(`DEFAULT_PROFILE "${defaultProfile}" has no command configured (set PROFILE_${envKey(defaultProfile)}_COMMAND)`);
  }

  return Object.freeze({
    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 7681),
    token,
    tokenGenerated: !env.BRIDGE_TOKEN,
    claudeCmd,
    claudeArgs,
    cwd,
    quiescenceMs,
    promptTimeoutMs: num(env.PROMPT_TIMEOUT_MS, 600000),
    cols,
    rows,
    scrollback: num(env.SCROLLBACK, 5000),
    ringBytes: num(env.RING_BYTES, 262144),
    adapter: env.ADAPTER === 'generic' ? 'generic' : 'claude',
    strictVersions: flag(env.BRIDGE_STRICT_VERSIONS, false),
    // Whether an `x-forwarded-proto` header may be believed. Only meaningful
    // when a TLS-terminating reverse proxy sits in front of the bridge, and
    // only safe when that proxy is guaranteed to overwrite the header — so it
    // is opt-in. It gates the HSTS response header (see src/httpApi.js): a
    // spoofable "yes, this was HTTPS" signal would otherwise let any client
    // make a browser pin HSTS for the bridge's hostname.
    trustProxy: flag(env.BRIDGE_TRUST_PROXY, false),
    profiles: Object.freeze(profiles),
    defaultProfile,
    facade: Object.freeze({
      openaiChat: flag(env.FACADE_OPENAI_CHAT, true),
      openaiResponses: flag(env.FACADE_OPENAI_RESPONSES, true),
      anthropicMessages: flag(env.FACADE_ANTHROPIC_MESSAGES, true),
      sessionTtlMs: num(env.FACADE_SESSION_TTL_MS, 600000),
      pinnedTtlMs: num(env.FACADE_PINNED_TTL_MS, 3600000),
      maxSessions: num(env.FACADE_MAX_SESSIONS, 8),
      cols: num(env.FACADE_COLS, 400),
    }),
  });
}
