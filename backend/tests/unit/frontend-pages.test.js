"use strict";

// Static consistency between the frontend pages and the seed catalog, plus the
// catalog/bookingApi client modules (no browser, no services needed).

process.env.NODE_ENV = "test";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const FRONTEND = path.join(__dirname, "..", "..", "..", "frontend");
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "catalog.seed.json"), "utf8"));
const byId = new Map(seed.packages.map((p) => [p.id, p]));

const pages = ["index.html", ...fs.readdirSync(path.join(FRONTEND, "src", "themes")).map((f) => `src/themes/${f}`)];
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), "utf8");
const money = (n) => `Rs. ${n.toLocaleString("en-IN")}`;
const esm = (rel) => import(pathToFileURL(path.join(FRONTEND, "src", rel)).href);

describe("pages vs catalog", () => {
  for (const page of pages) {
    const html = read(page);

    test(`${page}: no hardcoded data-price / data-package attributes remain`, () => {
      assert.ok(!/data-price="/.test(html));
      assert.ok(!/data-package="/.test(html));
    });

    test(`${page}: every data-package-id exists in the catalog`, () => {
      const ids = [...html.matchAll(/data-package-id="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(ids.length > 0);
      for (const id of ids) assert.ok(byId.has(id), `unknown package id "${id}"`);
    });

    test(`${page}: static price labels equal the catalog price (fallback text never drifts)`, () => {
      for (const m of html.matchAll(/<(\w+)[^>]*data-price-of="([^"]+)"[^>]*>([^<]*)</g)) {
        const pkg = byId.get(m[2]);
        assert.ok(pkg, `unknown data-price-of "${m[2]}"`);
        const prefix = /data-price-prefix="([^"]*)"/.exec(m[0])?.[1] || "";
        assert.equal(m[3], prefix + money(pkg.price), `${m[2]} label`);
      }
    });

    test(`${page}: booking form sends packageId and no price fields`, () => {
      assert.match(html, /<input type="hidden" name="packageId" id="packageSelect"/);
      assert.ok(!/name="packagePrice"/.test(html));
      assert.ok(!/name="payableAmount"/.test(html));
      assert.ok(!/name="package"/.test(html));
    });

    test(`${page}: the free-form time input is replaced by a slot picker filled from the backend`, () => {
      assert.ok(!/name="time"|type="time"/.test(html), "no free-form time input");
      assert.match(html, /<select required name="slotId" id="slotSelect" disabled><option value="">Choose a date first<\/option><\/select>/);
      assert.ok(!/<option[^>]*>\s*\d{1,2}:\d{2}/.test(html), "no clock times are hardcoded in the page: the slots come from the API");
    });

    test(`${page}: payment choice is exactly HALF / FULL, methods are RAZORPAY / UPI / CASH`, () => {
      const radios = [...html.matchAll(/<input type="radio" name="paymentOption" value="([^"]+)"( checked)?/g)];
      assert.deepEqual(radios.map((m) => m[1]), ["HALF", "FULL"]);
      assert.deepEqual(radios.filter((m) => m[2]).map((m) => m[1]), ["HALF"], "HALF is preselected");
      const select = /<select name="paymentMethod">(.*?)<\/select>/s.exec(html)[1];
      assert.deepEqual([...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]), ["RAZORPAY", "UPI", "CASH"]);
      assert.ok(!/paymentType|value="Advance"|value="Full Payment"|Payable now/.test(html), "old payment markup is gone");
    });

    test(`${page}: the customer sees the amount to pay and is told nothing is charged`, () => {
      for (const id of ["payableAmount", "paymentSummary", "summaryTotal", "summaryRequired", "summaryRemaining", "halfOptionHint", "fullOptionHint"]) {
        assert.ok(html.includes(`id="${id}"`), id);
      }
      assert.match(html, /No payment is taken when you submit this request\./);
      assert.match(html, /Pay 50% Advance/);
      assert.match(html, /Pay Full Amount/);
      assert.ok(!/(payment (received|successful|complete)|you have paid|\bpaid\b.*successfully)/i.test(html.replace(/<style[\s\S]*?<\/style>/g, "")), "no copy claims a payment happened");
    });
  }

  test("every catalog package is bookable from at least one page, except custom/inactive ones are still listed", () => {
    const used = new Set(pages.flatMap((p) => [...read(p).matchAll(/data-package-id="([^"]+)"/g)].map((m) => m[1])));
    for (const p of seed.packages) assert.ok(used.has(p.id), `${p.id} is in the catalog but on no page`);
  });
});

describe("catalog.js (client)", () => {
  // Minimal fake DOM: just what applyCatalog touches.
  const el = (dataset, extra = {}) => ({ dataset, textContent: "", hidden: false, closest: () => null, ...extra });

  test("applyCatalog fills prices, applies the prefix, hides disabled packages", async () => {
    const { applyCatalog, loadCatalog } = await esm("catalog.js");
    const catalog = { packages: [{ id: "a", price: 1499 }], byId: new Map([["a", { id: "a", price: 1499 }]]) };

    const price = el({ priceOf: "a" });
    const from = el({ priceOf: "a", pricePrefix: "From " });
    const unknownPrice = el({ priceOf: "zzz" });
    unknownPrice.textContent = "Rs. 5";
    const card = el({});
    const active = el({ packageId: "a" }, { closest: () => card });
    const disabledCard = el({});
    const disabled = el({ packageId: "b" }, { closest: () => disabledCard });

    const root = {
      querySelectorAll: (sel) => (sel === "[data-price-of]" ? [price, from, unknownPrice] : [active, disabled]),
    };
    applyCatalog(root, catalog);

    assert.equal(price.textContent, "Rs. 1,499");
    assert.equal(from.textContent, "From Rs. 1,499");
    assert.equal(unknownPrice.textContent, "Rs. 5", "labels for unknown ids are left alone");
    assert.equal(card.hidden, false);
    assert.equal(disabledCard.hidden, true, "package missing from the catalog is hidden");
    assert.equal(typeof loadCatalog, "function");
  });

  test("loadCatalog rejects on bad status, malformed body and missing API url", async () => {
    const { loadCatalog } = await esm("catalog.js");
    await assert.rejects(loadCatalog(""), /not configured/);
    await assert.rejects(loadCatalog("http://x", { fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
    await assert.rejects(loadCatalog("http://x", { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /malformed/);
    const ok = await loadCatalog("http://x", { fetchImpl: async () => ({ ok: true, json: async () => ({ packages: [{ id: "a", price: 1 }] }) }) });
    assert.equal(ok.byId.get("a").price, 1);
  });
});

describe("bookingApi.js (client)", () => {
  test("pickBookingFields never lets a price field through", async () => {
    const { pickBookingFields } = await esm("bookingApi.js");
    const forged = {
      packageId: "a", name: "n", paymentOption: "HALF", paymentMethod: "UPI",
      packagePrice: 1, payableAmount: 1, status: "Confirmed", amount: 5, totalAmount: 1, requiredAmount: 1,
      remainingAmount: 0, paidAmount: 9, paymentStatus: "PAID", razorpayOrderId: "o", razorpayPaymentId: "p", razorpaySignature: "s",
    };
    assert.deepEqual(pickBookingFields(forged), { packageId: "a", name: "n", paymentOption: "HALF", paymentMethod: "UPI" });
  });

  test("attempt tracker: same details reuse the requestId, changed details get a new one, reset starts fresh", async () => {
    const { createAttemptTracker } = await esm("bookingApi.js");
    const t = createAttemptTracker();
    const a = { packageId: "x", name: "A", address: "1 road" };
    const id1 = t.requestIdFor(a);
    assert.equal(t.requestIdFor({ ...a }), id1);
    assert.equal(t.requestIdFor({ name: "A", address: "1 road", packageId: "x" }), id1, "key order does not matter");
    const id2 = t.requestIdFor({ ...a, address: "2 road" });
    assert.notEqual(id2, id1);
    t.reset();
    assert.notEqual(t.requestIdFor({ ...a, address: "2 road" }), id2);
  });

  test("newRequestId is a UUID v4", async () => {
    const { newRequestId } = await esm("bookingApi.js");
    assert.match(newRequestId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("submitBooking sends packageId + requestId and no price; maps responses and failures", async () => {
    const { submitBooking, BookingError, bookingErrorMessage } = await esm("bookingApi.js");
    let sent;
    const ok = async (_url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 201, json: async () => ({ booking: { id: "1" } }) };
    };
    const r = await submitBooking("http://api", { packageId: "a", name: "n", paymentOption: "FULL", totalAmount: 1, paymentStatus: "PAID" }, "rid", { fetchImpl: ok });
    assert.deepEqual(sent, { packageId: "a", name: "n", paymentOption: "FULL", requestId: "rid" });
    assert.equal(r.replay, false);

    const replay = await submitBooking("http://api", { packageId: "a" }, "rid", {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ booking: {} }) }),
    });
    assert.equal(replay.replay, true);

    const fail = (status, body) => submitBooking("http://api", { packageId: "a" }, "rid", { fetchImpl: async () => ({ ok: false, status, json: async () => body }) });
    await assert.rejects(fail(400, { code: "VALIDATION_ERROR", message: "m", issues: [{ field: "phone", message: "Enter a valid phone number" }] }),
      (e) => e instanceof BookingError && e.code === "VALIDATION_ERROR" && bookingErrorMessage(e) === "Enter a valid phone number");
    await assert.rejects(fail(429, { code: "RATE_LIMITED", message: "slow" }), (e) => /Too many/.test(bookingErrorMessage(e)));
    await assert.rejects(fail(422, { code: "PACKAGE_INACTIVE", message: "x" }), (e) => /no longer available/.test(bookingErrorMessage(e)));
    await assert.rejects(submitBooking("http://api", {}, "rid", { fetchImpl: async () => { throw new TypeError("fetch failed"); } }), (e) => e.code === "NETWORK_ERROR");
    await assert.rejects(submitBooking("", {}, "rid"), (e) => e.code === "NO_API");
    await assert.rejects(
      submitBooking("http://api", {}, "rid", { timeoutMs: 20, fetchImpl: (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" })))) }),
      (e) => e.code === "TIMEOUT");
  });
});

describe("describeAmountDue (what the customer is told after booking)", () => {
  test("states the amount to pay, never that anything was paid", async () => {
    const { describeAmountDue } = await esm("bookingApi.js");
    const fmt = (n) => `Rs. ${n.toLocaleString("en-IN")}`;
    assert.equal(describeAmountDue({ totalAmount: 10000, requiredAmount: 5000, remainingAmount: 5000 }, fmt), "Amount to pay: Rs. 5,000 of Rs. 10,000.");
    assert.equal(describeAmountDue({ totalAmount: 10000, requiredAmount: 10000, remainingAmount: 0 }, fmt), "Amount to pay: Rs. 10,000.");
    assert.ok(!/paid|received|success/i.test(describeAmountDue({ totalAmount: 999, requiredAmount: 500, remainingAmount: 499 }, fmt)));
  });
});

describe("admin dashboard wiring (regression guards)", () => {
  test("the browser never touches Firestore: no SDK import, no snapshot listener, no collection reads", () => {
    for (const file of ["src/app.js", "src/admin/dashboard.js", "src/admin/api.js", "src/admin/views.js", "src/adminRows.js"]) {
      const code = read(file);
      assert.ok(!/firebase-firestore|onSnapshot|getFirestore|getDocs|collection\(/.test(code), `${file} must not use Firestore`);
    }
  });

  test("bookings are loaded one bounded page at a time (a limit is always sent) and only via the API", () => {
    const dash = read("src/admin/dashboard.js");
    assert.match(dash, /const PAGE_SIZE = 20;/);
    assert.match(dash, /api\.listBookings\(\{ \.\.\.state\.filters, limit: PAGE_SIZE, cursor: state\.cursor \}\)/);
    assert.ok(!/listBookings\(\{[^}]*\}\)/.test(dash.replace(/limit: PAGE_SIZE/g, "")) || /limit: PAGE_SIZE/.test(dash));
  });

  test("the dashboard is created once and only started/stopped (its listeners must not be attached twice)", () => {
    const app = read("src/app.js");
    assert.match(app, /dashboard \?\?= initAdminDashboard\(/);
    assert.equal((app.match(/initAdminDashboard\(/g) || []).length, 1, "exactly one call site");
    assert.match(app, /if \(dashboardRunning\) return;/);
  });

  test("filters, load-more, row actions and modal are all wired", () => {
    const dash = read("src/admin/dashboard.js");
    for (const wiring of [/on\(el\.filterForm, "submit"/, /on\(el\.filterForm, "reset"/, /on\(el\.loadMore, "click"/, /on\(el\.rows, "click"/, /on\(el\.packageRows, "click"/, /on\(el\.slotRows, "click"/, /on\(el\.blockForm, "submit"/, /on\(el\.modal, "submit"/, /on\(el\.modal, "click"/]) {
      assert.match(dash, wiring);
    }
  });

  test("every element id the dashboard looks up exists in the page", () => {
    const html = read("index.html");
    const dash = read("src/admin/dashboard.js");
    const ids = [...dash.matchAll(/\$\("#([A-Za-z]+)"\)/g)].map((m) => m[1]);
    assert.ok(ids.length > 15);
    for (const id of new Set(ids)) {
      if (["cancelForm", "rescheduleForm", "detailMessage", "statusSelect", "formError"].includes(id)) continue; // rendered inside the modal
      assert.ok(html.includes(`id="${id}"`), `#${id} is missing from index.html`);
    }
    for (const tab of ["bookings", "packages", "slots"]) {
      assert.ok(html.includes(`data-admin-tab="${tab}"`) && html.includes(`data-admin-panel="${tab}"`), tab);
    }
  });

  test("the list table header has as many columns as a rendered row", async () => {
    const html = read("index.html");
    const tableHtml = html.slice(html.indexOf('data-admin-panel="bookings"'), html.indexOf('data-admin-panel="packages"'));
    const heads = [...tableHtml.matchAll(/<th>([^<]*)<\/th>/g)].length;
    const { renderBookingRow } = await esm("adminRows.js");
    assert.equal(heads, renderBookingRow({}).match(/<td/g).length);
    assert.equal(heads, 8);
  });

  test("the modal has a dialog role and a close button", () => {
    const html = read("index.html");
    assert.match(html, /<div class="admin-modal" id="adminModal" aria-hidden="true">/);
    assert.match(html, /role="dialog" aria-modal="true"/);
    assert.match(html, /id="adminModalClose"/);
  });
});

describe("admin bookings table rendering (adminRows.js)", () => {
  const created = { toDate: () => new Date("2027-03-01T10:30:00Z") };
  const newBooking = (over = {}) => ({
    id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    name: "Asha Rao", phone: "+919876543210", email: "asha@example.com",
    package: "Premium Decoration", packageId: "premium-decoration",
    date: "2027-03-05", time: "18:30", balloonColor: "Gold", address: "12 Lake Road", notes: "Ground floor",
    status: "Pending", createdAt: created,
    paymentOption: "HALF", paymentMethod: "RAZORPAY", paymentStatus: "PENDING", currency: "INR",
    totalAmount: 10000, requiredAmount: 5000, paidAmount: 0, remainingAmount: 5000,
    razorpayOrderId: null, razorpayPaymentId: null, razorpaySignature: null,
    ...over,
  });
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

  test("the list row shows: ID, customer, package, slot, total, option, required, paid, remaining, payment status, method, transaction", async () => {
    const { renderBookingRow } = await esm("adminRows.js");
    const html = renderBookingRow(newBooking());
    const t = text(html);
    for (const expected of [
      "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", // booking ID
      "Asha Rao", "+919876543210", "asha@example.com", // customer
      "Premium Decoration", // package
      "Total Rs. 10,000", "Required Rs. 5,000", "Paid Rs. 0", "Remaining Rs. 5,000", // amounts
      "50% Advance", // option
      "Pending", // payment status
      "via Razorpay", // method
      "No transaction yet", // reference
    ]) assert.ok(t.includes(expected), `missing "${expected}" in: ${t}`);
    assert.equal(html.match(/<td/g).length, 8, "eight columns to match the header");
    assert.ok(html.includes('data-action="view"'), "a View button opens the complete booking");
  });

  test("FULL / CASH renders as Full Amount / Cash with remaining Rs. 0", async () => {
    const { renderBookingRow } = await esm("adminRows.js");
    const t = text(renderBookingRow(newBooking({ paymentOption: "FULL", paymentMethod: "CASH", requiredAmount: 10000, remainingAmount: 0 })));
    for (const e of ["Full Amount", "via Cash", "Required Rs. 10,000", "Remaining Rs. 0", "Paid Rs. 0"]) assert.ok(t.includes(e), e);
  });

  test("transaction/order id appears when available (payment id wins over order id)", async () => {
    const { renderBookingRow } = await esm("adminRows.js");
    assert.ok(text(renderBookingRow(newBooking({ razorpayOrderId: "order_ABC123" }))).includes("Order ID: order_ABC123"));
    const both = text(renderBookingRow(newBooking({ razorpayOrderId: "order_ABC123", razorpayPaymentId: "pay_XYZ789", paymentStatus: "PAID", paidAmount: 5000 })));
    assert.ok(both.includes("Payment ID: pay_XYZ789"));
    assert.ok(both.includes("Paid") && both.includes("Paid Rs. 5,000"));
  });

  test("every payment status renders a distinct labelled badge; unknown values are shown, escaped", async () => {
    const { paymentStatusBadgeHtml } = await esm("adminRows.js");
    const labels = { PENDING: "Pending", PARTIALLY_PAID: "Partially paid", PAID: "Paid", FAILED: "Failed", REFUNDED: "Refunded" };
    const colors = new Set();
    for (const [code, label] of Object.entries(labels)) {
      const html = paymentStatusBadgeHtml(code);
      assert.ok(text(html).includes(label), code);
      colors.add(/background:([^;]+)/.exec(html)[1]);
    }
    assert.equal(colors.size, 5);
    assert.ok(paymentStatusBadgeHtml("<img src=x onerror=alert(1)>").includes("&lt;img"));
  });

  test("the payment signature is never displayed", async () => {
    const { renderBookingRow } = await esm("adminRows.js");
    const html = renderBookingRow(newBooking({ razorpaySignature: "SECRET_SIGNATURE_VALUE" }));
    assert.ok(!html.includes("SECRET_SIGNATURE_VALUE"));
  });

  test("customer-controlled text is HTML-escaped everywhere", async () => {
    const { renderBookingRow } = await esm("adminRows.js");
    const evil = '<img src=x onerror=alert(1)>"\'';
    const html = renderBookingRow(newBooking({ name: evil, email: evil, address: evil, notes: evil, balloonColor: evil, package: evil, razorpayOrderId: evil, id: evil }));
    assert.ok(!html.includes("<img"), "no raw tag survives");
    assert.ok(!/onerror=alert\(1\)>/.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, "")));
  });

  test("older bookings (pre-payment-model) still render, marked as older, without inventing payment state", async () => {
    const { renderBookingRow } = await esm("adminRows.js");
    const legacy = { id: "old1", name: "Old Customer", phone: "9000000000", package: "Birthday Decor", packagePrice: 999, paymentType: "Advance", payableAmount: 500, paymentMethod: "UPI", status: "Pending", date: "2026-01-01", time: "10:00" };
    const t = text(renderBookingRow(legacy));
    for (const e of ["Total Rs. 999", "Required Rs. 500", "Paid —", "Advance", "via UPI", "Not recorded", "(older booking)"]) assert.ok(t.includes(e), `missing "${e}" in ${t}`);
  });

  test("a booking with missing fields does not throw", async () => {
    const { renderBookingRow } = await esm("adminRows.js");
    assert.doesNotThrow(() => renderBookingRow({}));
    assert.doesNotThrow(() => renderBookingRow({ paymentOption: "HALF" }));
  });
});

describe("availability.js (slot picker, client side)", () => {
  const slot = (over) => ({ id: "t1000", label: "10:00 AM", time: "10:00", capacity: 1, booked: 0, remaining: 1, available: true, reason: null, ...over });
  const avail = (slots, over = {}) => ({ date: "2030-06-12", timezone: "Asia/Kolkata", blocked: false, slots, ...over });

  test("available slots are selectable; full/past/blocked ones are shown but disabled with a reason", async () => {
    const { slotSelectModel } = await esm("availability.js");
    const m = slotSelectModel(avail([
      slot({}),
      slot({ id: "t1300", label: "1:00 PM", booked: 1, remaining: 0, available: false, reason: "FULL" }),
      slot({ id: "t1600", label: "4:00 PM", available: false, reason: "PAST" }),
    ]));
    assert.equal(m.placeholder, "Choose a time");
    assert.equal(m.disabled, false);
    assert.deepEqual(m.options, [
      { value: "t1000", text: "10:00 AM", disabled: false },
      { value: "t1300", text: "1:00 PM — Fully booked", disabled: true },
      { value: "t1600", text: "4:00 PM — Not available", disabled: true },
    ]);
  });

  test("seats left are mentioned only when a slot holds more than one booking", async () => {
    const { slotSelectModel } = await esm("availability.js");
    const m = slotSelectModel(avail([slot({ capacity: 3, booked: 1, remaining: 2 }), slot({ id: "t1300", label: "1:00 PM", capacity: 1 })]));
    assert.deepEqual(m.options.map((o) => o.text), ["10:00 AM (2 left)", "1:00 PM"]);
  });

  test("everything booked -> a clear message and a disabled picker", async () => {
    const { slotSelectModel } = await esm("availability.js");
    const m = slotSelectModel(avail([slot({ available: false, reason: "FULL", remaining: 0, booked: 1 })]));
    assert.equal(m.placeholder, "All times are booked for this date");
    assert.equal(m.disabled, true);
  });

  test("a blocked date and a date with no slots each get their own message", async () => {
    const { slotSelectModel } = await esm("availability.js");
    assert.deepEqual(slotSelectModel(avail([slot({ available: false, reason: "BLOCKED" })], { blocked: true })), { placeholder: "This date is not available", disabled: true, options: [] });
    assert.deepEqual(slotSelectModel(avail([])), { placeholder: "No times available on this date", disabled: true, options: [] });
  });

  test("the browser invents no slots and no clock times: the model contains only what the API returned", async () => {
    const { slotSelectModel } = await esm("availability.js");
    const m = slotSelectModel(avail([slot({ id: "x1", label: "Sunrise" })]));
    assert.deepEqual(m.options.map((o) => o.value), ["x1"]);
  });

  test("loadAvailability calls the date endpoint uncached and rejects on failures", async () => {
    const { loadAvailability } = await esm("availability.js");
    let seen;
    const ok = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => avail([slot({})]) }; };
    const a = await loadAvailability("http://api", "2030-06-12", { fetchImpl: ok });
    assert.equal(seen.url, "http://api/api/availability?date=2030-06-12");
    assert.equal(seen.init.cache, "no-store");
    assert.equal(a.slots.length, 1);

    await assert.rejects(loadAvailability("", "2030-06-12"), /not configured/);
    await assert.rejects(loadAvailability("http://api", "2030-06-12", { fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
    await assert.rejects(loadAvailability("http://api", "2030-06-12", { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /malformed/);
    await assert.rejects(loadAvailability("http://api", "2030-06-12", { fetchImpl: async () => { throw new TypeError("fetch failed"); } }), /fetch failed/);
    await assert.rejects(
      loadAvailability("http://api", "2030-06-12", { timeoutMs: 20, fetchImpl: (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))) }),
      /aborted/
    );
  });

  test("applySlotModel renders options, disables the picker, and keeps a choice only if still bookable", async () => {
    const { applySlotModel, slotSelectModel } = await esm("availability.js");
    const makeSelect = () => {
      const doc = { createElement: () => ({ value: "", textContent: "", disabled: false }) };
      return { ownerDocument: doc, children: [], value: "", disabled: false, replaceChildren(...c) { this.children = c; } };
    };
    const model = slotSelectModel(avail([slot({}), slot({ id: "t1300", label: "1:00 PM", available: false, reason: "FULL", remaining: 0, booked: 1 })]));

    const a = makeSelect();
    applySlotModel(a, model, "t1000");
    assert.deepEqual(a.children.map((c) => [c.value, c.textContent, c.disabled]), [["", "Choose a time", false], ["t1000", "10:00 AM", false], ["t1300", "1:00 PM — Fully booked", true]]);
    assert.equal(a.value, "t1000", "a still-bookable choice is kept");
    assert.equal(a.disabled, false);

    const b = makeSelect();
    applySlotModel(b, model, "t1300");
    assert.equal(b.value, "", "a slot that just became full is NOT kept");

    const c = makeSelect();
    applySlotModel(c, { placeholder: "Choose a date first", disabled: true, options: [] });
    assert.deepEqual([c.disabled, c.value, c.children.length], [true, "", 1]);
  });
});

describe("booking client: slots", () => {
  test("the payload carries slotId and no time; error wording for slot problems", async () => {
    const { pickBookingFields, bookingErrorMessage, BookingError } = await esm("bookingApi.js");
    assert.deepEqual(pickBookingFields({ slotId: "t1000", time: "03:33", date: "2030-06-12" }), { slotId: "t1000", date: "2030-06-12" });
    const msg = (code) => bookingErrorMessage(new BookingError({ code, message: "x" }));
    assert.match(msg("SLOT_FULL"), /just booked by someone else/);
    assert.match(msg("SLOT_UNAVAILABLE"), /no longer available/);
    assert.match(msg("SLOT_NOT_FOUND"), /no longer available/);
  });

  test("the retry tracker treats a different slot as a new booking (new requestId), the same slot as a retry", async () => {
    const { createAttemptTracker } = await esm("bookingApi.js");
    const t = createAttemptTracker();
    const base = { packageId: "p", date: "2030-06-12", slotId: "t1000", name: "A" };
    const id = t.requestIdFor(base);
    assert.equal(t.requestIdFor({ ...base }), id);
    assert.notEqual(t.requestIdFor({ ...base, slotId: "t1300" }), id);
  });
});

describe("admin table shows the slot", () => {
  test("uses the slot label when present, the raw time for older bookings", async () => {
    const { renderBookingRow } = await esm("adminRows.js");
    const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.match(text(renderBookingRow({ id: "a", date: "2030-06-12", time: "10:00", timeLabel: "10:00 AM" })), /2030-06-12 10:00 AM/);
    assert.match(text(renderBookingRow({ id: "b", date: "2026-01-01", time: "18:30" })), /2026-01-01 18:30/);
  });
});
