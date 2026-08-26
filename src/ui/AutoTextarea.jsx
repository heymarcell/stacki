import React, { useLayoutEffect, useRef } from 'react';

// Textarea that grows and shrinks to fit its content. Height tracks the
// value on every change (and on width changes via ResizeObserver, since
// wrapping depends on width).
export default function AutoTextarea({ value, minRows = 2, maxRows = 0, style, ...props }) {
  const ref = useRef(null);

  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // +2 accounts for the 1px top/bottom borders (border-box sizing).
    const wanted = el.scrollHeight + 2;
    if (maxRows > 0) {
      // Grow to a limit, then let the field scroll inside itself. Without a
      // ceiling a long draft pushes the conversation it is a reply to off the
      // screen, which is the wrong way round.
      const line = parseFloat(getComputedStyle(el).lineHeight) || 18;
      const ceiling = Math.round(line * maxRows + 12);
      el.style.height = Math.min(wanted, ceiling) + 'px';
      el.style.overflowY = wanted > ceiling ? 'auto' : 'hidden';
      return;
    }
    el.style.height = wanted + 'px';
  };

  useLayoutEffect(fit, [value, maxRows]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={value}
      style={{ overflow: 'hidden', resize: 'none', ...style }}
      {...props}
    />
  );
}
