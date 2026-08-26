// What actually happens when Stacki is asked to open a link.
//
//   npx electron test/external-links.js
//
// Not a check of the policy function — test/review-ui.js does that, and a pure
// function agreeing with itself proves nothing about the wiring. This goes the
// whole way: `window.avb.openExternal(url)` in the real renderer, through the
// real preload, to the real handler in the real main process, with the only
// stub being `shell.openExternal` itself, so what the operating system would
// have been handed can be seen.
//
// It exists because that wiring lied. The renderer rendered `mailto:` as a
// clickable link, main.js opened only http and https, and the handler returned
// `{ ok: true }` either way — so a mail address in a comment looked live, was
// clicked, did nothing, and reported success. Every layer was individually
// defensible and the feature was broken.

process.env.STACKI_NO_DIALOGS = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { app, BrowserWindow } = electron;

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const say = (t) => fs.writeSync(1, `${t}\n`);
const shout = (t) => fs.writeSync(2, `${t}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// What the OS was handed. Replaced before main.js is required, because that is
// when the handler closes over `shell`.
const handed = [];
const realOpen = electron.shell.openExternal;
electron.shell.openExternal = async (url) => {
  handed.push(url);
  return undefined;
};

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-links-user-'));
app.setPath('userData', userData);
app.on('window-all-closed', () => {});

require('../electron/main.js');

const cleanup = [];

(async () => {
  await app.whenReady();
  const win = await (async () => {
    for (let i = 0; i < 200; i++) {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) return w;
      await wait(100);
    }
    throw new Error('no window');
  })();
  for (let i = 0; i < 200 && win.webContents.isLoading(); i++) await wait(100);
  await wait(400);

  /** Ask the way the app asks. */
  const open = async (url) => {
    handed.length = 0;
    const result = await win.webContents.executeJavaScript(
      `window.avb.openExternal(${JSON.stringify(url)}).then((r) => JSON.parse(JSON.stringify(r ?? null))).catch((e) => ({ threw: String(e) }))`,
      true
    );
    return { result, handed: [...handed] };
  };

  // --- what opens ----------------------------------------------------------
  for (const url of ['https://example.com/docs', 'http://example.com', 'mailto:design@example.com']) {
    const { result, handed: got } = await open(url);
    check(`${url} is opened`, result?.ok === true && result?.opened === true, JSON.stringify(result));
    check(`  and the OS was handed exactly it`, got.length === 1 && got[0] === url, JSON.stringify(got));
  }

  // A url with a case-shifted scheme is still that scheme.
  {
    const { result, handed: got } = await open('MailTo:someone@example.com');
    check('a scheme in odd case still opens', result?.ok === true, JSON.stringify(result));
    check('  and reaches the OS unchanged', got.length === 1, JSON.stringify(got));
  }

  // --- what does not -------------------------------------------------------
  //
  // Each of these is refused for its own reason, and the important half of the
  // assertion is the second one: nothing reached the operating system.
  const refused = [
    ['javascript:alert(1)', 'would run wherever it is opened'],
    ['data:text/html,<script>alert(1)</script>', 'can carry a whole document'],
    ['file:///etc/passwd', 'is the editor opening local files by path'],
    ['stacki-asset://thing', 'is the app’s own private scheme'],
    ['vbscript:msgbox', 'is executable too'],
    ['/just/a/path', 'is not a url at all'],
    ['', 'is nothing'],
  ];
  for (const [url, why] of refused) {
    const { result, handed: got } = await open(url);
    check(`${url || '(empty)'} is refused — ${why}`, result?.ok === false, JSON.stringify(result));
    check(`  and nothing reached the OS`, got.length === 0, JSON.stringify(got));
    check(`  and it says why rather than claiming success`, typeof result?.message === 'string' && result.message.length > 0, JSON.stringify(result));
  }

  // The trick that survives a naive prefix test.
  {
    const { result, handed: got } = await open('java\nscript:alert(1)');
    check('a scheme with a newline in it is refused', result?.ok === false, JSON.stringify(result));
    check('  and nothing reached the OS', got.length === 0, JSON.stringify(got));
  }

  // --- the contract the renderer relies on ---------------------------------
  //
  // ReviewMarkdown draws a link only for what it believes Stacki will open. If
  // these two ever disagree the result is either a dead link that looks live,
  // or a live one that looks dead.
  const { openableUrl } = require('../electron/externalLinks.js');
  const table = [
    'https://example.com',
    'http://example.com',
    'mailto:a@b.c',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'stacki-asset://x',
    '/relative',
    '',
  ];
  for (const url of table) {
    const { result } = await open(url);
    check(
      `the policy and the wiring agree about ${url || '(empty)'}`,
      !!openableUrl(url) === (result?.ok === true),
      `policy ${!!openableUrl(url)} vs bridge ${result?.ok}`
    );
  }

  return finish(failures.length ? 1 : 0);
})().catch((err) => {
  shout(`external-links: ${err?.stack || err}`);
  void finish(1);
});

/** Put everything back, and let a cleanup failure fail the run. */
async function finish(code) {
  const problems = [];
  electron.shell.openExternal = realOpen;
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.destroy();
    } catch (err) {
      problems.push(`window: ${String(err?.message || err)}`);
    }
  }
  try {
    await require('../electron/mcp').stopMcp();
  } catch (err) {
    problems.push(`mcp: ${String(err?.message || err)}`);
  }
  try {
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (err) {
    problems.push(`userData ${userData}: ${String(err?.message || err)}`);
  }
  for (const fn of cleanup) {
    try {
      await fn();
    } catch (err) {
      problems.push(String(err?.message || err));
    }
  }

  if (failures.length) {
    shout(`\nexternal-links: ${failures.length} failed, ${checked - failures.length} passed\n`);
    for (const f of failures) shout(f);
  }
  if (problems.length) {
    shout(`\nexternal-links: ${problems.length} cleanup failure(s)\n`);
    for (const p of problems) shout(`  ${p}`);
  }
  if (!failures.length && !problems.length) {
    say(`external-links: ${checked} passed  [renderer, preload, main, and what the OS was handed]`);
  }
  app.exit(failures.length || problems.length ? 1 : code);
}
