// A caption has to be about the picture underneath it.
//
//   node test/asserted-state.js
//
// The exporter asserts every state before photographing it. The remaining way
// for that to lie is timing: read the geometry, then take a picture a moment
// later, and the numbers in the caption describe a window that has since moved.
//
// The display matrix was shaped exactly like that. It read the geometry, built
// its claims and its caption from that object, and handed them to a capture
// helper that waits for the layout to settle before the shutter. Nothing wrong
// came out — but a relayout inside that window would have produced a caption
// that was true when it was written and false about the image it sat under, and
// the whole point of this package is that such a thing cannot happen quietly.
//
// So a state may supply a `read`, called once, after the wait and immediately
// before the shutter. The single object it returns is what the claims are about
// and what the caption is made of.
//
// This proves that: with the geometry deliberately changed during the wait, a
// claim about the old geometry cannot pass, and no caption quoting the old
// numbers can be recorded.

const { createState } = require('./support/assertedState.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

/**
 * A window that relayouts during the wait — an Inspector at 440 that has become
 * the 260px Comments Index by the time the picture is taken. Which is the exact
 * pair of states the matrix captions used to be able to confuse.
 */
function world() {
  const w = {
    live: { mode: 'docked', inspectorW: 440 },
    captured: [],
    failed: [],
    reads: 0,
    captures: 0,
  };
  w.state = createState({
    settle: async () => {
      w.live = { mode: 'index', inspectorW: 260 };
    },
    capture: async (name) => {
      w.captures++;
      // What the pixels would show: whatever is live at the shutter.
      w.shutter = { ...w.live, name };
    },
    onCaptured: (shot) => w.captured.push(shot),
    onFailed: (name, what, detail) => w.failed.push({ name, what, detail }),
  });
  w.read = async () => {
    w.reads++;
    return { ...w.live };
  };
  return w;
}

(async () => {
  // ── the claims are about the state at the shutter ─────────────────────────
  {
    const w = world();
    const before = { ...w.live }; // 440px Inspector, read before anything waits
    const ok = await w.state(
      'matrix-1024x665',
      (g) => `Inspector ${g.inspectorW}px, ${g.mode}`,
      async (g) => [['it is 440px wide', g.inspectorW === before.inspectorW, JSON.stringify(g)]],
      w.read
    );
    check('a claim about the pre-wait geometry does not pass', ok === false, JSON.stringify(w.captured));
    check('nothing was photographed', w.captures === 0, String(w.captures));
    check('no caption was recorded', w.captured.length === 0, JSON.stringify(w.captured));
    check('and the failure names the claim', w.failed[0]?.what === 'it is 440px wide', JSON.stringify(w.failed));
    check('the state was read once, not before the wait', w.reads === 1, String(w.reads));
  }

  // ── the caption quotes the state at the shutter, never the earlier one ────
  {
    const w = world();
    const ok = await w.state(
      'matrix-1024x665',
      (g) => `Inspector ${g.inspectorW}px, ${g.mode}`,
      // Claims that are true of the LIVE state, so this one gets captured.
      async (g) => [['the panel is presenting something', typeof g.mode === 'string', JSON.stringify(g)]],
      w.read
    );
    check('a state whose claims hold is captured', ok === true);
    check('the caption is built from the capture-time state', w.captured[0]?.caption === 'Inspector 260px, index', JSON.stringify(w.captured));
    check('not from the geometry before the wait', !/440/.test(w.captured[0]?.caption || ''), JSON.stringify(w.captured));
    check('and it describes what the shutter saw', w.shutter?.inspectorW === 260, JSON.stringify(w.shutter));
  }

  // ── claims and caption cannot disagree: one object, handed to both ────────
  {
    const w = world();
    let claimed = null;
    await w.state(
      'one-object',
      (g) => {
        check('the caption gets the same object the claims got', g === claimed, JSON.stringify({ g, claimed }));
        return 'x';
      },
      async (g) => {
        claimed = g;
        return [];
      },
      w.read
    );
  }

  // ── a state that asks for no reading still works, and gets nothing ────────
  {
    const w = world();
    const ok = await w.state('plain', 'a fixed caption', async (g) => [['there is no state to read', g === null]]);
    check('a state with no reader is captured on its own claims', ok === true);
    check('and keeps its literal caption', w.captured[0]?.caption === 'a fixed caption', JSON.stringify(w.captured));
    check('and never called a reader', w.reads === 0, String(w.reads));
  }

  // ── a reader that throws is a failure, not a picture ──────────────────────
  {
    const w = world();
    w.read = async () => {
      throw new Error('the window went away');
    };
    const ok = await w.state('broken', (g) => `never ${g}`, async () => [['unreachable', true]], w.read);
    check('a state whose reading throws is not captured', ok === false);
    check('nothing was photographed', w.captures === 0, String(w.captures));
    check('and the reason is reported', /went away/.test(w.failed[0]?.detail || ''), JSON.stringify(w.failed));
  }

  // ── one failed claim is enough, and every failure is reported ─────────────
  {
    const w = world();
    const ok = await w.state(
      'several',
      'c',
      async () => [
        ['this one holds', true],
        ['this one does not', false, 'measured 260'],
        ['nor does this one', false],
      ],
      w.read
    );
    check('one broken claim stops the capture', ok === false && w.captures === 0);
    check('and every broken claim is reported', w.failed.length === 2, JSON.stringify(w.failed));
    check('with the detail that was measured', w.failed[0]?.detail === 'measured 260', JSON.stringify(w.failed));
  }

  if (failures.length) {
    console.error(`\nasserted-state: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`asserted-state: ${checked} passed  [claims, caption and pixels are one moment]`);
})();
