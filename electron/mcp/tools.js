// The two things an agent can ask Stacki.
//
// The temptation with an editor that has an API is to expose the editor. That
// would be the wrong shape: an agent already has a filesystem, a text editor
// and a repository, and it is very good with all three. What it does not have
// is eyes. So Stacki answers exactly two questions — what is selected and
// where is it in source, and what does that actually look like — and nothing
// here writes anything.
//
// Both tools are read-only, idempotent and closed-world, and say so in their
// annotations, so a client can call them without asking anybody's permission.

const z = require('zod');

const INSTRUCTIONS = [
  'Stacki exposes the live visual state of the Astro project currently open in the Stacki desktop application.',
  'Use get_context whenever the user refers to "this", the selected element, this section, the current page,',
  'the current breakpoint, or asks for a visual/UI change. Use capture when appearance matters or when visually',
  'verifying a change. These tools are read-only. Modify project source using normal repository editing tools.',
  'After visually relevant code changes, query Stacki again to verify the rendered result.',
  'Stacki already owns the preview server; do not start another dev server.',
].join(' ');

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// --- shared shapes ----------------------------------------------------------

const nullableString = z.string().nullable();
const nullableInt = z.number().int().nullable();

const Rect = z
  .object({
    x: z.number().nullable(),
    y: z.number().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable(),
  })
  .nullable();

const Sides = z
  .object({
    top: z.number().optional(),
    right: z.number().optional(),
    bottom: z.number().optional(),
    left: z.number().optional(),
  })
  .optional();

const Spacing = z
  .object({
    padding: Sides,
    margin: Sides,
    gaps: z.array(z.object({ axis: z.enum(['row', 'column']), size: z.number() })).optional(),
  })
  .nullable();

const SourceRef = z
  .object({ file: nullableString, startLine: nullableInt, endLine: nullableInt })
  .nullable();

const View = z.object({
  device: nullableString,
  viewportWidth: nullableInt,
  viewportHeight: nullableInt,
});

const SelectionStatus = z.enum([
  'ready',
  'no_project',
  'no_page',
  'no_selection',
  'preview_not_ready',
]);

const Selection = z.object({
  status: SelectionStatus,
  nodeKind: nullableString,
  tag: nullableString,
  occurrence: nullableInt,
  occurrenceCount: nullableInt,
  source: SourceRef,
  sourceTrail: z.array(z.object({ file: nullableString, startLine: nullableInt, endLine: nullableInt })).nullable(),
  componentChain: z.array(z.string()).nullable(),
  breadcrumbs: z.array(z.string()).nullable(),
  text: nullableString,
  props: z.record(z.string(), z.string()).nullable(),
  classes: z.array(z.string()).nullable(),
  hidden: z.boolean(),
  inert: z.boolean(),
  rect: Rect,
  spacing: Spacing,
  essentialComputedStyles: z.record(z.string(), z.string()).nullable().optional(),
  computedStyles: z.record(z.string(), z.string()).nullable().optional(),
});

const ContextOutput = z.object({
  revision: z.number().int(),
  timestamp: z.number().int(),
  project: z.object({ root: nullableString }),
  page: z.object({ route: nullableString, file: nullableString }),
  view: View,
  selection: Selection,
});

const CaptureOutput = z.object({
  revision: z.number().int(),
  status: SelectionStatus,
  target: z.enum(['selection', 'viewport']),
  requestedTarget: z.enum(['selection', 'viewport']),
  format: z.enum(['png', 'jpeg']),
  source: SourceRef,
  view: View,
  occurrence: nullableInt,
  occurrenceCount: nullableInt,
  rect: Rect,
  pixelSize: z.object({ width: z.number().int(), height: z.number().int() }).nullable(),
  bytes: z.number().int(),
  note: nullableString,
});

// --- registration -----------------------------------------------------------

const MAX_PADDING = 256;

/**
 * Put both tools on `server`.
 *
 * `getContext({ styleDetail })` and `capture({ target, paddingPx, format })`
 * are the app's own implementations — passed in so this file describes the
 * surface and nothing else.
 */
function registerTools(server, { getContext, capture }) {
  server.registerTool(
    'get_context',
    {
      title: 'Stacki visual context',
      description:
        'What the user currently has selected in the Stacki desktop app: the page and breakpoint on screen, ' +
        'the selected element, its rendered classes, box and spacing, and the file:line trail that leads to it ' +
        'through every component drilled into on the way down. ' +
        'selection.status is one of ready, no_project, no_page, no_selection, preview_not_ready — ' +
        'an empty app is a status, not an error.',
      inputSchema: z.object({
        styleDetail: z
          .enum(['none', 'essential', 'full'])
          .default('essential')
          .describe(
            'How much computed CSS to include. "essential" (default) is the properties a visual change ' +
              'is ever about; "full" is every computed property the engine has; "none" skips the round trip.'
          ),
      }),
      outputSchema: ContextOutput,
      annotations: READ_ONLY,
    },
    async ({ styleDetail }) => {
      const snapshot = await getContext({ styleDetail: styleDetail || 'essential' });
      return {
        content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }],
        structuredContent: snapshot,
      };
    }
  );

  server.registerTool(
    'capture',
    {
      title: 'Stacki screenshot',
      description:
        'A picture of what Stacki is rendering right now, at the current breakpoint: the selected element ' +
        '(the selected occurrence of a repeated node, scrolled into view, with the editor overlays hidden) ' +
        'or the whole preview viewport. Returns the image plus the same source reference get_context gives.',
      inputSchema: z.object({
        target: z
          .enum(['selection', 'viewport'])
          .default('selection')
          .describe('"selection" crops to the selected element; "viewport" is the whole preview frame.'),
        paddingPx: z
          .number()
          .int()
          .min(0)
          .max(MAX_PADDING)
          .default(48)
          .describe('Context to leave around a selection capture, in CSS pixels. Ignored for "viewport".'),
        format: z.enum(['png', 'jpeg']).default('png').describe('Image encoding.'),
      }),
      outputSchema: CaptureOutput,
      annotations: READ_ONLY,
    },
    async ({ target, paddingPx, format }) => {
      const shot = await capture({
        target: target || 'selection',
        paddingPx: paddingPx == null ? 48 : paddingPx,
        format: format || 'png',
      });
      const content = [];
      if (shot.image) {
        content.push({ type: 'image', data: shot.image, mimeType: shot.mimeType });
      }
      content.push({ type: 'text', text: JSON.stringify(shot.meta, null, 2) });
      return {
        content,
        structuredContent: shot.meta,
        ...(shot.image ? {} : { isError: true }),
      };
    }
  );
}

module.exports = { registerTools, INSTRUCTIONS, READ_ONLY, ContextOutput, CaptureOutput, MAX_PADDING };
