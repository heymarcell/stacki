// What an agent pays to find out what it is working with.
//
// bench-mcp.js measures how fast one call answers. This measures something an
// agent actually feels: how many calls, and how many BYTES THAT REACH THE
// MODEL, it costs to get from "connected" to "knows enough to act correctly".
//
// Three numbers, deliberately kept apart:
//
//   PREAMBLE   what every session pays before its first useful call --
//              instructions, tools/list, resources/list, prompts/list.
//   SEQUENCE   a hand-authored shortest-correct call sequence per task, checked
//              in as data. Both arms run the IDENTICAL sequence, so any delta
//              is the server's and not an agent's cleverness.
//   CLOSURE    calls-to-answer. For a fixed question set, the fewest calls at
//              which each question first becomes answerable from bytes already
//              received. This is the one that cannot be gamed by writing a
//              nicer sentence: prose changes no answer's depth. Only a new
//              resource, a richer response or a better default does.
//
// CONTEXT BYTES is the primary metric. A tool answer is duplicated into
// `content[].text` (agentTools.js) and that is the copy a model reads, so it is
// what a context budget is actually spent on. structuredContent bytes are
// reported beside it, never instead of it.
//
// Deliberately NOT in `npm test`: it starts real servers and takes minutes.

const { startWireRig } = require('../test/support/mcpWireRig.js');

