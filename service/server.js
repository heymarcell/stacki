// The Shared Reviews service.
//
// Small on purpose. Everything a team needs to leave each other comments on
// source-backed objects and nothing else: no billing, no organizations, no
// dashboard, no web front end, no notifications, no OAuth, no GitHub. Five
// routes, one table of events, one table of people.
//
// It is not Stacki's cloud. It is a program you run — `npm run reviews:serve`
// on a laptop, a container on a box somebody's team already owns — and Stacki
// is pointed at it. There is no hard-wired address anywhere in the app.
//
// WHAT IT KNOWS. Review events, and the minimum to say who may read them. It
// has never seen the project. It cannot read a file, run a command, reach git,
// or name a path on anybody's disk — there is no code here that does any of
// those things, which is a stronger statement than a policy about it.
//
// THE SECURITY MODEL, in full:
//
//   Every workspace operation needs a member credential. There is no
//   unauthenticated read of anything but /health.
//
//   Membership is per workspace. A credential for one workspace names one
//   member of one workspace, and workspace ids are random UUIDs — a workspace
//   somebody is not in answers 404, not 403, so the endpoint cannot be used to
//   find out which workspaces exist.
//
//   The SERVER decides who a human is. A member's actor id is fixed at join
//   and every human event is checked against it. Bob's credential cannot push
//   an event signed Alice. Agent events are allowed under any actor id —
//   that is what lets Claude be Claude on both machines — and every one is
//   stamped with the member who submitted it, so an agent event is always
//   attributable to a person who is in the workspace.
//
//   Creating a workspace needs the server's own signup token. Without it a
//   self-hosted service on a reachable port is a free workspace factory.
//
//   Everything is bounded: body size, batch size, page size, name length.
//
// Nothing is logged that could be a comment. A request line and a status, and
// that is the lot — see `note`.

const http = require('node:http');
const crypto = require('node:crypto');

const { openStore } = require('./store');
const { reviveEvent, isKnownType, MAX_EVENT_BYTES } = require('../electron/review/events');

const DEFAULT_PORT = 43822;
const DEFAULT_HOST = '127.0.0.1';

// The largest request body this will read. Comfortably above a full batch of
// maximum-size events, and a hard stop long before memory is a question.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BATCH = 200;
const MAX_PAGE = 500;
const DEFAULT_PAGE = 200;
// One workspace's history. A backstop against a runaway client rather than a
// product limit; a project that reaches it wants a new workspace.
const MAX_WORKSPACE_EVENTS = 200000;

const ACTOR_ID = /^[A-Za-z0-9._:-]{1,100}$/;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    // Nothing here is for a browser and no page should be able to read it.
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

const refuse = (res, status, code, message) => sendJson(res, status, { error: code, message });

/** Read a JSON body, or refuse it by name. Never buffers past the cap. */
function readJson(req) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      resolve({ ok: false, code: 'too_large', status: 413, message: 'That request is too large.' });
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve({ ok: false, code: 'too_large', status: 413, message: 'That request is too large.' });
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
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return resolve({ ok: false, code: 'bad_json', status: 400, message: 'The body must be a JSON object.' });
        }
        resolve({ ok: true, body: parsed });
      } catch {
        resolve({ ok: false, code: 'bad_json', status: 400, message: 'The body is not valid JSON.' });
      }
    });
    req.on('error', () => resolve({ ok: false, code: 'bad_request', status: 400, message: 'The request ended early.' }));
  });
}

