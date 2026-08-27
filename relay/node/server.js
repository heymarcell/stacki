// The Node secure relay.
//
// The reference implementation of the v2 protocol, and the thing that makes
// self-hosting first class rather than a footnote: everything Secure Share can
// do, it can do against this, with no Stacki account, no Cloudflare account,
// and no proprietary anything. Cloudflare is an implementation of this
// protocol. It is not the protocol.
//
// WHAT THIS PROGRAM CANNOT DO, and the list is the feature:
//
//   It cannot read a review. It has no key. Not a key it declines to use — it
//   has never been sent one.
//
//   It cannot parse a review event. It does not import Stacki's event module;
//   there is a test that greps this directory for it. What arrives is a nonce,
//   a ciphertext and a signature, and what it knows how to do with them is
//   check the signature, count the bytes and put them in a row.
//
//   It cannot name a person. The only identifier it holds is an HMAC under a
//   key it does not have, and the only name-like thing in the schema is that
//   HMAC. No display names, no actor ids, no emails, no project name, no git
//   remote.
//
// WHAT IT DOES DO is order things and hold them. A room gets one sequence of
// envelopes so that "everything after 47" means the same to everybody, and it
// keeps them while the share exists so that Bob opening Stacki on Friday sees
// what Alice wrote on Monday and closed her laptop.
//
// Nothing is logged that could be a secret — see `note`, and the audit in
// test/secure-share.js that greps the log stream for canaries.

const http = require('node:http');
const crypto = require('node:crypto');

const { openStore } = require('./store.js');
const {
  VERSION,
  ERRORS,
  MAX_BODY_BYTES,
  MAX_BATCH,
  MAX_PAGE,
  IDLE_ROOM_TTL_MS,
  readEnvelope,
  serveEnvelope,
  signingBytes,
  isRoomId,
  isSenderId,
  isPublicKey,
  isCredential,
  fromBase64Url,
} = require('../protocol.js');

const DEFAULT_PORT = 43823;
const DEFAULT_HOST = '127.0.0.1';

// A very small amount of abuse resistance, and deliberately not a security
// boundary — see the protocol document. It exists so a public relay is not a
// free resource for whoever finds the port, and nothing is authorised by it.
const RATE_WINDOW_MS = 60_000;
const RATE_LIMITS = { rooms: 20, join: 30 };

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_SUBPROTOCOL = 'stacki-secure-review.v2';

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // Nothing here is for a browser and no page should be able to read it.
    'referrer-policy': 'no-referrer',
  });
  res.end(text);
}

const refuse = (res, code, message = null) =>
  sendJson(res, ERRORS[code] || 400, { error: code, message: message || null });

/** Read a JSON body, or refuse it by name. Never buffers past the cap. */
function readJson(req) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return resolve({ ok: false, code: 'too_large' });
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      // Bytes: `chunk` is a Buffer, so `length` is its byte length. Counting
      // characters instead would under-count multibyte UTF-8 by up to a
      // factor of two — see the note in the Worker's reader.
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve({ ok: false, code: 'too_large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({ ok: true, body: {} });
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return resolve({ ok: false, code: 'bad_json' });
        resolve({ ok: true, body: parsed });
      } catch {
        resolve({ ok: false, code: 'bad_json' });
      }
    });
    req.on('error', () => resolve({ ok: false, code: 'bad_request' }));
  });
}

const bearerOf = (header) => {
  if (typeof header !== 'string') return null;
  const m = /^Bearer[ ]+([A-Za-z0-9_-]{1,128})$/i.exec(header.trim());
  return m ? m[1] : null;
};

/**
 * Whether an envelope was signed by the member presenting it.
 *
 * The relay checks this so that a member cannot fill a room with envelopes
 * attributed to somebody else, and so that garbage is refused before it is
 * stored. It is NOT what the recipients rely on — they verify again, against a
 * key they pinned themselves, because a relay's word about a signature is
 * worth exactly as much as the relay.
 */
