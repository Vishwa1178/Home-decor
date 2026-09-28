"use strict";

// Admin API, part 2: every mutation, its effect on seats/prices/availability, and its audit entry.

const { setup, auditCapacity } = require("./adminHelpers");
const ctx = setup();

const { test, describe, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");

before(() => ctx.start());
after(async () => {
  assert.deepEqual(await auditCapacity(ctx.db), [], "capacity invariant at the end of the suite");
  await ctx.stop();
});

const slotState = async (date, slotId) => {
  const o = await ctx.occupancy(date, slotId);
  return o ? { count: o.bookedCount, ids: o.bookingIds } : { count: 0, ids: [] };
};
const bookingDoc = async (id) => (await ctx.db().collection("bookings").doc(id).get()).data();
const tally = (rs) => rs.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});

// ── booking status ────────────────────────────────────────────────────────────────
describe("confirm / cancel / update status", () => {
  test("confirm: status changes, one audit entry with the VERIFIED actor and before/after", async () => {
    const b = await ctx.book();
    assert.equal(b.status, 201);
    const before = await ctx.auditCount();

    const res = await ctx.patch(`/bookings/${b.id}/status`, { status: "Confirmed", expectedStatus: "Pending" });
    assert.equal(res.status, 200);
    assert.equal(res.json.changed, true);
    assert.equal(res.json.booking.status, "Confirmed");
    assert.equal(res.json.booking.id, b.id);

    assert.equal(await ctx.auditCount(), before + 1);
    const [entry] = await ctx.auditFor("booking", b.id);
    assert.deepEqual([entry.action, entry.entityType, entry.entityId], ["booking.status_changed", "booking", b.id]);
    assert.deepEqual(entry.actor, { uid: ctx.tokens.admin.uid, email: ctx.tokens.admin.email }, "actor comes from the verified token");
    assert.deepEqual(entry.before, { status: "Pending" });
    assert.equal(entry.after.status, "Confirmed");
    assert.ok(entry.at.toDate() instanceof Date, "server timestamp");
    assert.ok(entry.meta.ip !== undefined);
    assert.ok(!JSON.stringify(entry).includes("Asha") && !JSON.stringify(entry).includes("9876543210"), "the audit entry holds no customer PII");
  });

  test("the actor cannot be chosen by the caller: a body carrying an actor/email is rejected", async () => {
    const b = await ctx.book();
    const res = await ctx.patch(`/bookings/${b.id}/status`, { status: "Confirmed", actor: { email: "ceo@example.com" } });
    assert.equal(res.status, 400);
    assert.equal((await bookingDoc(b.id)).status, "Pending");
    assert.equal((await ctx.auditFor("booking", b.id)).length, 0);
  });

  test("repeating a change is a harmless no-op: changed:false and NO second audit entry", async () => {
    const b = await ctx.book();
    await ctx.patch(`/bookings/${b.id}/status`, { status: "Confirmed" });
    const again = await ctx.patch(`/bookings/${b.id}/status`, { status: "Confirmed" });
    assert.equal(again.status, 200);
    assert.equal(again.json.changed, false);
    assert.equal((await ctx.auditFor("booking", b.id)).length, 1);
  });

  test("confirmed can go back to pending", async () => {
    const b = await ctx.book();
    await ctx.patch(`/bookings/${b.id}/status`, { status: "Confirmed" });
    const res = await ctx.patch(`/bookings/${b.id}/status`, { status: "Pending" });
    assert.equal(res.json.booking.status, "Pending");
    assert.equal((await ctx.auditFor("booking", b.id)).length, 2);
  });

  test("cancel needs a real reason; nothing changes without one", async () => {
    const b = await ctx.book();
    for (const body of [{ status: "Cancelled" }, { status: "Cancelled", reason: "" }, { status: "Cancelled", reason: "ab" }]) {
      const res = await ctx.patch(`/bookings/${b.id}/status`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.ok(res.json.issues.some((i) => i.field === "reason"));
    }
    assert.equal((await bookingDoc(b.id)).status, "Pending");
    assert.equal((await slotState(b.body.date, "t1000")).count, 1, "seat still held");
  });

  test("cancel frees the slot seat; the slot is bookable again; the reason is recorded", async () => {
    const date = ctx.nextDate();
    const b = await ctx.book({ date });
    assert.equal((await ctx.book({ date })).status, 409, "slot is full");

    const res = await ctx.patch(`/bookings/${b.id}/status`, { status: "Cancelled", reason: "Customer changed plans" });
    assert.equal(res.status, 200);
    assert.equal(res.json.booking.status, "Cancelled");
    assert.equal(res.json.booking.cancelReason, "Customer changed plans");
    assert.ok(res.json.booking.cancelledAt);

    assert.deepEqual(await slotState(date, "t1000"), { count: 0, ids: [] });
    const slot = (await ctx.availability(date)).slots.find((s) => s.id === "t1000");
    assert.deepEqual([slot.available, slot.remaining], [true, 1]);

    const [entry] = await ctx.auditFor("booking", b.id);
    assert.equal(entry.reason, "Customer changed plans");
    assert.deepEqual([entry.before.status, entry.after.status, entry.after.seat], ["Pending", "Cancelled", "released"]);

    assert.equal((await ctx.book({ date })).status, 201, "another customer takes the freed seat");
  });

  test("cancelling twice never frees a seat that now belongs to someone else", async () => {
    const date = ctx.nextDate();
    const first = await ctx.book({ date });
    await ctx.patch(`/bookings/${first.id}/status`, { status: "Cancelled", reason: "no longer needed" });
    const second = await ctx.book({ date }); // takes the freed seat
    assert.equal(second.status, 201);

    const again = await ctx.patch(`/bookings/${first.id}/status`, { status: "Cancelled", reason: "no longer needed" });
    assert.equal(again.json.changed, false);
    assert.deepEqual(await slotState(date, "t1000"), { count: 1, ids: [second.id] }, "the second customer keeps the seat");
    assert.equal((await ctx.auditFor("booking", first.id)).length, 1);
  });

  test("10 simultaneous cancels of one booking: the seat is freed exactly once, one audit entry", async () => {
    const date = ctx.nextDate();
    const b = await ctx.book({ date });
    const results = await Promise.all(Array.from({ length: 10 }, () => ctx.patch(`/bookings/${b.id}/status`, { status: "Cancelled", reason: "duplicate clicks" })));
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(tally(results)));
    assert.equal(results.filter((r) => r.json.changed).length, 1);
    assert.deepEqual(await slotState(date, "t1000"), { count: 0, ids: [] });
    assert.equal((await ctx.auditFor("booking", b.id)).length, 1);
  });

  test("two admins confirming at once: one change, one audit entry", async () => {
    const b = await ctx.book();
    const rs = await Promise.all([ctx.patch(`/bookings/${b.id}/status`, { status: "Confirmed" }), ctx.patch(`/bookings/${b.id}/status`, { status: "Confirmed" })]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200]);
    assert.equal(rs.filter((r) => r.json.changed).length, 1);
    assert.equal((await ctx.auditFor("booking", b.id)).length, 1);
  });

  test("reopening a cancelled booking takes the seat back", async () => {
    const date = ctx.nextDate();
    const b = await ctx.book({ date });
    await ctx.patch(`/bookings/${b.id}/status`, { status: "Cancelled", reason: "mistake" });
    const res = await ctx.patch(`/bookings/${b.id}/status`, { status: "Confirmed", reason: "customer called back" });
    assert.equal(res.status, 200);
    assert.equal(res.json.booking.status, "Confirmed");
    assert.ok(!("cancelReason" in res.json.booking) && !("cancelledAt" in res.json.booking), "cancel fields are cleared");
    assert.deepEqual(await slotState(date, "t1000"), { count: 1, ids: [b.id] });
    const entries = await ctx.auditFor("booking", b.id);
    assert.equal(entries[entries.length - 1].after.seat, "reserved");
  });

  test("reopening when someone else took the seat: 409 SLOT_FULL, still cancelled, no audit entry, their seat untouched", async () => {
    const date = ctx.nextDate();
    const a = await ctx.book({ date });
    await ctx.patch(`/bookings/${a.id}/status`, { status: "Cancelled", reason: "moving away" });
    const other = await ctx.book({ date });
    const auditBefore = await ctx.auditCount();

    const res = await ctx.patch(`/bookings/${a.id}/status`, { status: "Pending" });
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "SLOT_FULL");
    assert.equal((await bookingDoc(a.id)).status, "Cancelled");
    assert.deepEqual(await slotState(date, "t1000"), { count: 1, ids: [other.id] });
    assert.equal(await ctx.auditCount(), auditBefore);
  });

  test("optimistic check: a stale expectedStatus is a 409 STATUS_CONFLICT and changes nothing", async () => {
    const b = await ctx.book();
    await ctx.patch(`/bookings/${b.id}/status`, { status: "Confirmed" });
    const res = await ctx.patch(`/bookings/${b.id}/status`, { status: "Cancelled", reason: "stale screen", expectedStatus: "Pending" });
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "STATUS_CONFLICT");
    assert.equal((await bookingDoc(b.id)).status, "Confirmed");
  });

  test("unknown booking is 404; bad ids and statuses are 400; payment fields cannot be smuggled in", async () => {
    assert.equal((await ctx.patch("/bookings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/status", { status: "Confirmed" })).status, 404);
    assert.equal((await ctx.patch("/bookings/bad%20id!/status", { status: "Confirmed" })).status, 400);
    const b = await ctx.book();
    assert.equal((await ctx.patch(`/bookings/${b.id}/status`, { status: "Paid" })).status, 400);
    const smuggle = await ctx.patch(`/bookings/${b.id}/status`, { status: "Confirmed", paymentStatus: "PAID", paidAmount: 999 });
    assert.equal(smuggle.status, 400);
    const doc = await bookingDoc(b.id);
    assert.deepEqual([doc.status, doc.paymentStatus, doc.paidAmount], ["Pending", "PENDING", 0], "payments are view-only");
  });

  test("changing a status never touches payment state", async () => {
    const b = await ctx.book();
    await ctx.patch(`/bookings/${b.id}/status`, { status: "Confirmed" });
    await ctx.patch(`/bookings/${b.id}/status`, { status: "Cancelled", reason: "testing payment state" });
    const doc = await bookingDoc(b.id);
    assert.deepEqual([doc.paymentStatus, doc.paidAmount, doc.razorpayOrderId, doc.razorpayPaymentId, doc.razorpaySignature], ["PENDING", 0, null, null, null]);
  });
});

