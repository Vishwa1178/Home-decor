"use strict";

const firebaseAdmin = require("../config/firebaseAdmin");
const { env } = require("../config/env");
const clock = require("../utils/clock");
const logger = require("../utils/logger");
const { AppError } = require("../utils/errors");
const { todayInTimezone, weekdayOf, minutesOfDay, minutesNowInTimezone } = require("../utils/dates");
const { slotDocSchema } = require("../schemas/slot.schema");

// Firestore layout
//   slots/{slotId}                     configuration (admin-editable): time, label, capacity, enabled, days
//   blockedDates/{YYYY-MM-DD}          a date on which no slot can be booked
//   slotBookings/{YYYY-MM-DD}_{slotId} deterministic occupancy document for one slot on one date:
//                                      { date, slotId, time, capacity, bookedCount, bookingIds[] }
//
// The backend is the only writer of slotBookings. Bookings reserve capacity inside the
// same Firestore transaction that creates them (bookings.service).

const REASONS = Object.freeze({
  DISABLED: "DISABLED",
  DAY_NOT_AVAILABLE: "DAY_NOT_AVAILABLE",
  BLOCKED: "BLOCKED",
  PAST: "PAST",
  FULL: "FULL",
});

const occupancyId = (date, slotId) => `${date}_${slotId}`;

function parseSlotSnapshot(snap) {
  if (!snap.exists) return null;
  const parsed = slotDocSchema.safeParse(snap.data());
  if (!parsed.success) {
    logger.error(`Invalid slot document "${snap.id}", ignoring it`, parsed.error.issues);
    return null;
  }
  return { id: snap.id, ...parsed.data };
}

// How many bookings a slot already holds on a date. If the counter and the id list ever
// disagree, trust the larger one: the failure mode must be "refuse", never "overbook".
function bookedCountOf(occupancySnap) {
  if (!occupancySnap || !occupancySnap.exists) return 0;
  const d = occupancySnap.data();
  const counter = Number.isInteger(d.bookedCount) && d.bookedCount >= 0 ? d.bookedCount : 0;
  const listed = Array.isArray(d.bookingIds) ? d.bookingIds.length : 0;
  if (counter !== listed) logger.error(`Slot occupancy mismatch on "${occupancySnap.id}": bookedCount=${counter}, bookingIds=${listed}`);
  return Math.max(counter, listed);
}

// THE rule for "can this slot be booked?". Availability (what customers see) and the
// booking transaction (what is enforced) both call this, so they cannot disagree.
// Returns null when bookable, otherwise the first blocking reason.
function evaluateSlot({ slot, date, blocked, booked, now = clock.now(), timeZone = env.BUSINESS_TIMEZONE, cutoffMinutes = env.SLOT_CUTOFF_MINUTES }) {
  if (!slot.enabled) return REASONS.DISABLED;
  if (!slot.days.includes(weekdayOf(date))) return REASONS.DAY_NOT_AVAILABLE;
  if (blocked) return REASONS.BLOCKED;

  const today = todayInTimezone(timeZone, now);
  if (date < today) return REASONS.PAST;
  if (date === today && minutesNowInTimezone(timeZone, now) >= minutesOfDay(slot.time) - cutoffMinutes) return REASONS.PAST;

  if (booked >= slot.capacity) return REASONS.FULL;
  return null;
}

const byTimeThenSort = (a, b) => a.time.localeCompare(b.time) || a.sortOrder - b.sortOrder;

// What the storefront shows for one date. Slots that are disabled or do not run on
// this weekday are not offered at all; the rest report remaining capacity and, when
// unavailable, why. Never cached: capacity changes with every booking.
async function getAvailability(date, now = clock.now()) {
  try {
    const db = firebaseAdmin.getDb();
    const slotSnap = await db.collection("slots").get();
    const slots = slotSnap.docs.map(parseSlotSnapshot).filter(Boolean).filter((s) => s.enabled && s.days.includes(weekdayOf(date))).sort(byTimeThenSort);

    const [blockedSnap, ...occupancySnaps] = slots.length
      ? await db.getAll(db.collection("blockedDates").doc(date), ...slots.map((s) => db.collection("slotBookings").doc(occupancyId(date, s.id))))
      : [await db.collection("blockedDates").doc(date).get()];
    const blocked = blockedSnap.exists;

    return {
      date,
      timezone: env.BUSINESS_TIMEZONE,
      blocked,
      slots: slots.map((slot, i) => {
        const booked = bookedCountOf(occupancySnaps[i]);
        const reason = evaluateSlot({ slot, date, blocked, booked, now });
        return {
          id: slot.id,
          label: slot.label,
          time: slot.time,
          capacity: slot.capacity,
          booked: Math.min(booked, slot.capacity),
          remaining: Math.max(0, slot.capacity - booked),
          available: reason === null,
          reason,
        };
      }),
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(`Availability lookup failed for ${date}`, err);
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Availability is temporarily unavailable");
  }
}

// The error a rejected booking gets for each reason.
function slotError(reason, slotId) {
  const field = (message) => [{ field: "slotId", message }];
  if (reason === REASONS.FULL) {
    return new AppError(409, "SLOT_FULL", "That time slot is fully booked. Please choose another.", field("Slot is fully booked"));
  }
  const messages = {
    [REASONS.DISABLED]: "This time slot is not available",
    [REASONS.DAY_NOT_AVAILABLE]: "This time slot does not run on the selected day",
    [REASONS.BLOCKED]: "Bookings are closed for the selected date",
    [REASONS.PAST]: "This time has already passed",
  };
  const err = new AppError(422, "SLOT_UNAVAILABLE", "That time slot is not available for the selected date.", field(messages[reason] || "Slot is not available"));
  err.reason = reason;
  return err;
}

module.exports = { REASONS, occupancyId, parseSlotSnapshot, bookedCountOf, evaluateSlot, getAvailability, slotError };
