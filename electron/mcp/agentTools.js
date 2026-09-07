// The Agent API's tools.
//
// Nine of them, one per thing a project is made of, each taking an `action`
// that decides what the rest of its arguments mean. The alternative — a tool
// per operation — would be a hundred and thirty tool descriptions in every
// client's context to use one of them, and a client that could no longer see
// the wood for the trees.
//
// The schemas are discriminated unions on `action`, so the arguments an action
// needs are required and the ones it does not are not merely optional but
// absent. That is what a client is shown, and it has not changed — but the
// CHECK is run here rather than by the host. It used to be the host's, and a
// call that named `set_prop` and forgot the prop got a bare English sentence
// with no structuredContent, which is the one answer in this surface an agent
// cannot branch on. See `advertised()` and `badArguments()` below.
//
// The annotations are honest and they are NOT the gate. `destructiveHint` says
// what an operation is; `electron/mcp/agent/permissions.js` says whether it
// may run, in the main process, before anything is dispatched. A client that
// ignores every hint gets exactly as far as its permission level allows.

const z = require('zod');

const { TOPICS, TOPIC_NAMES: GUIDE_TOPICS, uriFor: guideUri } = require('./guide');

const { DOMAINS, actionsOf, find } = require('./agent/registry');

// --- shapes ------------------------------------------------------------------

const Ref = z.string().min(8).max(4000).describe('An opaque Stacki ref, exactly as Stacki gave it to you.');
const RelPath = z
  .string()
  .min(1)
  .max(1024)
  .describe('A path inside the open project, relative to its root (src/pages/contact.astro). Never absolute.');
const Digest = z
  .string()
  .min(4)
  .max(64)
  .describe(
    'The digest Stacki reported when you read this. Required to REPLACE something that already exists, unless you ' +
      'pass the ref the read gave you instead — that carries the digest itself. Not needed to create something new.'
  );

// The ref a read handed back, which carries what that read saw. Passing it is
// the easier half of the same guard: nothing to copy, nothing to forget.
const FileRef = Ref.describe('The ref the read of this file gave you. It carries the version being replaced, so no digest is needed.');

/**
 * What every answer carries.
 *
 * Two halves, and the split is deliberate.
 *
 * DECLARED: the envelope, and every field a MUTATION answers with. Those are
 * the fields a client is expected to act on — the ref to carry into the next
 * call, the digests to compare, the patch to show somebody, whether ⌘Z will
 * reach it — and leaving them undeclared would make them conventions rather
 * than a contract. They are typed here, and test/agent-api.js checks that a
 * real mutation actually produces them.
 *
 * LOOSE: everything an individual action adds on top. `target.read` answers
 * with a different shape from `git.log`, and enumerating a hundred and thirty
 * of those in one file would be a second copy of the implementation that went
 * stale the first time an operation learned to say something new. The tool
 * descriptions and get_capabilities are where an action's own shape is
 * documented.
 *
 * So: strict about the parts that are the same everywhere, open about the parts
 * that are not, and honest about which is which.
 */
const ChangedFile = z.looseObject({
  file: z.string().describe('Project-relative. Never an absolute path.'),
  beforeDigest: z.string().nullable(),
  afterDigest: z.string().nullable(),
  patch: z
    .looseObject({
      hunks: z.array(z.looseObject({ at: z.number().int(), text: z.string() })),
      linesRemoved: z.number().int(),
      linesAdded: z.number().int(),
    })
    .nullable()
    .describe('Bounded: a whole-file rewrite does not become a whole-file patch.'),
});

const DocumentState = z
  .looseObject({
    file: z.string().nullable().describe('The document this revision is about.'),
    revision: z.number().int().nullable(),
    digest: z.string().nullable(),
  })
  .nullable();

const Envelope = z.looseObject({
  ok: z.boolean().describe('Whether the operation happened. False is a status with a code, never a crash.'),
  // THE THREE THAT REACHED A CLIENT WITHOUT BEING NAMED HERE. `merge_blocked`,
  // `merge_stuck` and `bad_branch_name` are minted in electron/gitBranches.js
  // and pass through the git mappers untouched — the resolve mapper only
  // rewrites a refusal carrying `badChoices` — so they were arriving on the
  // wire under a `code` this description told nobody about. They are named here
  // because this line is the shortest thing a client ever reads about refusals
  // and the only one that travels with the schema, whichever layer of the
  // process actually mints the code.
  code: z.string().nullable().optional().describe('Why not. permission_denied, guard_required, stale_target, stale_merge, bad_choices, merge_blocked, merge_stuck, bad_branch_name, bound_value, not_editable, no_project, bad_request, command_failed, …'),
  message: z.string().nullable().optional(),

  // --- what a mutation answers with ---------------------------------------
  ref: z.string().nullable().optional().describe('The target as it now is. Null when the edit removed it. Carry this into the next call rather than re-reading.'),
  action: z.string().optional(),
  notes: z.array(z.string()).optional().describe('What the operation wants said out loud — a binding it dropped, a frontmatter const it took with a deletion.'),
  gone: z.boolean().optional().describe('True when the edit removed the target, so there is nothing left to point at.'),
  undoable: z.boolean().optional().describe('Whether Stacki’s own undo can take this back. False is honest, not an omission.'),
  through: z.enum(['editor', 'disk']).optional().describe('Whether a source write went through the editor (undoable, on the canvas) or straight to disk.'),
  documentBefore: DocumentState.optional(),
  document: DocumentState.optional(),
  revisionBefore: z.number().int().nullable().optional(),
  revisionAfter: z.number().int().nullable().optional(),
  changedFiles: z.array(ChangedFile).optional().describe('Only what actually changed, with a bounded patch each.'),
  preview: z.looseObject({ note: z.string().optional() }).optional(),
  note: z.string().nullable().optional(),
  // On a refusal that is about currency rather than identity.
  observed: z.looseObject({}).nullable().optional().describe('What the ref recorded when it was made.'),
  current: z.looseObject({}).nullable().optional().describe('What is true now, so a re-read is one call rather than a guess.'),
  currentDigest: z.string().nullable().optional(),
  expectedDigest: z.string().nullable().optional(),
  currentRevision: z.number().int().nullable().optional(),
  expectedRevision: z.number().int().nullable().optional(),
  // On a permission refusal.
  operation: z.string().optional(),
  risk: z.enum(['read', 'write', 'high']).optional(),
  mode: z.string().optional(),
  // NULLABLE, and it has to be: two different answers land on this one key.
  // A permission refusal sends the mode an operation needs — always a string
  // (see permissions.js `refusal`). `project.diagnose` sends what the project
  // needs installed, which is `raw?.requires ?? null`: an explicit null when
  // nothing is missing. Declared string-only, that null failed the server's own
  // output validation, so a real client got `isError` and no result — every
  // refusal worked and project.diagnose was simply unusable over MCP. Found by
  // driving the action through a real client in test/mcp-wire-coverage.js.
  requires: z.string().nullable().optional(),
  index: z.number().int().nullable().optional().describe('Which operation in a batch was refused. The batch as a whole was not applied.'),
});

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const REMOTE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/** A tool's annotations, from what its actions actually do. */
function annotationsFor(domain, { remote = false } = {}) {
  const ops = actionsOf(domain).map((a) => find(domain, a));
  if (ops.every((op) => op.risk === 'read')) return READ_ONLY;
  const destructive = ops.some((op) => op.risk === 'high');
  if (remote) return REMOTE;
  return destructive ? DESTRUCTIVE : WRITES;
}

// --- the node vocabulary -----------------------------------------------------

const NodeSpec = z
  .object({
    kind: z.enum(['element', 'component', 'text', 'expr', 'comment', 'map', 'cond']),
    tag: z.string().max(64).optional().describe('For kind "element": the HTML tag.'),
    name: z.string().max(64).optional().describe('For kind "component": the component name, which the project must already provide.'),
    text: z.string().max(4000).optional().describe('Text content, for element/component/text/expr/comment.'),
    head: z.string().max(500).optional().describe('For kind "map": the loop head, e.g. "items.map((item) => (".'),
    test: z.string().max(500).optional().describe('For kind "cond": the condition.'),
    props: z
      .record(z.string(), z.union([z.string(), z.object({ type: z.enum(['string', 'expr']), value: z.string() })]))
      .optional()
      .describe('Attributes. A bare string is a literal; {type:"expr"} is code in braces.'),
  })
  .describe('A node to insert, in the same vocabulary Stacki’s own insert menu uses.');

const MoveTarget = z
  .object({
    parentRef: Ref.optional().describe('The node to move into. Omit for the document root.'),
    index: z.number().int().min(0).max(10000).describe('Position among that parent’s children.'),
  })
  .describe('Where the node should end up.');

/**
 * EVERY REBUILT SCHEMA, BESIDE THE ONE IT WAS REBUILT FROM.
 *
 * A rebuild can only be trusted if what came out can be compared with what went
 * in, and once `closed()` has run the open tree is unreachable from anywhere —
 * which is how twelve advertised bounds were deleted with a suite of 1,565
 * assertions watching. Every node `carried()` produces remembers its original
 * here.
 *
 * A WeakMap, keyed by the REBUILT node, for two reasons. It must not keep a
 * schema alive: `publishChecked` closes a tool's schema on every registration,
 * and a server that registers per request would otherwise accumulate a row per
 * request forever. And keying by the rebuilt node is what lets a reader walk a
 * closed tree asking each node what it used to be, rather than needing a handle
 * on an open tree nobody exports.
 *
 * The original in every row is a schema this file never rebuilt, and that is a
 * property `closeField` has to maintain rather than one that comes for free:
 * see the note there on closing a closed schema twice, which for a while left
 * thirty rows pointing at a rebuild instead of at an open tree.
 *
 * Read by test/schema-strictness.js, which converts both halves of every pair
 * to JSON Schema and requires every keyword to be identical bar the fence. That
 * grades the MECHANISM rather than the six fields this defect happened to hurt,
 * so a wrapper added tomorrow whose checks are not carried fails the day it is
 * written.
 */
const OPEN_SOURCE = new WeakMap();

/** What `schema` was before this file closed it, if it did. */
const openSourceOf = (schema) => (schema && typeof schema === 'object' ? OPEN_SOURCE.get(schema) : undefined);

// One operation inside a batch. The same vocabulary as the single-operation
// actions, so learning one teaches the other.
/**
 * The same union, with every branch closed.
 *
 * `z.object()` STRIPS a key it does not know, and a stripped key is an argument
 * the caller wrote and nobody ran. On a surface where most arguments are
 * optional and several operations have a server-side fallback for the one you
 * left out, that is not a tidy-up: it is a silent retarget. Measured at the
 * baseline commit, every one of these was accepted with `ok: true` and did
 * something other than what was asked:
 *
 *   git   {action:'restore_file', path, rev:'abc'}   -> `rev` dropped; restored from HEAD
 *   git   {action:'push', branchName:'feature-x'}    -> dropped; pushed the CURRENT branch
 *   target{action:'remove', target:'<a ref>'}        -> dropped; removed the person's SELECTION
 *   project{action:'probe', route:'/pricing'}        -> dropped; probed the preview root
 *
 * Two of those are `high` risk and one is destructive. The mistyped name is the
 * likeliest agent error of all — the top-level `properties` block that
 * `summarised()` publishes lists every branch's argument names side by side,
 * with nothing structural to say which action each belongs to — so the surface
 * has to answer it rather than absorb it.
 *
 * Closing the branch turns all four into `bad_arguments`, naming the key. It
 * also makes the ADVERTISED schema say so: `z.toJSONSchema` emits
 * `additionalProperties: false` per branch, so a validating client refuses the
 * call before it is sent, and this file's header stops being aspirational.
 *
 * Rebuilt rather than declared branch by branch, so a branch added tomorrow is
 * closed without its author having to remember to close it.
 */
