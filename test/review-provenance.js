// What the source looked like, and who said it.
//
//   node test/review-provenance.js
//
// Two things a shared review needs that a local one never did.
//
// PROVENANCE is evidence about a tree somebody else was standing on. The
// failure it prevents is quiet: Bob reads Alice's comment about a hero
// section, his hero section looks fine, and neither of them ever finds out
// they were looking at different files. So every new review records the branch,
// the commit and — the durable part — a digest of the actual bytes of the
// files it is anchored to.
//
// The rules being checked, in order of how badly getting them wrong would hurt:
//
//   Git is never required. A project with no repository still records file
//   digests, which are the strongest evidence anyway.
//   `head` degrades. A rebase, a squash or a gc makes a SHA unreachable, and
//   nothing about reading a review may depend on it existing.
//   Nothing is backfilled. A review written before this existed has provenance
//   of null, forever. A plausible-looking commit is worse than an admission.
//
// IDENTITY is a UUID and nothing else. Not an email, not a git author, not a
// server's idea of a username. A name is presentation and is allowed to change
// without orphaning anything signed with it. And the ownership rules — your
// own words, an agent's replies, never somebody else's — are checked here
// because they are the only thing an actor is FOR.

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

const {
  provenanceFor,
  sourceStamp,
  containsCommit,
  digestsFor,
  normalizeRemote,
  remoteHint,
  branchOf,
  dirtyOf,
  shaOf,
  git,
} = require('../electron/review/provenance.js');
const {
  displayName,
  uuidv5,
  agentActor,
  legacyAgentActor,
  suggestName,
  reviveActor,
  isActorId,
  mayEdit,
  mayDelete,
  localActor,
  setLocalName,
  readIdentityFile,
  fileFor,
  MAX_NAME,
} = require('../electron/review/actors.js');
const { createReviewStore } = require('../electron/review/store.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-prov-'));

// ── A real repository, because git's answers are the thing being checked ────

const REPO = path.join(home, 'site');
const run = (args, cwd = REPO) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.test',
    },
  });

fs.mkdirSync(path.join(REPO, 'src/pages'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'src/pages/index.astro'), '<h1>Hello</h1>\n');
run(['init', '-q', '-b', 'main']);
run(['config', 'user.name', 'Test Person']);
run(['config', 'user.email', 'test@example.test']);
run(['add', '-A']);
run(['commit', '-q', '-m', 'first']);
const FIRST = run(['rev-parse', 'HEAD']).trim();

// ── A clean tree ────────────────────────────────────────────────────────────

{
  const p = provenanceFor(REPO, ['src/pages/index.astro']);
  check('a git project records its head', p.head === FIRST, `${p.head} vs ${FIRST}`);
  check('and the branch it was on', p.branch === 'main', p.branch);
  check('a clean tree says so', p.dirty === false, String(p.dirty));
  check('and the file is digested', /^sha1:[0-9a-f]{40}$/.test(p.files['src/pages/index.astro'] || ''), JSON.stringify(p.files));
  check('the digest is of the bytes, not the name', provenanceFor(REPO, ['src/pages/index.astro']).files['src/pages/index.astro'] === p.files['src/pages/index.astro']);
}

// ── A dirty tree ────────────────────────────────────────────────────────────

{
  fs.appendFileSync(path.join(REPO, 'src/pages/index.astro'), '<p>more</p>\n');
  const p = provenanceFor(REPO, ['src/pages/index.astro']);
  check('an edited tree is recorded as dirty', p.dirty === true);
  check('and the digest follows the edit rather than the commit', p.files['src/pages/index.astro'] !== undefined);
  const before = p.files['src/pages/index.astro'];
  fs.appendFileSync(path.join(REPO, 'src/pages/index.astro'), '<p>and more</p>\n');
  check('a second edit changes the digest', provenanceFor(REPO, ['src/pages/index.astro']).files['src/pages/index.astro'] !== before);
  // An untracked file counts: a page that exists only in the working tree is a
  // difference between what was reviewed and what the commit holds.
  run(['checkout', '--', 'src/pages/index.astro']);
  check('and a restored tree is clean again', provenanceFor(REPO, []).dirty === false);
  fs.writeFileSync(path.join(REPO, 'untracked.txt'), 'x');
  check('an untracked file is a dirty tree', provenanceFor(REPO, []).dirty === true);
  fs.rmSync(path.join(REPO, 'untracked.txt'));
}

