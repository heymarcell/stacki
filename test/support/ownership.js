// What a run owns, written down before anything can delete it.
//
// The lifecycle oracle used to work by difference: list the temp directories
// before the child, list them after, and look for processes running out of
// whatever appeared. That is blind to the leak this project found in large
// numbers — a child that deletes its project and userData SUCCESSFULLY and
// leaves a process running out of the now-deleted directory. The difference is
// empty, so there is no path to search for, so `strayProcesses([])` is empty,
// so the run is declared clean while a server holds a port.
//
// So ownership is RECORDED rather than inferred. The child writes down the
// identity of everything it acquires — the app's pid and the command it was
// launched as, the dev server's pid, the ports, the exact paths — at the moment
// it acquires them, and the parent verifies those identities after the child has
// exited and forgotten them.
//
// Identity, never category. A pid is checked together with the command line it
// was recorded with, so a pid the operating system has since handed to something
// else is not mistaken for a leak. Nothing here matches on `node`, `astro` or
// `electron`: those are what a leak happens to be made of, not what makes it
// this run's.

const fs = require('node:fs');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

/** The command line a pid is running under, or null if it is gone. */
function commandOf(pid) {
  if (!pid) return null;
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.trim();
    return line || null;
  } catch {
    return null;
  }
}

/** Whether a pid exists at all, when its command line cannot be read. */
function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** Every process whose command line names this exact path. */
function processesUnder(dir) {
  if (!dir) return [];
  try {
    return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\n')
      .map((line) => {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), command: m[2] } : null;
      })
      .filter((p) => p && p.command.includes(dir));
  } catch {
    return [];
  }
}

const portBusy = (port) =>
  new Promise((done) => {
    if (!port) return done(false);
    const socket = net.connect({ port: Number(port), host: '127.0.0.1' });
    const settle = (busy) => {
      socket.destroy();
      done(busy);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    setTimeout(() => settle(false), 500).unref?.();
  });

/**
 * A manifest a run writes as it acquires things.
 *
 * Written through on every change rather than at the end, because the whole
 * point is to survive a child that dies badly — a crash between acquiring a
 * server and recording it is the one case this cannot cover, and flushing on
 * every claim makes that window as small as it can be.
 */
function createManifest(file) {
  const state = { processes: [], ports: [], paths: [], completed: false };
  const flush = () => {
    if (!file) return;
    try {
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      /* the parent will report the manifest missing, which is the right failure */
    }
  };
  return {
    file,
    /** A process this run started or caused to exist. `what` is for the report. */
    /**
     * A process this run started or caused to exist.
     *
     * Recorded EVEN IF its command line cannot be read. Dropping the claim was
     * the same mistake this file exists to correct, one level down: a resource
     * the run owns, which could not be written down, becomes a resource nobody
     * owns. `ps` can fail for reasons that have nothing to do with the process
     * — it can lose the race with a pid that has only just appeared — so the
     * read is retried briefly, and a claim that still cannot be verified is
     * kept and marked rather than thrown away.
     */
    process(what, pid) {
      if (!pid) return;
      if (state.processes.some((p) => p.pid === Number(pid))) return;
      let command = commandOf(pid);
      for (let i = 0; i < 4 && !command; i += 1) {
        const until = Date.now() + 50;
        while (Date.now() < until) { /* a short pause; callers here are not async */ }
        command = commandOf(pid);
      }
      state.processes.push({ what, pid: Number(pid), command: command ?? null, unverifiable: !command });
      flush();
    },
    /** Everything running out of a directory this run owns, claimed at once. */
    processesUnder(what, dir) {
      for (const found of processesUnder(dir)) {
        if (state.processes.some((p) => p.pid === found.pid)) continue;
        state.processes.push({ what: `${what} (${found.command.split(/[\s]/)[0].split('/').pop()})`, pid: found.pid, command: found.command, unverifiable: false });
      }
      flush();
    },
    /** A port this run bound, or caused to be bound. */
    port(what, port) {
      if (!port) return;
      if (state.ports.some((p) => p.port === Number(port))) return;
      state.ports.push({ what, port: Number(port) });
      flush();
    },
    /** A directory this run created and must remove. */
    path(what, dir) {
      if (!dir) return;
      state.paths.push({ what, path: String(dir) });
      flush();
    },
    /**
     * The run got as far as owning what a run owns, and is now accounting for
     * it. Without this a manifest with three entries — written before the app
     * is even spawned — looks exactly like a finished one, and "it recorded
     * what it owned" is satisfied by a child that died at launch.
     */
    complete() {
      state.completed = true;
      flush();
    },
    read: () => JSON.parse(JSON.stringify(state)),
  };
}

/**
 * What survived, judged against a manifest.
 *
 * A recorded process counts as leaked only if the pid is alive AND is still
 * running the command it was recorded with; a pid reused by the operating
 * system for something else is not this run's leak.
 *
 * Given a grace period, this waits: ending a process and releasing a port are
 * not instantaneous, and calling a leak at the first look would be as wrong as
 * never looking.
 */
async function residueOfManifest(manifest, { graceMs = 12000, everyMs = 400 } = {}) {
  const look = async () => {
    const processes = manifest.processes.filter((p) => {
      // A claim whose command line could never be read is judged on the pid
      // alone. That is weaker evidence — the operating system may have handed
      // the number to something else — so it is reported as possible rather
      // than dropped, which is the direction a cleanup gate should err in.
      if (p.unverifiable || p.command == null) return pidAlive(p.pid);
      const now = commandOf(p.pid);
      return now !== null && now === p.command;
    });
    const ports = [];
    for (const p of manifest.ports) if (await portBusy(p.port)) ports.push(p);
    const paths = manifest.paths.filter((p) => fs.existsSync(p.path));
    return { processes, ports, paths };
  };
  const deadline = Date.now() + graceMs;
  let seen = await look();
  while ((seen.processes.length || seen.ports.length || seen.paths.length) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, everyMs));
    seen = await look();
  }
  return seen;
}

const describeManifestResidue = ({ processes, ports, paths }) =>
  [
    processes.length ? `${processes.length} process(es): ${processes.map((p) => `${p.what} pid ${p.pid}`).join(', ')}` : '',
    ports.length ? `${ports.length} port(s) still bound: ${ports.map((p) => `${p.what} ${p.port}`).join(', ')}` : '',
    paths.length ? `${paths.length} path(s) still present: ${paths.map((p) => p.what).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');

module.exports = { createManifest, residueOfManifest, describeManifestResidue, commandOf, pidAlive, processesUnder, portBusy };
