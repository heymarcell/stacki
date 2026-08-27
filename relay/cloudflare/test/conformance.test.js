// The Cloudflare relay, against the same suite the Node one answers.
//
//   npm test        (in relay/cloudflare)
//
// These run inside workerd, through `@cloudflare/vitest-pool-workers`, against
// a real Durable Object with real SQLite storage. Nothing is mocked, and that
// is deliberate: the properties worth testing here — that an invitation cannot
// be redeemed twice by two simultaneous requests, that a sequence is a
// sequence, that storage survives — are exactly the properties a mock would
// assert about itself.
//
// The first test is `test/relay-conformance.js`, shared with the Node relay
// and imported rather than reimplemented. If the two relays ever disagree
// about what the protocol means, one of them fails this.

import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

import { runConformance, newMember, envelopeFrom, randomBytes, CONFORMANCE_CHECKS } from '../../../test/relay-conformance.js';
import { toBase64Url } from '../../protocol.js';

const ORIGIN = 'https://relay.test';

/** One request, in the shape the conformance suite wants. */
const call = async (path, { method = 'GET', body = null, headers = {} } = {}) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body != null ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
};

const bearer = (token) => ({ authorization: `Bearer ${token}` });

/** A room with one member, ready to use. */
async function freshRoom() {
  const owner = await newMember();
  const roomId = toBase64Url(randomBytes(16));
  const created = await call('/v2/rooms', {
    method: 'POST',
    body: { roomId, senderId: owner.senderId, publicKey: owner.publicKey },
  });
  return { owner, roomId, token: created.body.credential.token };
}

describe('protocol conformance', () => {
  // The timeout lives in vitest.config.js: this waits out a real invitation
  // expiry, because that is the only way to observe one expiring.
  it('answers the same suite as the Node relay', async () => {
    const { checked, failures } = await runConformance({ call, label: 'cloudflare' });
    expect(failures.join('\n')).toBe('');
    expect(checked).toBe(CONFORMANCE_CHECKS);
  });
});

describe('the landing page', () => {
  it('is served with a policy that forbids third parties', async () => {
    const response = await SELF.fetch(`${ORIGIN}/`);
    expect(response.status).toBe(200);
    const csp = response.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'sha256-/);
    expect(csp).not.toContain('unsafe-inline; script');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    const html = await response.text();
    // Nothing is fetched from anywhere. The only outside address on the page
    // is the link somebody follows on purpose when they do not have Stacki.
    const urls = html.match(/https?:\/\/[^"'\s)]+/g) || [];
    expect(urls.every((u) => u.startsWith('https://stacki.app'))).toBe(true);
    // Nothing is loaded and nothing is sent: no external script, no
    // stylesheet, no image, and no code that could call out.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/\bfetch\(|XMLHttpRequest|navigator\.sendBeacon/);
  });
});

describe('the durable object stores nothing readable', () => {
  it('keeps ciphertext and no plaintext review metadata', async () => {
    const { owner, roomId, token } = await freshRoom();
    const envelope = await envelopeFrom(owner, roomId);
    const pushed = await call(`/v2/rooms/${roomId}/envelopes`, {
      method: 'POST',
      body: { envelopes: [envelope] },
      headers: bearer(token),
    });
    expect(pushed.status).toBe(200);

    const stub = env.ROOM.getByName(roomId);
    await runInDurableObject(stub, async (room) => {
      const tables = room.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table'")
        .toArray()
        .map((r) => r.name);
      // The schema itself is the claim: there is nowhere for a comment to go.
      expect(tables).toContain('envelopes');
      const columns = room.ctx.storage.sql.exec('PRAGMA table_info(envelopes)').toArray().map((c) => c.name);
      expect(columns.sort()).toEqual(
        ['ciphertext', 'envelope_id', 'nonce', 'received_at', 'seq', 'sender_id', 'signature'].sort()
      );
      for (const forbidden of ['body', 'thread_id', 'actor_id', 'actor_name', 'type', 'anchor', 'provenance']) {
        expect(columns).not.toContain(forbidden);
      }

      // And the rows hold what was sent, unchanged and unreadable.
      const rows = room.ctx.storage.sql.exec('SELECT * FROM envelopes').toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].ciphertext).toBe(envelope.ciphertext);

      // Credentials are hashes.
      const members = room.ctx.storage.sql.exec('SELECT * FROM members').toArray();
      expect(members.every((m) => /^[0-9a-f]{64}$/.test(m.token_hash))).toBe(true);
      expect(JSON.stringify(members)).not.toContain(token);
    });
  });

  it('never holds a room secret, because it is never sent one', async () => {
    const { roomId } = await freshRoom();
    const stub = env.ROOM.getByName(roomId);
    await runInDurableObject(stub, async (room) => {
      // Our four tables. `sqlite_master` also lists the runtime's own internal
      // ones, which a Durable Object is not permitted to read.
      const ours = ['room_meta', 'members', 'invites', 'envelopes'];
      const everything = ours
        .map((name) => JSON.stringify(room.ctx.storage.sql.exec(`SELECT * FROM ${name}`).toArray()))
        .join('');
      expect(everything).not.toContain('secret');
      expect(everything).not.toContain('private');
    });
  });
});

