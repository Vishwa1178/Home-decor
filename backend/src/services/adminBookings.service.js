"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const firebaseAdmin = require("../config/firebaseAdmin");
const { env } = require("../config/env");
const clock = require("../utils/clock");
const logger = require("../utils/logger");
const { AppError } = require("../utils/errors");
const { encodeCursor, decodeCursor } = require("../utils/cursor");
const { serializeTimestamps } = require("../utils/serialize");
const { todayInTimezone } = require("../utils/dates");
const { withKeyedLocks } = require("../utils/keyedLock");
const { withContentionRetry } = require("../utils/txRetry");
const { planBookingQuery, matchesPostFilters } = require("./bookingQuery");
const slotsService = require("./slots.service");
const audit = require("./audit.service");

// Admin operations on bookings. Reads are paginated and bounded; every mutation runs in a
// Firestore transaction together with its audit entry (and with the slot-seat change it
// implies), behind the admin check in routes/admin.routes.js.

const MAX_SCAN = 250; // most documents one list request may read, however selective the filters
const BATCH = 50;

const notFound = (id) => new AppError(404, "BOOKING_NOT_FOUND", "Booking not found", [{ field: "id", message: `No booking "${id}"` }]);
const invalidCursor = () => new AppError(400, "INVALID_CURSOR", "The pagination cursor is invalid or does not belong to this query. Start again from the first page.");

// Everything an admin may see about a booking. The Razorpay signature is verification
// material, not display data: it never leaves the server (only whether one is stored).
function toAdminBooking(id, d) {
  const { requestFingerprint, razorpaySignature, nameLower, ...rest } = d; // eslint-disable-line no-unused-vars
  return { id, ...serializeTimestamps(rest), hasRazorpaySignature: Boolean(razorpaySignature) };
}

// Non-AppError failures are infrastructure problems: report them as 503, never as success.
async function guard(what, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`${what} failed`, err);
    throw new AppError(503, "SERVICE_UNAVAILABLE", "The service is temporarily unavailable. Please try again.", undefined, { retryAfter: 1 });
  }
}

function buildQuery(db, plan) {
  let q = db.collection("bookings");
  if (plan.equality) q = q.where(plan.equality[0], "==", plan.equality[1]);
  if (plan.range) {
    if (plan.range.from) q = q.where(plan.range.field, ">=", plan.range.from);
    if (plan.range.to) q = q.where(plan.range.field, "<=", plan.range.to);
  }
  if (plan.prefix) q = q.where(plan.prefix.field, ">=", plan.prefix.value).where(plan.prefix.field, "<", `${plan.prefix.value}`);
  for (const [field, dir] of plan.orderBy) q = q.orderBy(field, dir);
  return q;
}

// ── list ────────────────────────────────────────────────────────────────────────
// Cursor pagination over a bounded scan. `params` is the validated list query.
async function listBookings(params) {
  const plan = planBookingQuery(params);
  const { limit } = params;

  return guard("Listing bookings", async () => {
    const db = firebaseAdmin.getDb();

    // Exact booking ID: one document read, no query.
    if (plan.mode === "search" && plan.search.kind === "id") {
      const snap = await db.collection("bookings").doc(plan.search.value).get();
      const found = snap.exists && matchesPostFilters(snap.data(), plan.postFilters);
      return { bookings: found ? [toAdminBooking(snap.id, snap.data())] : [], page: { limit, hasMore: false, nextCursor: null, scanned: 1 } };
    }

    const query = buildQuery(db, plan);
    let after = null;
    if (params.cursor) {
      const snap = await db.collection("bookings").doc(decodeCursor(params.cursor, plan.signature)).get();
      if (!snap.exists) throw invalidCursor();
      after = snap;
    }

    const hasPostFilters = Object.keys(plan.postFilters.equals).length > 0 || Boolean(plan.postFilters.range);
    const matches = [];
    let scanned = 0;
    let last = null;
    let exhausted = false;

    if (!hasPostFilters) {
      // Everything is filtered by Firestore: read one extra document to learn whether there is a next page.
      const docs = (await (after ? query.startAfter(after) : query).limit(limit + 1).get()).docs;
      scanned = docs.length;
      for (const doc of docs.slice(0, limit)) matches.push(doc);
      last = matches[matches.length - 1] || null;
      exhausted = docs.length <= limit;
    } else {
      // Some filters run here: scan forward in batches until the page is full, the data ends or the cap is hit.
      let cursorDoc = after;
      while (matches.length < limit && scanned < MAX_SCAN && !exhausted) {
        const size = Math.min(BATCH, MAX_SCAN - scanned);
        const docs = (await (cursorDoc ? query.startAfter(cursorDoc) : query).limit(size).get()).docs;
        let stoppedEarly = false;
        for (let i = 0; i < docs.length; i++) {
          scanned++;
          last = docs[i];
          if (matchesPostFilters(docs[i].data(), plan.postFilters)) matches.push(docs[i]);
          if (matches.length === limit) { stoppedEarly = i < docs.length - 1 || docs.length === size; break; }
        }
        if (docs.length < size && !stoppedEarly) exhausted = true;
        cursorDoc = last;
        if (docs.length === 0) exhausted = true;
      }
    }

    const hasMore = !exhausted;
    return {
      bookings: matches.map((d) => toAdminBooking(d.id, d.data())),
      page: { limit, hasMore, nextCursor: hasMore && last ? encodeCursor(last.id, plan.signature) : null, scanned },
    };
  });
}

