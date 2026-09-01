// Read every trial's result and say what happened.
//
//   node scripts/eval/report.js <evalDir>
//
// No cherry-picking: every task that ran is printed, including the ones where the
// candidate did no better or did worse. A trial that produced no result.json is
// printed as a failure rather than dropped, because a dropped trial is the
// easiest way to make an evaluation say what you wanted.

const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2];
if (!dir) {
  console.error('need the eval directory');
  process.exit(2);
}

const rows = [];
for (const name of fs.readdirSync(dir).sort()) {
  const ws = path.join(dir, name);
  if (!fs.statSync(ws).isDirectory()) continue;
  const m = /^t(\d+)-(.+)-(baseline|candidate)$/.exec(name);
  if (!m) continue;
  const [, trial, task, arm] = m;
  let r = null;
  try {
    r = JSON.parse(fs.readFileSync(path.join(ws, 'result.json'), 'utf8'));
  } catch {
    rows.push({ trial: Number(trial), task, arm, missing: true, pass: false });
    continue;
  }
  rows.push({
    trial: Number(trial),
    task,
    arm,
    pass: r.ok === true,
    finished: r.finished === true,
    oracle: r.oracle || null,
    cleanupProblems: (r.cleanupProblems || []).length,
    ...(r.metrics || {}),
  });
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
};

const TASKS = [...new Set(rows.map((r) => r.task))];
const num = (v) => (typeof v === 'number' ? String(v) : '-');

console.log('\n=== FRESH-AGENT EVALUATION — every task, every trial ===\n');
console.log(
  ['task', 'arm', 'tri', 'pass', 'fin', 'mcp', 'calls', 'res', 'prm', 'disc', 'inval', 'redun', 'bytes', 'ms']
    .map((h, i) => h.padEnd(i < 2 ? 11 : 6))
    .join('')
);
for (const task of TASKS) {
  for (const arm of ['baseline', 'candidate']) {
    for (const r of rows.filter((x) => x.task === task && x.arm === arm).sort((a, b) => a.trial - b.trial)) {
      console.log(
        [
          task.padEnd(11),
          arm.padEnd(11),
          String(r.trial).padEnd(6),
          (r.missing ? 'MISS' : r.pass ? 'YES' : 'no').padEnd(6),
          (r.finished ? 'y' : 'n').padEnd(6),
          num(r.mcpInteractions).padEnd(6),
          num(r.toolCalls).padEnd(6),
          num(r.resourcesRead).padEnd(6),
          num(r.promptsFetched).padEnd(6),
          num(r.discovery).padEnd(6),
          num(r.invalid).padEnd(6),
          num(r.redundant).padEnd(6),
          num(r.responseBytes).padEnd(8),
          num(r.elapsedMs).padEnd(8),
        ].join('')
      );
    }
  }
}

console.log('\n=== MEDIANS PER TASK ===\n');
console.log(['task', 'arm', 'pass', 'mcp', 'calls', 'disc', 'inval', 'redun', 'bytes'].map((h) => h.padEnd(11)).join(''));
const summary = {};
for (const task of TASKS) {
  summary[task] = {};
  for (const arm of ['baseline', 'candidate']) {
    const got = rows.filter((x) => x.task === task && x.arm === arm);
    const s = {
      trials: got.length,
      passed: got.filter((x) => x.pass).length,
      mcp: median(got.map((x) => x.mcpInteractions)),
      calls: median(got.map((x) => x.toolCalls)),
      discovery: median(got.map((x) => x.discovery)),
      invalid: median(got.map((x) => x.invalid)),
      redundant: median(got.map((x) => x.redundant)),
      bytes: median(got.map((x) => x.responseBytes)),
    };
    summary[task][arm] = s;
    console.log(
      [
        task.padEnd(11),
        arm.padEnd(11),
        `${s.passed}/${s.trials}`.padEnd(11),
        num(s.mcp).padEnd(11),
        num(s.calls).padEnd(11),
        num(s.discovery).padEnd(11),
        num(s.invalid).padEnd(11),
        num(s.redundant).padEnd(11),
        num(s.bytes).padEnd(11),
      ].join('')
    );
  }
}

// The headline, stated in terms of what was actually measured.
const all = (arm, key) => median(rows.filter((r) => r.arm === arm && !r.missing).map((r) => r[key]));
const passRate = (arm) => {
  const got = rows.filter((r) => r.arm === arm);
  return `${got.filter((r) => r.pass).length}/${got.length}`;
};
console.log('\n=== ACROSS EVERY TRIAL ===\n');
for (const key of ['mcpInteractions', 'toolCalls', 'discovery', 'invalid', 'redundant', 'responseBytes']) {
  console.log(`${key.padEnd(18)} baseline ${String(all('baseline', key)).padEnd(10)} candidate ${all('candidate', key)}`);
}
console.log(`${'semantic success'.padEnd(18)} baseline ${passRate('baseline').padEnd(10)} candidate ${passRate('candidate')}`);
const cleanup = rows.reduce((n, r) => n + (r.cleanupProblems || 0), 0);
console.log(`${'cleanup problems'.padEnd(18)} ${cleanup} across ${rows.length} trials`);

fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ rows, summary }, null, 1), 'utf8');
console.log(`\nwrote ${path.join(dir, 'summary.json')}`);
