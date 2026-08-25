// The Agent API's contract: identity, permission, paths, and the tool surface.
//
//   node test/agent-api.js
//
// Four things here fail silently and expensively, which is why each of them
// gets a section rather than a check:
//
//   A ref. It names an editor object, and a ref that resolves when it should
//   not is an agent editing the wrong node with total confidence. Forged,
//   expired, from another project, from a previous opening of this one — every
//   one of those has to be a refusal, and the refusal has to say which.
//
//   A permission. The server writes now. The gate is in the main process and
//   it is checked before dispatch; an operation that could be reached without
//   passing it would make the setting decoration.
//
//   A path. Every path argument is a client's string. `..`, an absolute path,
//   a symlink out of the project and a null byte are all the same bug with
//   four spellings.
//
//   The surface itself. Thirteen tools with schemas a strict client validates
//   against — an action whose arguments are wrong at the protocol level is a
//   sentence from the SDK; an action missing from the registry is unreachable
//   however well it is spelled.
//
// The behaviour — does an edit actually land on the undo stack, does a stale
// write get refused against a real file — is next door in agent-acceptance.js,
// which drives the whole app.

const fs = require('fs');
const os = require('os');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const refs = require('../electron/mcp/agent/refs.js');
const permissions = require('../electron/mcp/agent/permissions.js');
const registry = require('../electron/mcp/agent/registry.js');
const { resolveInProject, relativeTo } = require('../electron/mcp/agent/paths.js');
const { digestOf, digestOfFile, checkDigest, checkRevision } = require('../electron/mcp/agent/digest.js');
const { patchBetween } = require('../electron/mcp/agent/patch.js');
const { runMain } = require('../electron/mcp/agent/domains.js');
const { createAgentApi } = require('../electron/mcp/agent/index.js');
const agentTools = require('../electron/mcp/agentTools.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-agent-api-')));
const OTHER = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-agent-other-')));

// ── Refs ─────────────────────────────────────────────────────────────────────

{
  const anchor = { keys: ['src/pages/index.astro#0.1'], fingerprint: { tag: 'div' }, page: { file: 'src/pages/index.astro' } };
  const ref = refs.mint('node', anchor, { projectRoot: ROOT });

  check('a ref is opaque', /^stacki:/.test(ref) && !ref.includes('index.astro'), ref.slice(0, 60));
  check('and carries no filesystem path in the clear', !ref.includes(ROOT));

  const read = refs.parse(ref, { projectRoot: ROOT });
  check('a ref Stacki minted reads back', read.ok === true, read.message);
  check('with what it was minted about', read.ok && read.data.keys[0] === anchor.keys[0]);
  check('and its kind', read.ok && read.kind === 'node');
  check('and is writable unless it was withheld', read.ok && read.writable === true);

  const held = refs.parse(refs.mint('node', anchor, { projectRoot: ROOT, writable: false }), { projectRoot: ROOT });
  check('a ref issued read-only says so', held.ok && held.writable === false);

  // Forgery. The signature is the whole of it: change a byte of the payload and
  // the ref is not a ref, whatever it decodes to.
  const [body, mac] = ref.slice('stacki:'.length).split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  decoded.d.keys = ['../../../../etc/passwd#0'];
  const forged = `stacki:${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${mac}`;
  const forgedRead = refs.parse(forged, { projectRoot: ROOT });
  check('a ref whose payload was rewritten is refused', forgedRead.ok === false && forgedRead.code === 'bad_ref', forgedRead.code);

  const madeUp = 'stacki:' + Buffer.from(JSON.stringify({ v: 1, k: 'source', p: 'x', s: 'y', d: { path: '/etc/passwd' } })).toString('base64url') + '.aaaaaaaaaaaaaaaaaaaaaaaaaaa';
  check('a ref nobody minted is refused', refs.parse(madeUp, { projectRoot: ROOT }).code === 'bad_ref');
  check('and so is a string that is not one at all', refs.parse('src/pages/index.astro', { projectRoot: ROOT }).code === 'bad_ref');
  check('and an empty one', refs.parse('', { projectRoot: ROOT }).code === 'bad_ref');

  check(
    'a ref for another project does not resolve here',
    refs.parse(ref, { projectRoot: OTHER }).code === 'wrong_project',
    refs.parse(ref, { projectRoot: OTHER }).code
  );
  check(
    'and a ref for a node is not a ref for a file',
    refs.parse(ref, { projectRoot: ROOT, kind: 'source' }).code === 'wrong_kind'
  );

  // Time and session. Both make a ref stop working, and both say so as
  // `stale_ref` — which is the one thing an agent can act on: read again.
  const old = refs.mint('node', anchor, { projectRoot: ROOT, ttlMs: 1 });
  check('an expired ref is stale', refs.parse(old, { projectRoot: ROOT, now: () => Date.now() + 1000 }).code === 'stale_ref');

  refs.rotate();
  const afterReopen = refs.parse(ref, { projectRoot: ROOT });
  check('reopening a project invalidates every ref about the last one', afterReopen.code === 'stale_ref', afterReopen.code);
  check('and a ref minted after it works again', refs.parse(refs.mint('node', anchor, { projectRoot: ROOT }), { projectRoot: ROOT }).ok);

  check('every kind a ref can name is declared', refs.KINDS.includes('node') && refs.KINDS.includes('source'));
  let threw = false;
  try {
    refs.mint('whatever', {}, { projectRoot: ROOT });
  } catch {
    threw = true;
  }
  check('and minting an undeclared one is a mistake, not a ref', threw);
}

