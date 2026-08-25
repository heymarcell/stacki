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

const problem = (code, message, extra = {}) => ({ error: { ok: false, code, message, ...extra } });

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
    const stale = checkDigest({ expected: input.expectedDigest, actual: before, what: at.rel });
    if (stale) return { error: stale };
    if (before == null && input.expectedDigest != null) {
      return problem('no_file', `There is no ${at.rel} to replace.`);
    }
    await ctx.callMain('src:writeText', { projectPath: ctx.root, rel: at.rel, text: input.text });
    return {
      value: {
        path: at.rel,
        beforeDigest: before,
        afterDigest: digestOf(input.text),
        bytes: Buffer.byteLength(input.text, 'utf8'),
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
    const stale = checkDigest({ expected: input.expectedDigest, actual: before, what: at.rel });
    if (stale) return { error: stale };
    const lines = current.split('\n');
    const from = Number(input.startLine);
    const to = Number(input.endLine ?? input.startLine);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || from > lines.length) {
      return problem('bad_request', `${at.rel} has ${lines.length} lines; ${from}–${to} is not a range in it.`);
    }
    const next = [...lines.slice(0, from - 1), ...String(input.text).split('\n'), ...lines.slice(Math.min(to, lines.length))].join('\n');
    await ctx.callMain('src:writeText', { projectPath: ctx.root, rel: at.rel, text: next });
    return {
      value: {
        path: at.rel,
        beforeDigest: before,
        afterDigest: digestOf(next),
        replacedLines: `${from}-${to}`,
        lines: next.split('\n').length,
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
    result: (raw, _input, ctx) => ({
      file: raw?.path ? relativeTo(ctx.root, raw.path) : null,
      name: raw?.name ?? null,
      text: clip(raw?.text ?? '', MAX_TEXT_BYTES).text,
      startLine: raw?.startLine ?? null,
      endLine: raw?.endLine ?? null,
    }),
  },

  resolve_path: {
    channel: 'src:resolvePath',
    args: (input, ctx) => {
      const from = rel(ctx, input.fromFile, 'file path');
      if (from.error) return from;
      return { projectPath: ctx.root, fromFile: from.abs, spec: input.spec };
    },
    result: (raw, _input, ctx) => ({
      path: raw?.path ? relativeTo(ctx.root, raw.path) : null,
      outsideProject: !!(raw?.path && !relativeTo(ctx.root, raw.path)),
    }),
  },
};

// --- page --------------------------------------------------------------------

const summarizeScan = (raw, ctx, limit = MAX_LIST) => ({
  pages: take(raw?.pages, limit).map((p) => ({
    name: p.name,
    route: p.route,
    path: relativeTo(ctx.root, p.path),
    dynamic: !!p.dynamic,
  })),
  components: take(raw?.components, limit).map((c) => ({
    name: c.name,
    path: relativeTo(ctx.root, c.path),
    slots: c.slots || null,
    props: take(c.props, 40).map((prop) => (typeof prop === 'string' ? prop : prop?.name)).filter(Boolean),
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
    result: (raw, _input, ctx) => ({ path: relativeTo(ctx.root, raw?.path || ''), route: raw?.route ?? null }),
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

  component_create: {
    channel: 'component:create',
    args: (input, ctx) => {
      if (!Array.isArray(input.nodes) || !input.nodes.length) {
        return problem('bad_request', 'component_create needs the nodes to make the component from.');
      }
      return {
        projectPath: ctx.root,
        pagePath: input.fromPage ? path.resolve(ctx.root, input.fromPage) : null,
        name: input.name,
        nodes: input.nodes,
        imports: input.imports || [],
        props: input.props || [],
      };
    },
    result: (raw) => ({ name: raw?.name ?? null, path: raw?.rel ?? null }),
  },

  component_usage: {
    channel: 'component:usage',
    args: (input, ctx) => ({ projectPath: ctx.root, name: input.name, exclude: input.exclude || null }),
    result: (raw, _input, ctx) => ({
      uses: take(raw?.uses || raw, MAX_LIST).map((u) =>
        typeof u === 'string' ? relativeTo(ctx.root, u) || u : { ...u, path: u.path ? relativeTo(ctx.root, u.path) || u.path : null }
      ),
    }),
  },

  dynamic_paths: {
    channel: 'page:dynamicPaths',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'page path');
      if (at.error) return at;
      return { projectPath: ctx.root, pagePath: at.abs, devUrl: ctx.devUrl || null };
    },
    result: (raw) => ({ paths: take(raw?.paths || raw, MAX_LIST), problem: raw?.problem || null }),
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

const content = {
  cms_list: { channel: 'cms:list', args: (_i, ctx) => ctx.root, result: (raw) => ({ files: take(raw?.files || raw, MAX_LIST) }) },
  cms_read: {
    channel: 'cms:read',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'data file');
      if (at.error) return at;
      return { projectPath: ctx.root, rel: at.rel };
    },
  },
  cms_write: {
    channel: 'cms:write',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'data file');
      if (at.error) return at;
      const stale = checkDigest({ expected: input.expectedDigest, actual: digestOfFile(at.abs), what: at.rel });
      if (stale) return { error: stale };
      if (input.data === undefined) return problem('bad_request', 'data is required.');
      return { projectPath: ctx.root, rel: at.rel, data: input.data };
    },
    result: (raw, input, ctx) => ({
      path: input.path,
      afterDigest: digestOfFile(path.resolve(ctx.root, input.path)),
      ...(raw && typeof raw === 'object' ? raw : {}),
    }),
  },
  cms_create: { channel: 'cms:create', args: (input, ctx) => ({ projectPath: ctx.root, name: input.name }) },
  cms_delete: {
    channel: 'cms:delete',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'data file');
      if (at.error) return at;
      return { projectPath: ctx.root, rel: at.rel };
    },
  },
  cms_usage: {
    channel: 'cms:usage',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'data file');
      if (at.error) return at;
      return { projectPath: ctx.root, rel: at.rel };
    },
  },
  cms_meta: { channel: 'cms:meta', args: (_i, ctx) => ctx.root },
  cms_set_meta: {
    channel: 'cms:setMeta',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'data file');
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
        returned: Math.min(list.length, limit),
        total: list.length,
        entries: take(list, limit).map((e) => ({
          id: e.id ?? null,
          slug: e.slug ?? null,
          file: e.rel ?? e.file ?? null,
          data: e.data ?? null,
          // A whole markdown body per entry turns a listing into a book.
          body: e.body == null ? null : clip(e.body, 2000).text,
          digest: e.body != null || e.data != null ? digestOf(JSON.stringify({ data: e.data ?? null, body: e.body ?? null })) : null,
        })),
        truncated: list.length > limit,
      };
    },
  },
  write_entry: {
    channel: 'content:writeEntry',
    args: (input, ctx) => {
      if (!input.entry || typeof input.entry !== 'object') {
        return problem('bad_request', 'entry is required — pass the entry object content.entries reported.');
      }
      return { projectPath: ctx.root, entry: input.entry, edits: input.edits || {}, body: input.body };
    },
  },
  validate: {
    channel: 'content:validate',
    args: (input, ctx) => ({ projectPath: ctx.root, collection: input.collection, data: input.data }),
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
      return { path: input.path, text: body.text, truncated: body.truncated, digest: digestOfFile(path.resolve(ctx.root, input.path)) };
    },
  },
  write_text: {
    channel: 'assets:writeText',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'asset path');
      if (at.error) return at;
      const stale = checkDigest({ expected: input.expectedDigest, actual: digestOfFile(at.abs), what: at.rel });
      if (stale) return { error: stale };
      if (typeof input.text !== 'string') return problem('bad_request', 'text is required.');
      return { projectPath: ctx.root, rel: at.rel, text: input.text };
    },
    result: (_raw, input) => ({ path: input.path, afterDigest: digestOf(input.text) }),
  },
  mkdir: { channel: 'assets:mkdir', args: (input, ctx) => ({ projectPath: ctx.root, parentRel: input.parent, name: input.name }) },
  move: { channel: 'assets:move', args: (input, ctx) => ({ projectPath: ctx.root, fromRel: input.path, toDirRel: input.toFolder }) },
  rename: { channel: 'assets:rename', args: (input, ctx) => ({ projectPath: ctx.root, rel: input.path, newName: input.name }) },
  delete: { channel: 'assets:delete', args: (input, ctx) => ({ projectPath: ctx.root, rel: input.path }) },
};

