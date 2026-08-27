import React from 'react';

// A stand-in for react-markdown that counts instead of parsing.
//
// Used by one measurement in test/review-ui.js, through an esbuild alias, so
// that "typing a reply does not reparse the conversation" can be answered with
// a number rather than an argument.
//
// Counting renders is the only way to see this. DOM identity does not show it:
// React reuses a node when it re-renders the element that produced it, so a
// component parsing its Markdown afresh on every keystroke leaves exactly the
// same nodes in place. That is what made the first attempt at this test pass
// with the memoization removed.

export const counter = { renders: 0 };

export default function CountingMarkdown({ children }) {
  counter.renders += 1;
  return <span className="counted-md">{children}</span>;
}