describe('the wake signal', () => {
  it('tells a watcher the head, and carries nothing else', async () => {
    const { owner, roomId, token } = await freshRoom();

    const upgrade = await SELF.fetch(`${ORIGIN}/v2/rooms/${roomId}/watch`, {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `stacki-secure-review.v2, ${token}` },
    });
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    expect(socket).toBeTruthy();

    const seen = [];
    socket.accept();
    socket.addEventListener('message', (event) => seen.push(JSON.parse(event.data)));

    // The head, as soon as the socket is open.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toEqual({ type: 'head', cursor: 0 });

    const envelope = await envelopeFrom(owner, roomId);
    await call(`/v2/rooms/${roomId}/envelopes`, { method: 'POST', body: { envelopes: [envelope] }, headers: bearer(token) });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(seen.length).toBeGreaterThanOrEqual(2);
    const last = seen[seen.length - 1];
    expect(last.type).toBe('head');
    expect(last.cursor).toBe(1);
    // No review data travels over this socket. Ever.
    expect(Object.keys(last).sort()).toEqual(['cursor', 'type']);
    socket.close();
  });

  it('refuses a socket with no credential', async () => {
    const { roomId } = await freshRoom();
    const refused = await SELF.fetch(`${ORIGIN}/v2/rooms/${roomId}/watch`, {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'stacki-secure-review.v2, not-a-token' },
    });
    expect(refused.status).toBe(401);
  });

  it('refuses a socket with the wrong subprotocol', async () => {
    const { roomId, token } = await freshRoom();
    const refused = await SELF.fetch(`${ORIGIN}/v2/rooms/${roomId}/watch`, {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `something-else, ${token}` },
    });
    expect(refused.status).toBe(400);
  });

  it('is not needed for correctness — HTTP alone delivers', async () => {
    const { owner, roomId, token } = await freshRoom();
    const envelope = await envelopeFrom(owner, roomId);
    await call(`/v2/rooms/${roomId}/envelopes`, { method: 'POST', body: { envelopes: [envelope] }, headers: bearer(token) });
    const pulled = await call(`/v2/rooms/${roomId}/envelopes?after=0`, { headers: bearer(token) });
    expect(pulled.body.envelopes).toHaveLength(1);
    expect(pulled.body.envelopes[0].ciphertext).toBe(envelope.ciphertext);
  });
});

describe('retention', () => {
  it('schedules its own sweep and keeps a busy room', async () => {
    const { roomId, token } = await freshRoom();
    const stub = env.ROOM.getByName(roomId);

    await runInDurableObject(stub, async (room) => {
      expect(await room.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
    });

    // An alarm that fires while the room is still in use re-schedules rather
    // than deleting: activity since the alarm was set has already moved the
    // deadline, and an early fire must not take somebody's room with it.
    await call(`/v2/rooms/${roomId}`, { headers: bearer(token) });
    await runInDurableObject(stub, async (room) => {
      await room.alarm();
      expect(room.meta).toBeTruthy();
      expect(await room.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
    });
  });

  it('deletes an abandoned room when the sweep is genuinely due', async () => {
    const { roomId } = await freshRoom();
    const stub = env.ROOM.getByName(roomId);
    await runInDurableObject(stub, async (room) => {
      // Backdate the room past the retention window, then let its alarm run.
      room.ctx.storage.sql.exec('UPDATE room_meta SET last_activity = ?', 0);
      await room.alarm();
      expect(room.meta).toBeNull();
    });
  });
});

describe('ending a room', () => {
  it('removes every trace of it from the relay', async () => {
    const { owner, roomId, token } = await freshRoom();
    const envelope = await envelopeFrom(owner, roomId);
    await call(`/v2/rooms/${roomId}/envelopes`, { method: 'POST', body: { envelopes: [envelope] }, headers: bearer(token) });

    const ended = await call(`/v2/rooms/${roomId}`, { method: 'DELETE', headers: bearer(token) });
    expect(ended.status).toBe(200);

    const stub = env.ROOM.getByName(roomId);
    await runInDurableObject(stub, async (room) => {
      expect(room.meta).toBeNull();
      expect(room.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM envelopes').toArray()[0].n).toBe(0);
      expect(room.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM members').toArray()[0].n).toBe(0);
      expect(await room.ctx.storage.getAlarm()).toBeNull();
    });
  });
});

describe('invite brute force', () => {
  it('is bounded per room', async () => {
    const { roomId } = await freshRoom();
    const guesser = await newMember();
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      const attempt = await call('/v2/join', {
        method: 'POST',
        body: { roomId, invite: toBase64Url(randomBytes(32)), senderId: guesser.senderId, publicKey: guesser.publicKey },
      });
      if (attempt.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});
