#!/usr/bin/env node
// Live acceptance (spec Testing §4): drives REAL CLIs through the official
// SDKs against an in-process bridge. Opt-in and manual — consumes
// subscription quota. Usage:
//   node scripts/live-acceptance.mjs [profile ...]   # default: claude claude-headless codex
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';
import { createFacade } from '../src/facade/index.js';

const profiles = process.argv.slice(2).length ? process.argv.slice(2) : ['claude', 'claude-headless', 'codex'];
const config = loadConfig({ ...process.env, BRIDGE_TOKEN: process.env.BRIDGE_TOKEN || 'live-tok' });
const manager = new SessionManager(config);
const facade = createFacade(config, manager);
const server = createHttpServer(config, manager, facade);
const port = await new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
const openai = new OpenAI({ apiKey: config.token, baseURL: `http://127.0.0.1:${port}/v1` });
const anthropic = new Anthropic({ apiKey: config.token, baseURL: `http://127.0.0.1:${port}` });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

for (const profile of profiles) {
  console.log(`\n=== ${profile} ===`);
  try {
    const r = await openai.chat.completions.create({ model: profile, messages: [{ role: 'user', content: 'reply with exactly: PONG' }] });
    const text = r.choices[0].message.content;
    check(`${profile} openai non-stream`, /PONG/.test(text), JSON.stringify(text.slice(0, 120)));
    const stream = await openai.chat.completions.create({ model: profile, stream: true, messages: [
      { role: 'user', content: 'reply with exactly: PONG' },
      { role: 'assistant', content: text },
      { role: 'user', content: 'reply with exactly: DONG' },
    ] });
    let streamed = '';
    for await (const c of stream) streamed += c.choices[0]?.delta?.content || '';
    check(`${profile} openai stream + stickiness`, /DONG/.test(streamed), JSON.stringify(streamed.slice(0, 120)));
    const a = await anthropic.messages.create({ model: profile, max_tokens: 100, messages: [{ role: 'user', content: 'reply with exactly: PING' }] });
    check(`${profile} anthropic non-stream`, /PING/.test(a.content[0].text), JSON.stringify(a.content[0].text.slice(0, 120)));
  } catch (e) {
    check(`${profile}`, false, String(e.message || e).slice(0, 200));
  }
}

facade.close();
for (const r of manager.list()) manager.remove(r.id);
server.close();
console.log(failures ? `\n${failures} FAILURES` : '\nall live checks passed');
process.exit(failures ? 1 : 0);
