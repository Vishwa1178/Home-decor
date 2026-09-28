"use strict";

const crypto = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const firebaseAdmin = require("../config/firebaseAdmin");
const { AppError } = require("../utils/errors");
const { calculateAmounts, initialPayment } = require("../utils/pricing");
const logger = require("../utils/logger");
const clock = require("../utils/clock");
const catalogService = require("./catalog.service");
const slotsService = require("./slots.service");
const { withKeyedLock } = require("../utils/keyedLock");
const { withContentionRetry } = require("../utils/txRetry");

// Deterministic hash of everything the client submitted (except requestId), used to
// tell "same request retried" from "same requestId reused for a different booking".
function fingerprintOf(input) {
  const { requestId, ...rest } = input; // eslint-disable-line no-unused-vars
  const canonical = JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k] ?? null]));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// What the client gets back. Contains no personal data and is identical for the
// original request and any replay.
function toReceipt(id, b) {
  return {
    id,
    status: b.status,
    package: { id: b.packageId, name: b.package },
    payment: {
      option: b.paymentOption,
      method: b.paymentMethod,
      status: b.paymentStatus,
      currency: b.currency,
      totalAmount: b.totalAmount,
      requiredAmount: b.requiredAmount,
      paidAmount: b.paidAmount,
      remainingAmount: b.remainingAmount,
    },
    slot: { id: b.slotId, label: b.timeLabel },
    date: b.date,
    time: b.time,
  };
}

function packageProblem(packageId, pkgExists) {
  return pkgExists
    ? new AppError(422, "PACKAGE_INACTIVE", "This package is not available for booking right now", [
        { field: "packageId", message: "Package is not available" },
      ])
    : new AppError(422, "PACKAGE_NOT_FOUND", "Unknown package", [{ field: "packageId", message: `No package "${packageId}"` }]);
}

function slotNotFound(slotId) {
  return new AppError(422, "SLOT_NOT_FOUND", "Unknown time slot", [{ field: "slotId", message: `No slot "${slotId}"` }]);
}

