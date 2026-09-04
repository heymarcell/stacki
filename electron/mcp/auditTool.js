// `audit`, as a tool.
//
// WHY A FOURTEENTH TOOL AND NOT A 112TH OPERATION.
//
// The obvious home is the Agent registry: get_capabilities would list it for
// free, docs/agent-api-coverage.md would stay generated, and the permission
// matrix would pick it up without being asked. That is a real argument and it
// was nearly taken.
//
// It loses on two counts. The registry's 111 operations, 110 FULL and 1 BOUNDARY,
// and the 444 permission answers derived from them, are Phase A's most heavily
// proven numbers; growing them to 112 and 448 churns that evidence to buy
// bookkeeping. And every registry operation answers in the same generic
// `Envelope`, whereas an audit's whole value is a typed result -- findings with
// kinds, viewports, evidence and honest limits -- that a client should be able to
// validate against a declared schema.
//
// So it is a tool, and the cost of that decision is paid here rather than
// avoided: being outside `api.run` means being outside where the permission gate
// lives, and a new surface that reads the project without asking the gate is
// exactly how a `visual` token ends up reading a repository. It therefore asks
// THE SAME gate object, through `api.checkAccess`. Not a second check that
// resembles the first -- the first one, called from one more place.
//
// WHY `inspect`. A finding carries DOM text, CSS selectors, computed values,
// element geometry and, where the page carried a marker, a real source path. That
// is project source information by any reasonable reading, and it is exactly what
// `inspect` exists to gate. `capture` remains at visual because a photograph of
// what is already on the person's screen tells you nothing you could not see by
// looking at it; a structured description of the document does.

const z = require('zod');

const { NAMES: VIEWPORT_NAMES, MAX_VIEWPORTS } = require('./viewports');
// ONE ENVELOPE FOR EVERY REFUSAL ON THE WIRE.
//
// This tool used to build its own two-line return, and the difference was
// `isError`. The permission refusal that reaches a client from `target.set_text`
// carries it; the byte-identical refusal from `audit` did not, and neither did
// `get_comments`. The spec says a tool that fails for an application reason
// SHOULD set it so the model can self-correct, and a host keying off it -- Claude
// Code does -- recorded a refused audit as a call that worked. At the default
// permission level `audit` is ALWAYS refused, so this was the common case rather
// than the edge one.
//
// AND ONE ARGUMENT CHECK, FOR THE SAME REASON.
//
// The SDK validates `tools/call` arguments against a tool's input schema BEFORE
// the handler runs, and a failure there is a protocol error: `isError`, one
// English sentence, no structuredContent, nothing to branch on. Every other
// tool in this surface was moved off that shape -- the eight domains through
// `domain()`, the five non-domain ones through the facade in tools.js -- and
// this one, registered from its own file straight onto the server, was missed.
// So `audit {viewports: "phone"}`, the single likeliest mistake given that the
// schema publishes viewport NAMES, came back as
//
//   "Input validation error: Invalid arguments for tool audit:
//    viewports: Invalid input: expected array, received string"
//
// while the byte-identical mistake on any other tool came back as
// `{ok:false, code:'bad_arguments', issues:[…]}`. `publishChecked` is the same
// door the other thirteen go through, not a second one that resembles it.
const { answer, publishChecked } = require('./agentTools');

// The permission subject. Named like a registry operation so that a reader
// grepping for what needs `inspect` finds it in the same shape as the rest.
const AUDIT_OPERATION = 'audit.run';
const AUDIT_RISK = 'read';

const Viewport = z.object({
  key: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  device: z.string().nullable(),
});