function closed(union) {
  const key = union.def?.discriminator || 'action';
  const rebuilt = z.discriminatedUnion(
    key,
    union.options.map((branch) => {
      // A BRANCH CAN CARRY A DESCRIPTION, AND REBUILDING IT DROPPED ONE.
      //
      // `z.strictObject(shape)` keeps every FIELD's `.describe()` and none of
      // the object's own, so two operations lost the sentence published beside
      // them in `tools/list` — retrieval metadata deleted by a change that was
      // about validation. `carried()` puts the sentence back, and the branch's
      // own checks with it.
      return carried(closeShape(branch.shape), branch);
    })
  );
  // The union's own checks and description, which the rebuild above does not
  // reach: `z.discriminatedUnion` was handed the branches, not the wrapper.
  return carried(rebuilt, union);
}

/**
 * Close an object shape, and everything object-shaped inside it.
 *
 * Closing only the top level left the same silent strip one level down: the
 * arguments that are themselves objects — a node spec, a move target, a
 * declaration identity — went on dropping keys nobody typed correctly. A
 * mistyped field inside `node` is exactly as invisible as a mistyped field
 * beside it, and rather more likely, because those are the shapes an agent has
 * to construct rather than copy.
 *
 * Wrappers are unwrapped and put back: `.optional()`, `.nullable()`,
 * `.default()` and arrays all hold an inner type that may itself be an object.
 * Anything this does not recognise is returned untouched — a rebuilt schema
 * that dropped a refinement would be worse than an open one.
 */
function closeShape(shape) {
  const out = {};
  for (const [name, field] of Object.entries(shape)) out[name] = closeField(field);
  return z.strictObject(out);
}

function closeField(field) {
  const def = field?.def;
  if (!def) return field;
  // CLOSING A CLOSED SCHEMA A SECOND TIME BLINDED THE CHECK THAT GRADES THE
  // REBUILD.
  //
  // `Operation` is closed at declaration and then embedded in `target.edit`, so
  // walking into `operations` found a discriminated union and rebuilt it again.
  // The second generation was identical in what it accepts — but its
  // OPEN_SOURCE entry pointed at the FIRST generation, which is itself a
  // rebuild, and the genuinely open union was then reachable from neither half
  // of any pair. Measured: 30 of the 197 pairs test/schema-strictness.js grades
  // — the `Operation` union, its thirteen branches, the node specs, their
  // props record and the move target — compared one rebuild against another, so
  // a keyword lost by the FIRST close was invisible to the one assertion whose
  // whole purpose is to notice a keyword going missing that nobody predicted.
  //
  // A node this file has already rebuilt is already closed, all the way down,
  // so handing it straight back is both correct and one generation cheaper. The
  // wrapper around it then sees `closedInner === inner` and keeps its own
  // identity too, which is why the array of operations stops being rebuilt at
  // all: there is nothing left in it to close.
  if (OPEN_SOURCE.has(field)) return field;
  if (def.type === 'object') return carried(closeShape(field.shape), field);
  // A UNION OF SHAPES IS STILL SHAPES. `audit`'s `viewports` takes either a
  // named string or a `{width, height}` object, and the object half was the
  // last place on the surface still dropping a key silently.
  if (def.type === 'union' && Array.isArray(def.options)) {
    const rebuilt = def.options.map(closeField);
    if (rebuilt.every((o, i) => o === def.options[i])) return field;
    // A DISCRIMINATED UNION REBUILT AS A PLAIN ONE STOPS NAMING THE KEY.
    //
    // A discriminated union in zod 4 IS a union with `discriminator` on its
    // def, so `Operation` -- the batch's own union on `type` -- matched this
    // branch, every option was rebuilt, and what went back was a plain
    // `z.union` with the discriminator dropped on the way past. The cost is
    // not validation, which still refuses: it is the ANSWER. A plain union
    // fails as `invalid_union` with "Invalid input" and buries the thirteen
    // real sub-errors in `errors[]`, which `issuesOf()` does not read -- so a
    // mistyped key inside an edit batch came back as `operations.0: Invalid
    // input`, the one shape on this surface an agent cannot act on,
    // reintroduced one level down by the fix for the level above.
    return carried(
      def.discriminator ? z.discriminatedUnion(def.discriminator, rebuilt) : z.union(rebuilt),
      field
    );
  }
  // A RECORD'S VALUES ARE STILL SHAPES, and the wrapper walk below could not
  // see them: a record holds its inner type under `valueType`, not `innerType`
  // or `element`, so it was returned untouched and every object inside it
  // stayed open. `props` on a node spec is the one that mattered -- its KEYS
  // are attribute names the author chooses and are rightly open, but its VALUE
  // is a declared `{type, value}` shape an agent has to construct, and a
  // mistyped key in it was dropped and the insert ran.
  if (def.type === 'record' && def.valueType) {
    const closedValue = closeField(def.valueType);
    if (closedValue === def.valueType) return field;
    return carried(z.record(def.keyType, closedValue), field);
  }
  // One inner type, held under a name that differs by wrapper.
  const innerKey = def.type === 'array' ? 'element' : 'innerType';
  const inner = def[innerKey];
  if (!inner || typeof inner !== 'object' || !inner.def) return field;
  const closedInner = closeField(inner);
  if (closedInner === inner) return field;
  if (def.type === 'array') return carried(z.array(closedInner), field);
  if (def.type === 'optional') return carried(closedInner.optional(), field);
  if (def.type === 'nullable') return carried(closedInner.nullable(), field);
  if (def.type === 'default') return carried(closedInner.default(def.defaultValue), field);
  return field;
}

/**
 * THE REBUILD WIDENED WHAT THE SURFACE ACCEPTS.
 *
 * Every branch above hands back a NEW schema built from the old one's inner
 * types, and everything hanging off the OLD wrapper that was not explicitly
 * copied across went with it. Only the description was copied. In zod 4 a
 * wrapper's bounds live in `def.checks` — `.min()`, `.max()`, `.int()`,
 * `.regex()` are all checks rather than part of the type — so
 * `z.array(closedInner)` is the same array with its bounds deleted.
 *
 * That is the one failure this mechanism must not have. Closing an object only
 * ever REFUSES more; losing a check ACCEPTS more, silently, and the advertised
 * JSON Schema stops naming the bound at the same moment, so a validating client
 * stops catching it either. Because `Operation` is a discriminated union,
 * `closeField(element) !== element` always held, so the array rebuild always
 * fired: twelve published keywords went missing at once, across seven fields —
 * `target.edit.operations` (1..30), `style.set_declarations` (1..40),
 * `style.add_variables` / `rename_variables` / `move_variables` (1..100 each),
 * `content.write_entry.edits` (..500) and `audit.viewports` (..6). Six of the
 * seven have no downstream guard, so one call could put five thousand variable
 * renames inside a single undo transaction, and `MAX_BODY_BYTES` in server.js
 * lost the largest schema-legal write it is sized against.
 *
 * Nothing else was lost, and that is a measurement rather than a hope: a string
 * `.max()`, a `.regex()`, a number's `.int()` all sit on a primitive, and
 * `closeField` returns a primitive untouched, so those checks were never in the
 * rebuild's path. The invariance check in test/schema-strictness.js is what
 * says so for every position rather than for the ones anybody thought of.
 *
 * So the checks are carried across with the description, on EVERY rebuilt
 * wrapper rather than on arrays alone — a refinement on an object, a bound on
 * a record, a check on an optional, all of them. `.check()` re-attaches the
 * check objects themselves, so the runtime rule and the emitted `minItems` /
 * `maxItems` come back together. test/schema-strictness.js asserts that the
 * closed tree's JSON Schema keywords are IDENTICAL to the open tree's, which is
 * what makes this a class closed rather than an instance fixed.
 */
const carried = (rebuilt, original) => {
  const checks = original?.def?.checks;
  const withChecks = checks && checks.length ? rebuilt.check(...checks) : rebuilt;
  const kept = original.description ? withChecks.describe(original.description) : withChecks;
  OPEN_SOURCE.set(kept, original);
  return kept;
};

const Operation = closed(z.discriminatedUnion('type', [
  // `value` is this form's name and stays the declared one; `text` is accepted
  // because the single-action form calls it that. See the note on
  // `action: "set_text"` below.
  z.object({
    type: z.literal('set_text'),
    value: z.string().max(20000).optional(),
    text: z.string().max(20000).optional(),
    replaceBinding: z.boolean().optional(),
  }),
  z.object({ type: z.literal('set_prop'), name: z.string().max(120), value: z.string().max(4000), valueType: z.enum(['string', 'expr']).optional() }),
  z.object({ type: z.literal('remove_prop'), name: z.string().max(120) }),
  z.object({ type: z.literal('set_classes'), classes: z.array(z.string().max(120)).max(80) }),
  z.object({ type: z.literal('add_class'), className: z.string().max(120) }),
  z.object({ type: z.literal('remove_class'), className: z.string().max(120) }),
  z.object({ type: z.literal('insert_before'), node: NodeSpec }),
  z.object({ type: z.literal('insert_after'), node: NodeSpec }),
  z.object({ type: z.literal('append_child'), node: NodeSpec }),
  z.object({ type: z.literal('remove') }),
  z.object({ type: z.literal('duplicate') }),
  z.object({ type: z.literal('move'), to: MoveTarget }),
  z.object({ type: z.literal('set_tag'), tag: z.string().max(64) }),
]));

// --- target ------------------------------------------------------------------

const withTarget = (shape) => ({
  ref: Ref.optional().describe('The target. Omit to act on whatever is selected in Stacki right now.'),
  ...shape,
});

const guard = {
  expectedRevision: z.number().int().optional().describe('The document revision your read reported. The edit is refused if the document has moved on.'),
  expectedDigest: z.string().max(64).optional().describe('The document digest your read reported.'),
};