// Creates a booking exactly once per requestId AND reserves a seat in its slot.
//
// The booking document ID *is* the requestId, and everything happens in ONE
// Firestore transaction:
//   1. if a booking with this requestId exists -> replay it (same payload) or
//      409 (different payload). A replay never touches slot capacity.
//   2. read the package -> the price is the price at commit time
//   3. read the slot configuration, the blocked-date marker and the slot's occupancy
//      document for that date, and apply the shared availability rule (slots.service
//      evaluateSlot) -> reject when disabled / not that weekday / blocked / passed / FULL
//   4. create the booking AND increment the occupancy document (bookedCount, bookingIds)
// Two requests can never both take the last seat: Firestore serialises transactions
// that touch the same occupancy document, and the loser re-reads it as full.
// Returns { booking, created }.
async function createBooking(input) {
  const fingerprint = fingerprintOf(input);

  try {
    // Inside the try so credential/initialisation failures are 503s too.
    const db = firebaseAdmin.getDb();
    const bookingRef = db.collection("bookings").doc(input.requestId);
    const packageRef = db.collection("packages").doc(input.packageId);
    const slotRef = db.collection("slots").doc(input.slotId);
    const blockedRef = db.collection("blockedDates").doc(input.date);
    const occupancyRef = db.collection("slotBookings").doc(slotsService.occupancyId(input.date, input.slotId));

    // Requests for the same date+slot queue up here instead of colliding in Firestore;
    // the transaction below is still the authority (see utils/keyedLock.js).
    return await withKeyedLock(occupancyRef.id, () => withContentionRetry(() =>
      db.runTransaction(async (tx) => {
        // All reads first (Firestore requires reads before writes in a transaction).
        const [bookingSnap, packageSnap, slotSnap, blockedSnap, occupancySnap] = await tx.getAll(
          bookingRef, packageRef, slotRef, blockedRef, occupancyRef
        );

        if (bookingSnap.exists) {
          const existing = bookingSnap.data();
          if (existing.requestFingerprint !== fingerprint) {
            throw new AppError(
              409,
              "IDEMPOTENCY_KEY_REUSED",
              "This requestId was already used for a different booking. Generate a new requestId."
            );
          }
          return { booking: toReceipt(bookingSnap.id, existing), created: false };
        }

        const pkg = catalogService.parsePackageSnapshot(packageSnap);
        if (!pkg || !pkg.active) throw packageProblem(input.packageId, Boolean(pkg));

        const slot = slotsService.parseSlotSnapshot(slotSnap);
        if (!slot) throw slotNotFound(input.slotId);

        const booked = slotsService.bookedCountOf(occupancySnap);
        const reason = slotsService.evaluateSlot({ slot, date: input.date, blocked: blockedSnap.exists, booked, now: clock.now() });
        if (reason) throw slotsService.slotError(reason, input.slotId);

        // Every amount is derived here from the catalog price. Nothing numeric is
        // taken from the request.
        const payment = initialPayment({
          totalAmount: pkg.price,
          paymentOption: input.paymentOption,
          paymentMethod: input.paymentMethod,
        });

        const doc = {
          requestId: input.requestId,
          requestFingerprint: fingerprint,

          packageId: pkg.id,
          package: pkg.name, // name/category, slot and amounts are snapshots: later edits never rewrite history
          packageCategory: pkg.category,
          ...payment,

          name: input.name,
          nameLower: input.name.toLowerCase(), // for the admin's case-insensitive name-prefix search
          phone: input.phone,
          email: input.email ?? "",
          occasion: input.occasion ?? "",
          date: input.date,
          slotId: slot.id,
          slotKey: occupancyRef.id,
          time: slot.time,
          timeLabel: slot.label,
          balloonColor: input.balloonColor ?? "",
          address: input.address,
          notes: input.notes ?? "",

          status: "Pending",
          source: "web",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };

        // Reserve the seat and create the booking together.
        const bookingIds = Array.isArray(occupancySnap.data()?.bookingIds) ? occupancySnap.data().bookingIds : [];
        const occupancy = {
          date: input.date,
          slotId: slot.id,
          time: slot.time,
          capacity: slot.capacity, // snapshot for admin views; enforcement always uses the live slot config
          bookedCount: booked + 1,
          bookingIds: [...bookingIds, bookingRef.id],
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (occupancySnap.exists) tx.update(occupancyRef, occupancy);
        else tx.set(occupancyRef, { ...occupancy, createdAt: FieldValue.serverTimestamp() });

        tx.create(bookingRef, doc);
        return { booking: toReceipt(bookingRef.id, doc), created: true };
      })
    ));
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`Booking transaction failed (requestId=${input.requestId})`, err);
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Booking service is temporarily unavailable. Please try again.", undefined, { retryAfter: 1 });
  }
}

// Dry run of createBooking: same package + slot rules and pricing, reserves and writes nothing.
async function previewBooking(input) {
  const pkg = await catalogService.getActivePackage(input.packageId);
  if (!pkg) {
    // getActivePackage collapses "missing" and "inactive"; report the safe common case.
    throw packageProblem(input.packageId, false);
  }

  let slot;
  let reason;
  try {
    const db = firebaseAdmin.getDb();
    const [slotSnap, blockedSnap, occupancySnap] = await db.getAll(
      db.collection("slots").doc(input.slotId),
      db.collection("blockedDates").doc(input.date),
      db.collection("slotBookings").doc(slotsService.occupancyId(input.date, input.slotId))
    );
    slot = slotsService.parseSlotSnapshot(slotSnap);
    if (slot) {
      reason = slotsService.evaluateSlot({ slot, date: input.date, blocked: blockedSnap.exists, booked: slotsService.bookedCountOf(occupancySnap), now: clock.now() });
    }
  } catch (err) {
    logger.error("Slot lookup failed in preview", err);
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Availability is temporarily unavailable");
  }
  if (!slot) throw slotNotFound(input.slotId);
  if (reason) throw slotsService.slotError(reason, input.slotId);

  return {
    package: { id: pkg.id, name: pkg.name },
    slot: { id: slot.id, label: slot.label },
    paymentOption: input.paymentOption,
    currency: initialPayment({ totalAmount: pkg.price, paymentOption: input.paymentOption, paymentMethod: input.paymentMethod }).currency,
    ...calculateAmounts({ totalAmount: pkg.price, paymentOption: input.paymentOption }),
  };
}

module.exports = { createBooking, previewBooking, fingerprintOf, toReceipt };
