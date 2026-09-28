"use strict";

// The slot rule, date/time helpers, occupancy counting and the seed file (no services needed).

process.env.NODE_ENV = "test";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { evaluateSlot, bookedCountOf, REASONS } = require("../../src/services/slots.service");
const { weekdayOf, minutesOfDay, minutesNowInTimezone } = require("../../src/utils/dates");
const { slotSchema, slotSeedSchema } = require("../../src/schemas/slot.schema");

const TZ = "Asia/Kolkata";
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const slot = (over = {}) => ({ id: "t1000", time: "10:00", label: "10:00 AM", capacity: 1, enabled: true, days: ALL_DAYS, sortOrder: 10, ...over });
const at = (iso) => new Date(iso);
const evalSlot = (over) => evaluateSlot({ slot: slot(), date: "2030-06-12", blocked: false, booked: 0, now: at("2030-06-10T09:00:00+05:30"), timeZone: TZ, cutoffMinutes: 0, ...over });

describe("evaluateSlot: the one rule behind availability AND booking", () => {
  test("a future, enabled, open, empty slot is bookable (null)", () => assert.equal(evalSlot({}), null));

  test("disabled", () => assert.equal(evalSlot({ slot: slot({ enabled: false }) }), REASONS.DISABLED));

  test("weekday availability: 2030-06-12 is a Wednesday (3)", () => {
    assert.equal(weekdayOf("2030-06-12"), 3);
    assert.equal(evalSlot({ slot: slot({ days: [1, 2] }) }), REASONS.DAY_NOT_AVAILABLE);
    assert.equal(evalSlot({ slot: slot({ days: [3] }) }), null);
  });

  test("blocked date", () => assert.equal(evalSlot({ blocked: true }), REASONS.BLOCKED));

  test("capacity: full at capacity, and if the counter is somehow above capacity", () => {
    assert.equal(evalSlot({ booked: 0 }), null);
    assert.equal(evalSlot({ booked: 1 }), REASONS.FULL);
    assert.equal(evalSlot({ booked: 5 }), REASONS.FULL);
    assert.equal(evalSlot({ slot: slot({ capacity: 3 }), booked: 2 }), null);
    assert.equal(evalSlot({ slot: slot({ capacity: 3 }), booked: 3 }), REASONS.FULL);
  });

  test("lowering capacity below what is booked refuses new bookings", () => {
    assert.equal(evalSlot({ slot: slot({ capacity: 1 }), booked: 2 }), REASONS.FULL);
  });

  test("dates before today are PAST", () => assert.equal(evalSlot({ date: "2030-06-09" }), REASONS.PAST));

  test("today: a slot is bookable until its start time, PAST from that minute on", () => {
    const today = "2030-06-10";
    assert.equal(evalSlot({ date: today, now: at("2030-06-10T09:59:00+05:30") }), null);
    assert.equal(evalSlot({ date: today, now: at("2030-06-10T10:00:00+05:30") }), REASONS.PAST);
    assert.equal(evalSlot({ date: today, now: at("2030-06-10T10:01:00+05:30") }), REASONS.PAST);
    assert.equal(evalSlot({ date: today, now: at("2030-06-10T00:00:00+05:30") }), null);
  });

  test("SLOT_CUTOFF_MINUTES closes a slot early", () => {
    const today = "2030-06-10";
    assert.equal(evalSlot({ date: today, cutoffMinutes: 60, now: at("2030-06-10T08:59:00+05:30") }), null);
    assert.equal(evalSlot({ date: today, cutoffMinutes: 60, now: at("2030-06-10T09:00:00+05:30") }), REASONS.PAST);
  });

  test("'today' is the BUSINESS day, not the UTC day", () => {
    // 20:00 UTC on 10 June is already 01:30 on 11 June in India: 10 June is over.
    const now = at("2030-06-10T20:00:00Z");
    assert.equal(evalSlot({ date: "2030-06-10", now }), REASONS.PAST);
    assert.equal(evalSlot({ date: "2030-06-11", now, slot: slot({ time: "10:00" }) }), null);
    assert.equal(evalSlot({ date: "2030-06-11", now, slot: slot({ time: "01:00" }) }), REASONS.PAST);
  });

  test("future dates ignore the time of day", () => {
    assert.equal(evalSlot({ date: "2030-06-11", now: at("2030-06-10T23:59:00+05:30"), slot: slot({ time: "00:30" }) }), null);
  });

  test("priority when several reasons apply: DISABLED > DAY_NOT_AVAILABLE > BLOCKED > PAST > FULL", () => {
    // 2030-06-09 is a Sunday (0), so a Monday-only slot does not run that day.
    const all = { slot: slot({ enabled: false, days: [1] }), blocked: true, booked: 9, date: "2030-06-09" };
    assert.equal(weekdayOf("2030-06-09"), 0);
    assert.equal(evalSlot(all), REASONS.DISABLED);
    assert.equal(evalSlot({ ...all, slot: slot({ days: [1] }) }), REASONS.DAY_NOT_AVAILABLE);
    assert.equal(evalSlot({ ...all, slot: slot() }), REASONS.BLOCKED);
    assert.equal(evalSlot({ ...all, slot: slot(), blocked: false }), REASONS.PAST);
    assert.equal(evalSlot({ ...all, slot: slot(), blocked: false, date: "2030-06-12" }), REASONS.FULL);
  });
});

