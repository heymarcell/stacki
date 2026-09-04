// What each operation actually calls, and with what.
//
// Every entry here turns the API's arguments into the arguments of a handler
// Stacki already has, and turns the answer back into something bounded. That
// is the whole of it: there is no second implementation of creating a page,
// writing an entry or making a commit anywhere in this feature. The Pages
// panel and `page.create` end up in the same function, with the same
// validation, the same errors and the same file on disk.
//
// Two rules run through all of it:
//
//   Paths are relative and are checked here. A handler that takes an absolute
//   path gets one built from the open project root, never one a client sent.
//   Several of the handlers guard themselves as well; that is not a reason to
//   skip it, it is a reason the guard has been right so far.
//
//   Answers are bounded. A project scan, an asset listing and a git log can
//   all be enormous, and an agent that asked for "the pages" should not get
//   forty thousand tokens of prop schemas it did not ask for.

const path = require('node:path');
const fs = require('node:fs');

const { resolveInProject, relativeTo, toPosix } = require('./paths');
const { digestOf, digestOfFile, checkDigest } = require('./digest');
const { originOf, projectOriginTest } = require('../../projectOrigin.js');

const problem = (code, message, extra = {}) => ({ error: { ok: false, code, message, ...extra } });

/**
 * The guard on a write that replaces something.
 *
 * Three ways a caller can name the version it is replacing, in the order they
 * are worth having:
 *
 *   a ref      handed over by the read that produced it, with the digest
 *              baked into the signature. Nothing to remember and nothing to
 *              copy wrongly.
 *   a digest   named explicitly, for a caller that would rather.
 *   nothing    refused, if the thing already exists. This used to be allowed
 *              and it was the hole: concurrency protection that only worked
 *              for clients that opted in.
 *
 * `ctx.refObservation(input.ref, expectedPath)` is the API's own reader — it
 * verifies the signature and that the ref is about this path.
 */
function guardWrite(ctx, at, input, what) {
  const actual = digestOfFile(at.abs);
  let expected = input.expectedDigest;
  if (input.ref) {
    // Without a ref reader there is nothing behind the ref, and a write that
    // quietly ignored one would be a write that lost its guard.
    if (typeof ctx.refObservation !== 'function') {
      return { error: { ok: false, code: 'bad_ref', message: 'Stacki cannot read refs right now.' } };
    }
    const fromRef = ctx.refObservation(input.ref, at.rel);
    if (fromRef.error) return fromRef;
    expected = fromRef.digest ?? expected;
  }
  const stale = checkDigest({ expected, actual, what: what || at.rel, requireForExisting: true });
  return stale ? { error: stale } : { ok: true, actual };
}

// --- shared helpers ----------------------------------------------------------

/** A project-relative path argument, validated. */
function rel(ctx, value, what = 'path') {
  const found = resolveInProject(ctx.root, value, { what });
  if (!found.ok) return { error: found };
  return found;
}

const clip = (text, max) => {
  const s = String(text ?? '');
  return s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };
};

const take = (list, limit) => (Array.isArray(list) ? list.slice(0, limit) : []);

/**
 * Where each line of a file begins, 1-based line N at `starts[N - 1]`.
 *
 * A `split` sees an empty segment after the file's final newline and calling
 * that a line is how a read of a ten-line file came back saying eleven. The
 * terminator ENDS the last line; it does not begin another one. So the count
 * this yields is the count a person gets from their editor's gutter, and
 * slicing by it gives back whole lines with their own line endings attached —
 * which is what makes a range read and a range replacement the same bytes.
 */
function lineStarts(text) {
  if (text === '') return [];
  const starts = [0];
  const re = /\r\n|\n/g;
  let m;
  while ((m = re.exec(text))) starts.push(m.index + m[0].length);
  if (starts[starts.length - 1] === text.length) starts.pop();
  return starts;
}

/** Lines `from`..`to` inclusive, terminators included, as they sit in the file. */
const sliceLines = (text, starts, from, to) => text.slice(starts[from - 1], to < starts.length ? starts[to] : text.length);

// The two things the API layer supplies, with the behaviour to fall back on
// when it has not — so `runMain` stays a function of its context and can be
// driven straight in a test.
const refFor = (ctx, rel) => (typeof ctx.sourceRef === 'function' ? ctx.sourceRef(rel) : null);
const putText = (ctx, rel, text) =>
  typeof ctx.writeText === 'function'
    ? ctx.writeText(rel, text)
    : Promise.resolve(ctx.callMain('src:writeText', { projectPath: ctx.root, rel, text })).then(() => ({
        through: { through: 'disk', undoable: false },
      }));

// How much of an answer travels. Generous enough to be useful in one call,
// small enough that no single call can fill a context window.
const MAX_LIST = 400;
const MAX_TEXT_BYTES = 120_000;
const MAX_SNIPPET_LINES = 400;

// --- source ------------------------------------------------------------------
//
// The escape hatch, and deliberately the least convenient door in the API: a
// file Stacki can model is better edited through `target`, where the change
// lands on the undo stack and the preview follows. This is for the rest — a
// utility module, a config, a component in a framework Stacki does not parse.

