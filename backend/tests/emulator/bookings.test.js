"use strict";

// POST /api/bookings against the real Firestore emulator and the real Admin SDK.

const helpers = require("./helpers");
helpers.setupEnv({ CATALOG_CACHE_TTL_MS: "0", RATE_LIMIT_BOOKINGS_MAX: "10000" });

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const app = require("../../src/app");
const { getDb } = require("../../src/config/firebaseAdmin");
const { addDays, todayInTimezone } = require("../../src/utils/dates");

const today = todayInTimezone("Asia/Kolkata");
let srv;

// Every booking needs a free (date, slot): slots have capacity 1, so each generated
// body gets its own future date unless a test asks for a specific one.
let dayCounter = 0;
const nextDate = () => addDays(today, 1 + ++dayCounter);

const body = (over = {}) => ({
  requestId: crypto.randomUUID(),
  packageId: "birthday-decor", // Rs. 999
  name: "Asha Rao",
  phone: "+91 98765 43210",
  email: "asha@example.com",
  occasion: "Birthday",
  date: nextDate(),
  slotId: "t1000", // 10:00 AM
  balloonColor: "Gold & White",
  address: "12 Lake Road, Bangalore",
  notes: "Ground floor",
  paymentOption: "HALF",
  paymentMethod: "UPI",
  ...over,
});
const post = (b, headers = {}) =>
  fetch(`${srv.base}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(b) });
const bookingsCount = async () => (await getDb().collection("bookings").count().get()).data().count;
const stored = async (id) => (await getDb().collection("bookings").doc(id).get()).data();
const setPrice = (id, price) => getDb().collection("packages").doc(id).update({ price });

const PAYMENT_FIELDS = [
  "paymentOption", "paymentMethod", "paymentStatus", "currency", "totalAmount", "requiredAmount",
  "paidAmount", "remainingAmount", "razorpayOrderId", "razorpayPaymentId", "razorpaySignature",
];
const paymentOf = (doc) => Object.fromEntries(PAYMENT_FIELDS.map((k) => [k, doc[k]]));

before(async () => {
  await helpers.resetAndSeed();
  srv = await helpers.listen(app);
});
after(() => srv.close());

describe("HALF payment", () => {
  test("the spec example: package Rs. 10,000 -> total 10,000, required 5,000, remaining 5,000", async () => {
    await setPrice("premium-decoration", 10000);
    const b = body({ packageId: "premium-decoration", paymentOption: "HALF", paymentMethod: "RAZORPAY" });
    const res = await post(b);
    assert.equal(res.status, 201);

    assert.deepEqual(paymentOf(await stored(b.requestId)), {
      paymentOption: "HALF",
      paymentMethod: "RAZORPAY",
      paymentStatus: "PENDING",
      currency: "INR",
      totalAmount: 10000,
      requiredAmount: 5000,
      paidAmount: 0,
      remainingAmount: 5000,
      razorpayOrderId: null,
      razorpayPaymentId: null,
      razorpaySignature: null,
    });
    await setPrice("premium-decoration", 2499);
  });

  test("odd catalog price rounds the required half up: Rs. 999 -> 500 required, 499 remaining", async () => {
    const b = body();
    const { booking } = await (await post(b)).json();
    assert.equal(booking.payment.totalAmount, 999);
    assert.equal(booking.payment.requiredAmount, 500);
    assert.equal(booking.payment.remainingAmount, 499);
    assert.equal((await stored(b.requestId)).totalAmount, 999);
  });
});

describe("FULL payment", () => {
  test("the spec example: package Rs. 10,000 -> total 10,000, required 10,000, remaining 0", async () => {
    await setPrice("reception-stage", 10000);
    const b = body({ packageId: "reception-stage", paymentOption: "FULL", paymentMethod: "CASH" });
    const res = await post(b);
    assert.equal(res.status, 201);

    assert.deepEqual(paymentOf(await stored(b.requestId)), {
      paymentOption: "FULL",
      paymentMethod: "CASH",
      paymentStatus: "PENDING",
      currency: "INR",
      totalAmount: 10000,
      requiredAmount: 10000,
      paidAmount: 0,
      remainingAmount: 0,
      razorpayOrderId: null,
      razorpayPaymentId: null,
      razorpaySignature: null,
    });
    await setPrice("reception-stage", 4999);
  });

  test("a seeded package: Rs. 4,999 FULL -> 4,999 / 4,999 / 0", async () => {
    const { booking } = await (await post(body({ packageId: "reception-stage", paymentOption: "FULL" }))).json();
    assert.deepEqual(
      [booking.payment.totalAmount, booking.payment.requiredAmount, booking.payment.remainingAmount],
      [4999, 4999, 0]
    );
  });
});

describe("what is stored and returned", () => {
  test("nothing is claimed as paid: PENDING, paidAmount 0, no provider ids, in every combination", async () => {
    for (const paymentOption of ["HALF", "FULL"]) {
      for (const paymentMethod of ["RAZORPAY", "CASH", "UPI"]) {
        const b = body({ paymentOption, paymentMethod });
        const { booking } = await (await post(b)).json();
        const doc = await stored(b.requestId);
        assert.equal(doc.paymentStatus, "PENDING");
        assert.equal(doc.paidAmount, 0);
        assert.equal(doc.paymentMethod, paymentMethod);
        assert.equal(doc.razorpayOrderId, null);
        assert.equal(doc.razorpayPaymentId, null);
        assert.equal(doc.razorpaySignature, null);
        assert.equal(booking.payment.status, "PENDING");
        assert.equal(booking.payment.paidAmount, 0);
        assert.equal(booking.status, "Pending");
      }
    }
  });

  test("receipt shape; no provider fields and no personal data", async () => {
    const b = body();
    const res = await post(b);
    const json = await res.json();
    assert.deepEqual(json.booking, {
      id: b.requestId,
      status: "Pending",
      package: { id: "birthday-decor", name: "Birthday Decor" },
      payment: {
        option: "HALF", method: "UPI", status: "PENDING", currency: "INR",
        totalAmount: 999, requiredAmount: 500, paidAmount: 0, remainingAmount: 499,
      },
      slot: { id: "t1000", label: "10:00 AM" },
      date: b.date,
      time: "10:00",
    });
    const text = JSON.stringify(json);
    for (const s of ["razorpay", "Asha", "9876543210", "asha@example.com", "Lake Road"]) assert.ok(!text.includes(s), s);
  });

  test("the retired Phase 2 fields are gone (money is stored once)", async () => {
    const b = body();
    await post(b);
    const doc = await stored(b.requestId);
    for (const k of ["paymentType", "payableAmount", "balanceAmount", "packagePrice"]) assert.ok(!(k in doc), `${k} must not be stored`);
  });

  test("document keeps what the admin dashboard needs", async () => {
    const b = body();
    await post(b);
    const doc = await stored(b.requestId);
    for (const k of ["name", "email", "phone", "package", "packageId", "date", "time", "balloonColor", "address", "notes", "status", "createdAt", ...PAYMENT_FIELDS]) {
      assert.ok(k in doc, `missing ${k}`);
    }
    assert.equal(doc.package, "Birthday Decor");
    assert.equal(doc.phone, "+919876543210");
    assert.equal(doc.status, "Pending");
    assert.equal(typeof doc.createdAt.toDate, "function");
  });
});

describe("modified frontend amounts / payment state are never trusted", () => {
  test("forged totals, paid flags, statuses and provider ids are all ignored", async () => {
    const forged = {
      totalAmount: 1, requiredAmount: 1, remainingAmount: 0, paidAmount: 999,
      paymentStatus: "PAID", payment: { paymentStatus: "PAID", paidAmount: 999, requiredAmount: 1 },
      packagePrice: 1, price: 1, amount: 1, payableAmount: 1, balanceAmount: 0, currency: "USD",
      status: "Confirmed", createdAt: "2001-01-01",
      razorpayOrderId: "order_forged", razorpayPaymentId: "pay_forged", razorpaySignature: "sig_forged",
    };
    const b = body(forged);
    const res = await post(b);
    assert.equal(res.status, 201);

    assert.deepEqual(paymentOf(await stored(b.requestId)), {
      paymentOption: "HALF", paymentMethod: "UPI", paymentStatus: "PENDING", currency: "INR",
      totalAmount: 999, requiredAmount: 500, paidAmount: 0, remainingAmount: 499,
      razorpayOrderId: null, razorpayPaymentId: null, razorpaySignature: null,
    });
    const doc = await stored(b.requestId);
    assert.equal(doc.status, "Pending");
    assert.equal(typeof doc.createdAt.toDate, "function");
    for (const k of ["payment", "price", "amount", "payableAmount", "packagePrice"]) assert.ok(!(k in doc), k);

    const { booking } = await res.json();
    assert.equal(booking.payment.totalAmount, 999);
    assert.equal(booking.payment.status, "PENDING");
  });

  test("amounts sent as strings, negatives or huge numbers change nothing", async () => {
    for (const totalAmount of ["1", -5, 1e12, null, [], {}]) {
      const b = body({ totalAmount, requiredAmount: totalAmount, paidAmount: totalAmount });
      assert.equal((await post(b)).status, 201);
      const doc = await stored(b.requestId);
      assert.equal(doc.totalAmount, 999);
      assert.equal(doc.requiredAmount, 500);
      assert.equal(doc.paidAmount, 0);
    }
  });

  test("the amounts follow the current catalog price at commit time", async () => {
    await setPrice("canopy-decoration", 1400);
    const { booking } = await (await post(body({ packageId: "canopy-decoration", totalAmount: 1299 }))).json();
    assert.deepEqual([booking.payment.totalAmount, booking.payment.requiredAmount, booking.payment.remainingAmount], [1400, 700, 700]);
    await setPrice("canopy-decoration", 1299);
  });
});

describe("invalid payment option / method", () => {
  const badOptions = ["half", "Half", "full", "FULL ", "Advance", "Full Payment", "50%", "PARTIAL", "", 50, 0, true, null, ["HALF"], { option: "HALF" }];

  test("every invalid paymentOption is a 400 on paymentOption and writes nothing", async () => {
    const before = await bookingsCount();
    for (const paymentOption of badOptions) {
      const res = await post(body({ paymentOption }));
      assert.equal(res.status, 400, JSON.stringify(paymentOption));
      const j = await res.json();
      assert.equal(j.code, "VALIDATION_ERROR");
      assert.ok(j.issues.some((i) => i.field === "paymentOption"), JSON.stringify(j.issues));
    }
    assert.equal(await bookingsCount(), before);
  });

  test("missing paymentOption is a 400 (the customer must choose)", async () => {
    const b = body();
    delete b.paymentOption;
    const res = await post(b);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).issues.some((i) => i.field === "paymentOption"));
  });

  test("the old Phase 2 fields do not substitute for paymentOption", async () => {
    const b = body({ paymentType: "Advance" });
    delete b.paymentOption;
    assert.equal((await post(b)).status, 400);
  });

  test("invalid paymentMethod values are rejected", async () => {
    const before = await bookingsCount();
    for (const paymentMethod of ["Razorpay Online", "Cash after confirmation", "CARD", "razorpay", "", null, 1]) {
      const res = await post(body({ paymentMethod }));
      assert.equal(res.status, 400, JSON.stringify(paymentMethod));
      assert.ok((await res.json()).issues.some((i) => i.field === "paymentMethod"));
    }
    assert.equal(await bookingsCount(), before);
  });
});

describe("invalid packages still fail cleanly", () => {
  test("unknown package -> 422 PACKAGE_NOT_FOUND", async () => {
    const before = await bookingsCount();
    const res = await post(body({ packageId: "no-such-package" }));
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, "PACKAGE_NOT_FOUND");
    assert.equal(await bookingsCount(), before);
  });

  test("disabled package -> 422 PACKAGE_INACTIVE", async () => {
    await getDb().collection("packages").doc("theme-backdrop").update({ active: false });
    const res = await post(body({ packageId: "theme-backdrop" }));
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, "PACKAGE_INACTIVE");
    await getDb().collection("packages").doc("theme-backdrop").update({ active: true });
  });
});

describe("validation writes nothing", () => {
  test("invalid bodies are 400 and create no documents", async () => {
    const before = await bookingsCount();
    for (const c of [body({ name: "" }), body({ phone: "abc" }), body({ email: "nope" }), body({ date: "2001-01-01" }), body({ slotId: "BAD ID" }), body({ address: "" }), body({ requestId: "x" }), {}]) {
      assert.equal((await post(c)).status, 400);
    }
    assert.equal(await bookingsCount(), before);
  });
});

describe("duplicate requests (idempotency)", () => {
  test("same requestId + same payload: 201 then 200 replay, identical receipt, one document", async () => {
    const b = body({ paymentOption: "FULL" });
    const before = await bookingsCount();
    const first = await post(b);
    const second = await post(b);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("idempotent-replay"), "true");
    assert.deepEqual(await second.json(), await first.json());
    assert.equal(await bookingsCount(), before + 1);
  });

  test("15 concurrent identical requests: one 201, the rest 200, one document", async () => {
    const b = body({ packageId: "haldi-decor" });
    const before = await bookingsCount();
    const statuses = (await Promise.all(Array.from({ length: 15 }, () => post(b)))).map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 1, statuses.join());
    assert.equal(statuses.filter((s) => s === 200).length, 14, statuses.join());
    assert.equal(await bookingsCount(), before + 1);
  });

  test("same requestId with a different paymentOption -> 409, the stored booking is untouched", async () => {
    const b = body({ paymentOption: "HALF" });
    assert.equal((await post(b)).status, 201);
    const res = await post({ ...b, paymentOption: "FULL" });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "IDEMPOTENCY_KEY_REUSED");
    const doc = await stored(b.requestId);
    assert.equal(doc.paymentOption, "HALF");
    assert.equal(doc.requiredAmount, 500);
    assert.equal((await post({ ...b, paymentMethod: "CASH" })).status, 409);
  });

  test("replay returns the original amounts even after a price change or disabling", async () => {
    const b = body({ packageId: "candlelight-setup" }); // Rs. 1,799
    const first = await (await post(b)).json();
    await getDb().collection("packages").doc("candlelight-setup").update({ price: 2500, active: false });
    const replay = await post(b);
    assert.equal(replay.status, 200);
    const j = await replay.json();
    assert.deepEqual(j, first);
    assert.equal(j.booking.payment.totalAmount, 1799);
    assert.equal((await stored(b.requestId)).requiredAmount, 900);
    await getDb().collection("packages").doc("candlelight-setup").update({ price: 1799, active: true });
  });
});

describe("POST /api/bookings/validate (dry run)", () => {
  const dry = (b) =>
    fetch(`${srv.base}/api/bookings/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

  test("returns the server's quote, ignores client amounts, writes nothing", async () => {
    const before = await bookingsCount();
    const res = await dry(body({ totalAmount: 1, requiredAmount: 1 }));
    assert.equal(res.status, 200);
    const { ok, quote } = await res.json();
    assert.equal(ok, true);
    assert.deepEqual(
      [quote.paymentOption, quote.totalAmount, quote.requiredAmount, quote.remainingAmount, quote.currency],
      ["HALF", 999, 500, 499, "INR"]
    );
    assert.equal(await bookingsCount(), before);
  });

  test("invalid paymentOption is rejected here too", async () => {
    assert.equal((await dry(body({ paymentOption: "half" }))).status, 400);
  });
});
