"use strict";

// Slot availability + reservation against the real Firestore emulator and Admin SDK:
// double-booking prevention, capacity, idempotency, concurrency and retries.

const helpers = require("./helpers");
helpers.setupEnv({ RATE_LIMIT_BOOKINGS_MAX: "100000", RATE_LIMIT_AVAILABILITY_MAX: "100000", RATE_LIMIT_CATALOG_MAX: "100000" });

const { test, describe, before, after, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const app = require("../../src/app");
const firebaseAdmin = require("../../src/config/firebaseAdmin");
const clock = require("../../src/utils/clock");
const { getDb } = require("../../src/config/firebaseAdmin");
const { addDays, todayInTimezone, weekdayOf } = require("../../src/utils/dates");

const TZ = "Asia/Kolkata";
const today = todayInTimezone(TZ);
const seedSlots = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "slots.seed.json"), "utf8")).slots;
let srv;

let dayCounter = 0;
const nextDate = () => addDays(today, 2 + ++dayCounter); // never today: no time-of-day flakiness

const body = (over = {}) => ({
  requestId: crypto.randomUUID(),
  packageId: "birthday-decor",
  name: "Asha Rao",
  phone: "9876543210",
  email: "asha@example.com",
  date: nextDate(),
  slotId: "t1000",
  address: "12 Lake Road, Bangalore",
  paymentOption: "HALF",
  paymentMethod: "UPI",
  ...over,
});
const post = (b) => fetch(`${srv.base}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const availability = async (date) => {
  const res = await fetch(`${srv.base}/api/availability?date=${date}`);
  return { status: res.status, headers: res.headers, json: await res.json() };
};
const slotOf = (a, id) => a.json.slots.find((s) => s.id === id);

const db = () => getDb();
const occupancy = async (date, slotId) => (await db().collection("slotBookings").doc(`${date}_${slotId}`).get()).data();
const bookingsFor = async (date, slotId) => (await db().collection("bookings").where("slotKey", "==", `${date}_${slotId}`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const setSlot = (id, patch) => db().collection("slots").doc(id).update(patch);
async function resetSlots() {
  const batch = db().batch();
  for (const { id, ...data } of seedSlots) batch.set(db().collection("slots").doc(id), data);
  await batch.commit();
}
const codes = async (responses) => Promise.all(responses.map(async (r) => ({ status: r.status, code: r.status >= 400 ? (await r.json()).code : null })));
const tally = (results) => results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});

// The invariant that must hold after ANY scenario: capacity is never exceeded and the
// occupancy documents agree exactly with the bookings that exist.
async function auditCapacity() {
  const slotConfigs = Object.fromEntries((await db().collection("slots").get()).docs.map((d) => [d.id, d.data()]));
  const occSnap = await db().collection("slotBookings").get();
  const problems = [];
  const seen = new Set();
  for (const d of occSnap.docs) {
    const o = d.data();
    const bookings = await bookingsFor(o.date, o.slotId);
    seen.add(d.id);
    if (o.bookedCount !== o.bookingIds.length) problems.push(`${d.id}: bookedCount ${o.bookedCount} != ids ${o.bookingIds.length}`);
    if (o.bookedCount !== bookings.length) problems.push(`${d.id}: bookedCount ${o.bookedCount} != bookings ${bookings.length}`);
    if (new Set(o.bookingIds).size !== o.bookingIds.length) problems.push(`${d.id}: duplicate booking ids`);
    if (!o.bookingIds.every((id) => bookings.some((b) => b.id === id))) problems.push(`${d.id}: booking id without a booking`);
    if (o.bookedCount > o.capacity) problems.push(`${d.id}: OVERBOOKED ${o.bookedCount} > snapshot capacity ${o.capacity}`);
  }
  // every booking must be counted in an occupancy document
  for (const b of (await db().collection("bookings").get()).docs) {
    const k = b.data().slotKey;
    if (k && !seen.has(k)) problems.push(`booking ${b.id} has no occupancy document ${k}`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
  return { slotConfigs };
}

before(async () => {
  await helpers.resetAndSeed();
  srv = await helpers.listen(app);
});
after(async () => {
  await auditCapacity();
  await srv.close();
});
afterEach(() => mock.restoreAll());

describe("seed script", () => {
  test("dry run writes nothing; first run creates the 4 slots; re-run and overwrite behave", async () => {
    await helpers.clearFirestore();
    let r = helpers.runScript("seed-slots.js", "--dry-run");
    assert.match(r.stdout, /\[dry run\] slots: 4 \| created: 4/);
    assert.equal((await db().collection("slots").get()).size, 0);

    r = helpers.runScript("seed-slots.js");
    assert.match(r.stdout, /slots: 4 \| created: 4, overwritten: 0, left unchanged: 0/);
    assert.equal((await db().collection("slots").get()).size, 4);

    await setSlot("t1300", { capacity: 5, enabled: false });
    r = helpers.runScript("seed-slots.js");
    assert.match(r.stdout, /created: 0, overwritten: 0, left unchanged: 4/);
    assert.deepEqual([(await db().collection("slots").doc("t1300").get()).data().capacity], [5], "admin edits are never clobbered");

    r = helpers.runScript("seed-slots.js", "--overwrite");
    assert.match(r.stdout, /overwritten: 4/);
    assert.equal((await db().collection("slots").doc("t1300").get()).data().capacity, 1);
    await helpers.resetAndSeed();
  });

  test("slot documents are deterministic: ids t1000, t1300, t1600, t1900", async () => {
    const ids = (await db().collection("slots").get()).docs.map((d) => d.id).sort();
    assert.deepEqual(ids, ["t1000", "t1300", "t1600", "t1900"]);
  });
});

describe("GET /api/availability", () => {
  test("validates the date", async () => {
    for (const q of ["", "?date=", "?date=tomorrow", "?date=2030-13-40", "?date=2031-02-31", `?date=${addDays(today, -1)}`, `?date=${addDays(today, 9999)}`]) {
      const res = await fetch(`${srv.base}/api/availability${q}`);
      assert.equal(res.status, 400, q);
      assert.equal((await res.json()).code, "VALIDATION_ERROR", q);
    }
  });

  test("an empty future date offers the 4 agreed slots, all available, exact shape, never cached", async () => {
    const date = nextDate();
    const a = await availability(date);
    assert.equal(a.status, 200);
    assert.equal(a.headers.get("cache-control"), "no-store");
    assert.equal(a.json.date, date);
    assert.equal(a.json.timezone, TZ);
    assert.equal(a.json.blocked, false);
    assert.deepEqual(
      a.json.slots.map((s) => [s.id, s.label, s.time, s.capacity, s.booked, s.remaining, s.available, s.reason]),
      [
        ["t1000", "10:00 AM", "10:00", 1, 0, 1, true, null],
        ["t1300", "1:00 PM", "13:00", 1, 0, 1, true, null],
        ["t1600", "4:00 PM", "16:00", 1, 0, 1, true, null],
        ["t1900", "7:00 PM", "19:00", 1, 0, 1, true, null],
      ]
    );
    assert.deepEqual(Object.keys(a.json.slots[0]).sort(), ["available", "booked", "capacity", "id", "label", "reason", "remaining", "time"]);
  });

  test("shows a booked slot as FULL and leaves the others available", async () => {
    const date = nextDate();
    assert.equal((await post(body({ date, slotId: "t1300" }))).status, 201);
    const a = await availability(date);
    assert.deepEqual([slotOf(a, "t1300").booked, slotOf(a, "t1300").remaining, slotOf(a, "t1300").available, slotOf(a, "t1300").reason], [1, 0, false, "FULL"]);
    for (const id of ["t1000", "t1600", "t1900"]) assert.equal(slotOf(a, id).available, true, id);
  });

  test("capacity above 1: remaining counts down 3, 2, 1, 0", async () => {
    await setSlot("t1600", { capacity: 3 });
    const date = nextDate();
    const remaining = [(slotOf(await availability(date), "t1600")).remaining];
    for (let i = 0; i < 3; i++) {
      assert.equal((await post(body({ date, slotId: "t1600" }))).status, 201);
      remaining.push(slotOf(await availability(date), "t1600").remaining);
    }
    assert.deepEqual(remaining, [3, 2, 1, 0]);
    assert.equal(slotOf(await availability(date), "t1600").reason, "FULL");
    await resetSlots();
  });

  test("a disabled slot is not offered; re-enabling brings it back", async () => {
    await setSlot("t1900", { enabled: false });
    const date = nextDate();
    assert.deepEqual((await availability(date)).json.slots.map((s) => s.id), ["t1000", "t1300", "t1600"]);
    await setSlot("t1900", { enabled: true });
    assert.equal((await availability(date)).json.slots.length, 4);
  });

  test("availability by weekday: a slot that does not run that day is not offered", async () => {
    const date = nextDate();
    const wd = weekdayOf(date);
    await setSlot("t1000", { days: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== wd) });
    const a = await availability(date);
    assert.ok(!a.json.slots.some((s) => s.id === "t1000"));
    assert.equal(a.json.slots.length, 3);
    // and the booking endpoint agrees
    const res = await post(body({ date, slotId: "t1000" }));
    assert.equal(res.status, 422);
    const j = await res.json();
    assert.equal(j.code, "SLOT_UNAVAILABLE");
    assert.match(j.issues[0].message, /does not run/);
    await resetSlots();
  });

  test("a blocked date: every slot unavailable with reason BLOCKED, and bookings are refused", async () => {
    const date = nextDate();
    await db().collection("blockedDates").doc(date).set({ reason: "Owner away" });
    const a = await availability(date);
    assert.equal(a.json.blocked, true);
    assert.equal(a.json.slots.length, 4);
    assert.ok(a.json.slots.every((s) => !s.available && s.reason === "BLOCKED"));
    assert.ok(!JSON.stringify(a.json).includes("Owner away"), "the private reason is never exposed");
    const res = await post(body({ date }));
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, "SLOT_UNAVAILABLE");
    assert.equal(await occupancy(date, "t1000"), undefined, "nothing was reserved");
    // unblocking restores it
    await db().collection("blockedDates").doc(date).delete();
    assert.equal((await post(body({ date }))).status, 201);
  });

  test("today: slots that have started are PAST (business timezone), later ones stay available", async () => {
    const now = new Date(`${today}T14:00:00+05:30`);
    mock.method(clock, "now", () => now);
    const a = await availability(today);
    assert.deepEqual(a.json.slots.map((s) => [s.id, s.available, s.reason]), [
      ["t1000", false, "PAST"], ["t1300", false, "PAST"], ["t1600", true, null], ["t1900", true, null],
    ]);
    const past = await post(body({ date: today, slotId: "t1300" }));
    assert.equal(past.status, 422);
    assert.equal((await past.json()).code, "SLOT_UNAVAILABLE");
    assert.equal(await occupancy(today, "t1300"), undefined);
    assert.equal((await post(body({ date: today, slotId: "t1600" }))).status, 201);
  });

  test("what availability says is exactly what booking enforces, in every state", async () => {
    const date = nextDate();
    assert.equal((await post(body({ date, slotId: "t1000" }))).status, 201); // t1000 FULL
    await setSlot("t1300", { enabled: false }); // t1300 hidden
    const a = await availability(date);
    for (const id of ["t1000", "t1300", "t1600", "t1900"]) {
      const shown = slotOf(a, id);
      const res = await post(body({ date, slotId: id }));
      const bookable = res.status === 201;
      assert.equal(Boolean(shown?.available), bookable, `${id}: availability=${JSON.stringify(shown)} booking=${res.status}`);
    }
    await resetSlots();
  });
});

describe("booking reserves the slot", () => {
  test("creates the booking and a deterministic occupancy document in one step", async () => {
    const b = body({ slotId: "t1600" });
    const res = await post(b);
    assert.equal(res.status, 201);
    const { booking } = await res.json();
    assert.deepEqual(booking.slot, { id: "t1600", label: "4:00 PM" });
    assert.equal(booking.time, "16:00");

    const doc = (await db().collection("bookings").doc(b.requestId).get()).data();
    assert.equal(doc.slotId, "t1600");
    assert.equal(doc.slotKey, `${b.date}_t1600`);
    assert.equal(doc.time, "16:00");
    assert.equal(doc.timeLabel, "4:00 PM");

    const occ = await occupancy(b.date, "t1600");
    assert.equal(occ.date, b.date);
    assert.equal(occ.slotId, "t1600");
    assert.equal(occ.capacity, 1);
    assert.equal(occ.bookedCount, 1);
    assert.deepEqual(occ.bookingIds, [b.requestId]);
  });

  test("a free-form `time` from an old client is ignored; the slot decides the time", async () => {
    const b = body({ time: "03:33" });
    const { booking } = await (await post(b)).json();
    assert.equal(booking.time, "10:00");
  });

  test("slotId is required; an unknown slot is 422 SLOT_NOT_FOUND; a disabled slot is 422 SLOT_UNAVAILABLE; none reserve anything", async () => {
    const b1 = body();
    delete b1.slotId;
    assert.equal((await post(b1)).status, 400);

    const date = nextDate();
    const unknown = await post(body({ date, slotId: "t0300" }));
    assert.equal(unknown.status, 422);
    assert.equal((await unknown.json()).code, "SLOT_NOT_FOUND");

    await setSlot("t1900", { enabled: false });
    const disabled = await post(body({ date, slotId: "t1900" }));
    assert.equal(disabled.status, 422);
    assert.equal((await disabled.json()).code, "SLOT_UNAVAILABLE");
    await resetSlots();

    assert.equal((await db().collection("slotBookings").where("date", "==", date).get()).size, 0);
  });

  test("atomic: a booking that fails after the slot check (unknown package) reserves nothing", async () => {
    const date = nextDate();
    const res = await post(body({ date, packageId: "no-such-package" }));
    assert.equal(res.status, 422);
    assert.equal(await occupancy(date, "t1000"), undefined);
    assert.equal(slotOf(await availability(date), "t1000").available, true);
    assert.equal((await post(body({ date }))).status, 201, "and the slot is still bookable");
  });

  test("dates and slots are independent of each other", async () => {
    const d1 = nextDate();
    const d2 = nextDate();
    const results = [];
    for (const [date, slotId] of [[d1, "t1000"], [d1, "t1300"], [d2, "t1000"], [d2, "t1300"]]) results.push((await post(body({ date, slotId }))).status);
    assert.deepEqual(results, [201, 201, 201, 201]);
  });

  test("raising capacity opens seats; lowering it below what is booked refuses new bookings but keeps existing ones", async () => {
    const date = nextDate();
    assert.equal((await post(body({ date, slotId: "t1300" }))).status, 201);
    assert.equal((await post(body({ date, slotId: "t1300" }))).status, 409);

    await setSlot("t1300", { capacity: 2 });
    assert.equal((await post(body({ date, slotId: "t1300" }))).status, 201);
    assert.equal((await post(body({ date, slotId: "t1300" }))).status, 409);

    await setSlot("t1300", { capacity: 1 }); // now 2 booked, capacity 1
    assert.equal((await post(body({ date, slotId: "t1300" }))).status, 409);
    assert.equal((await occupancy(date, "t1300")).bookedCount, 2, "existing bookings untouched");
    await resetSlots();
  });

  test("the dry-run validate endpoint checks the slot but reserves nothing", async () => {
    const date = nextDate();
    const dry = (b) => fetch(`${srv.base}/api/bookings/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const ok = await dry(body({ date }));
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).quote.slot, { id: "t1000", label: "10:00 AM" });
    assert.equal(await occupancy(date, "t1000"), undefined);

    assert.equal((await post(body({ date }))).status, 201);
    const full = await dry(body({ date }));
    assert.equal(full.status, 409);
    assert.equal((await full.json()).code, "SLOT_FULL");
  });

  test("SLOT_FULL is a clean 409 with a field-level issue", async () => {
    const date = nextDate();
    await post(body({ date }));
    const res = await post(body({ date }));
    assert.equal(res.status, 409);
    const j = await res.json();
    assert.deepEqual([j.error, j.code], ["AppError", "SLOT_FULL"]);
    assert.equal(j.issues[0].field, "slotId");
    assert.match(j.message, /fully booked/);
  });
});

