import React from 'react';

// How an agent connects to this window, and how much of it it may move.
//
// Stacki runs a small MCP server so a coding agent can ask what is selected on
// the canvas, what it looks like, and — since the Agent API — change it. A
// background service on a port with a bearer token is exactly the sort of thing
// that should not be invisible, so this is where it is: whether it is up, where
// it is, how to connect, and — the one that matters when it isn't working —
// why it isn't.
//
// It has one setting, and it is the one that had to be a setting. The token
// answers "is this our agent"; it has nothing to say about "should our agent be
// able to delete a branch", and that question is the user's. Three levels,
// because there are three genuinely different fears — see
// electron/mcp/agent/permissions.js — and the default is the most cautious one
// even for somebody who has been running this server for months, because an
// update must never quietly hand out a permission nobody was asked for.

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

// What each level means, in the terms somebody deciding would use.
//
// The words come from electron/mcp/agent/permissions.js, which is where the
// gate reads them from too — a window that described a level differently from
// what it grants is worse than one that describes nothing. The test in
// test/agent-api.js reads both files and checks they agree.
//
// The one thing this must not do is soften "Inspect project". It is the level
// at which an agent can read every file in the repository, and the earlier
// wording — "read what is on screen" — described the level below it.
const ACCESS = [
  {
    key: 'visual',
    label: 'Visual only',
    blurb:
      'See what you have selected and take a picture of it, and read and reply to your comments. ' +
      'It cannot read your project’s files.',
  },
  {
    key: 'inspect',
    label: 'Inspect project',
    blurb:
      'Also READ the project: the source of any file, your content and data, asset text, and the git ' +
      'history. Nothing changes, and everything in the repository becomes visible to the agent.',
  },
  {
    key: 'edit',
    label: 'Edit project',
    blurb:
      'Also change things: text, styles, structure, pages, content and assets — through Stacki, on the ' +
      'undo stack you can press ⌘Z on.',
  },
  {
    key: 'full',
    label: 'Full control',
    blurb:
      'Also the operations that are hard to take back or that reach the network: deletes, dependency ' +
      'installs, and git — commit, switch, restore, merge, push. Lasts this session and this project.',
  },
];

export default function McpDialog({ status, onClose }) {
  const [client, setClient] = React.useState('claude');
  const [copied, setCopied] = React.useState(null);
  const [revealed, setRevealed] = React.useState(false);
  const [access, setAccess] = React.useState(null);
  const closeRef = React.useRef(null);

  // The level as the main process has it FOR THE PROJECT THAT IS OPEN, which is
  // the one that is enforced. Read when the dialog opens rather than held
  // anywhere: this window is not where the answer lives, and the answer is
  // different in the next project.
  React.useEffect(() => {
    let alive = true;
    const read = window.avb.agentAccess;
    if (!read) {
      setAccess({ agentMode: 'visual', hasProject: false });
      return undefined;
    }
    void read()
      .then((state) => alive && setAccess(state || { agentMode: 'visual' }))
      .catch(() => alive && setAccess({ agentMode: 'visual' }));
    return () => {
      alive = false;
    };
  }, []);

  const chooseAccess = async (next) => {
    if (!window.avb.setAgentMode) return; // an older main process
    setAccess((was) => ({ ...(was || {}), agentMode: next }));
    const result = await window.avb.setAgentMode(next).catch(() => null);
    // What it actually settled on. A level this build does not know is refused
    // and comes back as the cautious one, and Full control is granted for this
    // session — the control should say what happened rather than what was
    // clicked.
    if (result?.agentMode) setAccess(result);
  };

  const level = access?.agentMode || null;

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
                A connected agent can ask Stacki what you have selected, take a picture of it, and —
                depending on what you allow below — change the exact thing you pointed at, through
                Stacki, on the undo stack you can press ⌘Z on.
              </p>

              <div className="mcp-access">
                <div className="mcp-access-title">
                  What a connected agent may do{access?.hasProject === false ? '' : ' in this project'}
                </div>
                <div className="mcp-access-options" role="radiogroup" aria-label="Agent access">
                  {ACCESS.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      role="radio"
                      aria-checked={level === option.key}
                      className={`mcp-access-option ${level === option.key ? 'on' : ''}`}
                      disabled={level === null || access?.hasProject === false}
                      onClick={() => chooseAccess(option.key)}
                    >
                      <span className="mcp-access-name">{option.label}</span>
                      <span className="mcp-access-blurb">{option.blurb}</span>
                    </button>
                  ))}
                </div>
                {access?.hasProject === false ? (
                  <p className="mcp-hint">
                    Open a project to set this. Access is granted per project, so a project you have not
                    opened yet starts at Visual only.
                  </p>
                ) : (
                  <p className="mcp-hint">
                    Granted for <strong>this project</strong>, not for Stacki — opening another one starts
                    it at Visual only again. Enforced by Stacki rather than asked of the agent, and you can
                    change it at any time; the next thing it tries obeys the new setting.
                    {access?.sessionOnly
                      ? ` Full control lasts until you quit Stacki; after that this project is back to ${
                          ACCESS.find((o) => o.key === access.persisted)?.label || 'Visual only'
                        }.`
                      : ''}
                  </p>
                )}
              </div>

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
