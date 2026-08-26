// Which builds are allowed to update themselves.
//
//   node test/update-policy.js
//
// The bug this exists to prevent shipped once: `app.isPackaged` was the whole
// test, so an unsigned local package counted as an official release, checked
// the official feed, found an update and handed it to Squirrel.Mac — which
// refused to stage an unsigned app and surfaced "Stacki could not check for
// updates" with a code-signature failure.
//
// Squirrel was right. So these tests are about one thing: a build may update
// itself only if it says so, only if the release pipeline is what said it, and
// never merely because somebody ran electron-builder.

const fs = require('fs');
const path = require('path');

const { updatePolicy, saysTrue, UPDATE_ENABLED_FIELD } = require('../electron/updatePolicy.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// --- the policy itself -------------------------------------------------------

{
  const dev = updatePolicy({ isPackaged: false, updateEnabledMetadata: true });
  check('development never updates itself', dev.enabled === false, JSON.stringify(dev));
  check('and says why', dev.reason === 'development', dev.reason);
  // Even a metadata true cannot switch it on: a dev run has no installer to
  // update, and an enabled updater there would check a feed on every launch.
  check('not even with the release flag set', updatePolicy({ isPackaged: false, updateEnabledMetadata: 'true' }).enabled === false);

  const missing = updatePolicy({ isPackaged: true });
  check('a packaged build with no metadata does not update', missing.enabled === false, JSON.stringify(missing));
  check('and gives the stable reason', missing.reason === 'not-update-enabled', missing.reason);

  check('metadata false does not update', updatePolicy({ isPackaged: true, updateEnabledMetadata: false }).enabled === false);
  check('metadata null does not update', updatePolicy({ isPackaged: true, updateEnabledMetadata: null }).enabled === false);
  check('metadata undefined does not update', updatePolicy({ isPackaged: true, updateEnabledMetadata: undefined }).enabled === false);

  const on = updatePolicy({ isPackaged: true, updateEnabledMetadata: true });
  check('a packaged build that says true updates', on.enabled === true, JSON.stringify(on));
  check('and is named a release', on.reason === 'release', on.reason);
  // The release workflow passes this through a shell, so it arrives as
  // characters. A policy that disagreed with the command CI actually runs
  // would fail closed on every official build.
  check('the string "true" counts, because that is what -c passes', updatePolicy({ isPackaged: true, updateEnabledMetadata: 'true' }).enabled === true);
}

{
  // Nothing else is a yes. A value that merely looks affirmative must not
  // enable an updater — the field is a statement the build makes, not a hint.
  for (const value of [1, '1', 'yes', 'TRUE', 'True', 'on', {}, [], 'false', 0, '']) {
    check(`${JSON.stringify(value)} is not true`, saysTrue(value) === false, JSON.stringify(value));
    check(`and does not enable updates`, updatePolicy({ isPackaged: true, updateEnabledMetadata: value }).enabled === false);
  }
  check('no argument at all is safe', updatePolicy().enabled === false);
}

{
  // The refusal must not claim to know something it does not. The policy sees
  // a missing flag; it cannot see a signature, and telling somebody their
  // build is unsigned when a release flag was simply missed sends them looking
  // in the wrong place.
  const off = updatePolicy({ isPackaged: true, updateEnabledMetadata: false });
  check('the explanation does not claim the build is unsigned', !/unsign|signature|codesign/i.test(off.detail), off.detail);
  check('it tells the person what to do instead', /manually/i.test(off.detail), off.detail);
  check('a missing flag and an explicit false read the same', off.detail === updatePolicy({ isPackaged: true }).detail);
}

// --- what the repository actually ships --------------------------------------

{
  const pkg = JSON.parse(read('package.json'));

  // The default in the repository is the safe one. A fork that clones this and
  // runs any packaging command gets a build that will not touch the feed.
  check(
    `package.json does not ship ${UPDATE_ENABLED_FIELD}: true`,
    pkg[UPDATE_ENABLED_FIELD] !== true && pkg[UPDATE_ENABLED_FIELD] !== 'true',
    JSON.stringify(pkg[UPDATE_ENABLED_FIELD])
  );
  check(
    'so the shipped default is update-disabled',
    updatePolicy({ isPackaged: true, updateEnabledMetadata: pkg[UPDATE_ENABLED_FIELD] }).enabled === false
  );

  // No ordinary packaging script may enable updates. These are the commands
  // the README tells people to run.
  for (const name of ['dist', 'dist:mac', 'dist:mac:unsigned', 'dist:win']) {
    const script = pkg.scripts[name];
    check(`the ${name} script exists`, typeof script === 'string', name);
    check(
      `and does not enable updates`,
      typeof script === 'string' && !script.includes(UPDATE_ENABLED_FIELD),
      script
    );
  }
}

{
  // The official workflow is the only thing that turns updates on, and it has
  // to do it for BOTH platforms — a Windows release that silently could not
  // update itself is the failure this guards.
  const workflow = read('.github/workflows/release.yml');
  const lines = workflow.split('\n').filter((l) => l.includes('npx electron-builder'));
  check('the release workflow builds two platforms', lines.length === 2, JSON.stringify(lines));

  const mac = lines.find((l) => l.includes('--mac'));
  const win = lines.find((l) => l.includes('--win'));
  check('the macOS release enables updates explicitly', !!mac && mac.includes(`-c.extraMetadata.${UPDATE_ENABLED_FIELD}=true`), mac);
  check('the Windows release enables updates explicitly', !!win && win.includes(`-c.extraMetadata.${UPDATE_ENABLED_FIELD}=true`), win);

  // Signing and notarization are not what this change is about, and a fix that
  // quietly turned either off would make the original error disappear for the
  // wrong reason.
  check('the macOS release still publishes', !!mac && mac.includes('--publish always'), mac);
  check('the Windows release still publishes', !!win && win.includes('--publish always'), win);
  check('macOS signing credentials are still required', /MAC_CSC_LINK is missing/.test(workflow));
  check('and notarization credentials are still passed', /APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|notarize/i.test(workflow));
}

{
  // The runtime gate is mandatory even where the feed metadata is absent, so
  // the three places that could reach the updater must all consult the policy
  // and none of them may decide on app.isPackaged alone.
  const main = read('electron/main.js');
  check('main.js uses the policy helper', main.includes("require('./updatePolicy')"), 'no require');
  for (const fn of ['runAutoUpdateCheck', 'startAutoUpdateChecks', 'checkForUpdatesFromMenu']) {
    const at = main.indexOf(`function ${fn}`);
    check(`${fn} exists`, at > 0, fn);
    const body = main.slice(at, at + 1400);
    check(`${fn} consults the update policy`, body.includes('currentUpdatePolicy()'), fn);
    check(`${fn} does not decide on app.isPackaged alone`, !body.includes('app.isPackaged'), fn);
  }

  // The dialog a person gets when they ask must be informational. A build
  // working as designed is not a warning.
  const menuAt = main.indexOf('function checkForUpdatesFromMenu');
  const menu = main.slice(menuAt, main.indexOf('function startAutoUpdateChecks'));
  const gateEnd = menu.indexOf('if (autoUpdateCheckInFlight)');
  const gate = menu.slice(0, gateEnd > 0 ? gateEnd : menu.length);
  check('the disabled manual check answers with an info dialog', /type: 'info'/.test(gate), gate.slice(0, 200));
  check('and does not warn', !/type: 'warning'/.test(gate));
  // Nothing in the disabled branch may reach electron-updater.
  check('and never calls the updater', !/autoUpdater\./.test(gate), gate.slice(0, 200));

  // The disabled background path must not register handlers or an interval.
  const startAt = main.indexOf('function startAutoUpdateChecks');
  const start = main.slice(startAt, startAt + 900);
  const disabledBranch = start.slice(0, start.indexOf('registerAutoUpdaterEvents'));
  check('a disabled build registers no updater events', !/registerAutoUpdaterEvents/.test(disabledBranch));
  check('and schedules no interval', !/setInterval/.test(disabledBranch), disabledBranch.slice(0, 200));
  check('and says so in the log', /Automatic updates disabled for this build/.test(disabledBranch), disabledBranch.slice(0, 200));
}

{
  // Nothing anywhere may weaken signature verification to make the original
  // error go away. That was the explicitly wrong fix.
  const main = read('electron/main.js');
  const policy = read('electron/updatePolicy.js');
  for (const [what, body] of [['main.js', main], ['updatePolicy.js', policy]]) {
    check(`${what} does not disable signature verification`, !/verifyUpdateCodeSignature|disableWebInstaller|allowDowngrade\s*=\s*true|checkCodeSignature\s*=\s*false/.test(body));
  }
  const pkg = JSON.parse(read('package.json'));
  check('the appId is unchanged', pkg.build.appId === 'com.stacki.editor', pkg.build.appId);
}

if (failures.length) {
  console.error(`\nupdate-policy: ${failures.length} failed, ${checked - failures.length} passed\n`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log(`update-policy: ${checked} passed  [only a release says it can update itself]`);
