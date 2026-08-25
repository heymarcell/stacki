// How much of Stacki an agent is allowed to move.
//
// The endpoint's guards — loopback, Host, Origin, a bearer token — answer "is
// this our agent". They have nothing to say about "should our agent be able to
// read this project's source", and until the Agent API that question never came
// up: the server answered what was on screen and what it looked like, and the
// worst a caller could do was learn that.
//
// It reads and writes the project now, so there are four settings, because
// there are four genuinely different fears:
//
//   visual    Exactly what the server did before the Agent API existed: the
//             selection, a picture of it, the review threads, and moving the
//             view. No project source, no data, no history, no writes.
//
//   inspect   Everything about the project, READ. The source of the file a
//             target is in, the CMS and content collections, the asset text,
//             the git history. Nothing changes, and the agent can now see the
//             repository through this endpoint.
//
//   edit      The ordinary editor. Text, props, classes, structure, styles,
//             variables, pages, components, content, assets, undo, redo.
//             Everything a person does with the panels, which is a great deal,
//             and none of it leaves the working tree.
//
//   full      The operations that are hard to take back or that reach the
//             network: restoring over uncommitted work, deleting a branch,
//             merging, pushing, publishing, installing dependencies.
//
// WHY `visual` AND NOT `inspect` IS THE DEFAULT.
//
// This started as three levels with `inspect` at the bottom, and that was a
// mistake worth writing down. An installation that has had this server running
// for months has a bearer token that could see the canvas. Shipping a version
// where the same token can read every file in the project — because "inspect"
// sounds harmless and reading is not writing — hands out an authority nobody
// was asked for, on an update. Reading a repository IS a permission.
//
// So the bottom rung is what the token could already do, and it is the default
// for every project that has not been asked about.
//
// The gate is here, in the main process, and it is checked for every operation
// before anything is dispatched. The MCP annotations on the tools say related
// things, and they are documentation: a client that ignores them is not
// bypassing anything.

const MODES = ['visual', 'inspect', 'edit', 'full'];

// What an operation costs if it turns out to be a mistake.
//
//   read   nothing changes — but the project's contents leave the machine's
//          editor and reach whatever is holding the token.
//   write  the working tree changes, and Stacki's own undo or git can put it
//          back.
//   high   it is destructive, or it runs package tooling, or it talks to a
//          remote. "Put it back" is not obviously available.
const RISKS = ['read', 'write', 'high'];

// `visual` is deliberately the empty set. Every operation in the Agent API's
// registry is about the project; the four original tools are not in it and are
// not gated by it, which is exactly the line this level draws.
const ALLOWED = {
  visual: new Set(),
  inspect: new Set(['read']),
  edit: new Set(['read', 'write']),
  full: new Set(['read', 'write', 'high']),
};

const DEFAULT_MODE = 'visual';

// The one level that is not remembered.
//
// Somebody who turned on remote and destructive git for an afternoon on a
// disposable project should not find it still on next month, on a different
// project, having forgotten they ever said yes. So a grant of this level lasts
// the session and the project it was made for; what gets written down is the
// level below it.
const SESSION_ONLY = 'full';

/** The level `full` falls back to when a session ends. */
const PERSISTED_AS = { full: 'edit' };

/** A mode name, or the conservative default for anything unrecognised. */
function normalizeMode(value) {
  return MODES.includes(value) ? value : DEFAULT_MODE;
}

/** Whether `mode` may run an operation of this risk. */
function allows(mode, risk) {
  return ALLOWED[normalizeMode(mode)].has(risk);
}

/** Whether `a` grants at least as much as `b`. */
const atLeast = (a, b) => MODES.indexOf(normalizeMode(a)) >= MODES.indexOf(normalizeMode(b));

const NEEDED = { read: 'inspect', write: 'edit', high: 'full' };

const LABEL = {
  visual: 'Visual only',
  inspect: 'Inspect project',
  edit: 'Edit project',
  full: 'Full control',
};

// What each level actually authorises, in the terms somebody deciding would
// use. The window shows these; the coverage document and get_capabilities
// quote them, so there is one description of each level rather than three.
const BLURB = {
  visual:
    'See what you have selected and take a picture of it, and read and reply to your comments. ' +
    'It cannot read your project’s files.',
  inspect:
    'Also READ the project: the source of any file, your content and data, asset text, and the git ' +
    'history. Nothing changes, and everything in the repository becomes visible to the agent.',
  edit:
    'Also change things: text, styles, structure, pages, content and assets — through Stacki, on the ' +
    'undo stack you can press ⌘Z on.',
  full:
    'Also the operations that are hard to take back or that reach the network: deletes, dependency ' +
    'installs, and git — commit, switch, restore, merge, push. Lasts this session and this project.',
};

/**
 * The refusal, as something an agent can act on.
 *
 * It names the operation, the level it would need and where the person changes
 * it — because the only useful thing to do about this is ask them, and an
 * agent that cannot say what to ask for will guess at a workaround instead.
 */
function refusal({ operation, risk, mode }) {
  const needs = NEEDED[risk] || 'full';
  return {
    ok: false,
    code: 'permission_denied',
    operation,
    risk,
    mode,
    requires: needs,
    message:
      `Stacki's agent access is set to "${LABEL[normalizeMode(mode)]}", and ${operation} needs ` +
      `"${LABEL[needs]}". The person at the keyboard can change it in Stacki: the AI connection (MCP) ` +
      'window. Nothing was changed.',
  };
}

/**
 * A gate over one setting.
 *
 * `read()` answers the current mode every time rather than capturing it, so a
 * person who tightens the setting mid-session is obeyed by the next call
 * rather than by the next launch.
 */
function createGate(read) {
  const mode = () => normalizeMode(typeof read === 'function' ? read() : read);
  return {
    get mode() {
      return mode();
    },
    allows: (risk) => allows(mode(), risk),
    /** Null when it may run; the refusal to return when it may not. */
    check(operation, risk) {
      if (allows(mode(), risk)) return null;
      return refusal({ operation, risk, mode: mode() });
    },
  };
}

module.exports = {
  MODES,
  RISKS,
  ALLOWED,
  DEFAULT_MODE,
  SESSION_ONLY,
  PERSISTED_AS,
  LABEL,
  BLURB,
  NEEDED,
  normalizeMode,
  allows,
  atLeast,
  refusal,
  createGate,
};
