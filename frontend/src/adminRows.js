// Pure rendering helpers for the admin bookings table (no DOM, no Firebase), so they
// can be tested in isolation. Everything that comes from a booking document is
// HTML-escaped: customers control most of these strings.

import { formatMoney } from "./catalog.js";

export function escHtml(v) {
  return String(v)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

const OPTION_LABELS = { HALF: "50% Advance", FULL: "Full Amount" };
const METHOD_LABELS = { RAZORPAY: "Razorpay", CASH: "Cash", UPI: "UPI" };
const PAYMENT_STATUS = {
  PENDING:        { label: "Pending",        bg: "#fff7e6", text: "#b45309" },
  PARTIALLY_PAID: { label: "Partially paid", bg: "#eff6ff", text: "#1d4ed8" },
  PAID:           { label: "Paid",           bg: "#ecfdf5", text: "#0f6b37" },
  FAILED:         { label: "Failed",         bg: "#fef2f2", text: "#b91c1c" },
  REFUNDED:       { label: "Refunded",       bg: "#f5f3ff", text: "#6d28d9" },
};
const BOOKING_STATUS = {
  Pending:   { bg: "#fff7e6", text: "#b45309" },
  Confirmed: { bg: "#ecfdf5", text: "#0f6b37" },
  Cancelled: { bg: "#fef2f2", text: "#b91c1c" },
};
const GREY = { bg: "#f3f4f6", text: "#374151" };

const badge = (label, { bg, text }) =>
  `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;background:${bg};color:${text};">${escHtml(label)}</span>`;

export function statusBadgeHtml(status) {
  return badge(status, BOOKING_STATUS[status] || GREY);
}

// One consistent view of a booking's payment, whichever shape the document has.
// New bookings carry paymentOption/paymentStatus/totalAmount/...; bookings created
// before the payment model existed only have paymentType/payableAmount/packagePrice.
export function paymentView(b) {
  if (b.paymentOption) {
    return {
      legacy: false,
      option: OPTION_LABELS[b.paymentOption] || String(b.paymentOption),
      method: METHOD_LABELS[b.paymentMethod] || (b.paymentMethod ? String(b.paymentMethod) : "—"),
      statusCode: b.paymentStatus,
      total: b.totalAmount,
      required: b.requiredAmount,
      paid: b.paidAmount,
      remaining: b.remainingAmount,
      reference: b.razorpayPaymentId
        ? { label: "Payment ID", value: b.razorpayPaymentId }
        : b.razorpayOrderId ? { label: "Order ID", value: b.razorpayOrderId } : null,
    };
  }
  return {
    legacy: true,
    option: b.paymentType || "—",
    method: b.paymentMethod || "—",
    statusCode: null,
    total: b.packagePrice,
    required: b.payableAmount,
    paid: null,
    remaining: b.balanceAmount ?? null,
    reference: null,
  };
}

const money = (n) => (n === null || n === undefined ? "—" : formatMoney(n));

export function paymentStatusBadgeHtml(code) {
  if (!code) return badge("Not recorded", GREY);
  const s = PAYMENT_STATUS[code];
  return s ? badge(s.label, s) : badge(String(code), GREY);
}

// createdAt arrives from the admin API as an ISO string; a Firestore Timestamp is also understood.
export function formatCreatedAt(b) {
  const raw = b.createdAt;
  const date = raw?.toDate?.() ?? (typeof raw === "string" ? new Date(raw) : null);
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";
}

const muted = 'style="color:#686a75;"';
const line = (label, value, strong = false) =>
  `<div style="display:flex;justify-content:space-between;gap:10px;white-space:nowrap;"><span ${muted}>${label}</span>${strong ? `<strong>${value}</strong>` : `<span>${value}</span>`}</div>`;

const money0 = (n) => (n === null || n === undefined ? "—" : formatMoney(n));

// Columns: Booking | Customer | Package | Date & time | Amounts | Payment | Status | (View)
// The rest of the booking (address, notes, balloon colour, history, actions) is in the detail view.
export function renderBookingRow(b) {
  const p = paymentView(b);
  const id = escHtml(b.id || "");
  return `
    <tr data-booking-id="${id}">
      <td><small style="font-family:ui-monospace,monospace;word-break:break-all;" title="Booking ID">${escHtml(b.id || "—")}</small><br/><small ${muted}>${formatCreatedAt(b)}</small></td>
      <td><strong>${escHtml(b.name || "Guest")}</strong><br/><a href="tel:${escHtml(b.phone || "")}">${escHtml(b.phone || "—")}</a><br/><small ${muted}>${escHtml(b.email || "—")}</small></td>
      <td><strong>${escHtml(b.package || "Custom")}</strong></td>
      <td>${escHtml(b.date || "—")}<br/><small>${escHtml(b.timeLabel || b.time || "")}</small></td>
      <td>${line("Total", money0(p.total), true)}${line("Required", money0(p.required))}${line("Paid", money0(p.paid))}${line("Remaining", money0(p.remaining))}</td>
      <td><strong>${escHtml(p.option)}</strong><br/>${paymentStatusBadgeHtml(p.statusCode)}<br/><small>via ${escHtml(p.method)}</small><br/><small ${muted}>${p.reference ? `${p.reference.label}: ${escHtml(p.reference.value)}` : "No transaction yet"}</small>${p.legacy ? `<br/><small ${muted}>(older booking)</small>` : ""}</td>
      <td>${statusBadgeHtml(b.status || "Pending")}</td>
      <td><button type="button" class="secondary-button admin-small" data-action="view" data-id="${id}">View</button></td>
    </tr>`;
}
