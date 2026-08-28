#!/usr/bin/env node
// Run a secure relay of your own.
//
//   node relay/node/bin.js
//   STACKI_RELAY_PORT=8080 STACKI_RELAY_DATA=/var/lib/stacki-relay node relay/node/bin.js
//
// There is no signup token to find and no account to make. A secure room is
// worthless to whoever runs this — the secret that decrypts it never arrives
// here — so gating room creation behind a shared password would be protecting
// nothing, and the thing that actually needs bounding (how much a stranger can
// store) is bounded by the caps in the protocol and by the rate limiter.
//
// It also serves the share landing page at `/`, so invitation links made
// against this relay work without depending on Stacki's hosted service for
// anything at all. That is what §77 of the brief means by self-hosting being
// first class: no protocol behaviour anywhere requires Stacki's Cloudflare
// account, and this file is the proof.
//
// This process is not part of the Stacki desktop app and is never packaged
// into it — `relay/node` is outside `build.files`, and there is a packaging
// test that says so.

const os = require('node:os');
const path = require('node:path');

const { createSecureRelay, DEFAULT_PORT } = require('./server.js');
const { createLanding } = require('../share/serve.js');
const { IDLE_ROOM_TTL_MS } = require('../protocol.js');

const dataDir = process.env.STACKI_RELAY_DATA || path.join(os.homedir(), '.stacki-secure-relay');
const dbFile = path.join(dataDir, 'relay.db');

// How often abandoned rooms are looked for. The TTL is a year; checking once a
// day is plenty and costs one indexed query.
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

async function main() {
  const port = Number(process.env.STACKI_RELAY_PORT) || DEFAULT_PORT;
  // Loopback by default. Binding to every interface is a decision somebody
  // makes on purpose, with a firewall and a TLS terminator in mind — and
  // Stacki will refuse to send a credential to a remote plain-HTTP address, so
  // a public relay needs HTTPS in front of it either way.
  const host = process.env.STACKI_RELAY_HOST || '127.0.0.1';

  const relay = createSecureRelay({
    port,
    host,
    file: dbFile,
    landing: createLanding(),
    log: (code) => console.log(`[secure-relay] ${code}`),
    onError: (err) => console.warn('[secure-relay]', err?.message || err),
  });
  await relay.start();

  console.log(`[secure-relay] listening on http://${host}:${port}`);
  console.log(`[secure-relay] database ${dbFile}`);
  console.log('[secure-relay] in Stacki: Share… → Advanced → Use custom secure relay, and paste that address.');
  console.log(`[secure-relay] rooms with no activity for ${Math.round(IDLE_ROOM_TTL_MS / 86400000)} days are removed.`);

  const sweeper = setInterval(() => {
    const swept = relay.sweep();
    if (swept) console.log(`[secure-relay] rooms_swept ${swept}`);
  }, SWEEP_EVERY_MS);
  sweeper.unref?.();

  const bye = async () => {
    clearInterval(sweeper);
    await relay.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main().catch((err) => {
  console.error('[secure-relay] could not start:', err.message);
  process.exit(1);
});