// ── Permissions ──────────────────────────────────────────────────────────────

{
  check('the default is the conservative one', permissions.DEFAULT_MODE === 'inspect');
  check('an unrecognised mode is the conservative one too', permissions.normalizeMode('root') === 'inspect');
  check('and so is a missing one', permissions.normalizeMode(undefined) === 'inspect');

  const table = [
    ['inspect', 'read', true],
    ['inspect', 'write', false],
    ['inspect', 'high', false],
    ['edit', 'read', true],
    ['edit', 'write', true],
    ['edit', 'high', false],
    ['full', 'read', true],
    ['full', 'write', true],
    ['full', 'high', true],
  ];
  for (const [mode, risk, allowed] of table) {
    check(`${mode} ${allowed ? 'may' : 'may not'} run a ${risk} operation`, permissions.allows(mode, risk) === allowed);
  }

  let mode = 'inspect';
  const gate = permissions.createGate(() => mode);
  const denied = gate.check('target.set_text', 'write');
  check('a refusal names the operation', denied.operation === 'target.set_text');
  check('and the level it would need', denied.requires === 'edit');
  check('and says nothing was changed', /Nothing was changed/.test(denied.message));
  check('and where the person changes it', /AI connection/.test(denied.message));
  mode = 'edit';
  check('the gate is read every time, not captured', gate.check('target.set_text', 'write') === null);
  check('and still refuses what edit may not do', gate.check('git.push', 'high')?.code === 'permission_denied');
}

// ── The control the person actually uses ─────────────────────────────────────
//
// A gate nobody can find is a gate that is always on its default. So: the three
// levels are in the window, they are the three the main process enforces, the
// renderer carries the choice rather than the authority, and no tool can reach
// the setting.