const source = {
  async read(input, ctx) {
    const at = rel(ctx, input.path, 'file path');
    if (at.error) return at;
    let text;
    try {
      text = fs.readFileSync(at.abs, 'utf8');
    } catch (err) {
      return problem('no_file', `Stacki could not read ${at.rel}: ${err.code === 'ENOENT' ? 'there is no such file' : err.message}.`);
    }
    const starts = lineStarts(text);
    const total = starts.length;
    const asked = input.startLine != null || input.endLine != null;
    const from = asked ? Number(input.startLine ?? 1) : 1;
    const wantedEnd = input.endLine != null ? Number(input.endLine) : null;
    // A RANGE THAT CANNOT EXIST IS NOT A SUCCESSFUL EMPTY READ. Clamping the
    // high end while leaving the low one alone manufactured pairs like
    // 9000–250, echoed back as though they described what came out; and
    // `slice(8999, 250)` is legitimately [], so an impossible request answered
    // ok with nothing in it. `source.replace_range` has always refused the same
    // input precisely, and this is the same refusal in the same words.
    if (asked) {
      if (!Number.isInteger(from) || from < 1) {
        return problem('bad_range', `startLine must be a whole line number of at least 1; ${JSON.stringify(input.startLine)} is not.`);
      }
      if (from > total) {
        return problem('bad_range', `${at.rel} has ${total} lines; line ${from} is not in it.`);
      }
      if (wantedEnd != null && (!Number.isInteger(wantedEnd) || wantedEnd < 1)) {
        return problem('bad_range', `endLine must be a whole line number of at least 1; ${JSON.stringify(input.endLine)} is not.`);
      }
      if (wantedEnd != null && wantedEnd < from) {
        return problem('bad_range', `${at.rel}: ${from}–${wantedEnd} is not a range — endLine must be at least startLine.`);
      }
    }
    // An endLine PAST the end stays a read: "lines 200 to 400" of a 250-line
    // file is a reasonable thing to ask. It says so, so a short answer can be
    // told from a coincidence.
    const to = Math.min(total, wantedEnd ?? from + MAX_SNIPPET_LINES - 1);
    const body = clip(asked ? sliceLines(text, starts, from, to) : text, MAX_TEXT_BYTES);
    return {
      value: {
        path: at.rel,
        // Hand back a ref as well as the digest. The ref carries the digest in
        // its signature, so the write that follows this read is guarded by
        // passing it back — with nothing for a caller to copy or forget.
        ref: refFor(ctx, at.rel),
        // The digest is of the WHOLE file however much of it was read, because
        // that is what a write will be checked against. `wholeFileBytes` is its
        // companion, and `bytes` is neither of them: it is the payload.
        digest: digestOf(text),
        lines: total,
        startLine: asked ? from : Math.min(1, total),
        endLine: asked ? to : total,
        text: body.text,
        truncated: body.truncated,
        bytes: Buffer.byteLength(body.text, 'utf8'),
        wholeFileBytes: Buffer.byteLength(text, 'utf8'),
        ...(wantedEnd != null && wantedEnd > total ? { clampedEnd: true } : {}),
      },
    };
  },

  async write(input, ctx) {
    const at = rel(ctx, input.path, 'file path');
    if (at.error) return at;
    if (typeof input.text !== 'string') return problem('bad_request', 'text is required.');
    const before = digestOfFile(at.abs);
    const guard = guardWrite(ctx, at, input, at.rel);
    if (guard.error) return guard;
    if (before == null && input.expectedDigest != null) {
      return problem('no_file', `There is no ${at.rel} to replace.`);
    }
    const wrote = await putText(ctx, at.rel, input.text);
    if (wrote.error) return wrote;
    return {
      value: {
        path: at.rel,
        beforeDigest: before,
        afterDigest: digestOf(input.text),
        bytes: Buffer.byteLength(input.text, 'utf8'),
        ...wrote.through,
      },
    };
  },

  async replace_range(input, ctx) {
    const at = rel(ctx, input.path, 'file path');
    if (at.error) return at;
    if (typeof input.text !== 'string') return problem('bad_request', 'text is required.');
    let current;
    try {
      current = fs.readFileSync(at.abs, 'utf8');
    } catch {
      return problem('no_file', `There is no ${at.rel}.`);
    }
    const before = digestOf(current);
    const guard = guardWrite(ctx, at, input, at.rel);
    if (guard.error) return guard;
    // The file's own line ending, and lines with no \r riding along on them.
    // Splicing \n-joined segments into a CRLF file left one bare LF in the
    // middle of it, which is a change nobody asked for in a file nobody was
    // editing by hand.
    const eol = /\r\n/.test(current) ? '\r\n' : '\n';
    const lines = current.split(/\r?\n/);
    // The last segment of a terminated file is the empty string after its final
    // newline. It is not a line — it is the position AFTER the last one, and
    // `startLine === lines.length` is how an agent appends at the end.
    const appendPos = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    const from = Number(input.startLine);
    const to = Number(input.endLine ?? input.startLine);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || from > lines.length) {
      // `appendPos`, not `lines.length`: the empty segment after a terminated
      // file's final newline is a position, not a line, and counting it told an
      // agent a three-line file had four — a number it would then use.
      return problem('bad_request', `${at.rel} has ${appendPos} lines; ${from}–${to} is not a range in it.`);
    }
    // THE CONTRACT: `text` is a sequence of whole lines. Exactly one trailing
    // newline terminates the last of them and is consumed — every other one is
    // a blank line the caller meant — and `text: ''` deletes the range rather
    // than blanking it. Splicing `text.split('\n')` straight in made all three
    // wrong at once: 'A\n' became A plus an empty line, '' became one empty
    // line, and there was no way to say "delete this".
    const body = input.text === '' ? [] : String(input.text).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const next = [...lines.slice(0, from - 1), ...body, ...lines.slice(Math.min(to, appendPos))].join(eol);
    const wrote = await putText(ctx, at.rel, next);
    if (wrote.error) return wrote;
    return {
      value: {
        path: at.rel,
        beforeDigest: before,
        afterDigest: digestOf(next),
        replacedLines: `${from}-${to}`,
        lines: next.split('\n').length,
        ...wrote.through,
      },
    };
  },

  read_symbol: {
    channel: 'src:readSymbol',
    args: (input, ctx) => {
      const from = rel(ctx, input.fromFile, 'file path');
      if (from.error) return from;
      return { projectPath: ctx.root, fromFile: from.abs, spec: input.spec, name: input.name };
    },
    // src:readSymbol answers { ok, rel, text, line }. This read `raw.path`,
    // `raw.name`, `raw.startLine` and `raw.endLine` — none of which it sends —
    // so four of the five fields were null on every successful call and only
    // the text came through. `name` is the caller's own, and the handler
    // reports one line (where the declaration starts), not a range.
    // AN IN-BAND REFUSAL IS STILL A REFUSAL. src:readSymbol signals failure by
    // answering `{ ok: false, reason }` rather than throwing, and runMain only
    // makes an error envelope when the mapper reports one or the call throws —
    // so an unresolvable specifier, or a file too large to read, arrived as
    // ok:true with every field null.
    // AND IT IS THE WHOLE FILE. Stacki has no JavaScript parser in the main
    // process — the only symbol machinery is one regex that finds where a
    // declaration STARTS, with nothing that could find where it ends — so
    // there is no honest way to cut `money` out of a module. What comes back
    // is the file the symbol is declared in, and the payload says so rather
    // than letting the operation's name imply a span it did not compute. An
    // agent that wants the span composes: `declarationLine` into
    // `source.read {startLine, endLine}`.
    result: (raw, input) => {
      if (raw?.ok === false) {
        return problem('not_found', `${input?.spec} could not be read${raw.reason ? `: ${raw.reason}` : ''}.`);
      }
      const text = String(raw?.text ?? '');
      const body = clip(text, MAX_TEXT_BYTES);
      // Null, not zero. `declarationLine` answered 0 for "no such declaration"
      // and 0 is not a line, so a miss arrived looking like a position.
      const at = Number.isInteger(raw?.declarationLine) && raw.declarationLine > 0 ? raw.declarationLine : null;
      return {
        file: raw?.rel ? toPosix(raw.rel) : null,
        name: input?.name ?? null,
        text: body.text,
        wholeFile: true,
        lines: lineStarts(text).length,
        truncated: body.truncated,
        declarationLine: at,
        // The name this field had before it said what it meant. Kept so a
        // client reading `line` today does not break; `declarationLine` is the
        // one to read.
        line: at,
      };
    },
  },

  resolve_path: {
    channel: 'src:resolvePath',
    args: (input, ctx) => {
      const from = rel(ctx, input.fromFile, 'file path');
      if (from.error) return from;
      return { projectPath: ctx.root, fromFile: from.abs, spec: input.spec };
    },
    // `rel`, because that is the field the handler sends. It read `raw.path`,
    // which src:resolvePath has never answered with, so this operation returned
    // `{ path: null, outsideProject: false }` for every input it has ever been
    // given — a resolver that resolves nothing. The scenario asked only whether
    // a `path` key existed and whether `outsideProject` was false, and both were
    // true of the null.
    // Same in-band refusal as read_symbol above: `{ ok: false }` for a
    // specifier that points at nothing, which used to answer ok:true with a
    // null path — a resolver reporting success at resolving nothing.
    result: (raw, input) =>
      raw?.ok === false
        ? problem('not_found', `${input?.spec} does not resolve to a file in this project.`)
        : {
            path: raw?.rel ? toPosix(raw.rel) : null,
            // The handler refuses to leave the project at all (assertInProject
            // throws), so anything it resolves is inside it. Said from the
            // answer rather than asserted: a rel that climbs out is reported.
            outsideProject: typeof raw?.rel === 'string' && raw.rel.startsWith('..'),
          },
  },
};

// --- page --------------------------------------------------------------------

const summarizeScan = (raw, ctx, limit = MAX_LIST) => ({
  pages: take(raw?.pages, limit).map((p) => ({
    name: p.name,
    route: p.route,
    path: relativeTo(ctx.root, p.path),
    // WORKED OUT FROM THE ROUTE, because project:scan has never sent a flag.
    // This read `p.dynamic`, so src/pages/notes/[slug].astro — the one page in
    // the fixture that stands for many URLs — was reported `dynamic: false`,
    // along with every other page in every answer. The app decides the same
    // question the same way (App.jsx: `route?.includes('[')`), which is what
    // makes it the route's own property rather than a field somebody forgot.
    dynamic: typeof p.dynamic === 'boolean' ? p.dynamic : String(p.route ?? '').includes('['),
  })),
  components: take(raw?.components, limit).map((c) => ({
    name: c.name,
    path: relativeTo(ctx.root, c.path),
    slots: c.slots || null,
    // `schema` is what project:scan calls it — electron/main.js safeSchema()
    // spreads parsePropSchema's array in under that name. This read `c.props`,
    // a key the handler has never sent, so every component in this API
    // answered `props: []`: an agent asking what <Hero> takes was told
    // nothing, from a scan that knew `heading`.
    props: take(c.props || c.schema, 40).map((prop) => (typeof prop === 'string' ? prop : prop?.name)).filter(Boolean),
  })),
  layouts: take(raw?.layouts, limit).map((l) => ({ name: l.name, path: relativeTo(ctx.root, l.path) })),
  counts: {
    pages: raw?.pages?.length ?? 0,
    components: raw?.components?.length ?? 0,
    layouts: raw?.layouts?.length ?? 0,
  },
  trailingSlash: raw?.trailingSlash ?? null,
});

