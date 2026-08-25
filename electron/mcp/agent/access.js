// Which project an agent was granted what on.
//
// The endpoint is the machine's: one port, one token, and an agent configured
// once keeps working when Stacki opens something else. That is right for a
// connection and wrong for an authorisation. "This agent may commit and push"
// is a sentence about a repository, and letting it follow the app into the next
// one is how somebody ends up having granted remote git on a client's project
// because they turned it on for a scratch folder last week.
//
// So the grant is keyed by project, and a project nobody has been asked about
// gets the level that grants nothing.
//
// And one level is not remembered at all. `full` is destructive and remote; it
// lasts the session and the project it was made for, and what gets written down
// is the level below it. Somebody who meant "for the next ten minutes" should
// not discover next month that they meant "forever".
//
// The fingerprint, not the path: what is stored is a hash of the project root,
// so the settings file does not become a list of everywhere somebody works.

const permissions = require('./permissions');
const { projectFingerprint } = require('./refs');

/**
 * Build the store.
 *
 * `read()` and `write(next)` are the app's settings — passed in so this can be
 * exercised without a settings file, and so there is one place that knows what
 * the settings object looks like.
 */
function createAccessStore({ read = () => ({}), write = () => {} } = {}) {
  // Grants made this run, by project fingerprint. Never written down: this is
  // what makes `full` session-only, and it empties when Stacki quits.
  const session = new Map();

  const stored = () => {
    const saved = read()?.agentAccess;
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  };

  const keyFor = (root) => (root ? projectFingerprint(root) : null);

  /**
   * The level in force for a project.
   *
   * With no project open there is nothing to be permissive about, so it is the
   * bottom rung — and the same one an unknown project gets. `full` comes from
   * this session or not at all.
   */
  function modeFor(root) {
    const key = keyFor(root);
    if (!key) return permissions.DEFAULT_MODE;
    const live = session.get(key);
    if (live) return permissions.normalizeMode(live);
    return permissions.normalizeMode(stored()[key] ?? permissions.DEFAULT_MODE);
  }

  /**
   * Grant a level to a project.
   *
   * Answers what it settled on, which is not always what was asked for: an
   * unrecognised level becomes the default, and `full` is granted for the
   * session while `edit` is what the next launch will find.
   */
  function setModeFor(root, next) {
    const key = keyFor(root);
    const level = permissions.normalizeMode(next);
    if (!key) return { ok: false, code: 'no_project', agentMode: permissions.DEFAULT_MODE };

    if (level === permissions.SESSION_ONLY) {
      session.set(key, level);
      persist(key, permissions.PERSISTED_AS[level] || permissions.DEFAULT_MODE);
      return { ok: true, agentMode: level, sessionOnly: true, persistedAs: permissions.PERSISTED_AS[level] };
    }
    // Anything else replaces a session grant rather than sitting under it —
    // turning the level DOWN has to take effect now, not at the next launch.
    session.delete(key);
    persist(key, level);
    return { ok: true, agentMode: level, sessionOnly: false, persistedAs: level };
  }

  function persist(key, level) {
    const settings = read() || {};
    const nextAccess = { ...stored(), [key]: level };
    // The bottom rung is the default, so storing it says nothing. Keeping the
    // file small also keeps it honest: what is in it is what somebody chose.
    if (level === permissions.DEFAULT_MODE) delete nextAccess[key];
    write({ ...settings, agentAccess: nextAccess });
  }

  /**
   * The project changed. Nothing to do — the grant was never global — but
   * saying so out loud is the point: this is where an implementation that
   * carried a level across projects would have had to try.
   */
  function projectChanged() {
    /* grants are keyed by project; there is nothing to move or clear */
  }

  /** Everything the window needs to draw the control. */
  function describe(root) {
    const mode = modeFor(root);
    const key = keyFor(root);
    return {
      agentMode: mode,
      label: permissions.LABEL[mode],
      // Whether the level in force will survive a restart.
      sessionOnly: !!(key && session.has(key)),
      persisted: key ? permissions.normalizeMode(stored()[key] ?? permissions.DEFAULT_MODE) : permissions.DEFAULT_MODE,
      hasProject: !!key,
    };
  }

  return { modeFor, setModeFor, projectChanged, describe, get sessionSize() { return session.size; } };
}

module.exports = { createAccessStore };
