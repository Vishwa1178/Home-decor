"use strict";

// Firestore aborts a transaction when it loses a race for a document. The SDK already
// retries a few times; under a burst that can run out even though the work is valid, so
// retry a few more times (with jitter) before giving up. Re-running is always safe: the
// transactions in this codebase have no side effects outside Firestore.
const isContention = (err) => err?.code === 10 || err?.code === "aborted" || /contention|aborted/i.test(err?.message || "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_ATTEMPTS = 5;

async function withContentionRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isContention(err) || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(15 * attempt + Math.random() * 60 * attempt);
    }
  }
}

module.exports = { withContentionRetry, isContention };
