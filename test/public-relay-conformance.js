// The protocol, against a relay that is actually on the internet.
//
//   STACKI_PUBLIC_RELAY=https://…workers.dev node test/public-relay-conformance.js
//
// test/secure-relay.js runs the shared suite against a Node relay in this
// process. relay/cloudflare runs it against a Durable Object inside workerd.
// Both are real, and both are on this machine — so between them they still
// prove nothing about TLS termination, about Cloudflare's own request parsing,
// about what a hosted runtime does with a header it did not expect, or about
// whether the thing that answers `relay.stacki.app` one day is the thing this
// repository tests.
//
// This runs the SAME suite — one file, no forked expectations — over public
// HTTPS against a deployed Worker. If the deployment and the repository ever
// disagree about what the protocol means, this is where it shows.
//
// It creates real rooms on a real service. They are disposable and it ends
// every one it owns; see the teardown at the bottom.

const fs = require('node:fs');
const { runConformance, CONFORMANCE_CHECKS } = require('./relay-conformance.js');
const { usePublicNetwork } = require('./support/publicFetch.js');

// Before any request: see test/support/publicFetch.js for why Node needs
// telling how to reach a host that curl reaches without being told.
usePublicNetwork();

const BASE = (process.env.STACKI_PUBLIC_RELAY || '').replace(/\/+$/, '');
const say = (t) => fs.writeSync(1, `${t}\n`);
const shout = (t) => fs.writeSync(2, `${t}\n`);

if (!BASE) {
  shout('public-relay-conformance: set STACKI_PUBLIC_RELAY to the deployed https origin');
  process.exit(2);
}
if (!BASE.startsWith('https://')) {
  shout(`public-relay-conformance: refusing a non-https origin (${BASE})`);
  process.exit(2);
}

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

// Every room this run makes, so it can take them away again.
const owned = [];

/**
 * One HTTP call to the deployed relay.
 *
 * Deliberately the same shape the in-process suites use, so the conformance
 * file cannot tell the difference — that is the point. The only additions are
 * a timeout, because a public network can hang where a loopback cannot, and a
 * note of every room created so teardown can find them.
 */
let calls = 0;
let retried = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (pathname, { method = 'GET', body = null, headers = {} } = {}) => {
  calls++;
  const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
  let response = null;
  let lastError = null;

  // A PUBLIC NETWORK DROPS CONNECTIONS AND A LOOPBACK DOES NOT.
  //
  // The in-process suites never see this; a few hundred sequential TLS
  // handshakes across the internet occasionally do. Retried only when NO
  // response arrived at all — never on an HTTP status, because a status is an
  // answer and re-asking would be testing something else. The request is byte
  // for byte identical, so a create whose response was lost re-sends the same
  // roomId and the relay's own conflict handling decides, which is exactly
  // what a real client would do.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(`${BASE}${pathname}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(payload != null ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(payload != null ? { body: payload } : {}),
        signal: AbortSignal.timeout(20000),
      });
      break;
    } catch (err) {
      lastError = err?.name === 'TimeoutError' ? 'timeout' : String(err?.cause?.code || err?.message || err);
      response = null;
      if (attempt < 2) {
        retried++;
        await sleep(600 * (attempt + 1));
      }
    }
  }
  if (!response) return { status: 0, body: null, error: lastError };
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  // Remember rooms we own so the teardown can end them.
  if (method === 'POST' && pathname === '/v2/rooms' && parsed?.credential?.token) {
    owned.push({ roomId: body?.roomId, token: parsed.credential.token });
  }
  return { status: response.status, body: parsed };
};