const bytes = (v) => (v === undefined || v === null ? 0 : Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8'));

/** Wrap a rig so every call through it is counted. */
function record(rig) {
  const calls = [];
  const seen = new Map();
  const note = (name, args, res, ms) => {
    const text = (res?.raw?.content || []).map((c) => c.text || '').join('');
    const key = `${name}:${JSON.stringify(args)}`;
    const priorSame = seen.get(key);
    const responseKey = JSON.stringify(res?.envelope ?? null);
    const redundant = priorSame !== undefined && priorSame === responseKey;
    seen.set(key, responseKey);
    const env = res?.envelope || {};
    calls.push({
      name,
      args,
      ok: env.ok !== false,
      code: env.ok === false ? env.code || 'error' : null,
      contextBytes: bytes(text),
      structuredBytes: bytes(res?.envelope),
      ms,
      redundant,
      staleRetry: env.ok === false && String(env.code || '').includes('stale'),
    });
    return res;
  };
  return {
    calls,
    call: async (d, a, args = {}) => {
      const t = Date.now();
      const r = await rig.call(d, a, args);
      return note(d, { action: a, ...args }, r, Date.now() - t);
    },
    tool: async (n, args = {}) => {
      const t = Date.now();
      const r = await rig.tool(n, args);
      return note(n, args, r, Date.now() - t);
    },
    totals() {
      return {
        calls: calls.length,
        invalid: calls.filter((c) => !c.ok).length,
        redundant: calls.filter((c) => c.redundant).length,
        staleRetries: calls.filter((c) => c.staleRetry).length,
        contextBytes: calls.reduce((n, c) => n + c.contextBytes, 0),
        structuredBytes: calls.reduce((n, c) => n + c.structuredBytes, 0),
        ms: calls.reduce((n, c) => n + c.ms, 0),
      };
    },
  };
}

/** What every session pays before it does anything useful. */
async function preamble(rig) {
  const client = rig.client;
  const out = { instructionsBytes: 0, tools: 0, toolsBytes: 0, resources: 0, resourcesBytes: 0, prompts: 0, promptsBytes: 0 };

  // The instructions arrive at initialize; the client keeps them.
  const inst = client.getInstructions?.() ?? null;
  out.instructionsBytes = bytes(inst);

  const tools = await client.listTools();
  out.tools = (tools.tools || []).length;
  out.toolsBytes = bytes(tools);

  try {
    const res = await client.listResources();
    out.resources = (res.resources || []).length;
    out.resourcesBytes = bytes(res);
  } catch (err) {
    out.resources = null;
    out.resourcesError = String(err?.code || err?.message || err).slice(0, 80);
  }
  try {
    const pr = await client.listPrompts();
    out.prompts = (pr.prompts || []).length;
    out.promptsBytes = bytes(pr);
  } catch (err) {
    out.prompts = null;
    out.promptsError = String(err?.code || err?.message || err).slice(0, 80);
  }
  out.totalBytes = out.instructionsBytes + out.toolsBytes + out.resourcesBytes + out.promptsBytes;
  return out;
}

// The question set. Each is a fact an agent genuinely needs before it can act
// on THIS project, phrased so the answer is checkable and does not depend on
// the fixture's exact strings.
//
// `answerable(seen)` is given every response body received so far, in order,
// and returns true once the answer is derivable from them. The score is the
// index at which that first became true -- calls-to-answer.
// The question set. Each is a fact an agent genuinely needs about THIS project
// before it can act on it, and each demands PROJECT-SPECIFIC evidence: a name
// that exists in the fixture and cannot appear in a tool schema, an
// instructions string or a piece of static guidance.
//
// That last part is the whole point. An earlier version of this set asked
// whether the word "components" had been seen, and every question scored zero
// because the 131 KB tools/list mentions all of them. It measured vocabulary,
// not knowledge. A question only counts as answered when the server has handed
// over something true about the project in front of it.
//
// The fixture identifiers below live HERE, in the measuring apparatus. A test
// forbids any of them from appearing in anything Stacki ships -- see the
// lexical firewall in test/mcp-intelligence.js. Encoding the answer into the
// surface under test is the one way this benchmark could quietly become a lie.
const has = (...needles) => (s) => needles.every((n) => s.includes(n));
const QUESTIONS = [
  // FULL PATHS, not bare filenames. `about.astro` and `index.astro` appear in
  // stacki://guide/astro as the canonical example of how routing works, which is
  // legitimate generic documentation -- but a host that read that guide would
  // have satisfied a bare-filename needle without learning anything about THIS
  // project. The full path is a fact only the project can supply.
  { id: 'what-pages',       ask: 'which routes/pages does this project have',   answerable: has('src/pages/index.astro', 'src/pages/about.astro') },
  { id: 'what-components',  ask: 'which components exist',                      answerable: has('Card.astro', 'Hero.astro') },
  { id: 'what-layouts',     ask: 'which layouts exist',                         answerable: has('Base.astro') },
  { id: 'what-tokens',      ask: 'which design tokens exist',                   answerable: has('--brand', '--gap') },
  { id: 'what-styles',      ask: 'which stylesheets style this project',        answerable: has('site.css') },
  // Both collection names, because 'notes' alone also appears in a tool schema
  // and would score for free. 'links' appears nowhere Stacki ships.
  { id: 'what-collections', ask: 'which content collections exist',             answerable: has('notes', 'links') },
  { id: 'what-classes',     ask: 'which class names does this project use',     answerable: has('pricing-grid') },
  { id: 'what-astro',       ask: 'which Astro version is this project on',      answerable: has('^5.0.0') },
];

async function closure(rig, client, seenFromPreamble) {
  const seen = [...seenFromPreamble];
  const first = new Map();
  let spent = seenFromPreamble.reduce((n, t) => n + bytes(t), 0);
  const mark = (i) => {
    for (const q of QUESTIONS) {
      if (first.has(q.id)) continue;
      // One string, so a question needing two facts can be satisfied by two
      // different answers rather than only by one answer carrying both.
      if (q.answerable(seen.join('\n'))) first.set(q.id, { calls: i, bytes: spent });
    }
  };
  mark(0);

  // Deterministic breadth-first probe of the read surface, cheapest first.
  //
  // THE BASELINE MUST BE THE STRONGEST HONEST ONE. Two probes take an argument
  // derived from an earlier answer, because a capable agent would derive it
  // too: the collection name comes out of content.collections, and package.json
  // is the obvious place to look for a framework version. Leaving them out
  // would have made two questions look unanswerable and handed Phase B a win it
  // had not earned.
  const probes = [
    ['tool', 'get_capabilities', {}],
    ['tool', 'get_context', {}],
    ['call', 'project', 'info', {}],
    ['call', 'project', 'scan', {}],
    ['call', 'page', 'list', {}],
    ['call', 'style', 'variables', {}],
    ['call', 'style', 'list_sources', {}],
    ['call', 'content', 'collections', {}],
    ['call', 'content', 'entries', 'DERIVE_COLLECTION'],
    ['call', 'source', 'read', { path: 'package.json' }],
    ['call', 'project', 'classes', {}],
  ];
  let collection = null;
  let resourceBytes = null;
  let resourceError = null;

  // THE RESOURCE READ THE INSTRUCTIONS NOW POINT AT.
  //
  // Phase A cannot have this probe -- it advertises no resources -- so the two
  // arms are compared on each one's own SHORTEST CORRECT ROUTE rather than on a
  // sequence one of them has no way to run. Set BENCH_PROBE=legacy to make the
  // candidate walk the baseline's exact sequence instead; that run answers a
  // different question, which is whether the old road got slower.
  if (process.env.BENCH_PROBE !== 'legacy') {
    probes.unshift(['resource', 'stacki://project/profile', {}]);
  }
  let i = 0;
  for (const p of probes) {
    i += 1;
    try {
      if (p[0] === 'resource') {
        let body = '';
        try {
          const r = await client.readResource({ uri: p[1] });
          body = (r.contents || []).map((c) => c.text || '').join('');
          resourceBytes = bytes(body);
        } catch (err) {
          // A server with no resources: costs the call, answers nothing. That is
          // exactly what the baseline experiences, and it is RECORDED rather than
          // silently scoring zero -- an earlier version swallowed a programming
          // error here and reported it as "the resource answered nothing".
          body = '';
          resourceError = String(err?.message || err).slice(0, 120);
        }
        seen.push(body);
        spent += bytes(body);
        mark(i);
        continue;
      }
      let args = p[0] === 'tool' ? p[2] : p[3];
      if (args === 'DERIVE_COLLECTION') {
        if (!collection) { seen.push(''); mark(i); continue; }
        args = { collection };
      }
      const res = p[0] === 'tool' ? await rig.tool(p[1], args) : await rig.call(p[1], p[2], args);
      const text = (res?.raw?.content || []).map((c) => c.text || '').join('');
      const body = text || JSON.stringify(res?.envelope ?? {});
      seen.push(body);
      spent += bytes(body);
      if (p[1] === 'content' && p[2] === 'collections') {
        const names = res?.envelope?.collections;
        const firstName = Array.isArray(names)
          ? (typeof names[0] === 'string' ? names[0] : names[0]?.name)
          : Object.keys(names || {})[0];
        if (firstName) collection = firstName;
      }
    } catch (err) {
      seen.push('');
    }
    mark(i);
  }
  const median = (v) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : null);
  const hits = QUESTIONS.filter((q) => first.has(q.id));
  return {
    perQuestion: QUESTIONS.map((q) => ({
      id: q.id,
      callsToAnswer: first.get(q.id)?.calls ?? null,
      bytesToAnswer: first.get(q.id)?.bytes ?? null,
    })),
    answered: hits.length,
    total: QUESTIONS.length,
    medianCallsToAnswer: median(hits.map((q) => first.get(q.id).calls)),
    medianBytesToAnswer: median(hits.map((q) => first.get(q.id).bytes)),
    // The whole set, which is what a session actually needs.
    callsToAnswerAll: hits.length === QUESTIONS.length ? Math.max(...hits.map((q) => first.get(q.id).calls)) : null,
    bytesToAnswerAll: hits.length === QUESTIONS.length ? Math.max(...hits.map((q) => first.get(q.id).bytes)) : null,
    resourceBytes,
    resourceError,
  };
}

