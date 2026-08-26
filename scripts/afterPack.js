// electron-builder afterPack hook.
//
// Two things, both about what a packaged build is allowed to do:
//
//   1. Keep the official update feed out of builds that are not official
//      releases. `build.publish` stays in the common config — it is what the
//      release job needs and splitting it would mean maintaining two build
//      configurations to express one fact — so electron-builder writes an
//      app-update.yml naming flowtricks/stacki-releases into EVERY package,
//      including `npm run dist:mac:unsigned`. A local build has no business
//      carrying the official feed, so it is removed again here.
//
//      This is defence in depth, not the fix. The fix is the runtime policy in
//      electron/updatePolicy.js, which refuses to start the updater at all;
//      this only makes sure that a build which must not ask also has nothing
//      to ask. Either alone would be enough. Both is cheap.
//
//   2. Restore node-pty's spawn-helper exec bit inside the packaged app. The
//      postinstall script already fixed it in node_modules, but the bit can be
//      lost while copying into the bundle — and without it every pty.spawn
//      throws `posix_spawnp failed.` in the shipped build only, which is the
//      worst place to discover it. See scripts/fix-node-pty-permissions.js.

const path = require('node:path');
const fs = require('node:fs');
const { fixNodePtyPermissions } = require('./fix-node-pty-permissions');
const { saysTrue, UPDATE_ENABLED_FIELD } = require('../electron/updatePolicy');

/** Where electron-builder puts app-update.yml, per platform. */
const resourcesDir = (context) =>
  context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');

exports.default = async function afterPack(context) {
  // Before the win32 return below, because this half applies to every platform
  // — a Windows local build must not consume the official feed either.
  const enabled = saysTrue(context.packager.config?.extraMetadata?.[UPDATE_ENABLED_FIELD]);
  const feed = path.join(resourcesDir(context), 'app-update.yml');
  if (!enabled && fs.existsSync(feed)) {
    fs.rmSync(feed, { force: true });
    console.log('  • afterPack: removed app-update.yml (this build is not an update-enabled release)');
  } else if (enabled) {
    console.log('  • afterPack: kept app-update.yml (update-enabled release build)');
  }

  if (context.electronPlatformName === 'win32') return;

  const appName = context.packager.appInfo.productFilename;
  // node-pty is asarUnpack'd, so it lives beside app.asar as real files.
  const unpacked =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          `${appName}.app`,
          'Contents',
          'Resources',
          'app.asar.unpacked'
        )
      : path.join(context.appOutDir, 'resources', 'app.asar.unpacked');

  const nodePtyDir = path.join(unpacked, 'node_modules', 'node-pty');
  if (!fs.existsSync(nodePtyDir)) {
    console.warn('  • afterPack: node-pty not found in the packaged app; the terminal will not start.');
    return;
  }

  const fixed = fixNodePtyPermissions(nodePtyDir);
  console.log(
    fixed.length
      ? `  • afterPack: restored exec bit on ${fixed.length} node-pty spawn-helper(s)`
      : '  • afterPack: node-pty spawn-helper already executable'
  );
};
