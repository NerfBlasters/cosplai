// src/facade/dialects/anthropicMessages.js
// POST /v1/messages (+SSE). The facade auth gate accepts x-api-key for this
// family (see index.js). The top-level `system` parameter canonicalizes to a
// leading (system, text) tuple in the normalized sequence, so fingerprinting
// naturally separates conversations that differ only in system prompt.
// Assistant prefill (trailing non-user message) is unsupported → 400.
import {
  FacadeError, readJsonBody, sendError, jsonRes, errorBody, flattenContent, noteIgnoredParams,
  sseInit, sseEventFrame, writeIfOpen, collectDone, usageAnthropic, uuid,
} from '../shared.js';
import { parsePin } from './openaiChat.js';

const KNOWN = ['model', 'messages', 'system', 'stream'];

function normalize(body, req) {
  if (typeof body.model !== 'string' || !body.model) {
    throw new FacadeError(400, 'invalid_request', 'model: field required');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new FacadeError(400, 'invalid_request', 'messages: field required and must be non-empty');
  }
  const messages = [];
  if (body.system != null) {
    const text = typeof body.system === 'string' ? body.system : flattenContent(body.system, 'system');
    messages.push({ role: 'system', text });
  }
  body.messages.forEach((m, i) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      throw new FacadeError(400, 'invalid_request', `messages[${i}].role must be "user" or "assistant"`);
    }
    messages.push({ role: m.role, text: flattenContent(m.content, `messages[${i}].content`) });
  });
  if (messages[messages.length - 1].role !== 'user') {
    throw new FacadeError(400, 'invalid_request', 'assistant prefill is not supported by the bridge: the final message must have role "user"');
  }
  const { profileName, suffixPin, headerPin } = parsePin(body.model, req);
  return { profileName, pinId: headerPin || suffixPin, messages, stream: body.stream === true };
}

export function makeAnthropicMessagesHandler(ctx) {
  return async (req, res) => {
    let body;
    let norm;
    try {
      body = await readJsonBody(req);
      norm = normalize(body, req);
    } catch (e) {
      return sendError(res, 'anthropic', e);
    }
    noteIgnoredParams(body, KNOWN, 'messages');
    const id = `msg_${uuid()}`;
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let turn;
    try {
      turn = ctx.router.executeTurn({
        profileName: norm.profileName, pinId: norm.pinId, messages: norm.messages,
        signal: ac.signal, timeoutMs: ctx.config.promptTimeoutMs,
      });
    } catch (e) {
      return sendError(res, 'anthropic', e);
    }

    if (!norm.stream) {
      try {
        const done = await collectDone(turn.events);
        return jsonRes(res, 200, {
          id, type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: done.text }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: usageAnthropic(done.usage),
          ...(done.usage.estimated ? { bridge: { usage_estimated: true } } : {}),
        });
      } catch (e) {
        return sendError(res, 'anthropic', e);
      }
    }

    sseInit(res);
    const send = (event, obj) => writeIfOpen(res, sseEventFrame(event, obj));
    send('message_start', { type: 'message_start', message: {
      id, type: 'message', role: 'assistant', model: body.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    } });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    try {
      let done = null;
      for await (const ev of turn.events) {
        if (ev.type === 'delta') send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ev.text } });
        else if (ev.type === 'done') done = ev;
      }
      if (!done) throw new FacadeError(500, 'api_error', 'turn ended without a result');
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: usageAnthropic(done.usage),
        ...(done.usage.estimated ? { bridge: { usage_estimated: true } } : {}) });
      send('message_stop', { type: 'message_stop' });
    } catch (e) {
      // Native Anthropic mid-stream error framing (spec): event: error, then close.
      const err = e instanceof FacadeError ? e : new FacadeError(500, 'api_error', String((e && e.message) || e));
      send('error', errorBody('anthropic', err));
    }
    res.end();
  };
}