function bearerOf(header) {
  if (typeof header !== 'string') return null;
  const m = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** Equal-length, constant-time compare, for the one secret that is compared directly. */
function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Check one event a client wants to append.
 *
 * `reviveEvent` is the SAME function the app folds with, imported rather than
 * reimplemented: a server with its own idea of what an event is would accept
 * things no client could read, or refuse things every client can.
 */
function checkEvent(raw, member) {
  const event = reviveEvent(raw);
  if (!event) return { ok: false, code: 'invalid_event' };
  if (JSON.stringify(event).length > MAX_EVENT_BYTES) return { ok: false, code: 'too_large' };
  // An unknown type is accepted and stored verbatim. A newer client's event
  // must survive an older server, or upgrading one machine would silently
  // strip history for everybody else.
  if (!isKnownType(event.type) && !/^[a-z][a-z0-9]*\.[a-z0-9.]+$/.test(event.type)) {
    return { ok: false, code: 'invalid_event' };
  }
  // The server says who a person is. This is the line that makes authorship
  // mean something: a member may speak as themselves, or on behalf of an
  // agent, and never as another person.
  if (event.actorKind === 'human' && event.actorId !== member.actor_id) {
    return { ok: false, code: 'actor_mismatch' };
  }
  return { ok: true, event };
}

/**
 * Build the service. Nothing listens until `start()`.
 *
 * `signupToken` is required. A service that will make a workspace for anybody
 * who can reach the port is not a service worth shipping as a reference.
 */
function createReviewService({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  file = ':memory:',
  signupToken,
  now = Date.now,
  onError = null,
  log = null,
} = {}) {
  if (!signupToken || typeof signupToken !== 'string' || signupToken.length < 16) {
    throw new Error('a Shared Reviews service needs a signup token of at least 16 characters');
  }
  const store = openStore({ file, now });

  /** What may be written down about a request. Never a body, never a token. */
  const note = (line) => {
    try {
      log?.(line);
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

  /** The member a request is made by, or null. */
  const authenticate = (req) => store.memberFor(bearerOf(req.headers.authorization));

  async function route(req, res, url) {
    const segments = url.pathname.split('/').filter(Boolean);
    const method = req.method || 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'stacki-shared-reviews', version: 1 });
    }

    // POST /v1/workspaces — start one. The server's signup token, not a member's.
    if (method === 'POST' && url.pathname === '/v1/workspaces') {
      if (!tokenMatches(bearerOf(req.headers.authorization), signupToken)) {
        return refuse(res, 401, 'unauthorized', 'This server needs its signup token to create a workspace.');
      }
      const read = await readJson(req);
      if (!read.ok) return refuse(res, read.status, read.code, read.message);
      const actorId = read.body?.member?.actorId;
      if (typeof actorId !== 'string' || !ACTOR_ID.test(actorId)) {
        return refuse(res, 400, 'bad_actor', 'A member needs an actor id.');
      }
      const made = store.createWorkspace({
        displayName: read.body.displayName,
        repositoryHint: read.body.repositoryHint,
        actorId,
        memberName: read.body?.member?.displayName,
      });
      note(`workspace created ${made.workspace.id}`);
      return sendJson(res, 200, made);
    }

    // POST /v1/join — accept an invitation. Unauthenticated by necessity: the
    // invitation IS the credential, and it is single-use and expiring.
    if (method === 'POST' && url.pathname === '/v1/join') {
      const read = await readJson(req);
      if (!read.ok) return refuse(res, read.status, read.code, read.message);
      const invite = read.body?.invite;
      const actorId = read.body?.member?.actorId;
      if (typeof invite !== 'string' || !invite || invite.length > 512) {
        return refuse(res, 400, 'bad_invite', 'That invitation is not readable.');
      }
      if (typeof actorId !== 'string' || !ACTOR_ID.test(actorId)) {
        return refuse(res, 400, 'bad_actor', 'A member needs an actor id.');
      }
      const joined = store.redeemInvite({ invite, actorId, memberName: read.body?.member?.displayName });
      if (!joined.ok) {
        // One message for every bad invitation, so a wrong token and a used one
        // cannot be told apart by somebody guessing at them.
        return refuse(res, 401, joined.code, 'That invitation cannot be used.');
      }
      note(`member joined ${joined.workspace.id}`);
      return sendJson(res, 200, { workspace: joined.workspace, credential: joined.credential });
    }

    // Everything below is about one workspace and needs a member of it.
    if (segments[0] === 'v1' && segments[1] === 'workspaces' && segments[2]) {
      const workspaceId = decodeURIComponent(segments[2]);
      const member = authenticate(req);
      // 404 rather than 403 for a workspace this credential is not in: a 403
      // would confirm the workspace exists, which turns the endpoint into a way
      // to enumerate them.
      if (!member) return refuse(res, 401, 'unauthorized', 'This server does not recognise that credential.');
      if (member.workspace_id !== workspaceId) return refuse(res, 404, 'not_found', 'No such workspace.');
      const workspace = store.workspaceFor(workspaceId);
      if (!workspace) return refuse(res, 404, 'not_found', 'No such workspace.');

      // GET /v1/workspaces/:id
      if (method === 'GET' && segments.length === 3) {
        return sendJson(res, 200, {
          workspace: {
            id: workspace.id,
            displayName: workspace.display_name,
            repositoryHint: workspace.repository_hint,
            createdAt: workspace.created_at,
          },
          member: { memberId: member.id, actorId: member.actor_id, displayName: member.display_name },
          members: store.membersOf(workspaceId),
          head: store.headOf(workspaceId),
        });
      }

      // GET /v1/workspaces/:id/events?after=&limit=
      if (method === 'GET' && segments[3] === 'events' && segments.length === 4) {
        const after = Number(url.searchParams.get('after'));
        const limit = Number(url.searchParams.get('limit'));
        const page = store.eventsAfter({
          workspaceId,
          after: Number.isInteger(after) && after > 0 ? after : 0,
          limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_PAGE) : DEFAULT_PAGE,
        });
        return sendJson(res, 200, page);
      }

      // POST /v1/workspaces/:id/events
      if (method === 'POST' && segments[3] === 'events' && segments.length === 4) {
        const read = await readJson(req);
        if (!read.ok) return refuse(res, read.status, read.code, read.message);
        const incoming = Array.isArray(read.body.events) ? read.body.events : null;
        if (!incoming) return refuse(res, 400, 'bad_request', 'events must be a list.');
        if (incoming.length > MAX_BATCH) {
          return refuse(res, 413, 'too_many', `At most ${MAX_BATCH} events per request.`);
        }
        if (store.countOf(workspaceId) + incoming.length > MAX_WORKSPACE_EVENTS) {
          return refuse(res, 413, 'workspace_full', 'This workspace has reached its event limit.');
        }
        const good = [];
        const rejected = [];
        for (const raw of incoming) {
          const checked = checkEvent(raw, member);
          if (checked.ok) good.push(checked.event);
          else rejected.push({ id: typeof raw?.id === 'string' ? raw.id.slice(0, 100) : null, code: checked.code });
        }
        let result = { accepted: [], cursor: store.headOf(workspaceId) };
        if (good.length) {
          try {
            result = store.appendEvents({ workspaceId, memberId: member.id, events: good });
          } catch (err) {
            report(err);
            return refuse(res, 500, 'write_failed', 'The server could not store those events.');
          }
        }
        note(`events +${result.accepted.length} -${rejected.length} ${workspaceId}`);
        return sendJson(res, 200, { accepted: result.accepted, rejected, cursor: result.cursor });
      }

      // POST /v1/workspaces/:id/invites
      if (method === 'POST' && segments[3] === 'invites' && segments.length === 4) {
        const read = await readJson(req);
        if (!read.ok) return refuse(res, read.status, read.code, read.message);
        const made = store.createInvite({ workspaceId, memberId: member.id, ttlMs: read.body.ttlMs });
        note(`invite created ${workspaceId}`);
        return sendJson(res, 200, made);
      }
    }

    return refuse(res, 404, 'not_found', 'No such endpoint.');
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      return refuse(res, 400, 'bad_request', 'That request line could not be read.');
    }
    Promise.resolve(route(req, res, url)).catch((err) => {
      report(err);
      if (!res.headersSent) refuse(res, 500, 'internal_error', 'The server could not answer that.');
      else res.end();
    });
  });
  server.on('error', report);

  return {
    port,
    host,
    store,
    get url() {
      return `http://${host}:${port}`;
    },
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
  createReviewService,
  checkEvent,
  bearerOf,
  tokenMatches,
  DEFAULT_PORT,
  DEFAULT_HOST,
  MAX_BODY_BYTES,
  MAX_BATCH,
  MAX_PAGE,
  MAX_WORKSPACE_EVENTS,
};
