// Which relay a new secure share goes to.
//
// One default, one override, and no directory. A person who never opens
// Advanced never sees a server address at all — that is the whole point of
// §6 of the brief, and the reason the legacy dialog's "Reviews server" and
// "Signup token" fields do not appear anywhere in the new flow.
//
// THE DEFAULT IS A CLIENT-SIDE CONSTANT AND NOTHING DEPENDS ON IT. No protocol
// behaviour, no cryptography and no capability format refers to it: a
// capability carries its own relay origin, so a share created against a
// self-hosted relay is joined against that relay by a Stacki that has never
// heard of it. Changing this line changes where NEW shares are created and
// nothing else.
//
// AT THE TIME THIS WAS WRITTEN THE HOSTED RELAY IS NOT DEPLOYED. There are no
// Cloudflare credentials in this repository and none were created; see
// relay/cloudflare/README.md. Self-hosting is complete and tested today —
// `npm run relay:serve`, then Advanced → Use custom secure relay — and a
// Stacki pointed at the default before it exists reports an ordinary "could
// not reach the relay", which is the same thing it reports for a laptop on a
// plane.

const { relayOrigin, isLoopbackRelay } = require('./capability.js');

// Stacki's own hosted relay. A subdomain of the product's existing domain
// rather than a new one, and an address rather than an account: there is
// nothing to sign up for and no token to find.
// THE HOSTED RELAY FOR THIS FORK.
//
// Upstream Stacki intends `relay.stacki.app`; this repository is a fork and
// does not own that domain, so shipping it as the default meant Share… pointed
// at an address that does not answer. This one is operated by the fork
// maintainer and is a real service. It is not official Stacki infrastructure,
// and nothing in the product says it is — see the label below.
//
// Self-hosting remains first class: a capability carries its own relay origin,
// so nothing here is load-bearing for anybody who runs their own.
const DEFAULT_RELAY = 'https://stacki-relay.neongod.io';

// An escape hatch for development and for a team that has already stood one
// up and does not want to click through Advanced on every machine.
const ENV_RELAY = 'STACKI_SECURE_RELAY';

/**
 * The relay a new share should be created against.
 *
 * Order: an explicit per-installation choice, then the environment, then the
 * hosted default. A stored choice that no longer parses is ignored rather than
 * fatal — a relay address is a preference, not a credential, and a bad one
 * should not stop somebody sharing.
 */
function relayFor({ preferred = null, env = process.env } = {}) {
  return relayOrigin(preferred) || relayOrigin(env?.[ENV_RELAY]) || DEFAULT_RELAY;
}

/**
 * What to say about a relay, in a sentence, without teaching anybody the word
 * "relay" unless they went looking for it.
 */
function describeRelay(origin) {
  const normalized = relayOrigin(origin);
  if (!normalized) return { ok: false, code: 'bad_relay', message: 'That is not an address Stacki can use.' };
  // "Hosted relay", not "Stacki hosted": this fork's default is run by the
  // fork's maintainer, and calling it Stacki's would be a claim about who
  // operates it that is not true.
  if (normalized === DEFAULT_RELAY) return { ok: true, hosted: true, origin: normalized, label: 'Hosted relay' };
  if (isLoopbackRelay(normalized)) return { ok: true, hosted: false, origin: normalized, label: 'On this computer' };
  return { ok: true, hosted: false, origin: normalized, label: new URL(normalized).host };
}

/**
 * Whether Stacki will use this address, with a reason it can say out loud.
 *
 * The rule lives in `relayOrigin` — HTTPS, or loopback — and this exists to
 * turn a null into a sentence. A person who typed `http://reviews.internal`
 * deserves to be told why rather than watch a field refuse to accept them.
 */
function checkRelay(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, code: 'bad_relay', message: 'Enter the address of a secure relay.' };
  }
  const normalized = relayOrigin(value);
  if (normalized) return { ok: true, origin: normalized };
  const trimmed = value.trim();
  if (/^http:\/\//i.test(trimmed)) {
    return {
      ok: false,
      code: 'insecure_relay',
      message: 'A relay that is not on this computer has to use https, so your invitation and comments are not sent in the clear.',
    };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return { ok: false, code: 'bad_relay', message: 'That is not a web address.' };
  }
  return { ok: false, code: 'bad_relay', message: 'That does not look like a relay address.' };
}

module.exports = { DEFAULT_RELAY, ENV_RELAY, relayFor, describeRelay, checkRelay };
