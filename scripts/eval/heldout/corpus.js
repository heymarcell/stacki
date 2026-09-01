// The held-out projects, and the proof they are the ones the manifest names.
//
// WHY THESE ARE NOT WRITTEN HERE. The Phase-B fixture (test/agent-harness.js)
// was built alongside the surface it measures: it has a `Hero`, a `Card`, a
// `--brand` and two collections because the tasks needed them. Every number
// measured against it is a number measured against a project that was designed
// to be easy for the thing under test. That is fine for a regression fixture and
// worthless for a held-out one.
//
// So the corpus is upstream Astro's own examples, pinned to a commit that
// predates this phase, hashed, and never edited. They were not written to suit
// Stacki, they were not written to suit an evaluation, and nobody here chose
// what is in them.
//
// WHAT THIS DOES NOT DO. It does not clone, fork, push, open a pull request or
// an issue anywhere. It fetches one immutable tarball over HTTPS, extracts four
// directories out of it, and installs their declared dependencies into an owned
// copy. Upstream never learns it happened.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const MANIFEST = require('./manifest.json');

/** Where a materialised corpus lives, so a second run does not pay for it again. */
const CACHE =
  process.env.STACKI_HELDOUT_CACHE ||
  path.join(os.tmpdir(), `stacki-heldout-${MANIFEST.corpus.sourceCommit.slice(0, 12)}`);

// WHAT IS NOT THE PROJECT.
//
// Everything here is written by something other than upstream: npm writes
// `package-lock.json` and `node_modules` on install, Astro writes `.astro` and
// `dist` on a run, the packaged app writes `.stacki-automation` into whatever it
// is allowed to open, and macOS writes `.DS_Store` wherever it likes.
//
// None of them exist in the pinned tarball, and every one of them appears the
// first time the corpus is used. A hash that counted them would verify once and
// then fail for the rest of time, which is the same as not verifying at all.
const NOT_THE_PROJECT = new Set([
  'node_modules',
  '.git',
  '.astro',
  'dist',
  'package-lock.json',
  '.stacki-automation',
  '.DS_Store',
]);

/** Every file under `dir` that came from upstream, relative and sorted. */
function walk(dir, rel = '') {
  const here = path.join(dir, rel);
  let entries;
  try {
    entries = fs.readdirSync(here, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .flatMap((e) => {
      if (NOT_THE_PROJECT.has(e.name)) return [];
      const next = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? walk(dir, next) : [next];
    })
    .sort();
}

/**
 * The identity of a project's *content*, independent of where it was unpacked
 * and of whatever npm later writes into it.
 *
 * Path and bytes both go into the hash: two projects that differ only by a
 * renamed file are two different projects, and a hash over bytes alone would
 * call them the same.
 */
function contentHash(dir) {
  const files = walk(dir);
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    h.update(fs.readFileSync(path.join(dir, f)));
    h.update('\0');
  }
  return { hash: h.digest('hex'), fileCount: files.length };
}

/** The manifest's own identity, so a report can say which corpus produced it. */
function manifestHash() {
  return crypto.createHash('sha256').update(JSON.stringify(MANIFEST)).digest('hex');
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u, depth = 0) => {
      if (depth > 5) return reject(new Error(`too many redirects fetching ${url}`));
      https
        .get(u, { headers: { 'user-agent': 'stacki-heldout-corpus' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return get(new URL(res.headers.location, u).href, depth + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`${u} answered ${res.statusCode}`));
          }
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve()));
          out.on('error', reject);
        })
        .on('error', reject);
    };
    get(url);
  });
}

/**
 * Put the corpus on disk and prove it is the corpus.
 *
 * A mismatch throws. It is the whole point: an evaluation whose projects
 * drifted is an evaluation of nothing, and it would drift silently.
 */
async function materialise({ log = () => {}, install = true } = {}) {
  const sha = MANIFEST.corpus.sourceCommit;
  fs.mkdirSync(CACHE, { recursive: true });

  const need = MANIFEST.corpus.projects.filter((p) => !fs.existsSync(path.join(CACHE, p.id, 'package.json')));
  if (need.length) {
    const tarball = path.join(CACHE, 'source.tar.gz');
    log(`fetching ${MANIFEST.corpus.source} at ${sha.slice(0, 12)}`);
    await download(`https://codeload.github.com/${MANIFEST.corpus.source}/tar.gz/${sha}`, tarball);
    const stage = path.join(CACHE, '.stage');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '-C', stage, ...MANIFEST.corpus.projects.map((p) => `${path.basename(MANIFEST.corpus.source)}-${sha}/${p.upstreamPath}`)], {
      stdio: 'pipe',
    });
    for (const p of MANIFEST.corpus.projects) {
      const from = path.join(stage, `${path.basename(MANIFEST.corpus.source)}-${sha}`, p.upstreamPath);
      const to = path.join(CACHE, p.id);
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true });
    }
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(tarball, { force: true });
  }

  const projects = [];
  for (const p of MANIFEST.corpus.projects) {
    const root = path.join(CACHE, p.id);
    const seen = contentHash(root);
    if (seen.hash !== p.contentHash) {
      throw new Error(
        `${p.id} is not the project the manifest names.\n` +
          `  manifest: ${p.contentHash} (${p.fileCount} files)\n` +
          `  on disk:  ${seen.hash} (${seen.fileCount} files)\n` +
          'Delete the corpus cache and let it materialise again.'
      );
    }
    if (install && !fs.existsSync(path.join(root, 'node_modules', 'astro', 'package.json'))) {
      log(`installing ${p.id} dependencies (once)`);
      execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'pipe' });
    }
    let astro = null;
    try {
      astro = require(path.join(root, 'node_modules', 'astro', 'package.json')).version;
    } catch {
      /* not installed, which `install: false` callers expect */
    }
    projects.push({ ...p, root, astro, verified: seen.hash });
  }
  return { cache: CACHE, sourceCommit: sha, manifestHash: manifestHash(), projects };
}

/** One project by id, materialised. */
async function project(id, opts) {
  const { projects } = await materialise(opts);
  const found = projects.find((p) => p.id === id);
  if (!found) throw new Error(`no held-out project called ${id}; have ${projects.map((p) => p.id).join(', ')}`);
  return found;
}

/**
 * A disposable copy of a held-out project.
 *
 * Every trial that WRITES must work in one of these. The cached corpus is the
 * reference: if a trial edited it, the next trial would start from the last
 * one's changes and the hash check above would start failing for a reason that
 * has nothing to do with drift. `node_modules` is cloned rather than copied
 * where the filesystem allows it, so a copy costs a moment and no disk.
 */
function checkout(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  try {
    execFileSync('cp', ['-Rc', from, to], { stdio: 'pipe' });
  } catch {
    fs.cpSync(from, to, { recursive: true });
  }
  return to;
}

module.exports = { MANIFEST, CACHE, materialise, project, checkout, contentHash, manifestHash, walk };
