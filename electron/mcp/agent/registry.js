// Every operation the Agent API has, in one table.
//
// This file is the answer to "what can an agent do, and what does it cost if
// it is wrong". Three things read it and none of them has an opinion of its
// own:
//
//   the gate      looks up `risk` before dispatching anything.
//   the dispatcher looks up `via` to decide whether an operation is answered
//                 here, in the renderer, or by the main-process handler that
//                 the panels already call.
//   get_capabilities and docs/agent-api-coverage.md are generated from it, so
//                 the documentation cannot drift from the surface.
//
// `channel` names the IPC handler an operation reuses. That is deliberately an
// implementation detail: no MCP tool takes a channel, the client never sees
// one, and only what is written here is reachable. The point of naming it is
// that there is exactly one implementation of "create a page" and both the
// Pages panel and this go through it.
//
// The second table, EXCLUDED, is the other half of the same inventory: every
// project-semantic thing Stacki can do that an agent deliberately cannot, and
// why. A capability missing from both tables is an oversight, and the coverage
// test says so.

// --- what an agent can do ----------------------------------------------------

/**
 * @typedef {object} Operation
 * @property {'read'|'write'|'high'} risk   what it costs if it is wrong
 * @property {'renderer'|'main'|'local'} via where it is carried out
 * @property {string} [channel]             the existing handler it reuses
 * @property {string} summary               one line, for capabilities and docs
 * @property {boolean} [undoable]           lands on Stacki's own undo stack
 * @property {string} [reuses]              the module or code path behind it
 */