const Target = z.object({
  selector: z.string().nullable(),
  tag: z.string().nullable(),
  // Only when the selector matches more than one element, so a reader can tell
  // which of several identical boxes this is.
  selectorMatch: z.object({ index: z.number().int(), of: z.number().int() }).optional(),
  // THE OTHER ORDINAL, AND THE ONE A REAL PAGE PRODUCES MOST. A model path is a
  // SOURCE position, so a component drawn by a `.map()` stamps every row with the
  // identical one; this says which render this is. findings.js has emitted it for
  // every repeated node since ids stopped colliding, and it was missing here --
  // `additionalProperties: false` then made ONE alt-less <img> inside a loop
  // enough for a schema-validating client to discard the whole answer. A field
  // the engine emits and this object does not declare is not a documentation
  // gap; it is the audit returning nothing.
  modelPathMatch: z.object({ index: z.number().int(), of: z.number().int() }).optional(),
  // The Stacki model path, when the audited element actually carried a marker.
  // Null is a real answer and appears often: a runtime-generated node or a
  // third-party embed has no source Stacki can prove.
  modelPath: z.string().nullable(),
  // False when the nearest marker was on an ANCESTOR. "Somewhere inside this
  // component" and "this node" are different claims and are reported as such.
  exact: z.boolean(),
  note: z.string().nullable(),
});

const Finding = z.object({
  id: z.string(),
  ruleId: z.string(),
  category: z.string(),
  kind: z.enum(['mechanical', 'standard', 'advisory', 'incomplete']),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor', 'info']),
  // A named rule that HAS BEEN BROKEN. Null for measurements.
  standard: z.string().nullable(),
  // A criterion this measurement RELATES to without establishing a violation of
  // it -- horizontal overflow at 320px and WCAG 2.2 SC 1.4.10, whose
  // two-dimensional-layout exception a geometry probe cannot evaluate.
  relatedStandard: z.string().nullable().optional(),
  viewport: Viewport,
  message: z.string(),
  target: Target,
  evidence: z.record(z.string(), z.unknown()),
  help: z.string().nullable(),
  // Named when a field on THIS finding was shortened to keep the answer inside
  // the response budget. Present only when something was: a clipped selector
  // still looks like a selector, and a reader who is not told cannot know the
  // one they were handed will not match.
  truncatedFields: z.array(z.string()).optional(),
});

// A CAPTURE ROW DESCRIBES A PICTURE. IT IS NOT THE PICTURE.
//
// `data` used to be here, and a single base64 string was 98.8% of a real
// response: one viewport, one rule, zero findings, 127,029 characters, and the
// host replaced the whole result with a file pointer. The bytes now travel as
// MCP `image` content blocks, in the order the rows with `included: true`
// appear, which is where the protocol puts images and where Stacki's own
// `capture` tool has always put them.
//
// `included` is required and there is no `data` field to be half-present: a row
// can say "no image was sent for this viewport", and it cannot imply one that is
// not there. The sizes are nullable for exactly that row.
const Capture = z.object({
  viewport: z.object({ key: z.string(), width: z.number().int(), height: z.number().int() }),
  // True when an image block for this viewport is in the response.
  included: z.boolean(),
  mimeType: z.string().nullable(),
  bytes: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  // The identity of the picture, so a before and an after can be compared
  // without either being sent twice.
  sha256: z.string().nullable(),
  // Always true, and said rather than assumed: an audit capture is the project's
  // own page loaded again at the requested width in a window of the audit's own.
  // It is not the Stacki UI and not the person's current breakpoint.
  renderedOffscreen: z.boolean(),
  // Why there is no image, when there is none. 'budget' is the only one a
  // narrower re-run fixes, which is why `next` is worded from this and not from
  // `included` -- telling a caller to ask again for a viewport whose frame came
  // back empty is advice that cannot terminate.
  omittedBecause: z.enum(['budget', 'empty_frame', 'no_encoder']).optional(),
  note: z.string(),
});