const page = {
  list: {
    channel: 'project:scan',
    args: (_input, ctx) => ctx.root,
    result: (raw, _input, ctx) => summarizeScan(raw, ctx),
  },

  read: {
    channel: 'page:read',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'page path');
      if (at.error) return at;
      // Only what Stacki parses as a document. The parser is forgiving enough
      // to make a tree out of a JavaScript file, and the tree would be
      // nonsense — an agent handed one would edit it and produce nonsense
      // back. Everything else is the source domain, and saying so is more
      // useful than a model nobody can trust.
      if (!/\.(astro|md|mdx)$/i.test(at.rel)) {
        return problem(
          'unrepresentable',
          `${at.rel} is not a page, a layout or a component — Stacki has no tree for it. Read it with the source domain.`
        );
      }
      return at.abs;
    },
    result: (raw, input) => ({
      path: input.path,
      editable: !!raw?.editable,
      reason: raw?.reason || null,
      format: raw?.model?.format || 'astro',
      imports: take(raw?.model?.imports, 80).map((i) => ({ name: i.name, path: i.path, named: !!i.named })),
      frontmatter: clip(raw?.model?.extraFrontmatter || '', 8000).text,
      // The shape of the tree, not the tree: a page's markup is what `target`
      // is for, and dumping it here would be the whole file in JSON.
      outline: outlineOf(raw?.model?.nodes || [], 0),
      digest: digestOf(raw?.source || ''),
      lines: String(raw?.source || '').split('\n').length,
    }),
  },

  create: {
    channel: 'page:create',
    risky: true,
    args: async (input, ctx) => {
      let layout = null;
      if (input.layout) {
        const scan = await ctx.callMain('project:scan', ctx.root);
        layout = (scan?.layouts || []).find((l) => l.name === input.layout) || null;
        if (!layout) return problem('no_layout', `This project has no layout called ${input.layout}.`);
      }
      return { projectPath: ctx.root, name: input.name, layout };
    },
    result: (raw, _input, ctx) => ({ path: relativeTo(ctx.root, raw?.pagePath || raw?.path || '') }),
  },

  delete: {
    channel: 'page:delete',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'page path');
      if (at.error) return at;
      if (!/^src\/pages\//.test(at.rel)) return problem('bad_request', 'Only a file under src/pages is a page.');
      return at.abs;
    },
    result: (_raw, input) => ({ deleted: input.path }),
  },

  move: {
    channel: 'page:move',
    args: (input, ctx) => {
      const from = rel(ctx, input.from, 'page path');
      if (from.error) return from;
      const to = String(input.to || '').replace(/^\/+/, '');
      if (!to || path.isAbsolute(to) || to.includes('\0')) {
        return problem('bad_path', 'to must be a path inside src/pages, relative to it.');
      }
      return { projectPath: ctx.root, from: from.abs, to };
    },
    result: (raw, _input, ctx) => ({ path: relativeTo(ctx.root, raw?.newPath || '') }),
  },

  folder_create: { channel: 'pagefolder:create', args: (input, ctx) => ({ projectPath: ctx.root, dir: input.dir }) },
  folder_rename: { channel: 'pagefolder:rename', args: (input, ctx) => ({ projectPath: ctx.root, from: input.from, to: input.to }) },
  folder_delete: { channel: 'pagefolder:delete', args: (input, ctx) => ({ projectPath: ctx.root, dir: input.dir }) },


  component_usage: {
    channel: 'component:usage',
    args: (input, ctx) => ({ projectPath: ctx.root, name: input.name, exclude: input.exclude || null }),
    result: (raw, _input, ctx) => ({
      total: raw?.total ?? null,
      // No `name` here: componentUsage answers { rel, path, kind, count } and
      // never a name, so this field was null in every entry of every answer.
      // The component's name is what the caller asked with.
      files: take(raw?.files, MAX_LIST).map((f) => ({
        path: f.path ? relativeTo(ctx.root, f.path) || f.rel || null : f.rel || null,
        kind: f.kind ?? null,
        count: f.count ?? null,
      })),
    }),
  },

  dynamic_paths: {
    channel: 'page:dynamicPaths',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'page path');
      if (at.error) return at;
      return { projectPath: ctx.root, pagePath: at.abs, devUrl: ctx.devUrl || null };
    },
    // page:dynamicPaths answers { entries, error }. This read `raw.paths` and
    // `raw.problem`, so a successful enumeration of two routes arrived as
    // `{ paths: [], problem: null }` — indistinguishable from a page with no
    // dynamic routes, and from a dev server that had answered 500. The scenario
    // accepted "no paths, or a problem", which this satisfied both ways.
    result: (raw) => ({ paths: take(raw?.entries || [], MAX_LIST), problem: raw?.error || null }),
  },

  injected_routes: {
    channel: 'project:injectedRoutes',
    args: (_input, ctx) => ({ projectPath: ctx.root }),
    result: (raw) => ({ routes: take(raw?.routes || raw, MAX_LIST) }),
  },

  import_path: {
    channel: 'page:importPathFor',
    args: (input, ctx) => {
      const from = rel(ctx, input.fromFile, 'file path');
      if (from.error) return from;
      const to = rel(ctx, input.targetFile, 'file path');
      if (to.error) return to;
      return { pagePath: from.abs, targetPath: to.abs, projectPath: ctx.root };
    },
    result: (raw) => ({ relative: raw?.relative ?? null, srcRelative: raw?.srcRelative ?? null }),
  },

  rebase_import: {
    channel: 'page:rebaseImport',
    args: (input, ctx) => {
      const from = rel(ctx, input.fromPage, 'file path');
      if (from.error) return from;
      const to = rel(ctx, input.toPage, 'file path');
      if (to.error) return to;
      return { fromPagePath: from.abs, toPagePath: to.abs, spec: input.spec };
    },
  },
};

/** A page's tree as a shape rather than a document. Two levels, bounded. */
function outlineOf(nodes, depth) {
  if (depth > 2) return undefined;
  return take(nodes, 40)
    .filter((n) => n && n.kind !== 'text' && n.kind !== 'comment')
    .map((n) => ({
      kind: n.kind,
      name: n.name || null,
      children: Array.isArray(n.children) && depth < 2 ? outlineOf(n.children, depth + 1) : undefined,
    }));
}

// --- content -----------------------------------------------------------------
//
// The CMS handlers name a file relative to `src/`, and one of them can carry a
// `#export` on the end (a page's own `const plans = […]`, edited as data).
// Everything in this API is project-relative, so the two are translated here
// rather than by making a caller remember which convention it is in.

const CMS_PREFIX = 'src/';

/** A project-relative CMS path, as the handler wants it: src/-relative, fragment kept. */
function cmsRel(ctx, value) {
  const raw = String(value || '').trim();
  const hash = raw.indexOf('#');
  const filePart = hash === -1 ? raw : raw.slice(0, hash);
  const fragment = hash === -1 ? '' : raw.slice(hash);
  const at = rel(ctx, filePart, 'data file');
  if (at.error) return at;
  if (!at.rel.startsWith(CMS_PREFIX)) {
    return problem('bad_path', `${at.rel} is not under src/, so it is not a data file Stacki manages.`);
  }
  return { ok: true, rel: at.rel.slice(CMS_PREFIX.length) + fragment, abs: at.abs, projectRel: at.rel + fragment };
}

/** And back: what a caller sees is always project-relative. */
const cmsPublic = (r) => `${CMS_PREFIX}${r}`;

// The digest content.entries hands back for one entry.
//
// A client passes it straight back as the guard on its write, so both sides
// have to mint it from the same bytes — which is why it is a function rather
// than an expression copied into two places that could drift by one field.
const entryDigest = (e) =>
  e && (e.body != null || e.data != null) ? digestOf(JSON.stringify({ data: e.data ?? null, body: e.body ?? null })) : null;

const entryFile = (e) => e?.rel ?? e?.file ?? null;

/** One collection's entries, or the refusal that says why there are none. */
async function listCollection(name, ctx) {
  try {
    return { ok: true, raw: await ctx.callMain('content:entries', { projectPath: ctx.root, name }) };
  } catch (err) {
    return { error: problem('no_collection', String(err?.message || err)).error };
  }
}

/**
 * The entry a write is about, resolved HERE rather than taken from the caller.
 *
 * `content.write_entry` used to accept an `entry` object and hand its `file` to
 * `path.resolve`, which accepts `..` segments and returns an absolute argument
 * unchanged. That made it the one write in this API outside the fence every
 * other one is inside — `source.write` refuses `../x.md` with `outside_project`
 * and this wrote the file. The same trust broke file-backed collections the
 * other way: `content.entries` did not report `locator`, so an entry handed
 * back carried no record address, and the write landed on the TOP of the data
 * file — a two-record array grew a third element that was a bare string, and
 * the envelope said ok.
 *
 * Both are one mistake: believing a client string about where an entry lives.
 * So the collection is listed again, and what is written is the entry
 * `listEntries` produced — `file` and `locator` both computed from the open
 * project root. No client string becomes a filesystem path on THIS operation;
 * the one other place in the domain where one did is `rename`, whose `to` is a
 * filename for a glob collection and is fenced by `renameTarget` below.
 *
 * `entry` is still accepted for one release, as a SELECTOR into that listing
 * and nothing else: it may choose which entry, never where one lives. A hint
 * that selects nothing is refused rather than followed.
 */