const TargetInput = closed(z.discriminatedUnion('action', [
  z.object({
    action: z.literal('read'),
    ...withTarget({
      navigate: z.boolean().optional().describe('Whether Stacki may open the page and drill into the components to reach it. Default true.'),
      compact: z
        .boolean()
        .optional()
        .describe(
          'Leave out `snippet`, the markup around the target, and set `snippetOmitted` instead. ' +
            'Walking down a tree returns overlapping snippets of the same region once per level — ' +
            'six levels of one page measured 81KB, of which 17KB was the same markup five times. ' +
            'Use it while navigating and read the source once at the end. Default false.'
        ),
    }),
  }),
  z.object({
    action: z.literal('select'),
    ...withTarget({ occurrence: z.number().int().min(0).max(1000).optional().describe('Which rendered copy of a repeated node to scroll to.') }),
  }),
  z.object({
    action: z.literal('enter'),
    ...withTarget({
      occurrence: z.number().int().min(0).max(1000).optional().describe('Which rendered copy of the instance to open — the third card, not the first.'),
      compact: z.boolean().optional().describe('Leave out `snippet` and set `snippetOmitted` instead. See target.read.'),
    }),
  }),
  z.object({
    action: z.literal('exit'),
    compact: z.boolean().optional().describe('Leave out `snippet` and set `snippetOmitted` instead. See target.read.'),
  }),
  z.object({
    action: z.literal('edit'),
    ...withTarget({ ...guard, operations: z.array(Operation).min(1).max(30), label: z.string().max(80).optional() }),
  }),
  z.object({
    action: z.literal('set_text'),
    ...withTarget({
      ...guard,
      // ONE OPERATION, TWO NAMES FOR ITS ARGUMENT, AND AN AGENT CAUGHT BETWEEN
      // THEM.
      //
      // `action: "set_text"` takes `text`. The SAME operation inside `edit`'s
      // batch takes `value` (see `Operation` above), and every other pair in
      // this file is consistent — `set_prop` is `{name, value}` in both forms.
      // `set_text` is the one that is not.
      //
      // Measured, on the simplest task in the held-out corpus: change one
      // heading. A real Claude Code read the schemas, called
      // `{action:"set_text", value:"…"}` and got
      // "Invalid input: expected string, received undefined"; tried the batch
      // shape without `action` and got another validation error; and only then
      // found `{action:"edit", operations:[…]}`. Twelve tool calls and 718 KB
      // for a one-word change, and two of the calls were this.
      //
      // So both names are accepted, here and in the batch form, and the
      // dispatch normalises. Declaring `text` optional is what makes that
      // possible; a call with neither is refused by the tool with a sentence
      // naming both, which is a better answer than a Zod error either way.
      text: z.string().max(20000).optional().describe('The new text. `value` is accepted as well, because the batch form of this operation calls it that.'),
      value: z.string().max(20000).optional().describe('The same thing as `text`. Accepted so the single and batch forms of set_text agree.'),
      replaceBinding: z
        .boolean()
        .optional()
        .describe('Say true only to deliberately replace a {binding} with literal text. Without it, a bound value is refused and Stacki tells you where the value lives.'),
    }),
  }),
  z.object({
    action: z.literal('set_prop'),
    ...withTarget({ ...guard, name: z.string().max(120), value: z.string().max(4000), valueType: z.enum(['string', 'expr']).optional() }),
  }),
  z.object({ action: z.literal('remove_prop'), ...withTarget({ ...guard, name: z.string().max(120) }) }),
  z.object({ action: z.literal('set_classes'), ...withTarget({ ...guard, classes: z.array(z.string().max(120)).max(80) }) }),
  z.object({ action: z.literal('add_class'), ...withTarget({ ...guard, className: z.string().max(120) }) }),
  z.object({ action: z.literal('remove_class'), ...withTarget({ ...guard, className: z.string().max(120) }) }),
  z.object({ action: z.literal('insert_before'), ...withTarget({ ...guard, node: NodeSpec }) }),
  z.object({ action: z.literal('insert_after'), ...withTarget({ ...guard, node: NodeSpec }) }),
  z.object({ action: z.literal('append_child'), ...withTarget({ ...guard, node: NodeSpec }) }),
  z.object({ action: z.literal('remove'), ...withTarget(guard) }),
  z.object({ action: z.literal('duplicate'), ...withTarget(guard) }),
  z.object({ action: z.literal('move'), ...withTarget({ ...guard, to: MoveTarget }) }),
  z.object({ action: z.literal('set_tag'), ...withTarget({ ...guard, tag: z.string().max(64) }) }),
]));

// --- style -------------------------------------------------------------------

const DeclarationIdentity = z
  .object({
    source: z.string().max(1024).describe('The style source key, as style.read reported it.'),
    sourceLabel: z.string().max(512).optional(),
    atContext: z.array(z.string().max(300)).max(6).optional().describe('The at-rule chain the rule sits in, as reported.'),
    selector: z.string().max(1000),
    property: z.string().max(120).optional(),
    // What the stylesheet was when the read reported this. Pass it back
    // unchanged — a rule can be found again in a file somebody has rewritten,
    // and "the same rule" is not "the version I reasoned about".
    sourceDigest: z.string().max(64).optional().describe('Pass back exactly what style.read gave you; the write is refused if the stylesheet changed meanwhile.'),
  })
  .describe('A declaration, named the way style.read reported it. Pass the whole object back unchanged.');

const StyleInput = closed(z.discriminatedUnion('action', [
  z.object({
    action: z.literal('read'),
    ref: Ref.optional(),
    properties: z.array(z.string().max(120)).max(60).optional().describe('Extra properties to include in the computed values.'),
  }),
  z.object({ action: z.literal('list_sources') }),
  z.object({
    action: z.literal('set_property'),
    ref: Ref.optional(),
    identity: DeclarationIdentity.optional().describe('The declaration to change. Omit only when creating a rule, and then give selector and source.'),
    selector: z.string().max(1000).optional(),
    source: z.string().max(1024).optional(),
    property: z.string().max(120),
    value: z.string().max(2000),
    important: z.boolean().optional(),
  }),
  z.object({ action: z.literal('remove_property'), ref: Ref.optional(), identity: DeclarationIdentity }),
  z.object({
    action: z.literal('set_declarations'),
    ref: Ref.optional(),
    identity: DeclarationIdentity.optional(),
    selector: z.string().max(1000).optional(),
    source: z.string().max(1024).optional(),
    declarations: z
      .array(z.object({ property: z.string().max(120), value: z.string().max(2000), important: z.boolean().optional() }))
      .min(1)
      .max(40),
  }),
  z.object({ action: z.literal('read_source'), path: RelPath }),
  z.object({ action: z.literal('write_source'), path: RelPath, css: z.string().max(2_000_000), ref: FileRef.optional(), expectedDigest: Digest.optional() }),
  z.object({
    action: z.literal('variables'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(400)
      .optional()
      .describe('How many CSS custom properties to return — variables, not files. Default 200. The answer reports returned, total and truncated.'),
  }),
  z.object({
    action: z.literal('set_variable'),
    // The offsets are the ones `variables` reported for that cell. They are
    // required, and they are why `expect` is worth passing: the write is at a
    // position in a file, and a file that moved under it should refuse rather
    // than write somewhere else.
    edit: z.object({
      file: RelPath,
      valueStart: z.number().int().min(0),
      valueEnd: z.number().int().min(0),
      value: z.string().max(2000),
      // Required, not optional. This writes at a byte offset in a stylesheet;
      // if the file moved under the offset, an unguarded write does not do
      // nothing — it writes in the wrong place.
      expect: z.string().max(2000).describe('The value that is there now, exactly as `variables` reported it. The write is refused if the file has moved under the offset.'),
    }),
  }),
  z.object({
    action: z.literal('add_variables'),
    adds: z
      .array(z.object({ file: RelPath, selector: z.string().max(300), name: z.string().max(200), value: z.string().max(2000).optional(), after: z.string().max(200).optional() }))
      .min(1)
      .max(100),
  }),
  z.object({
    action: z.literal('rename_variables'),
    renames: z.array(z.object({ from: z.string().max(200), to: z.string().max(200) })).min(1).max(100),
  }),
  z.object({
    action: z.literal('move_variables'),
    moves: z
      .array(
        z.object({
          file: RelPath,
          selector: z.string().max(300),
          name: z.string().max(200).optional().describe('One variable. Give `names` instead to move a whole section.'),
          names: z.array(z.string().max(200)).max(200).optional(),
          target: z
            .string()
            .max(300)
            .optional()
            .describe('The VARIABLE to land in front of — a name like --spacing-lg, not a selector. Leave it out to move to the end of the rule.'),
          at: z.number().int().min(0).optional(),
        })
      )
      .min(1)
      .max(100),
  }),
  z.object({
    action: z.literal('add_section'),
    edit: z.object({ file: RelPath, selector: z.string().max(300), title: z.string().max(200), before: z.string().max(200).optional(), at: z.number().int().min(0).optional() }),
  }),
  z.object({
    action: z.literal('set_section_title'),
    edit: z.object({ file: RelPath, start: z.number().int().min(0), end: z.number().int().min(0), title: z.string().max(200), expect: z.string().max(4000).describe('The text between those offsets now, as `variables` reported it.') }),
  }),
  z.object({
    action: z.literal('remove_section'),
    edit: z.object({ file: RelPath, start: z.number().int().min(0), end: z.number().int().min(0), expect: z.string().max(20000).describe('The text between those offsets now, as `variables` reported it.') }),
  }),
  z.object({
    action: z.literal('move_heading'),
    edit: z.object({ file: RelPath, selector: z.string().max(300), start: z.number().int().min(0), end: z.number().int().min(0), before: z.string().max(200).optional(), expect: z.string().max(20000).describe('The text between those offsets now, as `variables` reported it.') }),
  }),
]));

// --- source ------------------------------------------------------------------

const SourceInput = closed(z.discriminatedUnion('action', [
  z.object({
    action: z.literal('read'),
    path: RelPath,
    startLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('First line to return, 1-based. Past the end of the file is refused with bad_range rather than answered with nothing.'),
    endLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Last line to return, inclusive. Past the end is clamped and the answer says clampedEnd; below startLine is refused. Lines come back whole, with their own line endings, so the text can go straight back to replace_range.'),
  }),
  z.object({
    action: z.literal('write'),
    path: RelPath,
    text: z.string().max(2_000_000),
    ref: FileRef.optional(),
    expectedDigest: Digest.optional(),
  }),
  z.object({
    action: z.literal('replace_range'),
    path: RelPath,
    startLine: z.number().int().min(1).describe('First line to replace, 1-based. One past the last line appends at the end of the file.'),
    endLine: z.number().int().min(1).optional().describe('Last line to replace, inclusive. Defaults to startLine.'),
    text: z
      .string()
      .max(2_000_000)
      .describe(
        'The replacement, as whole lines. One trailing newline terminates the last of them and is consumed; a second one is a blank ' +
          'line you meant. An empty string DELETES the range. The lines are written with the file’s own line endings.'
      ),
    ref: FileRef.optional(),
    expectedDigest: Digest.optional(),
  }),
  z
    .object({ action: z.literal('read_symbol'), fromFile: RelPath, spec: z.string().max(1024), name: z.string().max(200) })
    .describe(
      'The WHOLE FILE the symbol is declared in, with declarationLine pointing at its declaration (null when there is none to point ' +
        'at). Stacki has no JavaScript parser and cannot cut a symbol out of a module; to read just the declaration, put ' +
        'declarationLine into source.read’s startLine and endLine.'
    ),
  z.object({ action: z.literal('resolve_path'), fromFile: RelPath, spec: z.string().max(1024) }),
]));

// --- page --------------------------------------------------------------------

// ONE PATH SPACE, SAID ONCE.
//
// Every path in this domain is project-relative and under src/pages — the same
// spelling every other domain uses and the same spelling these actions RETURN.
// It used to be two: `page.move`'s `from` was project-relative and its `to` was
// relative to src/pages, and the folder actions prefixed `src/pages/` onto
// whatever they were handed, so passing back a path this API had just returned
// produced `src/pages/src/pages/blog`. Three of them did not even fail at it.
//
// The rule is in one constant so that the schema a client reads, the refusal it
// gets when it is wrong, and the resolver that enforces it cannot drift apart.
// See `pagesRel` in electron/mcp/agent/domains.js for the other two.
const PAGE_PATH_RULE = 'Project-relative and under src/pages/ — for example src/pages/blog or src/pages/blog/first.astro.';

const PagePath = z.string().min(1).max(300).describe(PAGE_PATH_RULE);

const PageInput = closed(z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('read'), path: RelPath }),
  z.object({
    action: z.literal('create'),
    // A NAME, NOT A PATH, and the only argument in this domain that is not one.
    // It says so, because the difference is exactly what a caller gets wrong.
    name: z
      .string()
      .max(300)
      .describe(
        'The page\'s name, WITHOUT src/pages and without an extension — "contact", or "docs/intro" for one in a ' +
          'folder. This is the one argument here that is a name rather than a path; the answer comes back as a ' +
          'project-relative path (src/pages/contact.astro), which is what every other action in this domain takes.'
      ),
    layout: z.string().max(120).optional(),
  }),
  z.object({ action: z.literal('delete'), path: PagePath }),
  z.object({ action: z.literal('move'), from: PagePath, to: PagePath.describe(`Where it should end up. ${PAGE_PATH_RULE}`) }),
  z.object({ action: z.literal('folder_create'), dir: PagePath }),
  z.object({ action: z.literal('folder_rename'), from: PagePath, to: PagePath.describe(`The folder's new path. ${PAGE_PATH_RULE}`) }),
  z.object({ action: z.literal('folder_delete'), dir: PagePath }),
  z.object({
    action: z.literal('component_create'),
    name: z.string().max(120).describe('The component name — a word starting with a capital letter.'),
    // A REF, not a tree. The old input asked for "the model nodes, as
    // target.read reports them", and no client could supply that: target.read
    // answers with bounded summaries carrying `childCount`, while the
    // serializer walks internal parser nodes with `children`. The operation was
    // unreachable from MCP whatever was passed. It takes the handle an agent
    // actually holds now, and Stacki resolves it against its own live model —
    // which is what a ref is for.
    ref: Ref.describe('One writable node, as target.read or get_context reported it. Its whole subtree becomes the component.'),
    withProps: z
      .boolean()
      .optional()
      .describe('Carry the page values this markup reads across as props. Default true; false extracts the markup as it stands, which may leave it reading scope it no longer has.'),
  }),
  z.object({ action: z.literal('component_usage'), name: z.string().max(120), exclude: z.string().max(1024).optional() }),
  z.object({ action: z.literal('dynamic_paths'), path: RelPath }),
  z.object({ action: z.literal('injected_routes') }),
  z.object({ action: z.literal('import_path'), fromFile: RelPath, targetFile: RelPath }),
  z.object({ action: z.literal('rebase_import'), fromPage: RelPath, toPage: RelPath, spec: z.string().max(1024) }),
]));