const AuditOutput = z.object({
  ok: z.boolean(),
  code: z.string().optional(),
  message: z.string().optional(),
  // The refusal, exactly as the gate words it. These four are what
  // permissions.refusal() carries, and they are declared here rather than
  // stripped so that a client validating against the schema sees the same
  // sentence -- naming the operation, the level in force and the level needed --
  // that every other refused operation gives it.
  operation: z.string().optional(),
  risk: z.string().optional(),
  mode: z.string().optional(),
  requires: z.string().optional(),
  // The HTTP status, when the route answered with an error page. A 404 renders
  // and could be measured; reporting it under the requested route would describe
  // an error page as if it were the project.
  status: z.number().int().optional(),
  // Named when a route left the project by redirect or navigation. Only the
  // ORIGIN -- a page Stacki declined to load is never quoted.
  blockedOrigin: z.string().nullable().optional(),
  // `session_not_isolated` -- the audit refused to measure because it could not
  // start from a clean browser session. `session_not_cleaned` -- it measured, and
  // could not clear up afterwards, so the findings are real but the run is not
  // reported as isolated.
  runId: z.string().optional(),
  route: z.string().optional(),
  // Present only when a same-origin redirect landed somewhere other than the
  // route that was asked for. The findings describe these, not `route`.
  finalRoutes: z.array(z.string()).optional(),
  // Off-origin documents the audit refused to load INSIDE the page — an iframe
  // pointing somewhere else. The page was measured without them, which is worth
  // knowing before trusting its geometry.
  blockedSubframeOrigins: z.array(z.string()).optional(),
  url: z.string().optional(),
  engine: z
    .object({
      accessibility: z.string().nullable(),
      error: z.string().nullable(),
      // Rule ids the caller named that this engine does not have: `[]` when all
      // were known, `null` when none were named. A typo used to be accepted in
      // silence and look exactly like a rule that found nothing.
      unknownRules: z.array(z.string()).nullable().optional(),
      // Whether this run actually began from a wiped audit session.
      sessionIsolated: z.boolean().optional(),
    })
    .optional(),
  viewports: z.array(z.unknown()).optional(),
  findings: z.array(Finding).optional(),
  // findingCount is the TRUE number detected, before any cap. returnedFindingCount
  // is what `findings` holds. See electron/mcp/audit/index.js.
  findingCount: z.number().int().optional(),
  returnedFindingCount: z.number().int().optional(),
  omittedFindingCount: z.number().int().optional(),
  truncated: z.boolean().optional(),
  truncation: z
    .object({
      detected: z.number().int(),
      // What the page handed Stacki, after the two in-page caps and before
      // either response cap. `counts` below breaks THIS number down by kind.
      // Optional so a payload minted before it existed still validates.
      scored: z.number().int().optional(),
      returned: z.number().int(),
      omitted: z.number().int(),
      omittedBeforeScoring: z.object({ geometryCulprits: z.number().int(), axeNodes: z.number().int() }),
      omittedByResponseBudget: z.number().int(),
      // Findings the answer could not carry: see MAX_RESPONSE_BYTES. Its own
      // field, because "there were more" and "they would not have fitted" are
      // different facts and lead a caller to do different things.
      omittedByByteBudget: z.number().int(),
      // Findings returned whole but with one of their own fields shortened.
      // `truncated` is about the list; this is the other kind of loss.
      findingsWithShortenedFields: z.number().int(),
      // Captures whose image was not sent because the whole envelope would not
      // have fitted. The metadata row stays, saying included:false, so a caller
      // is never told a picture is present when it is not.
      omittedCaptureCount: z.number().int().optional(),
      responseCap: z.number().int(),
      responseByteCap: z.number().int(),
      // The budget over the WHOLE serialized answer, images included, as
      // distinct from responseByteCap which governs the findings alone.
      totalByteCap: z.number().int().optional(),
      fieldCaps: z.record(z.string(), z.number().int()),
      incompleteReserved: z.number().int(),
    })
    .optional(),
  // BY KIND, OVER THE SCORED SET -- `truncation.scored`, which is what the page
  // handed Stacki. These sum to that and to neither `findingCount` (which counts
  // what the page capped too) nor `returnedFindingCount` (what fitted).
  counts: z.object({
    mechanical: z.number().int(),
    standard: z.number().int(),
    advisory: z.number().int(),
    incomplete: z.number().int(),
  }).optional(),
  captures: z.array(Capture).optional(),
  // What to do about a picture, or a route, the answer could not carry whole.
  // Present only when there is something to do.
  next: z.string().optional(),
  dropped: z
    .object({
      culpritsTruncatedAtViewports: z.array(z.string()),
      axeNodesPerRuleCap: z.number().int(),
      captureCap: z.number().int(),
      capturesRequestedButNotTaken: z.number().int(),
    })
    .optional(),
  limits: z.string().optional(),
});