async function findContentEntry(input, ctx) {
  const hint = input.entry && typeof input.entry === 'object' ? input.entry : null;
  const wantedId = typeof input.id === 'string' && input.id ? input.id : typeof hint?.id === 'string' ? hint.id : null;
  const wantedFile = typeof hint?.file === 'string' ? hint.file : null;
  if (!wantedId && !wantedFile) {
    return problem('bad_request', 'id is required — the id of the entry, exactly as content.entries reported it.');
  }

  const named = typeof input.collection === 'string' && input.collection.trim() ? input.collection.trim() : null;
  // WITHOUT A COLLECTION NAME, the collections are searched for the entry the
  // hint describes. That is the deprecated shape kept working for one release,
  // and it is still a server-side resolution: the hint says which entry, the
  // project says where it is.
  let names = named ? [named] : null;
  if (!names) {
    let all;
    try {
      all = await ctx.callMain('content:collections', ctx.root);
    } catch (err) {
      return problem('failed', String(err?.message || err));
    }
    names = (all?.collections || []).map((c) => c.name).filter(Boolean);
  }

  const matches = [];
  let readOnly = null;
  for (const name of names) {
    const listed = await listCollection(name, ctx);
    if (listed.error) {
      if (named) return { error: listed.error };
      continue;
    }
    if (listed.raw?.readOnly) {
      if (named) return problem('read_only', listed.raw.reason || `${name} cannot be written through Stacki.`);
      readOnly = readOnly || { name, reason: listed.raw.reason };
      continue;
    }
    for (const e of listed.raw?.entries || []) {
      // Where the hint carries both, both have to agree: an id can repeat
      // across collections and the file is what says which one this is.
      if (wantedId && e.id !== wantedId) continue;
      if (wantedFile && entryFile(e) !== wantedFile) continue;
      matches.push({ collection: name, entry: e });
    }
  }

  if (!matches.length) {
    if (readOnly) return problem('read_only', readOnly.reason || `${readOnly.name} cannot be written through Stacki.`);
    return problem(
      'no_entry',
      named
        ? `${named} has no entry ${wantedId ?? wantedFile}. content.entries lists the ones it has.`
        : `Stacki found no entry ${wantedId ?? wantedFile} in any collection. Send \`collection\` and \`id\` — content.entries reports both.`
    );
  }
  if (matches.length > 1) {
    return problem(
      'bad_request',
      `${wantedId ?? wantedFile} is an entry in ${matches.map((m) => m.collection).join(' and ')}. Send \`collection\` to say which.`
    );
  }

  const [{ collection, entry }] = matches;
  // Belt and braces. The file came from `listEntries`, which built it from the
  // project root — this says so rather than assuming it, because the assumption
  // is exactly what failed before.
  const at = rel(ctx, entryFile(entry), 'entry file');
  if (at.error) return at;
  return { collection, entry: { ...entry, file: at.rel }, abs: at.abs };
}

/**
 * One resolution per call.
 *
 * `mainWithSync` needs the entry's file BEFORE the write, to snapshot it for
 * the undo stack; the args mapper needs the whole entry to dispatch. Resolving
 * twice would walk every file in the collection twice and leave a window in
 * which the two answers could disagree — so the promise is memoised on the
 * context object, which `run()` makes fresh for every call.
 */
function resolveContentEntry(input, ctx) {
  const cache = (ctx.__contentEntry ||= new Map());
  const key = JSON.stringify([input.collection ?? null, input.id ?? null, input.entry?.id ?? null, input.entry?.file ?? null]);
  if (!cache.has(key)) cache.set(key, findContentEntry(input, ctx));
  return cache.get(key);
}

/**
 * The id a rename is moving TO, before it becomes a filename.
 *
 * `write_entry` was closed by never letting a client string say where an entry
 * lives; the table entry two below it still did. For a glob collection the id
 * IS the filename — `planRename` builds `dirname(entry.file)/<to><ext>` and
 * `applyRename` hands that to `mkdirSync` and `renameSync` — so a `to` of
 * '../../../../elsewhere/x' moved a project file out of the project and
 * replaced whatever already sat there, silently, on {ok:true}. Same domain,
 * same `write` risk, same Edit level as the hole that was fixed: the fix was
 * applied to an instance rather than to the class.
 *
 * A nested id stays legal — a glob collection's ids carry the path under its
 * base, so 'drafts/second' is an ordinary id and renaming to one has to keep
 * working. What an id may not do is climb out, be absolute, or carry a NUL,
 * which is exactly `resolveInProject` against the project ROOT. Checking there
 * rather than against the entry's own directory is deliberate and is not a
 * weaker test: the destination directory is always at or below the root, so a
 * `to` whose net climb keeps it inside the root keeps it inside every directory
 * deeper than the root as well.
 */
function renameTarget(ctx, to) {
  const at = rel(ctx, to, 'new id');
  return at.error ? at : null;
}

