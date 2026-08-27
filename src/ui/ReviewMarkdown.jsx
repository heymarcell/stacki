import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// What a comment's words look like once they are saved.
//
// Review bodies used to be `white-space: pre-wrap`, which was right when a
// comment was a sentence about a heading. It is not right any more: an agent
// working through a thread writes what it changed, in lists, with file names in
// backticks and diffs in fences, and a wall of grey pre-wrap makes that
// genuinely hard to read.
//
// So saved messages render as Markdown. The COMPOSER stays a plain textarea —
// what somebody types is what the store holds, byte for byte, because the
// thread is also an API surface that an agent reads back.
//
// The whole security posture is: no raw HTML, ever, and no link Stacki would
// not be willing to open.
//
//   react-markdown does not render embedded HTML unless rehype-raw is added.
//   It is not added, and should not be — a comment body can be written by an
//   agent, and an agent that could put HTML in a comment could put a script
//   tag in the editor's own renderer.
//
//   Links are checked twice. `urlTransform` drops anything that is not http,
//   https or mailto before it can reach an href, and the anchor component
//   checks again before doing anything with it. javascript: and data: are the
//   two that matter and both are refused.
//
//   Opening goes through the main process, which refuses non-http schemes a
//   third time. Nothing here navigates the renderer: the editor following a
//   link out of its own UI would replace Stacki with a web page.

// The same three schemes electron/externalLinks.js allows, kept in step by
// test/review-ui.js, which drives one table of urls through BOTH and fails if
// they ever disagree.
//
// Deliberately a copy rather than an import: that module is CommonJS because
// the main process requires it, and the renderer bundle cannot consume it as
// ESM. The main process stays the authority — this is the check that stops a
// link Stacki would refuse from being drawn as a live one in the first place.
const SAFE_SCHEME = /^(https?:|mailto:)/i;

/** Anything a person could not have typed into a link: spaces, tabs, newlines, controls. */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

/**
 * The url, if Stacki will open it. Null if it will not.
 *
 * A url carrying whitespace or a control character is refused outright rather
 * than stripped and retried — `java\nscript:` is the oldest trick there is and
 * it survives a naive prefix test, and sanitising would mean deciding what
 * somebody meant and then handing the original string on anyway.
 */
export function safeHref(url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return null;
  if (CONTROL_OR_SPACE.test(raw)) return null;
  if (!SAFE_SCHEME.test(raw)) return null;
  return raw;
}

/** react-markdown asks this before a url ever becomes an attribute. */
const urlTransform = (url) => safeHref(url) || '';

/**
 * A link in a comment.
 *
 * Rendered as an anchor so it reads and selects like one, but it never
 * navigates: the click is taken over and handed to the main process, which
 * opens it in the person's browser. An unsafe href is not a link at all — it
 * is drawn as the text somebody wrote, which is honest and inert.
 */
function ReviewLink({ href, children, ...rest }) {
  const safe = safeHref(href);
  if (!safe) {
    return (
      <span className="review-md-deadlink" title="Stacki only opens http, https and mailto links">
        {children}
      </span>
    );
  }
  return (
    <a
      {...rest}
      href={safe}
      className="review-md-link"
      title={safe}
      onClick={(e) => {
        // Every button, and every modifier. A middle click or a ⌘-click on a
        // plain anchor is still a navigation, and in an Electron renderer
        // that means the editor itself goes somewhere.
        e.preventDefault();
        e.stopPropagation();
        window.avb?.openExternal?.(safe);
      }}
      onAuxClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {children}
    </a>
  );
}

/** Fenced code, with a way to take it away. */
function CodeBlock({ children }) {
  const [copied, setCopied] = React.useState(false);
  const text = React.useMemo(() => extractText(children), [children]);
  return (
    <div className="review-md-pre-wrap">
      <pre className="review-md-pre">{children}</pre>
      {text ? (
        <button
          type="button"
          className="review-md-copy"
          title="Copy"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void navigator.clipboard?.writeText(text).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              },
              () => {}
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      ) : null}
    </div>
  );
}

/** The text inside a rendered node, for the copy button. */
function extractText(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node)) return extractText(node.props?.children);
  return '';
}

// Everything a review body may become. Anything not named here falls through
// to react-markdown's own element, and since raw HTML never reaches it the set
// is closed by construction.
const COMPONENTS = {
  a: ReviewLink,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  // Headings in a comment are somebody writing a title, not structure in a
  // document, so they are levelled down to something that fits a card rather
  // than rendering an h1 the size of the panel.
  h1: ({ children }) => <p className="review-md-h">{children}</p>,
  h2: ({ children }) => <p className="review-md-h">{children}</p>,
  h3: ({ children }) => <p className="review-md-h">{children}</p>,
  h4: ({ children }) => <p className="review-md-h">{children}</p>,
  h5: ({ children }) => <p className="review-md-h">{children}</p>,
  h6: ({ children }) => <p className="review-md-h">{children}</p>,
  // An image in a comment would be a remote fetch from the editor on behalf of
  // whoever wrote the comment. Shown as its alt text instead.
  img: ({ alt, src }) => <span className="review-md-deadlink">{alt || src || 'image'}</span>,
  input: () => null,
};

/**
 * One message body.
 *
 * `text` is exactly what the store holds. Nothing is trimmed, normalised or
 * repaired on the way in — what an agent wrote is what is rendered, and what
 * comes back out of the store is still what it wrote.
 */
function ReviewMarkdown({ text }) {
  const body = typeof text === 'string' ? text : '';
  if (!body) return null;
  return (
    <div className="review-body review-md">
      <Markdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={COMPONENTS}>
        {body}
      </Markdown>
    </div>
  );
}

/**
 * Memoized on the words, and it has to be.
 *
 * ReviewThread owns the reply draft, so every keystroke in the reply box
 * re-renders the whole thread — and re-rendering this means parsing the
 * Markdown again. On a forty-message conversation that is forty documents
 * re-parsed per character typed, for messages nobody has touched.
 *
 * `text` is the only input, so the comparison is the whole story: a body that
 * has not changed does not re-render. The one being edited is a different
 * element with different text and re-renders as it should.
 */
export default React.memo(ReviewMarkdown, (a, b) => a.text === b.text);
