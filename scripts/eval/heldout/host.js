// A real MCP host, driven.
//
// The previous evaluation gave the agent a one-shot CLI that reconnected per
// command. That measured "how does a model behave when MCP is an unfamiliar
// program it must explore" — the agent was charged for the instructions and the
// tool schemas a real host injects for free, and the connection preamble was
// invisible. This runs Claude Code itself, mounted on Stacki the way a person
// would mount it.
//
// NOTHING HERE TOUCHES THE USER'S CONFIGURATION. Every run gets its own MCP
// config file inside its own workspace, `--strict-mcp-config` so no other server
// is loaded, `--setting-sources` emptied so no user, project or local settings
// file joins in, and `--no-session-persistence` so nothing is left behind.
// `~/.claude` is never written, and `claude mcp add` is never called.
//
// TWO MODES, NEVER MIXED IN ONE NUMBER.
//
//   mcp-only    `--tools ""`. The model has ZERO built-in tools: no Bash, no
//               Read, no Write, no web. Every action it takes is an MCP call to
//               Stacki, and that is provable from the transcript rather than
//               asserted. This is the mode that measures Stacki.
//   integrated  the ordinary Claude Code toolset plus the project directory.
//               This is what a real user has, and its MCP call count is
//               meaningless on its own — an agent that reads ten files with
//               Bash looks cheap. Those reads are counted separately and
//               reported separately.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

