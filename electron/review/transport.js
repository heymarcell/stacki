// How events get to the other person.
//
// The one architectural decision this file exists to protect: Stacki does not
// know what a Shared Reviews server is. It knows an INTERFACE with five
// methods, and one implementation of it that speaks JSON over HTTP to a small
// service anybody can run. Nothing above this file mentions a URL, a token or
// a status code — so a different transport (somebody's own backend, a hosted
// one, a socket when there is a reason for one) is a new file here and nothing
// else changes.
//
//     SharedReviewTransport
//       describe()                    what this is, with no secrets in it
//       workspace()                   who is in it, and how far it has got
//       pullEvents({ after, limit })   everything since a cursor
//       pushEvents(events)            append; answers what it accepted
//       createInvite({ ttlMs })       a single-use way in for one more person
//       close()
//
// Two module-level functions sit beside it because they happen BEFORE there is
// a credential to build a transport from: `createWorkspace` (a person starting
// one) and `joinWorkspace` (a person accepting an invitation). Both are
// deliberately human actions — there is no MCP tool that reaches them, and no
// code path that reaches them without somebody clicking something.
//
// EVERY ANSWER IS A STATUS, NEVER A THROW. The caller is a sync loop that has
// to keep working when the network does not, so "the server is not there" is
// an ordinary result with a name, and the name is what the panel shows.

const { MAX_EVENT_BYTES } = require('./events');

// A pull that has not answered in this long is not going to help a person who
// pressed Sync. Long enough for a cold serverless start, short enough that the
// UI does not appear wedged.
const TIMEOUT_MS = 15000;
// The most events one request carries, in either direction. A cursor makes
// more of them somebody else's problem rather than this request's.
const MAX_BATCH = 200;
const MAX_PULL = 500;
// The largest answer this will read. A body bigger than this is a server that
// is not behaving; reading it into memory because it said to is not required.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const fail = (code, message) => ({ ok: false, code, message });

