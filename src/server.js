import { loadConfig } from './config.js';
import { SessionManager } from './sessionManager.js';
import { createHttpServer } from './httpApi.js';
import { attachWss } from './wsApi.js';
import { createFacade } from './facade/index.js';
import { loadPins } from './pins.js';
import { checkVersions, applyStrict } from './versionCheck.js';

const config = loadConfig();
for (const p of Object.values(config.profiles)) {
  if (p.command) console.log(`profile ${p.name}: ${p.command}`);
}
// A corrupt manifest must not kill a warn-only boot (spec B5): degrade to a
// loud warning and skip the handshake; under strict mode it IS fatal.
let pins = {};
try { pins = loadPins(); } catch (e) {
  if (config.strictVersions) { console.error(e.message); process.exit(1); }
  console.warn(`WARNING: skipping version handshake — ${e.message}`);
}
const versionReport = await checkVersions(config.profiles, pins);
if (config.strictVersions) {
  try { applyStrict(versionReport); } catch (e) { console.error(e.message); process.exit(1); }
}
const manager = new SessionManager(config);
const facade = createFacade(config, manager);
const server = createHttpServer(config, manager, facade);
attachWss(server, config, manager);
server.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}/?token=${encodeURIComponent(config.token)}`;
  const dialects = [
    config.facade.openaiChat && 'openai-chat',
    config.facade.openaiResponses && 'openai-responses',
    config.facade.anthropicMessages && 'anthropic-messages',
  ].filter(Boolean).join(', ') || 'none';
  console.log(`cosplai listening.`);
  console.log(`Open: ${url}`);
  console.log(`Facade dialects: ${dialects}`);
  if (config.tokenGenerated) console.log(`(token was generated; set BRIDGE_TOKEN to pin it)`);
});
