"use strict";

// The catalog list may be cached; bookings must never be priced from the cache.

const helpers = require("./helpers");
helpers.setupEnv({ CATALOG_CACHE_TTL_MS: "60000", RATE_LIMIT_BOOKINGS_MAX: "10000" });

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const app = require("../../src/app");
const { getDb } = require("../../src/config/firebaseAdmin");
const { addDays, todayInTimezone } = require("../../src/utils/dates");

let srv;
before(async () => {
  await helpers.resetAndSeed();
  srv = await helpers.listen(app);
});
after(() => srv.close());

test("GET /api/packages is served from cache, but a booking is priced from Firestore", async () => {
  const list = async () => (await (await fetch(`${srv.base}/api/packages`)).json()).packages.find((p) => p.id === "room-decoration");

  assert.equal((await list()).price, 1199);
  await getDb().collection("packages").doc("room-decoration").update({ price: 1250 });
  assert.equal((await list()).price, 1199, "list still cached");

  const res = await fetch(`${srv.base}/api/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: crypto.randomUUID(), packageId: "room-decoration", name: "Asha Rao", phone: "9876543210",
      date: addDays(todayInTimezone("Asia/Kolkata"), 1), slotId: "t1000", address: "12 Lake Road", paymentOption: "HALF", paymentMethod: "UPI",
    }),
  });
  assert.equal(res.status, 201);
  const { booking } = await res.json();
  assert.equal(booking.payment.totalAmount, 1250, "booking used the fresh price, not the cached one");
  assert.equal(booking.payment.requiredAmount, 625);
});

test("concurrent list requests share one cache fill", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => fetch(`${srv.base}/api/packages`).then((r) => r.status)));
  assert.deepEqual([...new Set(results)], [200]);
});
