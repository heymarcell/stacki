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

/** The only schemes a review may link to. */
const SAFE_SCHEME = /^(https?:|mailto:)/i;

/** Anything a person could not have typed into a link: spaces, tabs, newlines, controls. */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

/**
 * A relative link in a comment points at nothing — there is no document to be
 * relative to — so the test is absolute and strict rather than a sanitiser
 * that tries to rescue the string.
 */
export function safeHref(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return null;
  // A url carrying whitespace or a control character is not one somebody
  // typed. `java\nscript:` is the oldest trick there is and it survives a
  // naive prefix test, so such a url is refused outright rather than
  // stripped and retried — sanitising would mean deciding what they meant,
  // and then handing the original string on anyway.
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
export default function ReviewMarkdown({ text }) {
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