// --- content -----------------------------------------------------------------

const ContentInput = closed(z.discriminatedUnion('action', [
  z.object({ action: z.literal('cms_list') }),
  z.object({ action: z.literal('cms_read'), path: RelPath }),
  z.object({ action: z.literal('cms_write'), path: RelPath, data: z.unknown(), ref: FileRef.optional(), expectedDigest: Digest.optional() }),
  z.object({ action: z.literal('cms_create'), name: z.string().max(300) }),
  z.object({ action: z.literal('cms_delete'), path: RelPath }),
  z.object({ action: z.literal('cms_usage'), path: RelPath }),
  z.object({ action: z.literal('cms_meta') }),
  z.object({ action: z.literal('cms_set_meta'), path: RelPath, fields: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.literal('config'), force: z.boolean().optional() }),
  z.object({ action: z.literal('collections') }),
  z.object({ action: z.literal('entries'), collection: z.string().max(200), limit: z.number().int().min(1).max(400).optional() }),
  z.object({
    action: z.literal('write_entry'),
    // WHICH ENTRY, NEVER WHERE IT LIVES.
    //
    // This used to take the whole `entry` object a read handed back and use its
    // `file` as the path to write. `path.resolve` accepts `..` segments and
    // returns an absolute argument unchanged, so that was the one write in this
    // surface outside the project fence — and an entry that had lost its
    // `locator` on the way through addressed the top of a file-backed
    // collection instead of its own record. Stacki resolves the entry itself
    // now, through the same listing `content.entries` answers from.
    collection: z.string().max(200).optional().describe('The collection the entry belongs to. Required unless `entry` identifies one on its own.'),
    id: z.string().max(300).optional().describe('The entry, by the id content.entries reported. Required unless `entry` carries one.'),
    entry: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Deprecated, and accepted for one release as a SELECTOR only: Stacki reads its id and file to pick the ' +
          'entry out of the collection and takes nothing else from it. Send `collection` and `id` instead.'
      ),
    // A LIST, because that is what the implementation applies: contentEntries.js
    // `writeEntry` calls `edits.map(...)` over `{ path, value }` locators. This
    // was declared as an object of fields, which no client could make work —
    // an object reached `.map` and threw, and so did leaving it out, because
    // the mapper below turned the absence into `{}`. Every possible call to
    // content.write_entry failed until this matched the code underneath it.
    edits: z
      .array(
        z.object({
          path: z.array(z.union([z.string().max(200), z.number().int()])).min(1).describe('Where in the entry data, e.g. ["title"].'),
          value: z.unknown().optional().describe('The new value. Leave it out to clear the field.'),
          rename: z.string().max(200).optional().describe('Rename this key instead of setting it.'),
        })
      )
      .max(500)
      .optional()
      .describe('The fields to change, each addressed by a path into the entry data.'),
    body: z.string().max(1_000_000).optional().describe('The markdown body, when the entry has one.'),
    expectedDigest: Digest.optional().describe(
      'The digest content.entries reported for this entry. Not needed when you pass `entry` back, which carries it.'
    ),
    allowInvalid: z
      .boolean()
      .optional()
      .describe(
        'The entry is checked against the collection schema and a write that breaks it is refused with field-level ' +
          'issues. Say true to write it anyway — the issues are still reported, so the override is on the record.'
      ),
  }),
  z.object({ action: z.literal('validate'), collection: z.string().max(200), data: z.unknown() }),
  z.object({ action: z.literal('targets'), collection: z.string().max(200) }),
  z.object({ action: z.literal('rename_plan'), collection: z.string().max(200), from: z.string().max(300), to: z.string().max(300) }),
  z.object({ action: z.literal('rename'), collection: z.string().max(200), from: z.string().max(300), to: z.string().max(300) }),
  z.object({ action: z.literal('sample_entry'), collection: z.string().max(200), id: z.string().max(300).optional() }),
  z.object({ action: z.literal('resolve_import'), fromFile: RelPath, spec: z.string().max(1024) }),
]));

// --- asset -------------------------------------------------------------------

const AssetInput = closed(z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list'),
    under: z.string().max(1024).optional().describe('Only what is inside this folder, e.g. "public/images".'),
    limit: z.number().int().min(1).max(400).optional(),
  }),
  z.object({ action: z.literal('dimensions'), path: RelPath }),
  z.object({ action: z.literal('read_text'), path: RelPath }),
  z.object({ action: z.literal('write_text'), path: RelPath, text: z.string().max(2_000_000), ref: FileRef.optional(), expectedDigest: Digest.optional() }),
  z.object({ action: z.literal('mkdir'), parent: z.string().max(1024), name: z.string().max(200) }),
  z.object({ action: z.literal('move'), path: RelPath, toFolder: z.string().max(1024) }),
  z.object({ action: z.literal('rename'), path: RelPath, name: z.string().max(200) }),
  z.object({ action: z.literal('delete'), path: RelPath }),
]));

// --- project -----------------------------------------------------------------

const ProjectInput = closed(z.discriminatedUnion('action', [
  z.object({ action: z.literal('info') }),
  z.object({ action: z.literal('scan') }),
  z.object({ action: z.literal('classes'), limit: z.number().int().min(1).max(2000).optional() }),
  z.object({ action: z.literal('dependencies') }),
  z.object({ action: z.literal('install') }),
  z
    .object({ action: z.literal('diagnose') })
    .describe(
      'Why the dev server will or will not start. `kind` is one of: ready (node is here, the dependencies are installed and the ' +
        'version satisfies Astro — nothing is wrong), no-node (no node binary could be found), no-deps (node_modules or astro is ' +
        'missing — install them), node-too-old (the node found does not satisfy Astro’s engines range). Also reports ' +
        'packageManager as {detected, from, declared}: which one to run, which lockfile said so — `from: "default"` means no ' +
        'lockfile was found and npm is the fallback rather than a detection — and package.json’s own packageManager field, which ' +
        'can disagree with the lockfile.'
    ),
  z.object({ action: z.literal('probe'), url: z.string().max(2048).optional() }),
  z.object({ action: z.literal('dev_status') }),
  z.object({ action: z.literal('dev_start') }),
  z.object({ action: z.literal('dev_stop') }),
  z.object({ action: z.literal('undo') }),
  z.object({ action: z.literal('redo') }),
]));

// --- git ---------------------------------------------------------------------

