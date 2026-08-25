# Stacki

Visual Builder for Astro.

A Mac & Windows desktop app for editing [Astro](https://astro.build) projects visually.

MIT licensed — fork it, build on it, ship your own version.

## Features

- **Pages** — browse every page in `src/pages`, create new pages (including nested routes like `blog/post-1`), and delete pages.
- **Layouts** — choose which layout from `src/layouts` wraps each page, and edit the layout's props (e.g. `title`).
- **Components** — every component in `src/components` appears in the palette. Drag one into the page structure (or double-click to append), drag to reorder, click ✕ to remove.
- **Props** — the props panel reads each component's `interface Props` / `Astro.props` destructure and generates typed fields (text, number, checkbox). Defaults are shown as placeholders.
- **Live preview** — the app runs `astro dev` for the opened project and embeds it. Edits are auto-saved (300 ms debounce), so Astro's hot reload updates the preview as you type.
- **Git & GitHub** — the branch chip in the title bar shows the current branch and dirty state. From its dropdown you can switch branches, create branches, commit, push, or publish a brand-new repo to GitHub (via the `gh` CLI).
- **Tell an AI what's selected** — **⇧⌘C** copies whatever the canvas has selected as the trail of `file:line-range` pointers that leads to it: the page, each component drilled into on the way down, then the node itself. Paste that into Claude Code or any AI chat that can read the project and it knows exactly which markup you mean.
- **Comments** — press **C** and click anything on the page to leave a comment on it. The comment stays attached
  to that element — at the breakpoint you left it at, and on the copy of it you were looking at — and your coding
  agent can read them, go and look at each one, do the work, and close the loop. See [Comments](#comments).
- **Let an AI see what's selected (MCP)** — Stacki runs a small [MCP](https://modelcontextprotocol.io)
  server, so Claude Code, Cursor or any MCP client can ask what you have selected on the canvas, where it is
  in source, and what it actually looks like. See [Connecting an AI agent](#connecting-an-ai-agent-mcp).
- **Code fallback** — pages with markup too complex for the visual model open in a code editor instead, still with live preview.
- **New project** — "New Project…" scaffolds a minimal Astro starter (layout + 5 components + home page) and runs `npm install` for you.

## Running in development

```bash
npm install
npm run dev
```

`npm run dev` starts Vite (renderer hot reload) and launches Electron against it.

To run against a production build of the UI:

```bash
npm start
```

## Packaging installers

If you're building for yourself or from a fork, use the unsigned build — it
needs no Apple Developer account and no certificates:

```bash
npm run dist:mac:unsigned   # .dmg + .zip, no signing (build on macOS)
npm run dist:win            # NSIS installer (build on Windows)
```

Output lands in `release/`. macOS will warn the first time you open an
unsigned build; right-click the app and choose Open to get past Gatekeeper.

The signed variants are for maintainers with the release certificates:

```bash
npm run dist:mac   # requires a Developer ID cert + notarization credentials
```

## Releases

Official builds are published by CI, not from anyone's laptop. Pushing a
`v*` tag runs `.github/workflows/release.yml`, which builds a signed and
notarized macOS universal build plus a Windows installer, uploads them to
the `stacki-releases` repo, and only makes the release visible once both
platforms have landed. Shipped apps auto-update from that feed via
`electron-updater`.

Signing and notarization credentials live in GitHub Actions secrets. They
are never in this repository, and GitHub does not expose them to workflows
triggered from forks — so a fork can build and run everything here, but
cannot produce a build signed with the official identity. That's intended.

If you fork this and publish your own builds, change `build.appId` and
`build.publish` in `package.json` to your own identifiers so your releases
don't collide with the official update feed.

## Contributing

Issues and pull requests are welcome. A few notes:

- `npm run dev` is all you need for day-to-day work — no credentials required.
- Please don't add workflows that use `pull_request_target`, or any workflow
  that exposes secrets to code from a fork.
- Report security issues privately to the maintainer rather than opening a
  public issue.

## Comments

Review the site the way you look at it, and leave the feedback where you saw it.

| | |
| --- | --- |
| **C** | comment mode — the next click on the page picks what to comment on |
| **⇧C** | show or hide the pins |
| **Esc** | close the composer; again to leave comment mode |
| **⌘↩** | post the comment you are writing |

Both letters are ignored while you are typing in a field, the code editor or the
terminal. The **Comments** panel in the left rail lists them, filtered by state
and by whether they are on the page you are looking at.

Every comment gets a short number — **#3** — shown on its pin, on its row and in
what an agent reads back, so "fix #3" means one thing to both of you. A pin with
several comments under it shows the first number and how many more. Drag a
comment's header to push it aside when it is covering the thing it is about; the
pin stays where it is, and the panel goes back on its own next time.

A comment is not a sticky note on a screenshot. It is anchored to the same
source-backed node **⇧⌘C** copies and `get_context` reports — through every
component you had drilled into — together with the breakpoint you were at, which
copy of a repeated node you clicked, and a frozen snapshot of what the element
was at the time. Ordinary edits move lines and regenerate ids; the comment
follows.

**Three states, and that is all.** *Open* still wants something. *Resolved*
means a decision was reached — implemented and verified, or deliberately left
as it is. *Deferred* means valid, but not now: a reason, and optionally a link
to wherever it is tracked instead.

**Orphaned is not a state.** If the element is deleted, or changed past
recognising, the comment says so separately and points at nothing rather than at
something that looks similar. It still shows what you said, which page, which
component, and what the element was — so it stays readable, and you can still
reply to it, resolve it, defer it or delete it.

Comments are **local and yours**. They live in Stacki's own application-support
directory — one file per project, keyed by the project folder's real path — and
nothing is ever written into the website's repository. There is no account, no
server and nobody else's cursor.

The branch you were on is **recorded on the comment, not used to file it**:
checking out another branch does not give you a second list, and does not hide
the first. What changes is the anchor. Stacki re-resolves it conservatively —
the same position, or exactly one node of the same kind under the same
ancestors — and where it cannot be sure it reports *orphaned* rather than
attaching to something that merely looks similar.

A comment's **number is permanent**. It is assigned once, never reused, and
never renumbered by deleting, filtering, sorting or restarting — so `#3` means
the same comment tomorrow as it does now, to you and to your agent.

### Letting an agent work through them

> "Process my Stacki comments. Implement what you can, visually verify every
> change, resolve what you finish. If something is valid but out of scope,
> open an issue and defer the comment with the link. If something needs my
> decision, defer it and say why."

The agent reads them with `get_comments`, calls `comment` with `action: "focus"`
so Stacki navigates to each one — the page, the breakpoint, the components, the
element, the copy — then uses `get_context` and `capture` to see it, edits the
source with its **own** normal tools, lets Stacki refresh, captures again to
check its work, and resolves or defers.

Stacki has no GitHub integration and no credentials. When an agent files an
issue it does so with its own tooling and hands the URL back as a string:

```
comment(action: "defer", threadId: "…", reason: "Tracked separately.",
        externalRef: "https://github.com/you/site/issues/418")
```

Stacki stores the text. It never fetches it.

**Limits.** One reviewer, one machine — no sharing, sync or export yet, and one
Stacki window per project at a time (two would each hold the same file open). A
comment on a component's internals can only be checked against the source while
that file is open or when it is focused; until then it keeps the health it last
had. Screenshots taken with `capture` never include pins, the composer or any
other editor chrome — they are pictures of the site.

## Connecting an AI agent (MCP)

Stacki exposes what it is showing over the [Model Context Protocol](https://modelcontextprotocol.io),
so a coding agent can stop guessing which element you mean.

The split is deliberate:

> **Stacki is the eyes. Your agent is the brain and the hands.**

There are exactly four tools:

| Tool | Answers |
| --- | --- |
| `get_context` | What is selected: the page and breakpoint on screen, the tag, the rendered classes, the box and spacing, the essential computed styles, and the `file:line` trail that leads to it through every component drilled into on the way down. |
| `capture` | A picture of it: the selected element (the selected copy of a repeated node, scrolled into view, with Stacki's own outlines and comment pins hidden) or the whole preview viewport. |
| `get_comments` | Your [comments](#comments), filtered by state (`open` by default) and scope, as compact rows or in full. |
| `comment` | One action at a time: `focus` (send Stacki to a comment's target), `create`, `reply`, `resolve`, `defer`, `reopen`. A comment is named by its id or by its short number — `"#3"` and `"3"` both work. |

The first three are read-only. `comment` writes exactly two things: Stacki's own
local comment file, and where Stacki is looking. There is no `delete` — an agent
that disagrees with a comment resolves it and says why, which leaves you able to
disagree back.

Nothing here edits your project. Your agent keeps using its normal file tools;
Stacki just tells it what you are pointing at, what the result looks like, and
what you asked for.

Stacki does not have to be the window you are looking at — a capture taken while
it sits behind your terminal is the current render, not the last one you saw.
(One exception: while Stacki is *minimised*, the previewed page renders in a
frame the OS has stopped drawing, so the picture may be older than the page.
`capture` says so when that happens.)

### The endpoint

    http://127.0.0.1:43821/mcp

It binds to loopback only, validates `Host` and `Origin` (so a web page cannot
reach it by resolving its own domain to 127.0.0.1), sends no CORS headers, and
requires a bearer token. The token is generated once and stored in Stacki's own
application-support directory — never in your project, never in git.

`STACKI_MCP_PORT` moves the port; `STACKI_MCP=off` turns the server off. If the
port is taken, Stacki says so rather than quietly moving somewhere else.

### Connecting

**File ▸ AI Connection (MCP)…** shows whether the server is running, the
endpoint, and a ready-made config for Claude Code or Cursor with the token
filled in. Copy it from there rather than typing it — and don't commit it.

Claude Code:

```bash
claude mcp add --transport http --scope user stacki \
  http://127.0.0.1:43821/mcp \
  --header "Authorization: Bearer <token>"
```

Cursor — `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "stacki": {
      "url": "http://127.0.0.1:43821/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Both are shown at user/global scope on purpose: Stacki switches between
projects, and the endpoint does not.

## Requirements

- Node.js 18+ and npm (the app shells out to `npm install` / `astro dev` for opened projects)
- `git` for version control features
- [GitHub CLI](https://cli.github.com) (`gh`), authenticated via `gh auth login`, for "Publish to GitHub"

## How editing works

Pages are parsed into a simple model: optional layout wrapper + a flat list of
self-closing component instances with props. The editor writes that model back
as clean `.astro` source. Pages containing arbitrary HTML, expressions, or
nested children fall back to the built-in code editor — nothing is ever
rewritten destructively.
