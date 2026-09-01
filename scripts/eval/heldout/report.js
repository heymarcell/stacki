// What happened, per task class, without averaging the classes together.
//
//   node scripts/eval/heldout/report.js <runsDir>
//
// A discovery task and a one-word edit want opposite things: one should fetch
// project-wide context, the other should not. A single "calls" number over both
// says nothing, and a single "improvement" number over both can be produced by
// making either one worse. So every table here is per class, every trial is
// printed including the ones the candidate lost, and a trial with no result file
// is printed as a failure rather than dropped — a dropped trial is the easiest
// way to make an evaluation say what you wanted.

const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2];
if (!dir) {
  console.error('need the runs directory');
  process.exit(2);
}

const rows = [];
for (const name of fs.readdirSync(dir).sort()) {
  const ws = path.join(dir, name);
  if (!fs.statSync(ws).isDirectory()) continue;
  const m = /^t(\d+)-(.+)-(baseline|candidate)$/.exec(name);
  if (!m) continue;
  const [, trial, task, arm] = m;
  try {
    rows.push({ ...JSON.parse(fs.readFileSync(path.join(ws, 'result.json'), 'utf8')), trial: Number(trial) });
  } catch {
    rows.push({ task, arm, trial: Number(trial), missing: true, ok: false });
  }
}

if (!rows.length) {
  console.log('no trials in', dir);
  process.exit(0);
}

const pad = (v, n) => String(v ?? '-').padEnd(n);
const num = (v) => (typeof v === 'number' ? String(v) : '-');
const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
};

const CLASSES = [...new Set(rows.map((r) => r.class || '?'))].sort();
const ARMS = ['baseline', 'candidate'].filter((a) => rows.some((r) => r.arm === a));

console.log('\n=== HELD-OUT EVALUATION — every trial ===\n');
console.log(
  pad('class', 14) + pad('task', 22) + pad('arm', 11) + pad('t', 3) + pad('pass', 6) + pad('calls', 7) + pad('prof', 6) + pad('res', 5) + pad('bytes', 9) + pad('pre-KB', 8) + pad('tok-out', 9) + pad('esc', 5) + pad('s', 6)
);
for (const cls of CLASSES) {
  for (const task of [...new Set(rows.filter((r) => (r.class || '?') === cls).map((r) => r.task))].sort()) {
    for (const arm of ARMS) {
      for (const r of rows.filter((x) => x.task === task && x.arm === arm).sort((a, b) => a.trial - b.trial)) {
        console.log(
          pad(cls, 14) +
            pad(task, 22) +
            pad(arm, 11) +
            pad(r.trial, 3) +
            pad(r.missing ? 'MISS' : r.ok ? 'YES' : 'no', 6) +
            pad(num(r.wire?.toolCalls), 7) +
            pad(num(r.wire?.projectProfileReads), 6) +
            pad(num(r.wire?.resourceReads), 5) +
            pad(num(r.wire?.responseBytes), 9) +
            pad(r.wire?.preambleBytes ? Math.round(r.wire.preambleBytes / 1024) : '-', 8) +
            pad(num(r.host?.usage?.output), 9) +
            pad(num(r.host?.builtinToolCalls), 5) +
            pad(r.elapsedMs ? Math.round(r.elapsedMs / 1000) : '-', 6)
        );
      }
    }
  }
}

console.log('\n=== PER CLASS, MEDIAN ===\n');
console.log(pad('class', 16) + pad('arm', 11) + pad('n', 4) + pad('pass', 7) + pad('calls', 7) + pad('profile', 9) + pad('bytes', 10) + pad('out-tok', 9) + pad('s', 6));
for (const cls of CLASSES) {
  for (const arm of ARMS) {
    const xs = rows.filter((r) => (r.class || '?') === cls && r.arm === arm);
    if (!xs.length) continue;
    console.log(
      pad(cls, 16) +
        pad(arm, 11) +
        pad(xs.length, 4) +
        pad(`${xs.filter((r) => r.ok).length}/${xs.length}`, 7) +
        pad(num(median(xs.map((r) => r.wire?.toolCalls))), 7) +
        pad(num(median(xs.map((r) => r.wire?.projectProfileReads))), 9) +
        pad(num(median(xs.map((r) => r.wire?.responseBytes))), 10) +
        pad(num(median(xs.map((r) => r.host?.usage?.output))), 9) +
        pad(Math.round((median(xs.map((r) => r.elapsedMs)) || 0) / 1000), 6)
    );
  }
}

console.log('\n=== CONNECTION PREAMBLE (paid once per session, before the task) ===\n');
console.log(pad('arm', 11) + pad('discover', 10) + pad('tools/list', 12) + pad('resources', 11) + pad('prompts', 10) + pad('total', 10));
for (const arm of ARMS) {
  const xs = rows.filter((r) => r.arm === arm && r.wire);
  if (!xs.length) continue;
  console.log(
    pad(arm, 11) +
      pad(num(median(xs.map((r) => r.wire.discoverBytes))), 10) +
      pad(num(median(xs.map((r) => r.wire.toolsListBytes))), 12) +
      pad(num(median(xs.map((r) => r.wire.resourcesListBytes))), 11) +
      pad(num(median(xs.map((r) => r.wire.promptsListBytes))), 10) +
      pad(num(median(xs.map((r) => r.wire.preambleBytes))), 10)
  );
}

console.log('\n=== SAFETY AND HONESTY ===\n');
for (const arm of ARMS) {
  const xs = rows.filter((r) => r.arm === arm);
  const leaked = xs.filter((r) => r.isolationHeld === false);
  const dirty = xs.filter((r) => (r.cleanupProblems || []).length);
  const errored = xs.filter((r) => r.error);
  console.log(
    `${pad(arm, 11)} trials=${xs.length}  isolation-broken=${leaked.length}  cleanup-problems=${dirty.length}  harness-errors=${errored.length}` +
      `  refusals=${xs.reduce((a, r) => a + (r.wire?.refusals || 0), 0)}` +
      `  tool-errors=${xs.reduce((a, r) => a + (r.wire?.toolErrors || 0), 0)}`
  );
  for (const r of dirty) console.log(`   cleanup ${r.task}: ${(r.cleanupProblems || []).join('; ')}`);
  for (const r of errored) console.log(`   error   ${r.task}: ${String(r.error).split('\n')[0]}`);
  for (const r of leaked) console.log(`   escaped ${r.task}: ${JSON.stringify(r.host?.builtinUsed)}`);
}

console.log('\n=== TOOLS ACTUALLY CALLED ===\n');
for (const arm of ARMS) {
  const counts = {};
  for (const r of rows.filter((x) => x.arm === arm)) {
    for (const [name, n] of r.wire?.byTool || []) counts[name] = (counts[name] || 0) + n;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log(`${arm}: ${sorted.map(([n, c]) => `${n}×${c}`).join('  ') || '(none)'}`);
}

const failures = rows.filter((r) => !r.ok);
if (failures.length) {
  console.log('\n=== WHY EACH FAILURE FAILED ===\n');
  for (const r of failures) {
    console.log(`${pad(r.arm, 11)}${pad(r.task, 22)}${r.error ? String(r.error).split('\n')[0] : r.oracle?.why || '(no reason recorded)'}`);
  }
}
console.log('');
