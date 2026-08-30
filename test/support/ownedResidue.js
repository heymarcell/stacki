// What a run left behind, asked of the machine rather than assumed.
//
// Cleanup used to be a `finally` nobody checked. That is how this repository
// ended a single afternoon with a hundred and thirty live processes — Astro dev
// servers, esbuild compilers and content-config children — every one of them
// still running against a fixture directory that had been deleted underneath
// it. Each individual teardown looked fine; nothing ever asked afterwards.
//
// So a harness records the directories it made, and at the end this answers two
// questions about them: is any of them still on disk, and is any process still
// pointing at one. Both are failures. Ownership is the fixture path — nothing
// here matches on a program's name, so it can never mistake somebody else's
// editor or dev server for the run's own.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

/** Every process on this machine, as `pid<TAB>command`. */
function processTable() {
  try {
    return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\n')
      .map((line) => {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), command: m[2] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function snapshot(owned) {
  const dirs = owned.filter((dir) => fs.existsSync(dir));
  const table = processTable();
  const processes = table.filter((p) => owned.some((dir) => p.command.includes(dir)));
  return { dirs, processes };
}

/**
 * What is left, after giving what was asked to stop a fair chance to stop.
 *
 * Ending a process is not instantaneous and neither is releasing the files it
 * had open, so this polls for a few seconds rather than photographing the
 * moment teardown returned. It is still a gate: what is here at the end of the
 * window really has outlived the run.
 *
 * @param {string[]} roots  fixture directories this run created
 * @returns {Promise<{ dirs: string[], processes: {pid:number, command:string}[] }>}
 */
async function residueOf(roots, { graceMs = 10000, everyMs = 400 } = {}) {
  const owned = [...new Set(roots.filter(Boolean))];
  const deadline = Date.now() + graceMs;
  let seen = snapshot(owned);
  while ((seen.dirs.length || seen.processes.length) && Date.now() < deadline) {
    // Ask again for what would not go. A fixture with node_modules in it is
    // often most of the way gone, with a fragment the operating system is still
    // unmapping an esbuild binary out of — removable a moment later. Trying
    // once and reporting a leak would be as wrong as never checking.
    for (const dir of seen.dirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* still held; the next round asks again */
      }
    }
    await new Promise((r) => setTimeout(r, everyMs));
    seen = snapshot(owned);
  }
  return seen;
}

/** A one-line account for a check's detail. */
function describeResidue({ dirs, processes }) {
  const parts = [];
  if (dirs.length) parts.push(`${dirs.length} fixture director${dirs.length === 1 ? 'y' : 'ies'} still on disk: ${dirs.slice(0, 3).join(', ')}`);
  if (processes.length) {
    parts.push(
      `${processes.length} process${processes.length === 1 ? '' : 'es'} still pointing at one: ` +
        processes.slice(0, 4).map((p) => `${p.pid} ${p.command.slice(0, 90)}`).join(' | ')
    );
  }
  return parts.join('; ');
}

module.exports = { residueOf, describeResidue, processTable };
