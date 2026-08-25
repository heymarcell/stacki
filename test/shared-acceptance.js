// Alice and Bob, for real.
//
//   node --disable-warning=ExperimentalWarning test/shared-acceptance.js
//
// Unit tests prove the pieces. This proves the product, and it is the only
// test here that would have caught the failures that matter most — because
// every one of them lives between two installations rather than inside one.
//
// Two SEPARATE PROCESSES, each running the real electron/review/index.js with
// its own userData, its own identity, its own ledger and its own clock. Two
// working copies of one repository. One reference service on a real port.
// Nothing is mocked between them.
//
// The scenario, in order:
//
//   Alice opens the project, starts a workspace, and comments on the hero.
//   Bob accepts an invitation, synchronises, and sees Alice's thread with
//     Alice's name on it — and with its anchor UNRESOLVED, because nothing on
//     his machine has looked yet. He is never handed her anchor state.
//   Bob replies. Alice synchronises and reads it.
//   Claude changes the source on Alice's side, commits, and resolves the
//     review. Alice synchronises.
//   Bob synchronises his COMMENTS BEFORE his SOURCE. The thread says resolved.
//     His checkout does not contain the commit it was resolved on, and his
//     Stacki says exactly that rather than showing a tick.
//   Bob pulls the source. The warning clears, because now the evidence
//     supports it.
//   Bob checks out a divergent branch. The thread is still readable. The pin
//     is withheld, because a position that merely held is not evidence about
//     a node on another tree.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const { createReviewService } = require('../service/server.js');
const { createWorkspaces } = require('../electron/review/workspaces.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-accept-'));
const SIGNUP = 'an-acceptance-signup-token';
const DRIVER = path.join(__dirname, 'support', 'reviewClient.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
};
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();

