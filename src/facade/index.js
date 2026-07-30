// src/facade/index.js
// Facade mount: builds the route table from the enabled dialect toggles and
// performs per-family auth (Bearer everywhere; the Anthropic dialect also
// accepts x-api-key) so even 401s are provider-shaped. Routes are matched by
// httpApi BEFORE its own token gate; a disabled dialect's route is simply not
// registered, so it falls through to the bridge's plain 404.
import { checkToken, extractToken } from '../auth.js';
import { FacadeError, sendError } from './shared.js';
import { makeModelsHandler } from './models.js';
import { makeOpenaiChatHandler } from './dialects/openaiChat.js';
import { makeOpenaiResponsesHandler } from './dialects/openaiResponses.js';
import { makeAnthropicMessagesHandler } from './dialects/anthropicMessages.js';
import { ConversationRouter } from './router.js';

export function createFacade(config, manager) {
  const router = new ConversationRouter({ config, manager });
  const ctx = { config, manager, router };
  const routes = new Map(); // 'METHOD /path' → { family, handler }

  if (config.facade.openaiChat || config.facade.openaiResponses) {
    routes.set('GET /v1/models', { family: 'openai', handler: makeModelsHandler(ctx) });
  }

  if (config.facade.openaiChat) {
    routes.set('POST /v1/chat/completions', { family: 'openai', handler: makeOpenaiChatHandler(ctx) });
  }

  if (config.facade.openaiResponses) {
    routes.set('POST /v1/responses', { family: 'openai', handler: makeOpenaiResponsesHandler(ctx) });
  }

  if (config.facade.anthropicMessages) {
    routes.set('POST /v1/messages', { family: 'anthropic', handler: makeAnthropicMessagesHandler(ctx) });
  }

  return {
    router,
    canHandle(method, pathname) { return routes.has(`${method} ${pathname}`); },
    async handle(req, res, u) {
      const { family, handler } = routes.get(`${req.method} ${u.pathname}`);
      let token = extractToken(req);
      if (token == null && family === 'anthropic' && typeof req.headers['x-api-key'] === 'string') {
        token = req.headers['x-api-key'];
      }
      if (!checkToken(token, config.token)) {
        return sendError(res, family, new FacadeError(401, 'auth',
          family === 'anthropic' ? 'invalid x-api-key' : 'Incorrect API key provided'));
      }
      try {
        await handler(req, res, u);
      } catch (e) {
        if (!res.headersSent) sendError(res, family, e);
        else res.end();
      }
    },
    close() { router.close(); },
  };
}
