// The hosted relay's front door.
//
// It routes and it does nothing else. Every room is a Durable Object, every
// request for a room goes to that room's object, and this file's whole job is
// to work out which one and to turn `{ ok: false, code }` into an HTTP status.
// There is no state here, no database, no cache, and no second copy of any
// rule — the rules are in `room.js` and in `relay/protocol.js`.
//
// NO D1, NO KV, NO R2, NO QUEUES. One Durable Object per room is enough, and
// reaching for anything else would be adding a service to hold state that the
// object holding the state is already holding.
//
// It also serves the share landing page, so `https://<host>/#stacki2...` works
// from the same deployment that carries the ciphertext. The page is imported
// as text at build time; a Worker has no filesystem to read it from.

import landingHtml from '../../share/index.html';

import { ERRORS, MAX_BODY_BYTES, VERSION } from '../../protocol.js';
import { Room } from './room.js';

export { Room };

// The landing page's Content-Security-Policy allows exactly one inline script,
// by hash. Computed once per isolate rather than written down, because a hash
// somebody has to remember to update is a hash that will be wrong.
let landingHeaders = null;
async function headersForLanding() {
  if (landingHeaders) return landingHeaders;
  const match = /<script>([\s\S]*?)<\/script>/.exec(landingHtml);
  let hash = null;
  if (match) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]));
    hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  }
  landingHeaders = {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': [
      "default-src 'none'",
      `script-src ${hash ? `'sha256-${hash}'` : "'none'"}`,
      "style-src 'unsafe-inline'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
    'x-robots-tag': 'noindex, nofollow',
    'cache-control': 'no-store',
  };
  return landingHeaders;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });

/** A refusal, with a stable code and never a stack trace. */
const refuse = (code, message = null) => json({ error: code, message }, ERRORS[code] || 400);

/** The answer from a room, as HTTP. */
const answer = (result, shape = (r) => r) => {
  if (!result || result.ok !== true) return refuse(result?.code || 'internal_error', messageFor(result?.code));
  const { ok, ...rest } = result;
  return json(shape(rest));
};

/**
 * The few refusals a person is meant to read.
 *
 * Everything else answers with its code and no prose — the client turns a code
 * into a sentence, because the client is the thing that knows what the person
 * was trying to do.
 */
const messageFor = (code) =>
  code === 'bad_invite'
    ? 'That invitation cannot be used.'
    : code === 'room_full'
      ? 'This secure share has reached its limit.'
      : code === 'unauthorized'
        ? null
        : null;

const bearerOf = (header) => {
  if (typeof header !== 'string') return null;
  const m = /^Bearer[ ]+([A-Za-z0-9_-]{1,128})$/i.exec(header.trim());
  return m ? m[1] : null;
};

/** A JSON body, bounded, or a refusal. */
async function readJson(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, code: 'too_large' };
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, code: 'bad_request' };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false, code: 'too_large' };
  if (!text) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'bad_json' };
    return { ok: true, body: parsed };
  } catch {
    return { ok: false, code: 'bad_json' };
  }
}

/**
 * Room creation, rate limited at the edge when the binding is configured.
 *
 * Optional on purpose: the binding needs an account-level namespace, and
 * everything in this repository has to be runnable and testable locally by
 * somebody with no Cloudflare account at all. Where it is absent this is a
 * no-op and the README says to put a WAF rate-limiting rule in front instead.
 * Rate limiting is not authorisation and nothing here treats it as such.
 */
async function allowRoomCreation(request, env) {
  if (!env.ROOM_LIMITER?.limit) return true;
  const who = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await env.ROOM_LIMITER.limit({ key: `rooms:${who}` });
  return success !== false;
}

export default {
  async fetch(request, env) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return refuse('bad_request');
    }
    const segments = url.pathname.split('/').filter(Boolean);
    const method = request.method || 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'stacki-secure-relay', version: VERSION });
    }

    if ((method === 'GET' || method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(method === 'HEAD' ? null : landingHtml, { headers: await headersForLanding() });
    }

    const roomFor = (roomId) => env.ROOM.getByName(roomId);

    // POST /v2/rooms
    if (method === 'POST' && url.pathname === '/v2/rooms') {
      if (!(await allowRoomCreation(request, env))) return refuse('rate_limited', 'Too many rooms from here just now.');
      const read = await readJson(request);
      if (!read.ok) return refuse(read.code);
      const { roomId, senderId, publicKey } = read.body;
      if (typeof roomId !== 'string' || !roomId) return refuse('bad_room');
      return answer(await roomFor(roomId).create({ roomId, senderId, publicKey }));
    }

    // POST /v2/join
    if (method === 'POST' && url.pathname === '/v2/join') {
      const read = await readJson(request);
      if (!read.ok) return refuse(read.code);
      const { roomId, invite, senderId, publicKey } = read.body;
      if (typeof roomId !== 'string' || !roomId) return refuse('bad_room');
      return answer(await roomFor(roomId).join({ roomId, invite, senderId, publicKey }));
    }

    if (segments[0] === 'v2' && segments[1] === 'rooms' && segments[2]) {
      const roomId = decodeURIComponent(segments[2]);
      const stub = roomFor(roomId);
      const token = bearerOf(request.headers.get('authorization'));

      // GET /v2/rooms/:room/watch — the only path that stays a fetch, because
      // a WebSocket upgrade is not something RPC can carry.
      if (method === 'GET' && segments[3] === 'watch' && segments.length === 4) {
        return stub.fetch(request);
      }
      if (!token) return refuse('unauthorized');

      if (method === 'GET' && segments.length === 3) return answer(await stub.status(token));

      if (method === 'GET' && segments[3] === 'envelopes' && segments.length === 4) {
        const after = Number(url.searchParams.get('after'));
        const limit = Number(url.searchParams.get('limit'));
        return answer(await stub.pull({ token, after: Number.isFinite(after) ? after : 0, limit: Number.isFinite(limit) ? limit : undefined }));
      }

      if (method === 'POST' && segments[3] === 'envelopes' && segments.length === 4) {
        const read = await readJson(request);
        if (!read.ok) return refuse(read.code);
        if (!Array.isArray(read.body.envelopes)) return refuse('bad_request', 'envelopes must be a list.');
        return answer(await stub.push({ token, envelopes: read.body.envelopes }));
      }

      if (method === 'POST' && segments[3] === 'invites' && segments.length === 4) {
        const read = await readJson(request);
        if (!read.ok) return refuse(read.code);
        return answer(await stub.invite({ token, ttlMs: read.body.ttlMs }));
      }

      if (method === 'DELETE' && segments[3] === 'membership' && segments[4] === 'me' && segments.length === 5) {
        return answer(await stub.leave(token));
      }

      if (method === 'DELETE' && segments.length === 3) {
        const ended = await stub.end(token);
        return ended.ok ? json({ ok: true }) : refuse(ended.code, 'Only the person who started this share can end it.');
      }
    }

    return refuse('not_found', 'No such endpoint.');
  },
};