{
  const dialog = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'McpDialog.jsx'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

  for (const mode of permissions.MODES) {
    check(`the window offers "${mode}"`, new RegExp(`key: '${mode}'`).test(dialog), 'a level nobody can choose is a level nobody has');
  }
  // The ACCESS table specifically — the CLIENTS list above it in that file has
  // the same shape and is about which agent you are configuring, not what it
  // may do.
  const accessTable = dialog.slice(dialog.indexOf('const ACCESS = ['), dialog.indexOf('export default function McpDialog'));
  const offered = [...accessTable.matchAll(/key: '([a-z]+)'/g)].map((m) => m[1]);
  check('and offers no level the main process does not know', offered.length > 0 && offered.every((k) => permissions.MODES.includes(k)), offered.join(', '));
  check('and says what each one means', permissions.MODES.every((m) => new RegExp(`key: '${m}'[\\s\\S]{0,200}blurb:`).test(dialog)));
  check('and reads the level from the main process rather than remembering one', /window\.avb\s*\n?\s*\.settings\(\)/.test(dialog));
  check('and shows what it actually settled on', /result\?\.agentMode/.test(dialog));

  check('the bridge carries the choice', /setAgentMode: invoke\('settings:setAgentMode'\)/.test(preload));
  check('and the main process is where it is stored', /handle\('settings:setAgentMode'/.test(main));
  check('and an unrecognised one is normalized rather than trusted', /agentPermissions\.normalizeMode\(mode\)/.test(main));
  check('and an existing installation keeps the cautious default', /agentMode: 'inspect'/.test(main));

  check(
    'and no MCP tool can set it',
    !/settings:setAgentMode/.test(fs.readFileSync(path.join(__dirname, '..', 'electron', 'mcp', 'agent', 'domains.js'), 'utf8'))
  );
}

// ── Coverage ─────────────────────────────────────────────────────────────────
//
// The inventory this feature started from: every project-semantic thing Stacki
// can do is either exposed or written down as deliberately not. A capability in
// neither table is the failure mode that inventory existed to prevent.

{
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const registered = [...mainSource.matchAll(/^handle\('([^']+)'/gm)].map((m) => m[1]);
  check('main registers its handlers through the recorder', registered.length > 100, `${registered.length}`);

  const exposed = registry.channels();
  const excluded = registry.excludedChannels();
  const unaccounted = registered.filter((channel) => !exposed.has(channel) && !excluded.has(channel));
  check(
    'every IPC handler is exposed or explicitly excluded',
    unaccounted.length === 0,
    unaccounted.length ? `unaccounted for: ${unaccounted.join(', ')}` : ''
  );

  // And the other direction: an exclusion naming a channel that no longer
  // exists is a note about a capability Stacki does not have, which reads as a
  // deliberate decision and is nothing of the kind.
  const stale = [...excluded].filter((channel) => !registered.includes(channel) && !channel.startsWith('reviews:') && !channel.startsWith('mcp:') && !channel.startsWith('terminal:'));
  check('and no exclusion names a handler that is gone', stale.length === 0, stale.join(', '));
  check('every exclusion says why', registry.EXCLUDED.every((e) => e.why && e.reason && e.reason.length > 40));
  check('and every one names at least one channel', registry.EXCLUDED.every((e) => Array.isArray(e.channels) && e.channels.length));
  check(
    'the exclusions name the four kinds of reason and no others',
    registry.EXCLUDED.every((e) => ['human-only', 'unsafe', 'redundant', 'exposed elsewhere'].includes(e.why)),
    [...new Set(registry.EXCLUDED.map((e) => e.why))].join(', ')
  );

  const all = registry.list();
  check('every operation has a risk', all.every((op) => permissions.RISKS.includes(op.risk)));
  check('every operation says where it runs', all.every((op) => ['renderer', 'main', 'local'].includes(op.via)));
  check('every operation has a one-line summary', all.every((op) => op.summary && op.summary.length > 10));
  check(
    'every main-process operation names the handler it reuses',
    all.filter((op) => op.via === 'main').every((op) => !!op.channel || (op.direct && op.uses?.length)),
    all
      .filter((op) => op.via === 'main' && !op.channel && !(op.direct && op.uses?.length))
      .map((op) => `${op.domain}.${op.action}`)
      .join(', ')
  );

  // The classification that matters most: nothing that deletes, rewrites a
  // working tree or talks to a network may be reachable at the ordinary
  // editing level.
  const mustBeHigh = [
    ['git', 'commit'], ['git', 'checkout'], ['git', 'merge'], ['git', 'push'], ['git', 'publish'],
    ['git', 'restore_file'], ['git', 'restore_project'], ['git', 'delete_branch'], ['git', 'resolve_merge'],
    ['git', 'park'], ['git', 'unpark'], ['git', 'init'],
    ['page', 'delete'], ['page', 'folder_delete'], ['asset', 'delete'], ['content', 'cms_delete'],
    ['project', 'install'], ['style', 'remove_section'],
  ];
  for (const [domain, action] of mustBeHigh) {
    const op = registry.find(domain, action);
    check(`${domain}.${action} is a full-control operation`, op?.risk === 'high', op ? op.risk : 'missing');
  }

  const mustBeRead = [
    ['target', 'read'], ['target', 'select'], ['target', 'enter'], ['style', 'read'], ['page', 'list'],
    ['content', 'entries'], ['asset', 'list'], ['git', 'log'], ['git', 'status'], ['project', 'scan'],
    ['source', 'read'],
  ];
  for (const [domain, action] of mustBeRead) {
    check(`${domain}.${action} changes nothing`, registry.find(domain, action)?.risk === 'read');
  }

  check('there is no action for a shell', !registry.list().some((op) => /shell|terminal|exec|command/i.test(op.action)));
  check('and none for review administration', !registry.list().some((op) => /workspace|invite|identity/i.test(op.action)));
}

// ── The generated table ──────────────────────────────────────────────────────
//
// The coverage document is the answer to "was this considered". A hand-written
// one answers it wrongly the first time somebody adds an operation, so it comes
// out of the registry — and this is what stops it drifting.

{
  const { execFileSync } = require('node:child_process');
  let up = true;
  let why = '';
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'agent-api-coverage.js'), '--check'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    up = false;
    why = String(err.stderr || err.message).trim();
  }
  check('the coverage table matches the registry', up, why);
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'agent-api-coverage.md'), 'utf8');
  check('and lists every domain', registry.DOMAINS.every((d) => doc.includes(`## ${d}`)));
  check('and every exclusion', registry.EXCLUDED.every((e) => doc.includes(`\`${e.channels[0]}\``)));
  const design = fs.readFileSync(path.join(__dirname, '..', 'docs', 'agent-api.md'), 'utf8');
  check('and the design notes say what a ref is', /StackiRef/.test(design));
  check('and how a stale write is refused', /stale_target/.test(design));
  check('and what the permission modes are', permissions.MODES.every((m) => new RegExp(m, 'i').test(design)));
  check('and what is kept human-only', /Human-only, and why/.test(design));
  check('and what the known limits are', /Known limits/.test(design));
}

