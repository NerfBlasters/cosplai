import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkToken, extractToken } from './auth.js';
import { writeAndSubmitPrompt, MultilineUnsupportedError } from './promptWriter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const VENDOR = path.join(PUBLIC, 'vendor');

export async function sendPrompt(record, { text, submit = true, timeoutMs = 600000 }) {
  const start = Date.now();
  // Settle-timeout hazard (spec Error handling): after a timed-out turn the
  // CLI is still mid-generation; refuse to type until a confirmed settle.
  if (record.suspect) {
    await record.detector.waitForSettle({ timeoutMs });
    record.suspect = false;
  }
  const before = record.terminalModel.snapshotLineCount();
  record.detector.markBusy();
  await writeAndSubmitPrompt(record.session, record.adapter, text, submit);
  // Re-arm after the submit: a quiescenceMs <= SUBMIT_DELAY_MS profile could
  // otherwise settle to idle inside the write→submit gap (see turnRunner).
  record.detector.markBusy();
  let state;
  try {
    state = await record.detector.waitForSettle({ timeoutMs });
  } catch (e) {
    if (/settle timeout/.test(String(e.message || e))) record.suspect = true;
    throw e;
  }
  const lines = record.terminalModel.renderLinesSince(before);
  const output = lines.join('\n');
  const cleaned = typeof record.adapter.extractResponse === 'function'
    ? record.adapter.extractResponse(lines)
    : output;
  const prompt = state === 'awaiting_input' ? record.adapter.describePrompt(record.terminalModel.viewportTail(8)) : null;
  return { state, output, text: cleaned, prompt, durationMs: Date.now() - start };
}

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(b);
}

const MAX_BODY = 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; let len = 0; let tooLarge = false;
    req.on('data', (c) => {
      len += c.length;
      if (len > MAX_BODY) {
        // Stop buffering once over the cap, but keep draining the socket
        // (rather than destroying it) so the response we're about to send
        // — the 413 — actually reaches the client instead of racing a
        // connection reset.
        tooLarge = true;
        d = '';
      } else if (!tooLarge) {
        d += c;
      }
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('body too large'), { tooLarge: true }));
      try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// Reads and parses the request body, translating an oversized-body rejection
// into a 413 response. Returns a sentinel (undefined) when it has already
// written the 413 response itself, so call sites can bail out immediately.
async function readBodyOr413(req, res) {
  try {
    return await readBody(req);
  } catch (e) {
    if (e && e.tooLarge) { json(res, 413, { error: 'body too large' }); return undefined; }
    throw e;
  }
}

// Content-Security-Policy for the terminal shell. `connect-src 'self'` is the
// one that matters most here: it is the browser-enforced backstop on the
// WebSocket URL the page builds (CSP3 lets 'self' match ws:/wss: on the
// document's own origin), so even a bug in public/index.html's URL assembly
// can't open a socket to somebody else's host. 'unsafe-inline' is required by
// the page's own inline <script>/<style> blocks; everything the page loads
// otherwise is same-origin vendored assets, so the rest can stay closed.
const SHELL_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Is this request genuinely running over TLS? Either the socket is directly
// encrypted, or a reverse proxy the operator explicitly told us to trust
// (BRIDGE_TRUST_PROXY=1) said so. Absent that opt-in the header is spoofable
// by any client, so it is ignored.
function isSecureRequest(req, trustProxy) {
  if (req.socket && req.socket.encrypted) return true;
  if (!trustProxy) return false;
  const raw = req.headers['x-forwarded-proto'];
  const first = String(Array.isArray(raw) ? raw[0] : raw || '').split(',')[0].trim().toLowerCase();
  return first === 'https';
}

// Applied to EVERY response the bridge produces — bridge API routes, the
// static shell, and the cloud-API facade dialects alike (the facade is
// dispatched from inside this handler, so /v1/messages et al. inherit these).
//
// HSTS is deliberately conditional. The bridge serves plain HTTP on loopback
// by default, and RFC 6797 §7.2 says a UA MUST ignore a
// Strict-Transport-Security header received over non-secure transport — so
// emitting it unconditionally is a no-op at best. At worst it is harmful: an
// STS entry pinned for `localhost` forces https:// on every other local
// service sharing that hostname. So it goes out only on a genuinely-TLS
// request, which is exactly the deployment (TLS-terminating proxy in front)
// where it does real work.
//
// `referrer-policy: no-referrer` is load-bearing rather than boilerplate here:
// the bridge token travels in the query string (?token=…), so a default
// referrer policy would leak it in the Referer of any outbound navigation.
function applySecurityHeaders(req, res, config) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  if (isSecureRequest(req, config.trustProxy)) {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}

async function sendFile(res, file, type, extraHeaders = {}) {
  // Reject anything that isn't a plain file up front (fs.createReadStream
  // happily "opens" a directory on Linux — the failure only surfaces as
  // EISDIR on the first read, by which point we'd already have committed to
  // a 200 and can no longer send a clean error response).
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return json(res, 404, { error: 'not found' }); }
  if (!stat.isFile()) return json(res, 404, { error: 'not found' });

  // Defer writeHead(200) until the file is confirmed open: fs stream errors
  // fire asynchronously, so writing 200 unconditionally first (as a naive
  // `writeHead(200); s.pipe(res)` ordering would) loses the race and crashes
  // with ERR_HTTP_HEADERS_SENT when the 404 handler then tries to write its
  // own head. (headersSent guard below covers any residual race, e.g. a
  // read error after the stat-then-open TOCTOU window.)
  const s = fs.createReadStream(file);
  s.on('error', () => {
    if (res.headersSent) { res.destroy(); return; }
    json(res, 404, { error: 'not found' });
  });
  s.on('open', () => res.writeHead(200, { 'content-type': type, ...extraHeaders }));
  s.pipe(res);
}