const OPERATIONS = {
  target: {
    read: {
      risk: 'read',
      via: 'renderer',
      summary: 'Everything Stacki knows about one editor object: source trail, props, classes, bindings, styles, occurrence.',
      reuses: 'src/agent/targetRead.js over the live editor model',
    },
    select: {
      risk: 'read',
      via: 'renderer',
      summary: 'Select a target in Stacki, so get_context and capture describe it.',
      reuses: 'App.jsx selection + occurrence request',
    },
    enter: {
      risk: 'read',
      via: 'renderer',
      summary: "Open a component instance and read inside its own file — what a double-click does.",
      reuses: 'App.jsx openComponent',
    },
    exit: {
      risk: 'read',
      via: 'renderer',
      summary: 'Come back out of a component to whatever contains it.',
      reuses: 'App.jsx closeComponent',
    },
    edit: {
      risk: 'write',
      via: 'renderer',
      undoable: true,
      summary: 'Several operations on one target as a single undo step, all validated before any is applied.',
      reuses: 'src/modelOps.js through App.jsx mutateModel',
    },
    set_text: { risk: 'write', via: 'renderer', undoable: true, summary: "Replace a node's own text.", reuses: 'src/modelOps.js setText' },
    set_prop: { risk: 'write', via: 'renderer', undoable: true, summary: 'Set one prop or attribute.', reuses: 'src/modelOps.js setProp' },
    remove_prop: { risk: 'write', via: 'renderer', undoable: true, summary: 'Remove a prop or attribute.', reuses: 'src/modelOps.js setProp' },
    set_classes: { risk: 'write', via: 'renderer', undoable: true, summary: "Replace the element's class list.", reuses: 'src/classAttr.js' },
    add_class: { risk: 'write', via: 'renderer', undoable: true, summary: 'Add one class.', reuses: 'src/classAttr.js withClass' },
    remove_class: { risk: 'write', via: 'renderer', undoable: true, summary: 'Remove one class.', reuses: 'src/classAttr.js' },
    insert_before: { risk: 'write', via: 'renderer', undoable: true, summary: 'Insert a new node before the target.', reuses: 'src/modelOps.js insertIntoModel' },
    insert_after: { risk: 'write', via: 'renderer', undoable: true, summary: 'Insert a new node after the target.', reuses: 'src/modelOps.js insertIntoModel' },
    append_child: { risk: 'write', via: 'renderer', undoable: true, summary: "Insert a new node as the target's last child.", reuses: 'src/modelOps.js insertIntoModel' },
    remove: { risk: 'write', via: 'renderer', undoable: true, summary: 'Delete the target, its note, and frontmatter nothing else reads.', reuses: 'src/modelOps.js removeNode' },
    duplicate: { risk: 'write', via: 'renderer', undoable: true, summary: 'Copy the target in beside itself.', reuses: 'src/modelOps.js duplicateNode' },
    move: { risk: 'write', via: 'renderer', undoable: true, summary: 'Move the target somewhere else in the tree.', reuses: 'src/modelOps.js moveNode' },
    set_tag: { risk: 'write', via: 'renderer', undoable: true, summary: "Change an element's tag, keeping the attributes the new tag understands.", reuses: 'src/modelOps.js setTag' },
  },

  style: {
    read: {
      risk: 'read',
      via: 'renderer',
      summary: 'Every declaration reaching a target, with its selector, source ref, authored and computed value.',
      reuses: 'src/style-panel/lib (css, cascade, resolved, selectors)',
    },
    list_sources: { risk: 'read', via: 'renderer', summary: 'The stylesheets and <style> blocks that style this page.', reuses: 'src/style-panel/lib/webflow.ts styleSources' },
    set_property: { risk: 'write', via: 'renderer', undoable: true, summary: 'Set one CSS property in an authored rule, or in a rule chosen for it.', reuses: 'src/style-panel/lib/css.ts + writeEmbedDoc' },
    remove_property: { risk: 'write', via: 'renderer', undoable: true, summary: 'Remove one authored declaration.', reuses: 'src/style-panel/lib/css.ts removeDeclaration' },
    set_declarations: { risk: 'write', via: 'renderer', undoable: true, summary: 'Set several properties on one rule in a single step.', reuses: 'src/style-panel/lib/css.ts' },
    read_source: { risk: 'read', via: 'main', channel: 'style:readFile', summary: 'A stylesheet as text.', reuses: 'electron/main.js style:readFile' },
    write_source: { risk: 'write', via: 'main', channel: 'style:writeFile', undoable: true, summary: 'Replace a stylesheet.', reuses: 'electron/main.js style:writeFile' },
    variables: { risk: 'read', via: 'main', channel: 'css:variables', summary: 'The project CSS custom properties, in their sections.', reuses: 'electron/cssVars.js' },
    set_variable: { risk: 'write', via: 'main', channel: 'css:setVariable', undoable: true, summary: "Change a variable's value or name.", reuses: 'electron/cssVars.js' },
    add_variables: { risk: 'write', via: 'main', channel: 'css:addVariables', undoable: true, summary: 'Add variables to a section.', reuses: 'electron/cssVars.js' },
    rename_variables: { risk: 'write', via: 'main', channel: 'css:renameVariables', undoable: true, summary: 'Rename variables and every reference to them.', reuses: 'electron/cssVars.js' },
    move_variables: { risk: 'write', via: 'main', channel: 'css:moveVariables', undoable: true, summary: 'Move variables between sections.', reuses: 'electron/cssVars.js' },
    add_section: { risk: 'write', via: 'main', channel: 'css:addSection', undoable: true, summary: 'Add a variable section.', reuses: 'electron/cssVars.js' },
    set_section_title: { risk: 'write', via: 'main', channel: 'css:setSectionTitle', undoable: true, summary: 'Retitle a variable section.', reuses: 'electron/cssVars.js' },
    // `write`, not `high`, and the registry itself said so: it is marked
    // undoable, and "high" means put-it-back is not obviously available. Text
    // removed from a stylesheet that Stacki records an undo command for is the
    // same kind of thing as target.remove, which is a write. Classing it high
    // also made the whole `style` tool destructive to a client — for an action
    // nobody uses, over the read that everybody does.
    remove_section: { risk: 'write', via: 'main', channel: 'css:removeSection', undoable: true, summary: 'Remove a variable section and the variables in it.', reuses: 'electron/cssVars.js' },
    move_heading: { risk: 'write', via: 'main', channel: 'css:moveHeading', undoable: true, summary: 'Reorder variable sections.', reuses: 'electron/cssVars.js' },
  },

  source: {
    read: { risk: 'read', via: 'main', direct: true, uses: ['src:readText'], summary: 'A project file as text, whole or by line range.', reuses: 'read here, so a line range and a digest come back in one answer' },
    read_symbol: { risk: 'read', via: 'main', channel: 'src:readSymbol', summary: 'The source an imported symbol is defined in.', reuses: 'electron/main.js src:readSymbol' },
    resolve_path: { risk: 'read', via: 'main', channel: 'src:resolvePath', summary: 'What an import specifier resolves to.', reuses: 'electron/main.js src:resolvePath' },
    replace_range: { risk: 'write', via: 'main', direct: true, uses: ['src:writeText'], summary: 'Replace a line range, against an expected digest.', reuses: 'electron/main.js src:writeText' },
    write: { risk: 'write', via: 'main', direct: true, uses: ['src:writeText'], summary: 'Replace a whole file, against an expected digest.', reuses: 'electron/main.js src:writeText' },
  },

  page: {
    list: { risk: 'read', via: 'main', channel: 'project:scan', summary: 'Pages, components and layouts in the project.', reuses: 'electron/main.js project:scan' },
    read: { risk: 'read', via: 'main', channel: 'page:read', summary: "A page or component's model, imports and structure.", reuses: 'electron/astroParser.js parsePage' },
    create: { risk: 'write', via: 'main', channel: 'page:create', summary: 'Create a page, optionally wrapped in a layout.', reuses: 'electron/main.js page:create' },
    delete: { risk: 'high', via: 'main', channel: 'page:delete', summary: 'Delete a page file.', reuses: 'electron/main.js page:delete' },
    move: { risk: 'write', via: 'main', channel: 'page:move', summary: 'Move or rename a page, rewriting its imports.', reuses: 'electron/main.js page:move' },
    folder_create: { risk: 'write', via: 'main', channel: 'pagefolder:create', summary: 'Create a page folder.', reuses: 'electron/main.js pagefolder:create' },
    folder_rename: { risk: 'write', via: 'main', channel: 'pagefolder:rename', summary: 'Rename a page folder and rebase what it holds.', reuses: 'electron/main.js pagefolder:rename' },
    folder_delete: { risk: 'high', via: 'main', channel: 'pagefolder:delete', summary: 'Delete a page folder and the pages in it.', reuses: 'electron/main.js pagefolder:delete' },
    component_create: { risk: 'write', via: 'main', channel: 'component:create', summary: 'Create a component file.', reuses: 'electron/componentFile.js' },
    component_usage: { risk: 'read', via: 'main', channel: 'component:usage', summary: 'Where a component is used.', reuses: 'electron/componentUsage.js' },
    dynamic_paths: { risk: 'read', via: 'main', channel: 'page:dynamicPaths', summary: 'The routes a dynamic page renders.', reuses: 'electron/main.js page:dynamicPaths' },
    injected_routes: { risk: 'read', via: 'main', channel: 'project:injectedRoutes', summary: 'Routes injected by integrations.', reuses: 'electron/injectedRoutes.js' },
    import_path: { risk: 'read', via: 'main', channel: 'page:importPathFor', summary: 'How one file should import another.', reuses: 'electron/main.js page:importPathFor' },
    rebase_import: { risk: 'read', via: 'main', channel: 'page:rebaseImport', summary: 'What an import becomes when its file moves.', reuses: 'electron/main.js page:rebaseImport' },
  },

  content: {
    cms_list: { risk: 'read', via: 'main', channel: 'cms:list', summary: 'The JSON data files under src/.', reuses: 'electron/main.js cms:list' },
    cms_read: { risk: 'read', via: 'main', channel: 'cms:read', summary: 'One data file, with its inferred schema.', reuses: 'electron/main.js cms:read' },
    cms_write: { risk: 'write', via: 'main', channel: 'cms:write', undoable: true, summary: 'Replace a data file.', reuses: 'electron/main.js cms:write' },
    cms_create: { risk: 'write', via: 'main', channel: 'cms:create', summary: 'Create a data file.', reuses: 'electron/main.js cms:create' },
    cms_delete: { risk: 'high', via: 'main', channel: 'cms:delete', summary: 'Delete a data file.', reuses: 'electron/main.js cms:delete' },
    cms_usage: { risk: 'read', via: 'main', channel: 'cms:usage', summary: 'Which pages read a data file.', reuses: 'electron/cmsRefs.js' },
    cms_meta: { risk: 'read', via: 'main', channel: 'cms:meta', summary: 'Field presentation stored for the CMS panel.', reuses: 'electron/main.js cms:meta' },
    cms_set_meta: { risk: 'write', via: 'main', channel: 'cms:setMeta', summary: 'Set field presentation for the CMS panel.', reuses: 'electron/main.js cms:setMeta' },
    config: { risk: 'read', via: 'main', channel: 'content:config', summary: "The project's content collection configuration.", reuses: 'electron/contentConfig.js' },
    collections: { risk: 'read', via: 'main', channel: 'content:collections', summary: 'Content collections and their schemas.', reuses: 'electron/contentConfig.js' },
    entries: { risk: 'read', via: 'main', channel: 'content:entries', summary: 'The entries in a collection.', reuses: 'electron/contentEntries.js' },
    write_entry: { risk: 'write', via: 'main', channel: 'content:writeEntry', summary: 'Write fields and body of an entry.', reuses: 'electron/contentEntries.js' },
    validate: { risk: 'read', via: 'main', channel: 'content:validate', summary: 'Check data against a collection schema.', reuses: 'electron/contentConfig.js' },
    targets: { risk: 'read', via: 'main', channel: 'content:targets', summary: 'Where a collection may be written.', reuses: 'electron/contentEntries.js' },
    rename_plan: { risk: 'read', via: 'main', channel: 'content:renamePlan', summary: 'What renaming an entry would touch.', reuses: 'electron/contentRefs.js' },
    rename: { risk: 'write', via: 'main', channel: 'content:rename', summary: 'Rename an entry and every reference to it.', reuses: 'electron/contentRefs.js' },
    sample_entry: { risk: 'read', via: 'main', channel: 'content:sampleEntry', summary: 'One rendered entry, for shape.', reuses: 'electron/main.js content:sampleEntry' },
    resolve_import: { risk: 'read', via: 'main', channel: 'project:resolveImport', summary: 'What an import in a page points at.', reuses: 'electron/main.js project:resolveImport' },
  },

  asset: {
    list: { risk: 'read', via: 'main', channel: 'assets:list', summary: 'Files under public/ and src/.', reuses: 'electron/main.js assets:list' },
    dimensions: { risk: 'read', via: 'main', channel: 'assets:dimensions', summary: 'Pixel size of an image.', reuses: 'electron/main.js assets:dimensions' },
    read_text: { risk: 'read', via: 'main', channel: 'assets:readText', summary: 'A text asset.', reuses: 'electron/main.js assets:readText' },
    write_text: { risk: 'write', via: 'main', channel: 'assets:writeText', summary: 'Replace a text asset.', reuses: 'electron/main.js assets:writeText' },
    mkdir: { risk: 'write', via: 'main', channel: 'assets:mkdir', summary: 'Create an asset folder.', reuses: 'electron/main.js assets:mkdir' },
    move: { risk: 'write', via: 'main', channel: 'assets:move', undoable: true, summary: 'Move an asset into another folder.', reuses: 'electron/main.js assets:move' },
    rename: { risk: 'write', via: 'main', channel: 'assets:rename', undoable: true, summary: 'Rename an asset.', reuses: 'electron/main.js assets:rename' },
    delete: { risk: 'high', via: 'main', channel: 'assets:delete', summary: 'Delete an asset.', reuses: 'electron/main.js assets:delete' },
  },

  project: {
    info: { risk: 'read', via: 'local', summary: 'The open project, its branch, the preview, and this API’s permission mode.' },
    scan: { risk: 'read', via: 'main', channel: 'project:scan', summary: 'Pages, components, layouts, styles and prop schemas.', reuses: 'electron/main.js project:scan' },
    classes: { risk: 'read', via: 'main', channel: 'project:classes', summary: 'Every class name used in the project.', reuses: 'electron/main.js project:classes' },
    dependencies: { risk: 'read', via: 'main', channel: 'project:hasNodeModules', summary: 'Whether dependencies are installed.', reuses: 'electron/main.js project:hasNodeModules' },
    install: { risk: 'high', via: 'main', channel: 'project:install', summary: 'Install dependencies — runs package tooling and reaches the network.', reuses: 'electron/main.js project:install' },
    diagnose: { risk: 'read', via: 'main', channel: 'dev:diagnose', summary: 'Why the dev server will or will not start.', reuses: 'electron/main.js dev:diagnose' },
    probe: { risk: 'read', via: 'main', channel: 'dev:probe', summary: 'Whether a preview URL answers.', reuses: 'electron/devProbe.js' },
    dev_status: { risk: 'read', via: 'renderer', summary: 'What the preview is doing right now.', reuses: 'App.jsx devStatus' },
    dev_start: { risk: 'write', via: 'main', channel: 'dev:start', summary: "Start the project's dev server (Stacki normally does this itself).", reuses: 'electron/main.js dev:start' },
    dev_stop: { risk: 'write', via: 'main', channel: 'dev:stop', summary: 'Stop the dev server.', reuses: 'electron/main.js dev:stop' },
    undo: { risk: 'write', via: 'renderer', undoable: true, summary: "Undo the last step on Stacki's own stack.", reuses: 'App.jsx undo' },
    redo: { risk: 'write', via: 'renderer', undoable: true, summary: 'Redo the last undone step.', reuses: 'App.jsx redo' },
  },

  git: {
    info: { risk: 'read', via: 'main', channel: 'git:info', summary: 'Branch, remote, dirtiness, ahead/behind.', reuses: 'electron/main.js git:info' },
    status: { risk: 'read', via: 'main', channel: 'git:status', summary: 'Working-tree status.', reuses: 'electron/gitHistory.js' },
    log: { risk: 'read', via: 'main', channel: 'git:log', summary: 'Commit history.', reuses: 'electron/gitHistory.js' },
    commit_files: { risk: 'read', via: 'main', channel: 'git:commitFiles', summary: 'What one commit touched.', reuses: 'electron/gitHistory.js' },
    all_files: { risk: 'read', via: 'main', channel: 'git:allFiles', summary: 'Every tracked file.', reuses: 'electron/gitHistory.js' },
    file_at: { risk: 'read', via: 'main', channel: 'git:fileAt', summary: 'A file as it was at a revision.', reuses: 'electron/gitHistory.js' },
    worktrees: { risk: 'read', via: 'main', channel: 'git:worktrees', summary: 'Branches, and which are checked out elsewhere.', reuses: 'electron/gitHistory.js' },
    gh_status: { risk: 'read', via: 'main', channel: 'git:ghStatus', summary: 'Whether the GitHub CLI is available and signed in.', reuses: 'electron/main.js git:ghStatus' },
    init: { risk: 'high', via: 'main', channel: 'git:init', summary: 'Make the project a repository.', reuses: 'electron/main.js git:init' },
    commit: { risk: 'high', via: 'main', channel: 'git:commit', summary: 'Commit the working tree.', reuses: 'electron/gitSnapshot.js' },
    checkout: { risk: 'high', via: 'main', channel: 'git:checkout', summary: 'Switch or create a branch — rewrites the working tree.', reuses: 'electron/gitBranches.js' },
    merge: { risk: 'high', via: 'main', channel: 'git:merge', summary: 'Merge a branch.', reuses: 'electron/gitBranches.js' },
    resolve_merge: { risk: 'high', via: 'main', channel: 'git:resolveMerge', summary: 'Finish a conflicted merge.', reuses: 'electron/conflicts.js' },
    delete_branch: { risk: 'high', via: 'main', channel: 'git:deleteBranch', summary: 'Delete a branch.', reuses: 'electron/gitBranches.js' },
    restore_file: { risk: 'high', via: 'main', channel: 'git:restoreFile', summary: 'Put one file back to a revision.', reuses: 'electron/gitSnapshot.js' },
    restore_project: { risk: 'high', via: 'main', channel: 'git:restoreProject', summary: 'Put the whole tree back to a revision, parking what is there.', reuses: 'electron/gitSnapshot.js' },
    park: { risk: 'high', via: 'main', channel: 'git:park', summary: 'Set uncommitted work aside.', reuses: 'electron/gitBranches.js park' },
    unpark: { risk: 'high', via: 'main', channel: 'git:unpark', summary: 'Bring parked work back.', reuses: 'electron/gitBranches.js unpark' },
    push: { risk: 'high', via: 'main', channel: 'git:push', summary: 'Push to origin — reaches the network.', reuses: 'electron/main.js git:push' },
    publish: { risk: 'high', via: 'main', channel: 'git:publish', summary: 'Create a GitHub repository and push to it — reaches the network.', reuses: 'electron/main.js git:publish' },
  },
};

