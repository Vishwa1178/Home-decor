"use strict";

// Runs async functions that share a key strictly one at a time (FIFO) inside this
// process; functions with different keys run concurrently.
//
// Why: many simultaneous bookings for the SAME slot would otherwise all collide on one
// Firestore document, and Firestore aborts transactions that wait too long for its lock
// ("ABORTED: Transaction lock timeout" / "Too much contention"). Queueing them here means
// each one gets an uncontended transaction, and the ones that arrive after the slot is
// full are refused quickly with SLOT_FULL.
//
// This is an optimisation, not the safety mechanism. Correctness comes from the
// Firestore transaction, which also protects across several server instances (there the
// transaction retry in bookings.service absorbs the remaining contention).
const tails = new Map();

async function withKeyedLock(key, fn) {
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  tails.set(key, tail);

  await previous; // never rejects: every holder releases in `finally`
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key); // nobody queued behind us: free the entry
  }
}

// Runs fn while holding several keys at once. Keys are acquired in sorted order, so two
// callers that need overlapping sets can never deadlock.
async function withKeyedLocks(keys, fn) {
  const sorted = [...new Set(keys.filter(Boolean))].sort();
  const run = (i) => (i >= sorted.length ? fn() : withKeyedLock(sorted[i], () => run(i + 1)));
  return run(0);
}

// For tests and diagnostics.
const pendingKeys = () => tails.size;

module.exports = { withKeyedLock, withKeyedLocks, pendingKeys };