const content = {
  cms_list: {
    channel: 'cms:list',
    args: (_i, ctx) => ctx.root,
    result: (raw) => ({
      files: take(raw?.files || raw, MAX_LIST).map((f) => ({
        path: cmsPublic(f.rel),
        name: f.name,
        dir: f.dir ?? null,
        size: f.size ?? null,
        // The data itself is what cms_read is for; a listing that carried every
        // file's contents would be the whole CMS in one answer.
        keys: f.data && typeof f.data === 'object' && !Array.isArray(f.data) ? Object.keys(f.data).slice(0, 60) : null,
        entries: Array.isArray(f.data) ? f.data.length : null,
      })),
    }),
  },
  cms_read: {
    channel: 'cms:read',
    args: (input, ctx) => {
      const at = cmsRel(ctx, input.path);
      if (at.error) return at;
      return { projectPath: ctx.root, rel: at.rel };
    },
    result: (raw, input, ctx) => ({
      path: input.path,
      ref: refFor(ctx, cmsRel(ctx, input.path).projectRel),
      digest: digestOfFile(cmsRel(ctx, input.path).abs),
      ...raw,
    }),
  },
  cms_write: {
    channel: 'cms:write',
    args: (input, ctx) => {
      const at = cmsRel(ctx, input.path);
      if (at.error) return at;
      const guard = guardWrite(ctx, { abs: at.abs, rel: at.projectRel }, input, at.projectRel);
      if (guard.error) return guard;
      if (input.data === undefined) return problem('bad_request', 'data is required.');
      return { projectPath: ctx.root, rel: at.rel, data: input.data };
    },
    result: (raw, input, ctx) => ({
      path: input.path,
      afterDigest: digestOfFile(cmsRel(ctx, input.path).abs),
      ...(raw && typeof raw === 'object' ? raw : {}),
    }),
  },
  cms_create: {
    channel: 'cms:create',
    args: (input, ctx) => ({ projectPath: ctx.root, name: input.name }),
    result: (raw) => ({ path: raw?.rel ? cmsPublic(raw.rel) : null, ...(raw && typeof raw === 'object' ? { ...raw, rel: undefined } : {}) }),
  },
  cms_delete: {
    channel: 'cms:delete',
    args: (input, ctx) => {
      const at = cmsRel(ctx, input.path);
      if (at.error) return at;
      return { projectPath: ctx.root, rel: at.rel };
    },
  },
  cms_usage: {
    channel: 'cms:usage',
    args: (input, ctx) => {
      const at = cmsRel(ctx, input.path);
      if (at.error) return at;
      return { projectPath: ctx.root, rel: at.rel };
    },
    // BACK OUT OF THE CMS CONVENTION, like everything else here. cmsRefs.js
    // names an importer relative to src/ ('pages/index.astro'), and this
    // passed that straight through — so cms_list answered
    // 'src/data/site.json' and cms_usage answered 'pages/index.astro', and the
    // second is not a path any other operation in this API accepts. An agent
    // asking which pages read a data file got an answer it could not open.
    result: (raw) => ({ files: take(raw?.files || [], MAX_LIST).map((r) => cmsPublic(r)) }),
  },
  cms_meta: {
    channel: 'cms:meta',
    args: (_i, ctx) => ctx.root,
    // The same translation, on the keys. .stacki/cms.json is keyed by the
    // src-relative rel the CMS panel looks fields up by, and that convention
    // stays on disk — but a caller that reads a key here has to be able to
    // hand it back to cms_set_meta or cms_read, and 'data/site.json' is
    // refused by both ('not under src/'). A '#export' fragment survives the
    // round trip: cmsRel splits it off before resolving.
    result: (raw) => ({
      meta: Object.fromEntries(Object.entries(raw?.meta || {}).map(([k, v]) => [cmsPublic(k), v])),
    }),
  },
  cms_set_meta: {
    channel: 'cms:setMeta',
    args: (input, ctx) => {
      const at = cmsRel(ctx, input.path);
      if (at.error) return at;
      return { projectPath: ctx.root, rel: at.rel, fields: input.fields };
    },
  },
  config: { channel: 'content:config', args: (input, ctx) => ({ projectPath: ctx.root, force: !!input.force }) },
  collections: { channel: 'content:collections', args: (_i, ctx) => ctx.root },
  entries: {
    channel: 'content:entries',
    args: (input, ctx) => ({ projectPath: ctx.root, name: input.collection }),
    result: (raw, input) => {
      const list = raw?.entries || raw || [];
      const limit = Math.min(input.limit || 100, MAX_LIST);
      return {
        collection: input.collection,
        // "I CANNOT READ THIS" IS NOT "THERE IS NOTHING HERE". A collection
        // built by a custom loader answers `{ entries: [], readOnly: true,
        // reason }`, and dropping those two made it byte-identical to an empty
        // collection — so an agent was told a collection was empty when Stacki
        // simply had no way to enumerate it.
        ...(raw?.readOnly ? { readOnly: true, reason: raw.reason ?? null } : {}),
        returned: Math.min(list.length, limit),
        total: list.length,
        entries: take(list, limit).map((e) => ({
          id: e.id ?? null,
          slug: e.slug ?? null,
          file: entryFile(e),
          // WHERE THE RECORD IS INSIDE THAT FILE, and it is the only thing that
          // makes an entry writable. A file-backed collection keeps every entry
          // in one data file; without the locator an entry written back
          // addressed the top of the file rather than its own record, so a
          // two-record array grew a third element that was a bare string while
          // the record the caller meant stayed as it was.
          locator: Array.isArray(e.locator) ? e.locator : [],
          format: e.format ?? null,
          keyed: !!e.keyed,
          data: e.data ?? null,
          // A whole markdown body per entry turns a listing into a book.
          body: e.body == null ? null : clip(e.body, 2000).text,
          digest: entryDigest(e),
        })),
        truncated: list.length > limit,
      };
    },
  },
  write_entry: {
    channel: 'content:writeEntry',
    args: async (input, ctx) => {
      if (input.edits !== undefined && !Array.isArray(input.edits)) {
        return problem('bad_request', 'edits is a list of { path, value } — one per field to change.');
      }
      const found = await resolveContentEntry(input, ctx);
      if (found.error) return found;
      // THE VERSION GUARD, WITH NOTHING TO REMEMBER. content.entries already
      // mints a digest per entry and the client hands it straight back inside
      // the entry object, so the common case is guarded without a caller asking
      // for it — and a caller that names no version at all is refused, exactly
      // as content.cms_write refuses one. Same function, same envelopes.
      const stale = checkDigest({
        expected: typeof input.expectedDigest === 'string' ? input.expectedDigest : input.entry?.digest,
        actual: entryDigest(found.entry),
        what: `${found.collection}/${found.entry.id}`,
        requireForExisting: true,
      });
      if (stale) return { error: stale };
      return {
        projectPath: ctx.root,
        collection: found.collection,
        entry: found.entry,
        // The agent path opts INTO the schema check the CMS panel deliberately
        // does not want; `allowInvalid` still checks and still reports, it just
        // writes anyway — so an override is a decision on the record.
        validate: true,
        allowInvalid: input.allowInvalid === true,
        // `[]`, not `{}`. The implementation maps over this; an object arrived
        // at `.map` and took the operation down for every caller, including the
        // ones that sent no edits at all and only wanted to rewrite the body.
        edits: input.edits || [],
        body: input.body,
      };
    },
  },
  validate: {
    channel: 'content:validate',
    args: (input, ctx) => {
      if (input.data === undefined) {
        return problem('bad_request', 'data is required — the entry data to check, as an object of fields.');
      }
      return { projectPath: ctx.root, collection: input.collection, data: input.data };
    },
    // AN EMPTY `issues` LIST MEANS TWO THINGS AND THEY ARE NOT THE SAME. It
    // meant "the schema is satisfied" and "there was no schema to satisfy", and
    // an unknown collection landed in the second — so a misspelled name came
    // back as an all-clear. `checked` is the field that separates them, and an
    // unknown collection is now the refusal content.entries already gives.
    result: (raw, input) => {
      if (raw?.unknownCollection) {
        return problem('no_collection', raw.message || `${input.collection} is not a collection in this project.`);
      }
      const unchecked = !!raw?.unchecked || !!raw?.error;
      return {
        collection: input.collection,
        issues: raw?.issues || [],
        checked: !unchecked,
        ...(unchecked ? { unchecked: true, reason: raw?.reason ?? raw?.error ?? null } : {}),
      };
    },
  },
  targets: { channel: 'content:targets', args: (input, ctx) => ({ projectPath: ctx.root, name: input.collection }) },
  rename_plan: {
    channel: 'content:renamePlan',
    args: (input, ctx) => {
      const fenced = renameTarget(ctx, input.to);
      if (fenced) return fenced;
      return { projectPath: ctx.root, name: input.collection, from: input.from, to: input.to };
    },
  },
  rename: {
    channel: 'content:rename',
    args: (input, ctx) => {
      const fenced = renameTarget(ctx, input.to);
      if (fenced) return fenced;
      return { projectPath: ctx.root, name: input.collection, from: input.from, to: input.to };
    },
  },
  sample_entry: {
    channel: 'content:sampleEntry',
    args: (input, ctx) => ({ devUrl: ctx.devUrl || null, name: input.collection, id: input.id || null }),
  },
  resolve_import: {
    channel: 'project:resolveImport',
    args: (input, ctx) => {
      const from = rel(ctx, input.fromFile, 'file path');
      if (from.error) return from;
      return { projectPath: ctx.root, fromFile: from.abs, spec: input.spec };
    },
    result: (raw, _i, ctx) => ({ path: raw?.path ? relativeTo(ctx.root, raw.path) : null }),
  },
};

// --- asset -------------------------------------------------------------------

const asset = {
  list: {
    channel: 'assets:list',
    args: (_i, ctx) => ctx.root,
    result: (raw, input) => {
      const entries = raw?.entries || [];
      const under = input.under ? String(input.under).replace(/^\/+|\/+$/g, '') : null;
      const filtered = under ? entries.filter((e) => e.rel === under || e.rel.startsWith(`${under}/`)) : entries;
      const limit = Math.min(input.limit || 200, MAX_LIST);
      return {
        returned: Math.min(filtered.length, limit),
        total: filtered.length,
        missingPublic: !!raw?.missing,
        entries: take(filtered, limit).map((e) => ({ path: e.rel, name: e.name, isDir: !!e.isDir, root: e.root ?? null })),
        truncated: filtered.length > limit,
      };
    },
  },
  dimensions: {
    channel: 'assets:dimensions',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'asset path');
      if (at.error) return at;
      return { projectPath: ctx.root, rel: at.rel };
    },
  },
  read_text: {
    channel: 'assets:readText',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'asset path');
      if (at.error) return at;
      return { projectPath: ctx.root, rel: at.rel };
    },
    result: (raw, input, ctx) => {
      const body = clip(raw?.text ?? '', MAX_TEXT_BYTES);
      return {
        path: input.path,
        ref: refFor(ctx, input.path),
        text: body.text,
        truncated: body.truncated,
        digest: digestOfFile(path.resolve(ctx.root, input.path)),
      };
    },
  },
  write_text: {
    channel: 'assets:writeText',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'asset path');
      if (at.error) return at;
      const guard = guardWrite(ctx, at, input, at.rel);
      if (guard.error) return guard;
      if (typeof input.text !== 'string') return problem('bad_request', 'text is required.');
      return { projectPath: ctx.root, rel: at.rel, text: input.text };
    },
    // The digest of what is ON DISK, not of what the caller asked for. This
    // hashed `input.text`, so a write that did not land still reported the
    // digest of the text it was supposed to contain — and a client using that
    // for optimistic concurrency would then hold a digest no file has. The
    // cms_write beside it has always read the file.
    result: (_raw, input, ctx) => ({
      path: input.path,
      afterDigest: digestOfFile(path.resolve(ctx.root, input.path)),
    }),
  },
  mkdir: {
    channel: 'assets:mkdir',
    args: (input, ctx) => {
      const at = rel(ctx, input.parent, 'asset folder');
      if (at.error) return at;
      return { projectPath: ctx.root, parentRel: at.rel, name: input.name };
    },
  },
  move: {
    channel: 'assets:move',
    args: (input, ctx) => {
      const from = rel(ctx, input.path, 'asset path');
      if (from.error) return from;
      const to = rel(ctx, input.toFolder, 'asset folder');
      if (to.error) return to;
      return { projectPath: ctx.root, fromRel: from.rel, toDirRel: to.rel };
    },
  },
  rename: {
    channel: 'assets:rename',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'asset path');
      if (at.error) return at;
      return { projectPath: ctx.root, rel: at.rel, newName: input.name };
    },
  },
  delete: {
    channel: 'assets:delete',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'asset path');
      if (at.error) return at;
      return { projectPath: ctx.root, rel: at.rel };
    },
  },
};

// --- style (the parts that are files rather than the live cascade) -----------

/** One stylesheet edit, with its file checked. */
function cssEdit(ctx, edit) {
  if (!edit || typeof edit !== 'object') return problem('bad_request', 'edit is required.');
  const at = rel(ctx, edit.file, 'stylesheet path');
  if (at.error) return at;
  return { projectPath: ctx.root, ...edit, file: at.rel };
}