describe("date/time helpers", () => {
  test("weekdayOf", () => {
    assert.equal(weekdayOf("2023-12-31"), 0);
    assert.equal(weekdayOf("2024-01-01"), 1);
    assert.equal(weekdayOf("2024-02-29"), 4);
  });
  test("minutesOfDay", () => {
    assert.equal(minutesOfDay("00:00"), 0);
    assert.equal(minutesOfDay("10:00"), 600);
    assert.equal(minutesOfDay("19:00"), 1140);
  });
  test("minutesNowInTimezone (incl. midnight, which must be 0 and not 1440)", () => {
    assert.equal(minutesNowInTimezone(TZ, at("2030-06-10T09:30:00+05:30")), 570);
    assert.equal(minutesNowInTimezone(TZ, at("2030-06-10T18:30:00Z")), 0);
    assert.equal(minutesNowInTimezone(TZ, at("2030-06-10T18:29:00Z")), 23 * 60 + 59);
  });
});

describe("bookedCountOf (occupancy counting fails safe)", () => {
  const snap = (data) => ({ exists: data !== undefined, id: "d_s", data: () => data });
  test("no document -> 0", () => {
    assert.equal(bookedCountOf(snap(undefined)), 0);
    assert.equal(bookedCountOf(undefined), 0);
  });
  test("counter and list agree -> that number", () => assert.equal(bookedCountOf(snap({ bookedCount: 2, bookingIds: ["a", "b"] })), 2));
  test("they disagree -> the LARGER (refuse, never overbook)", () => {
    assert.equal(bookedCountOf(snap({ bookedCount: 1, bookingIds: ["a", "b", "c"] })), 3);
    assert.equal(bookedCountOf(snap({ bookedCount: 4, bookingIds: ["a"] })), 4);
  });
  test("garbage counter -> falls back to the list", () => {
    assert.equal(bookedCountOf(snap({ bookedCount: "x", bookingIds: ["a"] })), 1);
    assert.equal(bookedCountOf(snap({ bookedCount: -3, bookingIds: [] })), 0);
  });
});

describe("slotSchema", () => {
  const bad = [
    ["time without minutes", { time: "10" }],
    ["24:00", { time: "24:00" }],
    ["12h time", { time: "1:00 PM" }],
    ["capacity 0", { capacity: 0 }],
    ["fractional capacity", { capacity: 1.5 }],
    ["capacity too large", { capacity: 101 }],
    ["no days", { days: [] }],
    ["day 7", { days: [7] }],
    ["repeated days", { days: [1, 1] }],
    ["non-boolean enabled", { enabled: "yes" }],
    ["empty label", { label: "" }],
    ["bad id", { id: "T 1000" }],
  ];
  for (const [name, over] of bad) {
    test(`rejects: ${name}`, () => assert.equal(slotSchema.safeParse(slot(over)).success, false));
  }
  test("accepts a valid slot", () => assert.equal(slotSchema.safeParse(slot()).success, true));
});

describe("slots.seed.json (the agreed initial slots)", () => {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "slots.seed.json"), "utf8"));

  test("valid against the schema", () => {
    const r = slotSeedSchema.safeParse(seed);
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
  });
  test("exactly 10:00 AM, 1:00 PM, 4:00 PM, 7:00 PM; capacity 1; enabled; every day", () => {
    assert.deepEqual(
      seed.slots.map((s) => [s.time, s.label, s.capacity, s.enabled, s.days.length]),
      [["10:00", "10:00 AM", 1, true, 7], ["13:00", "1:00 PM", 1, true, 7], ["16:00", "4:00 PM", 1, true, 7], ["19:00", "7:00 PM", 1, true, 7]]
    );
  });
  test("unique ids and times; ids are deterministic (t + HHMM)", () => {
    assert.equal(new Set(seed.slots.map((s) => s.id)).size, seed.slots.length);
    assert.equal(new Set(seed.slots.map((s) => s.time)).size, seed.slots.length);
    for (const s of seed.slots) assert.equal(s.id, `t${s.time.replace(":", "")}`);
  });
  test("labels match times", () => {
    const label = (t) => { const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
    for (const s of seed.slots) assert.equal(s.label, label(s.time));
  });
});
