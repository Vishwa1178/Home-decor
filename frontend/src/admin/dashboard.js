// The admin dashboard: bookings (search, filter, cursor pagination, detail, confirm / cancel /
// update status / reschedule), packages, and slots (capacity, availability, blocked dates).
//
// It never reads Firestore. Every read is one bounded page from the admin API, and every
// change is an API call that the SERVER authorises (verified ID token + admin claim) and
// audits. This file only presents what the API returns.

import { AdminApiError } from "./api.js";
import { renderBookingRow, escHtml } from "../adminRows.js";
import { slotSelectModel, messageModel, applySlotModel } from "../availability.js";
import {
  bookingDetailHtml, packageRowHtml, packageFormHtml, packageFormValues, changedFields,
  slotRowHtml, slotFormHtml, slotFormValues, blockedRowHtml, occupancyHtml,
} from "./views.js";

const PAGE_SIZE = 20;
const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => isoDate(new Date(Date.now() + n * 86_400_000));

export function initAdminDashboard({ api, doc = document, loadAvailability, onUnauthorized }) {
  const $ = (sel) => doc.querySelector(sel);
  const $$ = (sel) => [...doc.querySelectorAll(sel)];

  const el = {
    notice: $("#adminNotice"),
    stats: { total: $("#statTotal"), pending: $("#statPending"), confirmed: $("#statConfirmed"), today: $("#statToday") },
    filterForm: $("#bookingFilters"),
    rows: $("#bookingRows"),
    count: $("#bookingCount"),
    loadMore: $("#loadMoreBookings"),
    packageRows: $("#packageRows"),
    slotRows: $("#slotRows"),
    blockedRows: $("#blockedRows"),
    blockForm: $("#blockForm"),
    occupancyDate: $("#occupancyDate"),
    occupancyView: $("#occupancyView"),
    modal: $("#adminModal"),
    modalBody: $("#adminModalBody"),
  };

  const state = {
    active: false,
    tab: "bookings",
    filters: {},
    items: [],
    cursor: null,
    hasMore: false,
    listToken: 0,
    catalog: null,
    slots: null,
    blocked: [],
    detail: null,
    loaded: { packages: false, slots: false },
  };

  // ── messages & errors ─────────────────────────────────────────────────────────────
  function notice(message, kind = "info") {
    if (!el.notice) return;
    el.notice.textContent = message || "";
    el.notice.className = `admin-notice ${kind}`;
    el.notice.hidden = !message;
  }

  const describeError = (err) =>
    err.issues?.length ? `${err.message} (${err.issues.map((i) => `${i.field}: ${i.message}`).join("; ")})` : err.message;

  // Runs an API call. Failures are shown in `into` (a selector inside the modal) or as a page
  // notice. A 401 means the session is no longer valid: hand over to the sign-in flow.
  async function run(fn, { into } = {}) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof AdminApiError)) {
        console.error(err);
        notice("Something went wrong. Please try again.", "error");
        return undefined;
      }
      if (err.status === 401 || err.code === "AUTH") { onUnauthorized(err); return undefined; }
      const target = into && $(into);
      if (target) { target.textContent = describeError(err); target.style.color = "#d91f52"; }
      else notice(describeError(err), "error");
      return undefined;
    }
  }

  const say = (selector, text, ok = true) => {
    const target = $(selector);
    if (target) { target.textContent = text; target.style.color = ok ? "#0f6b37" : "#d91f52"; }
  };

  // ── modal ─────────────────────────────────────────────────────────────────────────
  function openModal(html) {
    el.modalBody.innerHTML = html;
    el.modal.classList.add("open");
    el.modal.setAttribute("aria-hidden", "false");
    doc.body.classList.add("modal-open");
    el.modalBody.querySelector("input:not([type=hidden]):not([disabled]), select, button")?.focus?.();
  }
  function closeModal() {
    el.modal.classList.remove("open");
    el.modal.setAttribute("aria-hidden", "true");
    doc.body.classList.remove("modal-open");
    el.modalBody.innerHTML = "";
    state.detail = null;
  }

  // ── stats ─────────────────────────────────────────────────────────────────────────
  async function refreshStats() {
    const s = await run(() => api.stats());
    if (!s || !state.active) return;
    el.stats.total.textContent = s.total;
    el.stats.pending.textContent = s.pending;
    el.stats.confirmed.textContent = s.confirmed;
    el.stats.today.textContent = s.eventsToday;
  }

  // ── bookings list ─────────────────────────────────────────────────────────────────
  const filtersActive = () => Object.keys(state.filters).some((k) => k !== "sort") || state.filters.sort === "upcoming";

  function readFilters() {
    const out = {};
    for (const [k, v] of new FormData(el.filterForm).entries()) {
      const t = String(v).trim();
      if (t) out[k] = t;
    }
    return out;
  }

  function renderBookings() {
    if (!state.items.length) {
      const msg = state.hasMore
        ? "No matches in the part searched so far. Use “Load more” to keep searching."
        : filtersActive() ? "No bookings match these filters." : "No bookings yet.";
      el.rows.innerHTML = `<tr><td colspan="8" style="padding:30px;text-align:center;color:#686a75;">${escHtml(msg)}</td></tr>`;
    } else {
      el.rows.innerHTML = state.items.map(renderBookingRow).join("");
    }
    const n = state.items.length;
    el.count.textContent = n ? `Showing ${n} booking${n === 1 ? "" : "s"}${state.hasMore ? "" : " (all matching)"}` : "";
    el.loadMore.hidden = !state.hasMore;
    el.loadMore.disabled = false;
  }

  async function loadBookings({ reset }) {
    if (!state.active) return; // the session ended (e.g. stop() reset the form): never call the API
    if (reset) Object.assign(state, { cursor: null, items: [], hasMore: false });
    const token = ++state.listToken; // a newer request supersedes this one
    el.loadMore.disabled = true;
    if (reset) el.rows.innerHTML = `<tr><td colspan="8" style="padding:30px;text-align:center;color:#686a75;">Loading…</td></tr>`;

    const res = await run(() => api.listBookings({ ...state.filters, limit: PAGE_SIZE, cursor: state.cursor }));
    if (token !== state.listToken || !state.active) return;
    if (!res) {
      el.rows.innerHTML = `<tr><td colspan="8" style="padding:30px;text-align:center;color:#d91f52;">Could not load bookings.</td></tr>`;
      el.loadMore.hidden = !state.cursor;
      el.loadMore.disabled = false;
      return;
    }
    state.items.push(...res.bookings);
    state.cursor = res.page.nextCursor;
    state.hasMore = res.page.hasMore;
    renderBookings();
  }

  function replaceInList(booking) {
    const i = state.items.findIndex((b) => b.id === booking.id);
    if (i >= 0) { state.items[i] = booking; renderBookings(); }
  }

  // ── booking detail & actions ──────────────────────────────────────────────────────
  function renderDetail(booking, audit) {
    state.detail = booking;
    el.modalBody.innerHTML = bookingDetailHtml(booking, audit);
  }

  async function openDetail(id) {
    openModal("<p>Loading…</p>");
    const res = await run(() => api.getBooking(id));
    if (!res) { closeModal(); return; }
    renderDetail(res.booking, res.audit);
  }

  async function refreshDetail(message) {
    const b = state.detail;
    const res = await run(() => api.getBooking(b.id), { into: "#detailMessage" });
    if (!res) return;
    renderDetail(res.booking, res.audit);
    say("#detailMessage", message);
    replaceInList(res.booking);
    refreshStats();
  }

  async function changeStatus(status, reason) {
    const b = state.detail;
    const res = await run(() => api.setStatus(b.id, { status, expectedStatus: b.status, ...(reason ? { reason } : {}) }), { into: "#detailMessage" });
    if (res) await refreshDetail(res.changed ? `Booking is now ${res.booking.status}.` : "Nothing to change.");
  }

  async function submitReschedule(form) {
    const b = state.detail;
    const fd = new FormData(form);
    const reason = String(fd.get("reason") || "").trim();
    const res = await run(
      () => api.reschedule(b.id, { date: String(fd.get("date")), slotId: String(fd.get("slotId")), ...(reason ? { reason } : {}), expectedDate: b.date, ...(b.slotId ? { expectedSlotId: b.slotId } : {}) }),
      { into: "#detailMessage" }
    );
    if (res) await refreshDetail(res.changed ? "Booking rescheduled." : "That is already the booking's date and time.");
  }

  async function loadRescheduleSlots(form) {
    const select = form.querySelector('select[name="slotId"]');
    const date = form.querySelector('input[name="date"]').value;
    if (!date) { applySlotModel(select, messageModel("Choose a date first")); return; }
    applySlotModel(select, messageModel("Loading times…"));
    try {
      applySlotModel(select, slotSelectModel(await loadAvailability(date)));
    } catch {
      applySlotModel(select, messageModel("Couldn't load times. Change the date to retry."));
    }
  }

  function showForm(id) {
    for (const f of ["#cancelForm", "#rescheduleForm"]) { const n = $(f); if (n) n.hidden = f !== id; }
    const form = id ? $(id) : null;
    if (form) {
      form.hidden = false;
      if (id === "#rescheduleForm") form.querySelector('input[name="date"]').min = isoDate(new Date());
      form.querySelector("input")?.focus();
    }
  }

  // ── packages ──────────────────────────────────────────────────────────────────────
  const categoriesById = () => new Map((state.catalog?.categories || []).map((c) => [c.id, c.name]));

  function fillFilterOptions() {
    const fill = (selector, first, items) => {
      const select = el.filterForm.querySelector(selector);
      if (!select) return;
      const keep = select.value;
      select.innerHTML = `<option value="">${escHtml(first)}</option>${items.map((i) => `<option value="${escHtml(i.value)}">${escHtml(i.text)}</option>`).join("")}`;
      select.value = keep;
    };
    if (state.catalog) fill('select[name="packageId"]', "All packages", state.catalog.packages.map((p) => ({ value: p.id, text: p.name })));
    if (state.slots) fill('select[name="slotId"]', "All times", state.slots.map((s) => ({ value: s.id, text: s.label })));
  }

  function renderPackages() {
    const names = categoriesById();
    el.packageRows.innerHTML = state.catalog.packages.length
      ? state.catalog.packages.map((p) => packageRowHtml(p, names.get(p.category))).join("")
      : `<tr><td colspan="6" style="padding:24px;text-align:center;color:#686a75;">No packages yet.</td></tr>`;
  }

  async function loadCatalog() {
    const res = await run(() => api.catalog());
    if (!res || !state.active) return false;
    state.catalog = res;
    state.loaded.packages = true;
    renderPackages();
    fillFilterOptions();
    return true;
  }

  async function savePackage(form) {
    const editing = form.dataset.mode === "edit";
    const values = packageFormValues(new FormData(form), { editing });
    let body = values;
    if (editing) {
      const original = state.catalog.packages.find((p) => p.id === form.dataset.id);
      body = changedFields(original, values);
      if (!Object.keys(body).length) { closeModal(); notice("No changes to save."); return; }
      if (form.dataset.updatedAt) body.expectedUpdatedAt = form.dataset.updatedAt;
    }
    const res = await run(() => (editing ? api.updatePackage(form.dataset.id, body) : api.createPackage(body)), { into: "#formError" });
    if (!res) return;
    closeModal();
    if (await loadCatalog()) notice(editing ? `Saved “${res.package.name}”. Customers see the change now.` : `Added “${res.package.name}”.`, "success");
  }

  async function togglePackage(id, active) {
    const p = state.catalog.packages.find((x) => x.id === id);
    const res = await run(() => api.updatePackage(id, { active: !active, expectedUpdatedAt: p.updatedAt }));
    if (!res) { await loadCatalog(); return; }
    if (await loadCatalog()) notice(`“${res.package.name}” is now ${res.package.active ? "enabled" : "disabled"}.`, "success");
  }

  // ── slots, blocked dates, booked capacity ─────────────────────────────────────────
  function renderSlots() {
    el.slotRows.innerHTML = state.slots.length
      ? state.slots.map(slotRowHtml).join("")
      : `<tr><td colspan="5" style="padding:24px;text-align:center;color:#686a75;">No slots yet.</td></tr>`;
  }

  async function loadSlots() {
    const res = await run(() => api.slots());
    if (!res || !state.active) return false;
    state.slots = res.slots;
    state.loaded.slots = true;
    renderSlots();
    fillFilterOptions();
    refreshOccupancy();
    return true;
  }

  async function loadBlocked() {
    const res = await run(() => api.blockedDates(isoDate(new Date()), addDays(365)));
    if (!res || !state.active) return;
    state.blocked = res.blockedDates;
    el.blockedRows.innerHTML = res.blockedDates.length
      ? res.blockedDates.map(blockedRowHtml).join("")
      : `<tr><td colspan="3" style="padding:18px;text-align:center;color:#686a75;">No blocked dates.</td></tr>`;
  }

  async function refreshOccupancy() {
    const date = el.occupancyDate.value;
    if (!date || !state.slots) { el.occupancyView.innerHTML = ""; return; }
    const res = await run(() => api.occupancy(date, date));
    if (!res || !state.active) return;
    el.occupancyView.innerHTML = occupancyHtml({ date, slots: state.slots, occupancy: res.occupancy, blocked: res.blockedDates });
  }

  async function saveSlot(form) {
    const editing = form.dataset.mode === "edit";
    const values = slotFormValues(new FormData(form), { editing });
    let body = values;
    if (editing) {
      const original = state.slots.find((s) => s.id === form.dataset.id);
      body = changedFields(original, values);
      if (!Object.keys(body).length) { closeModal(); notice("No changes to save."); return; }
      if (form.dataset.updatedAt) body.expectedUpdatedAt = form.dataset.updatedAt;
    }
    const res = await run(() => (editing ? api.updateSlot(form.dataset.id, body) : api.createSlot(body)), { into: "#formError" });
    if (!res) return;
    closeModal();
    const warning = res.warnings?.[0]?.message;
    if (await loadSlots()) notice(warning || (editing ? `Saved slot ${res.slot.label}.` : `Added slot ${res.slot.label}.`), warning ? "warning" : "success");
  }

  async function toggleSlot(id, enabled) {
    const s = state.slots.find((x) => x.id === id);
    const res = await run(() => api.updateSlot(id, { enabled: !enabled, expectedUpdatedAt: s.updatedAt }));
    if (!res) { await loadSlots(); return; }
    if (await loadSlots()) notice(`Slot ${res.slot.label} is now ${res.slot.enabled ? "enabled" : "disabled"}.`, "success");
  }

  async function blockDate(form) {
    const fd = new FormData(form);
    const date = String(fd.get("date") || "");
    const reason = String(fd.get("reason") || "").trim();
    if (!date) { notice("Choose a date to block.", "error"); return; }
    const res = await run(() => api.blockDate(date, reason));
    if (!res) return;
    form.reset();
    await Promise.all([loadBlocked(), refreshOccupancy()]);
    notice(
      res.existingBookings > 0
        ? `${date} is blocked. ${res.existingBookings} booking${res.existingBookings === 1 ? "" : "s"} already exist for that date and were NOT cancelled.`
        : `${date} is blocked. Customers can no longer book it.`,
      res.existingBookings > 0 ? "warning" : "success"
    );
  }

  async function unblock(date) {
    const res = await run(() => api.unblockDate(date));
    if (!res) return;
    await Promise.all([loadBlocked(), refreshOccupancy()]);
    notice(`${date} is open for booking again.`, "success");
  }

  // ── tabs ──────────────────────────────────────────────────────────────────────────
  function showTab(name) {
    state.tab = name;
    for (const t of $$("[data-admin-tab]")) {
      const on = t.dataset.adminTab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
    }
    for (const p of $$("[data-admin-panel]")) p.hidden = p.dataset.adminPanel !== name;
    if (name === "slots" && !el.occupancyDate.value) {
      el.occupancyDate.value = isoDate(new Date());
      refreshOccupancy();
    }
    if (name === "slots") loadBlocked();
  }

  // ── events (attached once) ────────────────────────────────────────────────────────
  const on = (target, type, handler) => target?.addEventListener(type, handler);

  for (const t of $$("[data-admin-tab]")) on(t, "click", () => showTab(t.dataset.adminTab));

  on(el.filterForm, "submit", (e) => {
    e.preventDefault();
    state.filters = readFilters();
    loadBookings({ reset: true });
  });
  on(el.filterForm, "reset", () => {
    // the form resets after this event; read the cleared values on the next tick
    setTimeout(() => {
      if (!state.active) return;
      state.filters = readFilters();
      loadBookings({ reset: true });
    }, 0);
  });
  on(el.loadMore, "click", () => loadBookings({ reset: false }));

  on(el.rows, "click", (e) => {
    const btn = e.target.closest('[data-action="view"]');
    if (btn) openDetail(btn.dataset.id);
  });

  on(el.packageRows, "click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "edit-package") openModal(packageFormHtml(state.catalog.packages.find((p) => p.id === btn.dataset.id), state.catalog.categories));
    if (btn.dataset.action === "toggle-package") togglePackage(btn.dataset.id, btn.dataset.active === "1");
  });
  on($("#addPackage"), "click", () => state.catalog && openModal(packageFormHtml(null, state.catalog.categories)));

  on(el.slotRows, "click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "edit-slot") openModal(slotFormHtml(state.slots.find((s) => s.id === btn.dataset.id)));
    if (btn.dataset.action === "toggle-slot") toggleSlot(btn.dataset.id, btn.dataset.enabled === "1");
  });
  on($("#addSlot"), "click", () => state.slots && openModal(slotFormHtml(null)));

  on(el.blockForm, "submit", (e) => { e.preventDefault(); blockDate(el.blockForm); });
  on(el.blockedRows, "click", (e) => {
    const btn = e.target.closest('[data-action="unblock"]');
    if (btn) unblock(btn.dataset.date);
  });
  on(el.occupancyDate, "change", refreshOccupancy);

  // modal: one delegated set of handlers for detail, package and slot forms
  on(el.modal, "click", (e) => {
    if (e.target === el.modal) { closeModal(); return; }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    switch (btn.dataset.act) {
      case "close-modal": closeModal(); break;
      case "hide-forms": showForm(null); break;
      case "show-cancel": showForm("#cancelForm"); break;
      case "show-reschedule": showForm("#rescheduleForm"); break;
      case "set-status":
      case "reopen": changeStatus(btn.dataset.status); break;
      case "apply-status": {
        const status = $("#statusSelect").value;
        if (status === "Cancelled") showForm("#cancelForm");
        else changeStatus(status);
        break;
      }
      default: break;
    }
  });
  on($("#adminModalClose"), "click", closeModal);
  on(el.modal, "submit", (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.id === "cancelForm") changeStatus("Cancelled", new FormData(form).get("reason").trim());
    else if (form.id === "rescheduleForm") submitReschedule(form);
    else if (form.id === "packageForm") savePackage(form);
    else if (form.id === "slotForm") saveSlot(form);
  });
  on(el.modal, "change", (e) => {
    if (e.target.closest("#rescheduleForm") && e.target.name === "date") loadRescheduleSlots(e.target.closest("#rescheduleForm"));
  });
  on(doc, "keydown", (e) => { if (e.key === "Escape" && el.modal.classList.contains("open")) closeModal(); });

  // ── lifecycle ─────────────────────────────────────────────────────────────────────
  return {
    start() {
      state.active = true;
      notice("");
      showTab("bookings");
      refreshStats();
      loadCatalog();
      loadSlots();
      loadBookings({ reset: true });
    },
    stop() {
      state.active = false;
      state.listToken++;
      Object.assign(state, { items: [], cursor: null, hasMore: false, filters: {}, catalog: null, slots: null, blocked: [], loaded: { packages: false, slots: false } });
      el.rows.innerHTML = "";
      el.count.textContent = "";
      el.packageRows.innerHTML = "";
      el.slotRows.innerHTML = "";
      el.blockedRows.innerHTML = "";
      el.occupancyView.innerHTML = "";
      for (const s of Object.values(el.stats)) s.textContent = "–";
      el.filterForm.reset();
      closeModal();
      notice("");
    },
  };
}
