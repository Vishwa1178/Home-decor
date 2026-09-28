"use strict";

process.env.NODE_ENV = "test";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { calculateAmounts, quotesFor, initialPayment } = require("../../src/utils/pricing");
const { PAYMENT_OPTIONS, PAYMENT_STATUSES, PAYMENT_METHODS } = require("../../src/constants/payment");
const { createBookingSchema } = require("../../src/schemas/booking.schema");
const { seedSchema } = require("../../src/schemas/catalog.schema");
const { fingerprintOf } = require("../../src/services/bookings.service");
const { todayInTimezone, addDays, isRealDate } = require("../../src/utils/dates");

const today = todayInTimezone("Asia/Kolkata");
const valid = (over = {}) => ({
  requestId: crypto.randomUUID(),
  packageId: "birthday-decor",
  name: "Asha Rao",
  phone: "+91 98765 43210",
  email: "asha@example.com",
  occasion: "Birthday",
  date: addDays(today, 3),
  slotId: "t1000",
  balloonColor: "Gold",
  address: "12 Lake Road, Bangalore",
  notes: "",
  paymentOption: "HALF",
  paymentMethod: "UPI",
  ...over,
});

describe("calculateAmounts", () => {
  test("the spec example: Rs. 10,000, HALF -> required 5,000, remaining 5,000", () => {
    assert.deepEqual(calculateAmounts({ totalAmount: 10000, paymentOption: "HALF" }), {
      totalAmount: 10000, requiredAmount: 5000, remainingAmount: 5000,
    });
  });
  test("the spec example: Rs. 10,000, FULL -> required 10,000, remaining 0", () => {
    assert.deepEqual(calculateAmounts({ totalAmount: 10000, paymentOption: "FULL" }), {
      totalAmount: 10000, requiredAmount: 10000, remainingAmount: 0,
    });
  });
  test("odd prices round the required half UP to whole rupees (Rs. 999 -> 500 + 499)", () => {
    assert.deepEqual(calculateAmounts({ totalAmount: 999, paymentOption: "HALF" }), {
      totalAmount: 999, requiredAmount: 500, remainingAmount: 499,
    });
    assert.equal(calculateAmounts({ totalAmount: 1, paymentOption: "HALF" }).requiredAmount, 1);
  });
  test("invariants hold for every seeded price and random prices, both options", () => {
    const prices = [...JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "catalog.seed.json"), "utf8")).packages.map((p) => p.price)];
    for (let i = 0; i < 2000; i++) prices.push(1 + Math.floor(Math.random() * 1_000_000));
    for (const total of prices) {
      const half = calculateAmounts({ totalAmount: total, paymentOption: "HALF" });
      const full = calculateAmounts({ totalAmount: total, paymentOption: "FULL" });
      for (const r of [half, full]) {
        assert.ok(Number.isInteger(r.requiredAmount) && Number.isInteger(r.remainingAmount));
        assert.equal(r.requiredAmount + r.remainingAmount, r.totalAmount);
        assert.ok(r.requiredAmount >= 1 && r.remainingAmount >= 0);
      }
      assert.ok(half.requiredAmount >= total / 2 && half.requiredAmount < total / 2 + 1, `HALF of ${total}`);
      assert.ok(half.requiredAmount <= full.requiredAmount);
      assert.equal(full.requiredAmount, total);
      assert.equal(full.remainingAmount, 0);
    }
  });
  test("rejects invalid totals and unknown options", () => {
    for (const totalAmount of [0, -1, 9.5, "999", NaN, undefined, null]) {
      assert.throws(() => calculateAmounts({ totalAmount, paymentOption: "HALF" }), TypeError);
    }
    for (const paymentOption of ["half", "Advance", "Full Payment", "", undefined, null, 50]) {
      assert.throws(() => calculateAmounts({ totalAmount: 1000, paymentOption }), TypeError);
    }
  });
});

