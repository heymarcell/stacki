// Reaching a real host from Node, on a machine whose IPv6 goes nowhere.
//
// The in-process suites talk to 127.0.0.1 and never meet this. The moment a
// test points at a deployed relay, Node's connection logic and curl's stop
// agreeing, and the difference looks exactly like the service being down:
//
//   curl  https://…workers.dev/health   → 200, connected to 172.67.211.69
//   fetch https://…workers.dev/health   → ETIMEDOUT after ~510ms, every time
//
// The name resolves to four addresses:
//
//   104.21.37.181            IPv4  — times out from this network
//   172.67.211.69            IPv4  — works
//   2606:4700:3033::6815:…   IPv6  — EHOSTUNREACH, no route
//   2606:4700:3035::ac43:…   IPv6  — EHOSTUNREACH, no route
//
// curl happened to pick the address that works. Node tried the others and gave
// up. Nothing is wrong with the relay, and a test that reported "the deployed
// relay is unreachable" on this evidence would be wrong in a way that costs an
// afternoon — so this pins the family to IPv4 and gives each address a short
// window before moving to the next, which is what makes the second IPv4
// address reachable instead of theoretical.
//
// This is about THIS MACHINE'S network, not about the product. Electron's own
// requests go through Chromium, which does its own Happy Eyeballs and is not
// affected.

const { Agent, setGlobalDispatcher } = require('undici');

let installed = false;

/**
 * Make `fetch` in this process able to reach the public internet reliably.
 *
 * Call once, before any request. Idempotent.
 */
function usePublicNetwork() {
  if (installed) return;
  installed = true;
  setGlobalDispatcher(
    new Agent({
      connect: {
        // No IPv6: this host has addresses for it and no route to them, and
        // every attempt costs a full connect timeout before the fallback.
        family: 4,
        timeout: 10000,
        // Do not spend the whole timeout on the first address. With two IPv4
        // addresses and one of them blackholed, this is the difference
        // between "unreachable" and "fine".
        autoSelectFamilyAttemptTimeout: 1500,
      },
      keepAliveTimeout: 10000,
      keepAliveMaxTimeout: 30000,
    })
  );
}

module.exports = { usePublicNetwork };
