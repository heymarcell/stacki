// What a tree walk costs, and what `compact` takes off it.
//
//   node test/response-bulk.js
//
// Reaching a heading six levels down took six `target.read` calls in the native
// dogfood, and each answer carried a `snippet` -- the markup around the target,
// padded two lines either side and capped at sixty. Those six regions OVERLAP:
// the outermost node's snippet and its child's snippet are largely the same
// bytes, so a walk pays for the page's markup once per level: every answer in
// the six-level walk below quotes a window onto the same region of one file.
//
// The snippet is a good default and it is not removed. What was missing was a
// way to say "I am navigating, not reading" -- so `compact: true` drops it and
// sets `snippetOmitted: true` instead, which is a different fact from a null
// snippet (there is no source for this node).
//
// THE ORACLE IS SERIALIZED BYTES. A claim that a response got smaller is only
// worth what the number is, so this measures JSON.stringify of the real answer
// from the real Agent API, and the assertions are on the measurement -- not on
// the presence of a flag. It also asserts the walk still WORKS compactly: same
// refs, same children, same source trail. A smaller answer that cannot be
// walked is not an improvement.

const H = require('./agent-harness.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (x, n = 240) => JSON.stringify(x ?? null).slice(0, n);
const bytes = (x) => Buffer.byteLength(JSON.stringify(x ?? null), 'utf8');

const PAGE = 'src/pages/index.astro';

// Six nesting levels with a repeated list at the bottom, so the page is big
// enough that the same region really is quoted several times over.
const DEEP = `---
import Base from '../layouts/Base.astro';

const items = Array.from({ length: 24 }, (_, i) => 'item ' + (i + 1));
---
<Base>
	<section class="outer">
		<div class="middle">
			<article class="inner">
				<ul class="list">
					{items.map((item) => (
						<li class="item">
							<span class="label">{item}</span>
						</li>
					))}
				</ul>
			</article>
		</div>
	</section>
</Base>
`;

(async () => {
  const root = H.makeProject({ [PAGE]: DEEP });
  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(400);

  try {
    // --- the walk, both ways ------------------------------------------------
    //
    // Descend by taking the first structural child at each level, once with the
    // default answer and once compact, and total the serialized bytes.
    const walk = async (opts) => {
      const answers = [];
      let ref = null;
      for (let depth = 0; depth < 6; depth += 1) {
        const answer = await run('target', 'read', { ...opts, ...(ref ? { ref } : {}) });
        if (!answer?.ok) break;
        answers.push(answer);
        const kids = answer.target?.children || [];
        const next = kids.find((c) => c.ref && c.kind !== 'text');
        if (!next) break;
        ref = next.ref;
      }
      return answers;
    };

    const full = await walk({});
    const lean = await walk({ compact: true });

    check('the walk reaches six levels', full.length === 6, `${full.length} levels`);
    check('and compact reaches the same six', lean.length === full.length, `${lean.length} vs ${full.length}`);

    // POSITIVE CONTROL. If the default answers carried no snippet, every byte
    // claim below would be measuring nothing.
    const withSnippet = full.filter((a) => a.target?.snippet?.text);
    check('the default answers really do carry snippets', withSnippet.length >= 5, `${withSnippet.length} of ${full.length}`);

    // And that they OVERLAP -- which is the reason this is worth doing at all.
    // Not that the ranges are equal: each level quotes a slightly different
    // window onto the same markup, which is exactly how the same bytes get paid
    // for six times without any two answers looking alike.
    const spans = withSnippet.map((a) => ({
      file: a.target.source?.file,
      from: a.target.snippet.startLine,
      to: a.target.snippet.endLine,
    }));
    const overlaps = spans.filter((x, i) =>
      spans.some((y, j) => j !== i && y.file === x.file && y.from <= x.to && x.from <= y.to)
    );
    check('and they quote overlapping regions of one file', overlaps.length === spans.length, short(spans));

    const fullBytes = full.reduce((n, a) => n + bytes(a), 0);
    const leanBytes = lean.reduce((n, a) => n + bytes(a), 0);
    const saved = fullBytes - leanBytes;
    const pct = fullBytes ? Math.round((saved / fullBytes) * 1000) / 10 : 0;

    // What the snippets actually weigh, so the saving is checked against the
    // thing it is supposed to remove rather than against a percentage somebody
    // chose. A threshold tuned to this fixture would pass a change that dropped
    // something else instead; this cannot.
    const snippetBytes = full.reduce((n, a) => n + (a.target?.snippet ? bytes(a.target.snippet) : 0), 0);
    check('compact makes the walk smaller', leanBytes < fullBytes, `${fullBytes} -> ${leanBytes}`);
    // Exactly the snippets, and nothing else. Each level trades its snippet
    // object for `null` (4 bytes) and gains `,"snippetOmitted":true` (22), so
    // the arithmetic is closed and a tolerance would only hide a second change
    // riding along with this one.
    const perLevel = 'null'.length + ',"snippetOmitted":true'.length;
    check(
      'and what it removes is the snippets, exactly and only',
      saved === snippetBytes - perLevel * withSnippet.length,
      `saved ${saved}, expected ${snippetBytes - perLevel * withSnippet.length} (snippets ${snippetBytes}, ${withSnippet.length} levels)`
    );
    check(
      'which is a real fraction of the walk',
      pct >= 5,
      `saved ${saved} bytes of ${fullBytes} (${pct}%)`
    );

    // --- the flag says which fact it is -------------------------------------
    const leaf = lean[0];
    check('a compact answer carries no snippet', leaf.target?.snippet === null, short(leaf.target?.snippet));
    check('and says the caller asked for that', leaf.target?.snippetOmitted === true, short(leaf.target?.snippetOmitted));
    check(
      'while the default answer does not claim an omission',
      full[0].target?.snippetOmitted === undefined,
      short(full[0].target?.snippetOmitted)
    );

    // --- and it is still a walk ---------------------------------------------
    //
    // Everything a walk needs must survive: the ref, the children with their
    // refs, the source trail. Dropping those would also have made the answer
    // smaller.
    for (let i = 0; i < lean.length; i += 1) {
      const a = lean[i];
      const b = full[i];
      check(`level ${i}: compact still names the source file`, a.target?.source?.file === b.target?.source?.file, short([a.target?.source, b.target?.source]));
      check(`level ${i}: compact still carries a ref`, typeof a.target?.ref === 'string' && a.target.ref.length > 0);
      check(
        `level ${i}: compact reports the same children`,
        (a.target?.children || []).length === (b.target?.children || []).length,
        `${(a.target?.children || []).length} vs ${(b.target?.children || []).length}`
      );
      check(
        `level ${i}: and the same source trail depth`,
        (a.target?.sourceTrail || []).length === (b.target?.sourceTrail || []).length
      );
    }

    // --- a node with no source is still a null, not an omission -------------
    const leafless = lean[lean.length - 1];
    if (leafless?.target && !leafless.target.source) {
      check(
        'a node with no source says null rather than omitted',
        leafless.target.snippet === null && leafless.target.snippetOmitted === undefined,
        short({ s: leafless.target.snippet, o: leafless.target.snippetOmitted })
      );
    }

    console.log(`  walk of ${full.length} levels: ${fullBytes} bytes -> ${leanBytes} compact (saved ${saved}, ${pct}%)`);
  } finally {
    await app.stop?.();
    H.removeProject(root);
  }

  check('the fixture is gone', !require('node:fs').existsSync(root), root);

  if (failures.length) {
    console.error(`response-bulk: ${failures.length} of ${checked} failed`);
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log(`response-bulk: ${checked} passed  [what a walk costs, and what compact takes off it]`);
})().catch((e) => {
  console.error('response-bulk: threw');
  console.error(e);
  process.exit(1);
});
