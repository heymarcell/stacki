// Break each guard on purpose, and check that something notices.
//
//   npm run test:securesabotage
//
// PR #7 established the lesson this file exists for: code can exist, have a
// passing test, and still never work. A test that asserts a guard is present
// proves the guard is present. It does not prove the guard does anything, and
// it does not prove that removing it would be caught.
//
// So this removes each guard in turn — really removes it, in the real source
// file — runs the suite that is supposed to care, and records whether that
// suite failed. A sabotage that goes UNCAUGHT is reported as a hole in the
// test suite, and this run fails. That is the point: the output is not "the
// code is fine", it is "these tests would notice".
//
// NOTHING IS COMMITTED. Every file is read into memory first, restored in a
// `finally`, and restored again by a process-exit handler in case this is
// interrupted. The run verifies afterwards that every file is byte-identical
// to how it started, and fails loudly if one is not.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const rel = (p) => path.join(root, p);

const say = (t) => fs.writeSync(1, `${t}\n`);
const shout = (t) => fs.writeSync(2, `${t}\n`);

// Every file this run may touch, and its original bytes. Read once, up front,
// so a restore never depends on a patch having been applied cleanly.
const TOUCHED = [
  'electron/review/secure/crypto.js',
  'electron/review/secure/capability.js',
  'electron/review/secure/secrets.js',
  'electron/review/secure/transport.js',
  'relay/protocol.js',
  'relay/node/store.js',
  'relay/node/server.js',
];
const ORIGINAL = new Map(TOUCHED.map((f) => [f, fs.readFileSync(rel(f), 'utf8')]));

