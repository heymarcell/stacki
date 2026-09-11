// Does this server describe its whole self, and does it describe it compactly?
//
//   node test/mcp-surface-map.js
//
// TWO INVARIANTS, BOTH OF WHICH THIS ENDPOINT BROKE IN PRODUCTION.
//
// THE MAP. The instructions tell every client to call `get_capabilities` once,
// at the start, "rather than discovering a refusal". That answer was generated
// from the Agent registry — and five of the thirteen tools are deliberately not
// registry operations, because they answer typed results rather than the
// generic Envelope. So the one orienting call described eight of thirteen
// tools, and said nothing about the two that render or photograph a page.
//
// The cost was measured, not imagined. A real Claude Code session, asked to
// settle a colour-contrast finding the audit had returned as `incomplete`,
// reached for an external browser automation tool to render the route at a
// chosen width. It had called `get_capabilities` first, exactly as told.
// `audit({viewports, rules: [], capture: true})` does that natively and was not
// on the map; the only pointer to it lived in the description of `capture`,
// which a client has no reason to read unless it already suspects the answer.
//
// So this asserts BY RULE, not by listing today's thirteen: the set of tool
// names the server publishes in `tools/list` must equal the set the capability
// answer names. A fourteenth tool added tomorrow without being put on the map
// fails here, which is the only way this stays true.
//
// IN BOTH DIRECTIONS, because the first fix for this was itself a hand-kept
// list beside the registration conditions rather than built from them -- and
// `audit` is registered only when the app hands over a browser. That list
// claimed a tool the server does not publish. So the rule is checked against a
// server WITHOUT an audit and a server WITH one: a map that always names audit
// fails the first, and a map that never names it fails the second.
//
// THE SECOND COPY. Every envelope goes out twice — `structuredContent`, and the
// serialized text block the spec asks for so that clients older than the field
// still work. That text block was indented at two spaces on the reasoning that
// envelopes are small and a person reads them. Measured across ten operations
// through the real client, indentation was 44% of it, and the LARGEST answers
// paid the most: `get_capabilities` 14,659 bytes, of which 6,756 were spaces.
//
// A model reads this, not a person. Both halves are asserted — compact, AND
// still a faithful copy — because compacting a duplicate is only safe while it
// stays a duplicate.

const { startWireRig } = require('./support/mcpWireRig.js');
const { guardSuite } = require('./support/suiteGuard.js');

// A HANG MUST NOT REPORT A PASS. See test/support/suiteGuard.js.
const suiteDone = guardSuite('mcp-surface-map');

const failures = [];
let checked = 0;
const check = (what, ok, detail) => {
  checked += 1;
  if (!ok) failures.push(`    ${what}${detail ? ` — ${detail}` : ''}`);
};

const setOf = (xs) => [...new Set(xs)].sort();
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

(async () => {
  // A tool that only has to EXIST for this suite: the map is built from whether
  // the app handed a browser over, never from what that browser then does.
  const stubAudit = async () => ({ ok: true, findings: [] });

  for (const [label, opts, expectAudit] of [
    ['no browser behind it', {}, false],
    ['a browser behind it', { audit: stubAudit }, true],
  ]) {
    const rig = await startWireRig(opts);
    try {
      const published = setOf((await rig.client.listTools()).tools.map((t) => t.name));
      const res = await rig.client.callTool({ name: 'get_capabilities', arguments: {} });
      const caps = res.structuredContent;

      check(`[${label}] get_capabilities carries a tools map`, !!caps.tools, JSON.stringify(Object.keys(caps)));
      const direct = caps.tools?.direct || [];
      const mapped = setOf([...(caps.tools?.domain || []), ...direct.map((d) => d.tool)]);

      // THE RULE. Everything published is mapped, and nothing mapped is unpublished.
      check(
        `[${label}] the map is exactly what is published`,
        same(published, mapped),
        `published ${published.length} [${published.join(', ')}] vs mapped ${mapped.length} [${mapped.join(', ')}]`
      );

      // And the map MOVED with the configuration rather than being constant.
      const auditRow = direct.find((d) => d.tool === 'audit');
      check(
        `[${label}] audit is ${expectAudit ? 'on' : 'off'} the map`,
        !!auditRow === expectAudit,
        `served ${auditRow ? 'present' : 'absent'}, published ${published.includes('audit') ? 'present' : 'absent'}`
      );

      // The two that answer "render this page" and "photograph this page" are
      // the ones whose absence was actually paid for, so they are named. A rule
      // that only compares sets would pass a map that swapped one for another.
      for (const row of [auditRow, direct.find((d) => d.tool === 'capture')].filter(Boolean)) {
        check(`[${label}] ${row.tool} says what it is for`, typeof row.what === 'string' && row.what.length > 40, JSON.stringify(row.what));
      }
      // A tool that needs a level names it, in the words the window uses, so
      // "raise it" points at something a person can find.
      if (auditRow) {
        check(`[${label}] audit names the level it needs`, !!auditRow.needs?.mode && !!auditRow.needs?.label, JSON.stringify(auditRow.needs));
      }

      // --- the second copy is compact, and still a copy ----------------------
      const text = (res.content || []).find((c) => c.type === 'text')?.text;
      check(`[${label}] the envelope has a text block`, typeof text === 'string', typeof text);
      check(
        `[${label}] the text block is not indented`,
        typeof text === 'string' && !/\n\s+"/.test(text),
        typeof text === 'string' ? `${text.length} bytes` : ''
      );
      check(
        `[${label}] and it is byte-identical to structuredContent`,
        typeof text === 'string' && text === JSON.stringify(caps),
        typeof text === 'string' ? `text ${text.length} vs structured ${JSON.stringify(caps).length}` : ''
      );
    } finally {
      const { problems } = (await rig.stop?.()) || {};
      // CLEANUP FAILURE IS TEST FAILURE, not a log line.
      check(`[${label}] the rig left nothing behind`, !problems || problems.length === 0, problems && problems.join('; '));
    }
  }

  if (failures.length) {
    console.error(`mcp-surface-map: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  suiteDone();
  console.log(`mcp-surface-map: ${checked} passed  [the map is exactly what is published, in both configurations; the second copy is compact and faithful]`);
})().catch((err) => {
  console.error('mcp-surface-map: threw', err);
  process.exit(1);
});