/** One installation, talked to over a pipe. */
function client(name, env = {}) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', DRIVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let nextId = 1;
  const waiting = new Map();
  let buffer = '';
  const errors = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        errors.push(`${name}: unreadable answer ${line.slice(0, 200)}`);
        continue;
      }
      const settle = waiting.get(message.id);
      if (settle) {
        waiting.delete(message.id);
        settle(message);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => errors.push(`${name}: ${text.trim()}`));

  const send = (op, args) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${name}: ${op} did not answer`));
      }, 20000);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        if (!message.ok) return reject(new Error(`${name}: ${op} threw — ${message.error}`));
        resolve(message.result);
      });
      child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });

  return {
    name,
    send,
    errors,
    async quit() {
      try {
        await send('quit');
      } catch {
        child.kill();
      }
    },
  };
}

/**
 * The payload a click in comment mode publishes.
 *
 * The real shape, from src/mcpContext.js — a comment made from it goes through
 * the same anchor builder as a click in the app, so what this test creates is
 * what a person would create.
 */
const payloadFor = (root, branch) => ({
  project: { root, branch },
  page: { route: '/', file: path.join(root, 'src/pages/index.astro') },
  view: { device: 'desktop', viewportWidth: 1280, viewportHeight: 800 },
  preview: { status: 'on' },
  selection: {
    present: true,
    nodeKind: 'element',
    tag: 'a',
    occurrence: 0,
    occurrenceCount: 1,
    keys: ['src/pages/index.astro#0.1'],
    componentChain: ['index'],
    breadcrumbs: ['index', 'section', 'a'],
    peers: [{ index: 0, count: 1 }],
    text: 'Get started',
    classes: ['cta'],
    rect: { x: 0, y: 0, w: 200, h: 44 },
  },
});

(async () => {
  // ── One service, two working copies ──────────────────────────────────────

  const service = createReviewService({
    port: 0,
    host: '127.0.0.1',
    file: path.join(home, 'service.db'),
    signupToken: SIGNUP,
  });
  await service.start();
  const SERVER = `http://127.0.0.1:${service.address.port}`;

  const REPO_A = path.join(home, 'alice', 'site');
  const REPO_B = path.join(home, 'bob', 'site');
  fs.mkdirSync(path.join(REPO_A, 'src/pages'), { recursive: true });
  fs.writeFileSync(
    path.join(REPO_A, 'src/pages/index.astro'),
    '<section>\n  <h1>Lenuri</h1>\n  <a class="cta">Get started</a>\n</section>\n'
  );
  git(REPO_A, ['init', '-q', '-b', 'main']);
  git(REPO_A, ['config', 'user.name', 'Alice Git']);
  git(REPO_A, ['config', 'user.email', 'alice@example.test']);
  git(REPO_A, ['add', '-A']);
  git(REPO_A, ['commit', '-q', '-m', 'the site']);
  const BASE_COMMIT = git(REPO_A, ['rev-parse', 'HEAD']);

  fs.mkdirSync(path.dirname(REPO_B), { recursive: true });
  execFileSync('git', ['clone', '-q', REPO_A, REPO_B], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  git(REPO_B, ['config', 'user.name', 'Bob Git']);
  git(REPO_B, ['config', 'user.email', 'bob@example.test']);
  check('both working copies start on the same commit', git(REPO_B, ['rev-parse', 'HEAD']) === BASE_COMMIT);

  const DATA_A = path.join(home, 'alice', 'userData');
  const DATA_B = path.join(home, 'bob', 'userData');
  fs.mkdirSync(DATA_A, { recursive: true });
  fs.mkdirSync(DATA_B, { recursive: true });

  // The agent's name comes from the client that connected; here it is set the
  // way a Stacki running beside Claude would see it.
  const alice = client('alice', { STACKI_AGENT_NAME: 'Claude' });
  const bob = client('bob');

  try {
    // ── Alice ──────────────────────────────────────────────────────────────

    await alice.send('start', { userDataPath: DATA_A });
    const channels = await alice.send('channels');
    check(
      'every door the preload knocks on is registered',
      ['reviews:list', 'reviews:act', 'reviews:sync', 'reviews:sharedEnable', 'reviews:sharedJoin', 'reviews:sharedDisable', 'reviews:sharedInvite', 'reviews:identity', 'reviews:setIdentity'].every((c) =>
        channels.channels.includes(c)
      ),
      channels.channels.join()
    );

    await alice.send('open', { projectPath: REPO_A });
    await alice.send('payload', { value: payloadFor(REPO_A, 'main') });

    const suggested = await alice.send('identity');
    check('an identity is made on first need', !!suggested.actorId, JSON.stringify(suggested));
    check('and it is a uuid rather than an email or a username', /^[0-9a-f-]{36}$/.test(suggested.actorId));
    // The git author is offered as a default. It is never the identity, and
    // the git EMAIL is never used for anything at all.
    check('the name is suggested from the project’s git author', suggested.suggested === 'Alice Git', JSON.stringify(suggested));
    check('and the git email is nowhere near it', !JSON.stringify(suggested).includes('alice@example.test'));
    const renamed = await alice.send('setIdentity', { displayName: 'Alice' });
    check('a person can choose what to be called', renamed.displayName === 'Alice');
    check('and the id does not move when they do', renamed.actorId === suggested.actorId);

    const beforeSharing = await alice.send('shared');
    check('a project starts unshared', beforeSharing.shared.enabled === false);

    const enabled = await alice.send('enable', { server: SERVER, signupToken: SIGNUP, publishExisting: false });
    check('Alice starts a workspace', enabled.ok === true, JSON.stringify(enabled));
    check('and the project is now sharing', enabled.shared.enabled === true && !!enabled.shared.workspace.id);
    check('under her own name', enabled.shared.identity.displayName === 'Alice');
    // Nobody is asked to name a workspace, so it is named after the project it
    // is for. The alternative is what the server calls one by default, which
    // made every workspace on every project read identically in the one line
    // at the top of the Comments panel — and in every agent's read of it.
    check('and the workspace is named after the project', enabled.shared.workspace.displayName === path.basename(REPO_A), enabled.shared.workspace.displayName);

    const made = await alice.send('act', {
      action: 'create',
      message: 'This CTA is too close to the copy.',
      pin: { xRatio: 0.5, yRatio: 0.5 },
    });
    check('Alice leaves a comment', made.ok === true, JSON.stringify(made.code || made.message));
    const N = made.review.number;
    check('it has a number she can say out loud', Number.isInteger(N) && N > 0);
    check('and records the source it was written against', made.review.provenance?.head === BASE_COMMIT, JSON.stringify(made.review.provenance));
    check('including a digest of the file', !!made.review.provenance.files['src/pages/index.astro']);
    check('and it is attached on her own tree', made.review.anchorState === 'attached');

    const alicePushed = await alice.send('sync', { reason: 'manual' });
    check('and a sync sends it', alicePushed.ok === true && alicePushed.pushed >= 2, JSON.stringify(alicePushed));
    check('leaving nothing waiting', alicePushed.shared.pending === 0);

    const invitation = await alice.send('invite');
    check('Alice can invite somebody', invitation.ok === true && typeof invitation.invite === 'string');

    // ── Bob ────────────────────────────────────────────────────────────────

    await bob.send('start', { userDataPath: DATA_B });
    await bob.send('setIdentity', { displayName: 'Bob' });
    await bob.send('open', { projectPath: REPO_B });
    await bob.send('payload', { value: payloadFor(REPO_B, 'main') });

    const joined = await bob.send('join', { invite: invitation.invite, publishExisting: false });
    check('Bob joins with the invitation', joined.ok === true, JSON.stringify(joined));
    check('and lands in Alice’s workspace', joined.shared.workspace.id === enabled.shared.workspace.id);
    check('which he sees by the same name she does', joined.shared.workspace.displayName === enabled.shared.workspace.displayName, joined.shared.workspace.displayName);

    const bobList = await bob.send('list');
    const bobThread = bobList.reviews.find((r) => r.number === N);
    check('Bob sees Alice’s comment', !!bobThread, JSON.stringify(bobList.reviews.map((r) => r.number)));
    check('and it says Alice wrote it', bobThread.author.actorName === 'Alice' && bobThread.author.actorKind === 'human', JSON.stringify(bobThread.author));
    check('with the same number she sees', bobThread.number === N);
    check('and the words she wrote', bobThread.messages[0].body === 'This CTA is too close to the copy.');
    // The rule this whole feature is built on. Bob's Stacki has not looked at
    // his own tree for this element, so it does not claim to have found it —
    // whatever Alice's Stacki found on hers.
    check('but its anchor is not resolved on his word', bobThread.anchorState === 'unknown', bobThread.anchorState);
    check('and his checkout is compared against hers', bobThread.checkout.source === 'same', JSON.stringify(bobThread.checkout));
    check('on the same branch', bobThread.checkout.sameBranch === true);

    // Bob's own resolver looks, and only then is the anchor his to state.
    await bob.send('syncAnchors', { updates: [{ id: bobThread.id, anchorState: 'attached' }] });
    check('once his own Stacki looks, it is attached', (await bob.send('list')).reviews.find((r) => r.id === bobThread.id).anchorState === 'attached');

    // ── Bob replies, Alice reads it ────────────────────────────────────────

    const replied = await bob.send('act', { action: 'reply', threadId: bobThread.id, message: 'Agreed. The button is small on mobile too.' });
    check('Bob replies', replied.ok === true, JSON.stringify(replied));
    await bob.send('sync', { reason: 'manual' });
    await alice.send('sync', { reason: 'manual' });
    const aliceThread = (await alice.send('list')).reviews.find((r) => r.number === N);
    check('Alice sees Bob’s reply', aliceThread.messages.length === 2, String(aliceThread.messages.length));
    check('signed with his name', aliceThread.messages[1].actorName === 'Bob');
    check('and hers is still hers', aliceThread.messages[0].actorName === 'Alice');

    // Ownership across the wire: Bob cannot reword what Alice wrote.
    const forged = await bob.send('via', {
      channel: 'reviews:editMessage',
      args: { threadId: bobThread.id, messageId: bobThread.messages[0].id, message: 'I never said this' },
    });
    check('Bob cannot reword Alice’s message', forged.ok === false && forged.code === 'not_yours', JSON.stringify(forged));
    const deleted = await bob.send('via', { channel: 'reviews:remove', args: bobThread.id });
    check('nor delete her review', deleted.ok === false && deleted.code === 'not_yours', JSON.stringify(deleted));
    await bob.send('sync', { reason: 'manual' });
    await alice.send('sync', { reason: 'manual' });
    check(
      'and nothing he tried reached her copy',
      (await alice.send('list')).reviews.find((r) => r.number === N).messages[0].body === 'This CTA is too close to the copy.'
    );

    // ── Claude fixes it on Alice's side ────────────────────────────────────

    fs.writeFileSync(
      path.join(REPO_A, 'src/pages/index.astro'),
      '<section>\n  <h1>Lenuri</h1>\n\n  <a class="cta">Get started</a>\n</section>\n'
    );
    git(REPO_A, ['add', '-A']);
    git(REPO_A, ['commit', '-q', '-m', 'space the CTA away from the copy']);
    const FIX_COMMIT = git(REPO_A, ['rev-parse', 'HEAD']);
    check('the fix is a commit Bob does not have', FIX_COMMIT !== BASE_COMMIT);

    const resolved = await alice.send('act', {
      action: 'resolve',
      threadId: aliceThread.id,
      authorType: 'agent',
      message: 'Added 24px of space and checked it at 375 and 1280.',
    });
    check('Claude resolves it', resolved.ok === true && resolved.review.status === 'resolved', JSON.stringify(resolved.code));
    check('as an agent, not as Alice', resolved.review.resolvedBy.actorKind === 'agent', JSON.stringify(resolved.review.resolvedBy));
    check('with its own name on it', resolved.review.resolvedBy.actorName === 'Claude', resolved.review.resolvedBy.actorName);
    check('and the revision the fix landed on', resolved.review.resolvedAtSource.head === FIX_COMMIT, JSON.stringify(resolved.review.resolvedAtSource));
    check('and on Alice’s own tree the resolution is present', resolved.review.checkout.resolution === 'present', resolved.review.checkout.resolution);
    await alice.send('sync', { reason: 'manual' });

    // ── Bob syncs his COMMENTS before his SOURCE ───────────────────────────
    //
    // The failure this whole feature exists to prevent. The thread says
    // resolved. Bob's screen still has the bug.

    await bob.send('sync', { reason: 'manual' });
    const behind = (await bob.send('list')).reviews.find((r) => r.number === N);
    check('Bob sees it as resolved', behind.status === 'resolved');
    check('and knows who resolved it', behind.resolvedBy.actorName === 'Claude');
    check('and on which revision', behind.resolvedAtSource.head === FIX_COMMIT);
    // NOT a tick. Bob has not even fetched, so his git has never heard of that
    // commit — `unknown` is the honest word for it, and `unknown` is shown as
    // uncertainty rather than as absence.
    check('his repository cannot vouch for the resolution', behind.checkout.resolution === 'unknown', JSON.stringify(behind.checkout));
    check('and his source is still exactly what it was', behind.checkout.source === 'same' && behind.checkout.head === BASE_COMMIT, JSON.stringify(behind.checkout));
    check('and the closing note is readable either way', behind.messages[behind.messages.length - 1].body.includes('24px'));

    // ── ...and once he fetches, git can prove it ───────────────────────────
    //
    // Fetching without merging is the ordinary shape of "I have seen the
    // commit and I am not on it". Now the answer is not a shrug.

    git(REPO_B, ['fetch', '-q', 'origin']);
    await bob.send('close');
    await bob.send('open', { projectPath: REPO_B });
    const proven = (await bob.send('list')).reviews.find((r) => r.number === N);
    check('with the commit fetched, his checkout is provably behind it', proven.checkout.resolution === 'behind', JSON.stringify(proven.checkout));
    check('and his tree has not moved', proven.checkout.head === BASE_COMMIT);

    // ── ...then Bob pulls the source ───────────────────────────────────────

    git(REPO_B, ['merge', '-q', '--ff-only', 'origin/main']);
    check('Bob now has the fix', git(REPO_B, ['rev-parse', 'HEAD']) === FIX_COMMIT);
    // Reopening the project is what a person does; it also drops the cached
    // answers about where this working copy is.
    await bob.send('close');
    await bob.send('open', { projectPath: REPO_B });
    const caughtUp = (await bob.send('list')).reviews.find((r) => r.number === N);
    check('and the warning clears', caughtUp.checkout.resolution === 'present', JSON.stringify(caughtUp.checkout));
    check('while the review still says who resolved it and when', caughtUp.resolvedAtSource.head === FIX_COMMIT);
    check('and the file is now the edited one', caughtUp.checkout.source === 'changed', caughtUp.checkout.source);

    // ── Bob on a divergent branch ──────────────────────────────────────────

    git(REPO_B, ['checkout', '-q', '-b', 'bob/experiment']);
    fs.writeFileSync(
      path.join(REPO_B, 'src/pages/index.astro'),
      '<section>\n  <h2>Something else entirely</h2>\n  <a class="cta">Buy</a>\n</section>\n'
    );
    git(REPO_B, ['add', '-A']);
    git(REPO_B, ['commit', '-q', '-m', 'a different page']);
    await bob.send('close');
    await bob.send('open', { projectPath: REPO_B });

    const divergent = (await bob.send('list')).reviews.find((r) => r.number === N);
    // Readable, always. A shared review is never hidden because its source
    // moved — hiding it would lose the conversation as well as the pin.
    check('the thread is still readable on another branch', !!divergent && divergent.messages.length === 3, JSON.stringify(divergent?.messages?.length));
    check('and still says who wrote what', divergent.messages[0].actorName === 'Alice' && divergent.messages[1].actorName === 'Bob');
    check('Stacki knows he is somewhere else', divergent.checkout.branch === 'bob/experiment', divergent.checkout.branch);
    check('and that the review came from main', divergent.checkout.sameBranch === false, JSON.stringify(divergent.checkout));
    check('and that the file no longer says what it said', divergent.checkout.source === 'changed', divergent.checkout.source);

    // The pin decision is the renderer's, made from exactly this block.
    const esbuild = require('esbuild');
    const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
    fs.mkdirSync(buildDir, { recursive: true });
    const bundlePath = path.join(buildDir, 'accept-checkout.bundle.js');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'reviewCheckout.js')],
      outfile: bundlePath,
      bundle: true,
      format: 'cjs',
      platform: 'node',
    });
    const { mayPin, checkoutNote } = require(bundlePath);

    check('a position that merely held gets no pin here', !mayPin({ ...divergent, anchorState: 'attached' }, 'positional'));
    check('nor does a key nothing has verified', !mayPin({ ...divergent, anchorState: 'attached' }, 'unverified'));
    // Evidence about the node itself still travels: if Bob's resolver
    // identifies it by the recorded marks, the pin is honest.
    check('but proof about the node itself still pins', mayPin({ ...divergent, anchorState: 'attached' }, 'exact'));
    const note = checkoutNote(divergent, { pinned: false });
    check('and the panel says why there is no pin', note?.kind === 'other-branch' && note.branch === 'main', JSON.stringify(note));
    check('naming the branch he is actually on', note.here === 'bob/experiment');
    // Being descended from the commit the review was written on is not the
    // same as still looking like it — this branch has that ancestor and none
    // of its markup.
    check('even though the commit it was written on is in his history', divergent.checkout.originIn === 'present', divergent.checkout.originIn);

    // Back on main, everything behaves as it did.
    git(REPO_B, ['checkout', '-q', 'main']);
    await bob.send('close');
    await bob.send('open', { projectPath: REPO_B });
    const home_ = (await bob.send('list')).reviews.find((r) => r.number === N);
    check('back on his own branch it pins again', mayPin({ ...home_, anchorState: 'attached' }, 'positional'));
    check('and there is nothing to warn about', checkoutNote(home_) === null, JSON.stringify(checkoutNote(home_)));

    // ── Privacy, end to end ────────────────────────────────────────────────

    {
      // Nothing was written into either working copy. This is the rule the
      // whole feature is built under, and it is checked against the actual
      // directories rather than against an intention.
      const strayA = git(REPO_A, ['status', '--porcelain']);
      const strayB = git(REPO_B, ['status', '--porcelain']);
      check('nothing was written into Alice’s repository', strayA === '', strayA);
      check('nor into Bob’s', strayB === '', strayB);
      check('and no .stacki folder appeared in either', !fs.existsSync(path.join(REPO_A, '.stacki')) && !fs.existsSync(path.join(REPO_B, '.stacki')));

      // The credential lives in userData, is not readable by anybody else, and
      // is not in the repository, in git config, or in the ledger.
      const registryA = createWorkspaces({ userDataPath: DATA_A });
      const held = registryA.all()[0];
      check('Alice’s credential is in her own userData', !!held?.token && registryA.file.startsWith(DATA_A));
      check('and only she can read it', registryA.secure(), (fs.statSync(registryA.file).mode & 0o777).toString(8));
      const gitConfig = fs.readFileSync(path.join(REPO_A, '.git', 'config'), 'utf8');
      check('it is not in the git config', !gitConfig.includes(held.token));
      const ledgerDir = path.join(DATA_A, 'reviews');
      const ledgers = fs.readdirSync(ledgerDir).map((f) => fs.readFileSync(path.join(ledgerDir, f), 'utf8'));
      check('nor in the review ledger', ledgers.every((text) => !text.includes(held.token)));
      check('and the ledger holds the workspace id, which is not a secret', ledgers.some((text) => text.includes(held.id)));
    }

    // ── Turning it off keeps everything ────────────────────────────────────

    {
      const off = await bob.send('disable');
      check('Bob can stop sharing', off.ok === true && off.shared.enabled === false, JSON.stringify(off));
      const after = await bob.send('list');
      check('and keeps every comment', after.reviews.length >= 1 && after.reviews.some((r) => r.number === N));
      check('including Alice’s words', after.reviews.find((r) => r.number === N).messages[0].actorName === 'Alice');
      const quiet = await bob.send('sync', { reason: 'manual' });
      check('and a sync now does nothing at all', quiet.skipped === 'not_shared', JSON.stringify(quiet));
    }

    check('neither client wrote anything to stderr', alice.errors.length === 0 && bob.errors.length === 0, [...alice.errors, ...bob.errors].join('\n    '));
  } finally {
    await alice.quit();
    await bob.quit();
    await service.stop();
  }

  fs.rmSync(home, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\nshared-acceptance: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`shared-acceptance: ${checked} passed  [two installations, two checkouts, one conversation]`);
})().catch((err) => {
  console.error('shared-acceptance: threw\n', err);
  process.exit(1);
});