function verifySignature({ roomId, envelope, publicKey }) {
  const raw = fromBase64Url(publicKey, 32);
  const sig = fromBase64Url(envelope.signature, 64);
  if (!raw || !sig) return false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    const bytes = signingBytes({
      roomId,
      envelopeId: envelope.envelopeId,
      senderId: envelope.senderId,
      nonce: envelope.nonce,
      ciphertext: envelope.bytes.ciphertext,
    });
    return crypto.verify(null, Buffer.from(bytes), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

/** A fixed-window counter per source. Coarse, in memory, and enough. */
function createLimiter({ now = Date.now, limits = RATE_LIMITS } = {}) {
  const seen = new Map();
  return {
    allow(kind, who) {
      const at = now();
      const key = `${kind}:${who}`;
      const entry = seen.get(key);
      if (!entry || at - entry.since > RATE_WINDOW_MS) {
        seen.set(key, { since: at, n: 1 });
        // Opportunistic sweep: this map is only as big as the last minute of
        // distinct sources, and nothing here is worth a timer.
        if (seen.size > 5000) for (const [k, v] of seen) if (at - v.since > RATE_WINDOW_MS) seen.delete(k);
        return true;
      }
      entry.n += 1;
      return entry.n <= (limits[kind] || 60);
    },
  };
}

// --- the wake signal --------------------------------------------------------
//
// A WebSocket that carries one message shape and no review data whatever:
//
//     { "type": "head", "cursor": 184 }
//
// A client that sees a higher cursor runs an ordinary HTTP sync. There is one
// synchronisation protocol and this is a doorbell for it. If the socket never
// connects, or drops and never comes back, nothing is lost and nothing is
// late beyond the next ordinary sync.

/** A server-to-client text frame. Server frames are never masked. */
function textFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const head = Buffer.alloc(4);
  head[0] = 0x81;
  head[1] = 126;
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

/**
 * Enough of RFC 6455 to notice a close and answer a ping.
 *
 * The relay never reads an application message from a client — there is
 * nothing a client could say here that the HTTP API does not say better — so
 * this only has to keep the connection honest rather than parse a protocol.
 */
function readFrames(buffer, { onClose, onPing }) {
  let at = 0;
  while (buffer.length - at >= 2) {
    const opcode = buffer[at] & 0x0f;
    const masked = (buffer[at + 1] & 0x80) === 0x80;
    let length = buffer[at + 1] & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      if (buffer.length < offset + 2) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      // A client sending a 64-bit length to a socket that reads nothing is
      // not a client this needs to serve.
      onClose();
      return buffer.length;
    }
    if (masked) offset += 4;
    if (buffer.length < offset + length) break;
    if (opcode === 0x8) {
      onClose();
      return buffer.length;
    }
    if (opcode === 0x9) onPing();
    at = offset + length;
  }
  return at;
}

function createSecureRelay({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  file = ':memory:',
  now = Date.now,
  onError = null,
  log = null,
  landing = null,
  idleTtlMs = IDLE_ROOM_TTL_MS,
  // A self-hosting knob. Rate limiting is not authorisation and never stands
  // in for it — see the protocol document — so a relay behind somebody's own
  // firewall is entitled to a different number here.
  rateLimits = RATE_LIMITS,
} = {}) {
  const store = openStore({ file, now });
  const limiter = createLimiter({ now, limits: rateLimits });
  // roomId -> Set of sockets. Nothing durable; a relay restart drops every
  // watcher and every client falls back to HTTP, which is the design.
  const watchers = new Map();

  /**
   * What may be written down.
   *
   * A coarse code and, at most, nothing else. No authorization header, no
   * token, no invitation, no room id, no sender id, no body, no ciphertext, no
   * URL. There is a test that runs a whole share through this and greps the
   * output for every secret it created.
   */
  const note = (code) => {
    try {
      log?.(code);
    } catch {
      /* a logger that throws must not take the request with it */
    }
  };
  const report = (err) => {
    try {
      onError?.(err);
    } catch {
      /* same */
    }
  };

  function wake(roomId) {
    const set = watchers.get(roomId);
    if (!set?.size) return;
    const frame = textFrame(JSON.stringify({ type: 'head', cursor: store.headOf(roomId) }));
    for (const socket of set) {
      try {
        socket.write(frame);
      } catch {
        set.delete(socket);
      }
    }
  }

  const sourceOf = (req) => req.socket?.remoteAddress || 'unknown';

  /** The member a request is made by, plus the room, or a refusal. */
  function authenticate(req, roomId) {
    const member = store.memberFor(bearerOf(req.headers.authorization));
    // ONE ANSWER FOR EVERY WAY OF NOT BEING IN THIS ROOM. A wrong credential,
    // a credential for a different room, a room that was never created and a
    // room that has ended all answer 401 — because any code that told them
    // apart would tell somebody holding one valid token which other rooms
    // exist. The Cloudflare relay gives the same answer for a structural
    // reason as well: a room is its own Durable Object, and it genuinely
    // cannot distinguish a stranger's token from another room's.
    if (!member || member.room_id !== roomId) return { ok: false, code: 'unauthorized' };
    const room = store.roomFor(roomId);
    if (!room || room.ended_at) return { ok: false, code: 'unauthorized' };
    return { ok: true, member, room };
  }

  async function route(req, res, url) {
    const segments = url.pathname.split('/').filter(Boolean);
    const method = req.method || 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'stacki-secure-relay', version: VERSION });
    }

    // The share landing page, so a self-hoster's invitation links work without
    // depending on Stacki's hosted service for anything at all.
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') && landing) {
      return landing(req, res);
    }

    // POST /v2/rooms — start one. No credential: there is nothing yet to hold
    // one. Bounded by rate limit, and by the fact that a room is worthless
    // without the secret its creator kept.
    if (method === 'POST' && url.pathname === '/v2/rooms') {
      if (!limiter.allow('rooms', sourceOf(req))) {
        note('rate_limited');
        return refuse(res, 'rate_limited', 'Too many rooms from here just now.');
      }
      const read = await readJson(req);
      if (!read.ok) return refuse(res, read.code);
      const { roomId, senderId, publicKey } = read.body;
      if (!isRoomId(roomId)) return refuse(res, 'bad_room');
      if (!isSenderId(senderId)) return refuse(res, 'bad_sender');
      if (!isPublicKey(publicKey)) return refuse(res, 'bad_key');
      const made = store.createRoom({ roomId, senderId, publicKey });
      if (!made.ok) return refuse(res, made.code);
      note('room_created');
      return sendJson(res, 200, { room: made.room, credential: made.credential });
    }

    // POST /v2/join — redeem an invitation. Unauthenticated by necessity: the
    // invitation IS the credential, and it is single-use and expiring.
    if (method === 'POST' && url.pathname === '/v2/join') {
      if (!limiter.allow('join', sourceOf(req))) {
        note('rate_limited');
        return refuse(res, 'rate_limited', 'Too many attempts from here just now.');
      }
      const read = await readJson(req);
      if (!read.ok) return refuse(res, read.code);
      const { roomId, invite, senderId, publicKey } = read.body;
      if (!isRoomId(roomId)) return refuse(res, 'bad_room');
      if (!isCredential(invite)) return refuse(res, 'bad_invite', 'That invitation cannot be used.');
      if (!isSenderId(senderId)) return refuse(res, 'bad_sender');
      if (!isPublicKey(publicKey)) return refuse(res, 'bad_key');
      const joined = store.redeemInvite({ roomId, invite, senderId, publicKey });
      if (!joined.ok) {
        return refuse(res, joined.code, joined.code === 'bad_invite' ? 'That invitation cannot be used.' : null);
      }
      note('member_joined');
      note('invite_redeemed');
      return sendJson(res, 200, {
        room: joined.room,
        credential: joined.credential,
        // Who this member now is, which matters for somebody REJOINING: a
        // member row keeps its ownership when its token is replaced, so an
        // owner who left and was invited back is still the owner and the
        // client should not have to guess.
        member: { senderId, isOwner: joined.isOwner === true },
        members: store.membersOf(roomId).map((m) => ({ senderId: m.senderId, publicKey: m.publicKey })),
      });
    }

    if (segments[0] === 'v2' && segments[1] === 'rooms' && segments[2]) {
      const roomId = decodeURIComponent(segments[2]);
      const auth = authenticate(req, roomId);
      if (!auth.ok) return refuse(res, auth.code);
      const { member, room } = auth;

      // GET /v2/rooms/:room
      if (method === 'GET' && segments.length === 3) {
        store.touch(roomId);
        return sendJson(res, 200, {
          room: {
            id: room.id,
            createdAt: room.created_at,
            endedAt: room.ended_at,
            envelopeCount: room.envelope_count,
            storedBytes: room.stored_bytes,
          },
          member: { senderId: member.sender_id, isOwner: !!member.is_owner },
          members: store.membersOf(roomId),
          head: store.headOf(roomId),
        });
      }

      // GET /v2/rooms/:room/envelopes?after=&limit=
      if (method === 'GET' && segments[3] === 'envelopes' && segments.length === 4) {
        const after = Number(url.searchParams.get('after'));
        const limit = Number(url.searchParams.get('limit'));
        const page = store.envelopesAfter({
          roomId,
          after: Number.isInteger(after) && after > 0 ? after : 0,
          limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_PAGE) : MAX_PAGE,
        });
        store.touch(roomId);
        return sendJson(res, 200, {
          envelopes: page.envelopes.map(serveEnvelope),
          cursor: page.cursor,
          hasMore: page.hasMore,
        });
      }

      // POST /v2/rooms/:room/envelopes
      if (method === 'POST' && segments[3] === 'envelopes' && segments.length === 4) {
        const read = await readJson(req);
        if (!read.ok) return refuse(res, read.code);
        const incoming = Array.isArray(read.body.envelopes) ? read.body.envelopes : null;
        if (!incoming) return refuse(res, 'bad_request', 'envelopes must be a list.');
        if (incoming.length > MAX_BATCH) return refuse(res, 'too_many', `At most ${MAX_BATCH} envelopes per request.`);

        const good = [];
        const rejected = [];
        for (const raw of incoming) {
          const checked = readEnvelope(raw);
          if (!checked.ok) {
            rejected.push({ envelopeId: typeof raw?.envelopeId === 'string' ? raw.envelopeId.slice(0, 64) : null, code: checked.code });
            continue;
          }
          // A member may only speak as themselves. This is the relay half of
          // the authorship rule; the recipients enforce the other half without
          // needing to trust this one.
          if (checked.envelope.senderId !== member.sender_id) {
            rejected.push({ envelopeId: checked.envelope.envelopeId, code: 'bad_sender' });
            continue;
          }
          if (!verifySignature({ roomId, envelope: checked.envelope, publicKey: member.public_key })) {
            note('bad_signature');
            rejected.push({ envelopeId: checked.envelope.envelopeId, code: 'bad_signature' });
            continue;
          }
          good.push(checked.envelope);
        }

        let result = { accepted: [], cursor: store.headOf(roomId), added: 0 };
        if (good.length) {
          try {
            result = store.appendEnvelopes({ roomId, envelopes: good });
          } catch (err) {
            report(err);
            return refuse(res, 'internal_error', 'The relay could not store that.');
          }
          if (!result.ok) return refuse(res, result.code, 'This secure share has reached its limit.');
        }
        if (result.added) {
          note('envelope_accepted');
          wake(roomId);
        }
        return sendJson(res, 200, { accepted: result.accepted, rejected, cursor: result.cursor });
      }

      // POST /v2/rooms/:room/invites
      if (method === 'POST' && segments[3] === 'invites' && segments.length === 4) {
        const read = await readJson(req);
        if (!read.ok) return refuse(res, read.code);
        const made = store.createInvite({ roomId, senderId: member.sender_id, ttlMs: read.body.ttlMs });
        if (!made.ok) return refuse(res, made.code, 'This share already has as many open invitations as it allows.');
        note('invite_created');
        return sendJson(res, 200, { invite: made.invite, expiresAt: made.expiresAt });
      }

      // DELETE /v2/rooms/:room/membership/me — leave.
      if (method === 'DELETE' && segments[3] === 'membership' && segments[4] === 'me' && segments.length === 5) {
        store.leaveRoom({ roomId, senderId: member.sender_id });
        note('member_left');
        return sendJson(res, 200, { ok: true });
      }

      // DELETE /v2/rooms/:room — end it, for everybody. The owner alone.
      if (method === 'DELETE' && segments.length === 3) {
        if (!member.is_owner) return refuse(res, 'unauthorized', 'Only the person who started this share can end it.');
        store.endRoom(roomId);
        const set = watchers.get(roomId);
        if (set) {
          for (const socket of set) socket.destroy();
          watchers.delete(roomId);
        }
        note('room_ended');
        return sendJson(res, 200, { ok: true });
      }
    }

    return refuse(res, 'not_found', 'No such endpoint.');
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      return refuse(res, 'bad_request');
    }
    Promise.resolve(route(req, res, url)).catch((err) => {
      report(err);
      note('internal_error');
      if (!res.headersSent) refuse(res, 'internal_error', 'The relay could not answer that.');
      else res.end();
    });
  });

  // GET /v2/rooms/:room/watch — the doorbell.
  server.on('upgrade', (req, socket) => {
    const bye = () => {
      try {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      } catch {
        /* already gone */
      }
      socket.destroy();
    };
    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      return bye();
    }
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'v2' || segments[1] !== 'rooms' || !segments[2] || segments[3] !== 'watch') return bye();
    const roomId = decodeURIComponent(segments[2]);

    // A browser-style WebSocket cannot set an Authorization header, so the
    // credential rides in the subprotocol — which is a header, and is not the
    // URL. A token in a URL is a token in an access log.
    const offered = String(req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (offered[0] !== WS_SUBPROTOCOL) return bye();
    const member = store.memberFor(offered[1]);
    if (!member || member.room_id !== roomId) return bye();
    const room = store.roomFor(roomId);
    if (!room || room.ended_at) return bye();

    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || !key) return bye();
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        `Sec-WebSocket-Protocol: ${WS_SUBPROTOCOL}\r\n\r\n`
    );
    socket.setNoDelay(true);

    let set = watchers.get(roomId);
    if (!set) watchers.set(roomId, (set = new Set()));
    set.add(socket);
    const drop = () => {
      set.delete(socket);
      if (!set.size) watchers.delete(roomId);
      socket.destroy();
    };
    socket.on('error', drop);
    socket.on('close', () => {
      set.delete(socket);
      if (!set.size) watchers.delete(roomId);
    });
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 4096) return drop(); // nothing legitimate is this big
      const used = readFrames(pending, { onClose: drop, onPing: () => socket.write(Buffer.from([0x8a, 0x00])) });
      pending = pending.subarray(used);
    });
    // The current head straight away, so a client that connected after a push
    // does not wait for the next one.
    socket.write(textFrame(JSON.stringify({ type: 'head', cursor: store.headOf(roomId) })));
  });

  server.on('error', report);

  return {
    port,
    host,
    store,
    get url() {
      return `http://${host}:${port}`;
    },
    get watcherCount() {
      let n = 0;
      for (const set of watchers.values()) n += set.size;
      return n;
    },
    sweep: () => store.sweepIdle({ ttlMs: idleTtlMs }),
    start() {
      return new Promise((resolve, reject) => {
        const onceError = (err) => {
          server.removeListener('listening', onceListening);
          reject(err instanceof Error ? err : new Error(String(err)));
        };
        const onceListening = () => {
          server.removeListener('error', onceError);
          server.on('error', report);
          resolve(this);
        };
        server.removeListener('error', report);
        server.once('error', onceError);
        server.once('listening', onceListening);
        server.listen(port, host);
      });
    },
    /** The port actually taken. Tests ask for 0 and want to know. */
    get address() {
      return server.address();
    },
    async stop() {
      for (const set of watchers.values()) for (const socket of set) socket.destroy();
      watchers.clear();
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      store.close();
    },
  };
}

module.exports = {
  createSecureRelay,
  verifySignature,
  createLimiter,
  bearerOf,
  DEFAULT_PORT,
  DEFAULT_HOST,
  WS_SUBPROTOCOL,
  RATE_LIMITS,
  RATE_WINDOW_MS,
};