// ── Paths ────────────────────────────────────────────────────────────────────

{
  fs.mkdirSync(path.join(ROOT, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'src', 'pages', 'index.astro'), '<p>hi</p>', 'utf8');

  const good = resolveInProject(ROOT, 'src/pages/index.astro');
  check('a project-relative path resolves', good.ok && good.rel === 'src/pages/index.astro', good.message);
  check('and comes back posix-spelled and relative', good.ok && !path.isAbsolute(good.rel));

  const refusals = [
    ['an absolute path', '/etc/passwd', 'outside_project'],
    ['a windows absolute path', 'C:\\Windows\\System32\\config', 'outside_project'],
    ['a parent traversal', '../../../etc/passwd', 'outside_project'],
    ['a traversal buried in the middle', 'src/pages/../../../etc/passwd', 'outside_project'],
    ['a traversal to the project’s own parent', '..', 'outside_project'],
    ['a null byte', 'src/pages/index.astro\u0000.png', 'bad_path'],
    ['an empty path', '', 'bad_path'],
    ['a path that is not a string', 42, 'bad_path'],
  ];
  for (const [what, value, code] of refusals) {
    const result = resolveInProject(ROOT, value);
    check(`${what} is refused`, result.ok === false && result.code === code, `${result.code}: ${result.message}`);
  }

  // The one that survives normalizing: a link inside the project pointing out
  // of it. `..` can be spotted in a string; this cannot.
  const outside = path.join(OTHER, 'secret.txt');
  fs.writeFileSync(outside, 'not yours', 'utf8');
  try {
    fs.symlinkSync(outside, path.join(ROOT, 'escape.txt'));
    const linked = resolveInProject(ROOT, 'escape.txt');
    check('a symlink out of the project is refused', linked.ok === false && linked.code === 'outside_project', linked.code);
  } catch {
    check('a symlink out of the project is refused', true, 'symlinks not available here — skipped');
  }

  check('a path that does not exist yet is allowed', resolveInProject(ROOT, 'src/pages/new.astro').ok);
  check('with no project open, nothing resolves', resolveInProject(null, 'src/x.astro').code === 'no_project');
  check('relativeTo refuses to answer about a file outside the project', relativeTo(ROOT, outside) === null);
}

