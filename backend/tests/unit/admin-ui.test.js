"use strict";

// The admin dashboard's API client and rendering helpers (no browser, no services).

process.env.NODE_ENV = "test";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const esm = (rel) => import(pathToFileURL(path.join(__dirname, "..", "..", "..", "frontend", "src", rel)).href);
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("admin API client", () => {
  const make = async (fetchImpl, over = {}) => {
    const { createAdminApi } = await esm("admin/api.js");
    return createAdminApi({ baseUrl: "http://api", getIdToken: async () => "TOKEN123", fetchImpl, ...over });
  };
  const okJson = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
  const recorder = () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined }); return okJson({ ok: true }); };
    return { calls, fetchImpl };
  };

  test("every request carries the signed-in user's bearer token", async () => {
    const { calls, fetchImpl } = recorder();
    const api = await make(fetchImpl);
    await api.stats();
    assert.equal(calls[0].init.headers.Authorization, "Bearer TOKEN123");
    assert.equal(calls[0].url, "http://api/api/admin/stats");
  });

  test("the token is fetched fresh for each call (so expiry/refresh is handled by Firebase)", async () => {
    let n = 0;
    const { calls, fetchImpl } = recorder();
    const api = await make(fetchImpl, { getIdToken: async () => `T${++n}` });
    await api.stats();
    await api.stats();
    assert.deepEqual(calls.map((c) => c.init.headers.Authorization), ["Bearer T1", "Bearer T2"]);
  });

  test("list query: empty filters are never sent; values are URL-encoded", async () => {
    const { calls, fetchImpl } = recorder();
    const api = await make(fetchImpl);
    await api.listBookings({ status: "Pending", q: "asha rao & co", packageId: "", cursor: undefined, limit: 20, slotId: null, dateFrom: "  " });
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/api/admin/bookings");
    assert.deepEqual([...url.searchParams.entries()].sort(), [["limit", "20"], ["q", "asha rao & co"], ["status", "Pending"]]);
  });

  test("each operation uses the right verb, path and body", async () => {
    const { calls, fetchImpl } = recorder();
    const api = await make(fetchImpl);
    await api.getBooking("abc-1");
    await api.setStatus("abc-1", { status: "Confirmed" });
    await api.reschedule("abc-1", { date: "2030-01-01", slotId: "t1000" });
    await api.catalog();
    await api.createPackage({ name: "N" });
    await api.updatePackage("p-1", { price: 5 });
    await api.slots();
    await api.createSlot({ time: "17:00", capacity: 1 });
    await api.updateSlot("t1000", { capacity: 2 });
    await api.blockedDates("2030-01-01", "2030-02-01");
    await api.blockDate("2030-01-05", "Away");
    await api.blockDate("2030-01-06");
    await api.unblockDate("2030-01-05");
    await api.occupancy("2030-01-01", "2030-01-01");
    await api.audit({ entityType: "booking", entityId: "abc-1" });
    await api.me();
    const seen = calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`);
    assert.deepEqual(seen, [
      "GET /api/admin/bookings/abc-1", "PATCH /api/admin/bookings/abc-1/status", "POST /api/admin/bookings/abc-1/reschedule",
      "GET /api/admin/catalog", "POST /api/admin/packages", "PATCH /api/admin/packages/p-1", "GET /api/admin/slots", "POST /api/admin/slots",
      "PATCH /api/admin/slots/t1000", "GET /api/admin/blocked-dates", "PUT /api/admin/blocked-dates/2030-01-05", "PUT /api/admin/blocked-dates/2030-01-06",
      "DELETE /api/admin/blocked-dates/2030-01-05", "GET /api/admin/slots/occupancy", "GET /api/admin/audit", "GET /api/admin/me",
    ]);
    assert.deepEqual(calls[1].body, { status: "Confirmed" });
    assert.deepEqual(calls[10].body, { reason: "Away" });
    assert.deepEqual(calls[11].body, {}, "no reason -> empty body, not reason: undefined");
    assert.equal(calls[1].init.headers["Content-Type"], "application/json");
    assert.equal(calls[0].init.headers["Content-Type"], undefined, "GETs send no body");
  });

  test("ids are URL-encoded so they cannot alter the path", async () => {
    const { calls, fetchImpl } = recorder();
    const api = await make(fetchImpl);
    await api.getBooking("../stats");
    assert.equal(new URL(calls[0].url).pathname, "/api/admin/bookings/..%2Fstats");
  });

  test("server errors become AdminApiError with status, code and field issues", async () => {
    const { AdminApiError } = await esm("admin/api.js");
    const api = await make(async () => okJson({ code: "VALIDATION_ERROR", message: "Request validation failed", issues: [{ field: "price", message: "Too small" }] }, 400));
    await assert.rejects(api.updatePackage("p", { price: 0 }), (e) => e instanceof AdminApiError && e.status === 400 && e.code === "VALIDATION_ERROR" && e.issues[0].field === "price");
    const forbidden = await make(async () => okJson({ code: "FORBIDDEN", message: "Admin access required" }, 403));
    await assert.rejects(forbidden.stats(), (e) => e.status === 403 && e.code === "FORBIDDEN");
    const conflict = await make(async () => okJson({ code: "SLOT_FULL", message: "full" }, 409));
    await assert.rejects(conflict.reschedule("a", {}), (e) => e.code === "SLOT_FULL");
  });

  test("a non-JSON error body still yields a useful error", async () => {
    const api = await make(async () => ({ ok: false, status: 502, json: async () => { throw new Error("not json"); } }));
    await assert.rejects(api.stats(), (e) => e.status === 502 && e.code === "HTTP_ERROR" && /502/.test(e.message));
  });

  test("failures before a response: NETWORK_ERROR, TIMEOUT, NO_API, and AUTH when signed out", async () => {
    const network = await make(async () => { throw new TypeError("fetch failed"); });
    await assert.rejects(network.stats(), (e) => e.code === "NETWORK_ERROR" && e.status === 0);
    const slow = await make((_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" })))), { timeoutMs: 20 });
    await assert.rejects(slow.stats(), (e) => e.code === "TIMEOUT");
    const { createAdminApi } = await esm("admin/api.js");
    await assert.rejects(createAdminApi({ baseUrl: "", getIdToken: async () => "t" }).stats(), (e) => e.code === "NO_API");
    const signedOut = await make(async () => okJson({}), { getIdToken: async () => { throw new Error("signed out"); } });
    await assert.rejects(signedOut.stats(), (e) => e.code === "AUTH" && e.status === 401);
  });
});

describe("audit history text", () => {
  test("each action reads as a sentence", async () => {
    const { describeAudit } = await esm("admin/views.js");
    assert.equal(describeAudit({ action: "booking.status_changed", before: { status: "Pending" }, after: { status: "Confirmed", seat: null } }), "Status Pending → Confirmed");
    assert.equal(describeAudit({ action: "booking.status_changed", before: { status: "Pending" }, after: { status: "Cancelled", seat: "released" } }), "Status Pending → Cancelled (slot seat released)");
    assert.match(describeAudit({ action: "booking.status_changed", before: { status: "Cancelled" }, after: { status: "Pending", seat: "reserved" } }), /seat taken again/);
    assert.equal(describeAudit({ action: "booking.rescheduled", before: { date: "2030-01-01", time: "10:00 AM" }, after: { date: "2030-01-02", time: "1:00 PM" } }), "Rescheduled 2030-01-01 10:00 AM → 2030-01-02 1:00 PM");
    assert.equal(describeAudit({ action: "package.updated", before: { price: 999, active: true }, after: { price: 1099, active: false } }), "Package edited — price: Rs. 999 → Rs. 1,099; enabled: yes → no");
    assert.equal(describeAudit({ action: "package.created", after: { price: 3333 } }), "Package created (Rs. 3,333)");
    assert.equal(describeAudit({ action: "slot.updated", before: { capacity: 1, days: [0, 1] }, after: { capacity: 3, days: [1, 2] } }), "Slot edited — capacity: 1 → 3; days: Sun, Mon → Mon, Tue");
    assert.equal(describeAudit({ action: "slot.created", after: { capacity: 2 } }), "Slot created (capacity 2)");
    assert.equal(describeAudit({ action: "blockedDate.blocked", after: { reason: "Away" } }), "Date blocked — Away");
    assert.equal(describeAudit({ action: "blockedDate.unblocked" }), "Date unblocked");
    assert.equal(describeAudit({ action: "something.new" }), "something.new");
  });

  test("creation time renders from the API's ISO string (and from a Firestore Timestamp), or a dash when absent/invalid", async () => {
    const { formatCreatedAt } = await esm("adminRows.js");
    const iso = formatCreatedAt({ createdAt: "2030-03-01T10:00:00.000Z" });
    assert.match(iso, /01 Mar 2030/);
    assert.notEqual(iso, "—");
    assert.equal(formatCreatedAt({ createdAt: { toDate: () => new Date("2030-03-01T10:00:00Z") } }), iso);
    for (const bad of [{}, { createdAt: null }, { createdAt: "not a date" }, { createdAt: 12345 }]) assert.equal(formatCreatedAt(bad), "—", JSON.stringify(bad));
  });

  test("the detail and the list row both show the creation time, and the detail labels its two badges", async () => {
    const { bookingDetailHtml } = await esm("admin/views.js");
    const { renderBookingRow } = await esm("adminRows.js");
    const b = { id: "x", name: "A", status: "Pending", paymentStatus: "PENDING", paymentOption: "HALF", createdAt: "2030-03-01T10:00:00.000Z", updatedAt: "2030-03-02T10:00:00.000Z" };
    assert.match(text(bookingDetailHtml(b, [])), /Created 01 Mar 2030/);
    assert.match(text(renderBookingRow(b)), /01 Mar 2030/);
    assert.match(text(bookingDetailHtml(b, [])), /Booking Pending Payment Pending/);
  });

  test("the history list is escaped and names who did it", async () => {
    const { auditListHtml } = await esm("admin/views.js");
    const html = auditListHtml([{ action: "booking.status_changed", before: { status: "Pending" }, after: { status: "Cancelled", seat: "released" }, reason: "<img src=x onerror=alert(1)>", at: "2030-01-01T10:00:00.000Z", actor: { email: "a<b>@x.com" } }]);
    assert.ok(!html.includes("<img") && !html.includes("<b>"));
    assert.ok(html.includes("&lt;img") && html.includes("Reason:"));
    assert.match(html, /a&lt;b&gt;@x\.com/);
    assert.match((await esm("admin/views.js")).auditListHtml([]), /No changes recorded yet/);
  });
});

describe("booking detail", () => {
  const booking = (over = {}) => ({
    id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", name: "Asha Rao", phone: "+919876543210", email: "asha@example.com", address: "12 Lake Road", notes: "Ground floor", balloonColor: "Gold",
    package: "Premium Decoration", packageId: "premium-decoration", occasion: "Birthday", date: "2030-03-05", time: "10:00", timeLabel: "10:00 AM", slotId: "t1000", source: "web",
    status: "Pending", createdAt: "2030-03-01T10:00:00.000Z", updatedAt: "2030-03-01T10:00:00.000Z",
    paymentOption: "HALF", paymentMethod: "RAZORPAY", paymentStatus: "PENDING", currency: "INR", totalAmount: 10000, requiredAmount: 5000, paidAmount: 0, remainingAmount: 5000,
    razorpayOrderId: null, razorpayPaymentId: null, hasRazorpaySignature: false, ...over,
  });

  test("shows the complete booking and every payment field the admin asked for", async () => {
    const { bookingDetailHtml } = await esm("admin/views.js");
    const t = text(bookingDetailHtml(booking(), []));
    for (const e of ["9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", "Asha Rao", "+919876543210", "asha@example.com", "12 Lake Road", "Ground floor", "Gold", "Premium Decoration", "Birthday", "2030-03-05", "10:00 AM",
      "Total amount Rs. 10,000", "Payment option 50% Advance", "Required amount Rs. 5,000", "Paid amount Rs. 0", "Remaining amount Rs. 5,000", "Payment status Pending", "Payment method Razorpay",
      "Razorpay order ID —", "Razorpay payment ID —", "Signature stored no"]) assert.ok(t.includes(e), `missing "${e}"`);
  });

  test("Razorpay ids appear when they exist; the signature is only ever 'stored: yes/no'", async () => {
    const { bookingDetailHtml } = await esm("admin/views.js");
    const html = bookingDetailHtml(booking({ razorpayOrderId: "order_ABC", razorpayPaymentId: "pay_XYZ", hasRazorpaySignature: true, paymentStatus: "PAID", paidAmount: 5000 }), []);
    const t = text(html);
    assert.ok(t.includes("Razorpay order ID order_ABC") && t.includes("Razorpay payment ID pay_XYZ") && t.includes("Signature stored yes") && t.includes("Payment status Paid"));
    assert.ok(!/razorpaySignature/.test(html));
  });

  test("payments are view-only: no payment editing controls", async () => {
    const { bookingDetailHtml } = await esm("admin/views.js");
    const html = bookingDetailHtml(booking(), []);
    assert.match(html, /Payments are view-only here/);
    assert.ok(!/name="paidAmount"|name="paymentStatus"|mark paid/i.test(html));
  });

  test("actions follow the status: Pending -> Confirm; Confirmed -> Mark pending; both -> Reschedule + Cancel", async () => {
    const { bookingDetailHtml } = await esm("admin/views.js");
    const pending = bookingDetailHtml(booking({ status: "Pending" }), []);
    assert.ok(pending.includes('data-act="set-status" data-status="Confirmed"') && !pending.includes('data-act="set-status" data-status="Pending"'));
    assert.ok(pending.includes('data-act="show-reschedule"') && pending.includes('data-act="show-cancel"'));
    const confirmed = bookingDetailHtml(booking({ status: "Confirmed" }), []);
    assert.ok(confirmed.includes('data-act="set-status" data-status="Pending"') && !confirmed.includes('data-act="set-status" data-status="Confirmed"'));
  });

  test("a cancelled booking offers reopen, not confirm/reschedule/cancel, and shows why it was cancelled", async () => {
    const { bookingDetailHtml } = await esm("admin/views.js");
    const html = bookingDetailHtml(booking({ status: "Cancelled", cancelReason: "Customer changed plans", cancelledAt: "2030-03-02T09:00:00.000Z" }), []);
    assert.ok(html.includes('data-act="reopen" data-status="Pending"') && html.includes('data-act="reopen" data-status="Confirmed"'));
    assert.ok(!html.includes('data-act="show-reschedule"') && !html.includes('data-act="show-cancel"') && !html.includes('data-act="set-status"'));
    assert.match(text(html), /Cancelled .*Customer changed plans/);
  });

  test("cancelling needs a reason in the form, and the form says nothing is refunded automatically", async () => {
    const { bookingDetailHtml } = await esm("admin/views.js");
    const html = bookingDetailHtml(booking(), []);
    assert.match(html, /<input name="reason" required minlength="3"/);
    assert.match(html, /nothing is refunded automatically/);
    assert.match(html, /<form id="cancelForm" class="admin-inline-form" hidden>/);
  });

  test("the status dropdown lists every OTHER status", async () => {
    const { bookingDetailHtml } = await esm("admin/views.js");
    const html = bookingDetailHtml(booking({ status: "Confirmed" }), []);
    const options = [...html.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]).filter((v) => ["Pending", "Confirmed", "Cancelled"].includes(v));
    assert.deepEqual(options, ["Pending", "Cancelled"]);
  });

  test("shows the reschedule origin", async () => {
    const { bookingDetailHtml } = await esm("admin/views.js");
    assert.match(text(bookingDetailHtml(booking({ rescheduledFrom: { date: "2030-03-01", slotId: "t1300", timeLabel: "1:00 PM", time: "13:00" } }), [])), /Rescheduled from 2030-03-01 1:00 PM/);
  });

  test("every customer-controlled field is escaped", async () => {
    const { bookingDetailHtml } = await esm("admin/views.js");
    const evil = '<img src=x onerror=alert(1)>"\'';
    const html = bookingDetailHtml(booking({ id: "x1", name: evil, email: evil, address: evil, notes: evil, balloonColor: evil, package: evil, packageId: evil, occasion: evil, phone: evil, cancelReason: evil, status: "Cancelled", source: evil, razorpayOrderId: evil, razorpayPaymentId: evil, slotId: evil }), []);
    assert.ok(!html.includes("<img"), "no raw tag");
    assert.ok(!/onerror=alert\(1\)>/.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, "")));
    assert.ok(!/"[^"]*"onerror/.test(html));
  });

  test("an older booking still renders and is marked as such", async () => {
    const { bookingDetailHtml } = await esm("admin/views.js");
    const t = text(bookingDetailHtml({ id: "old", name: "Old", package: "Birthday Decor", packagePrice: 999, paymentType: "Advance", payableAmount: 500, date: "2026-01-01", time: "18:30", status: "Pending" }, []));
    assert.ok(t.includes("Total amount Rs. 999") && t.includes("Created before payments were tracked") && t.includes("18:30"));
  });
});

describe("package and slot forms", () => {
  const fd = (obj) => ({ get: (k) => (k in obj ? obj[k] : null), getAll: (k) => [].concat(obj[k] ?? []) });

  test("package form values: numbers, blank image -> null, checkboxes -> booleans", async () => {
    const { packageFormValues } = await esm("admin/views.js");
    assert.deepEqual(packageFormValues(fd({ name: " Neon ", category: "birthday", price: "1500", description: " d ", image: "", sortOrder: "3", featured: "on" }), { editing: false }),
      { name: "Neon", category: "birthday", price: 1500, description: "d", image: null, sortOrder: 3, featured: true, active: false });
    assert.equal(packageFormValues(fd({ name: "N", category: "c", price: "" }), { editing: true }).price, undefined);
  });

  test("changedFields sends only what changed (a price edit sends only the price)", async () => {
    const { changedFields } = await esm("admin/views.js");
    const original = { name: "A", category: "c", price: 999, description: "d", image: null, sortOrder: 1, featured: false, active: true };
    assert.deepEqual(changedFields(original, { ...original, price: 1099 }), { price: 1099 });
    assert.deepEqual(changedFields(original, { ...original }), {});
    assert.deepEqual(changedFields(original, { ...original, image: "https://x/y.jpg", active: false }), { image: "https://x/y.jpg", active: false });
    assert.deepEqual(changedFields({ days: [1, 2] }, { days: [1, 2] }), {});
  });

  test("package form: prefilled, escaped, price hint on edit, stale-edit marker", async () => {
    const { packageFormHtml } = await esm("admin/views.js");
    const cats = [{ id: "birthday", name: "Birthday" }, { id: "festival", name: "Festival" }];
    const html = packageFormHtml({ id: "p1", name: '"><script>alert(1)</script>', category: "festival", price: 1234, description: "<b>d</b>", image: "https://x/y.jpg", sortOrder: 2, featured: true, active: false, updatedAt: "2030-01-01T00:00:00.000Z" }, cats);
    assert.ok(!html.includes("<script>") && !html.includes("<b>d</b>"));
    assert.match(html, /data-mode="edit" data-id="p1" data-updated-at="2030-01-01T00:00:00.000Z"/);
    assert.match(html, /<option value="festival" selected>/);
    assert.match(html, /name="price" type="number" min="1" step="1" required value="1234"/);
    assert.match(html, /Price changes apply to new bookings only/);
    assert.ok(/name="featured" type="checkbox" checked/.test(html) && !/name="active" type="checkbox" checked/.test(html));
    assert.match(packageFormHtml(null, cats), /data-mode="create"/);
  });

  test("slot form values: days sorted, blank label omitted on create, time absent on edit", async () => {
    const { slotFormValues } = await esm("admin/views.js");
    assert.deepEqual(slotFormValues(fd({ time: "17:00", label: "", capacity: "2", days: ["3", "1", "2"], enabled: "on" }), { editing: false }), { capacity: 2, days: [1, 2, 3], enabled: true, time: "17:00" });
    assert.deepEqual(slotFormValues(fd({ time: "17:00", label: "Evening", capacity: "2", days: ["1"] }), { editing: true }), { label: "Evening", capacity: 2, days: [1], enabled: false });
  });

  test("slot form: the start time is locked when editing", async () => {
    const { slotFormHtml } = await esm("admin/views.js");
    const slot = { id: "t1000", time: "10:00", label: "10:00 AM", capacity: 1, enabled: true, days: [0, 1, 2, 3, 4, 5, 6], updatedAt: "x" };
    assert.match(slotFormHtml(slot), /name="time" type="time" required value="10:00" disabled/);
    assert.match(slotFormHtml(slot), /The start time cannot be changed/);
    assert.ok(!/name="time"[^>]*disabled/.test(slotFormHtml(null)));
    assert.equal((slotFormHtml(slot).match(/name="days" value="\d" checked/g) || []).length, 7);
  });

  test("rows: enable/disable buttons reflect state; days are summarised; everything escaped", async () => {
    const { packageRowHtml, slotRowHtml, blockedRowHtml } = await esm("admin/views.js");
    const p = { id: "p1", name: "<i>Pkg</i>", category: "c", price: 1999, active: false, featured: true, updatedAt: "2030-01-01T00:00:00.000Z" };
    const ph = packageRowHtml(p, "Cat<b>");
    assert.ok(ph.includes(">Enable</button>") && ph.includes("Disabled") && ph.includes("Featured") && ph.includes("Rs. 1,999") && !ph.includes("<i>") && !ph.includes("<b>"));
    assert.ok(packageRowHtml({ ...p, active: true }, "c").includes(">Disable</button>"));
    const s = { id: "t1000", time: "10:00", label: "10:00 AM", capacity: 2, days: [1, 3], enabled: true };
    assert.ok(text(slotRowHtml(s)).includes("Mon, Wed") && slotRowHtml(s).includes(">Disable</button>"));
    assert.ok(text(slotRowHtml({ ...s, days: [0, 1, 2, 3, 4, 5, 6], enabled: false })).includes("Every day"));
    assert.ok(!blockedRowHtml({ date: "2030-01-01", reason: "<script>x</script>" }).includes("<script>"));
  });

  test("booked capacity table: open / full / disabled / date blocked", async () => {
    const { occupancyHtml } = await esm("admin/views.js");
    const slots = [{ id: "a", label: "10:00 AM", capacity: 1, enabled: true }, { id: "b", label: "1:00 PM", capacity: 3, enabled: true }, { id: "c", label: "4:00 PM", capacity: 1, enabled: false }];
    const occupancy = [{ date: "2030-01-01", slotId: "a", bookedCount: 1 }, { date: "2030-01-01", slotId: "b", bookedCount: 2 }, { date: "2030-01-02", slotId: "b", bookedCount: 3 }];
    const t = text(occupancyHtml({ date: "2030-01-01", slots, occupancy, blocked: [] }));
    assert.ok(t.includes("10:00 AM 1 / 1 Full") && t.includes("1:00 PM 2 / 3 Open") && t.includes("4:00 PM 0 / 1 Disabled"));
    assert.ok(text(occupancyHtml({ date: "2030-01-01", slots, occupancy, blocked: [{ date: "2030-01-01" }] })).includes("2 / 3 Date blocked"));
  });
});
