// Which projects are shared, with whom, and how to prove it.
//
// One file in the app's own userData — the same one the local actor lives in —
// holding three things:
//
//   the workspaces this installation belongs to, each with the server it is on
//   and the member credential that gets in;
//   the mapping from a project on this disk to one of them;
//   nothing else.
//
// THREE RULES, and all three are about the same failure:
//
//   NOTHING IS WRITTEN INTO THE PROJECT. Not the workspace id, not the
//   credential, not a `.stacki` folder. A repository that grows a file because
//   somebody enabled sharing is a repository that will have that file
//   committed, pushed, and read by everybody who clones it — including the
//   credential.
//
//   A GIT REMOTE IS A HINT, NEVER A KEY. Two clones of the same repository may
//   well be the same team's, and Stacki will say "this repository may already
//   have a workspace" on the strength of it. It will never join one. A public
//   clone must not be a way into private comments, and "the remote matches" is
//   a thing anybody who can read the repository can arrange.
//
//   JOINING IS ALWAYS A HUMAN ACT. There is no discovery, no directory, no
//   auto-enrol. An invitation is created by a person and accepted by a person.
//
// The mapping is keyed by the same `scopeKey` the ledger uses — the project's
// real path, hashed — so a project reached through a symlink and the same
// project reached directly are one project here too.

const fs = require('node:fs');

const { readIdentityFile, writeIdentityFile, fileFor, displayName } = require('./actors');
const { normalizeBase } = require('./transport');

const MAX_WORKSPACES = 100;
const MAX_PROJECTS = 500;

const str = (v, max) => {
  if (typeof v !== 'string') return null;
  const text = v.trim();
  if (!text) return null;
  return text.length > max ? null : text;
};

/** A stored workspace, checked field by field. Null for anything unusable. */
function reviveWorkspace(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id, 100);
  const server = normalizeBase(raw.server);
  const token = str(raw.token, 512);
  if (!id || !server || !token) return null;
  return {
    id,
    server,
    token,
    displayName: displayName(raw.displayName, 'Shared reviews'),
    memberId: str(raw.memberId, 100),
    actorId: str(raw.actorId, 100),
    repositoryHint: str(raw.repositoryHint, 200),
    joinedAt: Number.isInteger(raw.joinedAt) ? raw.joinedAt : 0,
  };
}

/**
 * The workspace registry.
 *
 * A thin object over one file rather than a module with hidden state, so a
 * test can point it at a temporary directory and the app can point it at
 * userData without either of them being special.
 */
function createWorkspaces({ userDataPath, now = Date.now } = {}) {
  if (!userDataPath) throw new Error('the workspace registry needs a userData directory');

  const read = () => readIdentityFile(userDataPath);

  const write = (data) => {
    writeIdentityFile(userDataPath, data);
    return true;
  };

  /** Every workspace this installation belongs to. Credentials included — callers must not publish them. */
  function all() {
    const data = read();
    const list = data.workspaces && typeof data.workspaces === 'object' ? Object.values(data.workspaces) : [];
    return list.map(reviveWorkspace).filter(Boolean).slice(0, MAX_WORKSPACES);
  }

  const get = (workspaceId) => all().find((w) => w.id === workspaceId) || null;

  /** The same, with the credential taken out. This is what may cross an IPC boundary. */
  const publicOf = (w) =>
    w
      ? {
          id: w.id,
          server: w.server,
          displayName: w.displayName,
          actorId: w.actorId,
          repositoryHint: w.repositoryHint,
          joinedAt: w.joinedAt,
        }
      : null;

  /** Remember a workspace this installation has just created or joined. */
  function remember({ id, server, token, displayName: shown, memberId, actorId, repositoryHint }) {
    const data = read();
    const workspaces = data.workspaces && typeof data.workspaces === 'object' ? { ...data.workspaces } : {};
    const entry = reviveWorkspace({
      id,
      server,
      token,
      displayName: shown,
      memberId,
      actorId,
      repositoryHint,
      joinedAt: now(),
    });
    if (!entry) return null;
    if (Object.keys(workspaces).length >= MAX_WORKSPACES && !workspaces[entry.id]) return null;
    workspaces[entry.id] = entry;
    write({ ...data, version: 1, workspaces });
    return entry;
  }

  /**
   * Forget a workspace and every project pointed at it.
   *
   * Local review history is untouched — that lives in the ledger, and turning
   * sharing off must never be a way to lose comments. This only drops the
   * credential and the mapping.
   */
  function forget(workspaceId) {
    const data = read();
    const workspaces = { ...(data.workspaces || {}) };
    if (!workspaces[workspaceId]) return false;
    delete workspaces[workspaceId];
    const projects = { ...(data.projects || {}) };
    for (const [key, value] of Object.entries(projects)) {
      if (value?.workspaceId === workspaceId) delete projects[key];
    }
    write({ ...data, workspaces, projects });
    return true;
  }

  /** Which workspace a project belongs to, by its ledger scope key. Null for a local project. */
  function forProject(key) {
    if (!key) return null;
    const data = read();
    const entry = data.projects?.[key];
    const workspaceId = str(entry?.workspaceId, 100);
    if (!workspaceId) return null;
    return get(workspaceId);
  }

  /** Point a project at a workspace. */
  function link(key, workspaceId) {
    if (!key || !get(workspaceId)) return false;
    const data = read();
    const projects = data.projects && typeof data.projects === 'object' ? { ...data.projects } : {};
    if (Object.keys(projects).length >= MAX_PROJECTS && !projects[key]) return false;
    projects[key] = { workspaceId, linkedAt: now() };
    write({ ...data, version: 1, projects });
    return true;
  }

  /** Stop sharing this project. The workspace and its credential stay. */
  function unlink(key) {
    const data = read();
    if (!data.projects?.[key]) return false;
    const projects = { ...data.projects };
    delete projects[key];
    write({ ...data, projects });
    return true;
  }

  /**
   * A workspace this repository might already belong to.
   *
   * A SUGGESTION for a person to look at, and the only thing a git remote is
   * ever used for here. It does not link anything, it does not fetch anything,
   * and a project with no mapping makes no network request whatever this says.
   */
  function suggestFor(repositoryHint) {
    if (!repositoryHint) return null;
    return publicOf(all().find((w) => w.repositoryHint && w.repositoryHint === repositoryHint) || null);
  }

  return {
    file: fileFor(userDataPath),
    all,
    get,
    publicOf,
    remember,
    forget,
    forProject,
    link,
    unlink,
    suggestFor,
    /** Whether the credential file is only readable by this user. */
    secure() {
      try {
        return (fs.statSync(fileFor(userDataPath)).mode & 0o077) === 0;
      } catch {
        return true; // nothing written yet
      }
    },
  };
}

module.exports = { createWorkspaces, reviveWorkspace, MAX_WORKSPACES, MAX_PROJECTS };
