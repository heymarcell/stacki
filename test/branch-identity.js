// Which branch a ref was minted against, and whether that is the branch.
//
//   node test/branch-identity.js
//
// A ref records the branch it was minted on. That is not decoration: it is part
// of what makes a ref stale — a handle taken against one tree and used against
// another is a handle to something that may no longer be there, and the whole
// point of a ref is that a write through it is refused rather than landing
// somewhere unintended.
//
// It recorded the wrong branch. `ctx.branch` came from the renderer's published
// payload, and App.jsx reads git ONCE, when the project opens — so "the branch
// as of the last render" was in practice "the branch as of project open".
// Measured on the candidate before this fix, switching branch through the Agent
// API's own git surface:
//
//   HEAD on disk                    beta
//   git.info                        beta      <- the truth was available
//   project.info                    alpha     <- wrong
//   a ref minted 2.2s AFTER          alpha     <- wrong
//
// Two consecutive calls in one process answering `beta` and `alpha` about the
// same question. And a write through a ref minted while HEAD was `beta` but
// stamped `alpha` succeeded, because the field that would have refused it held
// the wrong value.
//
// So the branch comes from git, through `branchOf` — the reader that already
// ships, already refuses to call a detached HEAD a branch, and is already
// covered by test/review-provenance.js. Main caches it for 1500 ms, which is
// the TTL electron/review/checkout.js already chose for the same question, and
// every channel that can move HEAD drops the cache when it returns.
//
// WHAT IS ASSERTED HERE is the behaviour, not the plumbing: after a checkout,
// a newly minted ref carries the new branch, and every surface that reports a
// branch agrees with `git rev-parse`. The plumbing is how; `git` is the oracle.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const H = require('./agent-harness.js');

const short = (x, n = 240) => JSON.stringify(x ?? null).slice(0, n);

/**
 * The branch a ref was minted against.
 *
 * A ref is `stacki:<base64url payload>.<signature>`; the signature is the last
 * dot-segment. Reading the payload is fair game for a test — it is asserting
 * what the product recorded, which is the thing that was wrong.
 */
function branchIn(ref) {
  try {
    const rest = String(ref).replace(/^stacki:/, '');
    const body = rest.slice(0, rest.lastIndexOf('.'));
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')).d?.branch ?? null;
  } catch {
    return '(unreadable)';
  }
}