// ── reschedule ───────────────────────────────────────────────────────────────────
describe("reschedule", () => {
  test("moves the booking AND the seat; audit records old and new", async () => {
    const d1 = ctx.nextDate();
    const d2 = ctx.nextDate();
    const b = await ctx.book({ date: d1, slotId: "t1000" });
    const res = await ctx.post(`/bookings/${b.id}/reschedule`, { date: d2, slotId: "t1300", reason: "Customer request" });
    assert.equal(res.status, 200);
    assert.equal(res.json.changed, true);
    const nb = res.json.booking;
    assert.deepEqual([nb.date, nb.slotId, nb.slotKey, nb.time, nb.timeLabel], [d2, "t1300", `${d2}_t1300`, "13:00", "1:00 PM"]);
    assert.deepEqual(nb.rescheduledFrom, { date: d1, slotId: "t1000", time: "10:00", timeLabel: "10:00 AM" });

    assert.deepEqual(await slotState(d1, "t1000"), { count: 0, ids: [] }, "old seat freed");
    assert.deepEqual(await slotState(d2, "t1300"), { count: 1, ids: [b.id] }, "new seat taken");
    assert.equal((await ctx.availability(d1)).slots.find((s) => s.id === "t1000").available, true);
    assert.equal((await ctx.availability(d2)).slots.find((s) => s.id === "t1300").available, false);

    const [entry] = await ctx.auditFor("booking", b.id);
    assert.equal(entry.action, "booking.rescheduled");
    assert.deepEqual(entry.before, { date: d1, slotId: "t1000", time: "10:00 AM" });
    assert.deepEqual([entry.after.date, entry.after.slotId, entry.after.time, entry.after.seat], [d2, "t1300", "1:00 PM", "moved"]);
    assert.equal(entry.reason, "Customer request");
  });

  test("same date and slot is a no-op (no audit)", async () => {
    const b = await ctx.book();
    const res = await ctx.post(`/bookings/${b.id}/reschedule`, { date: b.body.date, slotId: "t1000" });
    assert.equal(res.json.changed, false);
    assert.equal((await ctx.auditFor("booking", b.id)).length, 0);
  });

  test("into a full slot: 409 SLOT_FULL, the booking keeps its ORIGINAL seat, no audit", async () => {
    const d1 = ctx.nextDate();
    const d2 = ctx.nextDate();
    const b = await ctx.book({ date: d1 });
    const holder = await ctx.book({ date: d2 });
    const res = await ctx.post(`/bookings/${b.id}/reschedule`, { date: d2, slotId: "t1000" });
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "SLOT_FULL");
    assert.deepEqual(await slotState(d1, "t1000"), { count: 1, ids: [b.id] });
    assert.deepEqual(await slotState(d2, "t1000"), { count: 1, ids: [holder.id] });
    assert.equal((await bookingDoc(b.id)).date, d1);
    assert.equal((await ctx.auditFor("booking", b.id)).length, 0);
  });

  test("blocked date, disabled slot, unknown slot, past date: refused, nothing moves", async () => {
    const b = await ctx.book();
    const blocked = ctx.addDays(ctx.today, 402);
    await ctx.put(`/blocked-dates/${blocked}`, { reason: "closed" });
    assert.equal((await ctx.post(`/bookings/${b.id}/reschedule`, { date: blocked, slotId: "t1300" })).json.code, "SLOT_UNAVAILABLE");
    await ctx.del(`/blocked-dates/${blocked}`);

    await ctx.patch("/slots/t1900", { enabled: false });
    assert.equal((await ctx.post(`/bookings/${b.id}/reschedule`, { date: ctx.nextDate(), slotId: "t1900" })).json.code, "SLOT_UNAVAILABLE");
    await ctx.patch("/slots/t1900", { enabled: true });

    assert.equal((await ctx.post(`/bookings/${b.id}/reschedule`, { date: ctx.nextDate(), slotId: "t0300" })).status, 404);
    assert.equal((await ctx.post(`/bookings/${b.id}/reschedule`, { date: "2001-01-01", slotId: "t1300" })).status, 400);
    assert.equal((await bookingDoc(b.id)).date, b.body.date);
    assert.deepEqual(await slotState(b.body.date, "t1000"), { count: 1, ids: [b.id] });
    assert.equal((await ctx.auditFor("booking", b.id)).length, 0);
  });

  test("a cancelled booking cannot be rescheduled (409 BOOKING_CANCELLED)", async () => {
    const b = await ctx.book();
    await ctx.patch(`/bookings/${b.id}/status`, { status: "Cancelled", reason: "cancelled first" });
    const res = await ctx.post(`/bookings/${b.id}/reschedule`, { date: ctx.nextDate(), slotId: "t1300" });
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "BOOKING_CANCELLED");
  });

  test("stale expectedDate/expectedSlotId: 409 SCHEDULE_CONFLICT", async () => {
    const b = await ctx.book();
    const res = await ctx.post(`/bookings/${b.id}/reschedule`, { date: ctx.nextDate(), slotId: "t1300", expectedDate: ctx.nextDate() });
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "SCHEDULE_CONFLICT");
  });

  test("an older booking that never held a seat can be rescheduled (nothing to free)", async () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const legacyDate = ctx.nextDate();
    await ctx.db().collection("bookings").doc(id).set({ name: "Old Customer", phone: "9000000000", package: "Birthday Decor", packageId: "birthday-decor", date: legacyDate, time: "18:30", status: "Pending", createdAt: new Date() });
    const target = ctx.nextDate();
    const res = await ctx.post(`/bookings/${id}/reschedule`, { date: target, slotId: "t1600" });
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.booking.date, res.json.booking.slotId, res.json.booking.timeLabel], [target, "t1600", "4:00 PM"]);
    assert.deepEqual(res.json.booking.rescheduledFrom, { date: legacyDate, slotId: null, time: "18:30", timeLabel: null });
    assert.deepEqual(await slotState(target, "t1600"), { count: 1, ids: [id] });
    const [entry] = await ctx.auditFor("booking", id);
    assert.equal(entry.after.seat, "reserved");
    await ctx.patch(`/bookings/${id}/status`, { status: "Cancelled", reason: "cleanup" });
    assert.deepEqual(await slotState(target, "t1600"), { count: 0, ids: [] });
  });

  test("two bookings racing into the LAST seat of one slot: exactly one moves, the loser keeps its old seat", async () => {
    for (let round = 0; round < 6; round++) {
      const target = ctx.nextDate();
      const a = await ctx.book({ date: ctx.nextDate() });
      const b = await ctx.book({ date: ctx.nextDate() });
      const rs = await Promise.all([
        ctx.post(`/bookings/${a.id}/reschedule`, { date: target, slotId: "t1300" }),
        ctx.post(`/bookings/${b.id}/reschedule`, { date: target, slotId: "t1300" }),
      ]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], `round ${round}: ${JSON.stringify(rs.map((r) => r.json.code || r.json.changed))}`);
      const winner = rs[0].status === 200 ? a : b;
      const loser = winner === a ? b : a;
      assert.deepEqual(await slotState(target, "t1300"), { count: 1, ids: [winner.id] });
      assert.deepEqual(await slotState(loser.body.date, "t1000"), { count: 1, ids: [loser.id] }, "loser keeps its original seat");
      assert.deepEqual(await slotState(winner.body.date, "t1000"), { count: 0, ids: [] }, "winner's old seat is free");
    }
  });

  test("a customer cannot take the seat being moved into, and cancel/reschedule interleavings keep the counters exact", async () => {
    const target = ctx.nextDate();
    const movers = [];
    for (let i = 0; i < 5; i++) movers.push(await ctx.book({ date: ctx.nextDate() }));
    const ops = [
      ...movers.map((m) => ctx.post(`/bookings/${m.id}/reschedule`, { date: target, slotId: "t1600" })),
      ...Array.from({ length: 5 }, () => ctx.book({ date: target, slotId: "t1600" })),
      ctx.patch(`/bookings/${movers[0].id}/status`, { status: "Cancelled", reason: "racing" }),
    ];
    await Promise.all(ops);
    assert.deepEqual(await auditCapacity(ctx.db), []);
    assert.ok((await slotState(target, "t1600")).count <= 1, "capacity 1 is never exceeded");
  });
});

