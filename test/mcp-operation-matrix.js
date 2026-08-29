// Every Agent operation, and whether anything has ever driven it over the wire.
//
//   node test/mcp-operation-matrix.js
//
// electron/mcp/agent/registry.js is the single list of what Stacki's Agent API
// can do — 8 domains, 111 actions at the time of writing. The number matters
// less than the shape of the risk: an action can be added there, wired up, and
// shipped without one line of test ever calling it THROUGH MCP. Direct calls to
// `api.run(...)` in test/agent-api.js prove the implementation. They prove
// nothing about the wire, and the wire is where our one shipped MCP bug lived.
//
// So this file is a LEDGER, and its job is to make silence impossible.
//
// Every action in the registry must appear in exactly one of two places:
//
//   COVERED    — a scenario somewhere drives it through a real MCP client.
//   UNCOVERED  — listed here, on purpose, with the reason it is not yet driven.
//
// An action in NEITHER fails this test. That is the whole point: adding an
// operation to the registry without deciding how it gets tested is now a
// build failure rather than a thing nobody notices for a year.
//
// The UNCOVERED list is not an excuse list. It is a debt register, it is
// reviewed, and it is meant to shrink. Nothing may be moved into it silently:
// every entry carries a reason, and the reasons are grouped so that a reader
// can see at a glance what kind of work is outstanding.

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const { DOMAINS, actionsOf, find } = require('../electron/mcp/agent/registry.js');

const key = (domain, action) => `${domain}.${action}`;

// ── What is driven through a real MCP client today ─────────────────────────
//
// Filled in by the wire scenarios. Empty for now by design: this commit adds
// the ledger and the guard, and the scenarios land against it.
const COVERED = new Set([]);

// ── What is not, and why ───────────────────────────────────────────────────
//
// Grouped by the reason, because the reason decides the work. A reader should
// be able to tell "needs a fixture project" from "reaches the network" without
// reading 111 lines.
const UNCOVERED = {
  'needs a disposable fixture project': [
    'target.read', 'target.select', 'target.enter', 'target.exit', 'target.edit',
    'target.set_text', 'target.set_prop', 'target.remove_prop', 'target.set_classes',
    'target.add_class', 'target.remove_class', 'target.insert_before', 'target.insert_after',
    'target.append_child', 'target.remove', 'target.duplicate', 'target.move', 'target.set_tag',
    'style.read', 'style.list_sources', 'style.set_property', 'style.remove_property',
    'style.set_declarations', 'style.read_source', 'style.write_source', 'style.variables',
    'style.set_variable', 'style.add_variables', 'style.rename_variables', 'style.move_variables',
    'style.add_section', 'style.set_section_title', 'style.remove_section', 'style.move_heading',
    'source.read', 'source.read_symbol', 'source.resolve_path', 'source.replace_range', 'source.write',
    'page.list', 'page.read', 'page.create', 'page.delete', 'page.move', 'page.folder_create',
    'page.folder_rename', 'page.folder_delete', 'page.component_create', 'page.component_usage',
    'page.dynamic_paths', 'page.injected_routes', 'page.import_path', 'page.rebase_import',
    'content.cms_list', 'content.cms_read', 'content.cms_write', 'content.cms_create',
    'content.cms_delete', 'content.cms_usage', 'content.cms_meta', 'content.cms_set_meta',
    'content.config', 'content.collections', 'content.entries', 'content.write_entry',
    'content.validate', 'content.targets', 'content.rename_plan', 'content.rename',
    'content.sample_entry', 'content.resolve_import',
    'asset.list', 'asset.dimensions', 'asset.read_text', 'asset.write_text', 'asset.mkdir',
    'asset.move', 'asset.rename', 'asset.delete',
    'project.info', 'project.scan', 'project.classes', 'project.dependencies',
    'project.diagnose', 'project.probe', 'project.undo', 'project.redo',
  ],
  'runs a dev server or installs packages — needs an isolated, bounded fixture': [
    'project.install', 'project.dev_status', 'project.dev_start', 'project.dev_stop',
  ],
  'needs a throwaway git repository with a local bare remote': [
    'git.info', 'git.status', 'git.log', 'git.commit_files', 'git.all_files', 'git.file_at',
    'git.worktrees', 'git.init', 'git.commit', 'git.checkout', 'git.merge', 'git.resolve_merge',
    'git.delete_branch', 'git.restore_file', 'git.restore_project', 'git.park', 'git.unpark',
  ],
  'reaches real remote infrastructure — boundary only, never a live side effect': [
    'git.gh_status', 'git.push', 'git.publish',
  ],
};

const listed = new Map();
for (const [reason, actions] of Object.entries(UNCOVERED)) {
  for (const a of actions) {
    if (listed.has(a)) failures.push(`  ${a} is listed twice in UNCOVERED (${listed.get(a)} and ${reason})`);
    listed.set(a, reason);
  }
}

// ── The guard ──────────────────────────────────────────────────────────────

const all = [];
for (const domain of DOMAINS) for (const action of actionsOf(domain)) all.push(key(domain, action));

check('the registry still reports domains and actions', all.length > 0, String(all.length));

const unaccounted = all.filter((k) => !COVERED.has(k) && !listed.has(k));
check(
  'EVERY registry action is either wire-covered or listed as outstanding',
  unaccounted.length === 0,
  unaccounted.length
    ? `${unaccounted.length} action(s) in registry.js with no wire scenario and no entry in UNCOVERED:\n      ${unaccounted.join('\n      ')}\n    Add a scenario, or add it to UNCOVERED with the reason it cannot have one yet.`
    : ''
);

// The reverse: a stale ledger is a lie in the other direction. An entry naming
// an action the registry no longer has means the list was not maintained when
// the operation was renamed or dropped.
const ghosts = [...listed.keys(), ...COVERED].filter((k) => !all.includes(k));
check('no entry names an action the registry no longer has', ghosts.length === 0, ghosts.join(', '));

check('nothing is claimed as both covered and outstanding', [...COVERED].every((k) => !listed.has(k)), [...COVERED].filter((k) => listed.has(k)).join(', '));

// ── What the ledger says right now ─────────────────────────────────────────

const byRisk = { read: 0, write: 0, high: 0 };
for (const k of all) {
  const [d, ...rest] = k.split('.');
  const entry = find(d, rest.join('.'));
  if (entry && byRisk[entry.risk] != null) byRisk[entry.risk] += 1;
}

if (!failures.length) {
  const pct = ((COVERED.size / all.length) * 100).toFixed(1);
  console.log(`  ${all.length} operations across ${DOMAINS.length} domains  [read ${byRisk.read} · write ${byRisk.write} · high ${byRisk.high}]`);
  console.log(`  wire-covered: ${COVERED.size}/${all.length} (${pct}%)`);
  for (const [reason, actions] of Object.entries(UNCOVERED)) {
    console.log(`  outstanding — ${reason}: ${actions.length}`);
  }
}

if (failures.length) {
  console.error(`\nmcp-operation-matrix: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`mcp-operation-matrix: ${checked} passed  [the ledger holds; nothing is untracked]`);
