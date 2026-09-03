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
    const lines = text.split('\n');
    const from = Math.max(1, input.startLine || 1);
    const to = Math.min(lines.length, input.endLine || Math.min(lines.length, from + MAX_SNIPPET_LINES - 1));
    const slice = input.startLine || input.endLine ? lines.slice(from - 1, to).join('\n') : text;
    const body = clip(slice, MAX_TEXT_BYTES);
    return {
      value: {
        path: at.rel,
        // Hand back a ref as well as the digest. The ref carries the digest in
        // its signature, so the write that follows this read is guarded by
        // passing it back — with nothing for a caller to copy or forget.
        ref: refFor(ctx, at.rel),
        // The digest is of the WHOLE file however much of it was read, because
        // that is what a write will be checked against.
        digest: digestOf(text),
        lines: lines.length,
        startLine: input.startLine || input.endLine ? from : 1,
        endLine: input.startLine || input.endLine ? to : lines.length,
        text: body.text,
        truncated: body.truncated,
        bytes: Buffer.byteLength(text, 'utf8'),
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
    const lines = current.split('\n');
    const from = Number(input.startLine);
    const to = Number(input.endLine ?? input.startLine);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || from > lines.length) {
      return problem('bad_request', `${at.rel} has ${lines.length} lines; ${from}–${to} is not a range in it.`);
    }
    const next = [...lines.slice(0, from - 1), ...String(input.text).split('\n'), ...lines.slice(Math.min(to, lines.length))].join('\n');
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
    result: (raw, input) =>
      raw?.ok === false
        ? problem('not_found', `${input?.spec} could not be read${raw.reason ? `: ${raw.reason}` : ''}.`)
        : {
            file: raw?.rel ? toPosix(raw.rel) : null,
            name: input?.name ?? null,
            text: clip(raw?.text ?? '', MAX_TEXT_BYTES).text,
            line: Number.isInteger(raw?.line) ? raw.line : null,
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
 * project root. There is no path by which a client string becomes a filesystem
 * path.
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
    args: (input, ctx) => ({ projectPath: ctx.root, name: input.collection, from: input.from, to: input.to }),
  },
  rename: {
    channel: 'content:rename',
    args: (input, ctx) => ({ projectPath: ctx.root, name: input.collection, from: input.from, to: input.to }),
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
    result: (raw, input) => {
      const files = raw?.files || [];
      const limit = Math.min(input.limit || 200, MAX_LIST);
      return {
        // One entry per stylesheet that declares custom properties, with the
        // sections the Variables panel shows. `values` is every name in the
        // project resolved to its value, which is what a caller actually wants
        // when it is chasing a var() it found in a declaration.
        files: take(files, limit).map((f) => ({
          path: f.rel,
          name: f.name,
          error: f.error || null,
          count: f.count ?? null,
          groups: take(f.groups, 60),
        })),
        values: raw?.values || {},
        truncated: files.length > limit,
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
    result: (raw) => ({
      kind: raw?.kind ?? 'unknown',
      nodeFound: !!raw?.nodePath,
      nodeVersion: raw?.nodeVersion ?? null,
      astroVersion: raw?.astroVersion ?? null,
      requires: raw?.requires ?? null,
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
  },
  checkout: {
    channel: 'git:checkout',
    args: (input, ctx) => ({ projectPath: ctx.root, branch: input.branch, create: !!input.create, parkFirst: input.parkFirst !== false }),
  },
  merge: { channel: 'git:merge', args: (input, ctx) => ({ projectPath: ctx.root, branch: input.branch }) },
  resolve_merge: { channel: 'git:resolveMerge', args: (input, ctx) => ({ projectPath: ctx.root, branch: input.branch, choices: input.choices || {} }) },
  delete_branch: { channel: 'git:deleteBranch', args: (input, ctx) => ({ projectPath: ctx.root, branch: input.branch, force: !!input.force }) },
  restore_file: {
    channel: 'git:restoreFile',
    args: (input, ctx) => {
      const at = gitPath(input, ctx);
      if (at.error) return at;
      // "PUT THIS FILE BACK" means "back to the last commit" unless it says
      // otherwise, which is what the panel's own restore does.
      return { projectPath: ctx.root, ref: input.ref || 'HEAD', path: at };
    },
  },
  restore_project: { channel: 'git:restoreProject', args: (input, ctx) => ({ projectPath: ctx.root, ref: input.ref }) },
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
  },
  publish: {
    channel: 'git:publish',
    args: (input, ctx) => ({ projectPath: ctx.root, repoName: input.repoName, isPrivate: input.private !== false }),
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
    const out = await entry(input, ctx);
    if (out?.error) return out.error;
    return { ok: true, ...(out?.value || {}) };
  }
  const built = await entry.args(input, ctx);
  if (built?.error) return built.error;
  let raw;
  try {
    raw = await ctx.callMain(entry.channel, built);
  } catch (err) {
    const message = String(err?.message || err);
    // A project that was never `git init`ed is a normal state, not a failure —
    // and an agent told "fatal: not a git repository" will go looking for a
    // bug rather than reading it as "there is no history here".
    if (/not a git repository/i.test(message)) {
      return { ok: false, code: 'no_repo', message: 'This project is not a git repository. Nothing was changed.' };
    }
    return { ok: false, code: 'failed', message };
  }
  const shaped = entry.result ? entry.result(raw, input, ctx) : raw;
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
  return { ok: true, ...(shaped && typeof shaped === 'object' && !Array.isArray(shaped) ? shaped : { value: shaped }) };
}

module.exports = { runMain, resolveContentEntry, DOMAINS, outlineOf, summarizeScan, MAX_LIST, MAX_TEXT_BYTES };
