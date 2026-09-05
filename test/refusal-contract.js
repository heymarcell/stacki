// Every way this surface says no, held to the same five promises.
//
//   node test/refusal-contract.js
//
// A refusal is the answer an agent gets most often. It is also the one answer
// nothing checks, and there is a mechanical reason for that.
//
// THE PREMISE. The SDK does not validate a tool's result against that tool's
// declared output schema when the result carries `isError`. Both halves of it:
//
//   node_modules/@modelcontextprotocol/server/dist/mcp-D7GmuPnv.cjs
//     validateToolOutput(tool, result, toolName) {
//       if (!tool.outputSchema) return;
//       if (isInputRequiredResult(result)) return;
//       if (result.isError) return;                 <- here
//
//   node_modules/@modelcontextprotocol/client/dist/index.cjs
//     if (result.structuredContent !== void 0 && !result.isError) try {
//       const validationResult = validator(result.structuredContent);
//
// Every Stacki refusal sets `isError` — see `answer()` in agentTools.js — so
// every Stacki refusal goes out unvalidated by both ends of the wire. A success
// that breaks its schema is destroyed in flight and the client is told; a
// refusal that breaks its schema is delivered intact and nobody finds out.
//
// That premise is not read off the source and believed. test/support/refusal-premise.js
// builds a real endpoint with the same `createMcpHandler`/`McpServer` pair
// electron/mcp/server.js uses, registers two tools that answer the identical
// schema-invalid payload and differ only in `isError`, and calls both with a
// real client. If a future SDK starts validating refusals, the first block below
// goes red and the reason this file exists has changed.
//
// WHAT THAT LEAVES UNGUARDED. test/schema-dispatch-contract.js validates exactly
// one refusal against a published output schema — audit's `permission_denied` —
// and says so at the assertion. Every other refusal family in the surface is
// shaped by hand in electron/mcp/agent/domains.js, main.js and the renderer's
// command stack, and reaches a client without ever being held against anything.
//
// SO: EVERY REFUSAL FAMILY THE SURFACE DECLARES, AGAINST FIVE PROMISES.
//
//   schema        valid against the output schema THAT TOOL PUBLISHED, read off
//                 the wire and checked with the SDK's own AJV validator — not a
//                 second, more forgiving reading of it out of the repository.
//   bounded       no unbounded list and no unbounded string, against the caps
//                 the surface itself declares (MAX_LIST, MAX_TEXT_BYTES, and the
//                 conflict budgets read out of domains.js by name).
//   sanitized     no absolute host path ANYWHERE in the payload — every field,
//                 not just `.message`. A sibling fix on this branch was exactly
//                 this class: `restored.failed` carried
//                 `/var/folders/…/src/styles/site.css` while `.message` was
//                 scrubbed, so the assertion is over the whole serialized
//                 payload and the real fixture root.
//   actionable    a code, from the enumeration the surface declares — and the
//                 enumeration is DISCOVERED from the shipping source, so a code
//                 added tomorrow is covered without this file being edited.
//   truthful      and this is the one that cannot be faked by shaping an
//                 envelope: where a refusal says nothing changed, the DISK is
//                 asked, not the envelope. Every refusal below is bracketed by a
//                 digest of every file in the project and by git's own view of
//                 HEAD, the branch, the index and MERGE_HEAD.
//
// REAL BEHAVIOUR, NOT MAPPER UNITS. The families that matter are provoked on the
// wire against a real repository: two branches that genuinely conflict, a dirty
// tree that genuinely blocks a switch, a ref that has genuinely expired, an undo
// whose inverse genuinely cannot run. Six codes cannot be reached over this wire
// at all — three need a running dev server, two need the project's dependencies
// installed, one is the terminal fallback — and those are graded IN PROCESS
// against the schema the tool publishes, exactly as schema-dispatch-contract.js
// grades get_context, and they are named as such in the output. One more,
// `bad_topic`, is dead: the published enum makes its branch unreachable, and
// that is proved rather than excused.
//
// COMPLETENESS IS AN ASSERTION. Every code the surface declares must be
// exercised, graded or proved unreachable. A declared code that is none of those
// is either dead or untested and both are worth knowing — and a code another
// change adds to the shaping layer (`stale_merge`, being written as this is)
// enters the denominator the moment it lands, without anybody remembering to add
// it here.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/server/validators/ajv');

const { startWireRig } = require('./support/mcpWireRig.js');
const { withPremiseServer, MALFORMED } = require('./support/refusal-premise.js');
const DOMAINS_MODULE = require('../electron/mcp/agent/domains.js');
const { createAgentApi } = require('../electron/mcp/agent/index.js');
const refs = require('../electron/mcp/agent/refs.js');
const { TOPICS, TOPIC_NAMES } = require('../electron/mcp/guide.js');
const { guardSuite } = require('./support/suiteGuard.js');

// A HANG MUST NOT REPORT A PASS. This suite awaits a real wire and a real
// repository; node exits 0 on an empty event loop, so an await that never settles
// would print nothing after the last line it reached and be recorded as success.
// See test/support/suiteGuard.js.
const suiteDone = guardSuite('refusal-contract');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v, n = 300) => JSON.stringify(v ?? null).slice(0, n);
const REPO = path.join(__dirname, '..');

// ── THE ENUMERATION, READ OUT OF WHAT SHIPS ──────────────────────────────────
//
// A list typed into a test is a list that agrees with itself. This one is read
// from the source on every run, so a family added to the shaping layer is in the
// denominator immediately and the completeness check at the bottom fails until
// somebody has exercised it.
//
// WHERE THE LINE IS. These are the files that turn a cause into an MCP refusal:
// the Agent API's dispatch and its guards, and the tool layer that shapes an
// argument mistake. src/agent/commands.js is deliberately NOT here — the
// renderer's command stack has a vocabulary of its own about canvas state, and
// pulling all of it in would put a dozen codes into an enumeration about the MCP
// surface. The two of its codes the published contract promises an agent,
// `undo_failed` and `redo_failed`, arrive through the documentation table below
// instead, and are provoked on the wire like the rest.
const SHAPING_FILES = [
  'electron/mcp/agent/domains.js',
  'electron/mcp/agent/digest.js',
  'electron/mcp/agent/paths.js',
  'electron/mcp/agent/refs.js',
  'electron/mcp/agent/access.js',
  'electron/mcp/agent/permissions.js',
  'electron/mcp/agent/index.js',
  'electron/mcp/agentTools.js',
];