// ── Revisions and digests ────────────────────────────────────────────────────

{
  check('the same text has the same digest', digestOf('hello') === digestOf('hello'));
  check('and different text does not', digestOf('hello') !== digestOf('hellp'));
  check('a digest is short enough to carry', digestOf('x'.repeat(100000)).length <= 22);
  check('a file that is not there has no digest', digestOfFile(path.join(ROOT, 'nope.txt')) === null);

  check('a write that claims nothing is allowed', checkDigest({ expected: undefined, actual: 'abc' }) === null);
  check('a write that claims correctly is allowed', checkDigest({ expected: 'abc', actual: 'abc' }) === null);
  const stale = checkDigest({ expected: 'abc', actual: 'xyz', what: 'src/x.astro' });
  check('a write that claims wrongly is refused', stale?.code === 'stale_target');
  check('and says what it found instead', stale.currentDigest === 'xyz');
  check('and says nothing was written', /Nothing was written/.test(stale.message));
  check('an expectedDigest that is not one is a bad request', checkDigest({ expected: 7, actual: 'x' })?.code === 'bad_request');

  check('a revision that agrees is allowed', checkRevision({ expectedRevision: 3, revision: 3, digest: 'a' }) === null);
  const moved = checkRevision({ expectedRevision: 3, revision: 4, digest: 'b', what: 'the page' });
  check('a revision that has moved on is refused', moved?.code === 'stale_target');
  check('and carries the current one, so a re-read is one call', moved.currentRevision === 4);
  check(
    'a revision that agrees but a digest that does not is still refused',
    checkRevision({ expectedRevision: 3, expectedDigest: 'a', revision: 3, digest: 'b' })?.code === 'stale_target'
  );
}

// ── Patches ──────────────────────────────────────────────────────────────────

{
  check('identical text has no patch', patchBetween('a\nb\n', 'a\nb\n') === null);
  const one = patchBetween('a\nb\nc\n', 'a\nB\nc\n');
  check('a one-line change is one hunk', one.hunks.length === 1);
  check('which shows what went and what came', /- b/.test(one.hunks[0].text) && /\+ B/.test(one.hunks[0].text), one.hunks[0].text);
  check('and counts both', one.linesRemoved === 1 && one.linesAdded === 1);

  const huge = patchBetween('x\n'.repeat(500), 'y\n'.repeat(500));
  const text = huge.hunks.map((h) => h.text).join('\n');
  check('a whole-file rewrite does not become a whole-file patch', text.length < 4000, `${text.length} chars`);
  check('and says how much it left out', /more removed line/.test(text) && /more added line/.test(text));
}

// ── The API, with nothing behind it ──────────────────────────────────────────
//
// Everything below runs the real dispatcher with no window and no project, and
// checks it answers with a status rather than throwing or hanging.