// ── packages ─────────────────────────────────────────────────────────────────────
describe("packages", () => {
  const publicPkg = async (id) => (await (await fetch(`${ctx.srv.base}/api/packages`)).json()).packages.find((p) => p.id === id);

  test("the admin catalog lists everything, including disabled packages, plus categories", async () => {
    await ctx.db().collection("packages").doc("pooja-setup").update({ active: false });
    const res = await ctx.get("/catalog");
    assert.equal(res.status, 200);
    assert.equal(res.json.packages.length, 32);
    assert.equal(res.json.packages.find((p) => p.id === "pooja-setup").active, false);
    assert.equal(res.json.categories.length, 7);
    assert.match(res.json.packages[0].updatedAt, /^\d{4}-/);
    await ctx.db().collection("packages").doc("pooja-setup").update({ active: true });
  });

  test("add a package: 201, id from the name, audit entry, customers see it AT ONCE despite the 60 s catalog cache", async () => {
    await publicPkg("warm-the-cache");
    const res = await ctx.post("/packages", { name: "Neon Party Setup", category: "birthday", price: 3333, description: "Glow-in-the-dark decor", featured: true });
    assert.equal(res.status, 201);
    assert.equal(res.json.package.id, "neon-party-setup");
    assert.deepEqual([res.json.package.active, res.json.package.price, res.json.package.featured], [true, 3333, true]);
    const live = await publicPkg("neon-party-setup");
    assert.deepEqual([live.name, live.price, live.paymentOptions.HALF.requiredAmount], ["Neon Party Setup", 3333, 1667]);
    const [entry] = await ctx.auditFor("package", "neon-party-setup");
    assert.equal(entry.action, "package.created");
    assert.deepEqual([entry.after.price, entry.after.category], [3333, "birthday"]);
    assert.equal(entry.actor.email, ctx.tokens.admin.email);
    assert.equal((await ctx.book({ packageId: "neon-party-setup" })).json.booking.payment.totalAmount, 3333);
  });

  test("validation: duplicate id 409, unknown category 422, bad price/name/image 400, unknown fields 400; nothing created", async () => {
    const auditBefore = await ctx.auditCount();
    assert.equal((await ctx.post("/packages", { name: "Neon Party Setup", category: "birthday", price: 1 })).json.code, "PACKAGE_EXISTS");
    assert.equal((await ctx.post("/packages", { id: "birthday-decor", name: "Clash", category: "birthday", price: 1 })).status, 409);
    assert.equal((await ctx.post("/packages", { name: "Ghost", category: "nope", price: 100 })).json.code, "CATEGORY_NOT_FOUND");
    for (const bad of [{ name: "X", category: "birthday", price: 100 }, { name: "Ok Name", category: "birthday", price: 0 }, { name: "Ok Name", category: "birthday", price: 12.5 }, { name: "Ok Name", category: "birthday", price: "100" },
      { name: "Ok Name", category: "birthday", price: 100, image: "javascript:alert(1)" }, { name: "Ok Name", category: "birthday", price: 100, createdAt: "x" }, { name: "!!!", category: "birthday", price: 100 }, {}]) {
      assert.equal((await ctx.post("/packages", bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal(await ctx.auditCount(), auditBefore, "failed creations leave no audit entries");
    assert.equal((await ctx.db().collection("packages").get()).size, 33);
  });

  test("change the price: ONLY the price changes (description, image, featured preserved), audit has just the price", async () => {
    await ctx.db().collection("packages").doc("premium-decoration").update({ description: "Keep me", image: "https://example.com/p.jpg", featured: true });
    const res = await ctx.patch("/packages/premium-decoration", { price: 2599 });
    assert.equal(res.status, 200);
    assert.equal(res.json.changed, true);
    const doc = (await ctx.db().collection("packages").doc("premium-decoration").get()).data();
    assert.deepEqual([doc.price, doc.description, doc.image, doc.featured, doc.active, doc.category, doc.name], [2599, "Keep me", "https://example.com/p.jpg", true, true, "birthday", "Premium Decoration"]);
    const entries = await ctx.auditFor("package", "premium-decoration");
    assert.deepEqual([entries.length, entries[0].action, entries[0].before, entries[0].after], [1, "package.updated", { price: 2499 }, { price: 2599 }]);
  });

  test("a price change applies to NEW bookings at once; existing bookings keep their snapshot", async () => {
    const before = await ctx.book({ packageId: "room-decoration" }); // Rs. 1,199
    assert.equal(before.json.booking.payment.totalAmount, 1199);
    assert.equal((await ctx.patch("/packages/room-decoration", { price: 1299 })).status, 200);
    assert.equal((await publicPkg("room-decoration")).price, 1299, "public catalog updated immediately");
    const after = await ctx.book({ packageId: "room-decoration" });
    assert.deepEqual([after.json.booking.payment.totalAmount, after.json.booking.payment.requiredAmount], [1299, 650]);
    assert.equal((await bookingDoc(before.id)).totalAmount, 1199, "old booking unchanged");
  });

  test("disable hides it from customers and refuses bookings; enable brings it back", async () => {
    assert.equal((await ctx.patch("/packages/haldi-decor", { active: false })).json.package.active, false);
    assert.equal(await publicPkg("haldi-decor"), undefined);
    assert.equal((await ctx.book({ packageId: "haldi-decor" })).json.code, "PACKAGE_INACTIVE");
    assert.equal((await ctx.patch("/packages/haldi-decor", { active: true })).json.package.active, true);
    assert.ok(await publicPkg("haldi-decor"));
    assert.equal((await ctx.book({ packageId: "haldi-decor" })).status, 201);
    assert.deepEqual((await ctx.auditFor("package", "haldi-decor")).map((e) => e.after), [{ active: false }, { active: true }]);
  });

  test("edit name, category, description, image, featured, order in one go; audit lists only changed fields", async () => {
    const res = await ctx.patch("/packages/diwali-decor", { name: "Diwali Decor Deluxe", description: "Lights and rangoli", image: "https://example.com/d.jpg", featured: true, sortOrder: 5, category: "festival" });
    assert.equal(res.status, 200);
    const [entry] = await ctx.auditFor("package", "diwali-decor");
    assert.deepEqual(Object.keys(entry.after).sort(), ["description", "featured", "image", "name", "sortOrder"], "category was unchanged, so it is not in the diff");
    assert.equal(entry.before.name, "Diwali Decor");
  });

  test("a no-op patch changes nothing and writes no audit entry", async () => {
    const before = await ctx.auditCount();
    const res = await ctx.patch("/packages/diwali-decor", { price: 1799 });
    assert.equal(res.json.changed, false);
    assert.equal(await ctx.auditCount(), before);
  });

  test("validation on edit: bad values 400, unknown category 422, unknown id 404, id/createdAt immutable, empty patch 400", async () => {
    const before = await ctx.auditCount();
    for (const bad of [{ price: 0 }, { price: -1 }, { price: 1.5 }, { price: "5" }, { name: "x" }, { image: "data:text/html,x" }, { id: "renamed" }, { createdAt: "x" }, {}, { expectedUpdatedAt: "2030-01-01T00:00:00.000Z" }]) {
      assert.equal((await ctx.patch("/packages/diwali-decor", bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await ctx.patch("/packages/diwali-decor", { category: "nope" })).json.code, "CATEGORY_NOT_FOUND");
    assert.equal((await ctx.patch("/packages/no-such-package", { price: 100 })).status, 404);
    assert.equal(await ctx.auditCount(), before);
  });

  test("stale edits are refused: expectedUpdatedAt must match", async () => {
    const list = await ctx.get("/catalog");
    const p = list.json.packages.find((x) => x.id === "festive-lighting-setup");
    assert.equal((await ctx.patch("/packages/festive-lighting-setup", { price: 1310, expectedUpdatedAt: p.updatedAt })).status, 200);
    const stale = await ctx.patch("/packages/festive-lighting-setup", { price: 1320, expectedUpdatedAt: p.updatedAt });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, "STALE_UPDATE");
    assert.equal((await ctx.db().collection("packages").doc("festive-lighting-setup").get()).data().price, 1310);
  });
});

// ── slots ────────────────────────────────────────────────────────────────────────
describe("slots", () => {
  afterEach(() => ctx.resetSlots());

  test("list shows every slot including disabled ones", async () => {
    await ctx.patch("/slots/t1900", { enabled: false });
    const res = await ctx.get("/slots");
    assert.deepEqual(res.json.slots.map((s) => [s.id, s.enabled]), [["t1000", true], ["t1300", true], ["t1600", true], ["t1900", false]]);
  });

  test("add a slot: id t1700, label generated, audit entry, customers see it (in time order) at once", async () => {
    const res = await ctx.post("/slots", { time: "17:00", capacity: 2 });
    assert.equal(res.status, 201);
    assert.deepEqual([res.json.slot.id, res.json.slot.label, res.json.slot.capacity, res.json.slot.enabled, res.json.slot.days], ["t1700", "5:00 PM", 2, true, [0, 1, 2, 3, 4, 5, 6]]);
    const a = await ctx.availability(ctx.nextDate());
    assert.deepEqual(a.slots.map((s) => [s.label, s.capacity]), [["10:00 AM", 1], ["1:00 PM", 1], ["4:00 PM", 1], ["5:00 PM", 2], ["7:00 PM", 1]]);
    const [entry] = await ctx.auditFor("slot", "t1700");
    assert.deepEqual([entry.action, entry.after.capacity, entry.actor.email], ["slot.created", 2, ctx.tokens.admin.email]);
    assert.equal((await ctx.book({ slotId: "t1700" })).status, 201);
  });

  test("a slot at an existing time is 409 SLOT_EXISTS; bad input is 400; nothing created", async () => {
    const before = await ctx.auditCount();
    assert.equal((await ctx.post("/slots", { time: "10:00", capacity: 1 })).json.code, "SLOT_EXISTS");
    for (const bad of [{ time: "5pm", capacity: 1 }, { time: "17:00", capacity: 0 }, { time: "17:00", capacity: 101 }, { time: "17:00", capacity: 1, days: [] }, { time: "17:00", capacity: 1, days: [9] }, { capacity: 1 }, { time: "17:00" }, { time: "17:00", capacity: 1, id: "x" }]) {
      assert.equal((await ctx.post("/slots", bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal(await ctx.auditCount(), before);
    assert.equal((await ctx.db().collection("slots").get()).size, 4);
  });

  test("change capacity: customers see the new seat count immediately", async () => {
    const res = await ctx.patch("/slots/t1300", { capacity: 3 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.warnings, []);
    const date = ctx.nextDate();
    assert.equal((await ctx.availability(date)).slots.find((s) => s.id === "t1300").remaining, 3);
    for (let i = 0; i < 3; i++) assert.equal((await ctx.book({ date, slotId: "t1300" })).status, 201);
    assert.equal((await ctx.book({ date, slotId: "t1300" })).status, 409);
    const [entry] = await ctx.auditFor("slot", "t1300");
    assert.deepEqual([entry.before, entry.after], [{ capacity: 1 }, { capacity: 3 }]);
  });

  test("lowering capacity below existing bookings warns, keeps them, and accepts no new ones", async () => {
    await ctx.patch("/slots/t1300", { capacity: 3 });
    const date = ctx.nextDate();
    for (let i = 0; i < 3; i++) await ctx.book({ date, slotId: "t1300" });
    const res = await ctx.patch("/slots/t1300", { capacity: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.json.warnings.length, 1);
    assert.equal(res.json.warnings[0].code, "OVER_CAPACITY");
    // every date listed really is over the new capacity (earlier tests may have left other such dates)
    assert.ok(res.json.warnings[0].dates.includes(date));
    for (const d of res.json.warnings[0].dates) assert.ok((await ctx.occupancy(d, "t1300")).bookedCount > 1, d);
    assert.equal((await slotState(date, "t1300")).count, 3, "existing bookings untouched");
    assert.equal((await ctx.book({ date, slotId: "t1300" })).status, 409);
  });

  test("disable: hidden from customers, bookings refused; enable restores", async () => {
    assert.equal((await ctx.patch("/slots/t1600", { enabled: false })).json.slot.enabled, false);
    const date = ctx.nextDate();
    assert.ok(!(await ctx.availability(date)).slots.some((s) => s.id === "t1600"));
    assert.equal((await ctx.book({ date, slotId: "t1600" })).json.code, "SLOT_UNAVAILABLE");
    assert.equal((await ctx.patch("/slots/t1600", { enabled: true })).json.slot.enabled, true);
    assert.equal((await ctx.book({ date, slotId: "t1600" })).status, 201);
  });

  test("availability by weekday and label edits take effect", async () => {
    const date = ctx.nextDate();
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
    await ctx.patch("/slots/t1000", { days: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== wd), label: "Morning" });
    const a = await ctx.availability(date);
    assert.ok(!a.slots.some((s) => s.id === "t1000"));
    assert.equal((await ctx.availability(ctx.addDays(date, 1))).slots.find((s) => s.id === "t1000").label, "Morning");
  });

  test("a slot's time cannot be changed; unknown fields and ids are refused; unknown slot is 404; no-op writes no audit", async () => {
    const before = await ctx.auditCount();
    for (const bad of [{ time: "11:00" }, { id: "t9999" }, { capacity: 0 }, { capacity: 1.5 }, { days: [] }, { enabled: "yes" }, {}, { createdAt: "x" }]) {
      assert.equal((await ctx.patch("/slots/t1000", bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await ctx.patch("/slots/t0000", { capacity: 2 })).status, 404);
    assert.equal((await ctx.patch("/slots/t1000", { capacity: 1 })).json.changed, false);
    assert.equal(await ctx.auditCount(), before);
  });

  test("stale edits are refused: expectedUpdatedAt must match", async () => {
    const slot = (await ctx.get("/slots")).json.slots.find((s) => s.id === "t1900");
    assert.equal((await ctx.patch("/slots/t1900", { capacity: 2, expectedUpdatedAt: slot.updatedAt })).status, 200);
    const stale = await ctx.patch("/slots/t1900", { capacity: 3, expectedUpdatedAt: slot.updatedAt });
    assert.deepEqual([stale.status, stale.json.code], [409, "STALE_UPDATE"]);
  });
});

// ── blocked dates & booked capacity ───────────────────────────────────────────────
describe("blocking availability and viewing booked capacity", () => {
  test("block a date: customers see it closed (without the private reason) and cannot book; audit entry", async () => {
    const date = ctx.nextDate();
    const res = await ctx.put(`/blocked-dates/${date}`, { reason: "Owner away" });
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.changed, res.json.blockedDate.reason, res.json.existingBookings], [true, "Owner away", 0]);
    const a = await ctx.availability(date);
    assert.equal(a.blocked, true);
    assert.ok(a.slots.every((s) => s.reason === "BLOCKED"));
    assert.ok(!JSON.stringify(a).includes("Owner away"));
    assert.equal((await ctx.book({ date })).json.code, "SLOT_UNAVAILABLE");
    const [entry] = await ctx.auditFor("blockedDate", date);
    assert.deepEqual([entry.action, entry.before, entry.after], ["blockedDate.blocked", null, { reason: "Owner away" }]);
  });

  test("blocking a date that already has bookings reports how many; they are NOT cancelled", async () => {
    const date = ctx.nextDate();
    const a = await ctx.book({ date, slotId: "t1000" });
    const b = await ctx.book({ date, slotId: "t1300" });
    const res = await ctx.put(`/blocked-dates/${date}`, { reason: "Storm" });
    assert.equal(res.json.existingBookings, 2);
    assert.equal((await bookingDoc(a.id)).status, "Pending");
    assert.equal((await bookingDoc(b.id)).status, "Pending");
  });

  test("blocking again with the same reason is a no-op; a new reason is an update; unblocking twice is a no-op", async () => {
    const date = ctx.nextDate();
    await ctx.put(`/blocked-dates/${date}`, { reason: "A" });
    assert.equal((await ctx.put(`/blocked-dates/${date}`, { reason: "A" })).json.changed, false);
    assert.equal((await ctx.put(`/blocked-dates/${date}`, { reason: "B" })).json.changed, true);
    assert.deepEqual((await ctx.auditFor("blockedDate", date)).map((e) => e.action), ["blockedDate.blocked", "blockedDate.updated"]);

    assert.equal((await ctx.del(`/blocked-dates/${date}`)).json.changed, true);
    assert.equal((await ctx.del(`/blocked-dates/${date}`)).json.changed, false);
    assert.deepEqual((await ctx.auditFor("blockedDate", date)).map((e) => e.action), ["blockedDate.blocked", "blockedDate.updated", "blockedDate.unblocked"]);
    assert.equal((await ctx.availability(date)).blocked, false);
    assert.equal((await ctx.book({ date })).status, 201);
  });

  test("list blocked dates in a range; invalid dates and ranges are 400", async () => {
    const d1 = ctx.addDays(ctx.today, 400); // far away: the shared day counter never reaches it
    const d2 = ctx.addDays(d1, 5);
    await ctx.put(`/blocked-dates/${d1}`, { reason: "one" });
    await ctx.put(`/blocked-dates/${d2}`, { reason: "two" });
    const res = await ctx.get("/blocked-dates", { query: { from: d1, to: d2 } });
    assert.deepEqual(res.json.blockedDates.map((b) => [b.date, b.reason]), [[d1, "one"], [d2, "two"]]);
    assert.equal((await ctx.get("/blocked-dates", { query: { from: d1, to: ctx.addDays(d1, 1) } })).json.blockedDates.length, 1);
    for (const query of [{ from: d2, to: d1 }, { from: "2030-02-31", to: d1 }, { from: d1 }, { from: d1, to: ctx.addDays(d1, 500) }]) {
      assert.equal((await ctx.get("/blocked-dates", { query })).status, 400, JSON.stringify(query));
    }
    assert.equal((await ctx.put("/blocked-dates/not-a-date", { reason: "x" })).status, 400);
    assert.equal((await ctx.put(`/blocked-dates/${d1}`, { reason: "x", extra: 1 })).status, 400);
    await ctx.del(`/blocked-dates/${d1}`);
    await ctx.del(`/blocked-dates/${d2}`);
  });

  test("booked capacity view: per date and slot, with blocked dates", async () => {
    const date = ctx.nextDate();
    await ctx.patch("/slots/t1600", { capacity: 3 });
    await ctx.book({ date, slotId: "t1600" });
    await ctx.book({ date, slotId: "t1600" });
    await ctx.book({ date, slotId: "t1000" });
    const farBlocked = ctx.addDays(ctx.today, 401);
    await ctx.put(`/blocked-dates/${farBlocked}`, { reason: "x" });
    const res = await ctx.get("/slots/occupancy", { query: { from: date, to: farBlocked } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.occupancy.filter((o) => o.date === date).map((o) => [o.slotId, o.bookedCount, o.capacity]).sort(), [["t1000", 1, 1], ["t1600", 2, 3]]);
    assert.deepEqual(res.json.blockedDates.map((b) => b.date), [farBlocked]);
    await ctx.del(`/blocked-dates/${farBlocked}`);
    await ctx.resetSlots();
  });
});

// ── audit trail ──────────────────────────────────────────────────────────────────
describe("audit trail", () => {
  test("GET /audit is newest first, cursor-paginated with no duplicates or gaps", async () => {
    const total = await ctx.auditCount();
    assert.ok(total > 40, `expected many entries from the tests above, got ${total}`);
    const seen = [];
    let cursor;
    for (let i = 0; i < 100; i++) {
      const res = await ctx.get("/audit", { query: { limit: 15, cursor } });
      assert.equal(res.status, 200);
      assert.ok(res.json.entries.length <= 15);
      seen.push(...res.json.entries);
      if (!res.json.page.hasMore) break;
      cursor = res.json.page.nextCursor;
    }
    assert.equal(seen.length, total);
    assert.equal(new Set(seen.map((e) => e.id)).size, total);
    const times = seen.map((e) => Date.parse(e.at));
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  });

  test("filter by record; a booking's detail includes its own history", async () => {
    const b = await ctx.book();
    await ctx.patch(`/bookings/${b.id}/status`, { status: "Confirmed" });
    await ctx.post(`/bookings/${b.id}/reschedule`, { date: ctx.nextDate(), slotId: "t1300", reason: "asked" });
    const res = await ctx.get("/audit", { query: { entityType: "booking", entityId: b.id } });
    assert.deepEqual(res.json.entries.map((e) => e.action), ["booking.rescheduled", "booking.status_changed"]);
    const detail = await ctx.get(`/bookings/${b.id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.json.audit.map((e) => e.action), ["booking.rescheduled", "booking.status_changed"]);
    assert.equal(detail.json.booking.status, "Confirmed");
    assert.equal((await ctx.get("/audit", { query: { entityType: "package" } })).json.entries.every((e) => e.entityType === "package"), true);
    assert.equal((await ctx.get("/audit", { query: { entityId: b.id } })).status, 400, "entityId needs entityType");
    assert.equal((await ctx.get("/audit", { query: { limit: 101 } })).status, 400);
    assert.equal((await ctx.get("/audit", { query: { cursor: "junk" } })).status, 400);
  });

  test("every entry names the verified admin and carries a server timestamp; entries expose no customer details", async () => {
    const all = (await ctx.get("/audit", { query: { limit: 100 } })).json.entries;
    for (const e of all) {
      assert.equal(e.actor.uid, ctx.tokens.admin.uid);
      assert.equal(e.actor.email, ctx.tokens.admin.email);
      assert.match(e.at, /^\d{4}-\d{2}-\d{2}T/);
    }
    const text = JSON.stringify(all);
    for (const pii of ["Asha", "9876543210", "asha@example.com", "Lake Road"]) assert.ok(!text.includes(pii), pii);
  });

  test("a failed mutation never leaves an audit entry, and a mutation never lacks one", async () => {
    const before = await ctx.auditCount();
    await ctx.patch("/bookings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d/status", { status: "Confirmed" });
    await ctx.patch("/packages/birthday-decor", { price: -5 });
    await ctx.patch("/slots/t1000", { capacity: 0 });
    await ctx.put("/blocked-dates/not-a-date", { reason: "x" });
    assert.equal(await ctx.auditCount(), before);
    const b = await ctx.book();
    const ok = await ctx.patch(`/bookings/${b.id}/status`, { status: "Confirmed" });
    assert.equal(ok.json.changed, true);
    assert.equal(await ctx.auditCount(), before + 1);
  });
});