/** Where the `claude` binary is, or null. Never installed by this file. */
function claudeBinary() {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function claudeVersion() {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** The config a host is handed, written where only this trial can see it. */
function writeConfig(workspace, { url, token, name = 'stacki' }) {
  const file = path.join(workspace, 'mcp-config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ mcpServers: { [name]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 1),
    'utf8'
  );
  return file;
}

// THE ONLY DOOR TO A RESOURCE, AND IT IS A BUILT-IN TOOL.
//
// Claude Code does not hand MCP resources to the model directly. It reaches
// them through two built-in tools, `ListMcpResourcesTool` and
// `ReadMcpResourceTool`. A run started with `--tools ""` therefore has a
// perfectly healthy `resources/list` in its preamble and no way on earth to read
// any of them — measured, not assumed: the first dev-set trials called `page`,
// `content`, `asset` and `source` and read the project profile zero times,
// because the profile was unreachable.
//
// That is a fact about Stacki's reach, and it is recorded as one. Here it means
// the MCP-only mode must include these two: they are MCP access, not filesystem
// access, and excluding them would measure a Stacki whose entire Phase-B
// resource surface had been switched off.
const MCP_ACCESS_TOOLS = ['ListMcpResourcesTool', 'ReadMcpResourceTool'];

// Structured answers come back through a tool as well. It writes nothing and
// reads nothing; counting it as an escape from the sandbox would fail every
// trial that was asked for a structured answer.
const NOT_AN_ESCAPE = new Set([...MCP_ACCESS_TOOLS, 'StructuredOutput']);

/** The built-in tools a host may use, per mode. */
const TOOLSET = {
  // Everything Stacki can be asked, and nothing else: no Bash, no Read, no
  // Write, no Glob, no Grep, no web. Whether that held is checked from the
  // transcript rather than trusted.
  'mcp-only': MCP_ACCESS_TOOLS.join(','),
  integrated: 'default',
};

/**
 * Run one trial.
 *
 * Returns everything the transcript can say about what happened: the final
 * text, the structured answer if one was asked for, token usage, every tool the
 * model used and how often, and whether any permission was denied.
 */
function runHost({
  workspace,
  url,
  token,
  prompt,
  mode = 'mcp-only',
  model = 'sonnet',
  effort = null,
  schema = null,
  addDir = null,
  timeoutMs = 900000,
  log = () => {},
}) {
  const config = writeConfig(workspace, { url, token });
  const tools = TOOLSET[mode];
  if (tools === undefined) throw new Error(`unknown host mode ${mode}`);

  const args = [
    '-p',
    '--strict-mcp-config',
    '--mcp-config',
    config,
    '--tools',
    tools,
    '--allowedTools',
    mode === 'mcp-only'
      ? `mcp__stacki,${MCP_ACCESS_TOOLS.join(',')}`
      : `mcp__stacki,${MCP_ACCESS_TOOLS.join(',')},Bash,Read,Write,Edit,Glob,Grep`,
    '--permission-mode',
    'dontAsk',
    // No user, project or local settings file joins the run, so a hook or a
    // memory on the machine this happens to run on cannot change the result.
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
  ];
  if (effort) args.push('--effort', effort);
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (mode === 'integrated' && addDir) args.push('--add-dir', addDir);
  args.push(prompt);

  return new Promise((resolve) => {
    const began = Date.now();
    const child = spawn('claude', args, {
      cwd: workspace,
      // A trial must not inherit an interactive terminal's idea of anything.
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const events = [];
    const stderr = [];
    let rest = '';
    let result = null;

    child.stdout.on('data', (chunk) => {
      rest += chunk;
      const lines = rest.split('\n');
      rest = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          events.push(event);
          if (event.type === 'result') result = event;
        } catch {
          /* a partial line, or something that is not ours */
        }
      }
    });
    child.stderr.on('data', (c) => stderr.push(String(c)));

    const timer = setTimeout(() => {
      log(`host exceeded ${timeoutMs}ms; terminating`);
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 10000).unref?.();
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(workspace, 'host-transcript.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'), 'utf8');

      // WHAT THE MODEL ACTUALLY USED, from the transcript rather than from its
      // account of itself. An `assistant` message carries `tool_use` blocks;
      // each names the tool. MCP tools arrive as `mcp__<server>__<tool>`.
      const used = {};
      for (const e of events) {
        for (const block of e?.message?.content || []) {
          if (block?.type !== 'tool_use') continue;
          used[block.name] = (used[block.name] || 0) + 1;
        }
      }
      const mcpUsed = Object.fromEntries(Object.entries(used).filter(([n]) => n.startsWith('mcp__')));
      const resourceUsed = Object.fromEntries(Object.entries(used).filter(([n]) => MCP_ACCESS_TOOLS.includes(n)));
      // Anything that is neither an MCP call, nor the door to an MCP resource,
      // nor the structured-answer tool, is the model reaching outside Stacki.
      const escaped = Object.fromEntries(Object.entries(used).filter(([n]) => !n.startsWith('mcp__') && !NOT_AN_ESCAPE.has(n)));

      resolve({
        ok: code === 0 && !!result && result.is_error !== true,
        exitCode: code,
        timedOut: Date.now() - began >= timeoutMs,
        elapsedMs: Date.now() - began,
        text: typeof result?.result === 'string' ? result.result : null,
        // The host validates the answer against `--json-schema` and hands it
        // back here. Parsing the final text instead would make the check about
        // whether a model wrote well-formed JSON.
        structured:
          result?.structured_output ??
          (() => {
            if (typeof result?.result !== 'string') return null;
            try {
              return JSON.parse(result.result);
            } catch {
              return null;
            }
          })(),
        turns: result?.num_turns ?? null,
        usage: result?.usage
          ? {
              input: result.usage.input_tokens ?? 0,
              output: result.usage.output_tokens ?? 0,
              cacheRead: result.usage.cache_read_input_tokens ?? 0,
              cacheCreation: result.usage.cache_creation_input_tokens ?? 0,
            }
          : null,
        costUsd: result?.total_cost_usd ?? null,
        permissionDenials: (result?.permission_denials || []).length,
        toolUse: used,
        mcpToolCalls: Object.values(mcpUsed).reduce((a, b) => a + b, 0),
        resourceToolCalls: Object.values(resourceUsed).reduce((a, b) => a + b, 0),
        // THE NUMBER THAT KEEPS THE TWO MODES APART. In `mcp-only` this must be
        // zero, and a run where it is not is a run whose isolation failed and
        // whose MCP counts are therefore only part of what the model did.
        builtinToolCalls: Object.values(escaped).reduce((a, b) => a + b, 0),
        builtinUsed: escaped,
        stderr: stderr.join('').slice(-2000),
      });
    });
  });
}

module.exports = { runHost, writeConfig, claudeBinary, claudeVersion, TOOLSET };
