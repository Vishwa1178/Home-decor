"use strict";

// Admin API, part 1: who may call it, and reading bookings safely (pagination, filters, search).
// Real Firestore + Auth emulators, real ID tokens, real middleware.

const { setup } = require("./adminHelpers");
const ctx = setup();

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { BOOKING_STATUSES } = require("../../src/constants/booking");
const { PAYMENT_STATUSES, PAYMENT_METHODS, PAYMENT_OPTIONS } = require("../../src/constants/payment");
const { MAX_SCAN } = require("../../src/services/adminBookings.service");

before(() => ctx.start());
after(() => ctx.stop());

// ── authorization ──────────────────────────────────────────────────────────────────
describe("every admin route requires a verified admin", () => {
  const id = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
  const routes = [
    ["GET", "/me"], ["GET", "/stats"], ["GET", "/bookings"], ["GET", `/bookings/${id}`],
    ["PATCH", `/bookings/${id}/status`, { status: "Confirmed" }],
    ["POST", `/bookings/${id}/reschedule`, { date: "2030-01-01", slotId: "t1000" }],
    ["GET", "/catalog"], ["POST", "/packages", { name: "Sneaky", category: "birthday", price: 1 }],
    ["PATCH", "/packages/birthday-decor", { price: 1 }],
    ["GET", "/slots"], ["POST", "/slots", { time: "05:00", capacity: 99 }], ["GET", "/slots/occupancy?from=2030-01-01&to=2030-01-02"],
    ["PATCH", "/slots/t1000", { capacity: 99 }], ["GET", "/blocked-dates?from=2030-01-01&to=2030-01-02"],
    ["PUT", "/blocked-dates/2030-05-05", { reason: "sneaky" }], ["DELETE", "/blocked-dates/2030-05-05"], ["GET", "/audit"],
  ];

  test(`${routes.length} routes: no token -> 401, garbage token -> 401, ordinary user -> 403, and NOTHING changes`, async () => {
    const before = { audit: await ctx.auditCount(), packages: (await ctx.db().collection("packages").doc("birthday-decor").get()).data().price, slots: (await ctx.db().collection("slots").get()).size };
    for (const [method, path, body] of routes) {
      const url = `/api/admin${path}`;
      const none = await ctx.call(method, url, { token: null, body });
      assert.equal(none.status, 401, `${method} ${path} without a token`);
      assert.equal(none.json.code, "UNAUTHORIZED");
      const garbage = await ctx.call(method, url, { token: "not.a.jwt", body });
      assert.equal(garbage.status, 401, `${method} ${path} with a garbage token`);
      const user = await ctx.call(method, url, { token: ctx.tokens.user.token, body });
      assert.equal(user.status, 403, `${method} ${path} as a non-admin`);
      assert.equal(user.json.code, "FORBIDDEN");
    }
    assert.equal(await ctx.auditCount(), before.audit, "no audit entries from rejected calls");
    assert.equal((await ctx.db().collection("packages").doc("birthday-decor").get()).data().price, before.packages);
    assert.equal((await ctx.db().collection("slots").get()).size, before.slots);
    assert.equal((await ctx.db().collection("blockedDates").doc("2030-05-05").get()).exists, false);
  });

  test("claims the browser sends about itself change nothing (headers, query, body)", async () => {
    const res = await ctx.call("PATCH", "/api/admin/packages/birthday-decor", {
      token: ctx.tokens.user.token,
      body: { price: 1, admin: true },
      headers: { "X-Admin": "true", "X-User-Email": ctx.tokens.admin.email, "X-Firebase-Claims": '{"admin":true}' },
      query: { admin: "true", role: "admin" },
    });
    assert.equal(res.status, 403);
    assert.equal((await ctx.db().collection("packages").doc("birthday-decor").get()).data().price, 999);
  });

  test("the audit trail cannot be written through the API at all", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await ctx.call(method, "/api/admin/audit", { body: { action: "forged" } });
      assert.equal(res.status, 404, method);
    }
    assert.equal((await ctx.call("DELETE", "/api/admin/audit/anything")).status, 404);
  });

  test("an admin gets through (GET /me)", async () => {
    const res = await ctx.get("/me");
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.admin, res.json.email], [true, ctx.tokens.admin.email]);
  });

  test("packages and slots cannot be deleted through the API (disable instead)", async () => {
    assert.equal((await ctx.del("/packages/birthday-decor")).status, 404);
    assert.equal((await ctx.del("/slots/t1000")).status, 404);
    assert.equal((await ctx.del("/bookings/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d")).status, 404);
  });
});