// --- and what it deliberately cannot -----------------------------------------
//
// The other half of the inventory. Each of these is something Stacki does that
// an agent has no tool for, with the reason it has none. "It did not occur to
// us" is not one of the reasons, which is the point of writing the list down.

const EXCLUDED = [
  // Native chrome and the operating system.
  { channels: ['project:openDialog', 'project:newDialog', 'project:parentDialog'], why: 'human-only', reason: 'Native folder and file pickers. An agent cannot see one, and which project is open is the person’s decision to make.' },
  { channels: ['assets:pickUpload'], why: 'human-only', reason: 'A native picker over the whole filesystem — the one door in Stacki that reaches outside the open project, and it opens only for a person.' },
  { channels: ['assets:upload'], why: 'human-only', reason: 'Copies files in from anywhere on the machine. Its input is a picker result or a drag, neither of which an agent has.' },
  { channels: ['shell:openExternal'], why: 'human-only', reason: 'Opens a browser on this machine. An agent that wants a page read has its own way to fetch one.' },
  { channels: ['native:copy', 'native:paste', 'native:undo', 'native:redo'], why: 'human-only', reason: 'The operating system’s edit menu acting on whichever text field has focus. project.undo is the editor’s own stack, which is the one that means something here.' },
  { channels: ['settings:get'], why: 'redundant', reason: 'Application preferences — the sound setting, and this API’s own permission mode, which get_capabilities already reports.' },
  { channels: ['settings:setAgentMode', 'settings:agentAccess'], why: 'human-only', reason: 'How much of Stacki an agent may move, and what it currently is. An agent that could raise its own permission level would not have one; get_capabilities tells it what it has.' },

  // A second shell is a second trust surface and no new ability.
  { channels: ['terminal:start', 'terminal:resize', 'terminal:close'], why: 'unsafe', reason: 'An agent connected to Stacki already has its own shell. A second one behind this endpoint would widen what a stolen token is worth and buy nothing visual.' },

  // Project creation and scaffolding.
  { channels: ['project:scaffold', 'project:createAstro', 'project:createStarter'], why: 'human-only', reason: 'Creating a project decides where it lives on disk and runs the Astro installer. This API acts on the project that is already open.' },
  { channels: ['project:close'], why: 'human-only', reason: 'Closes the project and reloads the window — it would pull the ground out from under the agent’s own refs mid-call.' },
  { channels: ['project:pending'], why: 'redundant', reason: 'The internal handshake for a window that is reloading onto another project.' },
  { channels: ['watch:start'], why: 'redundant', reason: 'The file watcher starts when a project opens; there is nothing here for anybody to decide.' },

  // Recents and thumbnails.
  { channels: ['recents:list', 'recents:add', 'recents:remove', 'recents:refreshThumb'], why: 'human-only', reason: 'The welcome screen’s own list of projects and their pictures. Not project state, and not about the project that is open.' },

  // Previewing an old commit.
  { channels: ['preview:atCommit', 'preview:stop'], why: 'human-only', reason: 'Points the canvas at a throwaway checkout and makes the editor read-only. An agent driving it would be an agent editing files that are about to be deleted.' },

  // Review administration — unchanged from Shared Reviews.
  { channels: ['reviews:sharedEnable', 'reviews:sharedJoin', 'reviews:sharedDisable', 'reviews:sharedInvite'], why: 'unsafe', reason: 'Creating a workspace, joining one or minting an invitation decides who can read somebody’s private comments. A person types the server address and the invitation.' },
  { channels: ['reviews:identity', 'reviews:setIdentity'], why: 'unsafe', reason: 'Changing whose name is on a comment. An agent signs with its own, and cannot sign with anybody else’s.' },
  { channels: ['reviews:editMessage', 'reviews:removeMessage'], why: 'human-only', reason: 'Rewording and pruning are a person tidying their own notes. An agent that could rewrite the conversation is an agent whose record of it means nothing.' },
  { channels: ['reviews:remove'], why: 'unsafe', reason: 'Deleting somebody’s feedback. An agent that disagrees resolves the thread with its reasoning, which leaves them able to disagree back.' },
  { channels: ['reviews:recolor'], why: 'human-only', reason: 'The colour the user files a comment under. Their filing, not a state to act on.' },
  { channels: ['reviews:sync', 'reviews:syncAnchors', 'reviews:shared'], why: 'redundant', reason: 'Housekeeping the window does for itself; get_comments already reports the result of all of it.' },
  { channels: ['reviews:list', 'reviews:act'], why: 'exposed elsewhere', reason: 'These ARE get_comments and comment, which existed before this feature and are unchanged by it.' },

  // Served through something else.
  { channels: ['selection:copy'], why: 'redundant', reason: 'Puts the selection trail on the clipboard for pasting into a chat. get_context and target.read return the same trail as data.' },
  { channels: ['page:write', 'page:writeRaw', 'page:parseSource'], why: 'exposed elsewhere', reason: 'The model and raw writers, and the parse that turns text into a model without touching disk. Reached through target edits and source writes, which go through the editor so undo, the canvas and the preview all follow.' },
  { channels: ['style:listFiles', 'style:listAstroStyles'], why: 'exposed elsewhere', reason: 'The stylesheet scan the Style panel runs. style.read and style.list_sources answer from it, with the rules already matched against the element.' },
  { channels: ['mcp:publish', 'mcp:reply', 'mcp:status'], why: 'redundant', reason: 'The wiring between this server and its own window. Nothing about the project is in any of it.' },
];