// THE SHAPE OF A CALL, as its own const so the same zod object is both what
// the tool publishes and what the handler checks -- a second copy of it is how
// a published schema and an enforced one drift apart.
const AuditInput = z.object({
  route: z
    .string()
    .optional()
    .describe(
      'Route to audit, e.g. "/" or "/about". Defaults to the site root — NOT to the page Stacki has open; ' +
        'call get_context first if you mean the page the person is looking at. Must resolve inside this project.'
    ),
  viewports: z
    // z.string(), not z.enum(VIEWPORT_NAMES): an enum is refused by the SDK
    // with "viewports.0: Invalid input", which does not say what the valid
    // ones are. A plain string reaches resolveViewports(), which answers
    // with the list. The COUNT stays in the schema, where a refusal needs
    // no context to be useful.
    .array(z.union([z.string(), z.object({ width: z.number().int(), height: z.number().int() })]))
    .max(MAX_VIEWPORTS)
    .optional()
    .describe(
      `Up to ${MAX_VIEWPORTS} viewports, by name (${VIEWPORT_NAMES.join(', ')}) or as {width,height}. ` +
        'Defaults to phone, tablet and desktop. Each one is a real page load. `reflow` is 320px, the width ' +
        'WCAG 2.2 SC 1.4.10 names — overflow found there names that criterion in `relatedStandard`, but stays a ' +
        'MEASUREMENT: the criterion exempts content needing a two-dimensional layout, and geometry cannot tell an ' +
        'exempt data table from a layout that failed to reflow.'
    ),
  rules: z
    .array(z.string())
    .max(40)
    .optional()
    .describe(
      'Specific accessibility rule ids to run instead of the WCAG A/AA set. Use when re-checking one fix. ' +
        'This scopes the ACCESSIBILITY engine and only that: the geometry probe is not a rule in this list ' +
        'and always runs. A rule id the engine does not have comes back in `engine.unknownRules` rather ' +
        'than being accepted in silence. An EMPTY list means no accessibility pass at all — no engine, no ' +
        'run, `engine.accessibility: null` — which is how you get geometry and a picture without paying ' +
        'for a full WCAG run.'
    ),
  capture: z
    .boolean()
    .optional()
    .describe(
      'Return a screenshot per viewport, taken in the same state the findings were measured in. Off by ' +
        'default: findings are the useful part. The picture arrives as an IMAGE BLOCK in the response, not ' +
        'as base64 in the payload; `captures[]` is metadata, one row per viewport asked about — including ' +
        'the ones no picture came back for — where `included` says whether an image was actually sent and ' +
        '`omittedBecause` says why not when it was not. Each picture is the page rendered ' +
        'OFFSCREEN at the width you asked for, as a visitor sees it — not the Stacki UI and not the ' +
        'breakpoint the person has open. This, with viewports:[{width,height}] and rules:[], is how to see ' +
        'a route at a width of your own choosing; the `capture` tool cannot change the person\'s breakpoint ' +
        'and will not resize their window.'
    ),
});

const DESCRIPTION = [
  'Render the real page in a real browser at real viewport widths and MEASURE it. Returns structured findings:',
  'page-level horizontal overflow from geometry, and accessibility violations from axe-core, each with the',
  'viewport it was found at, the element, its evidence, and a Stacki source path when the page carried one.',
  'Findings are separated by what they can honestly claim — `mechanical` is measured, `standard` is a named WCAG',
  'rule that has been broken, `advisory` is a heuristic, and `incomplete` is one the engine could not decide and',
  'a person has to look at. No violations does NOT mean accessible or WCAG compliant, and nothing here produces',
  'a design or quality score. The audit never writes to the project, never clicks or submits anything, and runs',
  'in a window of its own — it does not touch what the person is looking at, and it starts from a wiped browser',
  'session so one audit never inherits another\'s cookies or storage. It will not NAVIGATE off the project\'s',
  'origin: an absolute route, a redirect, a frame navigation are refused before the request leaves the process.',
  'It is not a network fence — the page renders as a visitor renders it, so its own subresources are fetched and',
  'its scripts run, because a page stripped of its stylesheet is not the page whose layout you asked about.',
  '`findingCount` is the TRUE number detected;',
  '`returnedFindingCount` is how many came back, and `truncation` says where the rest went — including',
  '`omittedByByteBudget`, findings dropped because the answer would not have fitted through the host. A finding',
  'whose own fields were shortened to fit names them in `truncatedFields`. `truncation.scored` is what the page ' +
  'handed Stacki after its own caps, and `counts` breaks THAT number down by kind — not `findingCount` and not ' +
  '`returnedFindingCount`. Needs `inspect`.',
].join(' ');