async function main() {
  const mode = process.env.BENCH_MODE || 'full';
  const label = process.env.BENCH_LABEL || 'baseline';
  const withDeps = process.env.BENCH_DEPS === '1';
  // An `audit` stub, so the benchmark measures the FOURTEEN-tool surface users
  // get rather than a thirteen-tool one that exists only in this harness. The
  // stub never runs -- no probe calls it -- but its schema is the real one, and
  // the schema is what tools/list costs.
  const rig = await startWireRig({ era: 'modern', agentMode: mode, withDeps, audit: async () => ({ ok: true }) });
  const out = { label, mode, withDeps, at: new Date().toISOString() };
  try {
    out.preamble = await preamble(rig);
    // The preamble bytes a model would actually be handed.
    // EVERYTHING A SESSION READS BEFORE ITS FIRST USEFUL CALL, including the two
    // lists Phase B added. An earlier version seeded only instructions and
    // tools/list, which charged the candidate nothing for resources/list and
    // prompts/list even though preamble() had already measured them -- flattering
    // the candidate by about 3 KB in every bytes-to-answer number it produced.
    const seed = [
      String(rig.client.getInstructions?.() ?? ''),
      JSON.stringify(await rig.client.listTools()),
    ];
    try {
      seed.push(JSON.stringify(await rig.client.listResources()));
    } catch { /* a server with no resources pays nothing, which is the point */ }
    try {
      seed.push(JSON.stringify(await rig.client.listPrompts()));
    } catch { /* likewise */ }
    const rec = record(rig);
    out.closure = await closure(rec, rig.client, seed);
    out.discovery = rec.totals();
  } finally {
    const { problems } = await rig.stop();
    out.cleanupProblems = problems || [];
  }
  console.log(JSON.stringify(out, null, 2));
  if (out.cleanupProblems.length) {
    console.error('CLEANUP FAILED:', out.cleanupProblems.join('; '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
