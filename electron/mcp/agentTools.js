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
// absent. A call that names `set_prop` and forgets the prop is refused by the
// protocol rather than by a sentence from us.
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
  .describe('A path inside the open project, relative to its root (src/pages/index.astro). Never absolute.');
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
  code: z.string().nullable().optional().describe('Why not. permission_denied, guard_required, stale_target, bound_value, not_editable, no_project, bad_request, …'),
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

// One operation inside a batch. The same vocabulary as the single-operation
// actions, so learning one teaches the other.
const Operation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_text'), value: z.string().max(20000), replaceBinding: z.boolean().optional() }),
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
]);

// --- target ------------------------------------------------------------------

const withTarget = (shape) => ({
  ref: Ref.optional().describe('The target. Omit to act on whatever is selected in Stacki right now.'),
  ...shape,
});

const guard = {
  expectedRevision: z.number().int().optional().describe('The document revision your read reported. The edit is refused if the document has moved on.'),
  expectedDigest: z.string().max(64).optional().describe('The document digest your read reported.'),
};

const TargetInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('read'),
    ...withTarget({
      navigate: z.boolean().optional().describe('Whether Stacki may open the page and drill into the components to reach it. Default true.'),
    }),
  }),
  z.object({
    action: z.literal('select'),
    ...withTarget({ occurrence: z.number().int().min(0).max(1000).optional().describe('Which rendered copy of a repeated node to scroll to.') }),
  }),
  z.object({
    action: z.literal('enter'),
    ...withTarget({ occurrence: z.number().int().min(0).max(1000).optional().describe('Which rendered copy of the instance to open — the third card, not the first.') }),
  }),
  z.object({ action: z.literal('exit') }),
  z.object({
    action: z.literal('edit'),
    ...withTarget({ ...guard, operations: z.array(Operation).min(1).max(30), label: z.string().max(80).optional() }),
  }),
  z.object({
    action: z.literal('set_text'),
    ...withTarget({
      ...guard,
      text: z.string().max(20000),
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
]);

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

const StyleInput = z.discriminatedUnion('action', [
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
  z.object({ action: z.literal('variables'), limit: z.number().int().min(1).max(400).optional() }),
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
            .describe('The VARIABLE to land in front of — a name like --gap, not a selector. Leave it out to move to the end of the rule.'),
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
]);

// --- source ------------------------------------------------------------------

const SourceInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('read'),
    path: RelPath,
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
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
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1).optional(),
    text: z.string().max(2_000_000),
    ref: FileRef.optional(),
    expectedDigest: Digest.optional(),
  }),
  z.object({ action: z.literal('read_symbol'), fromFile: RelPath, spec: z.string().max(1024), name: z.string().max(200) }),
  z.object({ action: z.literal('resolve_path'), fromFile: RelPath, spec: z.string().max(1024) }),
]);

// --- page --------------------------------------------------------------------

const PageInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('read'), path: RelPath }),
  z.object({ action: z.literal('create'), name: z.string().max(300), layout: z.string().max(120).optional() }),
  z.object({ action: z.literal('delete'), path: RelPath }),
  z.object({ action: z.literal('move'), from: RelPath, to: z.string().max(300).describe('The new path, relative to src/pages.') }),
  z.object({ action: z.literal('folder_create'), dir: z.string().max(300) }),
  z.object({ action: z.literal('folder_rename'), from: z.string().max(300), to: z.string().max(300) }),
  z.object({ action: z.literal('folder_delete'), dir: z.string().max(300) }),
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
]);

// --- content -----------------------------------------------------------------

const ContentInput = z.discriminatedUnion('action', [
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
    entry: z.record(z.string(), z.unknown()).describe('The entry object content.entries reported — it carries where the entry lives.'),
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
  }),
  z.object({ action: z.literal('validate'), collection: z.string().max(200), data: z.unknown() }),
  z.object({ action: z.literal('targets'), collection: z.string().max(200) }),
  z.object({ action: z.literal('rename_plan'), collection: z.string().max(200), from: z.string().max(300), to: z.string().max(300) }),
  z.object({ action: z.literal('rename'), collection: z.string().max(200), from: z.string().max(300), to: z.string().max(300) }),
  z.object({ action: z.literal('sample_entry'), collection: z.string().max(200), id: z.string().max(300).optional() }),
  z.object({ action: z.literal('resolve_import'), fromFile: RelPath, spec: z.string().max(1024) }),
]);

// --- asset -------------------------------------------------------------------

const AssetInput = z.discriminatedUnion('action', [
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
]);

// --- project -----------------------------------------------------------------

const ProjectInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('info') }),
  z.object({ action: z.literal('scan') }),
  z.object({ action: z.literal('classes'), limit: z.number().int().min(1).max(2000).optional() }),
  z.object({ action: z.literal('dependencies') }),
  z.object({ action: z.literal('install') }),
  z.object({ action: z.literal('diagnose') }),
  z.object({ action: z.literal('probe'), url: z.string().max(2048).optional() }),
  z.object({ action: z.literal('dev_status') }),
  z.object({ action: z.literal('dev_start') }),
  z.object({ action: z.literal('dev_stop') }),
  z.object({ action: z.literal('undo') }),
  z.object({ action: z.literal('redo') }),
]);

