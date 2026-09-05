// The Assets panel's own undo entries, built from where the file actually went.
//
// Used by test/undo-transaction.js; not a test on its own.
//
// The Agent API side of this defect has a suite already (test/asset-undo.js):
// `assets:rename` strips `/` and `\` out of a name and `assets:move` renames
// around a collision, so an inverse computed from the ARGUMENTS names a path
// the file is not at. The panel is the other caller of those two handlers and
// had the same bug with no test on it at all.
//
// So the panel is mounted for real — the real component, the real main-process
// handlers, a real project on disk — and driven the way a person drives it: a
// double-click on the name, a new name typed in, Enter. The oracle is the bytes
// on disk read by this process afterwards.

const fs = require('node:fs');
const path = require('node:path');

const ORIGINAL = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>\n';
const OTHER = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="8"/></svg>\n';

async function bundlePanel() {
  const esbuild = require('esbuild');
  const dir = path.join(__dirname, '..', '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'undo-txn-panel.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', '..', 'src', 'panels', 'AssetsPanel.jsx')],
    outfile: out,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
  });
  return out;
}

/**
 * Rename and move an asset through the panel, and run the undo entries it
 * recorded.
 *
 * `check` is the caller's own assertion counter, so these land in one report
 * with the rest. `callMain` reaches the real ipcMain handlers. The project is
 * this function's own and is removed before it returns.
 */