const GitInput = closed(z.discriminatedUnion('action', [
  z.object({ action: z.literal('info') }),
  z.object({ action: z.literal('gh_status') }),
  z.object({ action: z.literal('status'), limit: z.number().int().min(1).max(400).optional() }),
  z.object({ action: z.literal('log'), ref: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).optional(), skip: z.number().int().min(0).optional() }),
  z.object({ action: z.literal('commit_files'), ref: z.string().max(200) }),
  z.object({ action: z.literal('all_files'), limit: z.number().int().min(1).max(2000).optional() }),
  z.object({ action: z.literal('file_at'), ref: z.string().max(200), path: RelPath }),
  z.object({ action: z.literal('worktrees') }),
  z.object({ action: z.literal('init') }),
  z.object({ action: z.literal('commit'), message: z.string().min(1).max(4000), paths: z.array(z.string().max(1024)).max(500).optional() }),
  z.object({ action: z.literal('checkout'), branch: z.string().max(300), create: z.boolean().optional(), parkFirst: z.boolean().optional() }),
  z.object({ action: z.literal('merge'), branch: z.string().max(300) }),
  z.object({
    action: z.literal('resolve_merge'),
    mergeRef: Ref.describe(
      'The `mergeRef` git.merge handed back with the conflict, unchanged. It says WHICH conflict these answers ' +
        'are about \u2014 the two commits and what git made of them \u2014 and the branch is taken from IT rather ' +
        'than from `branch`. Required: applying the answers re-runs the merge, so a resolve that cannot say which ' +
        'conflict it is settling is refused with guard_required, and one whose conflict has moved since is refused ' +
        'with stale_merge. Nothing is merged either way \u2014 run git.merge again and answer what it reports now.'
    ),
    branch: z
      .string()
      .max(300)
      .optional()
      .describe('The branch being merged in. Cross-checked against the mergeRef rather than used, so naming a different one is refused.'),
    choices: z
      .record(z.string(), z.unknown())
      .describe(
        'How to settle each conflicting file, keyed by the `path` git.merge reported for it, spelled exactly as ' +
          'it reported it. THOSE PATHS ARE RELATIVE TO THE REPOSITORY ROOT and not to the open project, so they ' +
          'are not the paths source.read and the rest of this surface take \u2014 the two differ whenever the project ' +
          'sits inside a larger repository, and every conflicting file git.merge reports carries both: `path` to ' +
          'send back here, `sourcePath` to read the file with. A value is either "ours" or ' +
          '"theirs" for the whole file, or an array of "ours" | "theirs" | "both" | "merged" \u2014 one entry per ' +
          'conflicting hunk, in the order git reports them, which is the order git.merge listed them in, and ' +
          'exactly as many entries as that file has hunks. Every key must be a path git.merge reported, and ' +
          '"merged" is only an answer where that hunk offered one. A file you leave out keeps this branch\'s ' +
          'version. Anything else \u2014 a misspelt path, a short or long list, an empty one, an explicit null \u2014 ' +
          'is refused with bad_choices and nothing changed.'
      ),
  }),
  z.object({ action: z.literal('delete_branch'), branch: z.string().max(300), force: z.boolean().optional() }),
  z.object({ action: z.literal('restore_file'), ref: z.string().max(200).optional().describe('The revision to come back to. Defaults to HEAD — the last commit.'), path: RelPath }),
  z.object({ action: z.literal('restore_project'), ref: z.string().max(200) }),
  z.object({ action: z.literal('park') }),
  z.object({ action: z.literal('unpark') }),
  z.object({ action: z.literal('push'), branch: z.string().max(300).optional().describe('The branch to push. Defaults to the branch the project is on.') }),
  z.object({ action: z.literal('publish'), repoName: z.string().max(200), private: z.boolean().optional() }),
]));

// --- descriptions ------------------------------------------------------------
//
// Short, and about what the tool is FOR rather than about every field it takes
// — the schema already says the fields, and a description that repeats them is
// paid for in every client's context on every call.

// The eight domain schemas by name, so a refusal can say what the action it
// named actually accepts without a second table to go stale.
const DOMAIN_SCHEMAS = {};

const DESCRIPTIONS = {
  target:
    'Inspect and edit the source-backed element behind what is on screen. read returns everything Stacki knows ' +
    'about it — file and lines, the component chain, props, classes, children, where its words come from and how ' +
    'many copies of it the page is rendering — so you do not have to search the repository for any of that. ' +
    'It EDITS as well as reads, and the structural verbs are here rather than in source: set_text, set_prop, ' +
    'set_classes, add_class, set_tag, insert_before, insert_after, append_child, duplicate, move and remove — so ' +
    '"put this inside that", "delete this" and "add a card here" are one call on the object Stacki already ' +
    'identified. The edits go through Stacki’s own editor: they appear on the canvas at once, land on the undo ' +
    'stack, and save through the normal writer. Give the ref from get_context, comment(focus) or an earlier read; omit it ' +
    'to act on what the user has selected right now. A ref carries the document as your read found it, so an ' +
    'edit through one is refused if anybody changed that document meanwhile — you do not have to ask for that. ' +
    'Text that comes from a {binding} is NOT replaced with a literal: the answer says where the real value lives.',
  style:
    'Why an element looks the way it does, and how to change it. read lists every AUTHORED declaration Stacki ' +
    'can see reaching it, in cascade order, with the selector, the file it was authored in, whether it wins, ' +
    'what overrides it, and any CSS variables it reads — so "make the gap larger" needs no grep for a class ' +
    'name. CSS a build step generates (Tailwind, UnoCSS) is in no project file, so it cannot be in that scan: ' +
    '`coverage` says what the scan could not contain, `documentRules` is what the SERVED PAGE reports matching ' +
    'the element, and `coverage.complete` is true only when nothing reaching it is unaccounted for. A rule from ' +
    'the served page carries no file and no identity, because there is nothing in the project to edit. Writes go ' +
    'through the Style panel’s own code, so they are one undo step. Also the project’s CSS custom properties.',
  source:
    'Project files as text, and the LAST resort rather than the first. It is the fallback for code Stacki cannot ' +
    'model as a tree — a .ts or .js module, a config, a framework component — and the honest route when target ' +
    'reports a file unrepresentable. It is NOT the way to answer a question about the project: use project or ' +
    'page for structure, target for .astro markup, style for CSS and content for collection entries. Those keep ' +
    'undo, the preview and the editor in step, and they answer from what Stacki has already parsed; reading the ' +
    'files to work the same thing out costs more calls and can be wrong. Paths are project-relative. Replacing a ' +
    'file that already exists needs the ref your read gave you (or its digest); creating one does not.',
  // THESE FIVE WERE ONE-LINE CATALOGUE LABELS, AND A CATALOGUE LABEL IS NOT
  // RETRIEVAL METADATA.
  //
  // With tool search on — the default on the host this is measured against — a
  // description is what a tool is FOUND by, and these listed their verbs
  // without ever saying which question they answer. Measured over sixteen
  // held-out sessions: `source` took 30 of 80 calls, and not one of them was on
  // the single file in the fixture that `source`'s own description names as the
  // case it exists for. Asked "which component renders the header?", the model
  // read four files by hand rather than call `page.component_usage`, which is
  // the operation for exactly that.
  //
  // So each now leads with the question a person actually types, in their
  // words rather than the API's. They are still far shorter than `capture` and
  // `get_comments`, and `test/host-limits.js` holds the ceiling.
  page:
    'Pages, folders and components as project objects, and the fast answer to "which component renders this?", ' +
    '"what routes does this project have?" and "where is this component used?". list gives every route with its ' +
    'file; component_usage names every page an component appears on; dynamic_paths asks the running dev server ' +
    'what a [slug] route really stands for. Reach for this BEFORE reading files: it answers structure questions ' +
    'from what Stacki has already parsed, and reading the pages by hand to work the same thing out is the long ' +
    'way round. Also create, move, rename and delete.',
  content:
    'Content collections and CMS data — the answer to "rename that blog post", "what collections does this ' +
    'project have?" and "change the title of this entry". Reads the real Astro content config, so it knows each ' +
    'collection\u2019s schema and validates an entry against it before writing. Entries are objects with fields, ' +
    'not files to be text-edited: editing frontmatter through source instead loses the schema check and the ' +
    'references between entries. Also create, delete, rename and validate.',
  asset:
    'Images, fonts, downloads and data files already in the project, under public/ and src/ — the answer to ' +
    '"what images does this use?", "how big is that?" and "move this into a folder". list and measure without ' +
    'reading the bytes; read and write the text ones; make folders, move, rename, delete. Renaming or moving ' +
    'updates what refers to it. This is for files that exist; it does not download or generate anything.',
  project:
    'The open project as a whole, and the first thing to ask when you do not know what you are looking at: ' +
    'info and scan give the routes, components, layouts and stylesheets in one call; classes gives every class ' +
    'name in use. Also whether the preview is running, why it is not, and how to start it — and Stacki\u2019s own ' +
    'undo and redo, which is what "undo that" means here, not git. probe fetches a page from the project\u2019s own ' +
    'dev server and nothing else. If a resource-capable client is available, stacki://project/profile is the ' +
    'same picture in one read.',
  git:
    'The repository, through Stacki\u2019s own git operations — "commit what we changed", "what has changed?", ' +
    '"put that file back", "make a branch". status and info and history and diffs are readable at any level; ' +
    'committing, switching, restoring, merging and pushing need full control. A refusal names its cause — a ' +
    'merge conflict, uncommitted work in the way, a branch that is not there — rather than saying it failed. ' +
    'publish creates a repository on GitHub under the person\u2019s own account, which is the one thing here that ' +
    'reaches outside this machine.',
};

// --- registration ------------------------------------------------------------

/**
 * Put the Agent API on `server`.
 *
 * `api.run(domain, action, args)` is the app's own implementation — the
 * permission gate, the refs and the dispatch all live behind it, so this file
 * describes the surface and nothing else.
 */
function registerAgentTools(server, { api }) {
  publishChecked(
    server,
    'get_capabilities',
    {
      title: 'What Stacki can do here',
      description:
        'A fast answer to "what is Stacki able to do right now": its version, the open project and branch, the ' +
        'agent-access level the person has granted, every domain and action with whether this level may run it, ' +
        'and the current limitations. Call it once at the start rather than discovering a refusal. Pass a `topic` ' +
        'to get one of Stacki\'s guides as text — the same bytes as the stacki://guide/ resources, for a client ' +
        'that does not do resources. It lists the topics it has.',
      inputSchema: z.object({
        topic: z
          .enum(GUIDE_TOPICS)
          .optional()
          .describe('One of Stacki\'s guides. Omit for capabilities.'),
      }),
      outputSchema: Envelope,
      annotations: READ_ONLY,
    },
    // THE RESOURCE-FREE ROAD TO THE SAME PLACE.
    //
    // A host that ignores resources entirely is a first-class client, and the
    // instructions promise it this. It is the same string the resource serves,
    // read from the same module, so the two cannot drift into disagreeing.
    async ({ topic } = {}) => {
      if (!topic) return answer({ ...api.capabilities(), guideTopics: GUIDE_TOPICS });
      const t = TOPICS[topic];
      if (!t) {
        return answer({
          ok: false,
          code: 'bad_topic',
          message: `Stacki has no guide called ${topic}.`,
          guideTopics: GUIDE_TOPICS,
        });
      }
      return answer({ ok: true, topic, title: t.title, uri: guideUri(topic), text: t.body });
    }
  );

  const domain = (name, inputSchema, annotations) => {
    // Kept by name so a refusal can say what the action it named accepts,
    // without a second table that would go stale.
    DOMAIN_SCHEMAS[name] = inputSchema;
    return server.registerTool(
      name,
      {
        title: `Stacki ${name}`,
        description: DESCRIPTIONS[name],
        inputSchema: advertised(inputSchema),
        outputSchema: Envelope,
        annotations,
      },
      async (args) => {
        // THE CHECK THE HOST NO LONGER DOES, one step later and in the one
        // place that can shape a refusal. Same schema, same zod — and
        // `parsed.data`, not `args`, so every default and coercion the schema
        // declares is still applied exactly where it was.
        const parsed = inputSchema.safeParse(args || {});
        if (!parsed.success) return answer(badArguments(name, args?.action, parsed.error));
        const { action, ...rest } = parsed.data;
        const shaped = normalise(name, action, rest);
        // Declaring `text` optional is what lets `value` be accepted; the cost
        // is that a call with NEITHER now reaches here instead of being refused
        // by the schema. Refused with a sentence that names both, which is what
        // the Zod error should have said in the first place — in BOTH forms of
        // the operation. See `textlessSetText`.
        if (name === 'target') {
          const textless = textlessSetText(action, shaped);
          if (textless) return answer(textless);
        }
        return answer(await api.run(name, action, shaped));
      }
    );
  };

  domain('target', TargetInput, annotationsFor('target'));
  domain('style', StyleInput, annotationsFor('style'));
  domain('source', SourceInput, WRITES);
  domain('page', PageInput, annotationsFor('page'));
  domain('content', ContentInput, annotationsFor('content'));
  domain('asset', AssetInput, annotationsFor('asset'));
  domain('project', ProjectInput, annotationsFor('project'));
  domain('git', GitInput, annotationsFor('git', { remote: true }));
}

