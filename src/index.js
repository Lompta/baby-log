// Shared backend for the baby log (the web app in ../public).
//
// Cloudflare Access sits in front of this hostname and only lets the listed
// accounts through. As a second lock, every request here must also carry a
// valid Access JWT for one of the emails in ALLOWED_EMAILS, so nothing is served
// even if a request somehow arrives without passing through Access. Anything
// that fails the check gets a plain 404. workers.dev and preview URLs are off.
//
// Each feeding or diaper is its own record, and the newest edit wins per record,
// so several phones logging at once never overwrite each other. Deletes are kept
// as tombstones for a while so every phone hears about them.

import { DurableObject } from 'cloudflare:workers';

const KINDS = ['nurse', 'bottle', 'diaper'];
const MAX_RECORD_BYTES = 4096;
const MAX_RECORDS_PER_PUT = 500;
const TOMBSTONE_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    let email = null;
    try {
      email = await verifyAccess(request, env);
    } catch {
      email = null;
    }
    if (!email) return new Response('Not found', { status: 404 });

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const log = env.LOG.get(env.LOG.idFromName('log'));
    const names = parseNames(env.NAMES);

    if (url.pathname === '/api/records' && request.method === 'GET') {
      return json({ me: email, names, records: await log.getAll() });
    }
    if (url.pathname === '/api/records' && request.method === 'PUT') {
      const body = await request.json().catch(() => null);
      if (!body || !Array.isArray(body.records)) return json({ error: 'bad body' }, 400);
      const records = body.records.slice(0, MAX_RECORDS_PER_PUT).filter(valid);
      return json({ me: email, names, records: await log.put(records, email) });
    }
    return json({ error: 'not found' }, 404);
  },
};

function valid(r) {
  return r && typeof r === 'object' && typeof r.id === 'string' && r.id.length <= 64
    && KINDS.includes(r.kind)
    && Number.isFinite(r.start)
    && Number.isFinite(r.updatedAt)
    && JSON.stringify(r).length <= MAX_RECORD_BYTES;
}

// "alice@example.com:Alice, bob@example.com:Bob" -> { 'alice@example.com': 'Alice', ... }
function parseNames(s) {
  const out = {};
  for (const pair of (s || '').split(',')) {
    const i = pair.lastIndexOf(':');
    if (i < 1) continue;
    const email = pair.slice(0, i).trim().toLowerCase();
    const name = pair.slice(i + 1).trim();
    if (email && name) out[email] = name;
  }
  return out;
}

export class Log extends DurableObject {
  async getAll() {
    const out = [];
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    for (const [key, record] of await this.ctx.storage.list({ prefix: 'r:' })) {
      if (record.deleted && record.updatedAt < cutoff) {
        await this.ctx.storage.delete(key);
        continue;
      }
      out.push(record);
    }
    return out;
  }

  // Returns the server's resulting copy of each record sent.
  async put(records, email) {
    const out = [];
    for (const incoming of records) {
      const key = 'r:' + incoming.id;
      const current = await this.ctx.storage.get(key);
      if (current && current.updatedAt >= incoming.updatedAt) {
        out.push(current);
        continue;
      }
      const record = { ...incoming, by: current?.by || email, updatedBy: email };
      await this.ctx.storage.put(key, record);
      out.push(record);
    }
    return out;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// --- Access JWT verification ---

let certCache = { keys: null, fetchedAt: 0 };

async function getKeys(teamDomain, forceRefresh) {
  if (!forceRefresh && certCache.keys && Date.now() - certCache.fetchedAt < 60 * 60 * 1000) {
    return certCache.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('could not fetch Access certs');
  const { keys } = await res.json();
  if (!Array.isArray(keys)) throw new Error('bad Access certs');
  certCache = { keys, fetchedAt: Date.now() };
  return keys;
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function readCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

// Returns the authenticated email, or null.
async function verifyAccess(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ALLOWED_EMAILS) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || readCookie(request, 'CF_Authorization');
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return null;
  }
  if (!header || !payload || header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

  let jwk = (await getKeys(env.ACCESS_TEAM_DOMAIN, false)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await getKeys(env.ACCESS_TEAM_DOMAIN, true)).find(k => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1])
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (!aud.includes(env.ACCESS_AUD)) return null;
  const email = (typeof payload.email === 'string' ? payload.email : '').toLowerCase();
  if (!email) return null;
  const allowed = env.ALLOWED_EMAILS.toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
  if (!allowed.includes(email)) return null;
  return email;
}