describe("two users, one final slot", () => {
  test("30 rounds: exactly one of two simultaneous requests wins, the other gets SLOT_FULL", async () => {
    for (let round = 0; round < 30; round++) {
      const date = nextDate();
      const slotId = ["t1000", "t1300", "t1600", "t1900"][round % 4];
      const results = await codes(await Promise.all([post(body({ date, slotId, name: "User A" })), post(body({ date, slotId, name: "User B" }))]));
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 409], `round ${round}: ${JSON.stringify(results)}`);
      assert.equal(results.find((r) => r.status === 409).code, "SLOT_FULL");
      assert.equal((await occupancy(date, slotId)).bookedCount, 1);
      assert.equal((await bookingsFor(date, slotId)).length, 1, `round ${round}`);
    }
  });

  test("capacity 3 with 2 taken: two simultaneous requests for the last seat -> one wins", async () => {
    await setSlot("t1900", { capacity: 3 });
    const date = nextDate();
    for (let i = 0; i < 2; i++) assert.equal((await post(body({ date, slotId: "t1900" }))).status, 201);
    const statuses = (await Promise.all([post(body({ date, slotId: "t1900" })), post(body({ date, slotId: "t1900" }))])).map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409]);
    assert.equal((await occupancy(date, "t1900")).bookedCount, 3);
    assert.equal((await bookingsFor(date, "t1900")).length, 3);
    await resetSlots();
  });
});

