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
const short = (x, n = 200) => JSON.stringify(x ?? null).slice(0, n);
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

  // NOTHING ABSOLUTE, enforced rather than asserted in a comment. One minter
  // read the payload's page path raw, so a ref clients are told to log opaquely
  // carried somebody's home directory base64'd inside it while the observation
  // beside it stayed relative. The choke point is what stops the next one.
  const decode = (r) => {
    const rest = String(r).slice('stacki:'.length);
    return JSON.parse(Buffer.from(rest.slice(0, rest.lastIndexOf('.')), 'base64url').toString('utf8'));
  };
  const leaky = decode(
    refs.mint(
      'node',
      { keys: ['src/pages/index.astro#0'], page: { file: path.join(ROOT, 'src/pages/index.astro'), route: '/' } },
      { projectRoot: ROOT }
    )
  );
  check('a path under the project goes into a ref project-relative', leaky.d.page.file === 'src/pages/index.astro', short(leaky.d.page));
  check('and the route, which is not a path, is left alone', leaky.d.page.route === '/', short(leaky.d.page));
  const foreign = decode(refs.mint('node', { page: { file: '/etc/passwd' } }, { projectRoot: ROOT }));
  check('a path outside the project does not go in at all', foreign.d.page.file === null, short(foreign.d.page));

  // A WRITE HANDLE CARRIES WHAT IT SAW. The guard that refuses a stale write
  // compares against the ref's observation, so a writable ref without one is
  // not a weaker guard — it is none, and it read as ok:true through every write
  // in the API. Minting degrades rather than throwing: read-only is a
  // first-class state and a caller that forgets gets one.
  {
    const seen = { file: 'src/pages/index.astro', revision: 3, digest: 'abc-1' };
    const nodeApi = createAgentApi({ getProjectRoot: () => ROOT, getAgentMode: () => 'full' });
    const bare = refs.parse(nodeApi.nodeRef(anchor, { writable: true }), { projectRoot: ROOT });
    check('a node ref asked for writable with nothing observed is issued read-only', bare.ok && bare.writable === false, short(bare));
    const observed = refs.parse(nodeApi.nodeRef(anchor, { writable: true, observed: seen }), { projectRoot: ROOT });
    check('and one that names what it saw is writable', observed.ok && observed.writable === true, short(observed));
    check('and carries the revision it saw', observed.observed?.revision === 3, short(observed.observed));
    const withheld = refs.parse(nodeApi.nodeRef(anchor, { writable: false, observed: seen }), { projectRoot: ROOT });
    check('and an observation does not make a withheld ref writable', withheld.ok && withheld.writable === false, short(withheld));
  }

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
  // The bottom rung is what the endpoint could do BEFORE the Agent API: see
  // what is on screen, take a picture, read and reply to reviews. It is the
  // default because anything else means an update handing an existing bearer
  // token the ability to read a repository nobody offered it.
  check('the default grants nothing over the project', permissions.DEFAULT_MODE === 'visual');
  check('an unrecognised mode is the conservative one too', permissions.normalizeMode('root') === 'visual');
  check('and so is a missing one', permissions.normalizeMode(undefined) === 'visual');
  check('reading the project is its own level', permissions.MODES[1] === 'inspect');
  check('and the levels are in order of what they grant', JSON.stringify(permissions.MODES) === JSON.stringify(['visual', 'inspect', 'edit', 'full']));

  const table = [
    ['visual', 'read', false],
    ['visual', 'write', false],
    ['visual', 'high', false],
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

  // The one that would have been the regression: an existing installation, on
  // the level it gets by default, must not be able to read the project.
  const legacy = permissions.createGate(() => permissions.DEFAULT_MODE);
  check('the default cannot read project source', legacy.check('source.read', 'read')?.code === 'permission_denied');
  check('nor the content', legacy.check('content.cms_read', 'read')?.code === 'permission_denied');
  check('nor the git history', legacy.check('git.log', 'read')?.code === 'permission_denied');
  check('and the refusal says which level would', legacy.check('source.read', 'read').requires === 'inspect');
  check('and every level has words describing what it grants', permissions.MODES.every((m) => (permissions.BLURB[m] || '').length > 40));
  check('and "inspect" says out loud that it reads the project', /READ the project/.test(permissions.BLURB.inspect));
  check('and "full" says it does not outlive the session', /this session/.test(permissions.BLURB.full));

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

// ── Whose project, and for how long ──────────────────────────────────────────
//
// The endpoint is the machine's; the authorisation is not. "This agent may
// commit and push" is a sentence about a repository, and a grant that followed
// Stacki into the next one would be somebody's client project inheriting a
// permission they gave a scratch folder.

{
  const { createAccessStore } = require('../electron/mcp/agent/access.js');
  let settings = { sound: false, agentAccess: {} };
  const store = () => createAccessStore({ read: () => settings, write: (next) => { settings = next; } });
  const A = '/tmp/stacki-project-a';
  const B = '/tmp/stacki-project-b';

  const first = store();
  check('a project nobody has been asked about grants nothing', first.modeFor(A) === 'visual');
  check('and so does no project at all', first.modeFor(null) === 'visual');

  const granted = first.setModeFor(A, 'full');
  check('full control can be granted', granted.agentMode === 'full' && first.modeFor(A) === 'full');
  check('and says it is for this session only', granted.sessionOnly === true);
  check('another project does NOT inherit it', first.modeFor(B) === 'visual', first.modeFor(B));

  first.setModeFor(B, 'inspect');
  check('two projects hold two different levels', first.modeFor(A) === 'full' && first.modeFor(B) === 'inspect');

  // A restart: the settings survive, the session does not.
  const next = store();
  check('full control does not survive a restart', next.modeFor(A) === 'edit', next.modeFor(A));
  check('but what was written down does', next.modeFor(B) === 'inspect');
  check('and nothing was written down as full', !Object.values(settings.agentAccess).includes('full'), JSON.stringify(settings.agentAccess));

  next.setModeFor(A, 'visual');
  check('turning a level down takes effect at once', next.modeFor(A) === 'visual');
  check('and stops being stored, since it is the default', !(Object.keys(settings.agentAccess).length && settings.agentAccess[Object.keys(settings.agentAccess).find((k) => next.modeFor(A) === 'visual' && false)]));
  check('an unrecognised level is refused into the default', next.setModeFor(B, 'superuser').agentMode === 'visual');
  check('and with no project open there is nothing to grant', next.setModeFor(null, 'full').ok === false);

  // What is stored is a fingerprint, not a list of where somebody works.
  check('the settings do not record project paths', !JSON.stringify(settings).includes('/tmp/stacki-project'), JSON.stringify(settings));
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
  check('and reads the level from the main process rather than remembering one', /window\.avb\.agentAccess/.test(dialog));
  check('and asks about the project that is open', /agentAccess: invoke\('settings:agentAccess'\)/.test(preload));
  check('and shows what it actually settled on', /result\?\.agentMode/.test(dialog));
  check('and says the grant is per project', /this project/.test(dialog));
  check('and says when full control expires', /lasts until you quit/.test(dialog));

  check('the bridge carries the choice', /setAgentMode: invoke\('settings:setAgentMode'\)/.test(preload));
  check('and the main process is where it is stored', /handle\('settings:setAgentMode'/.test(main));
  check('and it is keyed by the open project', /agentAccess\.setModeFor\(openProjectRoot, mode\)/.test(main));
  check('and the gate reads that project’s level', /getAgentMode: \(\) => agentAccess\.modeFor\(openProjectRoot\)/.test(main));
  check('and nothing is granted until somebody grants it', /agentAccess: \{\}/.test(main));

  // The words in the window and the words the gate reports have to be the same
  // words. A level described as harmless and enforced as sweeping is worse
  // than one described as nothing at all.
  // The blurbs are written across lines in the JSX, so the joins come out
  // before comparing — what is checked is the sentence, not how it was typed.
  const table = dialog
    .slice(dialog.indexOf('const ACCESS = ['), dialog.indexOf('export default function McpDialog'))
    .replace(/'\s*\+\s*'/g, '');
  for (const mode of permissions.MODES) {
    check(`the window describes "${mode}" the way permissions.js does`, table.includes(permissions.BLURB[mode]), permissions.BLURB[mode].slice(0, 60));
    check('and labels it the same', table.includes(`label: '${permissions.LABEL[mode]}'`), permissions.LABEL[mode]);
  }

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

  // EVERY OPERATION'S RISK, WRITTEN DOWN HERE.
  //
  // The permission matrix drives all 111 operations at all four levels and
  // checks each answer against the policy — but it asks the REGISTRY what an
  // operation needs, and the gate reads that same field. So it proves the gate
  // is consistent with the registry, never that the registry is right:
  // reclassify asset.write_text from write to read and the matrix computes
  // "needs inspect", the gate agrees, and 444 answers stay green while a write
  // has quietly become reachable at a level that may only look.
  //
  // This is the expectation the gate cannot supply. It is a literal table, and
  // it is checked both ways — every operation must be listed with the risk it
  // has, and every listed operation must exist — so adding one without
  // classifying it fails here, and changing one's class is a deliberate edit to
  // this file rather than a side effect somewhere else.
  //
  // The three tables below it are kept: they say WHY particular ones are where
  // they are, which a flat list cannot.
const PINNED_RISK = {
  read: [
    'target.read', 'target.select', 'target.enter', 'target.exit', 'style.read',
    'style.list_sources', 'style.read_source', 'style.variables', 'source.read',
    'source.read_symbol', 'source.resolve_path', 'page.list', 'page.read',
    'page.component_usage', 'page.dynamic_paths', 'page.injected_routes', 'page.import_path',
    'page.rebase_import', 'content.cms_list', 'content.cms_read', 'content.cms_usage',
    'content.cms_meta', 'content.config', 'content.collections', 'content.entries',
    'content.validate', 'content.targets', 'content.rename_plan', 'content.sample_entry',
    'content.resolve_import', 'asset.list', 'asset.dimensions', 'asset.read_text',
    'project.info', 'project.scan', 'project.classes', 'project.dependencies',
    'project.diagnose', 'project.probe', 'project.dev_status', 'git.info', 'git.status',
    'git.log', 'git.commit_files', 'git.all_files', 'git.file_at', 'git.worktrees',
    'git.gh_status',
  ],
  write: [
    'target.edit', 'target.set_text', 'target.set_prop', 'target.remove_prop',
    'target.set_classes', 'target.add_class', 'target.remove_class', 'target.insert_before',
    'target.insert_after', 'target.append_child', 'target.remove', 'target.duplicate',
    'target.move', 'target.set_tag', 'style.set_property', 'style.remove_property',
    'style.set_declarations', 'style.write_source', 'style.set_variable', 'style.add_variables',
    'style.rename_variables', 'style.move_variables', 'style.add_section',
    'style.set_section_title', 'style.remove_section', 'style.move_heading',
    'source.replace_range', 'source.write', 'page.create', 'page.move', 'page.folder_create',
    'page.folder_rename', 'page.component_create', 'content.cms_write', 'content.cms_create',
    'content.cms_set_meta', 'content.write_entry', 'content.rename', 'asset.write_text',
    'asset.mkdir', 'asset.move', 'asset.rename', 'project.dev_start', 'project.dev_stop',
    'project.undo', 'project.redo',
  ],
  high: [
    'page.delete', 'page.folder_delete', 'content.cms_delete', 'asset.delete',
    'project.install', 'git.init', 'git.commit', 'git.checkout', 'git.merge',
    'git.resolve_merge', 'git.delete_branch', 'git.restore_file', 'git.restore_project',
    'git.park', 'git.unpark', 'git.push', 'git.publish',
  ],
};

  {
    const actual = new Map(all.map((op) => [`${op.domain}.${op.action}`, op.risk]));
    const pinned = new Map();
    for (const [risk, names] of Object.entries(PINNED_RISK)) for (const name of names) pinned.set(name, risk);

    const wrong = [...actual].filter(([name, risk]) => pinned.get(name) !== risk).map(([name, risk]) => `${name} is ${risk}, pinned ${pinned.get(name) || 'nowhere'}`);
    const gone = [...pinned.keys()].filter((name) => !actual.has(name));

    check('every operation carries the risk this file pins it at', wrong.length === 0, wrong.slice(0, 10).join('; '));
    check('and every operation is classified here', pinned.size === actual.size, `${pinned.size} pinned, ${actual.size} registered`);
    check('with nothing pinned that no longer exists', gone.length === 0, gone.join(', '));
  }

  // A SECOND OPINION, derived rather than typed: an operation whose mapper
  // guards a write cannot be a read, whatever anybody typed above.
  {
    // THE ENTRY, not the first block in the file that shares its action name.
    //
    // This searched domains.js for `  <action>: {` and took the first match,
    // discarding the domain — so asset.list was measured against page.list's
    // mapper, and target.read, style.read and source.read all against whichever
    // `read:` came first. Every answer it gave was about a different operation
    // than the one it named. The module is loaded and asked directly instead.
    const { DOMAINS: MAPPERS } = require('../electron/mcp/agent/domains.js');
    const guarded = [];
    const unmapped = [];
    for (const op of all.filter((o) => o.risk === 'read' && o.via === 'main')) {
      const entry = MAPPERS[op.domain]?.[op.action];
      if (!entry) {
        unmapped.push(`${op.domain}.${op.action}`);
        continue;
      }
      const text = typeof entry === 'function' ? String(entry) : `${String(entry.args || '')}${String(entry.result || '')}`;
      if (/guardWrite\(/.test(text)) guarded.push(`${op.domain}.${op.action}`);
    }
    check('every main-process read operation has a mapper to check', unmapped.length === 0, unmapped.join(', '));
    check('no operation classified read guards a write in its mapper', guarded.length === 0, guarded.join(', '));
  }

  // The classification that matters most: nothing that deletes, rewrites a
  // working tree or talks to a network may be reachable at the ordinary
  // editing level.
  const mustBeHigh = [
    ['git', 'commit'], ['git', 'checkout'], ['git', 'merge'], ['git', 'push'], ['git', 'publish'],
    ['git', 'restore_file'], ['git', 'restore_project'], ['git', 'delete_branch'], ['git', 'resolve_merge'],
    ['git', 'park'], ['git', 'unpark'], ['git', 'init'],
    ['page', 'delete'], ['page', 'folder_delete'], ['asset', 'delete'], ['content', 'cms_delete'],
    ['project', 'install'],
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

  // A risk class and an undo are two answers to the same question, and they
  // have to agree: "high" means putting it back is not obviously available, so
  // an operation Stacki records an undo command for is a write.
  const contradictory = all.filter((op) => op.risk === 'high' && op.undoable);
  check('nothing is both hard to take back and undoable', contradictory.length === 0, contradictory.map((op) => `${op.domain}.${op.action}`).join(', '));

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
  // THE ASSERTION IS OUTSIDE THE TRY, AND IT USED NOT TO BE.
  //
  // `resolveInProject` was called inside a `try` whose `catch` asserted
  // `check(..., true)`. So a regression in the path fence that made the
  // resolver THROW -- which is exactly what a broken fence does -- was caught
  // and converted into a pass, on the only test of the one escape that string
  // normalisation cannot catch. Making the link is allowed to fail on a
  // filesystem that has no symlinks; deciding what the resolver said about it
  // is not.
  let made = null;
  try {
    fs.symlinkSync(outside, path.join(ROOT, 'escape.txt'));
    made = true;
  } catch (err) {
    made = String(err?.code || err?.message || err);
  }
  check('this filesystem can make the symlink the fence has to survive', made === true, String(made));
  if (made === true) {
    const linked = resolveInProject(ROOT, 'escape.txt');
    check('a symlink out of the project is refused', linked.ok === false && linked.code === 'outside_project', linked.code);
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

    // AND WHICH LEVEL WOULD ALLOW THE ONE THAT IS NOT.
    //
    // Every action row carries `risk` and `allowed`. Turning "this is a write
    // and it is refused" into "you would need Edit project" needed a mapping
    // that lived only inside `refusal()` -- which an agent sees only if it
    // TRIES something. One that orients itself first, as the instructions tell
    // it to, never sees a refusal at all.
    //
    // Measured: asked to edit at `visual`, a real Claude Code called
    // get_capabilities once, correctly refused, correctly said only the person
    // at the keyboard could change it, and named the level needed as "Editing".
    // There is no level called Editing. It had nothing to read the name off.
    check('capabilities name the level each risk needs', caps.access.needs?.write?.mode === 'edit' && caps.access.needs?.high?.mode === 'full' && caps.access.needs?.read?.mode === 'inspect', JSON.stringify(caps.access.needs));
    check('  in the words the window uses', caps.access.needs?.write?.label === 'Edit project' && caps.access.needs?.high?.label === 'Full control', JSON.stringify(caps.access.needs));
    check('  and every level there is, in order', JSON.stringify((caps.access.levels || []).map((l) => l.mode)) === JSON.stringify(['visual', 'inspect', 'edit', 'full']), JSON.stringify(caps.access.levels));
    check('  named the same way', (caps.access.levels || []).map((l) => l.label).join('|') === 'Visual only|Inspect project|Edit project|Full control', JSON.stringify(caps.access.levels));
    // The refusal an agent gets if it tries, and the answer it gets if it asks,
    // must name the same level. Two sources that could disagree is worse than
    // one that was silent.
    const refused = await api.run('git', 'push', {});
    check('  the same level the refusal names', refused.requires === caps.access.needs?.high?.mode, `${refused.requires} vs ${caps.access.needs?.high?.mode}`);
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

    // The one the first version got wrong: no guard at all used to mean "take
    // whatever is there", which is protection a client could opt out of by
    // doing nothing.
    const unguarded = await runMain('source', 'write', { path: file, text: 'x' }, ctx);
    check('a write with NO guard at all is refused for an existing file', unguarded.code === 'guard_required', unguarded.code);
    check('and says how to name the version', /pass the ref it gave you/.test(unguarded.message));
    check('and still nothing was written', fs.readFileSync(path.join(ROOT, file), 'utf8') === '<p>hi</p>');

    // Creating is different: there is no prior version to be stale against.
    const created = await runMain('source', 'write', { path: 'src/pages/fresh.astro', text: '<p>new</p>' }, ctx);
    check('creating something new needs no guard', created.ok === true, created.message);
    check('and the file is there', fs.existsSync(path.join(ROOT, 'src/pages/fresh.astro')));

    const okWrite = await runMain('source', 'write', { path: file, text: '<p>bye</p>', expectedDigest: read.digest }, ctx);
    check('a source write against the right digest goes through', okWrite.ok === true, okWrite.message);
    check('and the file says so', fs.readFileSync(path.join(ROOT, file), 'utf8') === '<p>bye</p>');
    check('and it reports both digests', okWrite.beforeDigest === read.digest && okWrite.afterDigest === digestOf('<p>bye</p>'));

    fs.writeFileSync(path.join(ROOT, file), 'a\nb\nc\nd\n', 'utf8');
    const before = digestOf('a\nb\nc\nd\n');
    const range = await runMain('source', 'replace_range', { path: file, startLine: 2, endLine: 3, text: 'B', expectedDigest: before }, ctx);
    check('a range replace replaces the range', range.ok && fs.readFileSync(path.join(ROOT, file), 'utf8') === 'a\nB\nd\n', range.message);
    const badRange = await runMain('source', 'replace_range', { path: file, startLine: 99, text: 'x', expectedDigest: digestOf('a\nB\nd\n') }, ctx);
    check('a range that is not in the file is a bad request', badRange.code === 'bad_request', badRange.code);
    // 'a\nB\nd\n' is THREE lines. It used to be reported as four, because the
    // empty string after the final newline was counted as one.
    check('and says how long the file actually is', /\b3 lines\b/.test(badRange.message), badRange.message);

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

    // EVERY ARGUMENT POSITION THAT TAKES A REF, and not merely every argument
    // spelled `ref`.
    //
    // A move's destination is a ref called `parentRef`, nested two levels down
    // inside an operations array, and it stayed unguarded for as long as it did
    // because the guard was written for "the ref argument" — meaning the one at
    // the top of the object. So the positions are enumerated off the wire
    // instead of being remembered, by the shape `Ref`/`FileRef` emit (a string
    // bounded 8..4000, which git's revision argument — a plain string capped at
    // 200 — is not), and the answer is written down here.
    //
    // A new ref argument anywhere in any schema makes this fail, which is the
    // point: the list is a decision that somebody has covered it in
    // test/ref-concurrency.js, not a description of what happens to exist.
    {
      const positions = [];
      const walk = (schema, at, tool) => {
        if (!schema || typeof schema !== 'object') return;
        if (schema.type === 'string' && schema.minLength === 8 && schema.maxLength === 4000) positions.push(`${tool}:${at}`);
        if (schema.properties) for (const [key, value] of Object.entries(schema.properties)) walk(value, at ? `${at}.${key}` : key, tool);
        if (schema.items) walk(schema.items, `${at}[]`, tool);
        for (const branch of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(schema[branch])) schema[branch].forEach((one) => walk(one, at, tool));
      };
      for (const name of expected) walk(byName[name].inputSchema, '', name);
      const found = [...new Set(positions)].sort();
      const covered = [
        'asset:ref',
        'content:ref',
        'page:ref',
        'source:ref',
        'style:ref',
        'target:operations[].to.parentRef',
        'target:ref',
        'target:to.parentRef',
      ];
      check(
        'every ref-typed argument position on the surface is one somebody has covered',
        JSON.stringify(found) === JSON.stringify(covered),
        `found ${JSON.stringify(found)}\n    covered ${JSON.stringify(covered)}`
      );
      check('and the destination of a move is one of them', found.includes('target:to.parentRef'), found.join(', '));
      check('including the one inside an edit batch', found.includes('target:operations[].to.parentRef'), found.join(', '));
    }

    // A BLOAT GUARD, AND NO LONGER A CONTEXT ESTIMATE.
    //
    // This used to read "the descriptions are paid for in every client's
    // context, every call", and that premise has been measured false. Both
    // hosts driven against this server defer MCP tool schemas — Claude Code's
    // tool search is on by default, Codex's `tool_search_always_defer_mcp_tools`
    // is permanently on — so the catalogue is fetched when a tool becomes
    // relevant rather than inlined up front. Measured on Claude Code 2.1.259
    // with a real user toolset: Stacki's marginal first-turn cost is ~780
    // tokens deferred against ~12,860 inlined, and descriptions are 6% of the
    // catalogue either way.
    //
    // The constraint that actually binds is PER TOOL, not in total: a host
    // silently truncates any description over 2,048 characters, which
    // test/host-limits.js fails on with a margin. This number stays as a guard
    // against unbounded growth across the surface, and the ceiling is set from
    // what the tools currently need to say rather than from a token estimate
    // that no longer describes anything.
    const total = expected.reduce((n, name) => n + byName[name].description.length, 0);
    check('the descriptions together stay readable', total < 12000, `${total} chars`);

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

    // The declared half of the envelope has to be more than decoration: the
    // fields a client acts on are the ones that must be typed, and a real
    // mutation has to actually produce them.
    {
      const declared = Object.keys(agentTools.Envelope.shape || {});
      for (const field of ['ok', 'ref', 'document', 'documentBefore', 'changedFiles', 'undoable', 'revisionBefore', 'revisionAfter', 'notes', 'gone', 'through', 'code', 'message']) {
        check(`the output schema declares ${field}`, declared.includes(field), declared.join(', '));
      }
      const shape = byName.target.outputSchema;
      check('and a mutation shape is in the published schema', !!shape.properties?.changedFiles && !!shape.properties?.ref, Object.keys(shape.properties || {}).join(', '));
      check('with the patch bounded and typed', !!shape.properties.changedFiles.items?.properties?.patch);
      check('and revision/digest declared rather than conventional', !!shape.properties.document && !!shape.properties.revisionBefore);
      check('while an action’s own fields stay open', shape.additionalProperties !== false, JSON.stringify(shape.additionalProperties));

      // A refusal that a client has to branch on is typed too.
      const denied2 = await call('tools/call', { name: 'git', arguments: { action: 'push', branch: 'main' } });
      const verdict = await validator.getValidator(shape)(denied2.result?.structuredContent);
      check('a permission refusal validates against it', verdict.valid === true, verdict.errorMessage || '');
      check('and carries the fields a client would act on', ['code', 'operation', 'risk', 'requires'].every((k) => k in denied2.result.structuredContent), short(denied2.result?.structuredContent));
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
