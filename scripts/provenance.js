// Does this package come from this source tree, and can it prove it?
//
// THE GATE THE LIVE DOGFOOD DID NOT HAVE. A report of sixteen defects was
// written against a bundle everybody believed was the candidate. It was
// ninety-three commits behind it. Nothing in the process could have caught that,
// because the only identity anyone compared was the version string — and the
// version string was the same.
//
// So before a package is allowed to qualify anything, six values have to agree:
//
//   source HEAD          git rev-parse HEAD in the checkout
//   source tree          git rev-parse HEAD^{tree}
//   package HEAD         electron/build-info.json inside app.asar
//   package tree         same file
//   live MCP HEAD        what the running app reports through get_context
//   live MCP tree        or stacki://build
//
// This module establishes the first four and hashes the artefact. The last two
// are the running app's business, so `compare()` takes them as an argument —
// the dogfood harness reads them off the wire and hands them in.
//
// A DIRTY PACKAGE IS NOT A CANDIDATE. `scripts/buildInfo.js` will happily stamp
// a build made from a tree with uncommitted changes, because refusing would
// only teach people to bypass it. This is where that gets refused: a package
// whose stamp says `dirty: true` names a commit it was not made from, so the
// commit tells you nothing about the bytes.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { gitIdentity } = require('../electron/buildInfo');

const STAMP_IN_ASAR = 'electron/build-info.json';

/**
 * The stamp inside a packaged app.
 *
 * `appPath` is a .app bundle, a directory containing app.asar, or an app.asar
 * itself. Returns `{ ok, stamp, asar, error }`.
 */
function readPackagedStamp(appPath) {
  const candidates = [
    appPath,
    path.join(appPath, 'app.asar'),
    path.join(appPath, 'Contents', 'Resources', 'app.asar'),
    path.join(appPath, 'resources', 'app.asar'),
  ];
  const asar = candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
  if (!asar) return { ok: false, stamp: null, asar: null, error: `no app.asar under ${appPath}` };

  let raw;
  try {
    // Required lazily: @electron/asar arrives with electron-builder and is a
    // packaging-time concern, so a runtime that never packages anything should
    // not have to resolve it.
    raw = require('@electron/asar').extractFile(asar, STAMP_IN_ASAR);
  } catch (err) {
    return { ok: false, stamp: null, asar, error: `${STAMP_IN_ASAR} is not in ${asar}: ${err.message}` };
  }
  try {
    return { ok: true, stamp: JSON.parse(raw.toString('utf8')), asar, error: null };
  } catch (err) {
    return { ok: false, stamp: null, asar, error: `${STAMP_IN_ASAR} is not JSON: ${err.message}` };
  }
}

/** SHA-256 of a file, hex. The artefact hash a report quotes. */
function hashFile(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/**
 * Compare a package against a source tree, and optionally against what the live
 * app says about itself.
 *
 * `live` is `{ gitHead, gitTree }` as read off the running server, or null when
 * the app has not been started yet.
 *
 * Returns `{ ok, reasons, source, packaged, live, artifactSha256, asar }`.
 * `reasons` is empty exactly when `ok`.
 */
function compare({ appPath, sourceRoot, live = null } = {}) {
  const reasons = [];

  const source = gitIdentity(sourceRoot);
  if (!source) reasons.push(`${sourceRoot} is not a git checkout, so there is nothing to pin the package to`);
  else if (source.dirty === true) reasons.push('the source tree has uncommitted changes, so its HEAD does not describe it');
  else if (source.dirty === null) reasons.push('could not establish whether the source tree is clean');

  const read = readPackagedStamp(appPath);
  if (!read.ok) reasons.push(`the package carries no readable build identity: ${read.error}`);

  const packaged = read.stamp;
  if (packaged) {
    if (packaged.dirty === true) reasons.push('the package was built from a tree with uncommitted changes');
    if (packaged.dirty === null) reasons.push('the package does not say whether the tree it was built from was clean');
    if (source && packaged.gitHead !== source.gitHead) {
      reasons.push(`package HEAD ${packaged.gitHead || 'unknown'} is not source HEAD ${source.gitHead}`);
    }
    if (source && packaged.gitTree !== source.gitTree) {
      reasons.push(`package tree ${packaged.gitTree || 'unknown'} is not source tree ${source.gitTree}`);
    }
  }

  if (live) {
    if (packaged && live.gitHead !== packaged.gitHead) {
      reasons.push(`the running app reports HEAD ${live.gitHead || 'unknown'}, the package says ${packaged.gitHead || 'unknown'}`);
    }
    if (packaged && live.gitTree !== packaged.gitTree) {
      reasons.push(`the running app reports tree ${live.gitTree || 'unknown'}, the package says ${packaged.gitTree || 'unknown'}`);
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    source,
    packaged,
    live,
    asar: read.asar,
    artifactSha256: read.asar ? hashFile(read.asar) : null,
  };
}

/** The six values, as the header of a dogfood report. */
function report(result) {
  const line = (k, v) => `  ${k.padEnd(22)}${v ?? '—'}`;
  return [
    result.ok ? 'PROVENANCE OK' : 'PROVENANCE RED',
    line('source HEAD', result.source?.gitHead),
    line('source tree', result.source?.gitTree),
    line('package HEAD', result.packaged?.gitHead),
    line('package tree', result.packaged?.gitTree),
    line('live MCP HEAD', result.live?.gitHead),
    line('live MCP tree', result.live?.gitTree),
    line('package version', result.packaged?.packageVersion),
    line('built at', result.packaged?.builtAt),
    line('artifact sha256', result.artifactSha256),
    line('app.asar', result.asar),
    ...result.reasons.map((r) => `  ! ${r}`),
  ].join('\n');
}

module.exports = { compare, report, readPackagedStamp, hashFile, STAMP_IN_ASAR };

// node scripts/provenance.js <appPath> [sourceRoot]
if (require.main === module) {
  const [appPath, sourceRoot = path.join(__dirname, '..')] = process.argv.slice(2);
  if (!appPath) {
    process.stderr.write('usage: node scripts/provenance.js <path to .app or app.asar> [source root]\n');
    process.exit(2);
  }
  const result = compare({ appPath, sourceRoot });
  process.stdout.write(`${report(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