/** A list of them, refused as a set: half a batch of variable edits is worse. */
function cssEdits(ctx, list, what) {
  if (!Array.isArray(list) || !list.length) return problem('bad_request', `${what} must name at least one edit.`);
  const out = [];
  for (const edit of list) {
    const built = cssEdit(ctx, edit);
    if (built.error) return built;
    const { projectPath, ...rest } = built;
    out.push(rest);
  }
  return { projectPath: ctx.root, [what]: out };
}

const style = {
  read_source: {
    channel: 'style:readFile',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'stylesheet path');
      if (at.error) return at;
      return at.abs;
    },
    result: (raw, input, ctx) => {
      const body = clip(raw?.css ?? raw?.text ?? '', MAX_TEXT_BYTES);
      return {
        path: input.path,
        ref: refFor(ctx, input.path),
        css: body.text,
        truncated: body.truncated,
        digest: digestOfFile(path.resolve(ctx.root, input.path)),
      };
    },
  },
  write_source: {
    channel: 'style:writeFile',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'stylesheet path');
      if (at.error) return at;
      const guard = guardWrite(ctx, at, input, at.rel);
      if (guard.error) return guard;
      if (typeof input.css !== 'string') return problem('bad_request', 'css is required.');
      return { filePath: at.abs, css: input.css };
    },
    result: (_raw, input) => ({ path: input.path, afterDigest: digestOf(input.css) }),
  },
  variables: {
    channel: 'css:variables',
    args: (_i, ctx) => ctx.root,
    // `limit` IS ABOUT THE VARIABLES, which is the only unit a caller could
    // have meant: it capped the FILE array, and `values` — a flat name→value
    // map of the whole project, and the bulk of the bytes — went past it
    // untouched. An agent asking for five tokens got seventy-one in fourteen
    // kilobytes, with `truncated: false` to say nothing had been left out.
    // So the walk below keeps CELLS until the limit is reached, drops the rows,
    // blocks, groups and files left empty behind it, and reports what it did.
    result: (raw, input) => {
      const files = raw?.files || [];
      const limit = Math.min(input.limit || 200, MAX_LIST);
      let kept = 0;
      let total = 0;
      const names = new Set();
      const trimmed = [];
      for (const f of files) {
        const groups = [];
        for (const g of take(f.groups, 60)) {
          const blocks = [];
          for (const b of g.blocks || []) {
            const rows = [];
            for (const r of b.rows || []) {
              const cells = [];
              for (const c of r.cells || []) {
                total += 1;
                if (kept >= limit) continue;
                kept += 1;
                if (c?.name) names.add(c.name);
                cells.push(c);
              }
              if (cells.length) rows.push({ ...r, cells });
            }
            if (rows.length) blocks.push({ ...b, rows });
          }
          if (blocks.length) groups.push({ ...g, blocks });
        }
        // A file whose variables all fell past the limit is not part of the
        // answer; one that reported an error is, because that IS its answer.
        if (groups.length || f.error) {
          trimmed.push({ path: f.rel, name: f.name, error: f.error || null, count: f.count ?? null, groups });
        }
      }
      const values = raw?.values || {};
      return {
        // One entry per stylesheet that declares custom properties, with the
        // sections the Variables panel shows. `values` is every name resolved
        // to its value, which is what a caller actually wants when it is
        // chasing a var() it found in a declaration — narrowed to what came
        // back when the walk left something out, and whole when it did not.
        files: trimmed,
        filesTotal: files.length,
        values: kept < total ? Object.fromEntries(Object.entries(values).filter(([name]) => names.has(name))) : values,
        valuesTotal: Object.keys(values).length,
        returned: kept,
        total,
        truncated: kept < total,
        error: raw?.error || null,
      };
    },
  },
  // Every one of these writes at an OFFSET in a stylesheet — that is how the
  // Variables panel edits one value without reformatting the file around it.
  // Which makes the file argument the sharpest edge in this domain: an offset
  // is meaningless anywhere else, and a missing one is not a no-op but a write
  // over the whole file. So the path is validated here and the numbers are
  // required by the schema.
  set_variable: { channel: 'css:setVariable', args: (input, ctx) => cssEdit(ctx, input.edit) },
  add_variables: { channel: 'css:addVariables', args: (input, ctx) => cssEdits(ctx, input.adds, 'adds') },
  rename_variables: { channel: 'css:renameVariables', args: (input, ctx) => ({ projectPath: ctx.root, renames: input.renames }) },
  move_variables: { channel: 'css:moveVariables', args: (input, ctx) => cssEdits(ctx, input.moves, 'moves') },
  add_section: { channel: 'css:addSection', args: (input, ctx) => cssEdit(ctx, input.edit) },
  set_section_title: { channel: 'css:setSectionTitle', args: (input, ctx) => cssEdit(ctx, input.edit) },
  remove_section: { channel: 'css:removeSection', args: (input, ctx) => cssEdit(ctx, input.edit) },
  move_heading: { channel: 'css:moveHeading', args: (input, ctx) => cssEdit(ctx, input.edit) },
};

// --- project -----------------------------------------------------------------

const project = {
  scan: { channel: 'project:scan', args: (_i, ctx) => ctx.root, result: (raw, _i, ctx) => summarizeScan(raw, ctx) },
  classes: {
    channel: 'project:classes',
    args: (_i, ctx) => ctx.root,
    result: (raw, input) => {
      const list = raw?.classes || raw || [];
      const limit = Math.min(input.limit || 500, 2000);
      return { returned: Math.min(list.length, limit), total: list.length, classes: take(list, limit) };
    },
  },
  dependencies: { channel: 'project:hasNodeModules', args: (_i, ctx) => ctx.root, result: (raw) => ({ installed: !!(raw?.has ?? raw) }) },
  install: { channel: 'project:install', args: (_i, ctx) => ctx.root },
  diagnose: {
    channel: 'dev:diagnose',
    args: (_i, ctx) => ctx.root,
    // The panel shows the path to the node binary because a person may need to
    // go and look at it. Nothing an agent can do with it is worth telling it
    // where somebody's home directory is.
    // `kind` IS FOUR VALUES AND THE HEALTHY ONE WAS CALLED 'unknown'. It is the
    // dev-server verdict — not, as it was read, a statement about the package
    // manager — and 'unknown' meant node is here, the dependencies are here and
    // the version satisfies Astro: nothing is wrong. A value nobody can act on,
    // for the case where everything is fine. Translated here rather than in the
    // handler, because the preview's error panel reads the handler's own answer
    // and switches on 'unknown'.
    result: (raw) => ({
      kind: raw?.kind === 'unknown' || raw?.kind == null ? 'ready' : raw.kind,
      nodeFound: !!raw?.nodePath,
      nodeVersion: raw?.nodeVersion ?? null,
      astroVersion: raw?.astroVersion ?? null,
      requires: raw?.requires ?? null,
      // Which one to run, and what said so. 'default' in `from` means no
      // lockfile was found and npm is the fallback, not a detection.
      packageManager: raw?.packageManager ?? null,
    }),
  },
  // PROBE THE PROJECT'S PREVIEW, not an arbitrary address.
  //
  // `input.url` used to win outright over the trusted `ctx.devUrl`, which made
  // this a general-purpose fetch wearing a project operation's name. It is
  // resolved against the preview origin instead, so the ordinary thing an agent
  // wants -- "is /pricing answering?" -- is a route, an absolute URL on the
  // project still works, and anything else is refused HERE, before the main
  // process is asked for anything.
  //
  // The fence in electron/devProbe.js is the one that matters, because it also
  // sees the redirects. This one exists so the refusal names the reason at the
  // boundary the agent is actually standing at.
  probe: {
    channel: 'dev:probe',
    args: (input, ctx) => {
      const preview = ctx.devUrl || null;
      if (!input.url) return { url: preview, projectOrigin: preview };
      if (!preview) {
        return problem(
          'no_preview',
          'There is no preview running, so there is no project origin to probe. Start the dev server first.'
        );
      }
      let resolved = null;
      try {
        resolved = new URL(String(input.url), preview);
      } catch {
        return problem('bad_route', `${input.url} is not a route this project can serve.`);
      }
      if (!projectOriginTest(originOf(preview))(originOf(resolved.href))) {
        return problem(
          'route_outside_project',
          `${input.url} resolves to ${originOf(resolved.href) || 'an origin Stacki cannot read'}, which is not ` +
            `${preview}, the project Stacki is serving. project.probe only ever reaches this project.`
        );
      }
      // The origin travels with the route. Main prefers its own record of the
      // dev server and only falls back to this, and this is `ctx.devUrl` --
      // main's own `getDevUrl` -- never anything read out of `input.url`.
      return { url: resolved.href, projectOrigin: preview };
    },
  },

};

// --- git ---------------------------------------------------------------------

const gitPath = (input, ctx, key = 'path') => {
  const at = rel(ctx, input[key], 'file path');
  return at.error ? at : at.rel;
};

