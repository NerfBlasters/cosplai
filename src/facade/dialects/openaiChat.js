// src/facade/dialects/openaiChat.js
// POST /v1/chat/completions (+SSE). model = profile name, optionally with a
// '#<conversation-id>' pin suffix; the X-Bridge-Conversation header wins on
// disagreement. All errors are OpenAI-shaped (handled by shared.sendError).
import {
  FacadeError, readJsonBody, sendError, jsonRes, errorBody, flattenContent, noteIgnoredParams,
  sseInit, sseFrame, writeIfOpen, collectDone, usageOpenaiChat, now, uuid,
} from '../shared.js';

const KNOWN = ['model', 'messages', 'stream', 'stream_options', 'n'];

export function parsePin(model, req) {
  const hash = model.indexOf('#');
  const profileName = hash === -1 ? model : model.slice(0, hash);
  const suffixPin = hash === -1 ? null : model.slice(hash + 1);
  const headerPin = req.headers['x-bridge-conversation'];
  return { profileName, suffixPin: suffixPin || null, headerPin: (typeof headerPin === 'string' && headerPin) ? headerPin : null };
}

function normalize(body, req) {
  if (typeof body.model !== 'string' || !body.model) {
    throw new FacadeError(400, 'invalid_request', 'you must provide a model parameter');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new FacadeError(400, 'invalid_request', 'messages must be a non-empty array');
  }
  if (body.n != null && body.n !== 1) {
    throw new FacadeError(400, 'invalid_request', 'the bridge supports only n=1');
  }
  const messages = body.messages.map((m, i) => {
    if (!m || typeof m.role !== 'string') throw new FacadeError(400, 'invalid_request', `messages[${i}].role is required`);
    return { role: m.role === 'developer' ? 'system' : m.role, text: flattenContent(m.content, `messages[${i}].content`) };
  });
  if (messages[messages.length - 1].role !== 'user') {
    throw new FacadeError(400, 'invalid_request', 'the final message must be a user message (the bridge cannot continue an assistant turn)');
  }
  const { profileName, suffixPin, headerPin } = parsePin(body.model, req);
  return {
    profileName, pinId: headerPin || suffixPin, messages,
    stream: body.stream === true,
    includeUsage: !!(body.stream_options && body.stream_options.include_usage),
  };
}

export function makeOpenaiChatHandler(ctx) {
  return async (req, res) => {
    let body;
    let norm;
    try {
      body = await readJsonBody(req);
      norm = normalize(body, req);
    } catch (e) {
      return sendError(res, 'openai', e);
    }
    noteIgnoredParams(body, KNOWN, 'chat.completions');
    const id = `chatcmpl-${uuid()}`;
    const created = now();
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let turn;
    try {
      turn = ctx.router.executeTurn({
        profileName: norm.profileName, pinId: norm.pinId, messages: norm.messages,
        signal: ac.signal, timeoutMs: ctx.config.promptTimeoutMs,
      });
    } catch (e) {
      return sendError(res, 'openai', e);
    }

    if (!norm.stream) {
      try {
        const done = await collectDone(turn.events);
        return jsonRes(res, 200, {
          id, object: 'chat.completion', created, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: done.text }, logprobs: null, finish_reason: 'stop' }],
          usage: usageOpenaiChat(done.usage),
          ...(done.usage.estimated ? { bridge: { usage_estimated: true } } : {}),
        });
      } catch (e) {
        return sendError(res, 'openai', e);
      }
    }

    sseInit(res);
    const chunk = (delta, finish = null) => ({
      id, object: 'chat.completion.chunk', created, model: body.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    });
    writeIfOpen(res, sseFrame(chunk({ role: 'assistant', content: '' })));
    try {
      for await (const ev of turn.events) {
        if (ev.type === 'delta') writeIfOpen(res, sseFrame(chunk({ content: ev.text })));
        else if (ev.type === 'done') {
          writeIfOpen(res, sseFrame(chunk({}, 'stop')));
          if (norm.includeUsage) {
            writeIfOpen(res, sseFrame({
              id, object: 'chat.completion.chunk', created, model: body.model, choices: [],
              usage: usageOpenaiChat(ev.usage),
              ...(ev.usage.estimated ? { bridge: { usage_estimated: true } } : {}),
            }));
          }
        }
      }
      writeIfOpen(res, 'data: [DONE]\n\n');
    } catch (e) {
      // Errors after streaming began (spec): a final error frame, then [DONE].
      const err = e instanceof FacadeError ? e : new FacadeError(500, 'api_error', String((e && e.message) || e));
      writeIfOpen(res, sseFrame(errorBody('openai', err)));
      writeIfOpen(res, 'data: [DONE]\n\n');
    }
    res.end();
  };
}
