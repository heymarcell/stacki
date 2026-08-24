import React from 'react';

// How an agent connects to this window.
//
// Stacki runs a small read-only MCP server so a coding agent can ask what is
// selected on the canvas and what it looks like. A background service on a
// port with a bearer token is exactly the sort of thing that should not be
// invisible, so this is where it is: whether it is up, where it is, how to
// connect, and — the one that matters when it isn't working — why it isn't.
//
// Deliberately not a settings screen. There is nothing to configure here; the
// port is fixed (STACKI_MCP_PORT overrides it) and the token is generated
// once. This is a status panel with three things to copy.

const CLIENTS = [
  {
    key: 'claude',
    label: 'Claude Code',
    hint: 'Run this in a terminal. --scope user registers it for every project, which is what you want: Stacki can switch projects, the endpoint does not.',
    text: ({ url, token }) =>
      `claude mcp add --transport http --scope user stacki ${url} --header "Authorization: Bearer ${token}"`,
  },
  {
    key: 'cursor',
    label: 'Cursor',
    hint: 'Put this in ~/.cursor/mcp.json (global) — or .cursor/mcp.json in one project, if you would rather it were not everywhere.',
    text: ({ url, token }) =>
      JSON.stringify(
        { mcpServers: { stacki: { url, headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2
      ),
  },
];

/** Copy without leaving the page. Falls back for anything that refuses. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const box = document.createElement('textarea');
      box.value = text;
      box.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(box);
      box.select();
      const ok = document.execCommand('copy');
      box.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export default function McpDialog({ status, onClose }) {
  const [client, setClient] = React.useState('claude');
  const [copied, setCopied] = React.useState(null);
  const [revealed, setRevealed] = React.useState(false);
  const closeRef = React.useRef(null);

  React.useEffect(() => {
    closeRef.current?.focus();
  }, []);

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  React.useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const running = !!status?.running;
  const url = status?.url || '';
  const token = status?.token || '';
  const chosen = CLIENTS.find((c) => c.key === client) || CLIENTS[0];
  const snippet = running ? chosen.text({ url, token }) : '';

  const copy = async (what, text) => {
    setCopied((await copyText(text)) ? what : 'failed');
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal mcp-dialog" role="dialog" aria-modal="true">
        <div className="modal-header">AI connection (MCP)</div>
        <div className="modal-body mcp-body">
          <div className={`mcp-status ${running ? 'on' : 'off'}`}>
            <span className="mcp-dot" />
            {running ? (
              <span>
                Running at <code>{url}</code>
              </span>
            ) : (
              <span>Not running</span>
            )}
          </div>

          {!running && (
            <p className="mcp-error">
              {status?.error ||
                'The server has not started yet. Reopen this window in a moment.'}
            </p>
          )}

          {running && (
            <>
              <p className="mcp-lead">
                A connected agent can ask Stacki what you have selected and take a picture of it.
                It cannot edit anything through this — your agent keeps using its own file tools.
              </p>

              <div className="mcp-tabs">
                {CLIENTS.map((c) => (
                  <button
                    key={c.key}
                    className={client === c.key ? 'on' : ''}
                    onClick={() => setClient(c.key)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <pre className="mcp-snippet">{revealed ? snippet : snippet.replace(token, '••••••••')}</pre>
              <p className="mcp-hint">{chosen.hint}</p>

              <div className="mcp-actions">
                <button className="primary" onClick={() => copy('config', snippet)}>
                  Copy {chosen.label} config
                </button>
                <button onClick={() => copy('token', token)}>Copy token</button>
                <button className="ghost" onClick={() => setRevealed((v) => !v)}>
                  {revealed ? 'Hide token' : 'Show token'}
                </button>
              </div>

              <p className="mcp-hint">
                The token is this machine's — it lives in Stacki's own data folder and never in
                your project. Keep it out of anything you commit.
              </p>
            </>
          )}
        </div>
        <div className="modal-footer">
          <span className="mcp-copied">
            {copied === 'failed' ? 'Could not copy.' : copied ? 'Copied.' : ''}
          </span>
          <button ref={closeRef} className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