const git = {
  info: { channel: 'git:info', args: (_i, ctx) => ctx.root },
  gh_status: { channel: 'git:ghStatus', args: (_i, ctx) => ctx.root },
  status: {
    channel: 'git:status',
    args: (_i, ctx) => ({ projectPath: ctx.root }),
    result: (raw, input) => {
      const list = raw?.files || raw || [];
      const limit = Math.min(input.limit || 200, MAX_LIST);
      return { returned: Math.min(list.length, limit), total: list.length, files: take(list, limit) };
    },
  },
  log: {
    channel: 'git:log',
    args: (input, ctx) => ({ projectPath: ctx.root, ref: input.ref || null, limit: Math.min(input.limit || 30, 200), skip: input.skip || 0 }),
    result: (raw) => ({ commits: take(raw?.commits || raw, 200), atEnd: raw?.atEnd ?? null }),
  },
  commit_files: {
    channel: 'git:commitFiles',
    args: (input, ctx) => ({ projectPath: ctx.root, ref: input.ref }),
    result: (raw) => ({ files: take(raw?.files || raw, MAX_LIST) }),
  },
  all_files: {
    channel: 'git:allFiles',
    args: (_i, ctx) => ({ projectPath: ctx.root }),
    result: (raw, input) => {
      const list = raw?.files || raw || [];
      const limit = Math.min(input.limit || 500, 2000);
      return { returned: Math.min(list.length, limit), total: list.length, files: take(list, limit) };
    },
  },
  file_at: {
    channel: 'git:fileAt',
    args: (input, ctx) => {
      const at = gitPath(input, ctx);
      if (at.error) return at;
      return { projectPath: ctx.root, ref: input.ref, path: at };
    },
    result: (raw) => {
      // A FILE THAT WAS NOT THERE YET is not a file that was empty. The handler
      // answers `null` on purpose, and `null ?? ''` turned "this page did not
      // exist at that commit" into an empty document — which reads as a page
      // somebody had emptied.
      if (raw === null || raw === undefined) return { text: null, existed: false, truncated: false };
      const body = clip(raw?.text ?? raw ?? '', MAX_TEXT_BYTES);
      return { text: body.text, existed: true, truncated: body.truncated };
    },
  },
  worktrees: { channel: 'git:worktrees', args: (_i, ctx) => ({ projectPath: ctx.root }), result: (raw) => ({ worktrees: take(raw?.worktrees || raw, MAX_LIST) }) },
  init: { channel: 'git:init', args: (_i, ctx) => ctx.root },
  commit: {
    channel: 'git:commit',
    args: (input, ctx) => {
      if (!String(input.message || '').trim()) return problem('bad_request', 'A commit message is required.');
      return { projectPath: ctx.root, message: input.message, paths: input.paths || null };
    },
    // THE COMMIT THAT WAS MADE, not the fact that one was. The handler answers
    // `{ ok: true, files: null }` — a count or a null, never a sha and never a
    // branch — because it was written for a panel that re-reads the repository
    // itself. An agent has no panel, so the only way to learn what it had just
    // done was to ask git in a second call. Both answers below come from
    // handlers that already exist and are already bounded.
    result: async (raw, _input, ctx) => {
      const info = await ctx.callMain('git:info', ctx.root);
      const at = info?.head || null;
      const changed = at ? await ctx.callMain('git:commitFiles', { projectPath: ctx.root, ref: at }) : null;
      return {
        head: at,
        branch: info?.branch || null,
        files: take(changed?.files || changed, MAX_LIST),
        // What the handler said about the pathspec: null for "everything",
        // otherwise how many paths were picked.
        picked: raw?.files ?? null,
      };
    },
  },
  checkout: {
    channel: 'git:checkout',
    args: (input, ctx) => ({ projectPath: ctx.root, branch: input.branch, create: !!input.create, parkFirst: input.parkFirst !== false }),
  },
  merge: { channel: 'git:merge', args: (input, ctx) => ({ projectPath: ctx.root, branch: input.branch }) },
  resolve_merge: { channel: 'git:resolveMerge', args: (input, ctx) => ({ projectPath: ctx.root, branch: input.branch, choices: input.choices || {} }) },
  delete_branch: {
    channel: 'git:deleteBranch',
    args: (input, ctx) => ({ projectPath: ctx.root, branch: input.branch, force: !!input.force }),
    // A REFUSAL WITH NO CODE IS A REFUSAL AN AGENT HAS TO READ ENGLISH TO
    // CLASSIFY. `{ ok: false, unmerged: true }` is exactly the shape runMain
    // spreads into an envelope, so `code` came out undefined while every other
    // refusal in the surface has one. The handler's own sentence is good and is
    // kept; only the code is added.
    result: async (raw, input, ctx) => {
      if (raw?.ok === false && raw.unmerged) return problem('unmerged_branch', String(raw.message || `"${input.branch}" has commits that are not on any other branch.`));
      const info = await ctx.callMain('git:info', ctx.root);
      return { deleted: input.branch, branches: take(info?.branches, MAX_LIST), branch: info?.branch || null };
    },
  },
  restore_file: {
    channel: 'git:restoreFile',
    args: (input, ctx) => {
      const at = gitPath(input, ctx);
      if (at.error) return at;
      // "PUT THIS FILE BACK" means "back to the last commit" unless it says
      // otherwise, which is what the panel's own restore does.
      return { projectPath: ctx.root, ref: input.ref || 'HEAD', path: at };
    },
    // The same two things: a code on the in-band refusal, and evidence on the
    // success. The digest is of what is on disk NOW — the whole point of the
    // operation is that those bytes changed, and a caller that has to re-read
    // the file to find out what it got has not been told anything.
    result: (raw, input, ctx) => {
      const at = gitPath(input, ctx);
      if (at.error) return at;
      if (raw?.ok === false && raw.missing) return problem('missing_at_ref', String(raw.message || `That version does not have ${at}.`));
      return { file: at, ref: input.ref || 'HEAD', afterDigest: digestOfFile(path.resolve(ctx.root, at)) };
    },
  },
  restore_project: {
    channel: 'git:restoreProject',
    args: (input, ctx) => ({ projectPath: ctx.root, ref: input.ref }),
    // Counts rather than a list: going back can touch the whole tree, and an
    // answer that named every file would be the one thing this API promises not
    // to send. `parked` stays — it is how the caller knows the work it had is
    // recoverable.
    result: async (raw, input, ctx) => {
      const status = await ctx.callMain('git:status', { projectPath: ctx.root });
      const info = await ctx.callMain('git:info', ctx.root);
      const list = status?.files || status || [];
      return { parked: raw?.parked ?? false, ref: input.ref, head: info?.head || null, branch: info?.branch || null, changedFiles: Array.isArray(list) ? list.length : null };
    },
  },
  park: { channel: 'git:park', args: (_i, ctx) => ({ projectPath: ctx.root }) },
  unpark: {
    channel: 'git:unpark',
    args: (_i, ctx) => ({ projectPath: ctx.root }),
    // `{ restored: false, error }` is a refusal, and it used to arrive as
    // ok:true with an error string nobody was obliged to read.
    result: (raw) =>
      raw && raw.restored === false && raw.error
        ? problem('failed', String(raw.error))
        : { restored: raw?.restored !== false, ...(raw?.error ? { note: String(raw.error) } : {}) },
  },
  push: {
    channel: 'git:push',
    // A push with no branch named pushes the branch the person is looking at.
    // `git push -u origin <branch>` sets the upstream either way, so this is the
    // ordinary intent rather than a guess. The window publishes the branch it is
    // showing; where it has not published one yet, git is asked, which is the
    // same answer one moment fresher. Only when neither knows is `branch`
    // required — and then it says so rather than picking one.
    args: async (input, ctx) => {
      let branch = input.branch || ctx.branch;
      if (!branch) branch = (await ctx.callMain('git:info', ctx.root))?.branch || null;
      if (!branch) {
        return problem('bad_request', 'Stacki could not work out which branch to push, so `branch` is required.');
      }
      return { projectPath: ctx.root, branch };
    },
    // What is now true of the remote, read from git rather than assumed from
    // the absence of an exception. `ahead` is the load-bearing one: it is zero
    // exactly when the push landed everything, and a caller can tell a
    // successful push from a successful no-op without another call.
    result: async (raw, input, ctx) => {
      const info = await ctx.callMain('git:info', ctx.root);
      return { branch: info?.branch || input.branch || null, remote: info?.remote || null, head: info?.head || null, ahead: info?.ahead ?? null, hasUpstream: info?.hasUpstream ?? null };
    },
  },
  publish: {
    channel: 'git:publish',
    args: (input, ctx) => ({ projectPath: ctx.root, repoName: input.repoName, isPrivate: input.private !== false }),
    // Three different things used to be one `code: 'failed'`: gh not installed,
    // gh installed and signed out, and GitHub itself refusing. The handler now
    // tells them apart and says which — returned rather than thrown, so the
    // code survives the generic catch — and this turns that into the refusal
    // shape the rest of the surface uses.
    result: (raw) => (raw?.ok === false ? problem(String(raw.code || 'failed'), String(raw.message || 'The publish did not happen.')) : raw),
  },
};