describe("quotesFor / initialPayment", () => {
  test("quotesFor gives both options", () => {
    assert.deepEqual(quotesFor(10000), {
      HALF: { totalAmount: 10000, requiredAmount: 5000, remainingAmount: 5000 },
      FULL: { totalAmount: 10000, requiredAmount: 10000, remainingAmount: 0 },
    });
  });
  test("a new booking is PENDING, unpaid, with no provider ids (Razorpay is not integrated)", () => {
    assert.deepEqual(initialPayment({ totalAmount: 10000, paymentOption: "HALF", paymentMethod: "RAZORPAY" }), {
      paymentOption: "HALF",
      paymentMethod: "RAZORPAY",
      paymentStatus: "PENDING",
      currency: "INR",
      totalAmount: 10000,
      requiredAmount: 5000,
      remainingAmount: 5000,
      paidAmount: 0,
      razorpayOrderId: null,
      razorpayPaymentId: null,
      razorpaySignature: null,
    });
  });
  test("enums are exactly the specified values", () => {
    assert.deepEqual([...PAYMENT_OPTIONS], ["HALF", "FULL"]);
    assert.deepEqual([...PAYMENT_STATUSES], ["PENDING", "PARTIALLY_PAID", "PAID", "FAILED", "REFUNDED"]);
    assert.deepEqual([...PAYMENT_METHODS], ["RAZORPAY", "CASH", "UPI"]);
  });
});

describe("createBookingSchema", () => {
  test("accepts a valid booking and normalizes it", () => {
    const r = createBookingSchema.safeParse(valid({ email: "ASHA@Example.com ", name: "  Asha Rao " }));
    assert.equal(r.success, true, JSON.stringify(r.error?.issues));
    assert.equal(r.data.phone, "+919876543210");
    assert.equal(r.data.email, "asha@example.com");
    assert.equal(r.data.name, "Asha Rao");
  });

  test("empty optional strings become undefined", () => {
    const r = createBookingSchema.safeParse(valid({ email: "", balloonColor: "", notes: "  ", occasion: "" }));
    assert.equal(r.success, true);
    assert.equal(r.data.email, undefined);
    assert.equal(r.data.notes, undefined);
    assert.equal(r.data.occasion, undefined);
  });

  test("paymentOption is required (no default: the customer must choose)", () => {
    const { paymentOption, ...rest } = valid();
    assert.equal(createBookingSchema.safeParse(rest).success, false);
  });

  test("FULL and HALF are both accepted", () => {
    for (const o of ["HALF", "FULL"]) assert.equal(createBookingSchema.safeParse(valid({ paymentOption: o })).data.paymentOption, o);
    for (const m of ["RAZORPAY", "CASH", "UPI"]) assert.equal(createBookingSchema.safeParse(valid({ paymentMethod: m })).data.paymentMethod, m);
  });

  test("client money / payment-state fields are stripped, never carried through", () => {
    const forged = {
      packagePrice: 1, price: 1, amount: 5, totalAmount: 1, requiredAmount: 1, remainingAmount: 0, paidAmount: 99999,
      payableAmount: 1, paymentStatus: "PAID", payment: { paymentStatus: "PAID" }, status: "Confirmed", createdAt: "x",
      razorpayOrderId: "order_x", razorpayPaymentId: "pay_x", razorpaySignature: "sig",
    };
    const r = createBookingSchema.safeParse(valid(forged));
    assert.equal(r.success, true);
    for (const k of Object.keys(forged)) assert.ok(!(k in r.data), k);
  });

  const bad = [
    ["missing requestId", { requestId: undefined }, "requestId"],
    ["non-uuid requestId", { requestId: "abc" }, "requestId"],
    ["uuid v1 requestId", { requestId: "c232ab00-9414-11ec-b3c8-9f6bdeced846" }, "requestId"],
    ["missing packageId", { packageId: undefined }, "packageId"],
    ["uppercase packageId", { packageId: "Birthday-Decor" }, "packageId"],
    ["path-like packageId", { packageId: "../bookings" }, "packageId"],
    ["name too short", { name: "A" }, "name"],
    ["name missing", { name: undefined }, "name"],
    ["phone letters", { phone: "abcdefghij" }, "phone"],
    ["phone too short", { phone: "12345" }, "phone"],
    ["email malformed", { email: "not-an-email" }, "email"],
    ["date in the past", { date: addDays(today, -1) }, "date"],
    ["date not real (Feb 31)", { date: "2027-02-31" }, "date"],
    ["date wrong format", { date: "05/10/2027" }, "date"],
    ["date too far ahead", { date: addDays(today, 800) }, "date"],
    ["slotId missing", { slotId: undefined }, "slotId"],
    ["slotId uppercase", { slotId: "T1000" }, "slotId"],
    ["slotId with spaces", { slotId: "t 1000" }, "slotId"],
    ["slotId path-like", { slotId: "../slots" }, "slotId"],
    ["slotId too long", { slotId: "a".repeat(41) }, "slotId"],
    ["slotId empty", { slotId: "" }, "slotId"],
    ["slotId numeric", { slotId: 1000 }, "slotId"],
    ["unknown occasion", { occasion: "Wedding" }, "occasion"],
    ["unknown paymentMethod", { paymentMethod: "Bitcoin" }, "paymentMethod"],
    ["old-style paymentMethod label", { paymentMethod: "Razorpay Online" }, "paymentMethod"],
    ["lowercase paymentMethod", { paymentMethod: "upi" }, "paymentMethod"],
    ["missing paymentMethod", { paymentMethod: undefined }, "paymentMethod"],
    ["missing paymentOption", { paymentOption: undefined }, "paymentOption"],
    ["lowercase paymentOption", { paymentOption: "half" }, "paymentOption"],
    ["mixed-case paymentOption", { paymentOption: "Full" }, "paymentOption"],
    ["old paymentOption 'Advance'", { paymentOption: "Advance" }, "paymentOption"],
    ["old paymentOption 'Full Payment'", { paymentOption: "Full Payment" }, "paymentOption"],
    ["percentage string", { paymentOption: "50%" }, "paymentOption"],
    ["unknown paymentOption", { paymentOption: "PARTIAL" }, "paymentOption"],
    ["numeric paymentOption", { paymentOption: 50 }, "paymentOption"],
    ["null paymentOption", { paymentOption: null }, "paymentOption"],
    ["array paymentOption", { paymentOption: ["HALF"] }, "paymentOption"],
    ["empty paymentOption", { paymentOption: "" }, "paymentOption"],
    ["address too short", { address: "x" }, "address"],
    ["notes too long", { notes: "n".repeat(1001) }, "notes"],
  ];
  for (const [name, over, field] of bad) {
    test(`rejects: ${name}`, () => {
      const r = createBookingSchema.safeParse(valid(over));
      assert.equal(r.success, false);
      assert.ok(r.error.issues.some((i) => i.path[0] === field), `expected an issue on ${field}, got ${JSON.stringify(r.error.issues.map((i) => i.path))}`);
    });
  }

  test("today is accepted (same-day slots are advertised)", () => {
    assert.equal(createBookingSchema.safeParse(valid({ date: today })).success, true);
  });
});

