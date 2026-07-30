// src/adapters/index.js
import { generic } from './generic.js';
import { claude } from './claude.js';
import { codex } from './codex.js';
import { antigravity } from './antigravity.js';
import { copilot } from './copilot.js';

const REGISTRY = { generic, claude, codex, antigravity, copilot };

export function getAdapter(name) {
  const a = REGISTRY[name];
  if (!a) throw new Error(`unknown adapter "${name}" (valid: ${Object.keys(REGISTRY).join(', ')})`);
  return a;
}
