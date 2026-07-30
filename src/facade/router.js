// src/facade/router.js
// ConversationRouter: request → conversation → session (spec "Conversation
// routing (the hybrid)"). Explicit pins (model suffix / header / response id)
// when the client provides them; history-prefix fingerprint stickiness as the
// default; seed a fresh session from client-held history on miss; TTL + LRU
// lifecycle. Turn execution (executeTurn) is layered on top in turnRunner /
// headlessClaudeRunner via Task 8.
import crypto from 'node:crypto';
import { PromptQueue } from '../promptQueue.js';
import { FacadeError, AsyncQueue, estTokens } from './shared.js';
import { runPtyTurn } from './turnRunner.js';
import { runHeadlessClaudeTurn } from './headlessClaudeRunner.js';
import { runHeadlessCopilotTurn } from './headlessCopilotRunner.js';

// mode:'headless' profiles dispatch to a runner keyed by profile.headlessRunner.
const HEADLESS_RUNNERS = { claude: runHeadlessClaudeTurn, copilot: runHeadlessCopilotTurn };

const REAP_EVERY_MS = 30000;

export class ConversationRouter {
  constructor({ config, manager }) {
    this._config = config;
    this._manager = manager;
    this._convs = new Map();   // conv.id → conv
    this._byFp = new Map();    // fingerprint key → conv
    this._pins = new Map();    // explicit pin id → conv
    this._byResp = new Map();  // resp_<uuid> → conv
    this._reapTimer = setInterval(() => this.reap(Date.now()), REAP_EVERY_MS);
    if (this._reapTimer.unref) this._reapTimer.unref();
  }

  _fp(profileName, messages) {
    const h = crypto.createHash('sha256');
    h.update(JSON.stringify([profileName, messages.map((m) => [m.role, m.text])]));
    return `${profileName}\n${h.digest('hex')}`;
  }

  _buildSeed(history) {
    if (!history.length) return '';
    return [
      'Prior conversation context, replayed for continuity. Do not respond to it;',
      'respond only to the message after the END CONTEXT line.',
      '--- BEGIN CONTEXT ---',
      ...history.map((m) => `[${m.role}] ${m.text}`),
      '--- END CONTEXT ---',
    ].join('\n');
  }

  _ensureCapacity() {
    const pty = [...this._convs.values()].filter((c) => c.mode === 'pty');
    if (pty.length < this._config.facade.maxSessions) return;
    const idle = pty.filter((c) => c.busy === 0).sort((a, b) => a.lastUsed - b.lastUsed);
    if (!idle.length) throw new FacadeError(429, 'rate_limit', 'all bridge sessions are mid-turn; retry shortly');
    this._destroy(idle[0]);
  }

  _create({ profileName, id = null, pinned = false }) {
    const profile = this._config.profiles[profileName];
    if (profile.mode === 'pty') this._ensureCapacity();
    const conv = {
      id: id ?? crypto.randomUUID(), profileName, profile, mode: profile.mode,
      record: null, queue: null, resumeSessionId: null, fpKey: null,
      pinned, lastUsed: Date.now(), busy: 0, respIds: new Set(), pending: null, needsSeed: false,
    };
    if (profile.mode === 'pty') {
      try {
        conv.record = this._manager.create({ profile: profileName, cols: this._config.facade.cols });
      } catch (e) {
        throw new FacadeError(500, 'api_error', `failed to start a "${profileName}" session: ${e.message}`,
          { spawn_error: String(e.message || e) });
      }
      conv.queue = conv.record.queue;
    } else {
      conv.queue = new PromptQueue();
    }
    this._convs.set(conv.id, conv);
    return conv;
  }

  _destroy(conv) {
    if (conv.record) this._manager.remove(conv.record.id);
    this._convs.delete(conv.id);
    if (conv.pinned) this._pins.delete(conv.id);
    if (conv.fpKey && this._byFp.get(conv.fpKey) === conv) this._byFp.delete(conv.fpKey);
    for (const rid of conv.respIds) this._byResp.delete(rid);
  }

