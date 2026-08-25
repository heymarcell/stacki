// The two things an agent can do with somebody's review.
//
// The existing surface is deliberately two read-only tools, and the reason is
// in tools.js: an agent already has a filesystem and an editor, and what it
// lacks is eyes. Visual Review changes that arithmetic in exactly one place —
// there is now persistent local state that an agent legitimately needs to
// change, because "I did this, and here is the picture proving it" is the
// point of the whole loop. So it gets a mutation surface, and the surface is
// kept as small as the thing it has to express.
//
// Two tools, not fifteen. `create_comment`, `reply_comment`, `resolve_comment`,
// `defer_comment`, `reopen_comment`, `focus_comment` would be six tools that
// differ by one verb and share every argument; a client would carry six
// descriptions of the same object in its context to use one of them. One
// action enum says the same thing in a tenth of the tokens, and the schema
// still enforces what each action needs.
//
// What is NOT here is as deliberate:
//
//   delete. An agent that disagrees with a comment resolves it and says why,
//   which leaves a person able to disagree back. Erasing their feedback is not
//   a thing it gets to do — and it cannot, because the enum has no word for it
//   and the store's delete is not reachable through `apply` at all.
//
//   anything that touches the project. These tools move Stacki's view and
//   write Stacki's own review file. They do not edit source, run commands,
//   reach the network or know what GitHub is. An agent that wants an issue
//   filed uses its own GitHub tooling and hands the URL back as text.

const z = require('zod');

const nullableString = z.string().nullable();
const nullableInt = z.number().int().nullable();

// Long enough for a real piece of feedback, short enough that one review
// cannot fill a response. Mirrors the store's own caps, which are what
// actually enforce them.
const MAX_MESSAGE = 4000;
const MAX_REASON = 1000;
const MAX_REF = 500;
const MAX_LIMIT = 200;

const Status = z.enum(['open', 'resolved', 'deferred']);
const AnchorState = z.enum(['attached', 'orphaned']);

const Summary = z.object({
  id: z.string(),
  // The short handle the user sees on the pin and in the panel. Either this or
  // the id names a review in `comment` — and this is the one they will say.
  number: z.number().int().nullable(),
  // The user's own colour for this note. Their filing, not a state and not
  // something to act on — there is no action here that sets it.
  color: z.string(),
  status: Status,
  anchorState: AnchorState,
  message: z.string(),
  replies: z.number().int(),
  lastAuthor: z.enum(['human', 'agent']),
  page: nullableString,
  breakpoint: nullableString,
  source: nullableString,
  occurrence: nullableInt,
  occurrenceCount: nullableInt,
  updatedAt: z.number().int(),
});

const SourceRef = z.object({ file: nullableString, startLine: nullableInt, endLine: nullableInt });

const Full = Summary.extend({
  createdAt: z.number().int(),
  messages: z.array(
    z.object({
      id: z.string(),
      authorType: z.enum(['human', 'agent']),
      body: z.string(),
      createdAt: z.number().int(),
      // When a person rewrote their own words, if they did. Null otherwise.
      // Only a human's message can be reworded, and only from the panel — an
      // agent cannot edit what was said, here or anywhere.
      editedAt: z.number().int().nullable(),
    })
  ),
  // How many older messages were left out of `messages` above, so a long
  // thread cannot be mistaken for a short one.
  messagesOmitted: z.number().int(),
  deferredReason: nullableString,
  externalRefs: z.array(z.string()),
  anchor: z.object({
    page: z.object({ route: nullableString, file: nullableString }),
    keys: z.array(z.string()),
    breakpoint: z.object({ device: nullableString, viewportWidth: nullableInt, viewportHeight: nullableInt }),
    pin: z.object({ xRatio: z.number(), yRatio: z.number() }).nullable(),
    fingerprint: z
      .object({
        nodeKind: nullableString,
        tag: nullableString,
        text: nullableString,
        componentChain: z.array(z.string()).nullable(),
        breadcrumbs: z.array(z.string()).nullable(),
        // The sibling run at each level down to the node, recorded when the
        // review was written. It is what separates "this slot never moved"
        // from "a neighbour was inserted above it", so it is part of the
        // anchor an agent is allowed to see.
        peers: z.array(z.object({ index: z.number().int(), count: z.number().int() })).nullable(),
      })
      .nullable(),
    sourceTrail: z.array(SourceRef).nullable(),
  }),
  creationContext: z.looseObject({}),
});