/** `{a, b, c?}` — the fields of one object argument, required ones first-class. */
function fieldsOf(spec) {
  if (!spec || typeof spec !== 'object') return null;
  if (spec.type === 'array' && spec.items?.type === 'object') {
    const inner = fieldsOf(spec.items);
    return inner ? `[${inner}]` : '[{…}]';
  }
  if (spec.type !== 'object' || !spec.properties) return null;
  const required = new Set(spec.required || []);
  const names = Object.keys(spec.properties).map((name) => (required.has(name) ? name : `${name}?`));
  return names.length ? `{${names.join(', ')}}` : null;
}

/**
 * The argument shapes, where a host will actually show them.
 *
 * A discriminated union converts to `{type:'object', oneOf:[…]}` with no
 * top-level `properties`, and a client that renders `properties` — which is
 * most of them, and was the one a real agent drove this API with — therefore
 * renders NOTHING. Four `style` operations were unusable because of it: an
 * agent that could not see `edit` sent the fields at the top level, got back
 * "edit is required", and had to guess what belonged inside it one refusal at
 * a time. `remove_section` and `move_heading` were never reached at all.
 *
 * So every argument any branch takes is named at the top level too, with what
 * each action wants of it. The shapes are READ OUT of the branches rather than
 * written down again, so they cannot drift from the schema the handler checks;
 * the branches are still published underneath, unchanged, and remain the exact
 * contract. Nothing here narrows anything — a top-level entry describes, the
 * `oneOf` decides.
 */
function summarised(json) {
  const branches = Array.isArray(json?.oneOf) ? json.oneOf : Array.isArray(json?.anyOf) ? json.anyOf : null;
  if (!branches || !branches.length || json.properties) return json;

  const actions = [];
  const seen = new Map(); // property -> { types, shapes: [`action: {…}`], actions }
  for (const branch of branches) {
    const action = branch?.properties?.action?.const ?? branch?.properties?.action?.enum?.[0];
    if (typeof action !== 'string') return json; // not the action union this is for
    actions.push(action);
    const required = new Set(branch.required || []);
    for (const [name, spec] of Object.entries(branch.properties || {})) {
      if (name === 'action') continue;
      if (!seen.has(name)) seen.set(name, { types: new Set(), shapes: [], actions: [] });
      const entry = seen.get(name);
      if (typeof spec?.type === 'string') entry.types.add(spec.type);
      entry.actions.push(required.has(name) ? action : `${action} (optional)`);
      const shape = fieldsOf(spec);
      if (shape) entry.shapes.push(`${action}: ${shape}`);
    }
  }

  const properties = {
    action: {
      type: 'string',
      enum: actions,
      description: 'Which operation to run. The other arguments are the ones that action takes.',
    },
  };
  for (const [name, entry] of seen) {
    const type = entry.types.size === 1 ? [...entry.types][0] : null;
    properties[name] = {
      ...(type ? { type } : {}),
      description: entry.shapes.length
        ? `${entry.shapes.join('; ')}. Used by: ${entry.actions.join(', ')}.`
        : `Used by: ${entry.actions.join(', ')}.`,
    };
  }
  return { ...json, properties, required: ['action'] };
}

/**
 * The strict schema, advertised — and checked by Stacki rather than by the host.
 *
 * The SDK validates `tools/call` arguments against a tool's input schema BEFORE
 * the handler runs, and a failure there is a protocol error: a bare English
 * sentence, `isError`, and no structuredContent at all. Measured against a real
 * client, that is what every argument mistake on all eight domain tools came
 * back as —
 *
 *   git {action:'push'}
 *     -> "Input validation error: Invalid arguments for tool git:
 *         branch: Invalid input: expected string, received undefined"
 *
 * — the one shape in this surface an agent cannot branch on, and the DEFAULT
 * for the 73 operations that declare a required argument rather than a handful
 * of cases.
 *
 * A tool schema only has to be a Standard Schema: `tools/list` converts it with
 * `~standard.jsonSchema[io]()` and `tools/call` checks it with
 * `~standard.validate`. So the conversion is delegated to the real schema, and
 * the check is made a pass-through, so the identical zod schema can run inside
 * the handler where a failure becomes Stacki's own refusal.
 *
 * The strictness is NOT relaxed: nothing here loosens a type, and every branch
 * the real schema converts to is published unchanged. `summarised()` adds a
 * top-level description of the same branches — see above for the client that
 * could not read them.
 */
function advertised(schema) {
  const std = schema['~standard'];
  const convert = std.jsonSchema || {
    input: (o) => z.toJSONSchema(schema, { target: o?.target || 'draft-2020-12', io: 'input', unrepresentable: 'any' }),
    output: (o) => z.toJSONSchema(schema, { target: o?.target || 'draft-2020-12', io: 'output', unrepresentable: 'any' }),
  };
  return {
    '~standard': {
      version: 1,
      vendor: 'stacki',
      jsonSchema: {
        input: (o) => summarised(convert.input(o)),
        output: (o) => convert.output(o),
      },
      // Deliberately accepts everything. The handler runs the same schema a
      // moment later; validating twice would only mean the host's copy won.
      validate: (value) => ({ value }),
    },
    // AND THE REAL CHECK, STILL REACHABLE BY NAME.
    //
    // The SDK only ever looks at `~standard`, but this object is also what a
    // caller reading a registration back is handed, and the one thing such a
    // caller wants to ask is "would the tool accept this?" — test/contract-wording.js
    // puts the sentences a guide tells an agent to send to the schema itself
    // rather than to a reading of it. Delegated to the real schema, so the
    // answer is the one the handler will give, not a second implementation of
    // it; a shim that quietly answered "yes" to everything here would turn that
    // suite green by making its question meaningless.
    safeParse: (value) => schema.safeParse(value),
    parse: (value) => schema.parse(value),
    // AND THE TREE ITSELF, for the one reader that needs the schema rather than
    // an answer from it. test/schema-strictness.js walks the CLOSED tree asking
    // each node, through `openSourceOf`, what it was before the rebuild, and
    // requires the two to publish the same keywords — the check that would have
    // caught twelve bounds being deleted. There is no way to do that through a
    // `safeParse`, and the schema a tool is registered with is otherwise
    // reachable only for the eight domains that export theirs. Not read by the
    // SDK, which looks at `~standard` and nothing else.
    schema,
  };
}

/** Zod's complaints, in the `{path, message, code}` vocabulary this API uses. */
function issuesOf(error) {
  return (error?.issues || []).map((issue) => {
    const at = (issue.path || []).map((p) => (p && typeof p === 'object' ? p.key : typeof p === 'symbol' ? String(p) : p));
    // Zod's sentence for a value that simply is not there reads "Invalid input:
    // expected nonoptional, received undefined" on an unknown-typed field,
    // which names nothing an agent can act on. A missing value gets Stacki's
    // sentence; every other issue keeps zod's, which is more precise than
    // anything written here would be.
    const absent = /received undefined/.test(String(issue.message || ''));
    return {
      path: at,
      message: absent ? `${at.join('.') || 'This argument'} is required.` : issue.message,
      code: issue.code,
    };
  });
}

/**
 * The same object, with unknown keys refused rather than dropped.
 *
 * Only touches a plain object schema. Anything that is not object-shaped — a
 * union, something with a refinement wrapped round it — is handed back
 * untouched, because rebuilding one from `.shape` would lose whatever the
 * wrapper was there to add.
 *
 * AN ALREADY-STRICT ROOT IS NOT A CLOSED SCHEMA, AND USED TO BE TREATED AS ONE.
 *
 * There was a second early return here: a schema whose own catchall is `never`
 * was handed straight back. That reads as an optimisation and is a hole, because
 * strictness at the top says nothing whatever about the objects underneath —
 * which is the entire argument for `closeShape` over `z.strictObject` two
 * functions up: "a mistyped field inside `node` is exactly as invisible as a
 * mistyped field beside it, and rather more likely". Measured through
 * `publishChecked` with `z.strictObject({ node: z.object({ a }) })`: the call
 * `{node:{a:'x', stackiUnknownKey:1}}` was accepted, the key deleted, and the
 * handler RAN with arguments nobody wrote. None of the six non-domain tools
 * declares a strict root today, so nothing on the shipping surface was open —
 * the defect was that the guard sat one `z.strictObject` away from silently
 * reopening everything beneath it, on the day somebody closed a root by hand
 * believing that made it safer.
 *
 * Rebuilding an already-strict object costs nothing it can lose: `closeShape`
 * produces a strict object either way, and `carried()` puts the original's own
 * checks and description back.
 */
function closedObject(schema) {
  const shape = schema && typeof schema === 'object' ? schema.shape : null;
  if (!shape || typeof shape !== 'object') return schema;
  // `closeShape`, not `z.strictObject`, so a nested argument is closed here for
  // the same reason it is inside a domain branch: `audit`'s `viewports` takes
  // objects, and a key added beside `width` and `height` was dropped without a
  // word. What stays open is what should — a record's VALUES, where arbitrary
  // keys are the point.
  //
  // Through `carried()`, so the top-level object of a non-domain tool keeps its
  // own checks and description too. Nothing on the surface hangs a check on a
  // tool's outermost object today; the five tools that come through here are
  // rebuilt by the same rule as everything below them so that the day one does,
  // it is not deleted on the way to being published.
  return carried(closeShape(shape), schema);
}

/**
 * The same refusal for a tool that is not a domain.
 *
 * The fix below was applied to the eight domain tools and stopped there, so
 * five of the thirteen published tools — get_context, capture, get_comments,
 * comment and get_capabilities — still answered a mistyped argument with the
 * raw host sentence this whole mechanism exists to remove. `capture` and
 * `comment` are the two tools the `visual` level exists for, which made the raw
 * shape the FIRST thing an agent at that level could hit.
 *
 * They have no `action` to be wrong about, so there is no bad_action half; the
 * envelope is otherwise the domain one, down to the `issues` vocabulary.
 */