// --- style (the parts that are files rather than the live cascade) -----------

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
      return { path: input.path, css: body.text, truncated: body.truncated, digest: digestOfFile(path.resolve(ctx.root, input.path)) };
    },
  },
  write_source: {
    channel: 'style:writeFile',
    args: (input, ctx) => {
      const at = rel(ctx, input.path, 'stylesheet path');
      if (at.error) return at;
      const stale = checkDigest({ expected: input.expectedDigest, actual: digestOfFile(at.abs), what: at.rel });
      if (stale) return { error: stale };
      if (typeof input.css !== 'string') return problem('bad_request', 'css is required.');
      return { filePath: at.abs, css: input.css };
    },
    result: (_raw, input) => ({ path: input.path, afterDigest: digestOf(input.css) }),
  },
  variables: {
    channel: 'css:variables',
    args: (_i, ctx) => ctx.root,
    result: (raw, input) => {
      const sections = raw?.sections || raw || [];
      const limit = Math.min(input.limit || 200, MAX_LIST);
      return { file: raw?.file ?? null, sections: take(sections, limit), truncated: sections.length > limit };
    },
  },
  set_variable: { channel: 'css:setVariable', args: (input, ctx) => ({ projectPath: ctx.root, ...input.edit }) },
  add_variables: { channel: 'css:addVariables', args: (input, ctx) => ({ projectPath: ctx.root, adds: input.adds }) },
  rename_variables: { channel: 'css:renameVariables', args: (input, ctx) => ({ projectPath: ctx.root, renames: input.renames }) },
  move_variables: { channel: 'css:moveVariables', args: (input, ctx) => ({ projectPath: ctx.root, moves: input.moves }) },
  add_section: { channel: 'css:addSection', args: (input, ctx) => ({ projectPath: ctx.root, ...input.edit }) },
  set_section_title: { channel: 'css:setSectionTitle', args: (input, ctx) => ({ projectPath: ctx.root, ...input.edit }) },
  remove_section: { channel: 'css:removeSection', args: (input, ctx) => ({ projectPath: ctx.root, ...input.edit }) },
  move_heading: { channel: 'css:moveHeading', args: (input, ctx) => ({ projectPath: ctx.root, ...input.edit }) },
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
  diagnose: { channel: 'dev:diagnose', args: (_i, ctx) => ctx.root },
  probe: { channel: 'dev:probe', args: (input, ctx) => input.url || ctx.devUrl || null },
  dev_start: { channel: 'dev:start', args: (_i, ctx) => ctx.root },
  dev_stop: { channel: 'dev:stop', args: () => undefined },
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
      const body = clip(raw?.text ?? raw ?? '', MAX_TEXT_BYTES);
      return { text: body.text, truncated: body.truncated };
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
      return { projectPath: ctx.root, ref: input.ref, path: at };
    },
  },
  restore_project: { channel: 'git:restoreProject', args: (input, ctx) => ({ projectPath: ctx.root, ref: input.ref }) },
  park: { channel: 'git:park', args: (_i, ctx) => ({ projectPath: ctx.root }) },
  unpark: { channel: 'git:unpark', args: (_i, ctx) => ({ projectPath: ctx.root }) },
  push: { channel: 'git:push', args: (input, ctx) => ({ projectPath: ctx.root, branch: input.branch }) },
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
    return { ok: false, code: 'failed', message: String(err?.message || err) };
  }
  const shaped = entry.result ? entry.result(raw, input, ctx) : raw;
  return { ok: true, ...(shaped && typeof shaped === 'object' && !Array.isArray(shaped) ? shaped : { value: shaped }) };
}

module.exports = { runMain, DOMAINS, outlineOf, summarizeScan, MAX_LIST, MAX_TEXT_BYTES };
