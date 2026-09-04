// What a client is TOLD about the style domain, held against what running it does.
//
//   node test/style-agent-contract.js
//
// Two findings from a native agent driving the packaged app, both about the
// same gap: an operation can be perfectly implemented and still be unusable,
// or unrecoverable, because of what comes back down the wire.
//
//   THE SHAPE NOBODY PUBLISHED. `add_section`, `set_section_title`,
//   `remove_section` and `move_heading` all take their arguments inside `edit`,
//   and each wants a different set of fields. A discriminated union converts to
//   `{type:'object', oneOf:[…]}` with NO top-level `properties`, and the host
//   showed the agent nothing — so it sent the fields at the top level, was told
//   "edit is required", and had to guess the rest one refusal at a time. Two of
//   the four it never got past argument validation at all.
//
//   THE REFUSAL WITH NO CODE. `style.set_variable` guards a write at a byte
//   offset against the value it was told is there. When that guard fired, the
//   answer was `{ok:false, stale:true, error:"This file changed since the panel
//   read it."}` — no `code` to branch on, and the sentence under `error` where
//   every other refusal in the surface says `message`.
//
// The oracle for the first one is deliberately not "the description contains
// the right words". Every call below is BUILT FROM THE PUBLISHED SCHEMA — the
// field names are parsed out of what tools/list serves and nothing else — and
// then has to change the stylesheet on disk. A schema that documents the wrong
// shape cannot pass, because the call assembled from it would be refused.

