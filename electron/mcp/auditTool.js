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
});

const Capture = z.object({
  viewport: z.object({ key: z.string(), width: z.number().int(), height: z.number().int() }),
  mimeType: z.string(),
  bytes: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  data: z.string(),
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
  runId: z.string().optional(),
  route: z.string().optional(),
  url: z.string().optional(),
  engine: z
    .object({
      accessibility: z.string().nullable(),
      error: z.string().nullable(),
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
      returned: z.number().int(),
      omitted: z.number().int(),
      omittedBeforeScoring: z.object({ geometryCulprits: z.number().int(), axeNodes: z.number().int() }),
      omittedByResponseBudget: z.number().int(),
      responseCap: z.number().int(),
      incompleteReserved: z.number().int(),
    })
    .optional(),
  counts: z.object({
    mechanical: z.number().int(),
    standard: z.number().int(),
    advisory: z.number().int(),
    incomplete: z.number().int(),
  }).optional(),
  captures: z.array(Capture).optional(),
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

const DESCRIPTION = [
  'Render the real page in a real browser at real viewport widths and MEASURE it. Returns structured findings:',
  'page-level horizontal overflow from geometry, and accessibility violations from axe-core, each with the',
  'viewport it was found at, the element, its evidence, and a Stacki source path when the page carried one.',
  'Findings are separated by what they can honestly claim — `mechanical` is measured, `standard` is a named WCAG',
  'rule that has been broken, `advisory` is a heuristic, and `incomplete` is one the engine could not decide and',
  'a person has to look at. No violations does NOT mean accessible or WCAG compliant, and nothing here produces',
  'a design or quality score. The audit never writes to the project, never clicks or submits anything, and runs',
  'in a window of its own — it does not touch what the person is looking at, and it starts from a wiped browser',
  'session so one audit never inherits another\'s cookies or storage. `findingCount` is the TRUE number detected;',
  '`returnedFindingCount` is how many came back, and `truncation` says where the rest went. Needs `inspect`.',
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

  server.registerTool(
    'audit',
    {
      title: 'Measure the running page',
      description: DESCRIPTION,
      inputSchema: z.object({
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
              'WCAG 2.2 SC 1.4.10 names — overflow there is reported as a standards failure rather than a measurement.'
          ),
        rules: z
          .array(z.string())
          .max(40)
          .optional()
          .describe('Specific accessibility rule ids to run instead of the WCAG A/AA set. Use when re-checking one fix.'),
        capture: z
          .boolean()
          .optional()
          .describe('Return a screenshot per viewport, taken in the same state the findings were measured in. Off by default: findings are the useful part and images are large.'),
      }),
      outputSchema: AuditOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args = {}) => {
      // THE SAME DOOR. See the note at the top of this file.
      const denied = api.checkAccess(AUDIT_OPERATION, AUDIT_RISK);
      if (denied) {
        return {
          content: [{ type: 'text', text: JSON.stringify(denied) }],
          structuredContent: denied,
        };
      }
      const result = await audit(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }
  );
  return true;
}

module.exports = { registerAuditTool, AUDIT_OPERATION, AUDIT_RISK, AuditOutput, DESCRIPTION };
