// Booking modal shared by the home page (app.js) and the theme pages
// (theme_booking.js): pick a package -> fill the form -> POST /api/bookings.
//
// Prices, package names and "payable now" come from the central catalog
// (GET /api/packages). The browser sends a packageId, never a price, and never
// writes to Firestore: the backend prices and stores the booking.

import { API_BASE_URL } from "./firebase-config.js";
import { loadCatalog, applyCatalog, formatMoney } from "./catalog.js";
import { loadAvailability, slotSelectModel, messageModel, applySlotModel } from "./availability.js";
import { submitBooking, createAttemptTracker, bookingErrorMessage, pickBookingFields, describeAmountDue } from "./bookingApi.js";

export function initBookingModal({ selectedCardSelector }) {
  const bookingForm         = document.querySelector("#bookingForm");
  const bookingStatus       = document.querySelector("#bookingStatus");
  const packageSelect       = document.querySelector("#packageSelect");
  const bookingModal        = document.querySelector("#bookingModal");
  const closeBooking        = document.querySelector("#closeBooking");
  const selectedPackageName = document.querySelector("#selectedPackageName");
  const selectedPackagePrice= document.querySelector("#selectedPackagePrice");
  const payableAmount       = document.querySelector("#payableAmount");
  const halfHint            = document.querySelector("#halfOptionHint");
  const fullHint            = document.querySelector("#fullOptionHint");
  const paymentSummary      = document.querySelector("#paymentSummary");
  const summaryTotal        = document.querySelector("#summaryTotal");
  const summaryRequired     = document.querySelector("#summaryRequired");
  const summaryRemaining    = document.querySelector("#summaryRemaining");
  const serviceNotice       = document.querySelector("#firebaseAlert"); // legacy id; now the booking-service notice
  const submitBtn           = bookingForm?.querySelector('button[type="submit"]');
  const dateInput           = bookingForm?.querySelector('input[name="date"]');
  const occasionSelect      = bookingForm?.querySelector('select[name="occasion"]');
  const slotSelect          = document.querySelector("#slotSelect");

  let catalog = null;          // loaded catalog, or null while loading / if unavailable
  let catalogFailed = false;
  let selectedPackageId = null;
  let lastTrigger;
  let submitting = false;
  const attempts = createAttemptTracker();

  // ─── Catalog ────────────────────────────────────────────────────────────────
  function showNotice(text) {
    if (!serviceNotice) return;
    serviceNotice.textContent = text || "";
    serviceNotice.classList.remove("ready");
    serviceNotice.hidden = !text;
  }

  async function refreshCatalog() {
    try {
      catalog = await loadCatalog(API_BASE_URL);
      catalogFailed = false;
      applyCatalog(document, catalog);
      showNotice(null);
    } catch (err) {
      console.error(err);
      catalogFailed = true;
      showNotice("⚠ Booking is unavailable right now. Please try again in a few minutes.");
    }
    renderSelectedPackage();
  }

  function selectedPackage() {
    return catalog?.byId.get(selectedPackageId) || null;
  }

  // ─── Time slots (availability comes from the backend) ─────────────────────────
  let availabilityRequest = 0; // ignores responses that arrive out of order

  async function refreshSlots() {
    if (!slotSelect) return;
    const date = dateInput?.value;
    if (!date) { applySlotModel(slotSelect, messageModel("Choose a date first")); return; }

    const previous = slotSelect.value;
    const request = ++availabilityRequest;
    applySlotModel(slotSelect, messageModel("Loading times…"));
    try {
      const availability = await loadAvailability(API_BASE_URL, date);
      if (request === availabilityRequest) applySlotModel(slotSelect, slotSelectModel(availability), previous);
    } catch (err) {
      console.error(err);
      if (request === availabilityRequest) applySlotModel(slotSelect, messageModel("Couldn't load times. Change the date to retry."));
    }
  }

  dateInput?.addEventListener("change", refreshSlots);
  dateInput?.addEventListener("input", refreshSlots);

  // ─── Modal ──────────────────────────────────────────────────────────────────
  function renderSelectedPackage() {
    const pkg = selectedPackage();
    if (selectedPackageName) {
      selectedPackageName.textContent = pkg ? pkg.name : (catalog || catalogFailed ? "Package unavailable" : "Loading…");
    }
    if (selectedPackagePrice) selectedPackagePrice.textContent = pkg ? formatMoney(pkg.price) : "";
    if (packageSelect) packageSelect.value = selectedPackageId || "";

    document.querySelectorAll(selectedCardSelector).forEach(c =>
      c.classList.toggle("selected", c.dataset.packageId === selectedPackageId));

    // Keep the "Decoration Type" dropdown in step with the chosen package.
    const category = pkg && catalog.categories.find(c => c.id === pkg.category);
    if (category && occasionSelect && [...occasionSelect.options].some(o => o.value === category.name)) {
      occasionSelect.value = category.name;
    }

    updatePaymentPreview();
    updateSubmitState();
  }

  // Shows what the customer will need to pay. Every number comes from the catalog
  // response (calculated by the server); nothing is computed in the browser.
  function updatePaymentPreview() {
    const pkg = selectedPackage();
    const quotes = pkg?.paymentOptions;

    if (halfHint) halfHint.textContent = quotes
      ? `${formatMoney(quotes.HALF.requiredAmount)} to pay, ${formatMoney(quotes.HALF.remainingAmount)} balance`
      : "Half of the package price";
    if (fullHint) fullHint.textContent = quotes
      ? `${formatMoney(quotes.FULL.requiredAmount)} to pay`
      : "The complete package price";

    const option = bookingForm.querySelector('input[name="paymentOption"]:checked')?.value || "HALF";
    const q = quotes?.[option];
    if (payableAmount) payableAmount.textContent = q ? `Amount to pay: ${formatMoney(q.requiredAmount)}` : "";
    if (paymentSummary) {
      paymentSummary.hidden = !q;
      if (q) {
        summaryTotal.textContent = formatMoney(q.totalAmount);
        summaryRequired.textContent = formatMoney(q.requiredAmount);
        summaryRemaining.textContent = formatMoney(q.remainingAmount);
      }
    }
  }

  function updateSubmitState() {
    if (submitBtn) submitBtn.disabled = submitting || !selectedPackage();
  }

  function openBooking(packageId) {
    selectedPackageId = packageId || null;
    bookingStatus.textContent = "";
    renderSelectedPackage();
    refreshSlots();
    bookingModal.classList.add("open");
    bookingModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    bookingForm.querySelector("input[name='name']").focus();
  }

  function closeBookingModal() {
    bookingModal?.classList.remove("open");
    bookingModal?.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    lastTrigger?.focus?.();
  }

  function setMinimumBookingDate() {
    if (!dateInput) return;
    const t = new Date();
    t.setMinutes(t.getMinutes() - t.getTimezoneOffset());
    dateInput.min = t.toISOString().slice(0, 10);
  }

  document.querySelectorAll("[data-open-booking]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.preventDefault();
      lastTrigger = btn;
      openBooking(btn.dataset.packageId);
    });
  });

  document.querySelectorAll('input[name="paymentOption"]').forEach(i => i.addEventListener("change", updatePaymentPreview));
  closeBooking?.addEventListener("click", closeBookingModal);
  bookingModal?.addEventListener("click", e => { if (e.target === bookingModal) closeBookingModal(); });
  window.addEventListener("keydown", e => { if (e.key === "Escape") closeBookingModal(); });

  // ─── Submit booking -> backend ────────────────────────────────────────────────
  bookingForm?.addEventListener("submit", async e => {
    e.preventDefault();
    const pkg = selectedPackage();
    if (submitting || !pkg) return;

    bookingStatus.textContent = "";
    if (!slotSelect?.value) {
      bookingStatus.textContent = "⚠ Please choose a date and an available time.";
      bookingStatus.style.color = "#d91f52";
      return;
    }
    submitting = true;
    updateSubmitState();
    submitBtn.textContent = "Saving…";

    const payload = pickBookingFields({ ...Object.fromEntries(new FormData(bookingForm)), packageId: pkg.id });

    try {
      // Same details => same requestId, so a retry can never create a second booking.
      const requestId = attempts.requestIdFor(payload);
      const { booking } = await submitBooking(API_BASE_URL, payload, requestId);

      // Amounts come from the server's receipt. Nothing has been charged.
      bookingStatus.textContent =
        `✅ Booking submitted! ${describeAmountDue(booking.payment, formatMoney)} No payment has been taken yet. Admin will confirm your slot soon.`;
      bookingStatus.style.color = "#0f6b37";
      attempts.reset();
      bookingForm.reset();
      renderSelectedPackage();
      refreshSlots();
      setTimeout(() => closeBookingModal(), 2200);
    } catch (err) {
      console.error(err);
      bookingStatus.textContent = "⚠ " + bookingErrorMessage(err);
      bookingStatus.style.color = "#d91f52";
      if (err.code === "IDEMPOTENCY_KEY_REUSED") attempts.reset();
      if (err.code === "PACKAGE_NOT_FOUND" || err.code === "PACKAGE_INACTIVE") refreshCatalog();
      // Someone else took the slot (or it closed) since the list was loaded: show the current picture.
      if (err.code === "SLOT_FULL" || err.code === "SLOT_UNAVAILABLE" || err.code === "SLOT_NOT_FOUND") refreshSlots();
    } finally {
      submitting = false;
      submitBtn.textContent = "Submit Booking";
      updateSubmitState();
    }
  });

  setMinimumBookingDate();
  refreshCatalog();

  return { openBooking, setLastTrigger: el => { lastTrigger = el; } };
}
