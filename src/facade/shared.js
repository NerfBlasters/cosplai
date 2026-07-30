// src/facade/shared.js
// Cross-dialect plumbing for the cloud-API facade: provider-shaped errors,
// SSE helpers, body reading, the events channel, content flattening, and
// usage mapping. Family is 'openai' or 'anthropic' — every error we send is
// shaped so the official SDK raises its native exception type.
import crypto from 'node:crypto';

export class FacadeError extends Error {
  constructor(status, kind, message, bridge = undefined) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.bridge = bridge;
  }
}

const OPENAI_KIND = {
  invalid_request: { type: 'invalid_request_error', code: null },
  auth: { type: 'invalid_request_error', code: 'invalid_api_key' },
  not_found: { type: 'invalid_request_error', code: null },
  model_not_found: { type: 'invalid_request_error', code: 'model_not_found' },
  rate_limit: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
  timeout: { type: 'api_error', code: 'bridge_settle_timeout' },
  api_error: { type: 'api_error', code: null },
  dialog: { type: 'invalid_request_error', code: 'bridge_dialog_pending' },
};
const ANTHROPIC_KIND = {
  invalid_request: 'invalid_request_error',
  auth: 'authentication_error',
  not_found: 'not_found_error',
  model_not_found: 'not_found_error',
  rate_limit: 'overloaded_error',
  timeout: 'api_error',
  api_error: 'api_error',
  dialog: 'invalid_request_error',
};

export function errorBody(family, err) {
  const bridge = err.bridge ? { bridge: err.bridge } : {};
  if (family === 'anthropic') {
    return { type: 'error', error: { type: ANTHROPIC_KIND[err.kind] || 'api_error', message: err.message }, ...bridge };
  }
  const m = OPENAI_KIND[err.kind] || OPENAI_KIND.api_error;
  return { error: { message: err.message, type: m.type, param: err.param ?? null, code: m.code }, ...bridge };
}

export function jsonRes(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(b);
}

export function sendError(res, family, err) {
  const e = err instanceof FacadeError ? err : new FacadeError(500, 'api_error', String((err && err.message) || err));
  jsonRes(res, e.status, errorBody(family, e));
}

// Facade requests carry whole conversation histories — allow more than the
// bridge API's 1 MiB.
const MAX_BODY = 8 * 1024 * 1024;

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    let len = 0;
    let over = false;
    req.on('data', (c) => {
      len += c.length;
      if (len > MAX_BODY) { over = true; d = ''; return; }
      if (!over) d += c;
    });
    req.on('end', () => {
      if (over) return reject(new FacadeError(413, 'invalid_request', 'request body too large'));
      try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new FacadeError(400, 'invalid_request', 'request body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

// Async push-queue: the router's turn loop produces events; the dialect
// consumes them with for-await. fail() surfaces as a throw from the iterator
// AFTER buffered values drain. push/end/fail after completion are no-ops.
export class AsyncQueue {
  constructor() {
    this._values = [];
    this._resolvers = [];
    this._ended = false;
    this._error = null;
  }
  _settle(result) { const r = this._resolvers.shift(); if (r) { r(result); return true; } return false; }
  push(value) { if (this._ended) return; if (!this._settle({ value })) this._values.push({ value }); }
  end() { if (this._ended) return; this._ended = true; while (this._resolvers.length) this._settle({ end: true }); }
  fail(error) { if (this._ended) return; this._ended = true; this._error = error; while (this._resolvers.length) this._settle({ error }); }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      let item;
      if (this._values.length) item = this._values.shift();
      else if (this._error) item = { error: this._error };
      else if (this._ended) item = { end: true };
      else item = await new Promise((res) => this._resolvers.push(res));
      if (item.error) throw item.error;
      if (item.end) return;
      yield item.value;
    }
  }
}

// Message content may be a string or the array-of-parts form; text parts are
// concatenated, non-text parts rejected provider-shaped (spec Translation).
const TEXT_PART_TYPES = ['text', 'input_text', 'output_text'];
export function flattenContent(content, where) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.map((p, i) => {
      if (p && TEXT_PART_TYPES.includes(p.type) && typeof p.text === 'string') return p.text;
      throw new FacadeError(400, 'invalid_request', `${where}[${i}]: only text content parts are supported by the bridge`);
    }).join('');
  }
  throw new FacadeError(400, 'invalid_request', `${where} must be a string or an array of text parts`);
}

// Non-goal params are accepted, ignored, and logged once per name (spec).
const ignoredLogged = new Set();
export function noteIgnoredParams(body, known, dialect) {
  for (const k of Object.keys(body)) {
    if (known.includes(k)) continue;
    const tag = `${dialect}.${k}`;
    if (ignoredLogged.has(tag)) continue;
    ignoredLogged.add(tag);
    console.warn(`facade: parameter "${k}" (${dialect}) is accepted but ignored by the bridge`);
  }
}

export const estTokens = (chars) => Math.max(1, Math.ceil(chars / 4));
export const now = () => Math.floor(Date.now() / 1000);
export const uuid = () => crypto.randomUUID();

export function sseInit(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
}
export const sseFrame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
export const sseEventFrame = (event, obj) => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
export function writeIfOpen(res, s) {
  if (res.writableEnded || res.destroyed) return;
  try { res.write(s); } catch { /* client gone mid-write */ }
}

export async function collectDone(events) {
  let done = null;
  for await (const ev of events) if (ev.type === 'done') done = ev;
  if (!done) throw new FacadeError(500, 'api_error', 'turn ended without a result');
  return done;
}

export const usageOpenaiChat = (u) => ({ prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output });
export const usageResponses = (u) => ({
  input_tokens: u.input, input_tokens_details: { cached_tokens: 0 },
  output_tokens: u.output, output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: u.input + u.output,
});
export const usageAnthropic = (u) => ({ input_tokens: u.input, output_tokens: u.output });