// --- lookups -----------------------------------------------------------------

const DOMAINS = Object.keys(OPERATIONS);

/** The operation, or null. Never throws — an unknown action is an answer. */
function find(domain, action) {
  const ops = OPERATIONS[domain];
  if (!ops) return null;
  return Object.prototype.hasOwnProperty.call(ops, action) ? ops[action] : null;
}

const actionsOf = (domain) => Object.keys(OPERATIONS[domain] || {});

/** Every operation as a flat list, for capabilities and the coverage table. */
function list() {
  const out = [];
  for (const domain of DOMAINS) {
    for (const [action, op] of Object.entries(OPERATIONS[domain])) {
      out.push({ domain, action, ...op });
    }
  }
  return out;
}

/** Every IPC channel an operation reuses. What the coverage test checks against. */
function channels() {
  const out = new Set();
  for (const op of list()) {
    if (op.channel) out.add(op.channel);
    for (const also of op.uses || []) out.add(also);
  }
  return out;
}

/** Every channel that is deliberately not reachable, flattened. */
function excludedChannels() {
  const out = new Set();
  for (const entry of EXCLUDED) for (const channel of entry.channels) out.add(channel);
  return out;
}

module.exports = { OPERATIONS, EXCLUDED, DOMAINS, find, actionsOf, list, channels, excludedChannels };
