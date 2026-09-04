// The argument names a client may send, and what it hears when it sends none.
//
//   node test/mcp-arguments.js
//
// WHY THIS FILE EXISTS, and it is not a hypothetical.
//
// `target` publishes two ways to change an element's text, and they disagreed
// about what the new text is called:
//
//   { action: "set_text", ref, text: "…" }
//   { action: "edit", ref, operations: [{ type: "set_text", value: "…" }] }
//
// Every other pair in the surface agrees — `set_prop` is `{name, value}` in both
// forms. `set_text` was the one that was not, and the disagreement is invisible
// unless you read both schemas side by side, which is exactly what an agent does
// when `tools/list` hands it 140 KB at once.
//
// Measured, on the simplest task in the held-out corpus — change one heading — a
// real Claude Code, connected to a real packaged Stacki over a recording proxy:
//
//   target { action: "set_text", value: "…" }
//     -> "Invalid input: expected string, received undefined"
//   target { operations: [{ type: "set_text", value: "…" }] }     (no action)
//     -> another validation error
//   target { action: "edit", operations: [ … ] }
//     -> finally
//
// Twelve tool calls and 718 KB for a one-word change, two of them spent here.
//
// So both spellings are accepted in both forms and the wire normalises. What is
// asserted below is not that the schema has a field — it is that BOTH spellings
// put the same bytes in the same file, which is the only thing that makes an
// alias real rather than declared.

const { execFileSync } = require('node:child_process');