/** An https or http URL with no query, no fragment and no credentials in it. */
function normalizeBase(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // A URL carrying a username and password is a credential in a field that
  // gets logged and shown; the token is the credential and it goes in a header.
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * One HTTP call, with every failure given a name.
 *
 * The names matter more than they look: the panel says something different for
 * "your credential was refused" (which needs a person) than for "nothing
 * answered" (which needs patience), and a sync loop backs off differently for
 * each.
 */
async function request(base, path, { method = 'GET', token = null, body = null, timeoutMs = TIMEOUT_MS, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return fail('unsupported', 'This build of Stacki cannot make network requests.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    const text = body == null ? null : JSON.stringify(body);
    if (text && text.length > MAX_RESPONSE_BYTES) return fail('too_large', 'That is too much to send in one request.');
    response = await doFetch(`${base}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(text ? { 'content-type': 'application/json' } : {}),
      },
      ...(text ? { body: text } : {}),
    });
  } catch (err) {
    if (err?.name === 'AbortError') return fail('timeout', 'The Shared Reviews server did not answer in time.');
    return fail('offline', 'Stacki could not reach the Shared Reviews server.');
  } finally {
    clearTimeout(timer);
  }

  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    return fail('too_large', 'The Shared Reviews server sent more than Stacki will read.');
  }
  let text;
  try {
    text = await response.text();
  } catch {
    return fail('bad_response', 'The Shared Reviews server sent something unreadable.');
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    return fail('too_large', 'The Shared Reviews server sent more than Stacki will read.');
  }
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // A 500 that answers in HTML is common and is still a server error, so
      // the status is what gets reported rather than the parse failure.
      if (response.ok) return fail('bad_response', 'The Shared Reviews server did not answer in JSON.');
    }
  }
  if (response.status === 401 || response.status === 403) {
    return fail('unauthorized', parsed?.message || 'The Shared Reviews server refused this credential.');
  }
  if (response.status === 404) {
    return fail('not_found', parsed?.message || 'That workspace is not on this Shared Reviews server.');
  }
  if (response.status === 413) return fail('too_large', parsed?.message || 'That was too much to send at once.');
  if (response.status === 429) return fail('busy', parsed?.message || 'The Shared Reviews server is asking for a pause.');
  if (!response.ok) {
    return fail(
      response.status >= 500 ? 'server' : 'refused',
      parsed?.message || `The Shared Reviews server answered ${response.status}.`
    );
  }
  if (!parsed || typeof parsed !== 'object') return fail('bad_response', 'The Shared Reviews server sent no answer.');
  return { ok: true, body: parsed };
}

/**
 * The HTTP transport.
 *
 * `config` is `{ kind: 'http', baseUrl, token }` and comes out of userData —
 * never out of a project, never out of git. `fetchImpl` is injected so the
 * whole of this is testable against a server started in the same process.
 */
function createHttpTransport({ baseUrl, token, workspaceId, fetchImpl = null, timeoutMs = TIMEOUT_MS } = {}) {
  const base = normalizeBase(baseUrl);
  if (!base) throw new Error('a Shared Reviews server needs an http(s) address');
  if (!token || typeof token !== 'string') throw new Error('a Shared Reviews workspace needs a credential');
  if (!workspaceId || typeof workspaceId !== 'string') throw new Error('a Shared Reviews workspace needs an id');
  let closed = false;

  const call = (path, options = {}) =>
    closed
      ? Promise.resolve(fail('closed', 'This workspace connection is closed.'))
      : request(base, path, { token, fetchImpl, timeoutMs, ...options });

  const root = `/v1/workspaces/${encodeURIComponent(workspaceId)}`;

  return {
    kind: 'http',
    workspaceId,
    /** Enough to show a person where this points. Deliberately without the token. */
    describe: () => ({ kind: 'http', server: base, workspaceId }),

    async workspace() {
      const answer = await call(root);
      if (!answer.ok) return answer;
      return { ok: true, workspace: answer.body.workspace || null, members: answer.body.members || [], head: answer.body.head ?? null };
    },

    /**
     * Everything the workspace has after `after`.
     *
     * The cursor is the SERVER's arrival order, not the events' own order —
     * delivery and truth are different things here, and the fold sorts by the
     * event order rule regardless of what came down the wire when.
     */
    async pullEvents({ after = null, limit = MAX_PULL } = {}) {
      const params = new URLSearchParams();
      if (Number.isInteger(after) && after >= 0) params.set('after', String(after));
      params.set('limit', String(Math.max(1, Math.min(Number(limit) || MAX_PULL, MAX_PULL))));
      const answer = await call(`${root}/events?${params.toString()}`);
      if (!answer.ok) return answer;
      const events = Array.isArray(answer.body.events) ? answer.body.events : [];
      return {
        ok: true,
        events,
        cursor: Number.isInteger(answer.body.cursor) ? answer.body.cursor : after ?? null,
        hasMore: answer.body.hasMore === true,
      };
    },

    /** Append. Answers with what was taken and what was refused, by name. */
    async pushEvents(events) {
      const batch = (Array.isArray(events) ? events : []).slice(0, MAX_BATCH);
      if (!batch.length) return { ok: true, accepted: [], rejected: [], cursor: null };
      for (const event of batch) {
        if (JSON.stringify(event).length > MAX_EVENT_BYTES) {
          return fail('too_large', 'One of these comments is too large to share.');
        }
      }
      const answer = await call(`${root}/events`, { method: 'POST', body: { events: batch } });
      if (!answer.ok) return answer;
      return {
        ok: true,
        accepted: Array.isArray(answer.body.accepted) ? answer.body.accepted : [],
        rejected: Array.isArray(answer.body.rejected) ? answer.body.rejected : [],
        cursor: Number.isInteger(answer.body.cursor) ? answer.body.cursor : null,
      };
    },

    /** A single-use way in for one more person. A human action, always. */
    async createInvite({ ttlMs = null } = {}) {
      const answer = await call(`${root}/invites`, { method: 'POST', body: ttlMs ? { ttlMs } : {} });
      if (!answer.ok) return answer;
      return { ok: true, invite: answer.body.invite || null, expiresAt: answer.body.expiresAt ?? null, server: base };
    },

    close() {
      closed = true;
    },
  };
}

/**
 * Start a workspace on a server.
 *
 * The signup token is the server's own — it is what stops a self-hosted
 * service from being a free workspace factory for anybody who finds the port.
 * It is not a user account and it is not stored beyond this call.
 */
async function createWorkspace({ baseUrl, signupToken, displayName, repositoryHint = null, actor, fetchImpl = null } = {}) {
  const base = normalizeBase(baseUrl);
  if (!base) return fail('bad_server', 'That is not an http or https address.');
  if (!actor?.id) return fail('no_actor', 'Stacki has no identity to create a workspace with.');
  const answer = await request(base, '/v1/workspaces', {
    method: 'POST',
    token: signupToken,
    fetchImpl,
    body: {
      displayName: displayName || null,
      repositoryHint: repositoryHint || null,
      member: { actorId: actor.id, displayName: actor.displayName || null },
    },
  });
  if (!answer.ok) return answer;
  return { ok: true, server: base, workspace: answer.body.workspace || null, credential: answer.body.credential || null };
}

/**
 * Accept an invitation.
 *
 * The invitation carries the server it is for, so a person pastes one string
 * rather than two — and, more to the point, so joining is never something
 * Stacki can work out on its own from a git remote. A public clone must not be
 * a key to somebody's private comments.
 */
async function joinWorkspace({ baseUrl, invite, actor, fetchImpl = null } = {}) {
  const base = normalizeBase(baseUrl);
  if (!base) return fail('bad_server', 'That is not an http or https address.');
  if (!invite || typeof invite !== 'string') return fail('bad_invite', 'That invitation is not readable.');
  if (!actor?.id) return fail('no_actor', 'Stacki has no identity to join a workspace with.');
  const answer = await request(base, '/v1/join', {
    method: 'POST',
    fetchImpl,
    body: { invite: invite.trim(), member: { actorId: actor.id, displayName: actor.displayName || null } },
  });
  if (!answer.ok) return answer;
  return { ok: true, server: base, workspace: answer.body.workspace || null, credential: answer.body.credential || null };
}

/**
 * An invitation, and the server it belongs to, as one thing to paste.
 *
 * Opaque on purpose. It is base64 of two fields rather than a URL, so nothing
 * about it invites being opened in a browser, pasted into a chat as a link
 * preview, or fetched by a crawler.
 */
function packInvite({ server, invite }) {
  if (!server || !invite) return null;
  return `stacki1.${Buffer.from(JSON.stringify({ s: server, i: invite }), 'utf8').toString('base64url')}`;
}

function unpackInvite(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('stacki1.') || trimmed.length > 4096) return null;
  try {
    const parsed = JSON.parse(Buffer.from(trimmed.slice('stacki1.'.length), 'base64url').toString('utf8'));
    const server = normalizeBase(parsed?.s);
    const invite = typeof parsed?.i === 'string' && parsed.i.length <= 512 ? parsed.i : null;
    return server && invite ? { server, invite } : null;
  } catch {
    return null;
  }
}

/** The one factory anything above this file uses. */
function createTransport(config = {}) {
  if (config.kind && config.kind !== 'http') throw new Error(`unknown Shared Reviews transport: ${config.kind}`);
  return createHttpTransport(config);
}

module.exports = {
  createTransport,
  createHttpTransport,
  createWorkspace,
  joinWorkspace,
  packInvite,
  unpackInvite,
  normalizeBase,
  TIMEOUT_MS,
  MAX_BATCH,
  MAX_PULL,
};