  // messages: normalized [{role, text}], trailing role 'user' (dialect-validated).
  acquire({ profileName, pinId, respConv, messages }) {
    const history = messages.slice(0, -1);
    const userText = messages[messages.length - 1].text;
    // Two key spaces share _byFp deliberately. The PRIMARY key (full message
    // list) is stored at creation and lives until completeTurn replaces it:
    // an identical request arriving while the first turn is in flight is
    // indistinguishable from a network retry, and the spec's retry semantics
    // (Error handling: identical fingerprint + trailing user message
    // "attaches") REQUIRE it to land on the same conversation, serialized on
    // its queue — not spawn a duplicate session. The SECONDARY key (history
    // only) is what completeTurn stores, giving post-turn history-prefix
    // stickiness. Single-operator trust model: there is no client identity
    // to separate "two users who typed the same thing".
    const fpKey = this._fp(profileName, messages);        // primary: full messages
    const historyKey = this._fp(profileName, history);    // secondary: history for next-acquire match
    let conv = null;
    let created = false;
    if (respConv) {
      conv = respConv;
    } else if (pinId != null) {
      conv = this._pins.get(pinId) || null;
      if (conv && conv.profileName !== profileName) {
        throw new FacadeError(400, 'invalid_request',
          `conversation "${pinId}" is bound to model "${conv.profileName}", not "${profileName}"`);
      }
      if (!conv) {
        conv = this._create({ profileName, id: pinId, pinned: true });
        created = true;
        this._pins.set(pinId, conv);
      }
    } else {
      conv = this._byFp.get(fpKey) || this._byFp.get(historyKey) || null;
      if (!conv) { conv = this._create({ profileName }); created = true; }
    }
    if (created) { conv.fpKey = fpKey; this._byFp.set(fpKey, conv); }
    const seedText = (created || conv.needsSeed) ? this._buildSeed(history) : '';
    return { conv, fpKey, userText, seedText };
  }

  // Store the next expected fingerprint: received history + user message +
  // the exact assistant text returned (spec) — turn N+1 then hits.
  completeTurn(conv, messages, assistantText) {
    const next = [...messages, { role: 'assistant', text: assistantText }];
    const key = this._fp(conv.profileName, next);
    if (conv.fpKey && this._byFp.get(conv.fpKey) === conv) this._byFp.delete(conv.fpKey);
    conv.fpKey = key;
    this._byFp.set(key, conv);
    conv.pending = null;
    conv.needsSeed = false;
    conv.lastUsed = Date.now();
  }

  registerResponse(conv) {
    const id = `resp_${crypto.randomUUID()}`;
    this._byResp.set(id, conv);
    conv.respIds.add(id);
    return id;
  }

  resolveResponseId(id) { return this._byResp.get(id); }

  reap(nowMs) {
    for (const conv of [...this._convs.values()]) {
      const ttl = conv.pinned ? this._config.facade.pinnedTtlMs : this._config.facade.sessionTtlMs;
      if (conv.busy === 0 && nowMs - conv.lastUsed > ttl) this._destroy(conv);
    }
  }

  stats() { return { conversations: this._convs.size }; }

  _dialogError(conv, promptText) {
    return new FacadeError(409, 'dialog',
      `the CLI is waiting on an interactive dialog; answer it via POST /api/sessions/${conv.record.id}/key and retry`,
      { conversation_id: conv.id, session_id: conv.record.id, dialog: promptText });
  }

  _failTurn(conv, e) {
    if (conv.mode === 'headless') {
      // Spec Error handling: drop the stored session_id; the next request
      // reseeds a fresh first -p turn from client-held history.
      conv.resumeSessionId = null;
      conv.needsSeed = true;
      return;
    }
    if (e && e.sessionExited) this._destroy(conv); // next request reseeds a fresh session
  }