(async () => {
  {
    const api = createAgentApi({ getProjectRoot: () => null, getAgentMode: () => 'full' });
    const answer = await api.run('target', 'read', {});
    check('with no project open, a call is a status', answer.ok === false && answer.code === 'no_project', answer.code);
    check('and capabilities still answer', api.capabilities().ok === true);
    check('which says no project is open', api.capabilities().project.open === false);
    const bad = await api.run('target', 'levitate', {});
    check('an action that does not exist is a status', bad.ok === false && bad.code === 'bad_action');
    check('and points at get_capabilities', /get_capabilities/.test(bad.message));
    const badDomain = await api.run('nonsense', 'read', {});
    check('and so is a domain that does not exist', badDomain.ok === false && badDomain.code === 'bad_action');
  }

  {
    // A project, a permission level, and no window at all: every renderer
    // operation has to come back as a status rather than wait forever.
    const api = createAgentApi({ getProjectRoot: () => ROOT, getAgentMode: () => 'full', ask: null, callMain: null });
    const answer = await api.run('target', 'read', {});
    check('with no window, a renderer call is a status', answer.ok === false && answer.code === 'no_window', answer.code);
  }

  {
    // A window that never answers. The point is the timeout: an agent must be
    // told rather than left holding the call.
    const api = createAgentApi({
      getProjectRoot: () => ROOT,
      getAgentMode: () => 'full',
      ask: () => new Promise((resolve) => setTimeout(() => resolve(null), 5)),
    });
    const answer = await api.run('target', 'read', {});
    check('a window that does not answer is a status, not a hang', answer.ok === false && answer.code === 'not_ready', answer.code);
    check('and says what to do about it', /try again/i.test(answer.message));
  }

  {
    // Inspect mode, against a real project. Nothing that writes may get through
    // — including through a domain whose other actions are reads.
    const api = createAgentApi({ getProjectRoot: () => ROOT, getAgentMode: () => 'inspect', ask: async () => ({ ok: true }) });
    for (const [domain, action] of [
      ['target', 'set_text'], ['target', 'edit'], ['target', 'remove'], ['style', 'set_property'],
      ['source', 'write'], ['source', 'replace_range'], ['page', 'create'], ['page', 'delete'],
      ['content', 'cms_write'], ['asset', 'write_text'], ['asset', 'delete'], ['git', 'commit'],
      ['project', 'undo'], ['project', 'install'], ['style', 'set_variable'],
    ]) {
      const answer = await api.run(domain, action, {});
      check(`inspect mode cannot ${domain}.${action}`, answer.code === 'permission_denied', answer.code);
    }
    const read = await api.run('target', 'read', {});
    check('but it can still read', read.ok === true || read.code !== 'permission_denied', read.code);
    check('and capabilities say so', api.capabilities().access.canEdit === false);
  }

  {
    const api = createAgentApi({ getProjectRoot: () => ROOT, getAgentMode: () => 'edit', ask: async () => ({ ok: true }) });
    for (const [domain, action] of [['git', 'push'], ['git', 'commit'], ['git', 'checkout'], ['page', 'delete'], ['asset', 'delete'], ['project', 'install']]) {
      check(`edit mode cannot ${domain}.${action}`, (await api.run(domain, action, {})).code === 'permission_denied');
    }
    check('edit mode can read git', (await api.run('git', 'info', {})).code !== 'permission_denied');
    const caps = api.capabilities();
    check('and capabilities say which actions are open to it', caps.domains.find((d) => d.domain === 'git').actions.find((a) => a.action === 'push').allowed === false);
    check('and which are not', caps.domains.find((d) => d.domain === 'git').actions.find((a) => a.action === 'log').allowed === true);
  }

  {
    // A forged ref must not reach a file even at the highest permission level.
    const api = createAgentApi({
      getProjectRoot: () => ROOT,
      getAgentMode: () => 'full',
      ask: async () => ({ ok: true, target: { keys: [] } }),
    });
    const answer = await api.run('target', 'read', { ref: 'stacki:AAAA.BBBB' });
    check('a forged ref is refused before anything is dispatched', answer.ok === false && answer.code === 'bad_ref', answer.code);
  }

  // ── Domains, against a real folder ─────────────────────────────────────────

  {
    const written = [];
    const ctx = {
      root: ROOT,
      devUrl: null,
      branch: null,
      payload: null,
      callMain: async (channel, args) => {
        written.push({ channel, args });
        if (channel === 'src:writeText') {
          fs.writeFileSync(path.join(ROOT, args.rel), args.text, 'utf8');
          return { ok: true };
        }
        return { ok: true };
      },
    };

    const file = 'src/pages/index.astro';
    const read = await runMain('source', 'read', { path: file }, ctx);
    check('a source read answers with the file and its digest', read.ok && read.digest === digestOf('<p>hi</p>'), read.message);
    check('and how many lines it has', read.lines === 1);

    const staleWrite = await runMain('source', 'write', { path: file, text: 'x', expectedDigest: 'wrong' }, ctx);
    check('a source write against a wrong digest is refused', staleWrite.code === 'stale_target');
    check('and nothing was written', fs.readFileSync(path.join(ROOT, file), 'utf8') === '<p>hi</p>');

    const okWrite = await runMain('source', 'write', { path: file, text: '<p>bye</p>', expectedDigest: read.digest }, ctx);
    check('a source write against the right digest goes through', okWrite.ok === true, okWrite.message);
    check('and the file says so', fs.readFileSync(path.join(ROOT, file), 'utf8') === '<p>bye</p>');
    check('and it reports both digests', okWrite.beforeDigest === read.digest && okWrite.afterDigest === digestOf('<p>bye</p>'));

    fs.writeFileSync(path.join(ROOT, file), 'a\nb\nc\nd\n', 'utf8');
    const before = digestOf('a\nb\nc\nd\n');
    const range = await runMain('source', 'replace_range', { path: file, startLine: 2, endLine: 3, text: 'B', expectedDigest: before }, ctx);
    check('a range replace replaces the range', range.ok && fs.readFileSync(path.join(ROOT, file), 'utf8') === 'a\nB\nd\n', range.message);
    const badRange = await runMain('source', 'replace_range', { path: file, startLine: 99, text: 'x' }, ctx);
    check('a range that is not in the file is a bad request', badRange.code === 'bad_request', badRange.code);
    check('and says how long the file actually is', /\b4 lines\b/.test(badRange.message), badRange.message);

    for (const bad of ['/etc/passwd', '../../../etc/passwd', 'src/../../escape.txt']) {
      const answer = await runMain('source', 'read', { path: bad }, ctx);
      check(`a source read of ${bad} is refused`, answer.ok === false && answer.code === 'outside_project', answer.code);
      const write = await runMain('source', 'write', { path: bad, text: 'x' }, ctx);
      check(`and a write of ${bad} is too`, write.ok === false && write.code === 'outside_project');
    }
    check('and none of those reached a handler', !written.some((w) => String(w.args?.rel || '').includes('..')));
  }

  // ── The tool surface ───────────────────────────────────────────────────────

  {
    const { createStackiMcpServer } = require('../electron/mcp/server.js');
    const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/server/validators/ajv');
    const validator = new AjvJsonSchemaValidator();

    const TOKEN = 'b'.repeat(43);
    const PORT = 43877; // not the real one, and not the other test's
    const api = createAgentApi({
      getProjectRoot: () => ROOT,
      getAgentMode: () => 'edit',
      ask: async () => ({ ok: true, target: { kind: 'element', tag: 'p', keys: [], page: {} }, document: { file: 'x', revision: 1, digest: 'd' } }),
      callMain: async () => ({ ok: true }),
      version: '9.9.9',
    });
    const server = createStackiMcpServer({
      port: PORT,
      token: TOKEN,
      version: '9.9.9',
      getContext: async () => ({ revision: 0, timestamp: 0, project: { root: null }, page: {}, view: {}, selection: { status: 'no_project' } }),
      capture: async () => ({ image: null, mimeType: null, meta: {} }),
      getComments: async () => ({ reviews: [] }),
      comment: async () => ({ ok: true }),
      api,
      onError: () => {},
    });
    await server.start();

    let id = 1;
    const call = async (method, params) => {
      const res = await fetch(server.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
      });
      const text = await res.text();
      const line = text.split('\n').find((l) => l.startsWith('data:')) || text;
      return JSON.parse(line.replace(/^data:\s*/, ''));
    };

    const listed = await call('tools/list', {});
    const names = (listed.result?.tools || []).map((t) => t.name).sort();
    const expected = [
      'asset', 'capture', 'comment', 'content', 'get_capabilities', 'get_comments',
      'get_context', 'git', 'page', 'project', 'source', 'style', 'target',
    ];
    check('the tool list is exactly the thirteen', JSON.stringify(names) === JSON.stringify(expected), names.join(', '));

    const byName = Object.fromEntries((listed.result?.tools || []).map((t) => [t.name, t]));
    check('the four that were here before are still here', ['get_context', 'capture', 'get_comments', 'comment'].every((n) => byName[n]));

    for (const name of expected) {
      const tool = byName[name];
      check(`${name} has a description`, !!tool.description && tool.description.length > 40);
      check(`${name} has an input schema`, !!tool.inputSchema && tool.inputSchema.type === 'object');
      check(`${name} declares its output`, !!tool.outputSchema);
      check(`${name} has annotations`, !!tool.annotations);
    }

    // The descriptions are paid for in every client's context, every call.
    const total = expected.reduce((n, name) => n + byName[name].description.length, 0);
    check('the descriptions together stay readable', total < 9000, `${total} chars`);

    // Annotations. Not the gate — see the permission section — but they must
    // not LIE, because a client uses them to decide what to confirm.
    check('get_capabilities is read-only', byName.get_capabilities.annotations.readOnlyHint === true);
    check('target is not read-only', byName.target.annotations.readOnlyHint === false);
    check('target does not claim to be destructive', byName.target.annotations.destructiveHint === false);
    check('target does not claim to reach the network', byName.target.annotations.openWorldHint === false);
    check('page is destructive, because it can delete one', byName.page.annotations.destructiveHint === true);
    check('asset is destructive, for the same reason', byName.asset.annotations.destructiveHint === true);
    check('git is destructive', byName.git.annotations.destructiveHint === true);
    check('and git reaches the network', byName.git.annotations.openWorldHint === true);
    check('nothing else claims to', expected.filter((n) => byName[n].annotations.openWorldHint).length === 1);
    check(
      'no tool claims to be idempotent when it is not',
      !expected.some((n) => byName[n].annotations.idempotentHint && byName[n].annotations.readOnlyHint === false)
    );

    // A discriminated union means the protocol refuses a call that forgot an
    // argument, rather than us refusing it in prose one layer down.
    const missing = await call('tools/call', { name: 'target', arguments: { action: 'set_text' } });
    check('an action missing its argument is refused by the schema', missing.result?.isError === true, JSON.stringify(missing).slice(0, 200));
    const unknownAction = await call('tools/call', { name: 'target', arguments: { action: 'obliterate' } });
    check('and an action that does not exist never reaches the app', unknownAction.result?.isError === true);
    const absolute = await call('tools/call', { name: 'source', arguments: { action: 'read', path: '/etc/passwd' } });
    check('an absolute path is refused', absolute.result?.structuredContent?.code === 'outside_project');

    const caps = await call('tools/call', { name: 'get_capabilities', arguments: {} });
    const body = caps.result?.structuredContent;
    check('get_capabilities answers with structured content', !!body && body.ok === true);
    check('and says the version', body.stacki.version === '9.9.9');
    check('and the permission mode', body.access.mode === 'edit');
    check('and every domain', body.domains.length === registry.DOMAINS.length);
    check('and does not dump the schemas into it', JSON.stringify(body).length < 12000, `${JSON.stringify(body).length} chars`);
    check('and names its limitations', Array.isArray(body.limits) && body.limits.length >= 3);

    // structuredContent has to validate against what the tool declared, or a
    // strict client rejects an answer that is perfectly correct.
    for (const [name, args] of [
      ['get_capabilities', {}],
      ['project', { action: 'info' }],
      ['target', { action: 'read' }],
      ['git', { action: 'info' }],
    ]) {
      const answer = await call('tools/call', { name, arguments: args });
      const content = answer.result?.structuredContent;
      const verdict = content
        ? await validator.getValidator(byName[name].outputSchema)(content)
        : { valid: false, errorMessage: 'no structuredContent' };
      check(`${name} answers within its declared output schema`, verdict.valid === true, verdict.errorMessage || '');
    }

    // A refusal is a status with a code, not a protocol error a client has to
    // parse out of a stack trace.
    const denied = await call('tools/call', { name: 'git', arguments: { action: 'push', branch: 'main' } });
    check('a refused operation answers with a code', denied.result?.structuredContent?.code === 'permission_denied');
    check('and marks itself an error for a client that reads only that', denied.result?.isError === true);
    check('and is not a JSON-RPC error', !denied.error);

    await server.stop();
  }

  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OTHER, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\nagent-api: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`agent-api: ${checked} passed  [refs, permission, paths, the surface]`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
