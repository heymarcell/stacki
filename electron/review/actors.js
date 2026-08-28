// Who said it.
//
// `authorType: 'human' | 'agent'` was enough while a review file belonged to
// one person on one machine: "You" and "Agent" name everybody there is. The
// moment two people share a thread it stops being enough, because "You" is
// then a different person depending on who is reading, and a message signed
// "human" says nothing about whose message it is — which is also the only
// thing ownership rules can be built on.
//
// So there is an actor, and it is deliberately three fields:
//
//   id           a UUID. This is identity, and it is the ONLY thing identity
//                is. Not an email, not a git author, not a username on a
//                server — those are all things that change, are shared between
//                people, or belong to somebody else's namespace.
//   kind         human or agent. Not a role and not a permission; the two
//                behave differently (an agent cannot rewrite what was said)
//                and a reader has a right to know which one wrote a sentence.
//   displayName  presentation. Changeable, non-unique, and never the thing
//                anything is looked up by.
//
// What is deliberately NOT here: avatars, profiles, emails, organizations,
// roles. A shared review needs to say "Alice wrote this" and "you may edit
// your own message". Everything beyond that is a product nobody asked for.
//
// AGENTS ARE ACTORS TOO, and their ids are derived rather than allocated:
// uuidv5 of the agent's name under a fixed namespace. That is what makes
// "Claude" the same actor on Alice's machine and on Bob's without either
// machine having to fetch a directory of who everybody is — and it means an
// agent's authorship survives arriving as a shared event from somebody else's
// installation. An agent is never given a human's id: `kind` is carried on
// every event and the reference service refuses to let a member push a HUMAN
// event under any id but their own.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_NAME = 60;
// The name a person sees when nothing better is known. Not "Anonymous" — this
// is the local human's own machine, and "You" is what the panel has always
// called them.
const DEFAULT_HUMAN_NAME = 'You';
const DEFAULT_AGENT_NAME = 'AI Agent';

// A fixed namespace, so a derived id is the same everywhere Stacki runs. This
// constant is part of the wire format: changing it renames every agent in
// every shared workspace.
const AGENT_NAMESPACE = '7c1e6f2a-4d1b-5b7a-9f3c-2a6e8d0b41f5';

const KINDS = ['human', 'agent'];

