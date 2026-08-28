// Load the deployed share page, click Open Stacki, print the url it offers.
//
//   STACKI_PUBLIC_RELAY=… STACKI_CAPABILITY=… npx electron test/support/publicPageHandover.js
//
// A helper, not a test. It exists because the two halves of the public
// deep-link proof want different runtimes: loading a real page needs Chromium,
// and driving the packaged app over the DevTools protocol needs a global
// `WebSocket`, which the Node that Electron bundles does not have. So the
// browser half lives here, prints one line of JSON, and exits.

process.env.STACKI_NO_DIALOGS = '1';
process.env.STACKI_HIDDEN_WINDOW = '1';

const fs = require('fs');
const { app, BrowserWindow } = require('electron');

// Closing the window mid-run must not end the process; Electron's default is
// to quit, which looks exactly like success with no output.
app.on('window-all-closed', () => {});

const BASE = (process.env.STACKI_PUBLIC_RELAY || '').replace(/\/+$/, '');
const CAPABILITY = process.env.STACKI_CAPABILITY || '';
const out = (obj) => fs.writeSync(1, JSON.stringify(obj) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await app.whenReady();

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { partition: `handover-${Date.now()}`, contextIsolation: true, nodeIntegration: false },
  });

  // What the page offers the operating system, caught rather than followed.
  const handedOver = [];
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http')) {
      event.preventDefault();
      handedOver.push(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    handedOver.push(url);
    return { action: 'deny' };
  });

  await win.loadURL(`${BASE}/#${CAPABILITY}`);
  await wait(1200);
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const readable = await js(`!document.getElementById('ready').classList.contains('hidden')`);
  const hashAfter = await js('location.hash');
  const hrefAfter = await js('location.href');

  // Fire, do not await: the click navigates the frame away, and awaiting the
  // evaluate that caused it waits on a promise the departing frame never
  // settles.
  js(`document.getElementById('open').click()`).catch(() => {});
  for (let i = 0; i < 40 && handedOver.length === 0; i++) await wait(200);

  out({ readable, hashAfter, hrefAfter, handedOver });
  app.exit(0);
})().catch((err) => {
  out({ error: String(err?.message || err) });
  app.exit(1);
});