describe("simultaneous requests", () => {
  test("10 simultaneous requests for a capacity-1 slot: exactly 1 succeeds, 9 get SLOT_FULL", async () => {
    const date = nextDate();
    const results = await codes(await Promise.all(Array.from({ length: 10 }, (_, i) => post(body({ date, name: `User ${i}` })))));
    assert.deepEqual(tally(results), { 201: 1, 409: 9 }, JSON.stringify(results));
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.code === "SLOT_FULL"));
    const occ = await occupancy(date, "t1000");
    assert.equal(occ.bookedCount, 1);
    assert.equal(occ.bookingIds.length, 1);
    assert.equal((await bookingsFor(date, "t1000")).length, 1);
  });

  test("10 simultaneous requests for a capacity-3 slot: exactly 3 succeed, 7 get SLOT_FULL", async () => {
    await setSlot("t1300", { capacity: 3 });
    const date = nextDate();
    const results = await codes(await Promise.all(Array.from({ length: 10 }, () => post(body({ date, slotId: "t1300" })))));
    assert.deepEqual(tally(results), { 201: 3, 409: 7 }, JSON.stringify(results));
    const occ = await occupancy(date, "t1300");
    assert.equal(occ.bookedCount, 3);
    assert.equal(new Set(occ.bookingIds).size, 3);
    assert.equal((await bookingsFor(date, "t1300")).length, 3);
    await resetSlots();
  });

  test("50 simultaneous requests for a capacity-5 slot: exactly 5 succeed, no request fails with a server error", async () => {
    await setSlot("t1600", { capacity: 5 });
    const date = nextDate();
    const results = await codes(await Promise.all(Array.from({ length: 50 }, () => post(body({ date, slotId: "t1600" })))));
    assert.deepEqual(tally(results), { 201: 5, 409: 45 }, JSON.stringify(tally(results)));
    assert.equal((await occupancy(date, "t1600")).bookedCount, 5);
    assert.equal((await bookingsFor(date, "t1600")).length, 5);
    await resetSlots();
  });

  test("100 simultaneous requests for a capacity-10 slot: exactly 10 succeed, the other 90 get SLOT_FULL, zero server errors", async () => {
    await setSlot("t1900", { capacity: 10 });
    const date = nextDate();
    const results = await codes(await Promise.all(Array.from({ length: 100 }, () => post(body({ date, slotId: "t1900" })))));
    assert.deepEqual(tally(results), { 201: 10, 409: 90 }, JSON.stringify(tally(results)));
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.code === "SLOT_FULL"));
    assert.equal((await occupancy(date, "t1900")).bookedCount, 10);
    assert.equal((await bookingsFor(date, "t1900")).length, 10);
    await resetSlots();
  });

  test("24 simultaneous requests spread over the 4 slots (capacity 2 each): every slot gets exactly 2", async () => {
    await Promise.all(["t1000", "t1300", "t1600", "t1900"].map((id) => setSlot(id, { capacity: 2 })));
    const date = nextDate();
    const ids = ["t1000", "t1300", "t1600", "t1900"];
    const results = await codes(await Promise.all(Array.from({ length: 24 }, (_, i) => post(body({ date, slotId: ids[i % 4] })))));
    assert.deepEqual(tally(results), { 201: 8, 409: 16 }, JSON.stringify(tally(results)));
    for (const id of ids) assert.equal((await bookingsFor(date, id)).length, 2, id);
    await resetSlots();
  });

  test("a burst mixing retried duplicates and competing customers never oversells and never contradicts itself", async () => {
    const date = nextDate();
    const winnerCandidate = body({ date });
    const others = Array.from({ length: 5 }, () => body({ date }));
    const sends = [...Array(5).fill(winnerCandidate), ...others];
    const responses = await Promise.all(sends.map(post));
    const results = await Promise.all(responses.map(async (r, i) => ({ id: sends[i].requestId, status: r.status, code: r.status >= 400 ? (await r.json()).code : null })));

    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results));
    assert.ok(results.every((r) => [200, 201, 409].includes(r.status)), JSON.stringify(results));
    // every response for one requestId must agree: either it all succeeded (201/200) or it was all refused (409)
    const byId = new Map();
    for (const r of results) byId.set(r.id, [...(byId.get(r.id) || []), r.status < 300]);
    for (const [id, oks] of byId) assert.ok(oks.every((x) => x === oks[0]), `${id} got contradictory answers`);
    assert.equal((await bookingsFor(date, "t1000")).length, 1);
  });
});