/**
 * THE SHAPE OF A REFUSAL, DECLARED RATHER THAN RELIED UPON.
 *
 * The five non-domain tools publish the PAYLOAD they answer with when they
 * work, and `badToolArguments` below answers something else entirely: no
 * `revision`, no `timestamp`, and two fields those payloads never declare. That
 * shipped only because both the SDK server and the official client skip output
 * validation when `isError` is set -- so the declared contract was false, and
 * the day either stops skipping, an argument mistake on those tools answers
 * with nothing at all rather than with something wrong.
 *
 * Publishing `z.union([Payload, ToolRefusal])` makes the declaration true
 * without loosening the success half: a payload still has to be exactly a
 * payload. It is the move `audit` already made by declaring the four fields
 * its gate refusal carries.
 *
 * AND IT IS STRICT, ON A SURFACE WHOSE WHOLE SCHEMA MECHANISM EXISTS TO STOP AN
 * OBJECT ACCEPTING KEYS IT DOES NOT DECLARE.
 *
 * This was `z.object`, which STRIPS. Because `orRefusal(X)` is
 * `z.union([X, ToolRefusal])`, that made the refusal branch a hole straight
 * through the declared output schema of the four tools that use it --
 * get_context, capture, get_comments and comment: ANY value carrying
 * `{ok:false, code, message}` validated against it no matter what else it held.
 * Measured: a value carrying nothing but `ok`, a code, a message and a fourth
 * key called `smuggled` parsed clean, with `smuggled` silently deleted from the
 * parse result. The two things a
 * refusal on this surface must never carry are an undeclared field and a host
 * absolute path, and a contract check that validates a refusal against the
 * schema its tool publishes was being answered yes either way.
 *
 * The advertised document does not change: zod already emits
 * `additionalProperties: false` for a stripping object under `io: 'output'`,
 * which is the direction the SDK converts an output schema in. What closes here
 * is the gap between what that document says and what the schema accepts.
 */
const ToolRefusal = z.strictObject({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  operation: z.string().optional(),
  issues: z
    .array(
      z.strictObject({ path: z.array(z.union([z.string(), z.number()])), message: z.string(), code: z.string().optional() })
    )
    .optional(),
});

/** Two JSON Schema fragments, compared as documents rather than as objects. */
const sameFragment = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A fragment's alternatives: the members of a bare `anyOf`, or the thing itself. */
const alternativesOf = (spec) =>
  spec && typeof spec === 'object' && Array.isArray(spec.anyOf) && Object.keys(spec).length === 1 ? spec.anyOf : [spec];

/**
 * THE UNION DELETED THE PUBLISHED SHAPE OF THE TOOLS IT WAS APPLIED TO.
 *
 * `z.union([Payload, ToolRefusal])` emits `{anyOf:[{…},{…}]}` and NOTHING at the
 * top level — no `properties`, no `required`. Measured on all four tools that
 * declare one: `get_context`, `capture`, `get_comments` and `comment` each went
 * from publishing a named, typed field list to publishing two nested branches
 * and a root with `$schema` and `anyOf` in it. A host that reads
 * `outputSchema.properties` to render or to type a result — the same client
 * class `summarised()` a few hundred lines up exists to serve — got nothing at
 * all. Declaring the refusal made the declaration TRUER and the document LESS
 * USEFUL, which is not a trade this surface has to make.
 *
 * So the branches are kept exactly as they are, and the fields they declare are
 * ALSO published at the top level, where a client that has never heard of
 * `anyOf` will look. Both readings stay true at once:
 *
 *   - a hoisted property is asserted against every answer, so it may only be
 *     hoisted in a form BOTH branches satisfy. A name that appears once is
 *     copied; a name both branches declare identically is copied once; a name
 *     they declare DIFFERENTLY (`ok` is `boolean` in a payload and `const
 *     false` in a refusal) is published as the alternatives side by side, which
 *     is the only shape that accepts both. Nothing is narrowed and nothing that
 *     used to validate stops validating.
 *
 *   - `required` CANNOT carry the payload's list, and this is the one place the
 *     two readings genuinely cannot both hold. A top-level `required` is
 *     asserted against every answer too, so publishing the payload's required
 *     fields there would refuse every refusal — reinstating exactly the false
 *     declaration `orRefusal` was written to end. What is published instead is
 *     the INTERSECTION: the fields every possible answer really does carry.
 *     For `get_comments` and `comment` that is `ok`, which is the useful half
 *     anyway ("every answer says whether it worked"); for `get_context` and
 *     `capture` the payload and the refusal share no field at all, so the
 *     honest answer is that nothing is guaranteed, and `required` is omitted
 *     rather than asserted falsely. The per-branch `required` lists are still
 *     there, in the branches, for a client that reads them.
 *
 * The alternative — collapsing the two branches into one object with everything
 * optional — would publish `properties` and `required` at the root and stop
 * saying which COMBINATIONS are legal, so `{}` would validate against a tool
 * that can never answer with it. That trades a true document for a readable
 * one; this trades nothing.
 */
function hoistUnionProperties(doc) {
  const branches = Array.isArray(doc?.anyOf) ? doc.anyOf : null;
  const shaped = branches && branches.length > 1 && branches.every((b) => b && typeof b === 'object' && b.properties && typeof b.properties === 'object');
  // Not a union of objects: hand back exactly what was converted. A shape this
  // does not understand must not be half-rewritten.
  if (!shaped) return doc;
  const properties = {};
  for (const branch of branches) {
    for (const [name, spec] of Object.entries(branch.properties)) {
      if (!(name in properties)) {
        properties[name] = spec;
        continue;
      }
      if (sameFragment(properties[name], spec)) continue;
      const merged = [];
      for (const alt of [...alternativesOf(properties[name]), ...alternativesOf(spec)]) {
        if (!merged.some((m) => sameFragment(m, alt))) merged.push(alt);
      }
      properties[name] = { anyOf: merged };
    }
  }
  const required = branches.reduce((kept, branch) => kept.filter((name) => (branch.required || []).includes(name)), [...(branches[0].required || [])]);
  return { ...doc, type: 'object', properties, ...(required.length ? { required } : {}) };
}

/**
 * A schema that VALIDATES as itself and PUBLISHES with its fields hoisted.
 *
 * Same shape as `advertised()` and for a related reason: the SDK reads
 * `~standard` and nothing else, so the document a client is served can be
 * improved without touching what the server actually checks an answer against.
 * `validate` is delegated to the real schema rather than reimplemented, so a
 * payload with a wrong-typed field is refused exactly as it was — that
 * assertion exists in test/schema-strictness.js and it is still the same zod
 * answering it.
 */
function publishedAs(schema, shapeDocument) {
  const std = schema['~standard'];
  const convert = std.jsonSchema || {
    input: (o) => z.toJSONSchema(schema, { target: o?.target || 'draft-2020-12', io: 'input', unrepresentable: 'any' }),
    output: (o) => z.toJSONSchema(schema, { target: o?.target || 'draft-2020-12', io: 'output', unrepresentable: 'any' }),
  };
  return {
    '~standard': {
      version: 1,
      vendor: 'stacki',
      jsonSchema: {
        input: (o) => shapeDocument(convert.input(o)),
        output: (o) => shapeDocument(convert.output(o)),
      },
      validate: (value) => schema['~standard'].validate(value),
    },
    safeParse: (value) => schema.safeParse(value),
    parse: (value) => schema.parse(value),
    // The union itself, for the readers that need the schema rather than an
    // answer from it — the refusal-branch derivation in
    // test/schema-strictness.js finds the four tools by looking for
    // `ToolRefusal` among a published union's options.
    schema,
  };
}

/** What a tool publishes when its answer is either a payload or a refusal. */
const orRefusal = (payload) => publishedAs(z.union([payload, ToolRefusal]), hoistUnionProperties);

/**
 * A CLAUSE, NOT A SENTENCE — THE FULL STOP THE ISSUE HAD ALREADY WRITTEN.
 *
 * `issuesOf` ends its own sentence ("name is required.") and both composers
 * below dropped that straight into a longer one and then punctuated again. A
 * real agent received this from the packaged app, during the native dogfood:
 *
 *   asset.rename could not run — name: name is required.. asset.rename takes: path, name.
 *
 * Two full stops, because two layers each believed they were the last one. The
 * same seam puts a stop in front of a semicolon as soon as there are two issues
 * — "path: path is required.; name: name is required." — which is the identical
 * mistake wearing different punctuation.
 *
 * So a clause is a clause here: whatever sentence-ending punctuation the issue
 * brought with it is trimmed, and the composer — the only thing that knows
 * whether a clause is followed by a semicolon, by another sentence, or by the
 * end — puts one back exactly once. Nothing about WHICH issue is reported
 * changes. This is only the surface talking to an agent in a sentence it has to
 * parse, which is the thing the surface is for.
 */
const asClause = (issue) => `${(issue?.path || []).join('.') || 'arguments'}: ${String(issue?.message ?? '').replace(/[.\s]+$/, '')}`;

/** Those clauses as one sentence, ended once. */
const clausesOf = (issues) => `${issues.map(asClause).join('; ')}.`;

/** Whatever zod called the failure at one top-level field, if it named one. */
const zodCodeAt = (error, field) => (error?.issues || []).find((i) => (i?.path || [])[0] === field)?.code || null;

function badToolArguments(tool, error) {
  const issues = issuesOf(error);
  return {
    ok: false,
    code: 'bad_arguments',
    operation: tool,
    issues,
    message: `${tool} could not run — ${clausesOf(issues)}`,
  };
}

/**
 * Register a tool whose arguments Stacki checks rather than the host.
 *
 * Same trick as `domain()` above and for the same reason — `advertised()`
 * publishes the real schema and lets everything through, and the handler runs
 * the identical zod a moment later so a failure becomes an envelope. Exported
 * because three of the five non-domain tools are registered from other files;
 * a second copy of this in each of them is how the eight and the five drifted
 * apart in the first place.
 *
 * A refusal carries `isError`, which is what stops the SDK validating it
 * against a tool's payload output schema: a refusal is not a payload, and
 * `get_context` declaring its snapshot shape must not mean a bad argument comes
 * back as an output-validation crash instead of an answer.
 */
function publishChecked(server, name, config, handler) {
  // CLOSED HERE TOO, AND FOR THE SAME REASON.
  //
  // `closed()` was applied to the eight domain unions and stopped there, which
  // left the six tools that are not domains — get_context, capture,
  // get_comments, comment, get_capabilities and audit — still stripping a key
  // they did not recognise. That is the same silent retarget, on tools where it
  // is just as consequential: `audit({ rout: '/pricing' })` dropped the typo
  // and audited the site root instead, reporting findings about a page nobody
  // asked about; `get_comments({ scop: 'selection' })` widened a read of one
  // element's reviews to the whole project.
  //
  // Applied at the composition point rather than at six registration sites, so
  // a tool added beside them tomorrow is closed without its author knowing to
  // ask — which is the same argument the `checked` facade in tools.js already
  // makes for the refusal shape.
  const schema = closedObject(config.inputSchema);
  return server.registerTool(name, { ...config, inputSchema: advertised(schema) }, async (args, extra) => {
    const parsed = schema.safeParse(args || {});
    if (!parsed.success) return answer(badToolArguments(name, parsed.error));
    return handler(parsed.data, extra);
  });
}

/**
 * An argument failure, in Stacki's own shape.
 *
 * `issues` is the same `{path, message, code}` vocabulary content.validate
 * answers with, so "a field is wrong" has one shape across this API whether the
 * field is in a content entry or in a tool call.
 */
