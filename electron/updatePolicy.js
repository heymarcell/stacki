// Whether this build is allowed to update itself.
//
// It used to be one question — `app.isPackaged` — and that is not the same
// question. Running electron-builder produces a packaged app; it does not
// produce an *official release*. The two came apart the moment the repository
// documented `npm run dist:mac:unsigned`, because that build is packaged, is
// unsigned by design, and still carried `build.publish` pointing at the
// official feed. So it checked for updates, found one, and handed it to
// Squirrel.Mac — which stages an update by verifying its code signature, found
// none it would accept, and surfaced:
//
//   Stacki could not check for updates.
//   Code signature at URL … did not pass validation
//
// Squirrel was right. The build genuinely was not an update-capable release.
// The fix is not to relax that check; it is to stop claiming to be something
// this build is not.
//
// So update capability is now something a build must *say about itself*, at
// build time, and only the official release pipeline says it. The value is
// read from the packaged package.json, which electron-builder writes and which
// nothing at runtime can talk its way into: absent means no, false means no,
// and only an explicit true means yes.
//
// Pure on purpose — no electron, no filesystem, no `codesign` — so the policy
// can be tested directly rather than inferred from an app that did or did not
// show a dialog.

/**
 * The one place `true` is decided.
 *
 * A string is accepted alongside the boolean because `-c.extraMetadata.x=true`
 * arrives from a shell as characters, and a policy that silently disagreed
 * with the command the release workflow actually runs would fail closed on
 * every official build — the one direction of failure nobody would notice
 * until a release shipped that could not update itself.
 *
 * Nothing else counts. Not 1, not "yes", not "TRUE" — a build either says the
 * word or it does not.
 */
const saysTrue = (value) => value === true || value === 'true';

/**
 * Decide whether the updater may run at all.
 *
 * @param {object} input
 * @param {boolean} input.isPackaged        Electron's app.isPackaged.
 * @param {unknown} input.updateEnabledMetadata
 *   The `stackiAutoUpdate` field from the packaged package.json, however it
 *   arrived. Anything that is not an explicit true is a no.
 * @returns {{enabled: boolean, reason: string, detail: string}}
 *   `reason` is a stable key for logs and tests; `detail` is the sentence a
 *   person reads when they ask.
 */
function updatePolicy({ isPackaged, updateEnabledMetadata } = {}) {
  if (!isPackaged) {
    return {
      enabled: false,
      reason: 'development',
      detail: 'This is a development build, which updates when you rebuild it.',
    };
  }
  if (saysTrue(updateEnabledMetadata)) {
    return {
      enabled: true,
      reason: 'release',
      detail: 'This build was produced by an update-enabled release pipeline.',
    };
  }
  // Both the missing case and the explicit-false case land here, and
  // deliberately give the same answer: a build that does not say it can update
  // itself cannot, and there is nothing for a person to act on differently
  // between "the field was false" and "the field was never written".
  //
  // The wording does not say "unsigned". This policy does not know that — it
  // knows what the build claimed — and telling somebody their build is
  // unsigned when the real reason is that a release flag was missed would send
  // them looking in the wrong place.
  return {
    enabled: false,
    reason: 'not-update-enabled',
    detail:
      'Install a newer build manually. Automatic updates are enabled only in release builds produced by an update-enabled release pipeline.',
  };
}

/** The package.json field the release build sets. Named once, used everywhere. */
const UPDATE_ENABLED_FIELD = 'stackiAutoUpdate';

module.exports = { updatePolicy, saysTrue, UPDATE_ENABLED_FIELD };