  async _runTurn({ conv, userText, seedText, timeoutMs, emit }) {
    if (conv.mode === 'headless') {
      const runHeadlessTurn = HEADLESS_RUNNERS[conv.profile.headlessRunner] || runHeadlessClaudeTurn;
      const out = await runHeadlessTurn({
        profile: conv.profile, resumeSessionId: conv.resumeSessionId, userText, seedText, emit, timeoutMs,
      });
      conv.resumeSessionId = out.resumeSessionId ?? conv.resumeSessionId;
      return out;
    }
    return runPtyTurn({ record: conv.record, userText, seedText, emit, timeoutMs });
  }

  // Attach to a dialog-blocked pending turn (spec Error handling): the retry
  // does not re-type — it returns the extracted text if the operator's answer
  // let the session settle, or the same dialog error if still blocked.
  _attachPending(conv, messages, events, timeoutMs) {
    const { sinceIndex, userText } = conv.pending;
    conv.busy += 1;
    (async () => {
      try {
        const det = conv.record.detector;
        const state = (det.state === 'idle' || det.state === 'awaiting_input')
          ? det.state
          : await det.waitForSettle({ timeoutMs });
        if (state === 'awaiting_input') {
          const tail = conv.record.terminalModel.viewportTail(8);
          events.fail(this._dialogError(conv, conv.record.adapter.describePrompt(tail) || tail.join('\n')));
          return;
        }
        const lines = conv.record.terminalModel.renderLinesSince(sinceIndex);
        const text = conv.record.adapter.extractResponse(lines);
        this.completeTurn(conv, messages, text);
        events.push({ type: 'done', text, finishReason: 'stop',
          usage: { input: estTokens(userText.length), output: estTokens(text.length), estimated: true } });
        events.end();
      } catch (e) {
        events.fail(e instanceof FacadeError ? e : new FacadeError(500, 'api_error', String((e && e.message) || e)));
      } finally {
        conv.busy -= 1;
        conv.lastUsed = Date.now();
      }
    })();
  }

  executeTurn({ profileName, pinId = null, previousResponseId = null, messages, signal = null, timeoutMs }) {
    const profile = this._config.profiles[profileName];
    if (!profile || !profile.command) {
      throw new FacadeError(404, 'model_not_found', `The model \`${profileName}\` does not exist or is not available on this bridge`);
    }
    let respConv = null;
    if (previousResponseId != null && pinId == null) {
      respConv = this._byResp.get(previousResponseId);
      if (!respConv) throw new FacadeError(404, 'not_found', `previous response "${previousResponseId}" not found or expired`);
    }
    const { conv, fpKey, userText, seedText } = this.acquire({ profileName, pinId, respConv, messages });
    const events = new AsyncQueue();
    if (conv.pending && conv.pending.fpKey === fpKey && conv.pending.userText === userText) {
      this._attachPending(conv, messages, events, timeoutMs);
      return { conv, events };
    }
    conv.busy += 1;
    conv.lastUsed = Date.now();
    conv.queue.enqueue(async () => {
      try {
        const emit = (ev) => { if (!signal || !signal.aborted) events.push(ev); };
        const outcome = await this._runTurn({ conv, userText, seedText, timeoutMs, emit });
        if (outcome.dialog) {
          conv.pending = { fpKey, userText, sinceIndex: outcome.dialog.sinceIndex };
          events.fail(this._dialogError(conv, outcome.dialog.promptText));
        } else {
          this.completeTurn(conv, messages, outcome.text);
          events.push({ type: 'done', text: outcome.text, finishReason: 'stop', usage: outcome.usage });
          events.end();
        }
      } catch (e) {
        this._failTurn(conv, e);
        events.fail(e instanceof FacadeError ? e : new FacadeError(500, 'api_error', String((e && e.message) || e)));
      } finally {
        conv.busy -= 1;
        conv.lastUsed = Date.now();
      }
    });
    return { conv, events };
  }

  close() {
    clearInterval(this._reapTimer);
    for (const conv of [...this._convs.values()]) this._destroy(conv);
  }
}
