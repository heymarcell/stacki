// Whether a modal dialog may be put on somebody's screen.
//
// Every blocking dialog the main process raises belongs to the updater, and a
// modal dialog is fatal to an automated run: the app stops and waits for a
// click that is never coming, so a test hangs until its timeout and a script
// driving the app silently stops making progress. Worse, the dialog belongs to
// whoever is at the keyboard — an unattended run leaves it sitting there.
//
// So a run can declare that nobody is watching. STACKI_NO_DIALOGS=1 turns
// every message box into a log line. Off by default and never inferred: a
// person running Stacki normally must still be told when an update failed, and
// guessing "this looks automated" would eventually guess wrong about somebody's
// real session.
//
// Pure, so the decision and the answer can both be tested without Electron.

/** Is anybody there? */
function dialogsSuppressed(env = process.env) {
  const flag = env?.STACKI_NO_DIALOGS;
  return flag === '1' || flag === 'true';
}

/**
 * What a suppressed dialog answers.
 *
 * Never the affirmative button. The one dialog here with consequences asks
 * whether to restart and install an update; answering it "yes" on a machine
 * with nobody watching would quit the app out from under whatever was driving
 * it. `cancelId` is what the caller already nominated as the harmless choice,
 * so that is what an absent person is taken to have chosen; failing that, the
 * last button, which is conventionally the passive one.
 */
function suppressedResponse(options = {}) {
  if (Number.isInteger(options.cancelId)) return options.cancelId;
  const buttons = Array.isArray(options.buttons) ? options.buttons : [];
  return buttons.length ? buttons.length - 1 : 0;
}

/** One line describing the dialog that was not shown, for the log. */
function suppressedLine(options = {}) {
  const parts = [options.title, options.message].filter(Boolean).join(' — ');
  const detail = options.detail ? ` ${String(options.detail).split('\n')[0]}` : '';
  return `Dialog suppressed (STACKI_NO_DIALOGS): ${parts}${detail}`.trim();
}

module.exports = { dialogsSuppressed, suppressedResponse, suppressedLine };