(async () => {
  say(`public-relay-conformance: ${BASE}`);

  // Reachable at all, over real TLS, before spending a suite on it.
  const health = await call('/health');
  check('the deployed relay answers /health', health.status === 200 && health.body?.ok === true, JSON.stringify(health).slice(0, 160));
  check('and names itself as the secure relay', health.body?.service === 'stacki-secure-relay', String(health.body?.service));
  check('speaking protocol version 2', health.body?.version === 2, String(health.body?.version));

  // --- the shared suite, unmodified ----------------------------------------
  const conformance = await runConformance({ call, label: 'cloudflare-public' });
  for (const f of conformance.failures || []) failures.push(f);
  checked += conformance.checked || 0;
  check(
    'the whole conformance suite ran, not part of it',
    conformance.checked === CONFORMANCE_CHECKS,
    `${conformance.checked} of ${CONFORMANCE_CHECKS} — a section stopped early`
  );

  // --- things only a hosted deployment can be wrong about -------------------
  //
  // None of these are protocol behaviour, so they do not belong in the shared
  // suite. They are what a real edge in front of the Worker adds.

  say('  the edge in front of it');

  // A body larger than the cap must be refused, and refused BEFORE it is
  // buffered — the Worker reads incrementally and cancels. Over a real
  // network this also exercises Cloudflare's own request handling.
  const huge = 'x'.repeat(200_000);
  const over = await call('/v2/rooms', { method: 'POST', body: `{"roomId":"a","pad":"${huge}"}` });
  check('an oversized body is refused, not accepted', over.status >= 400, `http ${over.status}`);
  check('  with a bounded JSON error, not a stack trace', !!over.body && typeof over.body === 'object', JSON.stringify(over.body).slice(0, 120));
  check('  and no stack trace anywhere in it', !/\bat \w+ \(|\.js:\d+/.test(JSON.stringify(over.body || {})), JSON.stringify(over.body).slice(0, 160));

  // A lying Content-Length must not get past the declared-length check.
  const lied = await call('/v2/rooms', {
    method: 'POST',
    body: '{"roomId":"a"}',
    headers: { 'content-length': String(50 * 1024 * 1024) },
  });
  check('a request claiming to be enormous is refused', lied.status >= 400 || lied.status === 0, `http ${lied.status}`);

  // Unknown endpoints, unknown rooms, and missing auth all answer in the
  // protocol's own vocabulary rather than in the platform's.
  const nowhere = await call('/not-a-thing');
  check('an unknown path is a clean 404', nowhere.status === 404, `http ${nowhere.status}`);
  check('  answering in JSON', !!nowhere.body?.error, JSON.stringify(nowhere.body).slice(0, 120));

  const noAuth = await call('/v2/rooms/nonexistent-room');
  check('a room request with no credential is refused', noAuth.status === 401, `http ${noAuth.status}`);
  check('  and does not say whether the room exists', !/not.?found|no such room/i.test(JSON.stringify(noAuth.body || {})), JSON.stringify(noAuth.body).slice(0, 120));

  // Security headers on the landing page, from the deployment rather than the
  // source file.
  let page = null;
  for (let attempt = 0; attempt < 3 && !page; attempt++) {
    try {
      page = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(20000) });
    } catch {
      retried++;
      await sleep(600 * (attempt + 1));
    }
  }
  check('the landing page could be fetched at all', !!page);
  const h = (name) => (page ? page.headers.get(name) || '' : '');
  check('the landing page is served', page?.status === 200, `http ${page?.status}`);
  check('  with a content security policy', /default-src 'none'/.test(h('content-security-policy')), h('content-security-policy').slice(0, 90));
  check('  allowing exactly one script, by hash', /script-src 'sha256-/.test(h('content-security-policy')));
  check('  no referrer', h('referrer-policy') === 'no-referrer', h('referrer-policy'));
  check('  no sniffing', h('x-content-type-options') === 'nosniff', h('x-content-type-options'));
  check('  no framing', /frame-ancestors 'none'/.test(h('content-security-policy')));
  check('  no indexing', /noindex/.test(h('x-robots-tag')), h('x-robots-tag'));
  check('  and nothing cached', /no-store/.test(h('cache-control')), h('cache-control'));

  // --- take back every room this run made ----------------------------------
  say('  cleaning up');
  // WHAT MATTERS IS THAT THE ROOM IS UNUSABLE, not which refusal says so.
  //
  // The conformance suite ends the room it owns as part of testing owner-end,
  // so this second DELETE arrives at a room that is already gone and is
  // refused rather than accepted. Asserting `200` here failed a run in which
  // nothing had leaked. So the statuses are reported for the log, and the
  // check is the one that means something: ask for the room afterwards and it
  // must not answer.
  const codes = [];
  for (const room of owned) {
    if (!room.roomId || !room.token) continue;
    const gone = await call(`/v2/rooms/${encodeURIComponent(room.roomId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${room.token}` },
    });
    codes.push(gone.status);
  }
  say(`    end responses: ${codes.join(', ') || '(none)'}`);

  let stillThere = 0;
  for (const room of owned) {
    const after = await call(`/v2/rooms/${encodeURIComponent(room.roomId)}`, {
      headers: { authorization: `Bearer ${room.token}` },
    });
    if (after.status === 200) stillThere += 1;
  }
  check('no room this run created is still live', stillThere === 0, `${stillThere} of ${owned.length} still answering`);

  say(`  ${calls} HTTP calls, ${owned.length} disposable rooms, ${retried} network retries`);
  check('the public network did not need excessive retrying', retried <= Math.max(5, calls * 0.05), `${retried} retries in ${calls} calls`);

  if (failures.length) {
    shout(`\npublic-relay-conformance: ${failures.length} failed, ${checked - failures.length} passed\n`);
    shout(failures.join('\n') + '\n');
    process.exit(1);
  }
  say(`\npublic-relay-conformance: ${checked} checks passed  [real TLS, real edge, real Durable Object]`);
})().catch((err) => {
  shout(`public-relay-conformance: threw\n${err?.stack || err}`);
  process.exit(1);
});