// ── stats ───────────────────────────────────────────────────────────────────────
async function getStats() {
  return guard("Booking stats", async () => {
    const col = firebaseAdmin.getDb().collection("bookings");
    const today = todayInTimezone(env.BUSINESS_TIMEZONE, clock.now());
    const count = async (q) => (await q.count().get()).data().count;
    const [total, pending, confirmed, cancelled, eventsToday, cancelledToday] = await Promise.all([
      count(col),
      count(col.where("status", "==", "Pending")),
      count(col.where("status", "==", "Confirmed")),
      count(col.where("status", "==", "Cancelled")),
      count(col.where("date", "==", today)),
      count(col.where("date", "==", today).where("status", "==", "Cancelled")),
    ]);
    return { total, pending, confirmed, cancelled, eventsToday: eventsToday - cancelledToday, today };
  });
}

// ── detail ──────────────────────────────────────────────────────────────────────
async function getBooking(id) {
  const snap = await guard("Loading a booking", () => firebaseAdmin.getDb().collection("bookings").doc(id).get());
  if (!snap.exists) throw notFound(id);
  const { entries } = await audit.listAudit({ entityType: "booking", entityId: id, limit: 20 });
  return { booking: toAdminBooking(snap.id, snap.data()), audit: entries };
}

// ── seat helpers (run inside a transaction) ─────────────────────────────────────
// Frees the seat this booking holds. If the id is not listed (an old/inconsistent record)
// nothing is changed, never a blind decrement that could free someone else's seat.
function releaseSeat(tx, occRef, occSnap, bookingId) {
  if (!occSnap || !occSnap.exists) return null;
  const ids = Array.isArray(occSnap.data().bookingIds) ? occSnap.data().bookingIds : [];
  if (!ids.includes(bookingId)) {
    logger.warn(`Booking ${bookingId} was not listed in ${occRef.id}; no seat released`);
    return null;
  }
  const next = ids.filter((x) => x !== bookingId);
  tx.update(occRef, { bookedCount: next.length, bookingIds: next, updatedAt: FieldValue.serverTimestamp() });
  return "released";
}

function reserveSeat(tx, occRef, occSnap, { bookingId, date, slot }) {
  const ids = occSnap.exists && Array.isArray(occSnap.data().bookingIds) ? occSnap.data().bookingIds : [];
  const next = ids.includes(bookingId) ? ids : [...ids, bookingId];
  const data = { date, slotId: slot.id, time: slot.time, capacity: slot.capacity, bookedCount: next.length, bookingIds: next, updatedAt: FieldValue.serverTimestamp() };
  if (occSnap.exists) tx.update(occRef, data);
  else tx.set(occRef, { ...data, createdAt: FieldValue.serverTimestamp() });
  return "reserved";
}

// ── status ──────────────────────────────────────────────────────────────────────
// Pending <-> Confirmed, anything -> Cancelled (frees the slot seat), Cancelled -> Pending/Confirmed
// (takes the seat back, or fails with SLOT_FULL if someone else has it since).
async function changeStatus(id, { status, reason, expectedStatus }, ctx) {
  return guard("Changing booking status", async () => {
    const db = firebaseAdmin.getDb();
    const bookingRef = db.collection("bookings").doc(id);
    const pre = await bookingRef.get();
    if (!pre.exists) throw notFound(id);
    const auditRef = audit.newAuditRef(db);

    const result = await withKeyedLocks([pre.data().slotKey || `booking:${id}`], () =>
      withContentionRetry(() =>
        db.runTransaction(async (tx) => {
          const bookingSnap = await tx.get(bookingRef);
          if (!bookingSnap.exists) throw notFound(id);
          const b = bookingSnap.data();

          if (expectedStatus && b.status !== expectedStatus) {
            throw new AppError(409, "STATUS_CONFLICT", `This booking is now "${b.status}", not "${expectedStatus}". Refresh and try again.`);
          }
          if (b.status === status) return { changed: false };

          const reopening = b.status === "Cancelled";
          const occRef = b.slotKey ? db.collection("slotBookings").doc(b.slotKey) : null;
          const reads = [];
          if (occRef) reads.push(occRef);
          if (occRef && reopening && b.slotId) reads.push(db.collection("slots").doc(b.slotId));
          const snaps = reads.length ? await tx.getAll(...reads) : [];
          const occSnap = occRef ? snaps[0] : null;

          let seat = null;
          if (status === "Cancelled") {
            seat = releaseSeat(tx, occRef, occSnap, id);
          } else if (reopening && occRef) {
            const slot = slotsService.parseSlotSnapshot(snaps[1]);
            if (!slot) throw new AppError(422, "SLOT_NOT_FOUND", "This booking's slot no longer exists, so it cannot be reopened. Reschedule it instead.");
            if (slotsService.bookedCountOf(occSnap) >= slot.capacity) throw slotsService.slotError(slotsService.REASONS.FULL, slot.id);
            seat = reserveSeat(tx, occRef, occSnap, { bookingId: id, date: b.date, slot });
          }

          const now = FieldValue.serverTimestamp();
          const update = { status, updatedAt: now, statusChangedAt: now };
          if (status === "Cancelled") Object.assign(update, { cancelledAt: now, cancelReason: reason });
          else if (reopening) Object.assign(update, { cancelledAt: FieldValue.delete(), cancelReason: FieldValue.delete() });
          tx.update(bookingRef, update);

          tx.create(auditRef, audit.auditEntry({
            action: "booking.status_changed", entityType: "booking", entityId: id, ctx, reason,
            before: { status: b.status }, after: { status, seat },
          }));
          return { changed: true };
        })
      )
    );

    return { changed: result.changed, booking: toAdminBooking(id, (await bookingRef.get()).data()) };
  });
}