// ── listing ────────────────────────────────────────────────────────────────────────
const N = 57;
const PACKAGES = ["birthday-decor", "balloon-decor", "haldi-decor", "room-surprise"];
const SLOTS = [["t1000", "10:00", "10:00 AM"], ["t1300", "13:00", "1:00 PM"], ["t1600", "16:00", "4:00 PM"], ["t1900", "19:00", "7:00 PM"]];
let data; // the source of truth the API results are compared with

async function seedBulk(count, make) {
  const db = ctx.db();
  await Promise.all((await db.collection("bookings").get()).docs.map((d) => d.ref.delete()));
  const rows = Array.from({ length: count }, (_, i) => make(i));
  for (let i = 0; i < rows.length; i += 400) {
    const batch = db.batch();
    for (const r of rows.slice(i, i + 400)) batch.set(db.collection("bookings").doc(r.id), r.doc);
    await batch.commit();
  }
  return rows;
}

const base = Date.parse("2030-01-01T00:00:00Z");
const makeRow = (i) => {
  const [slotId, time, timeLabel] = SLOTS[Math.floor(i / 2) % 4];
  const total = 1000 + i;
  const paymentOption = PAYMENT_OPTIONS[i % 2];
  const id = crypto.randomUUID();
  return {
    id,
    doc: {
      name: i % 7 === 0 ? `Priya Sharma ${i}` : `Asha Rao ${i}`, nameLower: (i % 7 === 0 ? `Priya Sharma ${i}` : `Asha Rao ${i}`).toLowerCase(),
      phone: `+91987650${String(i).padStart(4, "0")}`, email: `c${i}@example.com`,
      package: `Package ${PACKAGES[i % 4]}`, packageId: PACKAGES[i % 4], packageCategory: "birthday",
      status: BOOKING_STATUSES[i % 3], paymentStatus: PAYMENT_STATUSES[i % 5], paymentOption, paymentMethod: PAYMENT_METHODS[Math.floor(i / 3) % 3],
      totalAmount: total, requiredAmount: paymentOption === "FULL" ? total : Math.ceil(total / 2), paidAmount: 0, remainingAmount: 0, currency: "INR",
      razorpayOrderId: null, razorpayPaymentId: null, razorpaySignature: i === 5 ? "SECRET_SIGNATURE" : null, requestFingerprint: "fp",
      date: ctx.addDays(ctx.today, 3 + (i % 20)), time, timeLabel, slotId,
      address: `${i} Test Road`, notes: "", balloonColor: "", source: "web",
      createdAt: Timestamp.fromMillis(base + i * 60_000), updatedAt: Timestamp.fromMillis(base + i * 60_000),
    },
  };
};