let restored = false;
function restoreAll() {
  if (restored) return;
  restored = true;
  for (const [file, text] of ORIGINAL) {
    try {
      if (fs.readFileSync(rel(file), 'utf8') !== text) fs.writeFileSync(rel(file), text, 'utf8');
    } catch {
      try {
        fs.writeFileSync(rel(file), text, 'utf8');
      } catch (err) {
        shout(`  COULD NOT RESTORE ${file}: ${err.message}`);
      }
    }
  }
}
// Belt and braces: an interrupted run must not leave a sabotaged file — or
// anything a sabotage wrote — behind.
process.on('exit', () => {
  restoreAll();
  try {
    for (const name of fs.readdirSync(root)) {
      if (!rootBefore.has(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  } catch {
    /* nothing more can be done from an exit handler */
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}

/**
 * The sabotages.
 *
 * Each one is a single, plausible mistake — the kind that arrives in a
 * refactor rather than a kind nobody would write. `suite` is the test that is
 * supposed to care; if it still passes with the guard gone, that suite has a
 * hole in it and this run says so.
 */
const SABOTAGES = [
  {
    name: 'the AES associated data binds nothing',
    why: 'an envelope could be moved between rooms and still decrypt',
    file: 'relay/protocol.js',
    find: "const aadFor = ({ roomId, envelopeId, senderId }) =>\n  lengthPrefixed([`${PROTOCOL}/aad`, String(VERSION), roomId, envelopeId, senderId]);",
    replace: "const aadFor = () => lengthPrefixed([`${PROTOCOL}/aad`]);",
    suite: 'test:securecrypto',
  },
  {
    name: 'signature verification always succeeds',
    why: 'anybody could sign anything as anybody',
    file: 'electron/review/secure/crypto.js',
    find: 'function verifyBytes(publicKeyX, bytes, signature) {',
    replace: 'function verifyBytes(publicKeyX, bytes, signature) {\n  return true;',
    suite: 'test:securecrypto',
  },
  {
    name: 'the signed bytes no longer include the room',
    why: 'an envelope from one room would verify in another — cross-room replay',
    file: 'relay/protocol.js',
    find: "    `${PROTOCOL}/envelope`,\n    String(VERSION),\n    roomId,\n    envelopeId,",
    replace: "    `${PROTOCOL}/envelope`,\n    String(VERSION),\n    envelopeId,",
    suite: 'test:securecrypto',
  },
  {
    name: 'the human authorship check is skipped on receipt',
    why: 'Bob could publish a comment attributed to Alice',
    file: 'electron/review/secure/transport.js',
    find: "    if (event.actorKind === 'human' && senderIdFor(keys, event.actorId) !== envelope.senderId) {\n      return { ok: false, code: 'actor_mismatch' };\n    }",
    replace: '    // sabotaged: the human sender binding is not checked',
    suite: 'test:secureshare',
  },
  {
    name: 'the envelope id is not checked against the event inside it',
    why: 'an envelope could claim to carry one event and carry another',
    file: 'electron/review/secure/transport.js',
    find: "    if (envelopeIdFor(keys, event.id) !== envelope.envelopeId) return { ok: false, code: 'envelope_mismatch' };",
    replace: '    // sabotaged: the envelope is not bound to the event inside it',
    suite: 'test:secureshare',
  },
  {
    name: 'a pinned signing key may be replaced',
    why: 'a relay could hand out its own key for a member and sign as them',
    file: 'electron/review/secure/secrets.js',
    find: "    if (known && known !== publicKey) return { ok: false, code: 'key_changed' };",
    replace: '    // sabotaged: a changed key is accepted',
    suite: 'test:secureshare',
  },
  {
    // Single use is defended TWICE — a read check and an atomic conditional
    // update — so removing either one alone changes no behaviour. That is
    // defence in depth working, not a hole, and a sabotage that removed only
    // one would be reported "not caught" for the wrong reason. This is the
    // refactor that would actually break it: both, together.
    name: 'an invitation can be redeemed more than once',
    why: 'one leaked link would let any number of people in',
    file: 'relay/node/store.js',
    patches: [
      {
        find: '      if (row.used_at || row.expires_at < at) return { ok: false, code: \'bad_invite\' };',
        replace: "      if (row.expires_at < at) return { ok: false, code: 'bad_invite' };",
      },
      {
        find: "    useInvite: db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL'),",
        replace: "    useInvite: db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?'),",
      },
    ],
    suite: 'test:securerelay',
  },
  {
    name: 'an invitation never expires',
    why: 'a link shared a year ago would still work',
    file: 'relay/node/store.js',
    find: '      if (row.used_at || row.expires_at < at) return { ok: false, code: \'bad_invite\' };',
    replace: "      if (row.used_at) return { ok: false, code: 'bad_invite' };",
    suite: 'test:securerelay',
  },
  {
    name: 'member credentials are stored in the clear',
    why: 'a database dump would be a list of keys to every room in it',
    file: 'relay/node/store.js',
    find: "const hash = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');",
    replace: 'const hash = (token) => String(token);',
    suite: 'test:securerelay',
  },
  {
    name: 'review events are sent to the relay unencrypted',
    why: 'the whole feature',
    file: 'electron/review/secure/crypto.js',
    find: '  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);',
    replace: '  const ciphertext = Buffer.concat([plaintext, cipher.getAuthTag()]);',
    suite: 'test:securerelay',
  },
  {
    name: 'the relay logs the credential it was given',
    why: 'a log file would be a list of keys',
    file: 'relay/node/server.js',
    find: "      note('member_joined');\n      note('invite_redeemed');",
    replace: "      note('member_joined');\n      note(`invite_redeemed ${joined.credential.token}`);",
    suite: 'test:securerelay',
  },
  {
    name: 'a relay reached over ordinary remote http is accepted',
    why: 'a member token and every ciphertext would go over the wire in clear',
    file: 'electron/review/secure/capability.js',
    find: "  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return null;",
    replace: '  // sabotaged: plain http anywhere is fine',
    suite: 'test:securecrypto',
  },
  {
    name: 'the deep link accepts any protocol version',
    why: 'a capability from another format would be read as if it were this one',
    file: 'electron/review/secure/capability.js',
    find: "  if (!trimmed.startsWith(PREFIX)) return null;",
    replace: '  // sabotaged: the version prefix is not checked',
    suite: 'test:securecrypto',
  },
  {
    name: 'the capability travels in the query string instead of the fragment',
    why: 'every invitation would be in the access log of whoever serves the page',
    file: 'electron/review/secure/capability.js',
    find: '  return origin && capability ? `${origin}/#${capability}` : null;',
    replace: '  return origin && capability ? `${origin}/?c=${capability}` : null;',
    suite: 'test:securecrypto',
  },
  {
    name: 'the secret store writes beside the repository instead of into userData',
    why: 'room secrets would land in somebody’s working tree and be committed',
    file: 'electron/review/secure/secrets.js',
    find: "const fileFor = (userDataPath) => path.join(userDataPath, FILE);",
    replace: 'const fileFor = () => path.join(process.cwd(), FILE);',
    suite: 'test:secureshare',
  },
  {
    name: 'the relay accepts an envelope whose sender is somebody else',
    why: 'a member could fill a room with envelopes attributed to another',
    file: 'relay/node/server.js',
    find: "          if (checked.envelope.senderId !== member.sender_id) {",
    replace: '          if (false) {',
    suite: 'test:securerelay',
  },
  {
    name: 'the relay stores an envelope without verifying its signature',
    why: 'garbage and forgeries would be stored and served to everybody',
    file: 'relay/node/server.js',
    find: "          if (!verifySignature({ roomId, envelope: checked.envelope, publicKey: member.public_key })) {",
    replace: '          if (false) {',
    suite: 'test:securerelay',
  },
  {
    name: 'an envelope may carry any number of fields',
    why: 'a relay would store whatever it was handed',
    file: 'relay/protocol.js',
    find: '  for (const key of keys) if (!allowed.includes(key)) return { ok: false, code: \'bad_envelope\' };',
    replace: '  // sabotaged: unknown fields are allowed through',
    suite: 'test:securerelay',
  },
];

/** Run one npm suite, quietly. Answers whether it PASSED. */
function runSuite(script) {
  const result = spawnSync('npm', ['run', '--silent', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, STACKI_CANVAS_OFFLINE: '1' },
    timeout: 300000,
  });
  return { passed: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}` };
}

/**
 * What is in the repository root, so anything a sabotage creates can be undone.
 *
 * This is not hypothetical. The sabotage that points the secret store at
 * `process.cwd()` does exactly what it says: it writes a `secure-rooms.json`
 * full of room secrets into the repository. The suite catches it — that is the
 * point — and then the file is still sitting there, and the next `git add`
 * commits it. Restoring the source is not enough; what the sabotaged code did
 * has to be undone too.
 */
const rootBefore = new Set(fs.readdirSync(root));

/** Remove anything a sabotage left in the repository root. */
function sweepRoot() {
  const strays = fs.readdirSync(root).filter((name) => !rootBefore.has(name));
  for (const name of strays) {
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    } catch (err) {
      shout(`  COULD NOT REMOVE ${name}: ${err.message}`);
    }
  }
  return strays;
}

const results = [];
let gaps = 0;

try {
  say('secure-sabotage: breaking each guard in turn\n');

  for (const sabotage of SABOTAGES) {
    if (sabotage.skip) continue;
    const file = rel(sabotage.file);
    const before = ORIGINAL.get(sabotage.file);
    if (before == null) {
      shout(`  ${sabotage.file} is not in the restore list`);
      gaps += 1;
      continue;
    }
    const patches = sabotage.patches || [{ find: sabotage.find, replace: sabotage.replace }];
    const missing = patches.find((patch) => !before.includes(patch.find));
    if (missing) {
      // The guard has moved or been reworded. That is not a pass — it means
      // this campaign is no longer testing what it says it tests.
      results.push({ ...sabotage, outcome: 'STALE' });
      shout(`  STALE   ${sabotage.name}\n          the code it patches is not there any more`);
      gaps += 1;
      continue;
    }

    try {
      let broken = before;
      for (const patch of patches) broken = broken.replace(patch.find, patch.replace);
      fs.writeFileSync(file, broken, 'utf8');
      const { passed } = runSuite(sabotage.suite);
      const caught = !passed;
      results.push({ ...sabotage, outcome: caught ? 'caught' : 'NOT CAUGHT' });
      if (caught) {
        say(`  caught      ${sabotage.name}\n              (${sabotage.suite})`);
      } else {
        shout(`  NOT CAUGHT  ${sabotage.name}\n              ${sabotage.why}\n              ${sabotage.suite} passed with the guard removed`);
        gaps += 1;
      }
    } finally {
      fs.writeFileSync(file, before, 'utf8');
      // And whatever the broken code wrote while it was broken.
      const strays = sweepRoot();
      if (strays.length) say(`              (cleaned up ${strays.join(', ')})`);
    }
  }
} finally {
  restoreAll();
}

// Nothing left in the repository root. Checked rather than assumed, because a
// stray secret store here is exactly the thing this feature is supposed to
// make impossible and would be committed by the next `git add -A`.
const strays = fs.readdirSync(root).filter((name) => !rootBefore.has(name));
if (strays.length) {
  shout(`  the repository root gained: ${strays.join(', ')}`);
  gaps += 1;
}

// Every file back exactly as it was. Checked rather than assumed.
let dirty = 0;
for (const [file, text] of ORIGINAL) {
  if (fs.readFileSync(rel(file), 'utf8') !== text) {
    shout(`  ${file} was NOT restored`);
    dirty += 1;
  }
}

const caught = results.filter((r) => r.outcome === 'caught').length;
say(`\nsecure-sabotage: ${caught}/${results.length} sabotages caught`);
if (dirty) {
  shout(`secure-sabotage: ${dirty} file(s) left modified — fix this before committing anything`);
  process.exit(1);
}
say('secure-sabotage: every touched file is byte-identical to how it started');
if (gaps) {
  shout(`\nsecure-sabotage: ${gaps} guard(s) could be removed without a test noticing.`);
  shout('That is a hole in the suite, not a finding about the code. Fix the test.\n');
  process.exit(1);
}