const VENDOR_TYPES = { '.js': 'application/javascript', '.css': 'text/css' };

// Upper bound on a single POST /api/sessions/:id/key request. Each entry is a
// separate PTY write held on the session's queue, so an unbounded array lets one
// request monopolize the session for an arbitrary time.
const MAX_KEYS_PER_REQUEST = 64;

export function createHttpServer(config, manager, facade = null) {
  return http.createServer(async (req, res) => {
    try {
      applySecurityHeaders(req, res, config);
      const u = new URL(req.url, 'http://x');

      // Public, unauthenticated: vendored third-party static assets.
      if (req.method === 'GET' && u.pathname.startsWith('/vendor/')) {
        const f = path.resolve(PUBLIC, `.${u.pathname}`);
        if (f !== VENDOR && !f.startsWith(VENDOR + path.sep)) return json(res, 403, { error: 'forbidden' });
        const type = VENDOR_TYPES[path.extname(f)] || 'application/octet-stream';
        return sendFile(res, f, type);
      }

      // Cloud-API facade routes authenticate per provider family themselves
      // (provider-shaped 401s, x-api-key support) — match them before the
      // bridge token gate.
      if (facade && facade.canHandle(req.method, u.pathname)) return facade.handle(req, res, u);

      if (!checkToken(extractToken(req), config.token)) return json(res, 401, { error: 'unauthorized' });

      const parts = u.pathname.split('/').filter(Boolean); // e.g. ['api','sessions',':id','prompt']

      if (req.method === 'POST' && u.pathname === '/api/sessions') {
        const b = await readBodyOr413(req, res);
        if (b === undefined) return;
        try {
          const rec = manager.create(b);
          return json(res, 201, { id: rec.id, state: rec.detector.state, profile: rec.profile });
        } catch (e) {
          if (['UNKNOWN_PROFILE', 'PROFILE_NOT_PTY', 'PROFILE_NO_COMMAND', 'ADAPTER_UNAVAILABLE'].includes(e.code)) {
            return json(res, 400, { error: String(e.message), ...(e.validProfiles ? { validProfiles: e.validProfiles } : {}) });
          }
          throw e;
        }
      }
      if (req.method === 'GET' && u.pathname === '/api/sessions') {
        return json(res, 200, { sessions: manager.list().map((r) => ({ id: r.id, state: r.detector.state, createdAt: r.createdAt, profile: r.profile })) });
      }
      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2]) {
        const rec = manager.get(parts[2]);
        if (!rec) return json(res, 404, { error: 'not found' });
        if (req.method === 'GET' && parts.length === 3) return json(res, 200, { id: rec.id, state: rec.detector.state, createdAt: rec.createdAt, profile: rec.profile });
        if (req.method === 'DELETE' && parts.length === 3) {
          manager.remove(rec.id);
          res.writeHead(204);
          return res.end();
        }
        if (req.method === 'POST' && parts[3] === 'prompt') {
          if (!rec.session.alive) return json(res, 409, { error: 'session not alive' });
          const b = await readBodyOr413(req, res);
          if (b === undefined) return;
          if (typeof b.text !== 'string') return json(res, 400, { error: 'text required' });
          try {
            const timeoutMs = Number.isFinite(b.timeoutMs) ? b.timeoutMs : config.promptTimeoutMs;
            const out = await rec.queue.enqueue(() => sendPrompt(rec, { text: b.text, submit: b.submit !== false, timeoutMs }));
            return json(res, 200, out);
          } catch (e) {
            if (e instanceof MultilineUnsupportedError) return json(res, 400, { error: String(e.message) });
            const msg = String(e.message || e);
            const code = /exited/.test(msg) ? 409 : 504;
            return json(res, code, { error: msg });
          }
        }
        if (req.method === 'POST' && parts[3] === 'key') {
          if (!rec.session.alive) return json(res, 409, { error: 'session not alive' });
          const b = await readBodyOr413(req, res);
          if (b === undefined) return;
          const keys = b.keys ?? [];
          if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) {
            return json(res, 400, { error: 'keys must be an array of strings' });
          }
          if (keys.length > MAX_KEYS_PER_REQUEST) {
            return json(res, 400, { error: `keys may contain at most ${MAX_KEYS_PER_REQUEST} entries` });
          }
          // Serialize through the session's PromptQueue, exactly as /prompt does
          // above. Writing outside the queue lands these bytes in the middle of
          // an in-flight turn's capture window, corrupting the output that turn
          // returns to its caller (CWE-362).
          const q = config.profiles[rec.profile]?.quiescenceMs ?? config.quiescenceMs;
          await rec.queue.enqueue(async () => {
            for (const k of keys) rec.session.write(rec.adapter.keySeq(k));
            await new Promise((r) => setTimeout(r, Math.min(q * 2, 1000)));
          });
          return json(res, 200, { state: rec.detector.state });
        }
        if (req.method === 'GET' && parts[3] === 'events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          const onData = (d) => res.write(`data: ${JSON.stringify({ type: 'output', data: d })}\n\n`);
          const onState = (s) => res.write(`data: ${JSON.stringify({ type: 'state', state: s })}\n\n`);
          rec.session.on('data', onData);
          rec.detector.on('state', onState);
          req.on('close', () => { rec.session.off('data', onData); rec.detector.off('state', onState); });
          return;
        }
      }

      // Token already checked above: serve the HTML shell.
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
        return sendFile(res, path.join(PUBLIC, 'index.html'), 'text/html',
          { 'content-security-policy': SHELL_CSP });
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: String(e.message || e) });
    }
  });
}
