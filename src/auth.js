import crypto from 'node:crypto';

export function checkToken(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function extractToken(req) {
  const h = req.headers?.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  const q = (req.url || '').split('?')[1];
  if (q) { const p = new URLSearchParams(q); if (p.get('token')) return p.get('token'); }
  return null;
}