/** The block a named `const NAME = { … }` or `[ … ]` spans, as text. */
function blockOf(source, name) {
  const at = source.indexOf(`const ${name} = `);
  if (at === -1) return null;
  const open = source.indexOf(source[source.indexOf('=', at) + 2] === '[' ? '[' : '{', at);
  const closer = source[open] === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === source[open]) depth += 1;
    else if (source[i] === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

const CODE_WORD = /^[a-z][a-z0-9_]*$/;

/**
 * The codes the envelope schema names to every client that connects.
 *
 * `Envelope.code` carries a description and the description is a list. It is
 * the shortest thing a client reads about refusals and the only one that
 * arrives over the wire, so a code named there is declared in the strongest
 * sense there is — promised to everybody, in the schema itself — whichever
 * layer of the process actually mints it.
 */
function describedCodes() {
  const source = fs.readFileSync(path.join(REPO, 'electron/mcp/agentTools.js'), 'utf8');
  const said = source.match(/\bcode:\s*z\.[^\n]*?\.describe\('Why not\.([^']*)'\)/);
  if (!said) return null;
  return new Set([...said[1].matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map((m) => m[1]));
}

/** The codes docs/mcp-v1.md promises an agent, read out of its own table. */
function promisedCodes() {
  const doc = fs.readFileSync(path.join(REPO, 'docs/mcp-v1.md'), 'utf8');
  const from = doc.indexOf('Refusals an agent must expect');
  const to = doc.indexOf('This table is the ones worth knowing');
  if (from === -1 || to === -1 || to < from) return null;
  // A row is `| \`code\` | means |`, so only the backticked word in the first
  // cell is a code. Everything else in the table names an argument or a field.
  const codes = new Set();
  for (const line of doc.slice(from, to).split('\n')) {
    if (!line.startsWith('| `')) continue;
    for (const m of line.slice(0, line.indexOf('|', 2)).matchAll(/`([a-z][a-z0-9_]*)`/g)) codes.add(m[1]);
  }
  return codes;
}

/** Every refusal code the shaping layer writes down, with where it was found. */
function declaredCodes() {
  const found = new Map();
  const record = (code, where) => {
    if (!CODE_WORD.test(code)) return;
    if (!found.has(code)) found.set(code, new Set());
    found.get(code).add(where);
  };
  for (const rel of SHAPING_FILES) {
    const source = fs.readFileSync(path.join(REPO, rel), 'utf8');
    // `{ ok:false, code: 'x' }`, and the three one-word helpers this layer
    // refuses through — `problem()` in the dispatch table, `no()` in the API,
    // `fail()` where a domain builds its own. `\s*` spans the newline, because
    // the longer messages put the code on its own line.
    for (const m of source.matchAll(/\bcode:\s*'([a-z][a-z0-9_]*)'/g)) record(m[1], rel);
    for (const m of source.matchAll(/\b(?:problem|no|fail)\(\s*'([a-z][a-z0-9_]*)'/g)) record(m[1], rel);
    // AND THE TWO TABLES, which are the half a `code:` grep misses entirely: the
    // git vocabulary and the errno vocabulary are pairs, not properties, and
    // between them they carry six codes that appear nowhere else — including
    // `merge_conflict` and `working_tree_blocked` on the route where git's text
    // arrives as a throw.
    for (const table of ['GIT_CAUSES', 'ERRNO_CODES']) {
      const block = blockOf(source, table);
      if (!block) continue;
      for (const m of block.matchAll(/'([a-z][a-z0-9_]*)'/g)) record(m[1], `${rel} ${table}`);
    }
  }
  return found;
}

const SHAPED = declaredCodes();
const DECLARED = new Map(SHAPED);
const PROMISED = promisedCodes();
const DESCRIBED = describedCodes();
check('the published refusal table in docs/mcp-v1.md was found and read', PROMISED && PROMISED.size >= 12, PROMISED ? [...PROMISED].join(', ') : 'the table markers moved');
check('the envelope schema still names some of its codes to a client', DESCRIBED && DESCRIBED.size >= 5, DESCRIBED ? [...DESCRIBED].join(', ') : 'the `code` description moved');
// Both are part of the enumeration rather than lists to reconcile with it: a
// refusal the documentation tells an agent to expect, or the schema names to
// every client that connects, is one the surface has promised — wherever in the
// process it is actually minted.
for (const [where, codes] of [['docs/mcp-v1.md', PROMISED], ['the Envelope schema', DESCRIBED]]) {
  for (const code of codes || []) {
    if (!DECLARED.has(code)) DECLARED.set(code, new Set([where]));
    else DECLARED.get(code).add(where);
  }
}

// A POSITIVE CONTROL ON THE DISCOVERY ITSELF. Everything below divides by this
// set, so a scanner that quietly stopped matching would turn the completeness
// check into a tautology over nothing. These seven are found by five different
// rules — a `code:` property, a `problem()` call, a `no()` call, a git-cause
// pair, an errno pair and the documentation table — so a rule that breaks takes
// one of them with it.
check('the enumeration was discovered from the shipping source', DECLARED.size >= 40, `${DECLARED.size} codes`);
for (const [code, why] of [
  ['permission_denied', 'a `code:` property, in permissions.js'],
  ['merge_conflict', 'a multi-line problem() call, in domains.js'],
  ['not_editable', 'a no() call, in the Agent API'],
  ['no_branch', 'a GIT_CAUSES pair'],
  ['exists', 'an ERRNO_CODES pair'],
  ['bad_topic', 'the tool layer'],
  ['undo_failed', 'the published table, for a code the renderer mints'],
]) {
  check(`  and it found ${code} — ${why}`, DECLARED.has(code), [...DECLARED.keys()].sort().join(', '));
}

// ── THE CAPS THE SURFACE DECLARES ────────────────────────────────────────────
//
// Two of them are exported and are read as values. The two conflict budgets are
// not, so they are read out of domains.js by name — and the read is asserted, so
// a rename turns into a failure here rather than into a bound nothing checks.
const { MAX_LIST, MAX_TEXT_BYTES } = DOMAINS_MODULE;
const DOMAINS_SOURCE = fs.readFileSync(path.join(REPO, 'electron/mcp/agent/domains.js'), 'utf8');
const capOf = (name) => {
  const m = DOMAINS_SOURCE.match(new RegExp(`const ${name} = ([\\d_]+);`));
  return m ? Number(m[1].replace(/_/g, '')) : null;
};
const MAX_CONFLICT_BYTES = capOf('MAX_CONFLICT_BYTES');
const MAX_CONFLICT_ENVELOPE_BYTES = capOf('MAX_CONFLICT_ENVELOPE_BYTES');
check('the surface exports the two caps every bounded list is cut to', Number.isInteger(MAX_LIST) && Number.isInteger(MAX_TEXT_BYTES), short({ MAX_LIST, MAX_TEXT_BYTES }));
check(
  'and domains.js still names the two conflict budgets this file reads by name',
  Number.isInteger(MAX_CONFLICT_BYTES) && Number.isInteger(MAX_CONFLICT_ENVELOPE_BYTES),
  short({ MAX_CONFLICT_BYTES, MAX_CONFLICT_ENVELOPE_BYTES })
);

// ── THE ORACLES ──────────────────────────────────────────────────────────────

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const gitQuiet = (cwd, ...args) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.astro', '.vercel', '.netlify']);

/**
 * Every byte of the project, plus git's own view of it.
 *
 * This is the truthfulness oracle and it is deliberately not clever: a digest
 * per file, and the four things git can tell you that a file digest cannot —
 * which commit you are on, which branch, what the index thinks, and whether a
 * merge is half-finished. A refusal that says "nothing was changed" is measured
 * against this and against nothing it wrote itself.
 */
function snapshot(root) {
  const files = {};
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files[`${rel}/`] = 'dir';
        walk(abs, rel);
      } else if (entry.isSymbolicLink()) {
        files[rel] = `link:${fs.readlinkSync(abs)}`;
      } else {
        try {
          files[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('base64url').slice(0, 16);
        } catch {
          files[rel] = 'unreadable';
        }
      }
    }
  };
  walk(root, '');
  return {
    files,
    head: gitQuiet(root, 'rev-parse', 'HEAD'),
    branch: gitQuiet(root, 'rev-parse', '--abbrev-ref', 'HEAD'),
    branches: gitQuiet(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'),
    status: gitQuiet(root, 'status', '--porcelain'),
    merging: fs.existsSync(path.join(root, '.git', 'MERGE_HEAD')),
  };
}

/** What moved between two snapshots, in words. Empty when nothing did. */
function movement(before, after) {
  const moved = [];
  for (const key of ['head', 'branch', 'branches', 'status', 'merging']) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) moved.push(`${key}: ${short(before[key], 90)} -> ${short(after[key], 90)}`);
  }
  const names = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  for (const name of names) {
    if (before.files[name] !== after.files[name]) moved.push(`${name}: ${before.files[name] ?? '(absent)'} -> ${after.files[name] ?? '(absent)'}`);
  }
  return moved;
}

/**
 * Anything in a payload that names a place on this machine.
 *
 * Over the WHOLE serialized payload rather than over `.message`, because the
 * defect this is written against had a scrubbed message and an absolute path two
 * levels down in `restored.failed`. The fixture root, its realpath (macOS serves
 * /var as a link to /private/var, so a handler that resolved a path answers the
 * other spelling), the temp directory and the home directory are the four that
 * can actually appear; the shape rule behind them catches a fifth nobody thought
 * of.
 */