const Review = z.union([Full, Summary]);

const CommentsOutput = z.object({
  ok: z.boolean(),
  revision: z.number().int(),
  status: z.string(),
  scope: z.string(),
  total: z.number().int(),
  // How many came back, which is not always `limit`: a very large answer is
  // cut to a byte budget as well as to the count asked for.
  returned: z.number().int().optional(),
  truncated: z.boolean(),
  reviews: z.array(Review),
  // What went wrong reading the ledger, if anything. Declared because the
  // implementation always sends it — an undeclared field makes a strict client
  // reject the entire response, which is how `get_comments` came to be
  // unusable from a real MCP client while every local test passed.
  problem: z
    .object({ kind: z.string(), detail: z.string().nullable().optional(), movedTo: z.string().nullable().optional() })
    .nullable()
    .optional(),
  code: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
});

const ActionOutput = z.object({
  ok: z.boolean(),
  action: z.string(),
  code: nullableString,
  message: nullableString,
  revision: z.number().int(),
  // What a focus managed to put back. Absent for everything else.
  restored: z
    .object({
      page: z.boolean(),
      breakpoint: z.boolean(),
      component: z.boolean(),
      node: z.boolean(),
      occurrence: z.boolean(),
    })
    .nullable()
    .optional(),
  note: nullableString.optional(),
  review: Full.nullable(),
});

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// The honest set for a tool that can create things.
//
//   readOnlyHint    false — create and reply add state.
//   destructiveHint false — nothing here removes anything. resolve and defer
//                   change a status and keep every word that was ever written;
//                   delete is not in the enum.
//   idempotentHint  is deliberately NOT claimed. Calling `create` twice makes
//                   two reviews, and a client that batched a retry on the
//                   strength of an idempotent hint would leave duplicates on
//                   somebody's page. Some actions are idempotent and some are
//                   not, so the tool as a whole is not, and saying otherwise
//                   to make the annotation look tidier would be a lie the
//                   client acts on.
//   openWorldHint   false — a local file and a local window, nothing else.
const MUTATES = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

const ACTIONS = ['create', 'reply', 'focus', 'resolve', 'defer', 'reopen'];

// What each action requires, checked before anything is applied so a bad call
// is a sentence rather than a half-done mutation. The schema cannot express
// "threadId unless action is create" on its own, so it is said here and
// reported the way every other empty state in this server is: as a status.
const NEEDS = {
  create: { message: true, threadId: false },
  reply: { message: true, threadId: true },
  focus: { message: false, threadId: true },
  resolve: { message: false, threadId: true },
  defer: { message: false, threadId: true },
  reopen: { message: false, threadId: true },
};

function requirementProblem({ action, threadId, message }) {
  const needs = NEEDS[action];
  if (!needs) return { code: 'bad_action', message: `action must be one of ${ACTIONS.join(', ')}.` };
  if (needs.threadId && !threadId) {
    return { code: 'no_thread_id', message: `"${action}" needs the threadId of the review to act on.` };
  }
  if (!needs.threadId && threadId) {
    return { code: 'unexpected_thread_id', message: '"create" comments on the current Stacki selection and takes no threadId.' };
  }
  if (needs.message && !String(message || '').trim()) {
    return { code: 'no_message', message: `"${action}" needs something written in message.` };
  }
  return null;
}

/**
 * Put the review tools on `server`.
 *
 * `getComments(args)` and `comment(args)` are the app's own implementations,
 * passed in for the same reason the other two are: this file describes the
 * surface and nothing else.
 */