describe("duplicate submissions", () => {
  test("same requestId twice: 201 then 200 with an identical receipt; the seat is taken once", async () => {
    const b = body();
    const first = await post(b);
    const second = await post(b);
    assert.deepEqual([first.status, second.status], [201, 200]);
    assert.equal(second.headers.get("idempotent-replay"), "true");
    assert.deepEqual(await second.json(), await first.json());
    const occ = await occupancy(b.date, "t1000");
    assert.equal(occ.bookedCount, 1);
    assert.deepEqual(occ.bookingIds, [b.requestId]);
  });

  test("15 simultaneous duplicates of one request: 1x 201, 14x 200, never SLOT_FULL, one seat", async () => {
    const b = body();
    const results = await codes(await Promise.all(Array.from({ length: 15 }, () => post(b))));
    assert.deepEqual(tally(results), { 201: 1, 200: 14 }, JSON.stringify(tally(results)));
    assert.equal((await occupancy(b.date, "t1000")).bookedCount, 1);
    assert.equal((await bookingsFor(b.date, "t1000")).length, 1);
  });

  test("a duplicate does not consume a second seat when capacity is larger", async () => {
    await setSlot("t1300", { capacity: 3 });
    const b = body({ slotId: "t1300" });
    for (let i = 0; i < 5; i++) await post(b);
    assert.equal((await occupancy(b.date, "t1300")).bookedCount, 1);
    assert.equal(slotOf(await availability(b.date), "t1300").remaining, 2);
    await resetSlots();
  });

  test("same requestId but a different slot -> 409 IDEMPOTENCY_KEY_REUSED and neither slot changes", async () => {
    const b = body({ slotId: "t1000" });
    assert.equal((await post(b)).status, 201);
    const res = await post({ ...b, slotId: "t1300" });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal((await occupancy(b.date, "t1000")).bookedCount, 1);
    assert.equal(await occupancy(b.date, "t1300"), undefined);
  });

  test("same requestId with a different date -> 409 and no reservation on the new date", async () => {
    const b = body();
    assert.equal((await post(b)).status, 201);
    const other = nextDate();
    assert.equal((await post({ ...b, date: other })).status, 409);
    assert.equal(await occupancy(other, "t1000"), undefined);
  });

  test("replay still returns the original booking after the slot was disabled, blocked, or its seat count changed", async () => {
    const b = body({ slotId: "t1600" });
    const first = await (await post(b)).json();
    await setSlot("t1600", { enabled: false });
    await db().collection("blockedDates").doc(b.date).set({ reason: "x" });
    const replay = await post(b);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), first);
    await resetSlots();
  });
});

