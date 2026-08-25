// A shared review, read against the tree you actually have.
//
//   node test/review-checkout.js
//
// Two people share a comment. They do not share a working copy. Everything in
// this file exists to stop that difference being invisible, and there are
// exactly two ways it can be:
//
//   A PIN ON THE WRONG THING. Alice comments on the third card on `feature-a`.
//   Bob opens `main`, where index 3 is a different card that happens to look
//   the same. A marker appears on it. It is somebody else's feedback attached
//   to unrelated markup, and the only person who could notice is the one being
//   misled. So a cross-tree pin needs evidence about the NODE — the recorded
//   words, ancestry, sibling runs — and never a position that merely held.
//
//   A TICK OVER A BUG. Claude fixes #17 and resolves it on a commit Bob does
//   not have. The shared thread says `resolved`. Bob's screen still has the
//   bug. So a resolution carries the revision it landed on, and Bob's own git
//   answers whether that revision is here — with `unknown` as a real answer,
//   because a squash merge makes the SHA unreachable while the fix is present.
//
// The checkout side runs against a REAL repository, because the whole point is
// what git says.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const { createCheckout, filesOfAnchor } = require('../electron/review/checkout.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-checkout-'));

(async () => {
  // The renderer's half is an ES module with no dependencies; built rather
  // than reimplemented, so the rules being checked are the ones that ship.
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'review-checkout.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'reviewCheckout.js')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
  });
  const { mayPin, divergent, checkoutNote, originBranch, canEditMessage, canDeleteMessage, canDeleteThread } =
    require(bundlePath);

  // ── A repository with two branches that disagree ─────────────────────────

  const REPO = path.join(home, 'site');
  const run = (args, cwd = REPO) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.test',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.test',
      },
    });

  fs.mkdirSync(path.join(REPO, 'src/pages'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'src/pages/index.astro'), '<h1>Hello</h1>\n');
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.name', 'T']);
  run(['config', 'user.email', 't@example.test']);
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'first']);
  const BASE = run(['rev-parse', 'HEAD']).trim();

  // A fix, on a branch Bob has not merged.
  run(['checkout', '-q', '-b', 'fix']);
  fs.writeFileSync(path.join(REPO, 'src/pages/index.astro'), '<h1>Hello</h1>\n<p>fixed</p>\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'the fix']);
  const FIX = run(['rev-parse', 'HEAD']).trim();
  run(['checkout', '-q', 'main']);

  const thread = (over = {}) => ({
    id: 'rt_1',
    status: 'open',
    anchorState: 'attached',
    anchor: { keys: ['src/pages/index.astro#0.1'] },
    creationContext: {},
    provenance: null,
    resolvedAtSource: null,
    resolvedBy: null,
    ...over,
  });

  // ── Where this working copy is ───────────────────────────────────────────

  {
    const c = createCheckout({ projectPath: REPO });
    const where = c.where();
    check('a checkout knows its branch', where.branch === 'main', where.branch);
    check('and its head', where.head === BASE);
    check('and that it is clean', where.dirty === false);
    // Asking twice must not be two subprocesses: this runs on every redraw of
    // a filtered list.
    const again = c.where();
    check('the answer is reused for a moment', again === where);
    c.reset();
    check('and can be forgotten when the project changes', c.where() !== where);
  }

  // ── The files a review was written about ─────────────────────────────────

  {
    const c = createCheckout({ projectPath: REPO });
    const here = c.digestNow('src/pages/index.astro');
    check('a file on disk has a digest', /^sha1:/.test(here), here);
    check('a file that is not there says so', c.digestNow('src/pages/nope.astro') === 'missing');
    check('a path that climbs out of the project answers nothing at all', c.digestNow('../../../etc/hosts') === null);

    check('a review with no recorded digests cannot be compared', c.sourceState(null) === 'unknown');
    check('nor one with an empty file map', c.sourceState({ files: {} }) === 'unknown');
    check('identical bytes are the same source', c.sourceState({ files: { 'src/pages/index.astro': here } }) === 'same');
    check('different bytes are a change', c.sourceState({ files: { 'src/pages/index.astro': 'sha1:' + '0'.repeat(40) } }) === 'changed');
    check('a file that is not here is missing, not merely changed', c.sourceState({ files: { 'src/pages/gone.astro': 'sha1:x' } }) === 'missing');
  }

  // ── F: a resolution on a revision this checkout does not have ────────────

  {
    const c = createCheckout({ projectPath: REPO });
    check('a resolution on this very commit is present', c.resolutionState({ head: BASE, branch: 'main', dirty: false }) === 'present');
    check('a resolution on a branch this tree has not merged is behind', c.resolutionState({ head: FIX, branch: 'fix', dirty: false }) === 'behind', c.resolutionState({ head: FIX, branch: 'fix', dirty: false }));
    // Every honest shrug.
    check('a resolution with no commit is unknown', c.resolutionState({ head: null, branch: 'main', dirty: null }) === 'unknown');
    check('a commit this repository has never seen is unknown', c.resolutionState({ head: '0'.repeat(40), branch: 'x', dirty: false }) === 'unknown');
    // Resolved with uncommitted work: the SHA is real and is not where the fix
    // is, so having that commit proves nothing whatever.
    check('a resolution made on a dirty tree is unknown, not present', c.resolutionState({ head: BASE, branch: 'main', dirty: true }) === 'unknown');
    check('and no stamp at all is unknown', c.resolutionState(null) === 'unknown');
  }

  // ── ...and once the fix is merged, the warning has to clear ──────────────

  {
    const resolvedThread = thread({
      status: 'resolved',
      provenance: { head: BASE, branch: 'fix', dirty: false, files: {} },
      resolvedAtSource: { head: FIX, branch: 'fix', dirty: false },
      resolvedBy: { actorId: 'a', actorKind: 'agent', actorName: 'Claude' },
    });

    const before = createCheckout({ projectPath: REPO }).forThread(resolvedThread);
    check('before merging, the resolution is behind this checkout', before.resolution === 'behind', before.resolution);
    const noteBefore = checkoutNote({ ...resolvedThread, checkout: before });
    check('and it is said as such', noteBefore?.kind === 'resolved-elsewhere', JSON.stringify(noteBefore));
    check('naming who resolved it', noteBefore.who === 'Claude');
    check('and the revision they resolved it on', noteBefore.commit === FIX.slice(0, 7));

    run(['merge', '-q', '--no-ff', '-m', 'merge the fix', 'fix']);
    const after = createCheckout({ projectPath: REPO }).forThread(resolvedThread);
    check('once merged, the resolution is present', after.resolution === 'present', after.resolution);
    const noteAfter = checkoutNote({ ...resolvedThread, checkout: after });
    check('and nothing claims the fix is missing any more', noteAfter?.kind !== 'resolved-elsewhere' && noteAfter?.kind !== 'resolved-unproven', JSON.stringify(noteAfter));
    // What is left is only the true, mild fact that it was written on a branch
    // this one is not — which is also why a pin from it needs real evidence.
    check('only where it came from is still worth saying', noteAfter?.kind === 'other-branch', JSON.stringify(noteAfter));
    check('and the commit it was written on is in this history', after.originIn === 'present', after.originIn);
  }

  // ── A squashed or rebased-away commit degrades honestly ─────────────────

  {
    const squashed = thread({
      status: 'resolved',
      resolvedAtSource: { head: 'f'.repeat(40), branch: 'gone', dirty: false },
      resolvedBy: { actorId: 'a', actorKind: 'human', actorName: 'Alice' },
    });
    const c = createCheckout({ projectPath: REPO }).forThread(squashed);
    check('an unreachable commit is unknown rather than absent', c.resolution === 'unknown', c.resolution);
    const note = checkoutNote({ ...squashed, checkout: c });
    // The distinction that matters: "we cannot tell" is not "you do not have
    // it". A squash merge makes the SHA unreachable while the fix is present,
    // and telling somebody their tree is behind there would be a confident lie.
    check('and is shown as uncertainty, not as absence', note?.kind === 'resolved-unproven', JSON.stringify(note));
  }

  // ── A reopened thread's old resolution describes nothing ────────────────

  {
    const c = createCheckout({ projectPath: REPO });
    const reopened = thread({ status: 'open', resolvedAtSource: null });
    check('an open thread has no resolution state', c.forThread(reopened).resolution === null);
    check('and nothing to warn about', checkoutNote({ ...reopened, checkout: c.forThread(reopened) }) === null);
  }

  // ── Which branch a review came from ──────────────────────────────────────

  {
    const c = createCheckout({ projectPath: REPO });
    const fromHere = c.forThread(thread({ provenance: { head: BASE, branch: 'main', dirty: false, files: {} } }));
    check('a review from this branch says so', fromHere.sameBranch === true);
    const fromThere = c.forThread(thread({ provenance: { head: FIX, branch: 'feature-a', dirty: false, files: {} } }));
    check('and one from elsewhere says that', fromThere.sameBranch === false);
    // By this point `fix` has been merged into `main`, so the commit the
    // review was written on IS in this history — which is the fact that stops
    // a merged branch reading as a divergence.
    check('and whether the commit it was written on is in this history', fromThere.originIn === 'present', fromThere.originIn);
    check('a review with no recorded commit says nothing about that', c.forThread(thread({ provenance: { head: null, branch: 'x', dirty: null, files: {} } })).originIn === null);
    // Null, not false: "written somewhere else" and "nobody recorded where"
    // are different, and only one of them is a reason to withhold a pin.
    const unknownOrigin = c.forThread(thread({ provenance: null }));
    check('a review with no recorded branch says nobody knows', unknownOrigin.sameBranch === null, String(unknownOrigin.sameBranch));
    check('and an old review’s recorded branch is still used', c.forThread(thread({ creationContext: { branch: 'legacy' } })).origin.branch === 'legacy');
    check('originBranch reads provenance first', originBranch({ provenance: { branch: 'p' }, creationContext: { branch: 'c' } }) === 'p');
    check('and falls back to the creation snapshot', originBranch({ creationContext: { branch: 'c' } }) === 'c');
  }

  // ── G and H: what may wear a pin ─────────────────────────────────────────

  const sameTree = { checkout: { sameBranch: true, source: 'same', resolution: null } };
  const otherBranch = { checkout: { sameBranch: false, source: 'changed', resolution: null } };
  const fileGone = { checkout: { sameBranch: true, source: 'missing', resolution: null } };
  const unmeasured = {};

  {
    check('nothing is divergent until something says so', !divergent({ ...unmeasured, anchorState: 'attached' }));
    check('another branch is divergence', divergent(otherBranch));
    check('a missing file is divergence', divergent(fileGone));
    // An edited file is NOT divergence. Files change every time feedback is
    // acted on; treating that as another tree would drop the pin off every
    // review at the moment it was addressed.
    check('an edited file is not', !divergent({ checkout: { sameBranch: true, source: 'changed', resolution: null } }));

    // G — the case this whole file exists for.
    check(
      'a positional-only match on another branch gets no pin',
      !mayPin({ ...otherBranch, anchorState: 'attached' }, 'positional')
    );
    check(
      'and neither does a key that was never verified at all',
      !mayPin({ ...otherBranch, anchorState: 'attached' }, 'unverified')
    );
    // H — proof about the node travels.
    check('an exact match on another branch may pin', mayPin({ ...otherBranch, anchorState: 'attached' }, 'exact'));
    check('so may one found by its recorded marks', mayPin({ ...otherBranch, anchorState: 'attached' }, 'moved'));

    // Being DESCENDED from the commit a review was written on is not the same
    // as still looking like it. A branch taken after a merge and then
    // rewritten has that ancestor and none of its markup, so ancestry does not
    // buy a positional pin — the review is not lost, it simply has to be
    // identified by the marks it recorded.
    const merged = { checkout: { sameBranch: false, source: 'changed', originIn: 'present', resolution: null } };
    check('ancestry alone does not make a cross-branch review safe to pin', divergent(merged));
    check('so a positional match from it still gets no pin', !mayPin({ ...merged, anchorState: 'attached' }, 'positional'));
    check('while proof about the node still does', mayPin({ ...merged, anchorState: 'attached' }, 'moved'));
    check('and the panel says where it came from', checkoutNote({ ...merged, status: 'open' })?.kind === 'other-branch');

    // Byte-identical files settle it outright, with or without a repository:
    // the markup this was written about is the markup that is here.
    const identicalBytes = { checkout: { sameBranch: false, source: 'same', originIn: 'unknown', resolution: null } };
    check('identical file bytes beat a branch difference', !divergent(identicalBytes));
    check('and let a positional match pin', mayPin({ ...identicalBytes, anchorState: 'attached' }, 'positional'));

    // Same tree: nothing changes. This is the ordinary local case and must not
    // regress.
    check('a positional match on the same branch still pins', mayPin({ ...sameTree, anchorState: 'attached' }, 'positional'));
    check('and so does an unverified key on the same branch', mayPin({ ...sameTree, anchorState: 'attached' }, 'unverified'));
    check('a project with nothing measured behaves as it always did', mayPin({ ...unmeasured, anchorState: 'attached' }, 'positional'));

    // And the rules that were already true.
    check('an orphan never pins', !mayPin({ ...sameTree, anchorState: 'orphaned' }, 'exact'));
    check('nor does a resolver that found nothing', !mayPin({ ...sameTree, anchorState: 'attached' }, 'none'));
    check('a review with a missing file gets no positional pin', !mayPin({ ...fileGone, anchorState: 'attached' }, 'positional'));
    check('but an exact match still may', mayPin({ ...fileGone, anchorState: 'attached' }, 'exact'));
  }

  // ── What the panel says about it ─────────────────────────────────────────

  {
    const note = checkoutNote({ ...otherBranch, status: 'open', provenance: { branch: 'feature-a' }, checkout: { ...otherBranch.checkout, branch: 'main' } }, { pinned: false });
    check('a cross-branch review says where it came from', note?.kind === 'other-branch' && note.branch === 'feature-a', JSON.stringify(note));
    check('and where you are', note.here === 'main');
    check('and whether a pin was withheld', note.pinned === false);
    const missing = checkoutNote({ ...fileGone, status: 'open', provenance: { branch: 'feature-a' } });
    check('a missing file is said before a branch difference', missing?.kind === 'missing-source', JSON.stringify(missing));
    check('an ordinary same-tree review says nothing at all', checkoutNote({ ...sameTree, status: 'open' }) === null);
    check('and a review with nothing measured says nothing', checkoutNote({ status: 'open' }) === null);
  }

  // ── Ownership, as the panel asks it ──────────────────────────────────────

  {
    const mine = { authorType: 'human', actorId: 'me' };
    const theirs = { authorType: 'human', actorId: 'them' };
    const agent = { authorType: 'agent', actorId: 'claude' };
    const ancient = { authorType: 'human', actorId: null };

    check('you may reword your own', canEditMessage(mine, 'me'));
    check('not another person’s', !canEditMessage(theirs, 'me'));
    check('and not an agent’s', !canEditMessage(agent, 'me'));
    check('a message from before authorship was recorded is yours', canEditMessage(ancient, 'me'));

    check('you may delete your own', canDeleteMessage(mine, 'me'));
    check('and an agent’s', canDeleteMessage(agent, 'me'));
    check('but not another person’s', !canDeleteMessage(theirs, 'me'));

    check('you may delete your own review', canDeleteThread({ author: { actorKind: 'human', actorId: 'me' } }, 'me'));
    check('not somebody else’s', !canDeleteThread({ author: { actorKind: 'human', actorId: 'them' } }, 'me'));
    check('and an agent’s review may be deleted by a person', canDeleteThread({ author: { actorKind: 'agent', actorId: 'c' } }, 'me'));
    check('a review with no recorded author is this installation’s own', canDeleteThread({}, 'me'));
  }

  // ── The files a review is about ──────────────────────────────────────────

  {
    check(
      'an anchor names its files',
      filesOfAnchor({ keys: ['src/pages/index.astro#0.1', 'src/components/Hero.astro#0.2'] }).join() ===
        'src/pages/index.astro,src/components/Hero.astro'
    );
    check('and names each of them once', filesOfAnchor({ keys: ['a#1', 'a#2'] }).join() === 'a');
    check('an anchor with no keys names nothing', filesOfAnchor({}).length === 0 && filesOfAnchor(null).length === 0);
  }

  // ── A project with no repository is not a project with a problem ─────────

  {
    const plain = path.join(home, 'plain');
    fs.mkdirSync(path.join(plain, 'src'), { recursive: true });
    fs.writeFileSync(path.join(plain, 'src/page.astro'), '<main>hi</main>');
    const c = createCheckout({ projectPath: plain });
    const state = c.forThread(thread({ provenance: { head: null, branch: null, dirty: null, files: { 'src/page.astro': c.digestNow('src/page.astro') } } }));
    check('a project with no git still knows where it is', state.branch === null && state.head === null);
    check('and can still compare the files', state.source === 'same', state.source);
    check('and says nothing about branches', state.sameBranch === null);
    const edited = (() => {
      fs.writeFileSync(path.join(plain, 'src/page.astro'), '<main>edited</main>');
      return createCheckout({ projectPath: plain }).forThread(
        thread({ provenance: { head: null, branch: null, dirty: null, files: { 'src/page.astro': 'sha1:' + '0'.repeat(40) } } })
      );
    })();
    check('an edit is visible with no repository at all', edited.source === 'changed', edited.source);
  }

  fs.rmSync(home, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\nreview-checkout: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`review-checkout: ${checked} passed  [no pin without evidence, no tick without the fix]`);
})();