function registerReviewTools(server, { getComments, comment }) {
  server.registerTool(
    'get_comments',
    {
      title: 'Stacki review comments',
      description:
        "The user's visual review threads for the project open in Stacki — feedback they left by clicking on the " +
        'rendered page. Each one is anchored to a source-backed element, at the breakpoint it was written at. ' +
        'Read this when asked to work through comments/feedback/review notes. ' +
        'Each has a short number, which is what the user sees on the pin and what they will call it — "fix #3". ' +
        'anchorState "orphaned" means Stacki can no longer find that element in the current source; the review is ' +
        'still readable and its creationContext says what it was about. ' +
        'Use detail "summary" (the default) to survey, "full" for the messages and anchor of ones you will act on.',
      inputSchema: z.object({
        status: Status.or(z.literal('all'))
          .default('open')
          .describe('Which workflow state to list. "open" (default) is what still wants doing.'),
        scope: z
          .enum(['project', 'page', 'selection'])
          .default('project')
          .describe(
            '"project" (default) is every review in the open project; "page" only those on the page Stacki is ' +
              'showing; "selection" only those on the element currently selected.'
          ),
        detail: z
          .enum(['summary', 'full'])
          .default('summary')
          .describe(
            '"summary" (default) is one compact row each — enough to choose from. "full" adds the recent messages ' +
              '(with messagesOmitted saying how many older ones were left out), the anchor resolved to current ' +
              'file:line, the deferral reason, external references and the creation snapshot.'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .default(50)
          .describe(
            'How many to return, newest change first. A large answer is also capped by total size, so `returned` ' +
              'may be fewer than asked for and `truncated` says the list was cut.'
          ),
      }),
      outputSchema: CommentsOutput,
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await getComments({
        status: args.status || 'open',
        scope: args.scope || 'project',
        detail: args.detail || 'summary',
        limit: args.limit == null ? 50 : args.limit,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );

  server.registerTool(
    'comment',
    {
      title: 'Stacki review action',
      description:
        "Act on the user's visual review threads. " +
        'focus — send Stacki to a review\'s target: its page, its breakpoint, the components it is inside, the ' +
        'element itself and the rendered copy of it. Do this BEFORE acting on a review, so get_context and capture ' +
        'then describe and photograph the right thing. ' +
        'create — leave a new review on whatever is selected in Stacki right now. ' +
        'reply — add a note to a thread. ' +
        'resolve — a decision was reached (implemented and visually verified, or keeping it as it is). ' +
        'defer — valid, but not being done now: give a reason, and an externalRef if you tracked it elsewhere. ' +
        'reopen — put a resolved or deferred review back to open. ' +
        'This writes only to Stacki\'s own local review file and moves Stacki\'s view. It does not edit project ' +
        'source, run commands or reach the network — make code changes with your normal repository tools. ' +
        'Reviews cannot be deleted here: resolve one with your reasoning instead.',
      inputSchema: z.object({
        action: z.enum(ACTIONS).describe('What to do. "focus" only moves Stacki; the rest change the review.'),
        threadId: z
          .string()
          .max(100)
          .optional()
          .describe(
            'The review to act on — its id, or the short number the user sees on the pin, with or without the ' +
              'hash ("7" and "#7" both work). Required for everything except "create".'
          ),
        message: z
          .string()
          .max(MAX_MESSAGE)
          .optional()
          .describe(
            'Required for "create" and "reply". Optional on "resolve", "defer" and "reopen", where it is recorded ' +
              'as the closing note — say what you did and that you verified it visually.'
          ),
        reason: z
          .string()
          .max(MAX_REASON)
          .optional()
          .describe('Why a review is being deferred rather than done. Only meaningful with "defer".'),
        externalRef: z
          .string()
          .max(MAX_REF)
          .optional()
          .describe(
            'Where the deferred work is tracked — an issue URL you created with your own tooling. Stacki stores ' +
              'the text and never fetches it.'
          ),
      }),
      outputSchema: ActionOutput,
      annotations: MUTATES,
    },
    async (args) => {
      const problem = requirementProblem(args);
      const result = problem
        ? { ok: false, action: args.action, revision: 0, review: null, ...problem }
        : await comment(args);
      const body = {
        ok: !!result.ok,
        action: args.action,
        code: result.code || null,
        message: result.message || null,
        revision: result.revision || 0,
        review: result.review || null,
        ...(result.restored ? { restored: result.restored, note: result.note || null } : {}),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
        structuredContent: body,
        // A refusal is an error the client should see as one — an agent that
        // reads `ok: false` out of a successful tool call and carries on is a
        // real failure mode, and this is the wire's own word for "that did not
        // happen".
        ...(body.ok ? {} : { isError: true }),
      };
    }
  );
}

module.exports = {
  registerReviewTools,
  CommentsOutput,
  ActionOutput,
  Summary,
  Full,
  READ_ONLY,
  MUTATES,
  ACTIONS,
  NEEDS,
  requirementProblem,
  MAX_MESSAGE,
  MAX_REASON,
  MAX_REF,
  MAX_LIMIT,
};