// Walks every page of a query. Returns the ids in order plus page metadata.
async function walk(query, limit) {
  const ids = [];
  const pages = [];
  let cursor;
  for (let guard = 0; guard < 200; guard++) {
    const res = await ctx.get("/bookings", { query: { ...query, limit, cursor } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.ok(res.json.bookings.length <= limit, `page larger than limit ${limit}`);
    ids.push(...res.json.bookings.map((b) => b.id));
    pages.push(res.json.page);
    if (!res.json.page.hasMore) {
      assert.equal(res.json.page.nextCursor, null);
      return { ids, pages };
    }
    assert.ok(res.json.page.nextCursor, "hasMore requires a cursor");
    cursor = res.json.page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

const expectIds = (rows, pred, sortKey) => rows.filter(pred).sort(sortKey).map((r) => r.id);
const newest = (a, b) => b.doc.createdAt.toMillis() - a.doc.createdAt.toMillis();
const upcoming = (a, b) => a.doc.date.localeCompare(b.doc.date) || a.doc.time.localeCompare(b.doc.time) || a.id.localeCompare(b.id);

describe(`listing ${N} bookings`, () => {
  before(async () => { data = await seedBulk(N, makeRow); });

  test("cursor pagination: 3 pages of 20/20/17, newest first, no duplicates, none missing", async () => {
    const { ids, pages } = await walk({}, 20);
    assert.deepEqual(ids, expectIds(data, () => true, newest));
    assert.equal(new Set(ids).size, N);
    assert.deepEqual(pages.map((p) => p.hasMore), [true, true, false]);
    assert.ok(pages.every((p) => p.scanned <= 21), "without in-memory filters a page reads at most limit+1 documents");
  });

  test("a page never reads more than limit+1 documents; the whole collection is never loaded", async () => {
    const res = await ctx.get("/bookings", { query: { limit: 5 } });
    assert.equal(res.json.bookings.length, 5);
    assert.equal(res.json.page.scanned, 6);
    assert.equal(res.json.page.hasMore, true);
  });

  test("limit bounds: 1 works, 50 works, 0 / 51 / junk are 400s", async () => {
    assert.equal((await ctx.get("/bookings", { query: { limit: 1 } })).json.bookings.length, 1);
    assert.equal((await ctx.get("/bookings", { query: { limit: 50 } })).json.bookings.length, 50);
    for (const limit of ["0", "51", "-1", "abc", "1.5"]) assert.equal((await ctx.get("/bookings", { query: { limit } })).status, 400, limit);
    assert.equal((await ctx.get("/bookings", { query: { bogus: "1" } })).status, 400, "unknown parameters are rejected");
  });

  test("one page of exactly the remaining rows ends cleanly (no phantom next page)", async () => {
    // Filtered in Firestore (status) and in memory (paymentStatus): both code paths.
    for (const query of [{ status: "Pending" }, { status: "Pending", paymentStatus: "PENDING" }]) {
      const exact = data.filter((r) => r.doc.status === "Pending" && (!query.paymentStatus || r.doc.paymentStatus === query.paymentStatus)).length;
      assert.ok(exact > 0 && exact <= 50);
      const { ids, pages } = await walk(query, exact);
      assert.equal(ids.length, exact);
      assert.equal(pages.length, 1, JSON.stringify(query));
      assert.equal(pages[0].hasMore, false);
    }
  });

  for (const [name, query, pred] of [
    ["status", { status: "Pending" }, (r) => r.doc.status === "Pending"],
    ["payment status", { paymentStatus: "PAID" }, (r) => r.doc.paymentStatus === "PAID"],
    ["payment option", { paymentOption: "FULL" }, (r) => r.doc.paymentOption === "FULL"],
    ["payment method", { paymentMethod: "UPI" }, (r) => r.doc.paymentMethod === "UPI"],
    ["package", { packageId: "haldi-decor" }, (r) => r.doc.packageId === "haldi-decor"],
    ["slot", { slotId: "t1600" }, (r) => r.doc.slotId === "t1600"],
  ]) {
    test(`filter by ${name}: exactly the matching bookings, newest first, across pages`, async () => {
      const { ids } = await walk(query, 7);
      assert.deepEqual(ids, expectIds(data, pred, newest));
      assert.ok(ids.length > 0);
    });
  }

  test("several filters at once (one in Firestore, the rest in memory): exact set, paged correctly", async () => {
    const query = { status: "Pending", paymentStatus: "PENDING", paymentOption: "HALF", packageId: "birthday-decor" };
    const pred = (r) => r.doc.status === "Pending" && r.doc.paymentStatus === "PENDING" && r.doc.paymentOption === "HALF" && r.doc.packageId === "birthday-decor";
    const want = expectIds(data, pred, newest);
    for (const limit of [1, 2, 3, 50]) {
      const { ids, pages } = await walk(query, limit);
      assert.deepEqual(ids, want, `limit ${limit}`);
      assert.ok(pages.every((p) => p.scanned <= MAX_SCAN));
    }
    assert.ok(want.length >= 1);
  });

  test("sorted by event date (upcoming): date, then time, across pages", async () => {
    const { ids } = await walk({ sort: "upcoming" }, 10);
    assert.deepEqual(ids, expectIds(data, () => true, upcoming));
  });

  test("event-date range with 'upcoming' (pushed into Firestore) and with 'newest' (in memory) return the same rows", async () => {
    const from = ctx.addDays(ctx.today, 8);
    const to = ctx.addDays(ctx.today, 12);
    const pred = (r) => r.doc.date >= from && r.doc.date <= to;
    assert.deepEqual((await walk({ sort: "upcoming", dateFrom: from, dateTo: to }, 6)).ids, expectIds(data, pred, upcoming));
    assert.deepEqual((await walk({ sort: "newest", dateFrom: from, dateTo: to }, 6)).ids, expectIds(data, pred, newest));
    assert.deepEqual((await walk({ sort: "newest", dateFrom: from }, 9)).ids, expectIds(data, (r) => r.doc.date >= from, newest));
    assert.deepEqual((await walk({ sort: "upcoming", dateTo: from, status: "Confirmed" }, 4)).ids, expectIds(data, (r) => r.doc.date <= from && r.doc.status === "Confirmed", upcoming));
  });

  test("search by exact booking id", async () => {
    const target = data[12];
    const res = await ctx.get("/bookings", { query: { q: target.id.toUpperCase() } });
    assert.deepEqual(res.json.bookings.map((b) => b.id), [target.id]);
    assert.deepEqual((await ctx.get("/bookings", { query: { q: crypto.randomUUID() } })).json.bookings, []);
    // a filter that the booking does not satisfy hides it
    const wrong = BOOKING_STATUSES.find((s) => s !== target.doc.status);
    assert.deepEqual((await ctx.get("/bookings", { query: { q: target.id, status: wrong } })).json.bookings, []);
  });

  test("search by exact email; by phone prefix; by name prefix (case-insensitive)", async () => {
    assert.deepEqual((await ctx.get("/bookings", { query: { q: "C7@Example.com" } })).json.bookings.map((b) => b.id), [data[7].id]);

    const phone = "+919876500";
    assert.deepEqual((await walk({ q: phone }, 8)).ids.sort(), expectIds(data, (r) => r.doc.phone.startsWith(phone), () => 0).sort());
    assert.deepEqual((await ctx.get("/bookings", { query: { q: data[20].doc.phone } })).json.bookings.map((b) => b.id), [data[20].id]);

    for (const q of ["priya", "PRIYA sh", "Asha Rao 1"]) {
      const want = data.filter((r) => r.doc.nameLower.startsWith(q.toLowerCase())).map((r) => r.id).sort();
      const got = (await walk({ q }, 5)).ids.sort();
      assert.deepEqual(got, want, q);
      assert.ok(want.length > 0, q);
    }
    assert.deepEqual((await ctx.get("/bookings", { query: { q: "zzz-nobody" } })).json.bookings, []);
  });

  test("search + filters: the filters still apply (in memory)", async () => {
    const want = data.filter((r) => r.doc.nameLower.startsWith("asha") && r.doc.status === "Confirmed" && r.doc.paymentMethod === "CASH").map((r) => r.id).sort();
    assert.deepEqual((await walk({ q: "asha", status: "Confirmed", paymentMethod: "CASH" }, 4)).ids.sort(), want);
    assert.ok(want.length > 0);
  });

  test("search results are paged with cursors too (name prefix, limit 3)", async () => {
    const { ids, pages } = await walk({ q: "asha" }, 3);
    assert.equal(ids.length, data.filter((r) => r.doc.nameLower.startsWith("asha")).length);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(pages.length > 3);
  });

  test("a cursor only works for the query it came from", async () => {
    const first = await ctx.get("/bookings", { query: { status: "Pending", limit: 5 } });
    const cursor = first.json.page.nextCursor;
    assert.ok(cursor);
    for (const other of [{ status: "Confirmed" }, { status: "Pending", sort: "upcoming" }, { status: "Pending", q: "asha" }, {}]) {
      const res = await ctx.get("/bookings", { query: { ...other, limit: 5, cursor } });
      assert.equal(res.status, 400, JSON.stringify(other));
      assert.equal(res.json.code, "INVALID_CURSOR");
    }
    assert.equal((await ctx.get("/bookings", { query: { status: "Pending", limit: 5, cursor: "garbage" } })).json.code, "INVALID_CURSOR");
    assert.equal((await ctx.get("/bookings", { query: { status: "Pending", limit: 5, cursor: cursor.slice(0, -4) } })).status, 400);
  });

  test("a cursor pointing at a document that no longer exists is refused, not silently restarted", async () => {
    const first = await ctx.get("/bookings", { query: { limit: 3 } });
    const lastId = first.json.bookings[2].id;
    const backup = (await ctx.db().collection("bookings").doc(lastId).get()).data();
    await ctx.db().collection("bookings").doc(lastId).delete();
    const res = await ctx.get("/bookings", { query: { limit: 3, cursor: first.json.page.nextCursor } });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, "INVALID_CURSOR");
    await ctx.db().collection("bookings").doc(lastId).set(backup);
  });

  test("responses carry the complete booking, but never the signature or internals", async () => {
    const withSig = data[5];
    const res = await ctx.get("/bookings", { query: { q: withSig.id } });
    const b = res.json.bookings[0];
    assert.equal(b.hasRazorpaySignature, true);
    const text = JSON.stringify(res.json);
    assert.ok(!text.includes("SECRET_SIGNATURE"));
    assert.ok(!("requestFingerprint" in b) && !("razorpaySignature" in b) && !("nameLower" in b));
    for (const k of ["id", "name", "phone", "email", "package", "packageId", "date", "time", "timeLabel", "status", "paymentOption", "paymentStatus", "paymentMethod", "totalAmount", "requiredAmount", "paidAmount", "remainingAmount", "razorpayOrderId", "razorpayPaymentId", "address", "createdAt"]) {
      assert.ok(k in b, `missing ${k}`);
    }
    assert.match(b.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("stats use count queries: total, by status, and events today (cancelled excluded)", async () => {
    const todayRows = data.filter((r) => r.doc.date === ctx.today);
    await ctx.db().collection("bookings").doc(data[0].id).update({ date: ctx.today, status: "Confirmed" });
    await ctx.db().collection("bookings").doc(data[1].id).update({ date: ctx.today, status: "Cancelled" });
    const res = await ctx.get("/stats");
    assert.equal(res.status, 200);
    const docs = (await ctx.db().collection("bookings").get()).docs.map((d) => d.data());
    assert.deepEqual(
      [res.json.total, res.json.pending, res.json.confirmed, res.json.cancelled, res.json.eventsToday, res.json.today],
      [docs.length, docs.filter((d) => d.status === "Pending").length, docs.filter((d) => d.status === "Confirmed").length, docs.filter((d) => d.status === "Cancelled").length,
       docs.filter((d) => d.date === ctx.today && d.status !== "Cancelled").length, ctx.today]
    );
    assert.ok(res.json.eventsToday >= 1 && todayRows !== undefined);
  });
});

describe("a very selective filter cannot make one request read the whole collection", () => {
  test(`320 bookings, one match at the very end: page 1 reads at most ${MAX_SCAN}, says there is more, and the next page finds it`, async () => {
    const rows = await seedBulk(320, (i) => {
      const r = makeRow(i);
      r.doc.status = "Pending";
      r.doc.paymentStatus = i === 0 ? "PAID" : "PENDING"; // i === 0 is the OLDEST booking, i.e. last in "newest" order
      return r;
    });
    const oldest = rows[0].id;

    const p1 = await ctx.get("/bookings", { query: { status: "Pending", paymentStatus: "PAID", limit: 20 } });
    assert.equal(p1.status, 200);
    assert.deepEqual(p1.json.bookings, []);
    assert.equal(p1.json.page.scanned, MAX_SCAN);
    assert.equal(p1.json.page.hasMore, true);
    assert.ok(p1.json.page.nextCursor);

    const p2 = await ctx.get("/bookings", { query: { status: "Pending", paymentStatus: "PAID", limit: 20, cursor: p1.json.page.nextCursor } });
    assert.deepEqual(p2.json.bookings.map((b) => b.id), [oldest]);
    assert.equal(p2.json.page.hasMore, false);
    assert.ok(p1.json.page.scanned + p2.json.page.scanned <= 320);
  });

  test("with no in-memory filter, 320 bookings still cost limit+1 reads per page", async () => {
    const res = await ctx.get("/bookings", { query: { limit: 20 } });
    assert.equal(res.json.page.scanned, 21);
    assert.equal((await ctx.get("/bookings", { query: { status: "Pending", limit: 20 } })).json.page.scanned, 21);
  });
});
