// Two ways a suite can report success without having run, and the guards for them.
//
// A HANG EXITS ZERO. Node's answer to an empty event loop is to exit 0, silently.
// So a suite whose last await never settles — a request nobody answers, a window
// that never loads — drains the loop, prints nothing after the last line it
// reached, and the runner records a pass. That is not hypothetical: it happened
// in this repository while mutation-proving the audit timeouts, and
// test/audit-cancel.js carries the first copy of this guard because of it.
//
// A PORT COLLISION IS A FLAKE, NOT A FINDING. Several suites derive a fixed port
// from the pid and bind it once. The pid spans overlap the ones the wire rigs
// allocate from, so two suites in one run can want the same number; the loser
// fails on EADDRINUSE, which is the right direction but is noise. The rigs
// already probe and retry, and this is that loop, in one place, so a fourth copy
// does not drift from the other three.

const net = require('node:net');

/**
 * ONLY A REFUSAL PROVES A PORT IS FREE, AND EVERY OTHER ERROR USED TO SAY SO.
 *
 * This was `socket.once('error', () => settle(false))`: every connect error read
 * as "nothing is listening, take it". ECONNREFUSED does mean that. The others do
 * not, and each one is a port the caller then cannot bind:
 *
 *   EACCES        the port is administratively closed to this process
 *   EMFILE/ENFILE the probe ran out of descriptors; it learned nothing at all
 *   EADDRNOTAVAIL the local address is gone, so the connect never reached a port
 *   EHOSTUNREACH  no route; again, nothing was asked of the port
 *
 * A probe that cannot ask the question must answer TAKEN, for the same reason
 * silence does below: `freePort` skips a port it is unsure about, which costs a
 * number, and hands back a port it is wrong about, which costs a suite.
 */
const errorMeansFree = (err) => (err && err.code) === 'ECONNREFUSED';

/**
 * Whether something is listening on a loopback port.
 *
 * Silence is read as TAKEN, not as free: on 127.0.0.1 a live listener connects
 * and a dead one refuses, both immediately. Neither answer arriving means a
 * loaded machine or a socket on its way down, and reading that as "free" is how
 * a suite walks into a port and fails with "already in use".
 */
const portTaken = (port) =>
  new Promise((done) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const settle = (taken) => {
      socket.destroy();
      done(taken);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', (err) => settle(!errorMeansFree(err)));
    setTimeout(() => settle(true), 500).unref?.();
  });

/** The first free port at or after `from`, or a throw naming the span it tried. */
async function freePort(from, tries = 200) {
  let port = from;
  for (let n = 0; n < tries; n += 1) {
    if (!(await portTaken(port))) return port;
    port += 1;
  }
  throw new Error(`no free port in ${from}..${from + tries}`);
}

/**
 * Make "exited without finishing" a failure rather than a pass.
 *
 * Returns `done()`, which the suite calls when it has genuinely reached its end.
 * Anything else — an unsettled await, an uncaught throw, a killed process — hits
 * the exit handler with `finished` still false and turns the exit code non-zero
 * with a line saying so. The deadline is the second half: a suite that hangs
 * while HOLDING a handle (an open socket) never reaches the exit handler at all,
 * so it needs a timer to end it.
 */
function guardSuite(name, deadlineMs = 600000) {
  let finished = false;
  const timer = setTimeout(() => {
    console.error(`\n${name}: FAILED — still running after ${deadlineMs}ms; something never settled.`);
    process.exit(1);
  }, deadlineMs);
  timer.unref?.();
  process.on('exit', (code) => {
    if (finished || code !== 0) return;
    console.error(`\n${name}: FAILED — the process exited before the suite finished, and node exits 0 on an empty event loop.`);
    process.exitCode = 1;
  });
  return () => {
    finished = true;
    clearTimeout(timer);
  };
}

/**
 * A SKIP THAT SAYS SO, because "exited 0 having asserted nothing" is the other
 * way a suite reports success without having run.
 *
 * MEASURED, in this worktree, on 2026-09-07:
 *
 *     node test/packaged-lifecycle.js          → EXIT=0, "17 passed"
 *     (same file, with the one path its `available()` probes made absent)
 *                                              → EXIT=0, "packaged-lifecycle: skipped"
 *
 * and three suites that ARE in the npm test chain do the same thing off an
 * environment variable rather than a missing file:
 *
 *     STACKI_HOSTED_RUNNER=1 node test/hover-cost.js         → EXIT=0, 0 checks
 *     STACKI_HOSTED_RUNNER=1 node test/popover-dropdown.js   → EXIT=0, 0 checks
 *     STACKI_HOSTED_RUNNER=1 node test/shared-acceptance.js  → EXIT=0, 0 checks
 *
 * Zero is what the chain reads, and zero is what a suite that ran everything
 * reports too. So on a machine — or in a container, or on a runner with one
 * variable set differently — where the resource is missing, the entry is not a
 * weaker test. It is not a test.
 *
 * The skip itself is legitimate: nobody wants `npm test` to be impossible
 * without a signed bundle. What is not legitimate is that the skip is
 * UNDECLARED — the caller cannot ask for a run in which skipping is an error,
 * so no run anywhere can prove the skipped path still works.
 *
 * This makes the skip a declaration:
 *
 *     STACKI_NO_SKIPS unset  → prints the skip line, exits as the suite would
 *     STACKI_NO_SKIPS set    → prints FAILED and makes the exit code non-zero
 *
 * so a release run sets it and a laptop does not.
 *
 * `done` is the guard's own `done()` and passing it matters: `guardSuite` turns
 * "returned without finishing" into a failure, which a bare skip escape looks
 * exactly like. A DECLARED skip is a legitimate ending, and this is how it says
 * so; an undeclared one keeps failing, which is the point.
 *
 * @returns {boolean} whether the skip was allowed. False means this run had
 *   already been told not to accept one, and the exit code is now non-zero.
 */
function skipSuite(name, reason, done) {
  if (typeof done === 'function') done();
  const forbidding = process.env.STACKI_NO_SKIPS;
  if (forbidding && forbidding !== '0') {
    console.error(`\n${name}: FAILED — skipped (${reason}), and STACKI_NO_SKIPS forbids a suite that asserts nothing.`);
    process.exitCode = 1;
    return false;
  }
  console.log(`${name}: skipped  [${reason}]`);
  return true;
}

module.exports = { portTaken, freePort, guardSuite, skipSuite };