describe("fingerprintOf", () => {
  test("ignores requestId and key order, detects any change", () => {
    const a = createBookingSchema.parse(valid());
    const same = { ...a, requestId: crypto.randomUUID() };
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    assert.equal(fingerprintOf(a), fingerprintOf(same));
    assert.equal(fingerprintOf(a), fingerprintOf(reordered));
    assert.notEqual(fingerprintOf(a), fingerprintOf({ ...a, address: "Somewhere else" }));
    assert.notEqual(fingerprintOf(a), fingerprintOf({ ...a, packageId: "balloon-decor" }));
  });
});

describe("dates", () => {
  test("isRealDate", () => {
    assert.equal(isRealDate("2028-02-29"), true);
    assert.equal(isRealDate("2027-02-29"), false);
    assert.equal(isRealDate("2027-13-01"), false);
  });
});

describe("catalog.seed.json", () => {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "catalog.seed.json"), "utf8"));
  const parsed = seedSchema.safeParse(seed);

  test("is valid against the catalog schema", () => assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues)));
  test("has unique category and package ids", () => {
    const cats = seed.categories.map((c) => c.id);
    const pkgs = seed.packages.map((p) => p.id);
    assert.equal(new Set(cats).size, cats.length);
    assert.equal(new Set(pkgs).size, pkgs.length);
  });
  test("every package references an existing category", () => {
    const cats = new Set(seed.categories.map((c) => c.id));
    for (const p of seed.packages) assert.ok(cats.has(p.category), `${p.id} -> ${p.category}`);
  });
  test("32 packages in 7 categories, all active, extracted (not invented) prices", () => {
    assert.equal(seed.packages.length, 32);
    assert.equal(seed.categories.length, 7);
    assert.ok(seed.packages.every((p) => p.active));
  });
});
