// The one-time discard of the alpha's review data.
//
// The review model changed shape during alpha: a comment used to carry a
// filing colour the user picked, with an event type and a stored field behind
// it. Both are gone. Rather than keep migration code, a dead event type and a
// dead field alive forever to serve reviews written in an alpha nobody was
// relying on, the data written under the old model is DISCARDED.
//
// Two halves, and it is only correct with both:
//
//   THE LEDGERS, which store.js also refuses on read (see the version branch
//   there) — but a refusal on read leaves the old bytes on disk, and this
//   removes them.
//
//   THE SHARING MEMBERSHIP, which store.js cannot touch and which is the half
//   that actually matters. A project still joined to a relay room would pull
//   the old events straight back down into its fresh ledger on the next sync,
//   and the reset would have achieved nothing. So every room registration,
//   every workspace credential and every project mapping goes with them.
//
// WHAT IT DOES NOT TOUCH, and this is the boundary the whole file is written
// around:
//
//   THE LOCAL PERSON. `actor` and `actorCreatedAt` in the identity file are
//   this installation's own identity. Every comment ever written from this
//   machine is attributed to that uuid, and minting a new one would make a
//   person a stranger to their own past. It survives.
//
//   THE PREFERRED RELAY. A setting somebody typed, not review data. Wiping it
//   would silently move them back to the default relay.
//
//   ANYTHING ELSE IN userData. Settings, projects, caches, credentials for
//   other features. This reads two known files and one known directory.
//
// It runs at most once. The marker is written LAST, after both halves have
// succeeded, so a reset interrupted halfway is retried on the next launch
// rather than recorded as done.

const fs = require('node:fs');
const path = require('node:path');

// The review model this build speaks. Must match store.js's VERSION: the
// ledger branch discards anything below it, and this discards the files.
const EPOCH = 3;

const MARKER = 'review-epoch.json';
const markerFor = (userDataPath) => path.join(userDataPath, MARKER);

/** Which epoch this installation has already been reset to. 0 for never. */
function epochOf(userDataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerFor(userDataPath), 'utf8'));
    return Number.isInteger(parsed?.epoch) ? parsed.epoch : 0;
  } catch {
    return 0;
  }
}

/**
 * Every review ledger this installation holds, including quarantined ones.
 *
 * A `.corrupt-…` file is a ledger that could not be parsed and was set aside
 * rather than deleted. It is still review data written under the old model, so
 * it goes too — and it is the one thing here that could not have been read to
 * check its version, which is exactly why it cannot be left behind.
 */
function ledgerFiles(userDataPath) {
  const dir = path.join(userDataPath, 'reviews');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json') || n.includes('.json.corrupt-')).map((n) => path.join(dir, n));
}

/**
 * Discard the alpha's reviews, once.
 *
 * Synchronous, and deliberately: the local half must be finished before
 * anything reads a ledger or opens a connection, and an await between the
 * membership wipe and the first sync is a window where the old events come
 * back. The only asynchronous part is telling the relays, which is best-effort
 * by nature — see `notify` below.
 *
 * `rooms` and `workspaces` are the live registries the app already built.
 * Tests pass their own.
 */
function resetReviewEpoch({ userDataPath, rooms, workspaces, transportFor = null, log = null }) {
  if (!userDataPath) throw new Error('the review epoch reset needs a userData directory');
  if (epochOf(userDataPath) >= EPOCH) return { ran: false, epoch: EPOCH, notified: Promise.resolve([]) };

  const say = (m) => (typeof log === 'function' ? log(m) : undefined);

  // Captured BEFORE anything is destroyed, because leaving a room needs the
  // credential this is about to throw away. Constructing the transport is what
  // takes the copy — it reads the room once and holds it.
  const goodbyes = [];
  const roomList = (() => {
    try {
      return rooms?.all?.() || [];
    } catch {
      return [];
    }
  })();
  for (const room of roomList) {
    try {
      const transport = transportFor?.(room.roomId);
      if (transport) goodbyes.push({ roomId: room.roomId, isOwner: room.isOwner === true, transport });
    } catch {
      /* a room whose transport cannot be built is one that cannot be told; the
         local wipe below is what makes it harmless either way */
    }
  }

  // --- the membership, first --------------------------------------------
  //
  // Before the ledgers, so that a crash between the two halves leaves a
  // machine that still has its old comments and can no longer sync them —
  // rather than one with an empty ledger and a live subscription that refills
  // it.
  //
  // `wipe()` rather than a walk of `all()` and a `forget` each: `all()` shows
  // active, readable entries, and the ones it hides — a dormant signing
  // identity, a blob this machine can no longer decrypt — are review-sharing
  // material too. See the comment on each registry's wipe.
  const entriesWiped = rooms.wipe();
  const workspacesWiped = workspaces.wipe();

  // --- then the ledgers --------------------------------------------------
  let ledgersRemoved = 0;
  const undeleted = [];
  for (const file of ledgerFiles(userDataPath)) {
    try {
      fs.rmSync(file);
      ledgersRemoved++;
    } catch (err) {
      undeleted.push(`${path.basename(file)}: ${err.message}`);
    }
  }

  // Written last, and only if every file this owns actually went. A ledger
  // still on disk is one store.js would discard on read anyway, but recording
  // the reset as done while its bytes are still there is a lie about what
  // happened, and the retry costs nothing.
  const complete = undeleted.length === 0;
  if (complete) {
    const tmp = path.join(userDataPath, `.${MARKER}.${process.pid}.tmp`);
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ epoch: EPOCH, at: new Date().toISOString() }, null, 2), 'utf8');
    fs.renameSync(tmp, markerFor(userDataPath));
  }

  const summary = {
    ran: true,
    epoch: EPOCH,
    complete,
    ledgersRemoved,
    // Rooms, dormant identities and pending relay cleanups, together: the file
    // is cleared in one write and they are not counted apart.
    entriesWiped,
    workspacesWiped,
    // Rooms this machine still had live access to, and so could say goodbye
    // for. Never more than `entriesWiped`, and usually fewer.
    roomsContacted: goodbyes.length,
    undeleted,
  };
  // Only when there was something to say. On a fresh installation this runs,
  // finds nothing, writes the marker and never runs again — and announcing
  // that on stderr is noise in every log and every test that reads one.
  if (ledgersRemoved || entriesWiped || workspacesWiped || !complete) {
    say(
      `review epoch ${EPOCH}: discarded ${ledgersRemoved} ledger(s), ${entriesWiped} room entr(ies), ` +
        `${workspacesWiped} workspace(s)${complete ? '' : ` — ${undeleted.length} file(s) could not be removed`}`
    );
  }

  // --- and finally, the relays -------------------------------------------
  //
  // BEST-EFFORT AND ONLY THAT. This machine has already given up its access
  // locally; whether the relay hears about it changes nothing here. It is
  // still worth trying, because a room whose owner never says "end" sits on
  // the relay holding envelopes nobody will ever read again.
  //
  // Not awaited by the caller's critical path, and every failure is swallowed:
  // startup must not wait on a network, and a relay that is down must not stop
  // Stacki opening.
  summary.notified = Promise.all(
    goodbyes.map(async ({ roomId, isOwner, transport }) => {
      try {
        const answer = isOwner ? await transport.end() : await transport.leave();
        return { roomId, ok: answer?.ok === true, code: answer?.code || null };
      } catch (err) {
        return { roomId, ok: false, code: err?.message || 'failed' };
      } finally {
        try {
          transport.close();
        } catch {
          /* already gone */
        }
      }
    })
  );

  return summary;
}

module.exports = { resetReviewEpoch, epochOf, EPOCH };
