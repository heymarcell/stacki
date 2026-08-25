// How much of Stacki an agent is allowed to move.
//
// The endpoint's guards — loopback, Host, Origin, a bearer token — answer "is
// this our agent". They have nothing to say about "should our agent be able to
// delete a branch", and until this feature that question never came up: the
// server was read-only and the worst a caller could do was learn what was on
// screen. It writes now, so the question is real and it is the user's to
// answer.
//
// Three settings, because there are three genuinely different fears:
//
//   inspect   Look, and say things in a review. Nothing in the project
//             changes. This is what an existing installation gets, and it is
//             what the server did before this feature existed — an update
//             must never quietly grant an agent more than the person who
//             installed it agreed to.
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
// The gate is here, in the main process, and it is checked for every operation
// before anything is dispatched. The MCP annotations on the tools say the same
// things, and they are documentation: a client that ignores them is not
// bypassing anything.

const MODES = ['inspect', 'edit', 'full'];

// What an operation costs if it turns out to be a mistake.
//
//   read   nothing changes.
//   write  the working tree changes, and Stacki's own undo or git can put it
//          back.
//   high   it is destructive, or it runs package tooling, or it talks to a
//          remote. "Put it back" is not obviously available.
const RISKS = ['read', 'write', 'high'];

const ALLOWED = {
  inspect: new Set(['read']),
  edit: new Set(['read', 'write']),
  full: new Set(['read', 'write', 'high']),
};

const DEFAULT_MODE = 'inspect';

/** A mode name, or the conservative default for anything unrecognised. */
function normalizeMode(value) {
  return MODES.includes(value) ? value : DEFAULT_MODE;
}

/** Whether `mode` may run an operation of this risk. */
function allows(mode, risk) {
  return ALLOWED[normalizeMode(mode)].has(risk);
}

const NEEDED = { read: 'inspect', write: 'edit', high: 'full' };

const LABEL = {
  inspect: 'Inspect only',
  edit: 'Edit project',
  full: 'Full control',
};

/**
 * The refusal, as something an agent can act on.
 *
 * It names the operation, the mode it would need and where the person changes
 * it — because the only useful thing to do about this is ask them, and an
 * agent that cannot say what to ask for will guess at a workaround instead.
 */
function refusal({ operation, risk, mode }) {
  return {
    ok: false,
    code: 'permission_denied',
    operation,
    risk,
    mode,
    requires: NEEDED[risk] || 'full',
    message:
      `Stacki's agent access is set to "${LABEL[normalizeMode(mode)]}", and ${operation} needs ` +
      `"${LABEL[NEEDED[risk] || 'full']}". The person at the keyboard can change it in Stacki: ` +
      'the AI connection (MCP) window. Nothing was changed.',
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

module.exports = { MODES, RISKS, ALLOWED, DEFAULT_MODE, LABEL, NEEDED, normalizeMode, allows, refusal, createGate };