const fs = require('node:fs');
const path = require('node:path');
const { startWireRig } = require('./support/mcpWireRig.js');
const { actionsOf } = require('../electron/mcp/agent/registry.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v, n = 400) => JSON.stringify(v ?? null).slice(0, n);

const CSS = 'src/styles/site.css';

/**
 * The field names one action puts inside an object argument, read out of the
 * published description: `set_section_title: {file, start, end, title, expect}`.
 * Optional ones are written `before?`, which is how the schema marks them.
 */
const shapeFor = (description, action) => {
  const found = String(description || '').match(new RegExp(`(?:^|; )${action}: \\{([^}]*)\\}`));
  // Nothing published for this action: the calls below then send an empty
  // `edit` and are refused, which is the finding rather than a crash here.
  if (!found) return { required: [], optional: [], all: [], missing: true };
  const fields = found[1]
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  return {
    required: fields.filter((f) => !f.endsWith('?')),
    optional: fields.filter((f) => f.endsWith('?')).map((f) => f.slice(0, -1)),
    all: fields.map((f) => (f.endsWith('?') ? f.slice(0, -1) : f)),
  };
};

(async () => {
  const rig = await startWireRig({ era: 'modern', agentMode: 'full' });
  const cssPath = path.join(rig.root, CSS);
  const css = () => fs.readFileSync(cssPath, 'utf8');
  const variables = async () => (await rig.call('style', 'variables', {})).envelope;
  /** The block one heading names, with the offsets `variables` reports for it. */
  const blockTitled = async (title) => {
    const answer = await variables();
    const file = (answer.files || []).find((f) => f.path === CSS);
    return (file?.groups || []).flatMap((g) => g.blocks || []).find((b) => b.title === title) || null;
  };

  try {
    const listed = await rig.client.listTools();
    const style = listed.tools.find((t) => t.name === 'style');
    check('the style tool is published', !!style, short(listed.tools.map((t) => t.name)));

    // ── the arguments are where a client will look for them ──────────────────
    const properties = style?.inputSchema?.properties || {};
    check(
      'the published style schema names its arguments at the top level',
      Object.keys(properties).length > 1,
      short(Object.keys(properties))
    );
    check(
      '  starting with every action it has',
      Array.isArray(properties.action?.enum) && actionsOf('style').every((a) => properties.action.enum.includes(a)),
      short(properties.action?.enum)
    );
    check('  and the `edit` the four heading operations take', !!properties.edit, short(Object.keys(properties)));
    check(
      '  with the branches still published underneath, unchanged',
      (style?.inputSchema?.oneOf || []).length === actionsOf('style').length,
      String((style?.inputSchema?.oneOf || []).length)
    );

    // The description is not trusted to agree with the branch it summarises:
    // both are read, and they have to name the same fields.
    for (const action of ['add_section', 'set_section_title', 'remove_section', 'move_heading', 'set_variable']) {
      const branch = (style?.inputSchema?.oneOf || []).find((b) => b?.properties?.action?.const === action);
      const declared = Object.keys(branch?.properties?.edit?.properties || {}).sort();
      const summary = shapeFor(properties.edit?.description, action);
      check(`the published shape for style.${action} exists`, !summary.missing, short(properties.edit?.description));
      check(
        `  and names exactly the fields its own branch declares`,
        !summary.missing && JSON.stringify(summary.all.sort()) === JSON.stringify(declared),
        `summary: ${short(summary?.all)}\n    branch:  ${short(declared)}`
      );
      check(
        `  marking as required exactly the ones the branch requires`,
        !summary.missing && JSON.stringify(summary.required.sort()) === JSON.stringify([...(branch?.properties?.edit?.required || [])].sort()),
        `summary: ${short(summary?.required)}\n    branch:  ${short(branch?.properties?.edit?.required)}`
      );
    }

    // ── and the shape that is published is a shape that WORKS ────────────────
    //
    // Every call below is assembled from `shapeFor(...)` — the field names come
    // out of tools/list, never from this file — and then measured on disk.
    {
      const shape = shapeFor(properties.edit?.description, 'add_section');
      const values = { file: CSS, selector: ':root', title: 'Motion', before: '--brand' };
      const edit = Object.fromEntries(shape.all.filter((f) => values[f] !== undefined).map((f) => [f, values[f]]));
      check('add_section takes every field it requires', shape.required.every((f) => f in edit), short({ shape, edit }));
      const { envelope } = await rig.call('style', 'add_section', { edit });
      check('a section added with the published shape is not refused', envelope?.ok === true, short(envelope));
      check('  and the heading is in the stylesheet', css().includes('/* Motion */'), css());
    }

    {
      const block = await blockTitled('Motion');
      check('the variables read reports the heading it just wrote', !!block, short(block));
      const shape = shapeFor(properties.edit?.description, 'set_section_title');
      const values = { file: CSS, start: block?.titleStart, end: block?.titleEnd, title: 'Transitions', expect: 'Motion' };
      const edit = Object.fromEntries(shape.all.map((f) => [f, values[f]]));
      const { envelope } = await rig.call('style', 'set_section_title', { edit });
      check('a retitle with the published shape is not refused', envelope?.ok === true, short(envelope));
      check('  and the heading reads the new title', css().includes('/* Transitions */'), css());
      check('  still as a comment, with the variables under it intact', /--brand:\s*#3355ff;/.test(css()), css());
    }

    {
      const block = await blockTitled('Transitions');
      const shape = shapeFor(properties.edit?.description, 'move_heading');
      const values = { file: CSS, selector: ':root', start: block?.titleStart, end: block?.titleEnd, expect: 'Transitions', before: '--gap' };
      const edit = Object.fromEntries(shape.all.map((f) => [f, values[f]]));
      const { envelope } = await rig.call('style', 'move_heading', { edit });
      check('a move with the published shape is not refused', envelope?.ok === true, short(envelope));
      check('  and the heading is now above the first variable', css().indexOf('/* Transitions */') < css().indexOf('--gap'), css());
    }

    {
      const block = await blockTitled('Transitions');
      const shape = shapeFor(properties.edit?.description, 'remove_section');
      const values = { file: CSS, start: block?.titleStart, end: block?.titleEnd, expect: 'Transitions' };
      const edit = Object.fromEntries(shape.all.map((f) => [f, values[f]]));
      const { envelope } = await rig.call('style', 'remove_section', { edit });
      check('a removal with the published shape is not refused', envelope?.ok === true, short(envelope));
      check('  and the heading is gone', !css().includes('/* Transitions */'), css());
      check(
        '  and both variables are still declared',
        /--gap:\s*1rem;/.test(css()) && /--brand:\s*#3355ff;/.test(css()),
        css()
      );
    }

    // The mistake the schema now prevents, still refused in Stacki's own words.
    {
      const before = css();
      const { envelope } = await rig.call('style', 'set_section_title', { file: CSS, start: 0, end: 1, title: 'x', expect: ':' });
      check('the same call without the `edit` wrapper is refused', envelope?.ok === false, short(envelope));
      check('  as bad_arguments, naming the argument', envelope?.code === 'bad_arguments', short(envelope));
      check('  and nothing was written', css() === before);
    }

    // ── a refusal from the main process carries a code ───────────────────────
    {
      const answer = await variables();
      const cell = (answer.files || [])
        .find((f) => f.path === CSS)
        ?.groups.flatMap((g) => g.blocks)
        .flatMap((b) => b.rows)
        .flatMap((r) => r.cells)
        .find((c) => c?.name === '--brand');
      check('the variables read gives the offsets of a value', typeof cell?.valueStart === 'number', short(cell));

      const before = css();
      const { envelope } = await rig.call('style', 'set_variable', {
        edit: { file: CSS, valueStart: cell.valueStart, valueEnd: cell.valueEnd, value: '#000000', expect: 'NOT WHAT IS THERE' },
      });
      check('a write against a value that moved is refused', envelope?.ok === false, short(envelope));
      check('  with a code an agent can branch on', envelope?.code === 'stale_target', short(envelope));
      check('  and the sentence under `message`, as everywhere else', typeof envelope?.message === 'string' && envelope.message.length > 0, short(envelope));
      check('  and nothing under `error`', envelope?.error === undefined, short(envelope));
      check('  and the stylesheet is byte-identical', css() === before);

      // The same guard, satisfied: the refusal is about the guard and not about
      // the operation being broken.
      const written = await rig.call('style', 'set_variable', {
        edit: { file: CSS, valueStart: cell.valueStart, valueEnd: cell.valueEnd, value: '#000000', expect: cell.value },
      });
      check('and the same write with the value that IS there lands', written.envelope?.ok === true, short(written.envelope));
      check('  on disk', /--brand:\s*#000000;/.test(css()), css());
    }
  } finally {
    const teardown = await rig.stop();
    if (teardown.problems?.length) failures.push(`  the rig would not come down cleanly\n    ${teardown.problems.join("\n    ")}`);
  }

  if (failures.length) {
    console.error(`\nstyle-agent-contract: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`style-agent-contract: ${checked} passed  [the published style arguments, run as published]`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
