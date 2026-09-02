// The held-out checkers, checked.
//
//   node test/heldout-oracles.js
//
// An oracle is the one thing in an evaluation nobody grades. It decides whether
// every trial passed, it is never itself run against a known-wrong answer, and
// when it is wrong it does not look wrong — it looks like a result.
//
// This phase produced four corrections and every one of them was found by a
// BASELINE failure that looked exactly like a product defect: a check keyed to
// the wrong project's text; a check racing Vite's module invalidation; a check
// requiring a bare `<title>` on a page Stacki serves with `data-avb-p` on every
// element; and this one.
//
// THIS ONE IS THE WORST OF THE FOUR, because it did not fail. `semantic-nav`
// asks for a link that uses "the same kind of link component the other three
// use, so it is styled like them". The check worked out whether it did —
// `sameComponent` — and then left it out of the verdict. A raw
// `<a href="/uses">Uses</a>` satisfied every clause actually being read: on
// disk, renders, neighbours survive. The trial passed in both arms and the
// result file carried a field that read exactly like evidence and was load-
// bearing on nothing.
//
// So the source half of that judgement is a pure function now, and this file
// feeds it a correct control and a broken one and requires them to come out
// different. No model, no network, no dev server: an oracle proof that depends
// on an agent is not a proof.

const { judgeNavHeader } = require('../scripts/eval/heldout/tasks.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked += 1;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (v) => JSON.stringify(v ?? null);

// The upstream header, as `astro-blog` ships it: three links, no /uses.
const BEFORE = `---
import { SITE_TITLE } from '../consts';
import HeaderLink from './HeaderLink.astro';
---

<header>
\t<nav>
\t\t<h2><a href="/">{SITE_TITLE}</a></h2>
\t\t<div class="internal-links">
\t\t\t<HeaderLink href="/">Home</HeaderLink>
\t\t\t<HeaderLink href="/blog">Blog</HeaderLink>
\t\t\t<HeaderLink href="/about">About</HeaderLink>
\t\t</div>
\t</nav>
</header>
`;

/** The same header with a fourth link, written the given way. */
const withLink = (markup) => BEFORE.replace('\t\t</div>', `\t\t\t${markup}\n\t\t</div>`);

const CORRECT = withLink('<HeaderLink href="/uses">Uses</HeaderLink>');
const RAW_ANCHOR = withLink('<a href="/uses">Uses</a>');

(async () => {
  // --- THE CONTROL THE BRIEF ASKS FOR.
  {
    const j = judgeNavHeader(CORRECT);
    check('a HeaderLink to /uses is on disk', j.onDisk === true, short(j));
    check('  and is recognised as the same component as its neighbours', j.sameComponent === true, short(j));
    check('  and the links that were there survived', j.kept === true, short(j));
  }

  // --- THE CONTROL THAT MUST NOT PASS. Structurally identical, one word
  //     different, and unstyled on the page — which is the entire reason the
  //     brief names the component.
  {
    const j = judgeNavHeader(RAW_ANCHOR);
    check('a raw <a> to /uses is still on disk', j.onDisk === true, short(j));
    check('  and the neighbours still survived', j.kept === true, short(j));
    // THE ONE THIS FILE EXISTS FOR.
    check('  but it is NOT the same component', j.sameComponent === false, short(j));
  }

  // --- AND THEY MUST DISAGREE. A judgement that returns the same verdict for
  //     both controls has not distinguished anything, whatever its fields say.
  {
    const good = judgeNavHeader(CORRECT);
    const bad = judgeNavHeader(RAW_ANCHOR);
    check('the two controls are told apart', good.sameComponent !== bad.sameComponent, `${short(good)} vs ${short(bad)}`);
    check('  and only by the clause that should separate them', good.onDisk === bad.onDisk && good.kept === bad.kept, `${short(good)} vs ${short(bad)}`);
  }

  // --- THE VERDICT ITSELF, as the task computes it. This is the line that was
  //     wrong: `sameComponent` was absent from it.
  {
    const verdict = (header, rendered) => {
      const s = judgeNavHeader(header);
      return s.onDisk && s.sameComponent && rendered && s.kept;
    };
    check('the correct control passes when it renders', verdict(CORRECT, true) === true);
    check('the raw anchor fails even though it renders', verdict(RAW_ANCHOR, true) === false);
    check('and nothing passes when the page does not render it', verdict(CORRECT, false) === false);
  }

  // --- THE HEADER BEFORE THE AGENT TOUCHES IT must fail, or the task would pass
  //     for doing nothing at all.
  {
    const j = judgeNavHeader(BEFORE);
    check('the untouched header does not pass', j.onDisk === false, short(j));
    check('  though its existing links are of course intact', j.kept === true, short(j));
  }

  // --- LOSING THE NEIGHBOURS is a failure even with a perfect new link.
  {
    const clobbered = `---
import HeaderLink from './HeaderLink.astro';
---
<header><nav><div class="internal-links">
\t<HeaderLink href="/uses">Uses</HeaderLink>
</div></nav></header>
`;
    const j = judgeNavHeader(clobbered);
    check('a header that lost its other links does not pass', j.kept === false, short(j));
    check('  even though the new link is the right component', j.sameComponent === true, short(j));
  }

  // --- NOTHING AT ALL.
  {
    const j = judgeNavHeader('');
    check('an unreadable header is a failure, not a crash', j.onDisk === false && j.sameComponent === false && j.kept === false, short(j));
  }

  if (failures.length) {
    console.error(`heldout-oracles: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`heldout-oracles: ${checked} passed  [the semantic-nav judgement tells a HeaderLink from a bare anchor]`);
})().catch((err) => {
  console.error('heldout-oracles: threw\n', err?.stack || err);
  process.exit(1);
});
