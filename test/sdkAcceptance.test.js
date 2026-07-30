import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessionManager.js';
import { createHttpServer } from '../src/httpApi.js';
import { createFacade } from '../src/facade/index.js';

const REPL = path.resolve('scripts/helpers/fake-repl.sh');
const STUB = path.resolve('scripts/helpers/claude-stub.mjs');

function boot(extraEnv = {}) {
  const config = loadConfig({
    BRIDGE_TOKEN: 'tok', DEFAULT_PROFILE: 'generic',
    PROFILE_GENERIC_COMMAND: 'bash', PROFILE_GENERIC_ARGS: JSON.stringify([REPL]),
    PROFILE_GENERIC_CWD: process.cwd(), QUIESCENCE_MS: '200', PROMPT_TIMEOUT_MS: '8000',
    PROFILE_CLAUDE_HEADLESS_COMMAND: STUB, PROFILE_CLAUDE_HEADLESS_CWD: process.cwd(),
    ...extraEnv,
  });
  const manager = new SessionManager(config);
  const facade = createFacade(config, manager);
  const server = createHttpServer(config, manager, facade);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    config, manager, facade, server, port: server.address().port,
    close() { facade.close(); for (const r of manager.list()) manager.remove(r.id); server.close(); },
  })));
}

test('openai SDK: chat non-stream + multi-turn stickiness', async () => {
  const b = await boot();
  const client = new OpenAI({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}/v1` });
  const r1 = await client.chat.completions.create({ model: 'generic', messages: [{ role: 'user', content: 'hello' }] });
  assert.match(r1.choices[0].message.content, /reply 1 to: hello/);
  const r2 = await client.chat.completions.create({ model: 'generic', messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: r1.choices[0].message.content },
    { role: 'user', content: 'again' },
  ] });
  assert.match(r2.choices[0].message.content, /reply 2 to: again/);
  assert.equal(b.manager.list().length, 1, 'one session served both turns');
  b.close();
});

test('openai SDK: chat streaming', async () => {
  const b = await boot();
  const client = new OpenAI({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}/v1` });
  const stream = await client.chat.completions.create({ model: 'generic', stream: true, messages: [{ role: 'user', content: 'PARA' }] });
  let text = '';
  for await (const chunk of stream) text += chunk.choices[0]?.delta?.content || '';
  assert.match(text, /first paragraph\n\nsecond paragraph/);
  b.close();
});

test('openai SDK: models.list and native NotFoundError', async () => {
  const b = await boot();
  const client = new OpenAI({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}/v1` });
  const models = await client.models.list();
  assert.ok(models.data.some((m) => m.id === 'generic'));
  await assert.rejects(
    () => client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
    OpenAI.NotFoundError);
  b.close();
});

test('openai SDK: explicit pin via model suffix survives history-free requests', async () => {
  const b = await boot();
  const client = new OpenAI({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}/v1` });
  const r1 = await client.chat.completions.create({ model: 'generic#pinned', messages: [{ role: 'user', content: 'one' }] });
  assert.match(r1.choices[0].message.content, /reply 1 to: one/);
  const r2 = await client.chat.completions.create({ model: 'generic#pinned', messages: [{ role: 'user', content: 'two' }] });
  assert.match(r2.choices[0].message.content, /reply 2 to: two/);
  b.close();
});

test('openai SDK: responses non-stream, previous_response_id, streaming', async () => {
  const b = await boot();
  const client = new OpenAI({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}/v1` });
  const r1 = await client.responses.create({ model: 'generic', input: 'first' });
  assert.match(r1.output[0].content[0].text, /reply 1 to: first/);
  const r2 = await client.responses.create({ model: 'generic', input: 'second', previous_response_id: r1.id });
  assert.match(r2.output[0].content[0].text, /reply 2 to: second/);
  const stream = await client.responses.create({ model: 'generic', input: 'third', previous_response_id: r2.id, stream: true });
  let deltas = '';
  let completed = null;
  for await (const ev of stream) {
    if (ev.type === 'response.output_text.delta') deltas += ev.delta;
    if (ev.type === 'response.completed') completed = ev.response;
  }
  assert.match(deltas, /reply 3 to: third/);
  assert.equal(completed.status, 'completed');
  b.close();
});

test('anthropic SDK: messages non-stream + streaming + native BadRequestError on prefill', async () => {
  const b = await boot();
  const client = new Anthropic({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}` });
  const m1 = await client.messages.create({ model: 'generic', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] });
  assert.match(m1.content[0].text, /reply 1 to: hello/);
  const stream = client.messages.stream({ model: 'generic', max_tokens: 100, messages: [
    { role: 'user', content: 'hello' }, { role: 'assistant', content: m1.content[0].text }, { role: 'user', content: 'PARA' },
  ] });
  const final = await stream.finalMessage();
  assert.match(final.content[0].text, /first paragraph\n\nsecond paragraph/);
  assert.equal(final.stop_reason, 'end_turn');
  await assert.rejects(
    () => client.messages.create({ model: 'generic', max_tokens: 5, messages: [
      { role: 'user', content: 'x' }, { role: 'assistant', content: 'prefill' },
    ] }),
    Anthropic.BadRequestError);
  b.close();
});

test('headless model through the openai SDK: real usage, resume continuity', async () => {
  const b = await boot();
  const client = new OpenAI({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}/v1` });
  const r1 = await client.chat.completions.create({ model: 'claude-headless', messages: [{ role: 'user', content: 'alpha' }] });
  assert.equal(r1.choices[0].message.content, 'turn 1 reply to: alpha');
  assert.equal(r1.usage.prompt_tokens, 42, 'REAL usage from the result event');
  assert.equal(r1.usage.completion_tokens, 7);
  assert.equal(r1.bridge, undefined, 'no usage_estimated flag on the headless path');
  const r2 = await client.chat.completions.create({ model: 'claude-headless', messages: [
    { role: 'user', content: 'alpha' },
    { role: 'assistant', content: r1.choices[0].message.content },
    { role: 'user', content: 'beta' },
  ] });
  assert.equal(r2.choices[0].message.content, 'turn 2 reply to: beta', '--resume chained');
  b.close();
});

test('anthropic SDK streaming against the headless model (text_delta passthrough)', async () => {
  const b = await boot();
  const client = new Anthropic({ apiKey: 'tok', baseURL: `http://127.0.0.1:${b.port}` });
  const stream = client.messages.stream({ model: 'claude-headless', max_tokens: 100, messages: [{ role: 'user', content: 'streamme' }] });
  const final = await stream.finalMessage();
  assert.equal(final.content[0].text, 'turn 1 reply to: streamme');
  assert.equal(final.usage.output_tokens, 7);
  b.close();
});