const { startWireRig } = require('./support/mcpWireRig.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v) => JSON.stringify(v ?? null).slice(0, 240);

/** Every node in a target tree, so a heading can be found by tag. */
const flatten = (node) => (node ? [node, ...(node.children || []).flatMap(flatten)] : []);

(async () => {
  const rig = await startWireRig({ era: 'modern', agentMode: 'edit' });
  const problems = [];
  try {
    /**
     * A fresh ref for the fixture's `h1`, inside the Hero component.
     *
     * The editor is LEFT INSIDE the component deliberately. Leaving it — which
     * an earlier version did, for tidiness — moves the open document back to the
     * page, and the ref minted inside then describes a document the editor is no
     * longer on: every write came back `stale_target`, correctly. The scenario
     * set does the same thing for the same reason.
     */
    const headingRef = async () => {
      await rig.call('target', 'exit', {});
      const root = await rig.call('target', 'read', {});
      const hero = flatten(root.envelope?.target).find((n) => String(n.tag || '') === 'Hero');
      const inside = await rig.call('target', 'enter', { ref: hero?.ref });
      const h1 = flatten(inside.envelope?.target).find((n) => String(n.tag || '').toLowerCase() === 'h1');
      return h1?.ref || null;
    };

    const HERO = 'src/components/Hero.astro';

    /**
     * One write, and everything the file can say about it.
     *
     * NOTHING IS RESTORED BETWEEN CASES. An earlier version of this file put the
     * component back with a direct disk write and the next edit came back
     * `stale_target` — correctly: the editor had read a document that something
     * else then changed underneath it, which is the exact refusal the ref
     * contract exists to produce. So each case simply writes over the last, and
     * "changed nothing else" is measured against the state that case started
     * from.
     */
    const writeHeading = async (args, wanted) => {
      const before = rig.harness.read(HERO);
      const heading = /<h1[^>]*>([^<]*)<\/h1>/.exec(before)?.[1] ?? null;
      const ref = await headingRef();
      const said = await rig.call('target', 'set_text', { ref, replaceBinding: true, ...args });
      const after = rig.harness.read(HERO);
      return { said, before, after, heading, untouchedApartFromTheHeading: heading !== null && after.replace(wanted, heading) === before };
    };

    // --- THE DECLARED NAME still works, and is the control everything else is
    //     compared against.
    {
      const r = await writeHeading({ text: 'Written with text' }, 'Written with text');
      check('`text` writes the heading', r.said.envelope?.ok === true && r.after.includes('Written with text'), short(r.said.envelope));
      check('  in the element the ref named', /<h1[^>]*>[^<]*Written with text/.test(r.after), r.after.slice(0, 240));
      check('  and changes nothing else', r.untouchedApartFromTheHeading, 'the rest of the component moved');
    }

    // --- THE ALIAS. The same call with the batch form's name for the same
    //     argument, landing the same bytes in the same file.
    {
      const r = await writeHeading({ value: 'Written with value' }, 'Written with value');
      check('`value` writes the heading too', r.said.envelope?.ok === true, short(r.said.envelope));
      check('  and it is really on disk', r.after.includes('Written with value'), r.after.slice(0, 240));
      check('  in the same element the declared name used', /<h1[^>]*>[^<]*Written with value/.test(r.after), r.after.slice(0, 240));
      check('  and changes nothing else', r.untouchedApartFromTheHeading, 'the rest of the component moved');
    }

    // --- BOTH, AND THEY DISAGREE. The action's own name wins — it is the one
    //     the action's schema names first.
    {
      const r = await writeHeading({ text: 'The declared one', value: 'The alias one' }, 'The declared one');
      check('when both are sent, the declared name wins', r.after.includes('The declared one') && !r.after.includes('The alias one'), r.after.slice(0, 240));
    }

    // --- THE BATCH FORM, with the single form's name.
    {
      const before = rig.harness.read(HERO);
      const ref = await headingRef();
      const said = await rig.call('target', 'edit', {
        ref,
        operations: [{ type: 'set_text', text: 'Written in a batch with text', replaceBinding: true }],
      });
      const after = rig.harness.read(HERO);
      check('`text` works inside an `edit` batch as well', said.envelope?.ok === true, short(said.envelope));
      check('  and lands on disk', after.includes('Written in a batch with text'), after.slice(0, 240));
      check('  and changes nothing else', after.replace('Written in a batch with text', 'The declared one') === before, 'the rest of the component moved');
    }

    // --- NEITHER. Accepting an alias means the schema can no longer require the
    //     field, so the refusal has to be here — and it has to name both.
    {
      const before = rig.harness.read(HERO);
      const ref = await headingRef();
      const said = await rig.call('target', 'set_text', { ref, replaceBinding: true });
      const after = rig.harness.read(HERO);
      check('a set_text with no text at all is refused', said.envelope?.ok === false, short(said.envelope));
      check('  with a code a client can branch on', said.envelope?.code === 'bad_arguments', short(said.envelope?.code));
      check('  and a sentence that names both spellings', /`text`/.test(String(said.envelope?.message)) && /`value`/.test(String(said.envelope?.message)), short(said.envelope?.message));
      check('  and nothing was written', after === before, 'the component changed on a refused call');
    }

    // --- AND EVERY OTHER ARGUMENT MISTAKE, on every tool.
    //
    // `set_text` above is refused by Stacki because its schema had to make the
    // field optional to accept two names for it. Every OTHER missing argument
    // was refused by the SDK instead — `tools/call` validates against the tool's
    // input schema before the handler runs, and a failure there is a protocol
    // error: a bare English sentence, `isError`, and no structuredContent at
    // all. Measured against a real client:
    //
    //   git {action:'push'}
    //     -> "Input validation error: Invalid arguments for tool git:
    //         branch: Invalid input: expected string, received undefined"
    //
    // That is the one shape in this surface an agent cannot branch on, and it
    // was the DEFAULT for the 73 operations that declare a required argument —
    // not a handful of cases. So the strict schema is still advertised and
    // Stacki validates it itself, inside the handler, where a failure becomes
    // the same `{ok:false, code, operation, issues}` everything else answers.
    const BAD = [
      ['target', { action: 'set_prop', ref: 'x'.repeat(20) }, 'name'],
      ['style', { action: 'set_property' }, 'property'],
      ['source', { action: 'resolve_path', path: 'src/pages/index.astro' }, 'fromFile'],
      ['page', { action: 'create' }, 'name'],
      ['content', { action: 'validate', collection: 'notes' }, 'data'],
      ['asset', { action: 'write_text', path: 'public/robots.txt' }, 'text'],
      // `project` has no action with a required argument, so its argument
      // failure is a BOUND being broken rather than a field being absent —
      // which the same refusal has to cover.
      ['project', { action: 'classes', limit: 9999 }, 'limit'],
      ['git', { action: 'commit' }, 'message'],
    ];
    for (const [tool, args, field] of BAD) {
      const res = await rig.client.callTool({ name: tool, arguments: args });
      const text = res?.content?.[0]?.text;
      let parsed = null;
      try {
        parsed = JSON.parse(String(text));
      } catch {
        /* a raw sentence does not parse, which is the whole complaint */
      }
      check(`${tool}.${args.action} with no ${field} answers in Stacki's own shape`, !!res?.structuredContent, short(text));
      check('  with the same payload in the text block', !!parsed && parsed.ok === false, short(text));
      check('  a code a client can branch on', parsed?.code === 'bad_arguments', short(parsed?.code));
      check('  the operation it was about', parsed?.operation === `${tool}.${args.action}`, short(parsed?.operation));
      check(
        `  and an issue naming ${field}`,
        (parsed?.issues || []).some((i) => Array.isArray(i.path) && i.path[0] === field),
        short(parsed?.issues)
      );
    }

    // An action the tool does not have is a bad ACTION, not a bad argument —
    // the same answer the dispatcher gives, rather than zod's "Invalid
    // discriminator value".
    {
      const res = await rig.client.callTool({ name: 'target', arguments: { action: 'nope' } });
      let parsed = null;
      try {
        parsed = JSON.parse(String(res?.content?.[0]?.text));
      } catch {
        /* see above */
      }
      check('an action that does not exist is refused as one', parsed?.code === 'bad_action', short(res?.content?.[0]?.text));
      check('  and is told what the tool does have', Array.isArray(parsed?.actions) && parsed.actions.includes('set_text'), short(parsed?.actions));
    }

    // --- WHERE AN OMISSION CAN SAFELY DEFAULT, IT DOES. Two of the failures
    //     above were not argument mistakes at all: "put this file back" means
    //     "back to the last commit", and "push" means "push what I am on".
    //
    // The mode is raised through the HARNESS, never through MCP — git is `high`
    // risk and there is no agent-facing operation that raises its own level.
    {
      rig.harness.setMode('full');
      await rig.call('git', 'init', {});
      await rig.call('git', 'commit', { message: 'a commit for restore_file to come back to' });
      const head = execFileSync('git', ['show', `HEAD:${HERO}`], { cwd: rig.root, encoding: 'utf8' });
      rig.harness.write(HERO, '<p>vandalised</p>\n');
      const before = rig.harness.read(HERO);
      const said = await rig.call('git', 'restore_file', { path: HERO });
      check('git.restore_file with no ref restores from HEAD', said.envelope?.ok === true, short(said.envelope));
      // The oracle is the bytes: HEAD's copy of the file, out of git itself.
      check('  and the file really is HEAD’s copy', rig.harness.read(HERO) === head, 'the restored bytes are not HEAD’s');
      check('  which is not what was there a moment ago', before !== head, 'nothing was vandalised, so this proved nothing');
    }
    {
      // `push` has nowhere to go in a fixture and must not be given one — what
      // is asserted is that the MISSING BRANCH stopped being the reason. It
      // reaches git, and git says there is no remote.
      const said = await rig.call('git', 'push', {});
      check('git.push with no branch is not an argument failure', said.envelope?.code !== 'bad_arguments', short(said.envelope));
      check('  it got as far as git, which has no remote to push to', /origin|remote|upstream/i.test(String(said.envelope?.message || '')), short(said.envelope?.message));
      rig.harness.setMode('edit');
    }
  } finally {
    const said = await rig.stop();
    problems.push(...(said?.problems || []));
  }

  // Cleanup failure is test failure.
  check('the rig left nothing behind', problems.length === 0, problems.join('; '));

  if (failures.length) {
    console.error(`mcp-arguments: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`mcp-arguments: ${checked} passed  [both spellings of set_text, through the wire, onto the disk]`);
})().catch((err) => {
  console.error('mcp-arguments: threw\n', err?.stack || err);
  process.exit(1);
});