const DOMAINS = { source, page, content, asset, style, project, git };

/**
 * Run one main-process operation.
 *
 * `entry` is what the tables above hold: either a function that does the work
 * itself (the source domain, which is about files rather than about a handler)
 * or a `{ channel, args, result }` triple that calls one of Stacki's own.
 */
async function runMain(domain, action, input, ctx) {
  const entry = DOMAINS[domain]?.[action];
  if (!entry) return { ok: false, code: 'bad_action', message: `${domain} has no main-process action "${action}".` };
  if (typeof entry === 'function') {
    // THE SAME CATCH AS THE CHANNEL BRANCH BELOW. It did not have one: the
    // source domain writes files itself rather than through a handler, and a
    // write into a directory that is not there left `fs.writeFileSync`'s throw
    // to whatever caught it last — which spelled Node's own ENOENT sentence,
    // absolute path and all, out to the client under `code: 'failed'`. The
    // domain a failure came from is not a reason for it to be reported
    // differently.
    try {
      const out = await entry(input, ctx);
      if (out?.error) return out.error;
      return { ok: true, ...(out?.value || {}) };
    } catch (err) {
      return thrownFailure(err, ctx);
    }
  }
  const built = await entry.args(input, ctx);
  if (built?.error) return built.error;
  let raw;
  try {
    raw = await ctx.callMain(entry.channel, built);
  } catch (err) {
    return thrownFailure(err, ctx);
  }
  // Awaited, because a result mapper may need to ASK: a commit that answers
  // with the sha it made has to read the sha, and reading it is what makes
  // the field evidence rather than a claim.
  const shaped = entry.result ? await entry.result(raw, input, ctx) : raw;
  // A RESULT MAPPER MAY REFUSE, the same way an args mapper may — `problem()`
  // in either place means the same thing. Several handlers signal failure in
  // band (`{ ok: false, reason }`) rather than by throwing, and without this
  // the only thing a mapper could do with that was spread it into an ok:true
  // envelope: a resolver reporting success at resolving nothing.
  //
  // Only `problem()`'s own shape counts. Plenty of answers carry an `error`
  // STRING as an ordinary field — content.config says why it cannot read a
  // config, css:setVariable says why it would not write — and treating those as
  // the refusal itself replaced the whole envelope with that string, which
  // arrives at a client spread into numbered characters.
  if (shaped?.error && typeof shaped.error === 'object' && shaped.error.ok === false) return shaped.error;
  // AND A HANDLER'S OWN `ok:false` IS A REFUSAL TOO. The spread below carried
  // one through word for word, so `css:setVariable` refusing a stale offset
  // reached an agent as `{ok:false, stale:true, error:"This file changed since
  // the panel read it."}` — no `code` to branch on, and the sentence under
  // `error` where every other refusal in this surface says `message`. That is
  // the one answer a client cannot act on, and it was the LAST guard before a
  // write at a byte offset, so the agent that hit it had no way to tell "your
  // offsets are stale, read again" from any other failure.
  if (shaped && typeof shaped === 'object' && shaped.ok === false) return refusal(shaped);
  return { ok: true, ...(shaped && typeof shaped === 'object' && !Array.isArray(shaped) ? shaped : { value: shaped }) };
}

// An absolute path, as it appears inside a sentence: at the start, or after a
// space, a quote, an opening bracket or an `=`. Not after a colon, which is
// what keeps `http://localhost:4321/x` out of it.
const ABSOLUTE_IN_TEXT = /(^|[\s'"`([=,])((?:\/|[A-Za-z]:\\)[^\s'"`)\],]+)/g;

/**
 * A message with this machine taken out of it.
 *
 * The handlers that know they are answering an agent already speak in
 * project-relative paths. The ones that simply let an fs error out do not, and
 * an fs error carries the absolute path inside its message: `content.cms_read`
 * on a missing file reached a real client as `ENOENT: no such file or
 * directory, open '/Users/…/src/data/nope.json'`, somebody's home directory in
 * an answer an agent is free to quote back, log, or paste into a commit.
 *
 * That was fixed at one handler and it is not a property of one handler. This
 * is the last place a thrown message becomes wire text, so it is where the
 * rule belongs: inside the project, a path is said the only way that means
 * anything off this machine — relative to the project root. Outside it,
 * nothing is said at all, because nothing outside the project is any of the
 * client's business.
 */
function withoutHostPaths(message, root) {
  return String(message).replace(ABSOLUTE_IN_TEXT, (whole, lead, abs) => {
    const rel = relativeTo(root, abs.replace(/[.,;:]+$/, ''));
    return rel ? `${lead}${rel}` : `${lead}a path outside this project`;
  });
}

// What an fs errno means, in the vocabulary the rest of this surface refuses
// in. A raw fs throw is the commonest way a known cause reaches the wire as
// `failed`: every one of asset.read_text, asset.write_text, asset.rename,
// page.read, page.delete, page.move and source.write answered a missing file
// with `code: 'failed'` and Node's own ENOENT sentence, which is the one code
// a client cannot branch on and the one sentence it cannot show anybody.
const ERRNO_CODES = {
  ENOENT: 'no_file',
  ENOTDIR: 'no_file',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  EROFS: 'permission_denied',
  EISDIR: 'bad_path',
  EEXIST: 'exists',
  EMFILE: 'failed',
};

/**
 * A handler that threw, in the envelope's own vocabulary.
 *
 * `runMain`'s catch is the only thing between a throw and the wire, and it
 * used to answer `{code: 'failed'}` for everything but one git special case —
 * so a cause the handler knew exactly (there is no such file; that is not a
 * collection; something is already there) arrived as the code that means
 * "something went wrong and nobody knows what".
 *
 * THE HANDLERS STILL THROW. They are called by the CMS panel and the Pages
 * panel over IPC as well as by this API, and turning a throw into an in-band
 * `{ok:false}` would change what every one of those callers sees. So the cause
 * rides on the Error instead, as `refusalCode` (electron/main.js's `refuse`),
 * which Electron's IPC serializer drops on the way to a panel — the panel
 * still catches the same throw with the same message — and which arrives
 * intact here, because the Agent API calls the handler function directly.
 */
function thrownFailure(err, ctx) {
  const message = withoutHostPaths(err?.message || err, ctx?.root);
  // What the handler said this is, when it knew.
  const named = typeof err?.refusalCode === 'string' && err.refusalCode ? err.refusalCode : null;
  if (named) return { ok: false, code: named, message };
  // A project that was never `git init`ed is a normal state, not a failure —
  // and an agent told "fatal: not a git repository" will go looking for a
  // bug rather than reading it as "there is no history here".
  if (/not a git repository/i.test(message)) {
    return { ok: false, code: 'no_repo', message: 'This project is not a git repository. Nothing was changed.' };
  }
  // An fs error names its own cause and its own path, and says both in Node's
  // words. Both are rewritten: the errno becomes a code a client can branch
  // on, and the sentence becomes one about the file the caller asked for.
  const errno = typeof err?.code === 'string' ? ERRNO_CODES[err.code] : null;
  if (errno) {
    const rel = relativeTo(ctx?.root, err.path) || relativeTo(ctx?.root, err.dest);
    const what = rel ? rel : 'that path';
    const said =
      errno === 'no_file'
        ? `${what} is not in this project.`
        : errno === 'exists'
          ? `${what} already exists.`
          : errno === 'permission_denied'
            ? `Stacki is not allowed to use ${what} (${err.code}).`
            : `${what} could not be used (${err.code}).`;
    return { ok: false, code: errno, message: rel ? said : message };
  }
  return { ok: false, code: 'failed', message };
}

/** A main-process `{ok:false, …}` said in the envelope's own vocabulary. */
function refusal(raw) {
  const { ok, code, message, error, reason, ...rest } = raw;
  return {
    ...rest,
    ok: false,
    // `stale` is a handler's own word for the guard that fired: the file moved
    // under the offsets it was handed, which is `stale_target` everywhere else
    // in this surface. Anything else it did not name is `failed`, as before.
    code: typeof code === 'string' && code ? code : raw.stale ? 'stale_target' : 'failed',
    message: String(message || error || reason || 'That operation was refused.'),
  };
}

module.exports = {
  runMain,
  // Exported for test/git-envelopes.js, which calls it with the error shapes
  // that reach it — including the ones no fixture can provoke end to end, like
  // a package manager's stderr with somebody's home directory in it.
  thrownFailure,
  resolveContentEntry,
  DOMAINS,
  outlineOf,
  summarizeScan,
  MAX_LIST,
  MAX_TEXT_BYTES,
};
