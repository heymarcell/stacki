// Serving the share landing page, with the headers that make it safe to.
//
// The page itself is one file with one inline script. The Content-Security-
// Policy served with it is what turns "we did not add analytics" into "this
// page cannot load analytics": `default-src 'none'` means no script, style,
// image, font, frame, connection or form target from anywhere at all, and the
// single inline script is allowed by its SHA-256 rather than by
// `'unsafe-inline'` — so an edit that changes that script breaks the page
// loudly instead of quietly widening what may run on it.
//
// The hash is computed from the file at startup rather than written down,
// because a hash somebody has to remember to update is a hash that will be
// wrong.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PAGE = path.join(__dirname, 'index.html');

/** The contents of the one inline script, for hashing. */
function inlineScript(html) {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  return match ? match[1] : null;
}

/**
 * The headers, as one object, so a test can assert them without a server.
 *
 * `frame-ancestors 'none'` rather than X-Frame-Options because this page holds
 * a capability in memory and must not be framed by anything that could then
 * watch it. `no-referrer` because the fragment is stripped from a Referer by
 * every correct browser and this is the belt to that's braces.
 */
function headersFor(html) {
  const script = inlineScript(html);
  const hash = script ? crypto.createHash('sha256').update(script, 'utf8').digest('base64') : null;
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': [
      "default-src 'none'",
      `script-src ${hash ? `'sha256-${hash}'` : "'none'"}`,
      "style-src 'unsafe-inline'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
    'x-robots-tag': 'noindex, nofollow',
    // The page is static and the capability is never in it, so caching is
    // harmless — but a shared machine's disk cache is not somewhere to leave a
    // page about somebody's private review either.
    'cache-control': 'no-store',
  };
}

/** A `(req, res)` handler for the Node relay, or null if the page is missing. */
function createLanding({ file = PAGE } = {}) {
  let html;
  try {
    html = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const headers = { ...headersFor(html), 'content-length': Buffer.byteLength(html) };
  return (req, res) => {
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : html);
  };
}

module.exports = { createLanding, headersFor, inlineScript, PAGE };
