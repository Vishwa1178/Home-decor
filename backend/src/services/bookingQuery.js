"use strict";

// Turns the admin's search/filter/sort choices into a Firestore query PLAN, pure and
// side-effect free so it can be tested exhaustively.
//
// Firestore filters on ONE thing per query cheaply. Combining several equality filters
// with an ordering needs a composite index for that exact combination, and there are far
// too many combinations to index. So:
//
//   * ONE equality filter is pushed into Firestore (the first present, by PUSHDOWN_PRIORITY),
//     together with the sort. Each (filter field, sort) pair has a declared composite index
//     in firestore.indexes.json.
//   * Every other filter is applied in memory by the server on the page being scanned, and
//     the scan is capped (see adminBookings.service), so a request never reads the whole
//     collection.
//   * Search is a range on one indexed field (name/phone prefix) or an equality (email);
//     all filters are then applied in memory.
//
// A test enumerates every possible plan and checks that firestore.indexes.json covers it.

const PUSHDOWN_PRIORITY = ["status", "paymentStatus", "packageId", "slotId", "paymentMethod", "paymentOption"];
const FILTER_FIELDS = PUSHDOWN_PRIORITY;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Search cannot be "contains" (Firestore has no substring search); it is one of:
//   booking ID (exact) | email (exact) | phone (prefix of the stored number) | name (prefix, case-insensitive)
function classifySearch(q) {
  const text = q.trim();
  if (UUID_RE.test(text)) return { kind: "id", value: text.toLowerCase() };
  if (text.includes("@")) return { kind: "email", value: text.toLowerCase() };
  const compact = text.replace(/[\s\-()]/g, "");
  if (/^\+?\d{3,}$/.test(compact)) return { kind: "phone", value: compact };
  return { kind: "name", value: text.toLowerCase() };
}

// params: the validated list query (see admin.schema listBookingsQuery).
function planBookingQuery(params) {
  const filters = {};
  for (const f of FILTER_FIELDS) if (params[f] !== undefined) filters[f] = params[f];
  const range = params.dateFrom || params.dateTo ? { from: params.dateFrom ?? null, to: params.dateTo ?? null } : null;

  // What identifies "the same query" for cursors: everything except limit and cursor.
  const signature = { sort: params.sort, q: params.q ?? null, ...filters, dateFrom: params.dateFrom ?? null, dateTo: params.dateTo ?? null };

  if (params.q) {
    const search = classifySearch(params.q);
    const plan = { mode: "search", search, signature, equality: null, range: null, prefix: null, orderBy: [], postFilters: { equals: filters, range } };
    if (search.kind === "email") plan.equality = ["email", search.value];
    else if (search.kind === "phone") { plan.prefix = { field: "phone", value: search.value }; plan.orderBy = [["phone", "asc"]]; }
    else if (search.kind === "name") { plan.prefix = { field: "nameLower", value: search.value }; plan.orderBy = [["nameLower", "asc"]]; }
    return plan;
  }

  const pushed = PUSHDOWN_PRIORITY.find((f) => filters[f] !== undefined);
  const equals = { ...filters };
  if (pushed) delete equals[pushed];

  const upcoming = params.sort === "upcoming";
  return {
    mode: "list",
    search: null,
    signature,
    equality: pushed ? [pushed, filters[pushed]] : null,
    // A date range can only be pushed down when ordering by date (Firestore requires the
    // first ordering to be the range field). Otherwise it is applied in memory.
    range: upcoming && range ? { field: "date", ...range } : null,
    prefix: null,
    orderBy: upcoming ? [["date", "asc"], ["time", "asc"]] : [["createdAt", "desc"]],
    postFilters: { equals, range: upcoming ? null : range },
  };
}

const ORDER = { asc: "ASCENDING", desc: "DESCENDING" };

// The composite index a plan needs, or null when Firestore's automatic single-field
// indexes are enough. Firestore needs a composite index for an equality filter combined
// with ordering on a DIFFERENT field, and for ordering on more than one field.
function requiredIndex(plan) {
  if (plan.mode === "search" && plan.search.kind === "id") return null; // a direct document read
  const eq = plan.equality;
  const orderBy = plan.orderBy;
  const equalityWithOtherOrder = eq && orderBy.length > 0 && !(orderBy.length === 1 && orderBy[0][0] === eq[0]);
  if (!equalityWithOtherOrder && orderBy.length <= 1) return null;

  const fields = [];
  if (eq) fields.push({ fieldPath: eq[0], order: "ASCENDING" });
  for (const [field, dir] of orderBy) fields.push({ fieldPath: field, order: ORDER[dir] });
  return { collectionGroup: "bookings", queryScope: "COLLECTION", fields };
}

// Is `needed` declared in the parsed contents of firestore.indexes.json?
function indexDeclared(indexesJson, needed) {
  if (!needed) return true;
  return indexesJson.indexes.some(
    (i) =>
      i.collectionGroup === needed.collectionGroup &&
      i.queryScope === needed.queryScope &&
      i.fields.length === needed.fields.length &&
      i.fields.every((f, n) => f.fieldPath === needed.fields[n].fieldPath && f.order === needed.fields[n].order)
  );
}

// In-memory filters for everything not pushed into Firestore.
function matchesPostFilters(booking, { equals, range }) {
  for (const [field, value] of Object.entries(equals)) if (booking[field] !== value) return false;
  if (range) {
    if (range.from && !(booking.date >= range.from)) return false;
    if (range.to && !(booking.date <= range.to)) return false;
  }
  return true;
}

module.exports = { PUSHDOWN_PRIORITY, FILTER_FIELDS, classifySearch, planBookingQuery, requiredIndex, indexDeclared, matchesPostFilters };
