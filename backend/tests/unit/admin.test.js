"use strict";

// Pure admin logic: query planning + index coverage, cursors, schemas, serializers, audit helpers.

process.env.NODE_ENV = "test";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const q = require("../../src/services/bookingQuery");
const { encodeCursor, decodeCursor } = require("../../src/utils/cursor");
const schemas = require("../../src/schemas/admin.schema");
const { toAdminBooking } = require("../../src/services/adminBookings.service");
const { diffFields, auditEntry, toAdminAudit } = require("../../src/services/audit.service");
const { PAYMENT_OPTIONS, PAYMENT_STATUSES, PAYMENT_METHODS } = require("../../src/constants/payment");
const { BOOKING_STATUSES } = require("../../src/constants/booking");

const indexes = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "firestore.indexes.json"), "utf8"));
const listQuery = (over = {}) => schemas.listBookingsQuery.parse(over);

describe("booking query planner", () => {
  test("no filters: newest first, everything in Firestore, automatic index only", () => {
    const plan = q.planBookingQuery(listQuery());
    assert.deepEqual([plan.mode, plan.equality, plan.orderBy], ["list", null, [["createdAt", "desc"]]]);
    assert.equal(q.requiredIndex(plan), null);
  });

  test("ONE equality filter is pushed down (by priority); the others run in memory", () => {
    const plan = q.planBookingQuery(listQuery({ status: "Pending", paymentStatus: "PENDING", packageId: "birthday-decor" }));
    assert.deepEqual(plan.equality, ["status", "Pending"]);
    assert.deepEqual(plan.postFilters.equals, { paymentStatus: "PENDING", packageId: "birthday-decor" });
  });

  test("priority order is status > paymentStatus > packageId > slotId > paymentMethod > paymentOption", () => {
    const all = { status: "Pending", paymentStatus: "PENDING", packageId: "p", slotId: "t1000", paymentMethod: "UPI", paymentOption: "HALF" };
    const order = [];
    const left = { ...all };
    while (Object.keys(left).length) {
      const plan = q.planBookingQuery(listQuery(left));
      order.push(plan.equality[0]);
      delete left[plan.equality[0]];
    }
    assert.deepEqual(order, ["status", "paymentStatus", "packageId", "slotId", "paymentMethod", "paymentOption"]);
  });

  test("a date range is pushed down only when sorting by event date; otherwise in memory", () => {
    const upcoming = q.planBookingQuery(listQuery({ sort: "upcoming", dateFrom: "2030-01-01", dateTo: "2030-01-31" }));
    assert.deepEqual(upcoming.range, { field: "date", from: "2030-01-01", to: "2030-01-31" });
    assert.equal(upcoming.postFilters.range, null);
    const newest = q.planBookingQuery(listQuery({ sort: "newest", dateFrom: "2030-01-01" }));
    assert.equal(newest.range, null);
    assert.deepEqual(newest.postFilters.range, { from: "2030-01-01", to: null });
  });

  test("search kinds: booking id, email, phone prefix, name prefix", () => {
    assert.deepEqual(q.classifySearch("9B1DEB4D-3B7D-4BAD-9BDD-2B0D7B3DCB6D"), { kind: "id", value: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" });
    assert.deepEqual(q.classifySearch(" Asha@Example.COM "), { kind: "email", value: "asha@example.com" });
    assert.deepEqual(q.classifySearch("+91 98765-43210"), { kind: "phone", value: "+919876543210" });
    assert.deepEqual(q.classifySearch("98765"), { kind: "phone", value: "98765" });
    assert.deepEqual(q.classifySearch("Asha R"), { kind: "name", value: "asha r" });
    assert.deepEqual(q.classifySearch("12"), { kind: "name", value: "12" }, "too short to be a phone");
  });

  test("search plans: name/phone are ordered prefix ranges, every filter runs in memory", () => {
    const name = q.planBookingQuery(listQuery({ q: "Asha", status: "Pending" }));
    assert.deepEqual([name.mode, name.prefix, name.orderBy, name.equality], ["search", { field: "nameLower", value: "asha" }, [["nameLower", "asc"]], null]);
    assert.deepEqual(name.postFilters.equals, { status: "Pending" });
    const email = q.planBookingQuery(listQuery({ q: "a@b.co" }));
    assert.deepEqual([email.equality, email.orderBy], [["email", "a@b.co"], []]);
  });

  test("post filters", () => {
    const b = { status: "Pending", paymentStatus: "PENDING", date: "2030-01-15" };
    assert.equal(q.matchesPostFilters(b, { equals: { status: "Pending" }, range: null }), true);
    assert.equal(q.matchesPostFilters(b, { equals: { status: "Confirmed" }, range: null }), false);
    assert.equal(q.matchesPostFilters(b, { equals: {}, range: { from: "2030-01-16", to: null } }), false);
    assert.equal(q.matchesPostFilters(b, { equals: {}, range: { from: "2030-01-01", to: "2030-01-15" } }), true);
    assert.equal(q.matchesPostFilters(b, { equals: {}, range: { from: null, to: "2030-01-14" } }), false);
  });

  // The emulator does NOT enforce indexes, so this is the check that every query the API
  // can issue is covered by an index declared in firestore.indexes.json.
  test("EVERY supported query shape is covered by an index declared in firestore.indexes.json", () => {
    const opts = (vals) => [undefined, ...vals];
    let plans = 0;
    const needed = new Set();
    for (const sort of ["newest", "upcoming"])
      for (const status of opts(BOOKING_STATUSES))
        for (const paymentStatus of opts(PAYMENT_STATUSES))
          for (const paymentOption of opts(PAYMENT_OPTIONS))
            for (const paymentMethod of opts(PAYMENT_METHODS))
              for (const packageId of opts(["p"]))
                for (const slotId of opts(["t1000"]))
                  for (const dates of [{}, { dateFrom: "2030-01-01" }, { dateTo: "2030-02-01" }, { dateFrom: "2030-01-01", dateTo: "2030-02-01" }])
                    for (const search of [undefined, "Asha", "+91987", "a@b.co", "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"]) {
                      const clean = Object.fromEntries(Object.entries({ sort, status, paymentStatus, paymentOption, paymentMethod, packageId, slotId, q: search, ...dates }).filter(([, v]) => v !== undefined));
                      const plan = q.planBookingQuery(listQuery(clean));
                      const idx = q.requiredIndex(plan);
                      assert.ok(q.indexDeclared(indexes, idx), `missing index for ${JSON.stringify(clean)} -> ${JSON.stringify(idx)}`);
                      if (idx) needed.add(JSON.stringify(idx.fields.map((f) => f.fieldPath + f.order[0])));
                      plans++;
                    }
    assert.ok(plans > 10000, `enumerated ${plans} plans`);
    // and no index is declared that no query needs (they cost writes)
    const declared = indexes.indexes.filter((i) => i.collectionGroup === "bookings").map((i) => JSON.stringify(i.fields.map((f) => f.fieldPath + f.order[0])));
    for (const d of declared) assert.ok(needed.has(d), `declared but never used: ${d}`);
    assert.equal(declared.length, needed.size);
  });

  test("audit and slot queries have their indexes declared too", () => {
    const has = (cg, fields) => indexes.indexes.some((i) => i.collectionGroup === cg && JSON.stringify(i.fields.map((f) => f.fieldPath + f.order[0])) === JSON.stringify(fields));
    assert.ok(has("auditLogs", ["entityTypeA", "entityIdA", "atD"]));
    assert.ok(has("auditLogs", ["entityTypeA", "atD"]));
    assert.ok(has("slotBookings", ["slotIdA", "dateA"]));
  });
});

describe("cursor", () => {
  const sig = { sort: "newest", q: null, status: "Pending" };
  test("round-trips the document id", () => assert.equal(decodeCursor(encodeCursor("abc", sig), sig), "abc"));
  test("is opaque url-safe text", () => assert.match(encodeCursor("abc", sig), /^[A-Za-z0-9_-]+$/));
  test("a cursor from a different query is rejected (INVALID_CURSOR)", () => {
    const c = encodeCursor("abc", sig);
    for (const other of [{ ...sig, status: "Confirmed" }, { ...sig, sort: "upcoming" }, { ...sig, q: "asha" }]) {
      assert.throws(() => decodeCursor(c, other), (e) => e.code === "INVALID_CURSOR" && e.status === 400);
    }
  });
  test("garbage, tampered and malformed cursors are rejected", () => {
    for (const bad of ["", "not-base64!!", Buffer.from("{}").toString("base64url"), Buffer.from('{"id":1,"h":"x"}').toString("base64url"), Buffer.from("null").toString("base64url"), encodeCursor("abc", sig).slice(0, -3)]) {
      assert.throws(() => decodeCursor(bad, sig), (e) => e.code === "INVALID_CURSOR", bad);
    }
  });
});

describe("admin request schemas", () => {
  test("list query: defaults, coercion, blank filters ignored", () => {
    const v = listQuery({ limit: "10", status: "", q: "  " });
    assert.deepEqual([v.limit, v.sort, v.status, v.q], [10, "newest", undefined, undefined]);
    assert.equal(listQuery({}).limit, 20);
  });
  test("list query: limits, enums and unknown keys are rejected", () => {
    for (const bad of [{ limit: "0" }, { limit: "51" }, { limit: "x" }, { status: "Done" }, { paymentStatus: "paid" }, { sort: "random" }, { dateFrom: "2030-02-31" }, { dateFrom: "2030-02-01", dateTo: "2030-01-01" }, { bogus: "1" }, { packageId: "Bad ID" }, { status: ["Pending", "Confirmed"] }]) {
      assert.equal(schemas.listBookingsQuery.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });
  test("status body: cancelling requires a real reason; unknown keys rejected", () => {
    assert.equal(schemas.statusBody.safeParse({ status: "Confirmed" }).success, true);
    assert.equal(schemas.statusBody.safeParse({ status: "Cancelled" }).success, false);
    assert.equal(schemas.statusBody.safeParse({ status: "Cancelled", reason: "ab" }).success, false);
    assert.equal(schemas.statusBody.safeParse({ status: "Cancelled", reason: "Customer asked" }).success, true);
    assert.equal(schemas.statusBody.safeParse({ status: "Refunded" }).success, false);
    assert.equal(schemas.statusBody.safeParse({ status: "Confirmed", paymentStatus: "PAID" }).success, false, "cannot smuggle payment changes");
  });
  test("reschedule body needs a valid future date and a slot; no unknown keys", () => {
    assert.equal(schemas.rescheduleBody.safeParse({ date: "2000-01-01", slotId: "t1000" }).success, false);
    assert.equal(schemas.rescheduleBody.safeParse({ date: "2999-01-01", slotId: "t1000" }).success, false, "beyond the booking horizon");
    assert.equal(schemas.rescheduleBody.safeParse({ date: "2030-01-01", slotId: "" }).success, false);
  });
  test("package bodies: create needs name/category/price; price is a positive whole number; patch needs a change; unknown keys rejected", () => {
    assert.equal(schemas.createPackageBody.safeParse({ name: "New", category: "birthday", price: 1500 }).success, true);
    for (const bad of [{ category: "birthday", price: 1 }, { name: "N", category: "birthday", price: 0 }, { name: "N", category: "birthday", price: 9.5 }, { name: "N", category: "birthday", price: -3 }, { name: "N", category: "birthday", price: "12" }, { name: "N", category: "birthday", price: 1, createdAt: "x" }, { name: "N", category: "birthday", price: 1, image: "javascript:alert(1)" }]) {
      assert.equal(schemas.createPackageBody.safeParse(bad).success, false, JSON.stringify(bad));
    }
    assert.equal(schemas.updatePackageBody.safeParse({}).success, false);
    assert.equal(schemas.updatePackageBody.safeParse({ expectedUpdatedAt: "2030-01-01T00:00:00.000Z" }).success, false);
    assert.equal(schemas.updatePackageBody.safeParse({ price: 1999 }).success, true);
    // regression: a price-only edit must contain the price and NOTHING else (zod applies
    // .default() inside .partial(), which once made it reset description/image/featured)
    assert.deepEqual(schemas.updatePackageBody.parse({ price: 1999 }), { price: 1999 });
    assert.deepEqual(schemas.updatePackageBody.parse({ active: false }), { active: false });
    assert.deepEqual(schemas.updatePackageBody.parse({ image: null }), { image: null });
    assert.equal(schemas.updatePackageBody.safeParse({ id: "other" }).success, false, "id is immutable");
  });
  test("slot bodies: time is HH:MM; capacity 1..100; days valid; time is immutable on patch", () => {
    assert.equal(schemas.createSlotBody.safeParse({ time: "17:00", capacity: 2 }).success, true);
    for (const bad of [{ time: "5pm", capacity: 1 }, { time: "17:00", capacity: 0 }, { time: "17:00", capacity: 101 }, { time: "17:00", capacity: 1, days: [] }, { time: "17:00", capacity: 1, days: [8] }]) {
      assert.equal(schemas.createSlotBody.safeParse(bad).success, false, JSON.stringify(bad));
    }
    assert.equal(schemas.updateSlotBody.safeParse({ capacity: 3 }).success, true);
    assert.equal(schemas.updateSlotBody.safeParse({ time: "18:00" }).success, false, "time cannot be edited");
    assert.equal(schemas.updateSlotBody.safeParse({ id: "x", capacity: 1 }).success, false);
  });
  test("ranges: ordered and at most 400 days; dates must be real", () => {
    assert.equal(schemas.rangeQuery.safeParse({ from: "2030-01-01", to: "2030-01-31" }).success, true);
    assert.equal(schemas.rangeQuery.safeParse({ from: "2030-02-01", to: "2030-01-01" }).success, false);
    assert.equal(schemas.rangeQuery.safeParse({ from: "2030-01-01", to: "2031-06-01" }).success, false);
    assert.equal(schemas.rangeQuery.safeParse({ from: "2030-02-31", to: "2030-03-01" }).success, false);
  });
  test("slugify", () => {
    assert.equal(schemas.slugify("Rangoli & Diya Setup"), "rangoli-and-diya-setup");
    assert.equal(schemas.slugify("  Hello,   World!! "), "hello-world");
    assert.equal(schemas.slugify("!!!"), "");
  });
});

describe("what the browser is allowed to see of a booking", () => {
  const ts = (iso) => ({ toDate: () => new Date(iso) });
  const doc = { name: "Asha", nameLower: "asha", requestFingerprint: "deadbeef", razorpaySignature: "SECRET_SIG", razorpayOrderId: "order_1", razorpayPaymentId: null, status: "Pending", createdAt: ts("2030-01-01T10:00:00Z"), cancelledAt: ts("2030-01-02T10:00:00Z") };
  test("timestamps become ISO strings; the id is included", () => {
    const b = toAdminBooking("id1", doc);
    assert.equal(b.id, "id1");
    assert.equal(b.createdAt, "2030-01-01T10:00:00.000Z");
    assert.equal(b.cancelledAt, "2030-01-02T10:00:00.000Z");
  });
  test("the Razorpay signature and internal fields never leave the server", () => {
    const b = toAdminBooking("id1", doc);
    assert.ok(!JSON.stringify(b).includes("SECRET_SIG"));
    assert.ok(!("razorpaySignature" in b) && !("requestFingerprint" in b) && !("nameLower" in b));
    assert.equal(b.hasRazorpaySignature, true);
    assert.equal(toAdminBooking("id2", { name: "x" }).hasRazorpaySignature, false);
  });
  test("Razorpay order/payment ids are shown when present", () => assert.equal(toAdminBooking("id1", doc).razorpayOrderId, "order_1"));
});

describe("audit helpers", () => {
  test("diffFields keeps only what changed, before and after", () => {
    assert.deepEqual(diffFields({ price: 999, name: "A", active: true }, { price: 1099, name: "A", active: true }), { before: { price: 999 }, after: { price: 1099 }, changed: true });
    assert.equal(diffFields({ price: 999 }, { price: 999 }).changed, false);
    assert.equal(diffFields({ days: [1, 2] }, { days: [1, 2] }).changed, false);
    assert.equal(diffFields({ days: [1, 2] }, { days: [2, 1] }).changed, true);
    assert.deepEqual(diffFields({}, { image: null }).changed, false);
  });
  test("an entry carries the verified actor, the action, the entity and a server timestamp", () => {
    const ctx = { actor: { uid: "u1", email: "boss@example.com" }, meta: { ip: "1.2.3.4", userAgent: "x" } };
    const e = auditEntry({ action: "package.updated", entityType: "package", entityId: "p1", ctx, reason: "sale", before: { price: 1 }, after: { price: 2 } });
    assert.deepEqual([e.action, e.entityType, e.entityId, e.actor, e.reason, e.before, e.after, e.meta], ["package.updated", "package", "p1", ctx.actor, "sale", { price: 1 }, { price: 2 }, ctx.meta]);
    assert.ok(e.at, "server timestamp sentinel");
    assert.equal(auditEntry({ action: "a", entityType: "booking", entityId: "b", ctx }).reason, null);
  });
  test("toAdminAudit serializes the timestamp", () => {
    const out = toAdminAudit("x", { at: { toDate: () => new Date("2030-01-01T00:00:00Z") }, action: "a", entityType: "booking", entityId: "b", actor: { uid: "u", email: null } });
    assert.equal(out.at, "2030-01-01T00:00:00.000Z");
  });
});