describe("retry after a network failure", () => {
  test("the response is lost but the booking was made: another customer is refused, the original retry succeeds as a replay", async () => {
    const date = nextDate();
    const a = body({ date, name: "Customer A" });
    // A's request reaches the server and is processed; imagine the reply never arrives.
    assert.equal((await post(a)).status, 201);

    const b = await post(body({ date, name: "Customer B" }));
    assert.equal(b.status, 409, "B cannot take A's seat");

    const retry = await post(a); // A retries with the SAME requestId
    assert.equal(retry.status, 200, "A's retry is a replay, not SLOT_FULL");
    assert.equal(retry.headers.get("idempotent-replay"), "true");
    assert.equal((await retry.json()).booking.id, a.requestId);
    assert.equal((await occupancy(date, "t1000")).bookedCount, 1);
    assert.deepEqual((await occupancy(date, "t1000")).bookingIds, [a.requestId]);
  });

  test("client hangs up mid-request 25 times (random timing): the retry always yields exactly one booking and one seat", async () => {
    for (let round = 0; round < 25; round++) {
      const b = body();
      const controller = new AbortController();
      const first = fetch(`${srv.base}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: controller.signal }).catch(() => "aborted");
      setTimeout(() => controller.abort(), Math.floor(Math.random() * 25));
      await first;

      const retry = await post(b);
      assert.ok([200, 201].includes(retry.status), `round ${round}: retry gave ${retry.status}`);
      // let a still-running first attempt finish, then verify nothing doubled up
      await new Promise((r) => setTimeout(r, 50));
      assert.equal((await bookingsFor(b.date, "t1000")).length, 1, `round ${round}`);
      assert.equal((await occupancy(b.date, "t1000")).bookedCount, 1, `round ${round}`);
    }
  });

  test("a raw connection cut right after sending (server keeps processing), then retry: still one booking", async () => {
    const b = body();
    const payload = JSON.stringify(b);
    const { port } = new URL(srv.base);
    await new Promise((resolve) => {
      const req = http.request({ port, path: "/api/bookings", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } });
      req.on("error", () => resolve());
      req.write(payload);
      req.end();
      setTimeout(() => { req.destroy(); resolve(); }, 1); // hang up without reading the response
    });
    const retry = await post(b);
    assert.ok([200, 201].includes(retry.status));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await bookingsFor(b.date, "t1000")).length, 1);
    assert.equal((await occupancy(b.date, "t1000")).bookedCount, 1);
  });

  test("the server fails BEFORE committing (503): nothing is reserved and the retry with the same requestId succeeds", async () => {
    const b = body();
    mock.method(firebaseAdmin, "getDb", () => { throw new Error("Could not reach Firestore"); }, { times: 1 });
    const failed = await post(b);
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).code, "SERVICE_UNAVAILABLE");
    assert.equal(failed.headers.get("retry-after"), "1");

    assert.equal(await occupancy(b.date, "t1000"), undefined, "no seat leaked");
    assert.equal((await bookingsFor(b.date, "t1000")).length, 0);
    assert.equal(slotOf(await availability(b.date), "t1000").available, true);

    const retry = await post(b);
    assert.equal(retry.status, 201);
    assert.equal((await occupancy(b.date, "t1000")).bookedCount, 1);
  });

  // A stand-in for Firestore losing a race: the first N transaction attempts are aborted.
  function abortTransactions(times) {
    const real = getDb();
    let attempts = 0;
    mock.method(firebaseAdmin, "getDb", () =>
      new Proxy(real, {
        get(target, prop) {
          if (prop === "runTransaction") {
            return (fn, opts) => {
              if (attempts++ < times) return Promise.reject(Object.assign(new Error("10 ABORTED: Too much contention on these documents. Please try again."), { code: 10 }));
              return target.runTransaction(fn, opts);
            };
          }
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      })
    );
    return () => attempts;
  }

  test("transaction contention is retried transparently: two aborted attempts still end in a normal 201", async () => {
    const b = body();
    const attempts = abortTransactions(2);
    const res = await post(b);
    assert.equal(res.status, 201);
    assert.equal(attempts(), 3);
    assert.equal((await occupancy(b.date, "t1000")).bookedCount, 1);
  });

  test("if contention never clears the customer gets a 503 with Retry-After, nothing is reserved, and the retry works", async () => {
    const b = body();
    abortTransactions(1000);
    const res = await post(b);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "1");
    mock.restoreAll();
    assert.equal(await occupancy(b.date, "t1000"), undefined);
    assert.equal((await post(b)).status, 201);
  });
});

describe("capacity audit", () => {
  test("after everything above: no slot is over capacity and every count matches the bookings that exist", async () => {
    const before = (await db().collection("slotBookings").get()).size;
    assert.ok(before > 50, `expected many occupancy documents, got ${before}`);
    await auditCapacity();
  });
});
