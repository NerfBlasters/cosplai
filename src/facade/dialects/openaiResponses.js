// src/facade/dialects/openaiResponses.js
// POST /v1/responses (+SSE). previous_response_id is an explicit pin to the
// conversation that produced that response (spec Translation rules); the
// X-Bridge-Conversation header outranks it, the model '#' suffix ranks below.
import {
  FacadeError, readJsonBody, sendError, jsonRes, errorBody, flattenContent, noteIgnoredParams,
  sseInit, sseEventFrame, sseFrame, writeIfOpen, collectDone, usageResponses, now, uuid,
} from '../shared.js';
import { parsePin } from './openaiChat.js';

const KNOWN = ['model', 'input', 'instructions', 'stream', 'store', 'previous_response_id'];

function normalize(body, req) {
  if (typeof body.model !== 'string' || !body.model) {
    throw new FacadeError(400, 'invalid_request', 'you must provide a model parameter');
  }
  const messages = [];
  if (body.instructions != null) {
    if (typeof body.instructions !== 'string') throw new FacadeError(400, 'invalid_request', 'instructions must be a string');
    messages.push({ role: 'system', text: body.instructions });
  }
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', text: body.input });
  } else if (Array.isArray(body.input)) {
    body.input.forEach((item, i) => {
      const isMessage = item && typeof item.role === 'string' && (item.type == null || item.type === 'message');
      if (!isMessage) throw new FacadeError(400, 'invalid_request', `input[${i}]: only message items are supported by the bridge`);
      messages.push({ role: item.role === 'developer' ? 'system' : item.role, text: flattenContent(item.content, `input[${i}].content`) });
    });
  } else {
    throw new FacadeError(400, 'invalid_request', 'input must be a string or an array of message items');
  }
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    throw new FacadeError(400, 'invalid_request', 'the final input item must be a user message');
  }
  const { profileName, suffixPin, headerPin } = parsePin(body.model, req);
  const previousResponseId = typeof body.previous_response_id === 'string' ? body.previous_response_id : null;
  // Precedence: header > previous_response_id > model suffix.
  const pinId = headerPin || (previousResponseId ? null : suffixPin);
  return { profileName, pinId, previousResponseId: headerPin ? null : previousResponseId, messages, stream: body.stream === true };
}

function responseBody({ respId, msgId, created, body, norm, text, usage }) {
  return {
    id: respId, object: 'response', created_at: created, status: 'completed', background: false,
    error: null, incomplete_details: null, instructions: body.instructions ?? null,
    max_output_tokens: null, max_tool_calls: null, model: body.model,
    output: [{ id: msgId, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', annotations: [], logprobs: [], text }] }],
    parallel_tool_calls: true, previous_response_id: norm.previousResponseId ?? null,
    reasoning: { effort: null, summary: null }, store: true, temperature: null,
    text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [], top_p: null,
    truncation: 'disabled', usage: usageResponses(usage), user: null, metadata: {},
    ...(usage.estimated ? { bridge: { usage_estimated: true } } : {}),
  };
}

export function makeOpenaiResponsesHandler(ctx) {
  return async (req, res) => {
    let body;
    let norm;
    try {
      body = await readJsonBody(req);
      norm = normalize(body, req);
    } catch (e) {
      return sendError(res, 'openai', e);
    }
    noteIgnoredParams(body, KNOWN, 'responses');
    const created = now();
    const msgId = `msg_${uuid()}`;
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let turn;
    try {
      turn = ctx.router.executeTurn({
        profileName: norm.profileName, pinId: norm.pinId, previousResponseId: norm.previousResponseId,
        messages: norm.messages, signal: ac.signal, timeoutMs: ctx.config.promptTimeoutMs,
      });
    } catch (e) {
      return sendError(res, 'openai', e);
    }

    if (!norm.stream) {
      try {
        const done = await collectDone(turn.events);
        const respId = ctx.router.registerResponse(turn.conv);
        return jsonRes(res, 200, responseBody({ respId, msgId, created, body, norm, text: done.text, usage: done.usage }));
      } catch (e) {
        return sendError(res, 'openai', e);
      }
    }

    sseInit(res);
    let seq = 0;
    const send = (type, extra) => writeIfOpen(res, sseEventFrame(type, { type, sequence_number: seq++, ...extra }));
    const respId = ctx.router.registerResponse(turn.conv);
    const skeleton = (status) => ({
      id: respId, object: 'response', created_at: created, status, background: false, error: null,
      incomplete_details: null, instructions: body.instructions ?? null, max_output_tokens: null,
      max_tool_calls: null, model: body.model, output: [], parallel_tool_calls: true,
      previous_response_id: norm.previousResponseId ?? null, reasoning: { effort: null, summary: null },
      store: true, temperature: null, text: { format: { type: 'text' } }, tool_choice: 'auto',
      tools: [], top_p: null, truncation: 'disabled', usage: null, user: null, metadata: {},
    });
    send('response.created', { response: skeleton('in_progress') });
    send('response.in_progress', { response: skeleton('in_progress') });
    send('response.output_item.added', { output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    send('response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', annotations: [], text: '' } });
    try {
      let done = null;
      for await (const ev of turn.events) {
        if (ev.type === 'delta') send('response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: ev.text, logprobs: [] });
        else if (ev.type === 'done') done = ev;
      }
      if (!done) throw new FacadeError(500, 'api_error', 'turn ended without a result');
      send('response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text: done.text, logprobs: [] });
      const part = { type: 'output_text', annotations: [], text: done.text };
      send('response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part });
      send('response.output_item.done', { output_index: 0, item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [part] } });
      const final = responseBody({ respId, msgId, created, body, norm, text: done.text, usage: done.usage });
      send('response.completed', { response: final });
    } catch (e) {
      const err = e instanceof FacadeError ? e : new FacadeError(500, 'api_error', String((e && e.message) || e));
      writeIfOpen(res, sseFrame(errorBody('openai', err)));
      writeIfOpen(res, 'data: [DONE]\n\n');
    }
    res.end();
  };
}