// ── A branch, and a detached head ───────────────────────────────────────────

{
  run(['checkout', '-q', '-b', 'feature-a']);
  fs.writeFileSync(path.join(REPO, 'src/pages/index.astro'), '<h1>Hello there</h1>\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'second']);
  const SECOND = run(['rev-parse', 'HEAD']).trim();
  const onBranch = provenanceFor(REPO, ['src/pages/index.astro']);
  check('a review on another branch records it', onBranch.branch === 'feature-a', onBranch.branch);
  check('and that branch’s head', onBranch.head === SECOND);

  run(['checkout', '-q', '--detach', FIRST]);
  const detached = provenanceFor(REPO, ['src/pages/index.astro']);
  // `rev-parse --abbrev-ref HEAD` answers the literal string "HEAD" on a
  // detached checkout. Recording that as a branch name would file every
  // detached review under one branch called HEAD.
  check('a detached head has no branch', detached.branch === null, String(detached.branch));
  check('but still has a commit', detached.head === FIRST);
  run(['checkout', '-q', 'main']);
}

// ── A missing file ──────────────────────────────────────────────────────────

{
  const p = provenanceFor(REPO, ['src/pages/index.astro', 'src/pages/gone.astro']);
  check('a file that is there is digested', !!p.files['src/pages/index.astro']);
  // No entry rather than a null one: "I hashed nothing" and "there was nothing
  // to hash" are different facts, and conflating them would let a reader
  // compare two absences and call it a match.
  check('a file that is not there gets no entry at all', !('src/pages/gone.astro' in p.files), JSON.stringify(p.files));
}

// ── A project with no repository at all ─────────────────────────────────────

{
  const plain = path.join(home, 'plain');
  fs.mkdirSync(path.join(plain, 'src'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'src/page.astro'), '<main>hi</main>');
  const p = provenanceFor(plain, ['src/page.astro']);
  check('a project with no git has no head', p.head === null);
  check('nor a branch', p.branch === null);
  check('and does not claim to know whether it is dirty', p.dirty === null);
  check('but the file digest still works — which is the durable half', !!p.files['src/page.astro'], JSON.stringify(p.files));
  check('and a stamp from it is all nulls', JSON.stringify(sourceStamp(plain)) === JSON.stringify({ head: null, branch: null, dirty: null }));
}

// ── Digests refuse to leave the project ─────────────────────────────────────

{
  const escaped = digestsFor(REPO, ['../../../etc/hosts', '/etc/hosts', 'src/pages/index.astro']);
  check('a path that climbs out of the project is not digested', !('../../../etc/hosts' in escaped));
  check('nor an absolute one', !('/etc/hosts' in escaped));
  check('and the honest one still is', !!escaped['src/pages/index.astro']);
  const many = digestsFor(REPO, Array.from({ length: 60 }, (_, i) => `src/pages/index.astro?${i}`));
  check('the number of files is bounded', Object.keys(many).length <= 24, String(Object.keys(many).length));
}

// ── Ancestry, and every way it can fail to be knowable ──────────────────────

{
  run(['checkout', '-q', 'main']);
  const mainHead = run(['rev-parse', 'HEAD']).trim();
  check('a commit that is HEAD is present', containsCommit(REPO, mainHead) === 'yes');
  check('an ancestor is present', containsCommit(REPO, FIRST) === 'yes');
  const featureHead = run(['rev-parse', 'feature-a']).trim();
  check('a commit on another branch is not', containsCommit(REPO, featureHead) === 'no', containsCommit(REPO, featureHead));
  // The three ways nobody can say, and all three answer `unknown` rather than
  // a confident `no`. A squash merge makes the original SHA unreachable while
  // the fix is very much present; "you do not have it" there is a lie.
  check('a commit this repository has never seen is unknown', containsCommit(REPO, '0'.repeat(40)) === 'unknown');
  check('so is nonsense', containsCommit(REPO, 'not-a-sha') === 'unknown');
  check('and so is a folder that is not a repository', containsCommit(path.join(home, 'plain'), mainHead) === 'unknown');
  check('and no project at all', containsCommit(null, mainHead) === 'unknown');

  // A shallow clone genuinely cannot answer, and `--is-ancestor` would happily
  // say no past its horizon.
  const shallow = path.join(home, 'shallow');
  try {
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${REPO}`, shallow], { encoding: 'utf8' });
    check('a shallow clone knows it is shallow', git(shallow, ['rev-parse', '--is-shallow-repository']).trim() === 'true');
    check('and refuses to guess at ancestry', containsCommit(shallow, FIRST) === 'unknown', containsCommit(shallow, FIRST));
  } catch (err) {
    check('a shallow clone could be made', false, err.message);
  }
}

// ── Remote hints are hints ──────────────────────────────────────────────────

{
  check('an https remote normalises', normalizeRemote('https://github.com/Owner/Repo.git') === 'github.com/owner/repo');
  check('an ssh remote normalises to the same thing', normalizeRemote('git@github.com:Owner/Repo.git') === 'github.com/owner/repo');
  check('a trailing slash makes no difference', normalizeRemote('https://github.com/owner/repo/') === 'github.com/owner/repo');
  check('a URL with no path is not a repository', normalizeRemote('https://github.com') === null);
  check('and nonsense is null', normalizeRemote('not a url') === null && normalizeRemote(null) === null);
  check('a project with no remote has no hint', remoteHint(REPO) === null, String(remoteHint(REPO)));
  run(['remote', 'add', 'origin', 'git@github.com:Team/Site.git']);
  check('and one with a remote has one', remoteHint(REPO) === 'github.com/team/site', String(remoteHint(REPO)));
}

// ── Small pieces ────────────────────────────────────────────────────────────

{
  check('a sha is recognised', shaOf('  ABC1234  ') === 'abc1234');
  check('a line of prose is not', shaOf('not a sha at all') === null);
  check('a branch name comes back trimmed', typeof branchOf(REPO, git) === 'string');
  check('dirtiness is a boolean or null, never a string', [true, false, null].includes(dirtyOf(REPO, git)));
  check('a git call in a folder that is not a repository answers null', git(path.join(home, 'plain'), ['rev-parse', 'HEAD']) === null);
  check('and a git call with no project answers null', git(null, ['status']) === null);
}

// ── Who said it ─────────────────────────────────────────────────────────────

{
  check('a name is bounded', displayName('x'.repeat(500)).length === MAX_NAME);
  check('a name loses its control characters', displayName(`Ali${String.fromCharCode(10)}ce`) === 'Ali ce');
  check('an empty name falls back', displayName('   ') === 'You' && displayName(null) === 'You');
  check('a real name survives', displayName('Alice Bergström') === 'Alice Bergström');

  check('a derived id is a uuid', isActorId(uuidv5('anything')));
  check('and is stable', uuidv5('x') === uuidv5('x'));
  check('and different names are different actors', uuidv5('x') !== uuidv5('y'));

  const claude = agentActor('Claude');
  check('an agent has an id, a kind and a name', isActorId(claude.id) && claude.kind === 'agent' && claude.displayName === 'Claude');
  // The property the whole design leans on: two installations that have never
  // spoken agree on which actor "Claude" is, so a shared thread can say
  // "Claude resolved this" on a machine Claude has never run on.
  check('the same agent is the same actor everywhere', agentActor('Claude').id === claude.id);
  check('regardless of how it was capitalised', agentActor('claude').id === claude.id);
  check('and a different agent is a different one', agentActor('Codex').id !== claude.id);
  check('an unnamed agent has a name anyway', agentActor(null).displayName === 'AI Agent');
  check('a legacy agent is named for what it is', legacyAgentActor().displayName === 'Agent' && legacyAgentActor().kind === 'agent');

  check('a suggestion prefers the git author', suggestName({ run: git, projectPath: REPO }) === 'Test Person', suggestName({ run: git, projectPath: REPO }));
  // The email is never used. It is the one field of a git identity that is a
  // contact address.
  check('and never the git email', !/test@example\.test/.test(suggestName({ run: git, projectPath: REPO })));
  check('with no git it still suggests something', typeof suggestName() === 'string' && suggestName().length > 0);

  check('an actor with no id is not an actor', reviveActor({ kind: 'human', displayName: 'x' }) === null);
  check('an actor with a bad id is not an actor', reviveActor({ id: 'nope', kind: 'human' }) === null);
  check('an unknown kind falls back to human', reviveActor({ id: uuidv5('k'), kind: 'ghost' }).kind === 'human');
}

// ── The local person, made once ─────────────────────────────────────────────

{
  const data = path.join(home, 'userdata');
  fs.mkdirSync(data, { recursive: true });
  check('no identity file exists until one is needed', !fs.existsSync(fileFor(data)));
  const first = localActor(data, { suggest: 'Alice' });
  check('an identity is made on first need', isActorId(first.id) && first.displayName === 'Alice');
  check('and is written down', fs.existsSync(fileFor(data)));
  check('the same identity comes back next time', localActor(data).id === first.id);
  check('and is not remade by a different suggestion', localActor(data, { suggest: 'Somebody Else' }).displayName === 'Alice');

  const renamed = setLocalName(data, 'Alice B');
  check('a person can be renamed', renamed.displayName === 'Alice B');
  // The id is the identity. If renaming moved it, every message already signed
  // with it would stop being theirs.
  check('and the id does not move', renamed.id === first.id);
  check('the rename survives a reread', localActor(data).displayName === 'Alice B');
  check('the identity file is only readable by this user', (fs.statSync(fileFor(data)).mode & 0o077) === 0, (fs.statSync(fileFor(data)).mode & 0o777).toString(8));
  check('and holds nothing but identity so far', Object.keys(readIdentityFile(data)).every((k) => ['version', 'actor', 'actorCreatedAt'].includes(k)), JSON.stringify(Object.keys(readIdentityFile(data))));
}

// ── Ownership ───────────────────────────────────────────────────────────────

{
  const alice = { id: uuidv5('alice'), kind: 'human', displayName: 'Alice' };
  const bob = { id: uuidv5('bob'), kind: 'human', displayName: 'Bob' };
  const claude = agentActor('Claude');
  const msg = (actor) => ({ actorId: actor.id, actorKind: actor.kind });

  check('you can reword your own words', mayEdit(alice, msg(alice)));
  check('but not somebody else’s', !mayEdit(bob, msg(alice)));
  check('and not an agent’s', !mayEdit(alice, msg(claude)));
  check('and an agent can reword nothing', !mayEdit(claude, msg(claude)) && !mayEdit(claude, msg(alice)));

  check('you can delete your own words', mayDelete(alice, msg(alice)));
  check('and an agent’s reply', mayDelete(alice, msg(claude)));
  check('but not another person’s', !mayDelete(bob, msg(alice)));
  check('and an agent can delete nothing', !mayDelete(claude, msg(alice)) && !mayDelete(claude, msg(claude)));
}

// ── And all of it, through the ledger ───────────────────────────────────────

{
  const alice = { id: uuidv5('ledger-alice'), kind: 'human', displayName: 'Alice' };
  const bob = { id: uuidv5('ledger-bob'), kind: 'human', displayName: 'Bob' };
  const claude = agentActor('Claude');
  const file = path.join(home, 'ledger.json');
  const anchor = { keys: ['src/pages/index.astro#0.1'], page: { route: '/', file: 'src/pages/index.astro' } };
  const store = createReviewStore({ file, projectPath: REPO, actor: alice });

  const made = store.apply({ action: 'create', message: 'The CTA is too close.', anchor });
  check('a new review records provenance', !!made.thread.provenance, JSON.stringify(made.thread.provenance));
  check('with the branch it was written on', made.thread.provenance.branch === 'main', made.thread.provenance.branch);
  check('and a digest of the file it is about', !!made.thread.provenance.files['src/pages/index.astro']);
  check('and the person who wrote it', made.thread.author.actorId === alice.id && made.thread.author.actorName === 'Alice');

  const agentReply = store.apply({ action: 'reply', threadId: made.thread.id, message: 'Reduced the padding.', actor: claude });
  check('an agent’s reply is signed with the agent', agentReply.thread.messages[1].actorName === 'Claude');
  check('and is marked as an agent', agentReply.thread.messages[1].authorType === 'agent');

  const resolved = store.apply({ action: 'resolve', threadId: made.thread.id, actor: claude });
  check('a resolution records where the source stood', !!resolved.thread.resolvedAtSource, JSON.stringify(resolved.thread.resolvedAtSource));
  check('and who did it', resolved.thread.resolvedBy.actorName === 'Claude');

  // Ownership, at the door this time.
  const mine = store.editMessage(made.thread.id, made.thread.messages[0].id, 'The CTA is much too close.', alice);
  check('Alice can reword her own message', mine.ok === true, JSON.stringify(mine));
  const theirs = store.editMessage(made.thread.id, made.thread.messages[0].id, 'I never said that', bob);
  check('Bob cannot reword Alice’s', theirs.ok === false && theirs.code === 'not_yours', JSON.stringify(theirs));
  check('and the words are unchanged', store.get(made.thread.id).messages[0].body === 'The CTA is much too close.');
  const agentTried = store.editMessage(made.thread.id, made.thread.messages[0].id, 'rewritten', claude);
  check('and an agent cannot either', agentTried.ok === false && agentTried.code === 'not_yours');

  const dropAgent = store.removeMessage(made.thread.id, agentReply.thread.messages[1].id, alice);
  check('Alice can prune an agent’s reply', dropAgent.ok === true, JSON.stringify(dropAgent));
  const bobsDelete = store.remove(made.thread.id, bob);
  check('Bob cannot delete Alice’s review', bobsDelete.ok === false && bobsDelete.code === 'not_yours', JSON.stringify(bobsDelete));
  const agentDelete = store.remove(made.thread.id, claude);
  check('and an agent cannot delete a review at all', agentDelete.ok === false && agentDelete.code === 'not_yours');
  check('Alice can delete her own', store.remove(made.thread.id, alice).ok === true);
}

// ── Old reviews are never given provenance they never had ───────────────────

{
  const file = path.join(home, 'legacy.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      nextNumber: 2,
      threads: [
        {
          id: 'rt_old',
          number: 1,
          status: 'open',
          anchor: { keys: ['src/pages/index.astro#0.1'] },
          creationContext: { branch: 'some-old-branch', tag: 'h1' },
          messages: [{ id: 'm1', authorType: 'human', body: 'from before all this', createdAt: 10 }],
          createdAt: 10,
          updatedAt: 10,
        },
      ],
    }),
    'utf8'
  );
  const alice = { id: uuidv5('legacy-alice'), kind: 'human', displayName: 'Alice' };
  const store = createReviewStore({ file, projectPath: REPO, actor: alice });
  const old = store.all()[0];
  check('an old review survives the move to events', !!old && old.messages[0].body === 'from before all this');
  // The rule: nobody knows what the tree looked like on the day it was
  // written, and today's HEAD is not an answer to that question.
  check('and is given no provenance at all', old.provenance === null, JSON.stringify(old.provenance));
  check('it is marked as coming from before authorship was recorded', old.author.legacy === true);
  check('and attributed to this installation’s own person', old.author.actorId === alice.id);
  check('the branch it recorded at the time is still readable', old.creationContext.branch === 'some-old-branch');
  // A review it has never looked at is not "attached" — but this one carried a
  // recorded state from the old file, which is this machine's own finding.
  check('and its old anchor state came across', old.anchorState === 'attached', old.anchorState);

  // A new review in the same ledger DOES get provenance: nothing about the
  // migration turns the feature off.
  const fresh = store.apply({ action: 'create', message: 'a new one', anchor: { keys: ['src/pages/index.astro#0.2'] } });
  check('a new review in a migrated ledger still records provenance', !!fresh.thread.provenance?.head);
}

fs.rmSync(home, { recursive: true, force: true });

if (failures.length) {
  console.error(`\nreview-provenance: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`review-provenance: ${checked} passed  [git as evidence, a uuid as identity]`);