async function assetsPanelInverses({ check, makeProject, removeProject, callMain }) {
  const root = makeProject({
    'public/panel.svg': ORIGINAL,
    'public/logo.svg': ORIGINAL,
    'public/img/logo.svg': OTHER,
  });
  const at = (rel) => {
    const full = path.join(root, rel);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  };

  const bundle = await bundlePanel();
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const saved = {
    window: global.window,
    document: global.document,
    navigator: global.navigator,
    Element: global.Element,
    HTMLElement: global.HTMLElement,
    Node: global.Node,
    MouseEvent: global.MouseEvent,
    ResizeObserver: global.ResizeObserver,
    act: global.IS_REACT_ACT_ENVIRONMENT,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.MouseEvent = dom.window.MouseEvent;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  global.ResizeObserver = dom.window.ResizeObserver;

  // The panel's bridge, wired to the handlers the shipped app reaches. Only the
  // thumbnailer is stubbed: it wants an image decoder this process has no use
  // for, and no assertion here is about a picture.
  dom.window.avb = {
    listAssets: (projectPath) => callMain('assets:list', projectPath),
    renameAsset: (payload) => callMain('assets:rename', payload),
    moveAsset: (payload) => callMain('assets:move', payload),
    deleteAsset: (payload) => callMain('assets:delete', payload),
    uploadAssets: (payload) => callMain('assets:upload', payload),
    onAssetsChanged: () => () => {},
    assetThumb: async () => ({ dataUrl: null }),
    getFilePath: () => '',
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const AssetsPanel = require(bundle).default;
  const settle = (ms = 40) => new Promise((done) => setTimeout(done, ms));

  const recorded = [];
  const container = dom.window.document.getElementById('root');
  const reactRoot = createRoot(container);
  const draw = async () => {
    await act(async () => {
      reactRoot.render(
        React.createElement(AssetsPanel, {
          project: { path: root },
          showToast: () => {},
          onOpenFile: () => {},
          onRecordUndo: (entry) => recorded.push(entry),
        })
      );
      await settle(80);
    });
  };

  const fire = async (el, type, init = {}) => {
    if (!el) return false;
    await act(async () => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      el.dispatchEvent(event);
      await settle(60);
    });
    return true;
  };

  const tileFor = (name) =>
    [...container.querySelectorAll('.asset-tile')].find((tile) => tile.querySelector('.asset-name')?.textContent === name) ||
    null;

  try {
    await draw();
    // The panel opens above the roots, where only folders are; step into the
    // one holding the files.
    const publicFolder = [...container.querySelectorAll('.asset-folder')].find(
      (el) => el.textContent.includes('public')
    );
    await fire(publicFolder, 'click');
    check('the panel lists the fixture assets', !!tileFor('panel.svg'), [...container.querySelectorAll('.asset-name')].map((e) => e.textContent).join(','));

    // ── A NAME THE HANDLER WILL NOT USE AS TYPED ────────────────────────────
    //
    // `assets:rename` strips the slash, so 'sub/PANEL.svg' lands as
    // 'subPANEL.svg'. An inverse built from what was typed names
    // 'public/sub/PANEL.svg', which is nothing.
    {
      const TYPED = 'sub/PANEL.svg';
      const name = tileFor('panel.svg')?.querySelector('.asset-name');
      await fire(name, 'dblclick');
      const input = container.querySelector('input');
      check('double-clicking a name offers to rename it', !!input, container.innerHTML.slice(0, 200));
      if (input) {
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, TYPED);
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
          await settle(20);
        });
        // React listens for `focusout`, not `blur`, so a non-bubbling blur
        // never reaches the panel's `onBlur` — which is where a rename is
        // committed.
        check('  the typed name reaches the field', input.value === TYPED, input.value);
        await act(async () => {
          input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
          await settle(150);
        });
      }
      check('the rename lands under the name the handler chose', at('public/subPANEL.svg') === ORIGINAL, String(at('public/subPANEL.svg')));
      check('  and not under the one that was typed', at('public/sub/PANEL.svg') === null);
      check('  and it went on the undo stack', recorded.length === 1, String(recorded.length));

      if (recorded.length === 1) {
        let threw = null;
        await act(async () => {
          try {
            await recorded[0].undo();
          } catch (err) {
            threw = String(err?.message || err);
          }
          await settle(80);
        });
        check('the panel’s own undo does not throw', threw === null, threw);
        check('  and puts the file back under its original name', at('public/panel.svg') === ORIGINAL, String(at('public/panel.svg')));
        check('  with nothing left under the sanitised one', at('public/subPANEL.svg') === null, String(at('public/subPANEL.svg')));
      }
    }

    // ── A MOVE THE HANDLER RENAMED AROUND ──────────────────────────────────
    //
    // public/logo.svg dropped into public/img, which already holds a logo.svg.
    // The file lands as logo-1.svg, and the inverse this used to record moved
    // the OTHER logo.svg — the one that was already there — out over the top of
    // the original.
    recorded.length = 0;
    {
      await draw();
      const imgFolder = [...container.querySelectorAll('.asset-folder')].find((el) => el.textContent.includes('img'));
      check('the img folder is on screen to drop onto', !!imgFolder, [...container.querySelectorAll('.asset-folder')].map((e) => e.textContent).join(','));
      if (imgFolder) {
        await act(async () => {
          const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
          event.dataTransfer = {
            types: ['avb/asset'],
            files: [],
            getData: (kind) => (kind === 'avb/asset' ? 'public/logo.svg' : ''),
          };
          imgFolder.dispatchEvent(event);
          await settle(150);
        });
      }
      check('the drop moved the file, around the collision', at('public/img/logo-1.svg') === ORIGINAL, String(at('public/img/logo-1.svg')));
      check('  leaving the file that was already there alone', at('public/img/logo.svg') === OTHER, String(at('public/img/logo.svg')));

      // There is no one-step inverse for a move that also renamed, so the
      // honest answer is not to record one.
      //
      // AND THIS USED TO CLAIM MORE THAN IT PROVED. The sentence was "the
      // pre-existing file is still where it was, WHATEVER THE UNDO DID", over a
      // `for (const entry of recorded)` that ran ZERO times — the line under it
      // asserts `recorded.length === 0` — so nothing but the move handler had
      // ever touched that folder and no undo was run against it at all. What
      // the move alone establishes is claimed here; the undo that has to leave
      // the pre-existing file alone is driven for real underneath, by a move
      // that DOES record an inverse.
      check('  nothing is recorded, because no single move puts that name back', recorded.length === 0, String(recorded.length));
      check(
        '  and the move itself left the file that was already there alone',
        at('public/img/logo.svg') === OTHER,
        String(at('public/img/logo.svg'))
      );

      // ── AND A RECORDED INVERSE, RUN AGAINST THAT SAME FOLDER ───────────────
      //
      // panel.svg — back under its own name from the rename section above —
      // dropped into public/img, where nothing collides with it. The panel
      // records a move inverse for that, and running it has to bring the file
      // back and leave the logo.svg that was already living there untouched.
      await draw();
      const intoImg = [...container.querySelectorAll('.asset-folder')].find((el) => el.textContent.includes('img'));
      check('the img folder is still on screen for a second drop', !!intoImg, [...container.querySelectorAll('.asset-folder')].map((e) => e.textContent).join(','));
      if (intoImg) {
        await act(async () => {
          const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
          event.dataTransfer = {
            types: ['avb/asset'],
            files: [],
            getData: (kind) => (kind === 'avb/asset' ? 'public/panel.svg' : ''),
          };
          intoImg.dispatchEvent(event);
          await settle(150);
        });
      }
      check('a move with nothing in its way lands under its own name', at('public/img/panel.svg') === ORIGINAL, String(at('public/img/panel.svg')));
      check('  and this one IS recorded', recorded.length === 1, String(recorded.length));
      let ran = 0;
      for (const entry of recorded) {
        await act(async () => {
          try {
            await entry.undo();
            ran += 1;
          } catch {
            /* an inverse that refuses is not the failure this is about */
          }
          await settle(80);
        });
      }
      check('  the recorded inverse really ran', ran === 1, String(ran));
      check('  and put the file back where it came from', at('public/panel.svg') === ORIGINAL && at('public/img/panel.svg') === null, String(at('public/panel.svg')));
      check(
        'THE PRE-EXISTING FILE IS STILL WHERE IT WAS, with a real undo run over that folder',
        at('public/img/logo.svg') === OTHER,
        String(at('public/img/logo.svg'))
      );
    }

    // ── POSITIVE CONTROL ───────────────────────────────────────────────────
    //
    // An ordinary rename, with nothing unusual about it, still records an undo
    // that works. Everything above is satisfied by a panel that records
    // nothing at all.
    recorded.length = 0;
    {
      await draw();
      const TYPED = 'renamed.svg';
      const name = tileFor('panel.svg')?.querySelector('.asset-name');
      await fire(name, 'dblclick');
      const input = container.querySelector('input');
      if (input) {
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, TYPED);
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
          await settle(20);
        });
        // React listens for `focusout`, not `blur`, so a non-bubbling blur
        // never reaches the panel's `onBlur` — which is where a rename is
        // committed.
        check('  the typed name reaches the field', input.value === TYPED, input.value);
        await act(async () => {
          input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
          await settle(150);
        });
      }
      check('an ordinary rename through the panel still renames', at('public/renamed.svg') === ORIGINAL, String(at('public/renamed.svg')));
      check('  and records exactly one undo', recorded.length === 1, String(recorded.length));
      for (const entry of recorded) {
        await act(async () => {
          await entry.undo();
          await settle(80);
        });
      }
      check('  which puts the name back', at('public/panel.svg') === ORIGINAL, String(at('public/panel.svg')));
      check('  and takes the new one away', at('public/renamed.svg') === null, String(at('public/renamed.svg')));
    }
  } finally {
    try {
      await act(async () => {
        reactRoot.unmount();
      });
    } catch {
      /* a root that will not unmount does not fail a test */
    }
    dom.window.close();
    for (const [key, value] of Object.entries(saved)) {
      if (key === 'act') global.IS_REACT_ACT_ENVIRONMENT = value;
      else global[key] = value;
    }
    removeProject(root);
  }
  check('the panel fixture is gone', !fs.existsSync(root), root);
}

module.exports = { assetsPanelInverses };