function hostPathsIn(payload, root) {
  const text = JSON.stringify(payload ?? null);
  const hits = [];
  const named = [
    ['the fixture root', root],
    ['the fixture root, resolved', fs.realpathSync(root)],
    ['the temp directory', os.tmpdir()],
    ['the home directory', os.homedir()],
  ];
  for (const [what, needle] of named) {
    if (needle && needle !== '/' && text.includes(needle)) hits.push(`${what} (${needle})`);
  }
  // And the shape, for a path from somewhere none of the four covers. Anchored
  // on a quote or a space so that a project-relative `src/pages/index.astro` —
  // which every one of these refusals is allowed and expected to name — is not
  // mistaken for one.
  for (const m of text.matchAll(/(?:^|["'`\s(])(\/(?:Users|home|var|private|tmp|opt|etc|Applications|Library)\/[^"'`\s)]{2,})/g)) {
    hits.push(`an absolute path: ${m[1].slice(0, 80)}`);
  }
  return hits;
}

/** Every array and every string in a payload, with the path that reaches it. */
function measures(payload) {
  const arrays = [];
  const strings = [];
  const walk = (value, at) => {
    if (Array.isArray(value)) {
      arrays.push([at, value.length]);
      value.forEach((v, i) => walk(v, `${at}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, at ? `${at}.${k}` : k);
    } else if (typeof value === 'string') {
      strings.push([at, Buffer.byteLength(value, 'utf8')]);
    }
  };
  walk(payload, '');
  return { arrays, strings };
}

// ── WHAT EACH FAMILY WAS PROVED WITH ─────────────────────────────────────────
//
// Filled in as the sweep runs, and divided by DECLARED at the bottom.
const EXERCISED = new Map(); // code -> how it was reached, on the wire
const GRADED = new Map(); // code -> why the wire cannot reach it, and what was graded instead
const UNREACHABLE = new Map(); // code -> the proof that nothing can produce it

(async () => {
  // ── 1. THE PREMISE, MEASURED ───────────────────────────────────────────────
  //
  // Two tools, one payload, one bit of difference. Whatever this reports is what
  // the SDK in node_modules actually does.
  {
    const said = await withPremiseServer(async (client) => ({
      success: await client.callTool({ name: 'malformed_success', arguments: {} }),
      refusal: await client.callTool({ name: 'malformed_refusal', arguments: {} }),
    }));
    const successText = String(said.success?.content?.[0]?.text || '');
    check(
      'a schema-invalid SUCCESS is destroyed in flight',
      said.success?.structuredContent === undefined && said.success?.isError === true,
      short(said.success)
    );
    check('  and the client is told why, by name', /Output validation error/.test(successText), successText.slice(0, 200));
    check(
      'a schema-invalid REFUSAL is delivered intact — output validation is SKIPPED on isError',
      said.refusal?.isError === true && said.refusal?.structuredContent?.wanted === MALFORMED.wanted,
      short(said.refusal)
    );
    check(
      '  including the field the schema does not declare at all',
      said.refusal?.structuredContent?.unexpected === MALFORMED.unexpected,
      short(said.refusal?.structuredContent)
    );
    // Said out loud: this is the justification for the whole file, and if it
    // ever inverts the two assertions above are the ones that will say so.
    check(
      'so nothing between Stacki and a client checks the shape of a refusal',
      said.refusal?.structuredContent !== undefined && said.success?.structuredContent === undefined,
      'if this fails, the SDK has started validating refusals and this file is now a belt on a working brace'
    );
  }

  // ── 2. THE GATE, FIRST AND ON ITS OWN ──────────────────────────────────────
  //
  // `permission_denied` is the refusal a client meets most often and the only
  // one the rig below cannot produce: it runs at `full`, which allows
  // everything. So it needs a second wire — and a second wire cannot be started
  // beside the first.
  //
  // MEASURED, not assumed. test/agent-harness.js loads electron/main.js ONCE per
  // process and `openProjectRoot` is one module-level value in it, so a second
  // `startWireRig` re-points the main process at ITS fixture and leaves it there
  // — stopping it does not put the first one back. With the two the other way
  // round, every main-process write in the sweep above answered
  // `{ok:false, code:'failed', message:'Refusing to touch a file outside the
  // open project.'}` for a path plainly inside it, and the positive control at
  // the bottom of this file is what noticed. Nested rigs are not a thing this
  // harness does; this one is opened, asked its single question, and closed
  // before the real one starts.
  const denied = await (async () => {
    const gate = await startWireRig({ era: 'modern', agentMode: 'visual' });
    try {
      return await gate.call('git', 'status', {});
    } finally {
      const said = await gate.stop();
      check('the gate rig left nothing behind', (said?.problems || []).length === 0, (said?.problems || []).join('; '));
    }
  })();

  // ── 3. A REAL SURFACE, A REAL REPOSITORY ───────────────────────────────────
  const rig = await startWireRig({
    era: 'modern',
    agentMode: 'full',
    // The product ships with an audit, and `audit` is the one tool here whose
    // declared output schema is STRICT — it names the fields a refusal carries
    // rather than being loose about them. It is therefore the only tool on this
    // wire where "the refusal validates" is a claim about undeclared fields as
    // well as about declared ones, which is why it is registered even though the
    // engine behind it is never asked to run.
    audit: async () => ({ ok: true, route: '/', findingCount: 0, returnedFindingCount: 0, findings: [] }),
  });
  const root = rig.root;
  const problems = [];

  try {
    const listed = await rig.client.listTools();
    const tools = new Map(listed.tools.map((t) => [t.name, t]));
    const validator = new AjvJsonSchemaValidator();
    /** The SDK's own verdict, against the schema the WIRE handed the client. */
    const verdictOf = (schema, payload) =>
      payload === undefined || payload === null
        ? { valid: false, errorMessage: 'no structuredContent' }
        : validator.getValidator(schema)(payload);

    // A CONTROL ON THE VALIDATOR, before anything is graded with it. Every
    // schema verdict below is worth exactly what this is: a validator that said
    // yes to everything would make the whole file green and meaningless.
    {
      const envelope = tools.get('git')?.outputSchema;
      check('the git tool publishes an output schema', !!envelope, short([...tools.keys()]));
      check('  and the validator accepts a well-formed envelope', verdictOf(envelope, { ok: false, code: 'x', message: 'y' }).valid === true, '');
      check('  and REFUSES one whose declared field has the wrong type', verdictOf(envelope, { ok: false, code: 12, message: 'y' }).valid === false, '');
      check('  and refuses one that is not an envelope at all', verdictOf(envelope, { code: 'x' }).valid === false, '');
    }

    // The repository the git families are provoked against. Made here rather
    // than by the rig, because a project with no history is itself one of the
    // states under test — `no_repo` is asked for before this runs.
    const noRepo = await rig.call('git', 'status', {});
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'refusal@example.com');
    git(root, 'config', 'user.name', 'Refusal Contract');
    git(root, 'config', 'commit.gpgsign', 'false');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'the project as the fixture builds it');

    // ── the sweep ────────────────────────────────────────────────────────────
    const observed = [];
    /**
     * One refusal, bracketed by the disk.
     *
     * `setup` runs BEFORE the first snapshot, so a case that has to arrange the
     * world — write an obstruction, dirty a file, make two branches disagree —
     * is not measured as if the operation had done it.
     */
    const provoke = async (label, code, tool, action, args, { setup = null } = {}) => {
      if (setup) await setup();
      const before = snapshot(root);
      const { envelope, raw } = action ? await rig.call(tool, action, args) : await rig.tool(tool, args);
      const after = snapshot(root);
      observed.push({ label, want: code, tool, action, envelope, isError: raw?.isError === true, before, after });
      return envelope;
    };

    observed.push({
      label: 'git.status on a project with no history',
      want: 'no_repo',
      tool: 'git',
      action: 'status',
      envelope: noRepo.envelope,
      isError: noRepo.raw?.isError === true,
      // Nothing to compare: `git init` ran between this call and here, and that
      // is the test's own doing. The other four promises still apply.
      before: null,
      after: null,
    });

    const index = await rig.call('source', 'read', { path: 'src/pages/index.astro' });
    check('the fixture can be read, so the refusals below are refusals and not an empty project', index.envelope?.ok === true, short(index.envelope, 120));
    const indexDigest = index.envelope?.digest;

    // ARGUMENTS, ACTIONS AND THE GATE
    await provoke('a mistyped branch name', 'bad_arguments', 'git', 'checkout', { branch: 12 });
    await provoke('an action this tool does not have', 'bad_action', 'git', 'not_an_action', {});
    // THE ONE TOOL WITH A STRICT OUTPUT SCHEMA. Every other schema on this wire
    // is loose about fields it does not name, so "the refusal validates" is a
    // claim about the DECLARED fields having the declared types. `audit` names
    // what a refusal carries and closes the object around it, which makes it the
    // only place a field nobody declared is caught rather than carried.
    await provoke('a viewport list that is not a list', 'bad_arguments', 'audit', null, { viewports: 'phone' });

    // REFS — the four ways a handle can fail, three of them minted here so the
    // state they describe is real rather than described.
    await provoke('a string that was never a ref', 'bad_ref', 'target', 'read', { ref: 'not-a-stacki-ref-at-all' });
    await provoke('a ref that has expired', 'stale_ref', 'source', 'write', {
      path: 'src/pages/index.astro',
      text: 'this must never be written',
      ref: refs.mint('source', { path: 'src/pages/index.astro' }, { projectRoot: root, ttlMs: -1000 }),
    });
    await provoke('a ref minted about another project', 'wrong_project', 'source', 'write', {
      path: 'src/pages/index.astro',
      text: 'this must never be written',
      ref: refs.mint('source', { path: 'src/pages/index.astro' }, { projectRoot: `${root}-somewhere-else` }),
    });
    await provoke('a ref that names the wrong kind of thing', 'wrong_kind', 'source', 'write', {
      path: 'src/pages/index.astro',
      text: 'this must never be written',
      ref: refs.mint('asset', { path: 'src/pages/index.astro' }, { projectRoot: root }),
    });

    // THE CONCURRENCY GUARD
    await provoke('replacing a file without saying which version', 'guard_required', 'source', 'write', {
      path: 'src/pages/index.astro',
      text: 'this must never be written',
    });
    await provoke('replacing a file that moved since the read', 'stale_target', 'source', 'write', {
      path: 'src/pages/index.astro',
      text: 'this must never be written',
      expectedDigest: 'deadbeefdeadbeef',
    });
    await provoke('a range that starts past the end of the file', 'bad_range', 'source', 'read', {
      path: 'src/pages/index.astro',
      startLine: 9999,
    });
    // A REF THAT GUARDS THE WRONG FILE. Not a version disagreement — the handle
    // is about a different object entirely, and saying so is the difference
    // between "read it again" and "you have the wrong ref".
    await provoke('a ref that guards a different file', 'wrong_target', 'source', 'write', {
      path: 'src/pages/index.astro',
      text: 'this must never be written',
      ref: refs.mint('source', { path: 'src/pages/about.astro' }, { projectRoot: root, observed: { digest: 'x', file: 'src/pages/about.astro' } }),
    });
    // A REF THAT MAY BE READ AND NOT WRITTEN. `w:false` is how the review
    // evidence rules hand out a handle to something recovered on position
    // alone; the write path has to refuse it before the window is asked to do
    // anything.
    await provoke('a write through a read-only ref', 'not_editable', 'target', 'set_text', {
      ref: refs.mint('node', { path: 'src/pages/index.astro' }, { projectRoot: root, writable: false }),
      text: 'this must never be written',
    });

    // PATHS AND CONTENT
    await provoke('an absolute path', 'outside_project', 'source', 'read', { path: '/etc/hosts' });
    await provoke('a page folder with no name', 'bad_path', 'page', 'folder_create', { dir: '' });
    await provoke('a page that is not there', 'no_file', 'page', 'read', { path: 'src/pages/nope.astro' });
    await provoke('a file Stacki has no tree for', 'unrepresentable', 'page', 'read', { path: 'package.json' });
    await provoke('an import that resolves to nothing', 'not_found', 'source', 'resolve_path', {
      fromFile: 'src/pages/index.astro',
      spec: '@/nowhere/at/all',
    });
    await provoke('a layout this project does not have', 'no_layout', 'page', 'create', { name: 'never-created', layout: 'no-such-layout' });
    await provoke('a collection this project does not have', 'no_collection', 'content', 'entries', { collection: 'no-such-collection' });
    await provoke('renaming an asset onto one that is already there', 'exists', 'asset', 'rename', {
      path: 'public/spare.txt',
      name: 'robots.txt',
    });

    // GIT, AGAINST A REAL REPOSITORY
    await provoke('a commit with nothing to commit', 'nothing_to_commit', 'git', 'commit', { message: 'nothing has changed' });
    await provoke('a commit with no message', 'bad_request', 'git', 'commit', { message: '   ' });
    await provoke('a branch that is not there', 'no_branch', 'git', 'checkout', { branch: 'no-such-branch' });
    await provoke('a revision that is not there', 'no_ref', 'git', 'file_at', { ref: 'no-such-ref', path: 'src/pages/index.astro' });
    await provoke('a file that did not exist at that revision', 'missing_at_ref', 'git', 'restore_file', { path: 'public/never-existed.txt', ref: 'HEAD' }, {
      // The file has to exist NOW and not THEN, or the refusal is about the
      // working tree rather than about the revision.
      setup: () => fs.writeFileSync(path.join(root, 'public/never-existed.txt'), 'made after the commit\n'),
    });
    await provoke('deleting a branch whose work is nowhere else', 'unmerged_branch', 'git', 'delete_branch', { branch: 'unmerged-work' }, {
      setup: () => {
        git(root, 'checkout', '-q', '-b', 'unmerged-work');
        fs.writeFileSync(path.join(root, 'public/only-on-this-branch.txt'), 'work\n');
        git(root, 'add', '-A');
        git(root, 'commit', '-q', '-m', 'work that is only here');
        git(root, 'checkout', '-q', 'main');
      },
    });

    // THE TWO BRANCHES THAT GENUINELY DISAGREE, and the three refusals that
    // come out of the state they make. Nothing is simulated: git does the
    // merge, git finds the conflict, and git is asked afterwards whether the
    // repository moved.
    const conflict = await provoke('a merge that conflicts', 'merge_conflict', 'git', 'merge', { branch: 'other' }, {
      setup: () => {
        git(root, 'checkout', '-q', '-b', 'other');
        fs.writeFileSync(path.join(root, 'src/pages/index.astro'), '---\n---\n<h1>the other branch</h1>\n');
        git(root, 'add', '-A');
        git(root, 'commit', '-q', '-m', 'the other branch');
        git(root, 'checkout', '-q', 'main');
        fs.writeFileSync(path.join(root, 'src/pages/index.astro'), '---\n---\n<h1>this branch</h1>\n');
        git(root, 'add', '-A');
        git(root, 'commit', '-q', '-m', 'this branch');
      },
    });
    // THE HANDLE THAT SAYS WHICH CONFLICT. `resolve_merge` will not act without
    // it, which makes three more refusals real rather than hypothetical: no
    // handle, the wrong handle, and a vocabulary nobody can read.
    const mergeRef = conflict?.mergeRef;
    check('the conflict handed back a mergeRef to finish it with', typeof mergeRef === 'string' && mergeRef.length > 8, short(mergeRef, 60));
    // Refused by the SCHEMA, one step before the API's own `guard_required` for
    // a missing mergeRef: `mergeRef` is required on the published branch, so the
    // guard behind it is a second fence rather than the first. Asserted as
    // bad_arguments deliberately — `guard_required` here would mean the schema
    // had stopped requiring it.
    await provoke('finishing a merge without saying which one', 'bad_arguments', 'git', 'resolve_merge', {
      choices: { 'src/pages/index.astro': 'ours' },
    });
    await provoke('answers paired with the wrong merge', 'wrong_target', 'git', 'resolve_merge', {
      mergeRef,
      branch: 'main',
      choices: { 'src/pages/index.astro': 'ours' },
    });
    await provoke('a resolution nobody can read', 'bad_choices', 'git', 'resolve_merge', {
      mergeRef,
      branch: 'other',
      choices: { 'src/pages/index.astro': 'whichever-one-is-nicer' },
    });
    await provoke('a switch that would overwrite uncommitted work', 'working_tree_blocked', 'git', 'checkout', { branch: 'other', parkFirst: false }, {
      setup: () => fs.writeFileSync(path.join(root, 'src/pages/index.astro'), '---\n---\n<h1>not committed</h1>\n'),
    });
    git(root, 'checkout', '-q', '--', '.');

    // AND THE ONE THAT LANDED WHILE THIS WAS BEING WRITTEN. `resolve_merge` grew
    // a staleness guard on this branch: a mergeRef stops being an answer to
    // anything once either side has moved.
    //
    // ON A CONFLICT OF ITS OWN, and that is not tidiness. Run against the
    // conflict above — after three refused resolves, a blocked checkout and a
    // `git checkout -- .` — this answered `ok: true, changed: true` on roughly
    // one run in four while answering `stale_merge` on the rest. Isolated, it is
    // the same answer five times out of five. Whatever the interference is it
    // belongs to the earlier calls rather than to the guard, and a probe that
    // cannot say which is not a probe.
    //
    // Deliberately WITHOUT naming the code it expects: the sequence is run for
    // real and whatever comes back is held to the same five promises as
    // everything else, with one assertion of its own below the sweep — the
    // enumeration has to be able to name it. That is what caught `stale_merge`
    // arriving mid-run, and it is what will catch the next one without this file
    // being edited.
    const staleMerge = await (async () => {
      const at = (side) => fs.writeFileSync(path.join(root, 'stale-conflict.txt'), `${side}\n`);
      at('base');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'a file for the staleness probe');
      git(root, 'checkout', '-q', '-b', 'stale-other');
      at('theirs');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'their answer');
      git(root, 'checkout', '-q', 'main');
      at('ours');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'our answer');
      const { envelope: clash } = await rig.call('git', 'merge', { branch: 'stale-other' });
      check('the staleness probe starts from a real conflict', clash?.code === 'merge_conflict', short(clash, 160));
      check('  which handed back a handle to finish it with', typeof clash?.mergeRef === 'string', short(clash?.mergeRef, 40));
      return provoke('answers to a conflict that has since moved', null, 'git', 'resolve_merge', {
        mergeRef: clash?.mergeRef,
        branch: 'stale-other',
        choices: { 'stale-conflict.txt': 'ours' },
      }, {
        setup: () => {
          fs.writeFileSync(path.join(root, 'public/moved-on.txt'), 'a commit landed after the conflict\n');
          git(root, 'add', '-A');
          git(root, 'commit', '-q', '-m', 'a commit after the conflict');
        },
      });
    })();

    // THE PREVIEW
    await provoke('probing a project nothing is serving', 'no_preview', 'project', 'probe', {});

    // THE UNDO STACK. Both halves, and both provoked the way a person provokes
    // them: something is standing where the inverse has to put a file back.
    {
      fs.writeFileSync(path.join(root, 'public/collide.svg'), '<svg/>\n');
      const renamed = await rig.call('asset', 'rename', { path: 'public/collide.svg', name: 'renamed.svg' });
      check('an asset rename lands, so there is something on the stack to undo', renamed.envelope?.ok === true, short(renamed.envelope, 160));
      await provoke('an undo whose inverse cannot run', 'undo_failed', 'project', 'undo', {}, {
        setup: () => fs.writeFileSync(path.join(root, 'public/collide.svg'), 'standing in the way\n'),
      });
      fs.rmSync(path.join(root, 'public/collide.svg'));
      const undone = await rig.call('project', 'undo', {});
      check('  with the obstruction gone the same undo goes through', undone.envelope?.ok === true, short(undone.envelope, 160));
      await provoke('a redo whose command cannot run', 'redo_failed', 'project', 'redo', {}, {
        setup: () => fs.writeFileSync(path.join(root, 'public/renamed.svg'), 'standing in the way\n'),
      });
      fs.rmSync(path.join(root, 'public/renamed.svg'));
    }

    // A REFUSAL BUILT FROM A RAW fs THROW, WHICH IS THE ONE THE SCRUBBER EXISTS FOR.
    //
    // Every other refusal in this sweep is composed by Stacki, out of strings
    // Stacki chose, so none of them ever had a host path in it to begin with —
    // which made the SANITIZED promise above unfalsifiable: deleting host-path
    // scrubbing from the product entirely left this suite reporting the
    // identical green. The one shape that genuinely carries the machine's
    // layout is an errno bubbling up from the filesystem, where the text is
    // node's rather than ours: "EACCES: permission denied, open
    // '/var/folders/.../src/pages/index.astro'".
    //
    // So the file is made unwritable and written to. Both halves are asserted:
    // that the refusal names nothing on this machine, AND — separately, against
    // the same locked file — that an unscrubbed attempt at the same write really
    // does produce an absolute path. Without that second half this is one more
    // assertion about a payload that never had anything to hide.
    {
      const rel = 'src/pages/index.astro';
      const abs = path.join(root, rel);
      const read = await rig.call('source', 'read', { path: rel });
      const ref = read.envelope?.ref;
      const raw = (() => {
        try {
          fs.chmodSync(abs, 0o444);
          fs.writeFileSync(abs, 'probe\n');
          return null;
        } catch (err) {
          return String(err?.message || err);
        }
      })();
      check(
        'a locked file really does throw an errno naming this machine',
        typeof raw === 'string' && hostPathsIn({ message: raw }, root).length > 0,
        short({ raw })
      );
      try {
        await provoke('a write the filesystem refuses', null, 'source', 'write', {
          path: rel,
          ref,
          text: '---\n---\n<p>blocked</p>\n',
          expectedDigest: read.envelope?.digest,
        });
      } finally {
        fs.chmodSync(abs, 0o644);
      }
      const fsRefusal = observed[observed.length - 1]?.envelope;
      check('  and the refusal that comes back is a refusal', fsRefusal?.ok === false, short(fsRefusal, 200));
      check(
        '  and it carries none of that path, though the errno behind it did',
        hostPathsIn(fsRefusal, root).length === 0,
        hostPathsIn(fsRefusal, root).join('; ')
      );
    }

    // THE GATE. Collected before this rig existed, for the reason written at the
    // top of section 2.
    observed.push({
      label: 'an operation the granted level does not allow',
      want: 'permission_denied',
      tool: 'git',
      action: 'status',
      envelope: denied.envelope,
      isError: denied.raw?.isError === true,
      before: null,
      after: null,
    });
    check('the gate refusal names the level in force and the level needed', denied.envelope?.mode === 'visual' && denied.envelope?.requires === 'inspect', short(denied.envelope, 200));

    // ── 4. THE FIVE PROMISES, OVER EVERY ONE OF THEM ───────────────────────────
    check('the sweep provoked a real spread of families', observed.length >= 25, `${observed.length} refusals`);
    for (const seen of observed) {
      const { label, want, tool, envelope, isError, before, after } = seen;
      const where = `${label} [${tool}${seen.action ? `.${seen.action}` : ''}]`;

      // It is a refusal at all, and it is the one this case is about. Without
      // this the four promises below would be satisfied by a surface that
      // answered `ok: true` to everything.
      if (!check(`${where} is refused`, envelope?.ok === false, short(envelope, 200))) continue;
      // `want` is null for the one case whose code is not settled yet — the
      // staleness guard being written on this branch. It is held to every other
      // promise, and to a named assertion of its own below the sweep.
      if (want) check(`  ${where}: as ${want}`, envelope?.code === want, short({ code: envelope?.code, message: envelope?.message }));

      // ACTIONABLE
      check(`  ${where}: with a code the surface declares`, typeof envelope?.code === 'string' && DECLARED.has(envelope.code), short(envelope?.code));
      check(`  ${where}: and a sentence to show somebody`, typeof envelope?.message === 'string' && envelope.message.length > 0, short(envelope?.message));
      // AND THE CLIENT IS TOLD. This is the bit that buys the unvalidated
      // channel proved in section 1: a host keying off `isError` records a
      // refused call as refused.
      check(`  ${where}: marked isError on the wire`, isError === true, short({ isError }));

      // SCHEMA — against the schema THAT TOOL published, on this wire.
      const schema = tools.get(tool)?.outputSchema;
      if (check(`  ${where}: its tool publishes an output schema`, !!schema, tool)) {
        const verdict = verdictOf(schema, envelope);
        check(`  ${where}: validates against it`, verdict.valid === true, `${verdict.errorMessage || ''}\n    ${short(envelope)}`);
      }

      // BOUNDED
      const { arrays, strings } = measures(envelope);
      const longArray = arrays.find(([, n]) => n > MAX_LIST);
      check(`  ${where}: no list longer than the ${MAX_LIST} the surface caps at`, !longArray, longArray ? `${longArray[0]} has ${longArray[1]}` : '');
      const longString = strings.find(([, n]) => n > MAX_TEXT_BYTES);
      check(`  ${where}: no string longer than the ${MAX_TEXT_BYTES} bytes it caps at`, !longString, longString ? `${longString[0]} is ${longString[1]} bytes` : '');

      // SANITIZED — the whole payload, not the message.
      const leaks = hostPathsIn(envelope, root);
      check(`  ${where}: names no place on this machine, on any field`, leaks.length === 0, leaks.join('; '));

      // TRUTHFUL — asked of the disk and of git, never of the envelope.
      if (before && after) {
        const moved = movement(before, after);
        check(`  ${where}: and the project is exactly as it was`, moved.length === 0, moved.slice(0, 6).join('\n    '));
      }
      for (const code of [envelope?.code]) if (typeof code === 'string') EXERCISED.set(code, where);
    }

    // THE ONE THAT IS STILL BEING WRITTEN. Whatever `resolve_merge` answers for
    // a conflict that has moved, the enumeration has to be able to name it —
    // that is the whole point of discovering the list from the source rather
    // than typing it here. The day the guard lands, this passes without anybody
    // editing this file; the day it lands with a code nothing declares, it does
    // not.
    check(
      'the answer to a merge that moved carries a code the surface declares',
      typeof staleMerge?.code === 'string' && DECLARED.has(staleMerge.code),
      short({ code: staleMerge?.code, message: staleMerge?.message })
    );

    // AND THE ORACLE CAN SEE A CHANGE. Every truthfulness assertion above is a
    // comparison of two snapshots, so a snapshot that could not tell two states
    // apart would make all of them free. One file, written by the test itself.
    {
      const before = snapshot(root);
      fs.writeFileSync(path.join(root, 'public/oracle-control.txt'), 'the oracle has to see this\n');
      const after = snapshot(root);
      const moved = movement(before, after);
      check('the disk oracle notices a single new file', moved.length > 0 && moved.some((m) => m.includes('oracle-control.txt')), moved.join('; '));
      fs.rmSync(path.join(root, 'public/oracle-control.txt'));
      check('  and stops noticing when it is taken away again', movement(before, snapshot(root)).length === 0, movement(before, snapshot(root)).join('; '));
      // And it sees the repository move, which no file digest can: a commit
      // changes HEAD and nothing under the working tree.
      const head = snapshot(root);
      git(root, 'commit', '-q', '--allow-empty', '-m', 'a commit the oracle must notice');
      check('  and it notices a commit that touched no file', movement(head, snapshot(root)).some((m) => m.startsWith('head:')), movement(head, snapshot(root)).join('; '));
      git(root, 'reset', '-q', '--hard', 'HEAD~1');
    }

    // AND THE SANITIZER CAN SEE A PATH. Same argument: a scanner that found
    // nothing anywhere would make twenty-odd assertions free.
    {
      const planted = { ok: false, code: 'failed', message: 'scrubbed', restored: { failed: path.join(root, 'src/styles/site.css') } };
      check('the path scanner finds one buried two levels down', hostPathsIn(planted, root).length > 0, short(hostPathsIn(planted, root)));
      check('  and passes a payload that names only project-relative paths', hostPathsIn({ ok: false, message: 'src/styles/site.css is not in this project.' }, root).length === 0, '');
      // AND IN THE SHAPE AN fs ERROR ACTUALLY USES. The lead character class
      // did not include an apostrophe, so the one form every Node fs failure
      // produces — and the very form quoted in this scanner's own comment,
      // `open '/var/folders/.../site.css'` — was invisible to it. A scanner
      // blind to the shape it was written for makes every assertion that uses
      // it free.
      const quoted = { ok: false, code: 'failed', message: "EACCES: permission denied, open '/Users/someone/secret/site.css'" };
      check('  and finds one in the single-quoted form fs errors use', hostPathsIn(quoted, root).length > 0, short(hostPathsIn(quoted, root)));
      const backticked = { ok: false, code: 'failed', message: 'cannot rename `/opt/other/a`' };
      check('  and in a backticked one', hostPathsIn(backticked, root).length > 0, short(hostPathsIn(backticked, root)));
    }

    // ── 5. THE BOUNDS, PROVOKED RATHER THAN ASSUMED ────────────────────────────
    //
    // The largest thing this surface can be made to say is a conflicted merge:
    // the handler hands the panel BOTH COMPLETE VERSIONS of every clashing file,
    // and the cap on the way out to a client is the only thing between an agent
    // and a payload no host will deliver. Four hundred and fifty conflicting
    // files, so the list cap, the per-file cap and the running envelope budget
    // all have to bite in one answer.
    {
      const bulk = (side) => {
        fs.mkdirSync(path.join(root, 'bulk'), { recursive: true });
        for (let i = 0; i < 450; i += 1) fs.writeFileSync(path.join(root, 'bulk', `f${i}.md`), `${side} ${i}\n${side.repeat(400)}\n`);
      };
      git(root, 'checkout', '-q', '-b', 'bulk-theirs');
      bulk('theirs');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'bulk theirs');
      git(root, 'checkout', '-q', 'main');
      bulk('ours');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'bulk ours');

      const before = snapshot(root);
      const { envelope: big } = await rig.call('git', 'merge', { branch: 'bulk-theirs' });
      const after = snapshot(root);
      check('four hundred and fifty conflicting files is still a merge_conflict', big?.code === 'merge_conflict', short({ code: big?.code }));
      check('  and it reports the TRUE number it found', big?.conflictCount === 450, short({ conflictCount: big?.conflictCount }));
      check(`  and sends at most the ${MAX_LIST} the surface caps a list at`, Array.isArray(big?.files) && big.files.length === MAX_LIST, short({ files: big?.files?.length }));
      check('  and says how many it left out rather than pretending it sent them all', big?.filesOmitted === 450 - MAX_LIST, short({ filesOmitted: big?.filesOmitted }));
      const carried = (big?.files || []).filter((f) => !f.hunksOmitted);
      const spent = carried.reduce((n, f) => n + Buffer.byteLength(JSON.stringify(f.hunks ?? null), 'utf8'), 0);
      check('  and the hunks it did carry are inside the envelope budget', spent <= MAX_CONFLICT_ENVELOPE_BYTES, `${spent} of ${MAX_CONFLICT_ENVELOPE_BYTES}`);
      check('  with the files it could not afford keeping their path and saying so', carried.length < big.files.length && big.files.every((f) => typeof f.path === 'string'), short({ carried: carried.length, of: big?.files?.length }));
      const biggest = Math.max(0, ...carried.map((f) => Buffer.byteLength(JSON.stringify(f.hunks ?? null), 'utf8')));
      check(`  and no single file over the ${MAX_CONFLICT_BYTES}-byte per-file cap`, biggest <= MAX_CONFLICT_BYTES, `${biggest}`);
      check('  and the repository is exactly as it was', movement(before, after).length === 0, movement(before, after).slice(0, 4).join('\n    '));
      check('  and it names no place on this machine', hostPathsIn(big, root).length === 0, short(hostPathsIn(big, root)));
      EXERCISED.set('merge_conflict', 'a merge of 450 conflicting files [git.merge]');

      // THE POSITIVE CONTROL FOR THE CAP ITSELF: an answer that is genuinely
      // small must not be cut. A `filesOmitted` that was always non-zero, or a
      // `hunksOmitted` that was always true, would satisfy every assertion above
      // and describe a surface that never delivers anything.
      const one = observed.find((o) => o.want === 'merge_conflict')?.envelope;
      check('a conflict small enough to send arrives whole', one?.filesOmitted === 0 && (one?.files || []).every((f) => f.hunksOmitted === false), short({ filesOmitted: one?.filesOmitted, files: one?.files?.length }));
      check('  with the clashing hunks actually in it', ((one?.files || [])[0]?.hunks || []).length > 0, short((one?.files || [])[0], 200));

      git(root, 'rm', '-r', '-q', 'bulk');
      git(root, 'commit', '-q', '-m', 'bulk removed');
    }

    // ── 6. THE FOUR THAT USED TO DEPEND ON NOT BEING CHECKED ──────────────────
    //
    // Ten of the fourteen published tools declare the refusal envelope as their
    // output schema, so a refusal from one of them is inside its own contract —
    // that is what the sweep above proved. Four did not: get_context, capture,
    // get_comments and comment declared the shape of the PAYLOAD they answer
    // with when they work, and `{ok:false, code, issues}` is not inside that
    // shape. Those refusals were delivered anyway, for one reason only: section
    // 1 measures both the SDK server and the official client skipping output
    // validation when `isError` is set.
    //
    // That made the published contract false, and left those four one SDK
    // change away from answering an argument mistake with NOTHING AT ALL rather
    // than with something wrong. They now publish `z.union([Payload, refusal])`
    // — the move `audit` already made by declaring the fields its gate refusal
    // carries — so the declaration is true and the success half is still
    // exactly a payload. This block asserts the refusal fits, and the sibling
    // assertion below asserts a payload-shaped answer still has to be a payload,
    // so the union cannot be read as "anything goes".
    {
      const PAYLOAD_SCHEMA_TOOLS = [
        ['get_context', { styleDetail: 'not-a-detail-level' }],
        ['capture', { target: 'not-a-target' }],
        ['get_comments', { scope: 'not-a-scope' }],
        ['comment', { action: 'not-an-action' }],
      ];
      for (const [name, bad] of PAYLOAD_SCHEMA_TOOLS) {
        const { envelope, raw } = await rig.tool(name, bad);
        check(`${name} refuses a bad argument in Stacki's own shape`, envelope?.ok === false && envelope?.code === 'bad_arguments', short(envelope, 200));
        check(`  ${name}: with the field named, so an agent can fix it`, (envelope?.issues || []).some((i) => Array.isArray(i.path) && i.path.length), short(envelope?.issues));
        check(`  ${name}: and isError set, which is the only thing telling the client`, raw?.isError === true, short({ isError: raw?.isError }));
        check(`  ${name}: it names no place on this machine`, hostPathsIn(envelope, root).length === 0, short(hostPathsIn(envelope, root)));
        const verdict = verdictOf(tools.get(name)?.outputSchema, envelope);
        check(
          `  ${name}: and it validates against the schema that tool publishes`,
          verdict.valid === true,
          `${verdict.errorMessage || ''}\n    ${short(envelope, 200)}`
        );
      }
      // AND THE NINE THAT DO. Named as a count so that a tool moving from one
      // group to the other is a decision somebody makes here.
      const envelopeTools = listed.tools.filter((t) => !PAYLOAD_SCHEMA_TOOLS.some(([n]) => n === t.name));
      check('ten of the fourteen tools declare a schema a refusal fits inside', envelopeTools.length === 10, envelopeTools.map((t) => t.name).join(', '));
      check('  and the other four now do too, so every published tool does', PAYLOAD_SCHEMA_TOOLS.length + envelopeTools.length === 14, String(listed.tools.length));

      // THE UNION MUST NOT BE A LOOPHOLE. Widening an output schema to admit a
      // refusal is only safe if the PAYLOAD half stayed strict: a union that
      // accepted anything would satisfy every assertion above and describe a
      // contract that promises nothing. So a payload-shaped answer with a field
      // of the wrong type must still be refused by the very same schema.
      for (const [name] of PAYLOAD_SCHEMA_TOOLS) {
        const schema = tools.get(name)?.outputSchema;
        const nonsense = verdictOf(schema, { ok: true, revision: 'not-a-number', wildlyUndeclared: true });
        check(`  ${name}: and a payload-shaped answer of the wrong type is still refused by it`, nonsense.valid === false, short(nonsense.errorMessage));
      }
    }

    // ── 7. THE EIGHT THE WIRE CANNOT REACH ─────────────────────────────────────
    //
    // Said plainly rather than quietly skipped. Each is graded IN PROCESS against
    // the schema the tool that would carry it publishes — the idiom
    // schema-dispatch-contract.js uses for get_context — and each names what it
    // would take to reach it on a wire.
    {
      const envelope = tools.get('git')?.outputSchema;
      const gradeInProcess = (code, why, payload, schema = envelope) => {
        const where = `in process: ${why}`;
        check(`${code}: the shipping implementation still produces it`, payload?.ok === false && payload?.code === code, short(payload, 200));
        check(`  ${code}: and its payload validates against the schema its tool publishes`, verdictOf(schema, payload).valid === true, `${verdictOf(schema, payload).errorMessage || ''}\n    ${short(payload)}`);
        check(`  ${code}: with no place on this machine in it`, hostPathsIn(payload, root).length === 0, short(hostPathsIn(payload, root)));
        check(`  ${code}: and a sentence`, typeof payload?.message === 'string' && payload.message.length > 0, short(payload?.message));
        GRADED.set(code, where);
      };

      // NO PROJECT. This rig always has one open; that is what a rig is. The
      // shipping api is built with the one thing changed that produces it.
      const closed = createAgentApi({ getProjectRoot: () => null, getAgentMode: () => 'full' });
      gradeInProcess('no_project', 'the shipping Agent API with nothing open', await closed.run('git', 'status', {}));

      // NO WINDOW, AND A WINDOW THAT DID NOT ANSWER. Both are states of the app
      // rather than of the project: this rig is a running Stacki with a live
      // renderer, and a rig that was not could not answer anything at all. The
      // shipping api is built with the one thing changed that produces each.
      const nodeRef = () =>
        refs.mint(
          'node',
          { path: 'src/pages/index.astro' },
          { projectRoot: root, observed: { file: 'src/pages/index.astro', revision: 0, digest: 'whatever-the-read-saw' } }
        );
      const noWindow = createAgentApi({ getProjectRoot: () => root, getAgentMode: () => 'full', callMain: async () => ({}) });
      gradeInProcess('no_window', 'the shipping Agent API with no renderer to ask', await noWindow.run('target', 'set_text', { ref: nodeRef(), text: 'x' }));
      const silent = createAgentApi({ getProjectRoot: () => root, getAgentMode: () => 'full', callMain: async () => ({}), ask: async () => null });
      gradeInProcess('not_ready', 'the shipping Agent API with a renderer that does not answer', await silent.run('target', 'set_text', { ref: nodeRef(), text: 'x' }));

      // THE PREVIEW FENCE. Both of these need `ctx.devUrl`, which means a real
      // Astro dev server bound to a port — twenty seconds and a network listener
      // for two refusals that are decided by a URL comparison. The shipping
      // mapper is called instead, with the ctx shape main really gives it.
      const probe = DOMAINS_MODULE.DOMAINS.project.probe;
      const served = { devUrl: 'http://127.0.0.1:4321', root };
      gradeInProcess('route_outside_project', 'project.probe’s own mapper, with a preview running', (await probe.args({ url: 'https://somewhere.else.example/x' }, served)).error);
      gradeInProcess('bad_route', 'project.probe’s own mapper, with a preview running', (await probe.args({ url: 'http://' }, served)).error);

      // THE CONTENT COLLECTIONS. Reaching these on the wire means installing the
      // fixture's own dependencies — reading a content config bundles it with the
      // project's esbuild — and without them every content question refuses as
      // `no_collection` before either of these is reached. The mapper is called
      // with the answer the handler really returns for each state.
      const listing = (raw) => ({ root, callMain: async () => raw });
      gradeInProcess(
        'read_only',
        'content’s own entry resolver, over a collection Stacki cannot write',
        (await DOMAINS_MODULE.resolveContentEntry({ collection: 'notes', id: 'first' }, listing({ readOnly: true, reason: 'notes comes from a loader.' }))).error
      );
      gradeInProcess(
        'no_entry',
        'content’s own entry resolver, over a collection that has no such entry',
        (await DOMAINS_MODULE.resolveContentEntry({ collection: 'notes', id: 'no-such-entry' }, listing({ entries: [] }))).error
      );

      // THE TERMINAL FALLBACK. `failed` is the code this codebase's own comment
      // calls "the code that means nobody knows", and provoking it end to end
      // means finding a cause the surface cannot name — which is a moving target
      // by definition, and one test/named-causes.js already attacks from the
      // other side. What is asserted here is the shape of the answer when it does
      // happen, on the real mapper, with an error nothing classifies.
      gradeInProcess('failed', 'the throw mapper, on a cause nothing in the tables names', DOMAINS_MODULE.thrownFailure(new Error('the disk went away mid-write'), { root }));
      // AND IT IS STILL THE FALLBACK AND NOT THE ANSWER. A mapper that had
      // started answering `failed` for causes it knows would satisfy the line
      // above and undo the whole of named-causes.js.
      check(
        '  failed: and a cause the tables DO name still gets its own code',
        DOMAINS_MODULE.thrownFailure(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT', path: path.join(root, 'src/pages/gone.astro') }), { root }).code === 'no_file',
        short(DOMAINS_MODULE.thrownFailure(Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: path.join(root, 'src/pages/gone.astro') }), { root }))
      );
    }

    // ── 8. THE TWO THAT ARE DEAD, PROVED RATHER THAN EXCUSED ───────────────────
    //
    // `bad_topic` is written down in agentTools.js and cannot happen. The tool
    // publishes `topic` as an enum over `Object.keys(TOPICS)`, `publishChecked`
    // runs that enum before the handler, and the handler's `if (!t)` branch is
    // therefore reachable only by a topic the enum accepts and TOPICS does not
    // have — which is the empty set by construction.
    //
    // Two halves, because either alone is an argument rather than a proof: the
    // enum is really the keys, and the wire really refuses everything else with
    // the other code.
    {
      const published = tools.get('get_capabilities')?.inputSchema?.properties?.topic?.enum || [];
      check('get_capabilities publishes its topics as an enum', published.length > 0, short(published));
      check(
        '  which is exactly the guides that exist, so no accepted topic can be missing',
        JSON.stringify([...published].sort()) === JSON.stringify([...Object.keys(TOPICS)].sort()),
        `published: ${published.join(', ')}\n    TOPICS: ${Object.keys(TOPICS).join(', ')}`
      );
      check('  and the exported topic names are the same set again', JSON.stringify([...TOPIC_NAMES].sort()) === JSON.stringify([...Object.keys(TOPICS)].sort()), short(TOPIC_NAMES));
      const { envelope: refused } = await rig.tool('get_capabilities', { topic: 'no-such-guide' });
      check('  so a topic that is not one comes back as bad_arguments, never bad_topic', refused?.code === 'bad_arguments', short(refused, 200));
      const { envelope: real } = await rig.tool('get_capabilities', { topic: published[0] });
      check('  and one that IS one is answered rather than refused', real?.ok === true && typeof real?.text === 'string' && real.text.length > 0, short({ ok: real?.ok, topic: real?.topic }));
      UNREACHABLE.set('bad_topic', 'the published enum is exactly Object.keys(TOPICS), so the handler’s not-found branch cannot be entered');
    }

    // AND THE SECOND ONE, FOR THE SAME REASON ONE LEVEL DOWN. `bad_operation`
    // guards the dispatcher's NORMALIZE table against an operation type it does
    // not have. The batch schema is a closed discriminated union over exactly
    // those types, and closing it is what schema-dispatch-contract.js asserts —
    // so an unknown `type` is refused by the schema as `bad_arguments` and the
    // guard behind it can never be reached from a client.
    {
      const editBranch = (tools.get('target')?.inputSchema?.anyOf || tools.get('target')?.inputSchema?.oneOf || []).find(
        (b) => b?.properties?.action?.const === 'edit' || b?.properties?.action?.enum?.[0] === 'edit'
      );
      const union = (editBranch?.properties?.operations?.items?.anyOf || editBranch?.properties?.operations?.items?.oneOf || [])
        .map((b) => b?.properties?.type?.const)
        .filter(Boolean);
      check('the batch schema publishes its operation types as a closed union', union.length > 0, short(union, 200));
      const { envelope: unknownOp } = await rig.call('target', 'edit', {
        ref: refs.mint('node', { path: 'src/pages/index.astro' }, { projectRoot: root }),
        operations: [{ type: 'no_such_operation' }],
      });
      check('  so an operation type it does not have is refused by the schema', unknownOp?.code === 'bad_arguments', short(unknownOp, 220));
      check('  which means nothing can reach the dispatcher’s own bad_operation guard', !union.includes('no_such_operation'), short(union, 200));
      UNREACHABLE.set('bad_operation', 'the published Operation union is closed, so an unknown type is bad_arguments before the dispatcher is asked');
    }

    // ── 9. EVERY DECLARED CODE IS ACCOUNTED FOR ────────────────────────────────
    {
      // TWO FAMILIES THAT BELONG TO ANOTHER LAYER. Both are named to a client —
      // one by the published table, one by the envelope schema — and neither is
      // minted anywhere this file sweeps.
      //
      //   cancelled     the audit engine's, from electron/mcp/audit/index.js:
      //                 the caller going away in the middle of a render, which
      //                 needs Electron and a real browser. There is nothing here
      //                 to abandon.
      //   bound_value   the renderer's model layer, src/modelOps.js: text that
      //                 comes from data is never silently replaced with a
      //                 literal. It reaches the wire through the bridge.
      //
      // Each is checked below rather than believed: the place it names has to
      // still mint it, and it has to still be absent from the MCP layer — so the
      // day one moves in here, the excuse expires and the sweep has to grow.
      const ELSEWHERE = {
        cancelled: ['the audit engine', 'test/audit-cancel.js', "'cancelled'"],
        bound_value: ['the renderer’s model layer', 'src/modelOps.js', "code: 'bound_value'"],
      };
      for (const [code, [why, file, needle]] of Object.entries(ELSEWHERE)) {
        UNREACHABLE.set(code, `not this surface: ${why}`);
        check(`${code} is still minted where this file says it is`, fs.existsSync(path.join(REPO, file)) && fs.readFileSync(path.join(REPO, file), 'utf8').includes(needle), `${file} no longer holds ${needle}`);
        check(
          `  and the MCP layer still does not mint it itself`,
          !SHAPED.has(code),
          `${code} is now declared in ${[...(SHAPED.get(code) || [])].join(', ')} — it belongs in the sweep rather than in this list`
        );
      }
      const accounted = new Set([...EXERCISED.keys(), ...GRADED.keys(), ...UNREACHABLE.keys()]);
      const unaccounted = [...DECLARED.keys()].filter((c) => !accounted.has(c));
      check(
        'every code the shaping layer declares was exercised, graded or proved unreachable',
        unaccounted.length === 0,
        unaccounted.length
          ? unaccounted.map((c) => `${c}  (declared in ${[...DECLARED.get(c)].join(', ')})`).join('\n    ')
          : ''
      );
      // AND THE OTHER DIRECTION. A code that turned up on the wire and is in no
      // shaping file is a refusal a client is expected to branch on that nothing
      // in the surface wrote down.
      const undeclared = [...EXERCISED.keys()].filter((c) => !DECLARED.has(c));
      check('and nothing answered with a code the surface never declared', undeclared.length === 0, undeclared.join(', '));
      // Most of them are real behaviour, not a graded mapper. Said as a number so
      // that a rewrite which quietly moved families into the in-process bucket
      // has to change it deliberately.
      check('and most of them were provoked on the wire rather than graded in process', EXERCISED.size >= 25, `${EXERCISED.size} on the wire, ${GRADED.size} in process, ${UNREACHABLE.size} unreachable, of ${DECLARED.size} declared`);
    }

    // ── 10. WHAT THE CLIENT WAS TOLD, AGAINST WHAT ARRIVES ──────────────────────
    //
    // The enumeration above is read out of the repository. This reads the same
    // two client-facing declarations off the WIRE — the schema the client was
    // handed, and the guide it can fetch — because a description that says one
    // thing in the source and another over the wire is the shape of drift that a
    // repository-only check cannot see.
    {
      const described = String(tools.get('git')?.outputSchema?.properties?.code?.description || '');
      const overTheWire = new Set([...described.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map((m) => m[1]));
      check('the code description reaches a client at all', overTheWire.size >= 5, described.slice(0, 200));
      const missing = [...(DESCRIBED || [])].filter((c) => !overTheWire.has(c));
      check('  and names over the wire exactly what it names in the source', missing.length === 0, missing.join(', '));
      const unaccounted = [...overTheWire].filter((c) => !DECLARED.has(c));
      check('  and every code it names is one this file accounted for', unaccounted.length === 0, unaccounted.join(', '));

      // And the guides, which are the long half of the same promise. A client
      // that reads stacki://guide/* is told which refusals it will meet; a list
      // that grows a code nothing produces is an agent waiting for one. Read
      // over the wire, every topic, so a vocabulary moving from one guide to
      // another does not quietly stop being checked.
      const vocabulary = new Map();
      for (const topic of TOPIC_NAMES) {
        const guide = await rig.client.readResource({ uri: `stacki://guide/${topic}` });
        const text = String(guide?.contents?.[0]?.text || '');
        check(`the ${topic} guide is served`, text.length > 0, short(guide, 160));
        // The idiom these guides list a vocabulary in: two spaces, the word,
        // then a column of prose.
        for (const m of text.matchAll(/^ {2}([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s{3,}\S/gm)) vocabulary.set(m[1], topic);
      }
      check('  and between them they still spell out a refusal vocabulary', vocabulary.size >= 3, [...vocabulary.keys()].join(', '));
      const unknown = [...vocabulary.keys()].filter((c) => !DECLARED.has(c));
      check('  every code of which the surface declares', unknown.length === 0, unknown.map((c) => `${c} (in ${vocabulary.get(c)})`).join(', '));
    }

    // ── 11. THE POSITIVE CONTROL FOR THE WHOLE FILE ────────────────────────────
    //
    // Every assertion above is refusal-shaped. A surface that refused
    // EVERYTHING — a broken fixture, a gate stuck shut, a dispatcher that threw
    // on its way in — would satisfy the lot of them. So: the same tools, asked
    // for something they should do, have to do it.
    {
      const info = await rig.call('git', 'info', {});
      check('the same wire still answers a call that should work', info.envelope?.ok === true, short(info.envelope, 200));
      check('  from the repository this file built', info.envelope?.branch === 'main', short({ branch: info.envelope?.branch }));
      const before = snapshot(root);
      // Through the SOURCE domain deliberately, and through main's own
      // containment fence: that fence reads `openProjectRoot`, and this call is
      // the one that noticed a second rig had moved it. A control that avoided
      // the fence would have let the whole sweep run against the wrong project.
      const wrote = await rig.call('source', 'write', { path: 'public/written-by-the-control.txt', text: 'the surface can still be made to write something\n' });
      check('  and a write that is allowed still lands', wrote.envelope?.ok === true, short(wrote.envelope, 200));
      check(
        '  and the disk oracle sees it, so "nothing changed" above meant something',
        movement(before, snapshot(root)).some((m) => m.includes('written-by-the-control')),
        movement(before, snapshot(root)).slice(0, 3).join('; ')
      );
      const read = await rig.call('source', 'read', { path: 'public/written-by-the-control.txt' });
      check('  and reading it back gives what was written', String(read.envelope?.text || '').includes('can still be made to write'), short(read.envelope?.text, 120));
    }
  } finally {
    problems.push(...((await rig.stop())?.problems || []));
  }

  check('the rig left nothing behind', problems.length === 0, problems.join('; '));

  if (failures.length) {
    console.error(`refusal-contract: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  suiteDone();
  console.log(
    `refusal-contract: ${checked} passed  [${DECLARED.size} declared codes: ${EXERCISED.size} provoked on the wire, ` +
      `${GRADED.size} graded in process, ${UNREACHABLE.size} proved unreachable]`
  );
})().catch((err) => {
  // WHAT HAD ALREADY FAILED, BEFORE WHATEVER THREW. Same reason
  // schema-dispatch-contract.js does it: a wire that stops answering throws at
  // the first call, and the stack says nothing about the claim being made.
  if (failures.length) console.error(`refusal-contract: ${failures.length} of ${checked} had already failed\n${failures.join('\n')}`);
  console.error('refusal-contract: threw\n', err?.stack || err);
  process.exit(1);
});