// --- git ---------------------------------------------------------------------

const GitInput = z.discriminatedUnion('action', [
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
  z.object({ action: z.literal('resolve_merge'), branch: z.string().max(300), choices: z.record(z.string(), z.unknown()) }),
  z.object({ action: z.literal('delete_branch'), branch: z.string().max(300), force: z.boolean().optional() }),
  z.object({ action: z.literal('restore_file'), ref: z.string().max(200), path: RelPath }),
  z.object({ action: z.literal('restore_project'), ref: z.string().max(200) }),
  z.object({ action: z.literal('park') }),
  z.object({ action: z.literal('unpark') }),
  z.object({ action: z.literal('push'), branch: z.string().max(300) }),
  z.object({ action: z.literal('publish'), repoName: z.string().max(200), private: z.boolean().optional() }),
]);

// --- descriptions ------------------------------------------------------------
//
// Short, and about what the tool is FOR rather than about every field it takes
// — the schema already says the fields, and a description that repeats them is
// paid for in every client's context on every call.

const DESCRIPTIONS = {
  target:
    'Inspect and edit the source-backed element behind what is on screen. read returns everything Stacki knows ' +
    'about it — file and lines, the component chain, props, classes, children, where its words come from and how ' +
    'many copies of it the page is rendering — so you do not have to search the repository for any of that. ' +
    'The edits go through Stacki’s own editor: they appear on the canvas at once, land on the undo stack, and ' +
    'save through the normal writer. Give the ref from get_context, comment(focus) or an earlier read; omit it ' +
    'to act on what the user has selected right now. A ref carries the document as your read found it, so an ' +
    'edit through one is refused if anybody changed that document meanwhile — you do not have to ask for that. ' +
    'Text that comes from a {binding} is NOT replaced with a literal: the answer says where the real value lives.',
  style:
    'Why an element looks the way it does, and how to change it. read lists every declaration reaching it, in ' +
    'cascade order, with the selector, the file it was authored in, whether it wins, what overrides it, and any ' +
    'CSS variables it reads — so "make the gap larger" needs no grep for a class name. Writes go through the ' +
    'Style panel’s own code, so they are one undo step. Also the project’s CSS custom properties.',
  source:
    'Project files as text. The fallback for code Stacki cannot model as a tree — a framework component, a ' +
    'config, plain JS — and the honest route when target reports a file unrepresentable. Prefer target for ' +
    '.astro markup: it keeps undo, the preview and the editor in step. Paths are project-relative. Replacing a ' +
    'file that already exists needs the ref your read gave you (or its digest); creating one does not.',
  page: 'Pages, page folders and components as project objects: list, read, create, move, delete, and where a component is used.',
  content: 'The CMS data files and the content collections: list, read, write, create, delete, validate, rename, and the entries themselves.',
  asset: 'Files already inside the project, under public/ and src/: list, measure, read and write text ones, make folders, move, rename, delete.',
  project: 'The open project itself: what is in it, which classes it uses, whether the preview is up, why it is not — and Stacki’s own undo and redo.',
  git: 'The repository, through Stacki’s own git operations. Reading is always available; committing, switching, restoring, merging and pushing need full control.',
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
  server.registerTool(
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

  const domain = (name, inputSchema, annotations) =>
    server.registerTool(
      name,
      {
        title: `Stacki ${name}`,
        description: DESCRIPTIONS[name],
        inputSchema,
        outputSchema: Envelope,
        annotations,
      },
      async (args) => {
        const { action, ...rest } = args || {};
        return answer(await api.run(name, action, rest));
      }
    );

  domain('target', TargetInput, annotationsFor('target'));
  domain('style', StyleInput, annotationsFor('style'));
  domain('source', SourceInput, WRITES);
  domain('page', PageInput, annotationsFor('page'));
  domain('content', ContentInput, annotationsFor('content'));
  domain('asset', AssetInput, annotationsFor('asset'));
  domain('project', ProjectInput, annotationsFor('project'));
  domain('git', GitInput, annotationsFor('git', { remote: true }));
}

/**
 * One shape out.
 *
 * A refusal is `ok: false` with a code and a sentence, in content and in
 * structuredContent both — never a protocol error. `isError` is set as well,
 * so a client that reads only that still knows, but the sentence is the part
 * an agent can act on.
 */
function answer(result) {
  const body = result && typeof result === 'object' ? result : { ok: false, code: 'failed', message: 'Stacki gave no answer.' };
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    ...(body.ok === false ? { isError: true } : {}),
  };
}

module.exports = {
  registerAgentTools,
  DESCRIPTIONS,
  Envelope,
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
