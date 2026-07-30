// src/facade/models.js
// GET /v1/models — shared by the OpenAI-family dialects (mounted when at
// least one is enabled). model id = profile name; only facade-usable
// profiles are listed: enabled (BRIDGE_PROFILES already filtered them into
// config.profiles) AND command resolves. claude-headless IS facade-usable.
import { jsonRes, now } from './shared.js';

export function makeModelsHandler(ctx) {
  return async (req, res) => {
    const created = now();
    const data = Object.values(ctx.config.profiles)
      .filter((p) => p.command)
      .map((p) => ({ id: p.name, object: 'model', created, owned_by: 'bridge' }));
    jsonRes(res, 200, { object: 'list', data });
  };
}