/**
 * Put `audit` on the server.
 *
 * `audit` is the engine (electron/mcp/audit), `api` is the Agent API — required,
 * because without it there is no gate to ask and an ungated audit is not
 * something worth shipping.
 */
function registerAuditTool(server, { audit, api }) {
  if (!audit || !api) return false;

  publishChecked(
    server,
    'audit',
    {
      title: 'Measure the running page',
      description: DESCRIPTION,
      inputSchema: AuditInput,
      outputSchema: AuditOutput,
      // ANNOTATIONS, MEASURED AGAINST WHAT THE SPEC ACTUALLY SAYS.
      //
      // `openWorldHint` is defined as: "If true, this tool may interact with an
      // 'open world' of external entities. If false, the tool's domain of
      // interaction is closed. For example, the world of a web search tool is
      // open, whereas that of a memory tool is not." Default: true. Annotations
      // are HINTS, and the spec tells clients to treat them as untrusted; this
      // one describes the shape of the interaction, it does not enforce anything.
      //
      // TRUE, and this used to say false.
      //
      // The false was defended by the document fence: no argument can name a host
      // (`route` is a path joined onto the project's own preview origin and
      // `viewports` is an enum), and no document from another origin loads in any
      // frame of the audit window -- an off-origin redirect or navigation of the
      // main frame fails the run as `route_outside_project`, and one of a
      // subframe drops that frame and is named in `blockedSubframeOrigins`. All
      // of that is true and all of it is still enforced.
      //
      // It is just not the same claim as a closed world. This tool RENDERS A REAL
      // PROJECT PAGE in a real browser, and that page decides for itself what it
      // fetches: scripts, images, fonts, stylesheets, and whatever its own
      // JavaScript asks the network for. Those go wherever the project points
      // them, which can be anywhere. Saying `false` described the fence and
      // invited a reader to conclude something broader about the tool.
      //
      // The alternative -- blocking every external subresource to keep the word
      // "closed" -- would change what the page IS, and an audit of a page that
      // could not load its own fonts would measure a layout nobody has. The fence
      // is on documents, deliberately, and the hint now says the true thing about
      // the rest.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    // `args` is `AuditInput`'s own parse RESULT, not what arrived: the check
    // that used to be the host's is made by `publishChecked` a moment earlier,
    // with this same schema, so a mistyped argument is refused as
    // `bad_arguments` before the gate is asked and the engine never sees a
    // shape it did not declare.
    async (args = {}) => {
      // THE SAME DOOR. See the note at the top of this file.
      const denied = api.checkAccess(AUDIT_OPERATION, AUDIT_RISK);
      // Compact, exactly as this tool has always answered: the text block is a
      // second copy of the findings and indenting it is bytes for nothing.
      if (denied) return answer(denied, { spaces: 0 });
      // THE PICTURES RIDE BESIDE THE PAYLOAD, NOT INSIDE IT.
      //
      // `images` is the engine's second channel and is destructured off here so
      // it cannot reach `structuredContent`: base64 in the JSON is what made a
      // captured audit undeliverable. `answer` puts the blocks first, exactly as
      // electron/mcp/tools.js orders the capture tool's, so a host that shows
      // only the first block shows the picture.
      const { images = [], ...body } = await audit(args);
      return answer(body, { spaces: 0, images });
    }
  );
  return true;
}

module.exports = { registerAuditTool, AUDIT_OPERATION, AUDIT_RISK, AuditInput, AuditOutput, DESCRIPTION };