/** A display name, bounded and stripped of anything that would break a line. */
function displayName(value, fallback = DEFAULT_HUMAN_NAME) {
  if (typeof value !== 'string') return fallback;
  // Control characters out first: a name carrying a newline or an escape
  // sequence is a name that can redraw somebody else's terminal, and this
  // string is written into agent-readable output.
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text.length > MAX_NAME ? text.slice(0, MAX_NAME) : text;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isActorId = (v) => typeof v === 'string' && UUID.test(v);

/** RFC 4122 4.3 — a name-based UUID, so the same name is always the same id. */
function uuidv5(name, namespace = AGENT_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto
    .createHash('sha1')
    .update(Buffer.concat([ns, Buffer.from(String(name), 'utf8')]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The actor for an agent of a given name.
 *
 * Derived, never stored: two installations that have never spoken agree on it,
 * which is exactly the property a shared thread needs in order to say "Claude
 * resolved this" on a machine Claude has never run on.
 */
function agentActor(name) {
  const shown = displayName(name, DEFAULT_AGENT_NAME);
  return { id: uuidv5(`agent:${shown.toLowerCase()}`), kind: 'agent', displayName: shown };
}

/**
 * A name to suggest, from what the machine already knows.
 *
 * `git config user.name` first — it is what this person calls themselves in
 * this line of work, and it is already on every commit they make. A HINT and
 * nothing more: it is offered as a default, it is editable, and the identity
 * underneath it is a UUID either way.
 *
 * The project's config is asked first and the global one second, so somebody
 * who signs one repository differently gets that name — and so the answer does
 * not depend on whether a project happened to be open when the identity was
 * first needed. A name that changed depending on which screen you were looking
 * at would be a name nobody could predict.
 *
 * `user.email` is deliberately not used. It is the one field of a git identity
 * that is a contact address, and publishing somebody's email to a workspace
 * because it happened to be in a config file is not a thing to do by default.
 */
function suggestName({ run = null, projectPath = null } = {}) {
  if (typeof run === 'function') {
    const asked = [];
    if (projectPath) asked.push([projectPath, ['config', 'user.name']]);
    asked.push([os.homedir(), ['config', '--global', 'user.name']]);
    for (const [where, args] of asked) {
      const name = displayName(String(run(where, args) || '').trim(), '');
      if (name) return name;
    }
  }
  try {
    const info = os.userInfo();
    const name = displayName(info?.fullName || info?.username || '', '');
    if (name) return name;
  } catch {
    /* a sandbox with no passwd entry; the default below is fine */
  }
  return DEFAULT_HUMAN_NAME;
}

/** An actor from anywhere, checked field by field. Null for anything unusable. */
function reviveActor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isActorId(raw.id)) return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'human';
  return {
    id: String(raw.id).toLowerCase(),
    kind,
    displayName: displayName(raw.displayName, kind === 'agent' ? DEFAULT_AGENT_NAME : DEFAULT_HUMAN_NAME),
  };
}

/**
 * Whether an actor may rewrite a message.
 *
 * One rule, said once, used by the panel, by the projection and by the service:
 * your own words, and only if you are a person. It is enforced in the
 * PROJECTION as well as at the door, which is the part that matters once
 * events arrive over a network — a peer that forges an edit of somebody else's
 * message must have that edit ignored when the thread is rebuilt, not merely
 * be politely refused at the point it was made.
 */
const mayEdit = (actor, message) =>
  !!actor && actor.kind === 'human' && !!message && message.actorId === actor.id && message.actorKind === 'human';

/**
 * Whether an actor may take a message out of a thread.
 *
 * Wider than editing, and the asymmetry is deliberate and pre-existing: taking
 * words out is visible in the thread, putting different ones in somebody's
 * mouth is not. A person may prune their own messages and an agent's replies;
 * nobody may delete another person's words, and an agent may delete nothing.
 */
const mayDelete = (actor, message) => {
  if (!actor || !message) return false;
  if (actor.kind !== 'human') return false;
  if (message.actorKind === 'agent') return true;
  return message.actorId === actor.id;
};

// --- the local human -------------------------------------------------------

const FILE = 'shared-reviews.json';
const fileFor = (userDataPath) => path.join(userDataPath, FILE);

/** Read the identity/workspace file, or an empty one. Never throws. */
function readIdentityFile(userDataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(userDataPath), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Write it back, readable by this user only.
 *
 * The same file holds workspace member credentials, so its mode is not a
 * detail: 0600 before anything is written into it, and again afterwards
 * because writeFileSync leaves an existing file's mode alone.
 */
function writeIdentityFile(userDataPath, data) {
  const file = fileFor(userDataPath);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* a filesystem with no modes; the rename below still happens */
  }
  fs.renameSync(tmp, file);
}

/**
 * This installation's own person, made once and kept.
 *
 * Made on first need rather than at startup. The first need is opening a
 * project's ledger, because every comment written from then on is attributed
 * to somebody — so this is not conditional on sharing, and must not be: an
 * identity minted at the moment somebody first shares would make every comment
 * they had already written somebody else's.
 *
 * It is a uuid and a name in this machine's own application-support directory.
 * Nothing about having one causes a network request; see sync.js for the guard
 * that makes that a fact rather than an intention.
 */
function localActor(userDataPath, { suggest = null, now = Date.now } = {}) {
  const data = readIdentityFile(userDataPath);
  const existing = reviveActor(data.actor);
  if (existing && existing.kind === 'human') return existing;
  const actor = {
    id: crypto.randomUUID(),
    kind: 'human',
    displayName: displayName(typeof suggest === 'function' ? suggest() : suggest, DEFAULT_HUMAN_NAME),
  };
  try {
    writeIdentityFile(userDataPath, { ...data, version: 1, actor, actorCreatedAt: now() });
  } catch (err) {
    // An identity that cannot be stored still works for this run. It would be
    // a new id next launch, which is why sharing checks for this and says so
    // rather than quietly making a second Alice.
    console.warn('[stacki] could not store the review identity:', err.message);
  }
  return actor;
}

/** Rename the local person. The id does not move; that is the whole point of it. */
function setLocalName(userDataPath, name) {
  const data = readIdentityFile(userDataPath);
  const actor = reviveActor(data.actor);
  if (!actor) return null;
  const renamed = { ...actor, displayName: displayName(name, actor.displayName) };
  writeIdentityFile(userDataPath, { ...data, actor: renamed });
  return renamed;
}

module.exports = {
  displayName,
  uuidv5,
  agentActor,
  suggestName,
  reviveActor,
  isActorId,
  mayEdit,
  mayDelete,
  localActor,
  setLocalName,
  readIdentityFile,
  writeIdentityFile,
  fileFor,
  KINDS,
  MAX_NAME,
  DEFAULT_HUMAN_NAME,
  DEFAULT_AGENT_NAME,
  AGENT_NAMESPACE,
};
