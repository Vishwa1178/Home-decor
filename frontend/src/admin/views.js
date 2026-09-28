// Pure HTML/data helpers for the admin dashboard (no DOM, no network), so they can be tested
// in isolation. Everything that reaches HTML goes through escHtml: customers and admins type
// most of these strings.

import { escHtml, statusBadgeHtml, paymentStatusBadgeHtml, paymentView, formatCreatedAt } from "../adminRows.js";
import { formatMoney } from "../catalog.js";

const muted = 'style="color:#686a75;"';
const money = (n) => (n === null || n === undefined ? "—" : formatMoney(n));
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const BOOKING_STATUSES = ["Pending", "Confirmed", "Cancelled"];

const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

const badge = (text, bg, color) =>
  `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;background:${bg};color:${color};">${escHtml(text)}</span>`;
export const activeBadge = (active) => (active ? badge("Active", "#ecfdf5", "#0f6b37") : badge("Disabled", "#f3f4f6", "#374151"));

const dl = (rows) =>
  `<dl class="detail-list">${rows.map(([k, v]) => `<div><dt>${escHtml(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
const text = (v) => (v === null || v === undefined || v === "" ? "—" : escHtml(v));

// ── audit history ──────────────────────────────────────────────────────────────────
const FIELD_LABELS = { price: "price", name: "name", category: "category", description: "description", image: "image", active: "enabled", featured: "featured", sortOrder: "order", capacity: "capacity", enabled: "enabled", days: "days", label: "label", reason: "reason", time: "time" };

function fmtValue(key, v) {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (key === "price") return money(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.map((d) => (key === "days" ? DAY_NAMES[d] : d)).join(", ");
  return String(v);
}

function changes(before, after) {
  return Object.keys(after || {})
    .filter((k) => k !== "seat")
    .map((k) => `${FIELD_LABELS[k] || k}: ${fmtValue(k, before?.[k])} → ${fmtValue(k, after[k])}`)
    .join("; ");
}

// One line of plain text (NOT html) describing an audit entry.
export function describeAudit(e) {
  const b = e.before || {};
  const a = e.after || {};
  switch (e.action) {
    case "booking.status_changed":
      return `Status ${b.status} → ${a.status}${a.seat === "released" ? " (slot seat released)" : a.seat === "reserved" ? " (slot seat taken again)" : ""}`;
    case "booking.rescheduled":
      return `Rescheduled ${b.date} ${b.time || ""} → ${a.date} ${a.time || ""}`.replace(/\s+/g, " ").trim();
    case "package.created": return `Package created (${money(a.price)})`;
    case "package.updated": return `Package edited — ${changes(b, a)}`;
    case "slot.created": return `Slot created (capacity ${a.capacity})`;
    case "slot.updated": return `Slot edited — ${changes(b, a)}`;
    case "blockedDate.blocked": return `Date blocked${a.reason ? ` — ${a.reason}` : ""}`;
    case "blockedDate.updated": return `Block reason changed — ${b.reason || "(empty)"} → ${a.reason || "(empty)"}`;
    case "blockedDate.unblocked": return "Date unblocked";
    default: return e.action;
  }
}

export function auditListHtml(entries) {
  if (!entries.length) return `<p ${muted}>No changes recorded yet.</p>`;
  return `<ol class="audit-list">${entries
    .map(
      (e) => `<li><strong>${escHtml(describeAudit(e))}</strong>${e.reason ? `<br/><span>Reason: ${escHtml(e.reason)}</span>` : ""}<br/><small ${muted}>${escHtml(fmtTime(e.at))} · ${escHtml(e.actor?.email || e.actor?.uid || "unknown")}</small></li>`
    )
    .join("")}</ol>`;
}

// ── booking detail ─────────────────────────────────────────────────────────────────
export function bookingDetailHtml(b, audit = []) {
  const p = paymentView(b);
  const cancelled = b.status === "Cancelled";
  const others = BOOKING_STATUSES.filter((s) => s !== b.status);

  const customer = dl([
    ["Name", text(b.name)],
    ["Phone", b.phone ? `<a href="tel:${escHtml(b.phone)}">${escHtml(b.phone)}</a>` : "—"],
    ["Email", text(b.email)],
    ["Address", text(b.address)],
  ]);
  const event = dl([
    ["Package", `${text(b.package)}${b.packageId ? ` <small ${muted}>(${escHtml(b.packageId)})</small>` : ""}`],
    ["Occasion", text(b.occasion)],
    ["Date", text(b.date)],
    ["Time", text(b.timeLabel ? `${b.timeLabel}` : b.time)],
    ["Balloon colour", text(b.balloonColor)],
    ["Notes", text(b.notes)],
    ...(b.rescheduledFrom ? [["Rescheduled from", `${text(b.rescheduledFrom.date)} ${text(b.rescheduledFrom.timeLabel || b.rescheduledFrom.time)}`]] : []),
  ]);
  const payment = dl([
    ["Total amount", `<strong>${money(p.total)}</strong>`],
    ["Payment option", text(p.option)],
    ["Required amount", money(p.required)],
    ["Paid amount", money(p.paid)],
    ["Remaining amount", money(p.remaining)],
    ["Payment status", paymentStatusBadgeHtml(p.statusCode)],
    ["Payment method", text(p.method)],
    ["Razorpay order ID", text(b.razorpayOrderId)],
    ["Razorpay payment ID", text(b.razorpayPaymentId)],
    ["Signature stored", b.hasRazorpaySignature ? "yes" : "no"],
    ...(p.legacy ? [["Note", "Created before payments were tracked"]] : []),
  ]);
  const booking = dl([
    ["Booking ID", `<small style="font-family:ui-monospace,monospace;word-break:break-all;">${escHtml(b.id)}</small>`],
    ["Status", statusBadgeHtml(b.status || "Pending")],
    ["Created", escHtml(formatCreatedAt(b))],
    ["Last changed", escHtml(fmtTime(b.updatedAt))],
    ["Source", text(b.source)],
    ...(cancelled ? [["Cancelled", `${escHtml(fmtTime(b.cancelledAt))}${b.cancelReason ? ` — ${escHtml(b.cancelReason)}` : ""}`]] : []),
  ]);

  const actions = cancelled
    ? `<button type="button" class="primary-button admin-small" data-act="reopen" data-status="Pending">Reopen as pending</button>
       <button type="button" class="secondary-button admin-small" data-act="reopen" data-status="Confirmed">Reopen as confirmed</button>`
    : `${b.status === "Pending" ? `<button type="button" class="primary-button admin-small" data-act="set-status" data-status="Confirmed">Confirm</button>` : ""}
       ${b.status === "Confirmed" ? `<button type="button" class="secondary-button admin-small" data-act="set-status" data-status="Pending">Mark pending</button>` : ""}
       <button type="button" class="secondary-button admin-small" data-act="show-reschedule">Reschedule</button>
       <button type="button" class="secondary-button admin-small danger" data-act="show-cancel">Cancel booking</button>`;

  return `
    <div class="detail-head" data-booking-id="${escHtml(b.id)}" data-status="${escHtml(b.status || "Pending")}" data-date="${escHtml(b.date || "")}" data-slot-id="${escHtml(b.slotId || "")}">
      <h2>Booking details</h2>
      <div class="detail-badges"><small ${muted}>Booking</small> ${statusBadgeHtml(b.status || "Pending")} <small ${muted}>Payment</small> ${paymentStatusBadgeHtml(p.statusCode)}</div>
    </div>
    <div class="detail-grid">
      <section><h3>Booking</h3>${booking}</section>
      <section><h3>Customer</h3>${customer}</section>
      <section><h3>Event</h3>${event}</section>
      <section><h3>Payment</h3>${payment}<p class="admin-hint">Payments are view-only here.</p></section>
    </div>
    <section class="detail-actions">
      <h3>Actions</h3>
      <div class="admin-actions">${actions}
        <label class="inline-select">Update status
          <select id="statusSelect">${others.map((s) => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join("")}</select>
        </label>
        <button type="button" class="secondary-button admin-small" data-act="apply-status">Update</button>
      </div>
      <form id="cancelForm" class="admin-inline-form" hidden>
        <label>Reason for cancelling (required)<input name="reason" required minlength="3" maxlength="500" placeholder="e.g. Customer asked to cancel" /></label>
        <p class="admin-hint">The slot seat is released. Payment state is not changed and nothing is refunded automatically.</p>
        <button type="submit" class="primary-button admin-small danger">Cancel this booking</button>
        <button type="button" class="secondary-button admin-small" data-act="hide-forms">Keep booking</button>
      </form>
      <form id="rescheduleForm" class="admin-inline-form" hidden>
        <div class="form-row">
          <label>New date<input name="date" type="date" required /></label>
          <label>New time<select name="slotId" required disabled><option value="">Choose a date first</option></select></label>
        </div>
        <label>Reason (optional)<input name="reason" maxlength="500" /></label>
        <button type="submit" class="primary-button admin-small">Move booking</button>
        <button type="button" class="secondary-button admin-small" data-act="hide-forms">Close</button>
      </form>
      <p id="detailMessage" class="form-status" role="status"></p>
    </section>
    <section class="detail-history"><h3>History</h3>${auditListHtml(audit)}</section>`;
}

// ── packages ───────────────────────────────────────────────────────────────────────
export function packageRowHtml(p, categoryName) {
  const id = escHtml(p.id);
  return `
    <tr data-package-id="${id}">
      <td><strong>${escHtml(p.name)}</strong><br/><small ${muted}>${id}</small></td>
      <td>${escHtml(categoryName || p.category)}</td>
      <td><strong>${money(p.price)}</strong></td>
      <td>${activeBadge(p.active)}${p.featured ? ` ${badge("Featured", "#fff7e6", "#b45309")}` : ""}</td>
      <td><small ${muted}>${escHtml(fmtTime(p.updatedAt))}</small></td>
      <td>
        <button type="button" class="secondary-button admin-small" data-action="edit-package" data-id="${id}">Edit</button>
        <button type="button" class="secondary-button admin-small" data-action="toggle-package" data-id="${id}" data-active="${p.active ? "1" : "0"}">${p.active ? "Disable" : "Enable"}</button>
      </td>
    </tr>`;
}

export function packageFormHtml(p, categories) {
  const editing = Boolean(p);
  const v = p || { name: "", category: categories[0]?.id || "", price: "", description: "", image: "", sortOrder: 0, featured: false, active: true };
  return `
    <h2>${editing ? "Edit package" : "Add package"}</h2>
    <form id="packageForm" class="admin-form" data-mode="${editing ? "edit" : "create"}" data-id="${escHtml(p?.id || "")}" data-updated-at="${escHtml(p?.updatedAt || "")}" novalidate>
      <label>Name<input name="name" required minlength="2" maxlength="100" value="${escHtml(v.name)}" /></label>
      <div class="form-row">
        <label>Category<select name="category" required>${categories.map((c) => `<option value="${escHtml(c.id)}"${c.id === v.category ? " selected" : ""}>${escHtml(c.name)}</option>`).join("")}</select></label>
        <label>Price (Rs., whole rupees)<input name="price" type="number" min="1" step="1" required value="${escHtml(v.price)}" /></label>
      </div>
      <label>Description<textarea name="description" rows="3" maxlength="2000">${escHtml(v.description || "")}</textarea></label>
      <label>Image URL (https)<input name="image" type="url" placeholder="https://…" value="${escHtml(v.image || "")}" /></label>
      <div class="form-row">
        <label>Display order<input name="sortOrder" type="number" step="1" value="${escHtml(v.sortOrder ?? 0)}" /></label>
        <div class="checks"><label class="check"><input name="featured" type="checkbox"${v.featured ? " checked" : ""} /> Featured</label>
        <label class="check"><input name="active" type="checkbox"${v.active ? " checked" : ""} /> Enabled (visible to customers)</label></div>
      </div>
      ${editing ? `<p class="admin-hint">Price changes apply to new bookings only. Existing bookings keep the price they were made at.</p>` : ""}
      <p id="formError" class="form-status" role="alert"></p>
      <button type="submit" class="primary-button">${editing ? "Save changes" : "Add package"}</button>
      <button type="button" class="secondary-button" data-act="close-modal">Cancel</button>
    </form>`;
}

// FormData-like: anything with get(name) and getAll(name).
export function packageFormValues(fd, { editing }) {
  const num = (name) => (String(fd.get(name) ?? "").trim() === "" ? undefined : Number(fd.get(name)));
  const values = {
    name: String(fd.get("name") ?? "").trim(),
    category: String(fd.get("category") ?? ""),
    price: num("price"),
    description: String(fd.get("description") ?? "").trim(),
    image: String(fd.get("image") ?? "").trim() || null,
    sortOrder: num("sortOrder") ?? 0,
    featured: fd.get("featured") !== null && fd.get("featured") !== undefined,
    active: fd.get("active") !== null && fd.get("active") !== undefined,
  };
  return editing ? values : { ...values };
}

// Only what actually changed: a PATCH then never overwrites fields another admin edited meanwhile.
export function changedFields(original, values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) if (JSON.stringify(original[k] ?? null) !== JSON.stringify(v ?? null)) out[k] = v;
  return out;
}

// ── slots ──────────────────────────────────────────────────────────────────────────
const daysText = (days) => (days.length === 7 ? "Every day" : days.map((d) => DAY_NAMES[d]).join(", "));

export function slotRowHtml(s) {
  const id = escHtml(s.id);
  return `
    <tr data-slot-id="${id}">
      <td><strong>${escHtml(s.label)}</strong><br/><small ${muted}>${escHtml(s.time)} · ${id}</small></td>
      <td>${escHtml(s.capacity)}</td>
      <td>${escHtml(daysText(s.days))}</td>
      <td>${activeBadge(s.enabled)}</td>
      <td>
        <button type="button" class="secondary-button admin-small" data-action="edit-slot" data-id="${id}">Edit</button>
        <button type="button" class="secondary-button admin-small" data-action="toggle-slot" data-id="${id}" data-enabled="${s.enabled ? "1" : "0"}">${s.enabled ? "Disable" : "Enable"}</button>
      </td>
    </tr>`;
}

export function slotFormHtml(s) {
  const editing = Boolean(s);
  const v = s || { time: "", label: "", capacity: 1, enabled: true, days: [0, 1, 2, 3, 4, 5, 6] };
  return `
    <h2>${editing ? "Edit slot" : "Add slot"}</h2>
    <form id="slotForm" class="admin-form" data-mode="${editing ? "edit" : "create"}" data-id="${escHtml(s?.id || "")}" data-updated-at="${escHtml(s?.updatedAt || "")}" novalidate>
      <div class="form-row">
        <label>Start time<input name="time" type="time" required value="${escHtml(v.time)}"${editing ? " disabled" : ""} /></label>
        <label>Label shown to customers<input name="label" maxlength="30" placeholder="${editing ? "" : "Generated from the time"}" value="${escHtml(v.label)}" /></label>
      </div>
      <label>Capacity (bookings per date)<input name="capacity" type="number" min="1" max="100" step="1" required value="${escHtml(v.capacity)}" /></label>
      <fieldset class="days"><legend>Runs on</legend>${DAY_NAMES.map((n, i) => `<label class="check"><input type="checkbox" name="days" value="${i}"${v.days.includes(i) ? " checked" : ""} /> ${n}</label>`).join("")}</fieldset>
      <label class="check"><input name="enabled" type="checkbox"${v.enabled ? " checked" : ""} /> Enabled (offered to customers)</label>
      ${editing ? `<p class="admin-hint">The start time cannot be changed. To move a slot, add a new one and disable this one. Lowering capacity keeps existing bookings.</p>` : ""}
      <p id="formError" class="form-status" role="alert"></p>
      <button type="submit" class="primary-button">${editing ? "Save changes" : "Add slot"}</button>
      <button type="button" class="secondary-button" data-act="close-modal">Cancel</button>
    </form>`;
}

export function slotFormValues(fd, { editing }) {
  const values = {
    label: String(fd.get("label") ?? "").trim(),
    capacity: Number(fd.get("capacity")),
    days: fd.getAll("days").map(Number).sort((a, b) => a - b),
    enabled: fd.get("enabled") !== null && fd.get("enabled") !== undefined,
  };
  if (!editing) {
    values.time = String(fd.get("time") ?? "");
    if (!values.label) delete values.label; // the server generates it from the time
  }
  return values;
}

export function blockedRowHtml(b) {
  return `
    <tr data-blocked-date="${escHtml(b.date)}">
      <td><strong>${escHtml(b.date)}</strong></td>
      <td>${text(b.reason)}</td>
      <td><button type="button" class="secondary-button admin-small" data-action="unblock" data-date="${escHtml(b.date)}">Unblock</button></td>
    </tr>`;
}

// Booked capacity for one date: each slot's seats taken / capacity.
export function occupancyHtml({ date, slots, occupancy, blocked }) {
  const taken = new Map(occupancy.filter((o) => o.date === date).map((o) => [o.slotId, o]));
  const isBlocked = blocked.some((b) => b.date === date);
  const rows = slots
    .map((s) => {
      const o = taken.get(s.id);
      const booked = o ? o.bookedCount : 0;
      const capacity = s.capacity;
      const state = !s.enabled ? "Disabled" : isBlocked ? "Date blocked" : booked >= capacity ? "Full" : "Open";
      return `<tr><td><strong>${escHtml(s.label)}</strong></td><td>${escHtml(booked)} / ${escHtml(capacity)}</td><td>${escHtml(state)}</td></tr>`;
    })
    .join("");
  return `<table class="admin-mini"><thead><tr><th>Slot</th><th>Booked</th><th>State</th></tr></thead><tbody>${rows || `<tr><td colspan="3">No slots.</td></tr>`}</tbody></table>`;
}
