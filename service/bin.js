#!/usr/bin/env node
// Run the Shared Reviews service.
//
//   npm run reviews:serve
//   STACKI_REVIEWS_PORT=8080 STACKI_REVIEWS_DATA=/var/lib/stacki node service/bin.js
//
// The signup token is what lets somebody create a workspace here. It is read
// from STACKI_REVIEWS_SIGNUP_TOKEN, or generated once and kept beside the
// database — and it is printed at startup, because a token nobody can find is
// a service nobody can use, and the alternative (printing it every request, or
// logging it) is worse.
//
// This process is not part of the Stacki desktop app and is never packaged
// into it. `service/` is outside `build.files`; the app talks to whatever
// address a person points it at, and works completely with none running.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createReviewService, DEFAULT_PORT } = require('./server');

const dataDir = process.env.STACKI_REVIEWS_DATA || path.join(os.homedir(), '.stacki-reviews');
const dbFile = path.join(dataDir, 'reviews.db');
const tokenFile = path.join(dataDir, 'signup-token');

/** The server's own signup token: from the environment, or made once and kept. */
function signupToken() {
  const fromEnv = process.env.STACKI_REVIEWS_SIGNUP_TOKEN;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  try {
    const saved = fs.readFileSync(tokenFile, 'utf8').trim();
    if (saved.length >= 16) return saved;
  } catch {
    /* none yet */
  }
  const made = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tokenFile, made, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tokenFile, 0o600);
  } catch {
    /* a filesystem with no modes */
  }
  return made;
}

async function main() {
  const port = Number(process.env.STACKI_REVIEWS_PORT) || DEFAULT_PORT;
  // Loopback by default. Binding to every interface is a decision somebody
  // makes on purpose, with a firewall and a reverse proxy in mind.
  const host = process.env.STACKI_REVIEWS_HOST || '127.0.0.1';
  const token = signupToken();
  const service = createReviewService({
    port,
    host,
    file: dbFile,
    signupToken: token,
    log: (line) => console.log(`[shared-reviews] ${line}`),
    onError: (err) => console.warn('[shared-reviews]', err?.message || err),
  });
  await service.start();
  console.log(`[shared-reviews] listening on http://${host}:${port}`);
  console.log(`[shared-reviews] database ${dbFile}`);
  console.log(`[shared-reviews] signup token: ${token}`);
  console.log('[shared-reviews] paste the address and that token into Stacki to start a workspace.');

  const bye = async () => {
    await service.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main().catch((err) => {
  console.error('[shared-reviews] could not start:', err.message);
  process.exit(1);
});
