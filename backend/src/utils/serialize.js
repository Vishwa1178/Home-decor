"use strict";

// Firestore Timestamp -> ISO string; everything else unchanged (one level deep is enough
// for our documents; audit before/after payloads are plain values).
const isTimestamp = (v) => v && typeof v === "object" && typeof v.toDate === "function";
const iso = (v) => (isTimestamp(v) ? v.toDate().toISOString() : v ?? null);

function serializeTimestamps(data) {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, isTimestamp(v) ? v.toDate().toISOString() : v]));
}

module.exports = { isTimestamp, iso, serializeTimestamps };