// ── reschedule ──────────────────────────────────────────────────────────────────
// Moves the booking to another date/slot: the new seat is taken and the old one freed in the
// same transaction, under the same availability rule customers face (a full, blocked,
// disabled or past slot is refused and nothing changes). Older bookings that never held a
// slot seat can be rescheduled too; there is simply no old seat to free.
async function rescheduleBooking(id, { date, slotId, reason, expectedDate, expectedSlotId }, ctx) {
  return guard("Rescheduling a booking", async () => {
    const db = firebaseAdmin.getDb();
    const bookingRef = db.collection("bookings").doc(id);
    const pre = await bookingRef.get();
    if (!pre.exists) throw notFound(id);

    const newKey = slotsService.occupancyId(date, slotId);
    const oldKey = pre.data().slotKey || null;
    const newOccRef = db.collection("slotBookings").doc(newKey);
    const oldOccRef = oldKey && oldKey !== newKey ? db.collection("slotBookings").doc(oldKey) : null;
    const auditRef = audit.newAuditRef(db);

    const result = await withKeyedLocks([oldKey, newKey, `booking:${id}`], () =>
      withContentionRetry(() =>
        db.runTransaction(async (tx) => {
          const [bookingSnap, slotSnap, blockedSnap, newOccSnap, oldOccSnap] = await tx.getAll(
            bookingRef, db.collection("slots").doc(slotId), db.collection("blockedDates").doc(date), newOccRef, ...(oldOccRef ? [oldOccRef] : [])
          );
          if (!bookingSnap.exists) throw notFound(id);
          const b = bookingSnap.data();

          if (b.status === "Cancelled") throw new AppError(409, "BOOKING_CANCELLED", "A cancelled booking cannot be rescheduled. Reopen it first.");
          if ((expectedDate && b.date !== expectedDate) || (expectedSlotId && b.slotId !== expectedSlotId)) {
            throw new AppError(409, "SCHEDULE_CONFLICT", "This booking was rescheduled by someone else. Refresh and try again.");
          }
          if (b.date === date && b.slotId === slotId) return { changed: false };

          const slot = slotsService.parseSlotSnapshot(slotSnap);
          if (!slot) throw new AppError(404, "SLOT_NOT_FOUND", "Unknown time slot", [{ field: "slotId", message: `No slot "${slotId}"` }]);
          const blocked = blockedSnap.exists;
          const reasonCode = slotsService.evaluateSlot({ slot, date, blocked, booked: slotsService.bookedCountOf(newOccSnap), now: clock.now() });
          if (reasonCode) throw slotsService.slotError(reasonCode, slotId);

          const released = oldOccRef ? releaseSeat(tx, oldOccRef, oldOccSnap, id) : null;
          reserveSeat(tx, newOccRef, newOccSnap, { bookingId: id, date, slot });

          const now = FieldValue.serverTimestamp();
          tx.update(bookingRef, {
            date, slotId: slot.id, slotKey: newKey, time: slot.time, timeLabel: slot.label,
            rescheduledFrom: { date: b.date, slotId: b.slotId ?? null, time: b.time ?? null, timeLabel: b.timeLabel ?? null },
            rescheduledAt: now, updatedAt: now,
          });
          tx.create(auditRef, audit.auditEntry({
            action: "booking.rescheduled", entityType: "booking", entityId: id, ctx, reason,
            before: { date: b.date, slotId: b.slotId ?? null, time: b.timeLabel || b.time || null },
            after: { date, slotId: slot.id, time: slot.label, seat: released ? "moved" : "reserved" },
          }));
          return { changed: true };
        })
      )
    );

    return { changed: result.changed, booking: toAdminBooking(id, (await bookingRef.get()).data()) };
  });
}

module.exports = { listBookings, getStats, getBooking, changeStatus, rescheduleBooking, toAdminBooking, guard, MAX_SCAN, BATCH };
