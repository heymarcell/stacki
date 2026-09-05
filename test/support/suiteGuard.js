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

module.exports = { portTaken, freePort, guardSuite };
