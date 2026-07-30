import { WebSocketServer } from 'ws';
import { checkToken, extractToken } from './auth.js';

export function attachWss(server, config, manager) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/ws' || !checkToken(extractToken(req), config.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }
    const providedSid = u.searchParams.get('session');
    const existing = providedSid ? manager.get(providedSid) : null;
    const profileParam = u.searchParams.get('profile');
    const reject400 = (msg) => {
      const body = JSON.stringify({ error: msg, validProfiles: Object.keys(config.profiles) });
      socket.write(`HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      socket.destroy();
    };
    // Validate the EFFECTIVE creation profile pre-upgrade whenever this
    // connection will create a session (no ?session= at all): the explicit
    // ?profile=, or the default when none is given. A ?session= naming an
    // unknown id keeps today's create-fallback and ignores ?profile= (spec:
    // attachment never respawns). This covers the crash where a headless or
    // command-less DEFAULT_PROFILE would otherwise throw inside handleUpgrade.
    if (!providedSid) {
      const effective = profileParam || config.defaultProfile;
      const p = config.profiles[effective];
      const problem = !p ? `unknown profile "${effective}"`
        : p.mode !== 'pty' ? `profile "${effective}" is ${p.mode}-mode and cannot back an interactive session`
        : !p.command ? `profile "${effective}" has no command configured`
        : null;
      if (problem) { reject400(problem); return; }
    }
    wss.handleUpgrade(req, socket, head, ws => {
      let rec;
      try {
        rec = existing || manager.create(!providedSid && profileParam ? { profile: profileParam } : {});
      } catch (e) {
        // Belt-and-suspenders: pre-validation should have caught profile errors,
        // but a spawn/registry failure here must close the socket, never crash
        // the process.
        try { ws.close(1011, String(e.code || e.message || 'session create failed').slice(0, 120)); } catch { /* ignore */ }
        return;
      }
      const ownedByWs = !existing;
      ws.send(rec.session.scrollback());
      const onData = d => { if (ws.readyState === ws.OPEN) ws.send(d); };
      rec.session.on('data', onData);
      const onExit = () => { try { ws.close(); } catch { /* ignore */ } };
      rec.session.on('exit', onExit);
      ws.on('message', raw => {
        const s = raw.toString();
        if (s.startsWith('{')) { try { const m = JSON.parse(s); if (m.type === 'resize') { rec.session.resize(m.cols, m.rows); rec.terminalModel.resize(m.cols, m.rows); return; } } catch { /* fallthrough */ } }
        rec.session.write(s);
      });
      ws.on('close', () => {
        rec.session.off('data', onData);
        rec.session.off('exit', onExit);
        if (ownedByWs) manager.remove(rec.id);
      });
    });
  });
  return wss;
}
