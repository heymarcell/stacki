// Stamp the build's git identity into the package, before it is packed.
//
// electron-builder's `beforePack` hook, which runs after `npm run build` has
// produced dist/ and before anything is copied into app.asar. `electron/**/*`
// is in the `files` glob, so a file written here lands inside the bundle; it is
// gitignored, so writing it does not dirty the working tree, and it is written
// AFTER the dirty check, so a clean tree stamps `dirty: false` truthfully.
//
// WHY THE PACKAGER STAMPS RATHER THAN THE APP ASKING. A packaged Stacki runs on
// a machine that need not have git, in a directory that is not a checkout, with
// a user whose own repository is the OPEN PROJECT — asking git anything there
// would answer about the wrong repository entirely. The identity of a package
// is a property of the moment it was built, so it is recorded then.
//
// IT DOES NOT REFUSE TO STAMP A DIRTY TREE. Packaging a work-in-progress is a
// normal thing to do and blocking it would only teach people to bypass this.
// What it does is record the truth, so that a build made from a dirty tree
// cannot later be mistaken for the commit it was nearly made from. The gate
// that refuses lives in test/build-identity.js and in the provenance check the
// dogfood harness runs before it will accept a package as a candidate.

const fs = require('node:fs');
const path = require('node:path');

const { gitIdentity } = require('../electron/buildInfo');

const REPO_ROOT = path.join(__dirname, '..');
const STAMP_FILE = path.join(REPO_ROOT, 'electron', 'build-info.json');

/**
 * Write electron/build-info.json for the tree at `root`.
 *
 * `now` is injected so a test can assert the recorded timestamp rather than
 * having to accept whatever the clock said.
 */
function stamp({ root = REPO_ROOT, file = STAMP_FILE, now = new Date() } = {}) {
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? null;
  } catch {
    /* a package with no readable package.json has no version to record */
  }

  const identity = gitIdentity(root);
  const record = {
    packageVersion: version,
    gitHead: identity ? identity.gitHead : null,
    gitTree: identity ? identity.gitTree : null,
    // `gitIdentity` answers null when it could not read status. A stamp is
    // written once, by a process that is standing in the repository, so null
    // there is a real failure to establish and is recorded as such rather than
    // being flattened to `false`.
    dirty: identity ? identity.dirty : null,
    builtAt: now.toISOString(),
  };

  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

/** electron-builder's beforePack signature. */
exports.default = async function beforePack() {
  const record = stamp();
  const head = record.gitHead ? record.gitHead.slice(0, 12) : 'unknown';
  const dirty = record.dirty === true ? ' (DIRTY TREE)' : record.dirty === null ? ' (cleanliness unknown)' : '';
  console.log(`  • beforePack: stamped build identity ${record.packageVersion} ${head}${dirty}`);
};

exports.stamp = stamp;
exports.STAMP_FILE = STAMP_FILE;

// `node scripts/buildInfo.js` stamps by hand, which is what a build that is not
// going through electron-builder needs — `npm start`, or a harness that wants a
// packaged-shaped identity without a package.
if (require.main === module) {
  const record = stamp();
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}