(async () => {
  const root = H.makeProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-branch-home-'));
  // A throwaway global config, so this machine's identity, hooks, templates and
  // `init.defaultBranch` cannot reach the fixture.
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
  const headNow = () => git('rev-parse', '--abbrev-ref', 'HEAD').trim();

  git('init', '-q', '-b', 'alpha');
  git('config', 'user.email', 'branch@example.invalid');
  git('config', 'user.name', 'Branch Identity Suite');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  // DELIBERATELY IDENTICAL CONTENT on both branches. If the two trees differed,
  // a write through a stale ref would be refused by the DIGEST guard and this
  // suite would pass without the branch field working at all — which is exactly
  // how the defect survived. With identical bytes the digest has nothing to say
  // and the branch is the only thing that can answer.
  git('branch', 'beta');

  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(500);

  // ── before any switch ─────────────────────────────────────────────────────

  check('the fixture starts on alpha', headNow() === 'alpha', headNow());

  const first = await run('target', 'read');
  const alphaRef = first.target?.ref;
  check('a read hands back a ref', !!alphaRef, short(first));
  check('and it is stamped with the branch that is checked out', branchIn(alphaRef) === 'alpha', String(branchIn(alphaRef)));
  check('project.info agrees with git', (await run('project', 'info')).project?.branch === 'alpha', short((await run('project', 'info')).project));
  check('and git.info agrees too', (await run('git', 'info')).branch === 'alpha', short(await run('git', 'info')));

  // ── the switch, through Stacki's own git surface ──────────────────────────

  const co = await run('git', 'checkout', { branch: 'beta' });
  check('the checkout succeeds', co.ok === true, short(co));
  check('and git says so', headNow() === 'beta', headNow());
  await H.settle(800);

  // THE ASSERTION THE DEFECT WAS. Not "eventually", not "after a rescan" — the
  // next call.
  const second = await run('target', 'read');
  const betaRef = second.target?.ref;
  check('a ref minted AFTER the switch carries the new branch', branchIn(betaRef) === 'beta', String(branchIn(betaRef)));
  check('and the ref minted before it still says the old one', branchIn(alphaRef) === 'alpha', String(branchIn(alphaRef)));

  // Every surface that reports a branch reports the same one.
  {
    const info = await run('project', 'info');
    const gitInfo = await run('git', 'info');
    check('project.info tracks the checkout', info.project?.branch === 'beta', short(info.project));
    check('git.info tracks the checkout', gitInfo.branch === 'beta', short(gitInfo));
    check('and the two never disagree', info.project?.branch === gitInfo.branch, `${info.project?.branch} vs ${gitInfo.branch}`);
    check('and both agree with git itself', info.project?.branch === headNow(), `${info.project?.branch} vs ${headNow()}`);
  }

  // ── and back again ────────────────────────────────────────────────────────
  //
  // One switch could be a cache that expired. Two, in opposite directions, with
  // a read between them, is the mechanism.

  {
    const back = await run('git', 'checkout', { branch: 'alpha' });
    check('switching back succeeds', back.ok === true, short(back));
    await H.settle(400);
    const third = await run('target', 'read');
    check('and a ref minted now says alpha again', branchIn(third.target?.ref) === 'alpha', String(branchIn(third.target?.ref)));
    check('and project.info follows', (await run('project', 'info')).project?.branch === 'alpha', short((await run('project', 'info')).project));
  }

  // ── a branch made and switched to in one step ─────────────────────────────

  {
    const made = await run('git', 'checkout', { branch: 'gamma', create: true });
    check('a new branch can be created and checked out', made.ok === true, short(made));
    await H.settle(400);
    check('git is on it', headNow() === 'gamma', headNow());
    const ref = (await run('target', 'read')).target?.ref;
    check('and a ref minted now carries it', branchIn(ref) === 'gamma', String(branchIn(ref)));
    await run('git', 'checkout', { branch: 'alpha' });
    await H.settle(300);
  }

  // ── a detached HEAD is not a branch called HEAD ───────────────────────────
  //
  // `rev-parse --abbrev-ref HEAD` says "HEAD" when nothing is checked out by
  // name, and recording that as a branch would make every detached ref compare
  // equal to every other one. `branchOf` refuses to, and this is what says so.

  {
    const sha = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', '--detach', sha);
    check('the fixture is detached', headNow() === 'HEAD', headNow());
    await H.settle(300);
    const ref = (await run('target', 'read')).target?.ref;
    check('a ref minted while detached records no branch', branchIn(ref) === null, String(branchIn(ref)));
    check('and project.info says so too', (await run('project', 'info')).project?.branch === null, short((await run('project', 'info')).project));
    git('checkout', '-q', 'alpha');
    await H.settle(300);
    check('and it comes back when a branch is checked out again', branchIn((await run('target', 'read')).target?.ref) === 'alpha');
  }

  // ── a checkout made OUTSIDE Stacki ────────────────────────────────────────
  //
  // The cache exists so that the branch is not re-read by spawning git on the
  // hot path of every operation, and its whole risk is a switch Stacki did not
  // make. Bounded: within the TTL the answer may be the old one, and after it
  // the answer is right — which is what "cached for 1500 ms" means and what
  // this asserts rather than assumes.

  {
    git('checkout', '-q', 'beta');
    check('git is on beta, and Stacki was not told', headNow() === 'beta', headNow());
    // Past the TTL main uses. The harness reads git with no cache at all, so
    // this also passes there; what it protects against is a cache with no
    // expiry, which would answer `alpha` for the rest of the session.
    await H.settle(1800);
    const ref = (await run('target', 'read')).target?.ref;
    check('a ref minted after the TTL carries the branch git is on', branchIn(ref) === 'beta', String(branchIn(ref)));
    git('checkout', '-q', 'alpha');
    await H.settle(1800);
  }

  H.removeProject(root);
  fs.rmSync(home, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\nbranch-identity: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`branch-identity: ${checked} passed  [a ref records the branch that is checked out, not the one that was]`);
  process.exit(0);
})().catch((err) => {
  console.error('branch-identity: threw\n', err);
  process.exit(1);
});