function badArguments(domain, action, error) {
  const known = actionsOf(domain);
  // NO ACTION AT ALL IS A MISSING ARGUMENT, NOT AN UNKNOWN ACTION.
  //
  // These were one branch, and a call with no `action` came back as this,
  // reproduced against the packaged app during the native dogfood:
  //
  //   {"ok":false,"code":"bad_action","operation":"project.",
  //    "message":"Stacki has no project.(no action). Call get_capabilities for
  //               what it does have."}
  //
  // `operation` is "project." with a dangling dot — a value a client reads as
  // an operation name, and there is no operation called "project." — and
  // "Stacki has no project.(no action)" is not a sentence. Underneath the
  // wording it was also the wrong classification: nothing unknown was named,
  // a REQUIRED ARGUMENT was left out, and `bad_arguments` is the code this
  // surface uses for that everywhere else. An agent branching on `bad_action`
  // goes looking for a name it got wrong; there is no name to look at.
  //
  // What was right about the old answer is kept whole: it listed every action
  // the tool has, which is the one thing that gets the caller unstuck, so
  // `actions` and the sentence both still carry the list.
  if (typeof action !== 'string') {
    return {
      ok: false,
      code: 'bad_arguments',
      // The tool, not "project." — a domain with no action is named by the
      // domain, which is the only true thing there is to say about it.
      operation: domain,
      // Stacki's own sentence for a value that is simply not there, in the
      // shape `issuesOf` gives every other absent argument — and carrying
      // ZOD'S OWN issue code for the discriminator rather than a hand-picked
      // one. Two reasons, and the second is the load-bearing one: whatever zod
      // called it is the truthful label for what failed, and a refusal-code
      // literal written here would be swept up by the enumeration discovery in
      // test/refusal-contract.js, which reads `code:` properties out of this
      // file and cannot tell a zod issue code from a refusal code.
      issues: [{ path: ['action'], message: 'action is required.', ...(zodCodeAt(error, 'action') ? { code: zodCodeAt(error, 'action') } : {}) }],
      actions: known,
      message: `${domain} needs an action and this call named none. ${domain} takes: ${known.join(', ')}.`,
    };
  }
  // An action the tool does not have is a bad ACTION, not a bad argument — the
  // same envelope the dispatcher produces, rather than zod's "Invalid
  // discriminator value" followed by the list in prose.
  if (!known.includes(action)) {
    return {
      ok: false,
      code: 'bad_action',
      operation: `${domain}.${action}`,
      message: `Stacki has no ${domain}.${action}. Call get_capabilities for what it does have.`,
      actions: known,
    };
  }
  const issues = issuesOf(error);
  // AND WHAT IT WOULD HAVE TAKEN.
  //
  // Naming the key the caller got wrong is half an answer: "Unrecognized key:
  // \"rout\"" tells an agent to stop guessing but not what to guess next, and
  // the top-level `properties` block the schema publishes lists every branch's
  // arguments side by side, which is what invited the mistake. The accepted
  // set is right here in the schema, so it travels with the refusal — as a
  // field a client can read, and in the sentence for one that only shows text.
  const accepts = acceptedBy(domain, action);
  return {
    ok: false,
    code: 'bad_arguments',
    operation: `${domain}.${action}`,
    issues,
    accepts,
    message:
      `${domain}.${action} could not run — ${clausesOf(issues)}` +
      (accepts.length ? ` ${domain}.${action} takes: ${accepts.join(', ')}.` : ''),
  };
}

/** The argument names one action actually declares, read from its own branch. */
function acceptedBy(domain, action) {
  const schema = DOMAIN_SCHEMAS[domain];
  const branch = schema?.options?.find((o) => o.shape?.action?.def?.values?.[0] === action || o.shape?.action?.def?.value === action);
  if (!branch?.shape) return [];
  return Object.keys(branch.shape).filter((k) => k !== 'action');
}

/**
 * The one argument this surface calls two things, given one name before it
 * reaches the Agent API.
 *
 * The API below has ONE spelling and does not learn about this: the alias is a
 * property of the wire, where an agent chooses argument names from two schemas
 * that disagreed, and it stops there. `text` wins when both are sent, because
 * `text` is what the action's own schema names first.
 *
 * AND IT HAS TO WIN IN BOTH FORMS, WHICH IS THE WHOLE POINT OF AN ALIAS.
 *
 * The batch branch used to copy `text` across only when `value` was NOT a
 * string, so a call sending both got `text` from the single form and `value`
 * from the batch — two precedences for one pair of names, on the one operation
 * this alias exists because agents already confuse. An agent that filled both
 * in (a client that maps a field twice, a retry that adds the other spelling
 * to a call that was refused) wrote different words in the same element
 * depending on which shape it happened to reach for, and both answered ok.
 *
 * So both branches read the same way: `text` if it is a string, `value`
 * otherwise, and the name the layer underneath uses is the one that goes out —
 * `text` for the action, `value` for the operation. The other spelling is
 * removed rather than left riding along, so nothing downstream can pick the
 * loser back up.
 */
const preferredText = (args) => (typeof args.text === 'string' ? args.text : args.value);

function normalise(domain, action, args) {
  if (domain !== 'target') return args;
  if (action === 'set_text') {
    const text = preferredText(args);
    const { value, ...rest } = args;
    return { ...rest, ...(typeof text === 'string' ? { text } : {}) };
  }
  if (action === 'edit' && Array.isArray(args.operations)) {
    return {
      ...args,
      operations: args.operations.map((op) => {
        if (!op || op.type !== 'set_text') return op;
        const value = preferredText(op);
        const { text, ...rest } = op;
        return { ...rest, ...(typeof value === 'string' ? { value } : {}) };
      }),
    };
  }
  return args;
}

/**
 * THE ONE OPERATION THAT CAN ARRIVE WITH NO ARGUMENT AT ALL — IN EITHER FORM.
 *
 * `set_text` declares BOTH its spellings optional, which is the price of
 * accepting `value` as an alias for `text`: see the note beside
 * `action: "set_text"` in `TargetInput`. So a call carrying NEITHER is
 * schema-legal in both shapes, and the check that closes that hole has to cover
 * both — which it did not.
 *
 * Measured on the shipping surface, one ref, two calls:
 *
 *   target({action:"set_text", ref})                      → bad_arguments
 *   target({action:"edit", ref, operations:[{type:"set_text"}]}) → {"ok":true}
 *
 * The second reached electron/mcp/agent/index.js, where `NORMALIZE.set_text` is
 * `String(o.value ?? '')` — so the batch form ACCEPTED an operation with no
 * text in it and replaced the element's words with the empty string. One
 * surface, two answers, and the one that answered yes silently deleted what was
 * there. An agent that has been refused the action form and reaches for the
 * batch shape instead — which is exactly what the alias note records a real
 * Claude Code doing — got a wipe and an `ok`.
 *
 * So both forms are refused HERE, by one function, in one shape: the same
 * `bad_arguments` code, the same `target.<action>` operation naming, an issue
 * pointing at the argument that is missing, and a sentence that names both
 * spellings. A batch is refused whole, before `api.run`, so nothing in it is
 * applied — a partly-applied batch would be a worse answer than either.
 *
 * An EMPTY STRING is not missing. `{text:""}` and `{value:""}` are a deliberate
 * "make this element say nothing", and both forms have always taken them.
 *
 * @returns {object|null} the refusal, or null when there is nothing to refuse.
 */
function textlessSetText(action, shaped) {
  if (action === 'set_text') {
    if (typeof shaped.text === 'string') return null;
    return {
      ok: false,
      code: 'bad_arguments',
      operation: 'target.set_text',
      issues: [{ path: ['text'], message: 'set_text needs the new text' }],
      message:
        'set_text needs the new text. Send it as `text` — `value` is accepted too, because that is what the same operation is called inside `edit`.',
    };
  }
  if (action === 'edit' && Array.isArray(shaped.operations)) {
    // `normalise` has already run, so the surviving spelling on an operation is
    // `value` whichever name the caller used. A set_text with neither is the
    // one this finds.
    const at = shaped.operations.findIndex((op) => op && op.type === 'set_text' && typeof op.value !== 'string');
    if (at < 0) return null;
    return {
      ok: false,
      code: 'bad_arguments',
      operation: 'target.edit',
      issues: [{ path: ['operations', at, 'value'], message: 'set_text needs the new text' }],
      message:
        `operations.${at} is a set_text with no text in it. Send it as \`value\` — \`text\` is accepted too, because ` +
        'that is what the same operation is called as an action. Nothing in this batch was applied.',
    };
  }
  return null;
}

/**
 * One shape out.
 *
 * A refusal is `ok: false` with a code and a sentence, in content and in
 * structuredContent both — never a protocol error. `isError` is set as well,
 * so a client that reads only that still knows, but the sentence is the part
 * an agent can act on.
 */
function answer(result, { spaces = 2, images = [] } = {}) {
  const body = result && typeof result === 'object' ? result : { ok: false, code: 'failed', message: 'Stacki gave no answer.' };
  // A SECOND CHANNEL, FOR THE ANSWERS THAT ARE PARTLY A PICTURE.
  //
  // An envelope is JSON and always will be, but some answers are worth more
  // with the pixels beside them — and a client can only see an image if it
  // arrives as an image block, not as base64 inside a string. Blocks first,
  // exactly as electron/mcp/tools.js orders the capture tool's, so a host that
  // shows only the first block shows the picture. Nothing is dropped silently:
  // an entry with no data is not sent rather than sent empty.
  const pictures = (Array.isArray(images) ? images : [images])
    .filter((i) => i && typeof i.data === 'string' && i.data)
    .map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType || 'image/png' }));
  return {
    // `spaces` exists for one caller and one reason: the text block is a second
    // copy of the same payload, and an audit's payload is findings. Indenting it
    // costs a third again in bytes on the largest answer this endpoint sends, on
    // a wire where the catalogue already costs 140 KB a session. The envelope
    // answers stay indented, because they are small and a person reads them.
    content: [...pictures, { type: 'text', text: JSON.stringify(body, null, spaces) }],
    structuredContent: body,
    ...(body.ok === false ? { isError: true } : {}),
  };
}

module.exports = {
  registerAgentTools,
  ToolRefusal,
  orRefusal,
  // Exported so the two tools that live outside this file can refuse in exactly
  // the same shape rather than in one that resembles it. See auditTool.js.
  answer,
  // And so the non-domain tools refuse a bad argument in it too, rather than
  // leaving five of the thirteen answering with a raw host sentence. See
  // electron/mcp/tools.js, which composes the whole surface.
  publishChecked,
  badToolArguments,
  DESCRIPTIONS,
  Envelope,
  // What a closed schema was before it was closed, for the invariance check in
  // test/schema-strictness.js. See OPEN_SOURCE.
  openSourceOf,
  TargetInput,
  StyleInput,
  SourceInput,
  PageInput,
  ContentInput,
  AssetInput,
  ProjectInput,
  GitInput,
  annotationsFor,
  READ_ONLY,
  WRITES,
  DESTRUCTIVE,
  REMOTE,
  TOOL_NAMES: ['get_capabilities', ...DOMAINS],
};
