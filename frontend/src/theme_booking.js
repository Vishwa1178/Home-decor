// ─── Shared booking-modal logic for standalone theme pages ────────────────────
// (frontend/src/themes/birthday.html, anniversary.html, babyshower.html,
//  engagement.html, festival.html, housewarming.html)
//
// This is a trimmed copy of the booking-modal + Firestore-submit logic from
// app.js — theme pages don't need the SPA router or admin dashboard, just the
// "pick a decor type → book it" flow.

import { firebaseConfig } from "./firebase-config.js";

const bookingForm         = document.querySelector("#bookingForm");
const bookingStatus       = document.querySelector("#bookingStatus");
const packageSelect       = document.querySelector("#packageSelect");
const packagePrice        = document.querySelector("#packagePrice");
const payableAmountInput  = document.querySelector("#payableAmountInput");
const bookingModal        = document.querySelector("#bookingModal");
const closeBooking        = document.querySelector("#closeBooking");
const selectedPackageName = document.querySelector("#selectedPackageName");
const selectedPackagePrice= document.querySelector("#selectedPackagePrice");
const payableAmount       = document.querySelector("#payableAmount");
const firebaseAlert       = document.querySelector("#firebaseAlert");
const bookingSubmitBtn    = bookingForm?.querySelector('button[type="submit"]');
const bookingDateInput    = bookingForm?.querySelector('input[name="date"]');

let firebaseApp, firebaseModules;
let lastBookingTrigger;
const FB_TIMEOUT = 15000;

// ─── Booking triggers ─────────────────────────────────────────────────────────
document.querySelectorAll("[data-open-booking]").forEach(btn => {
  btn.addEventListener("click", e => {
    e.preventDefault();
    lastBookingTrigger = btn;
    openBooking(btn.dataset.package || "Custom Decoration", Number(btn.dataset.price || 999));
  });
});

document.querySelectorAll('input[name="paymentType"]').forEach(i => i.addEventListener("change", updatePayableAmount));
closeBooking?.addEventListener("click", closeBookingModal);
bookingModal?.addEventListener("click", e => { if (e.target === bookingModal) closeBookingModal(); });
window.addEventListener("keydown", e => { if (e.key === "Escape") closeBookingModal(); });

// ─── Booking modal ────────────────────────────────────────────────────────────
function openBooking(packageName, price) {
  packageSelect.value = packageName;
  packagePrice.value  = String(price);
  selectedPackageName.textContent  = packageName;
  selectedPackagePrice.textContent = formatMoney(price);
  document.querySelectorAll(".theme-card").forEach(c => c.classList.toggle("selected", c.dataset.package === packageName));
  updatePayableAmount();
  bookingModal.classList.add("open");
  bookingModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  bookingForm.querySelector("input[name='name']").focus();
}

function closeBookingModal() {
  bookingModal?.classList.remove("open");
  bookingModal?.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  lastBookingTrigger?.focus?.();
}

function updatePayableAmount() {
  const price = Number(packagePrice.value || 0);
  const type  = bookingForm.querySelector('input[name="paymentType"]:checked')?.value || "Advance";
  const amt   = type === "Full Payment" ? price : Math.min(500, price);
  payableAmount.textContent = `Payable now: ${formatMoney(amt)}`;
  payableAmountInput.value  = String(amt);
}

function setMinimumBookingDate() {
  if (!bookingDateInput) return;
  const t = new Date();
  t.setMinutes(t.getMinutes() - t.getTimezoneOffset());
  bookingDateInput.min = t.toISOString().slice(0, 10);
}
setMinimumBookingDate();

// ─── Firebase init ────────────────────────────────────────────────────────────
function hasFirebaseConfig() {
  return ["apiKey", "authDomain", "projectId", "messagingSenderId", "appId"].every(k => {
    const v = firebaseConfig[k];
    return v && !v.startsWith("PASTE_");
  });
}

function renderFirebaseNotice() {
  if (!firebaseAlert) return;
  if (hasFirebaseConfig()) {
    firebaseAlert.textContent = "✓ Firebase connected — bookings save to Firestore.";
    firebaseAlert.classList.add("ready");
  } else {
    firebaseAlert.textContent = "⚠ Firebase config incomplete. Add apiKey, messagingSenderId and appId.";
  }
}
renderFirebaseNotice();

async function getFirebase() {
  if (!hasFirebaseConfig()) return null;
  if (firebaseApp && firebaseModules) return { app: firebaseApp, ...firebaseModules };

  const [appMod, fsMod] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js"),
  ]);

  firebaseApp     = appMod.initializeApp(firebaseConfig);
  firebaseModules = { ...fsMod };
  return { app: firebaseApp, ...firebaseModules };
}

function withTimeout(p, msg, ms = FB_TIMEOUT) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(msg)), ms))]);
}

// ─── Submit booking → Firestore ───────────────────────────────────────────────
bookingForm?.addEventListener("submit", async e => {
  e.preventDefault();
  bookingStatus.textContent = "";
  bookingSubmitBtn.disabled = true;
  bookingSubmitBtn.textContent = "Saving…";

  const data = Object.fromEntries(new FormData(bookingForm));

  try {
    const fb = await withTimeout(getFirebase(), "Firebase SDK did not load. Check your internet and try again.");

    if (!fb) {
      saveLocalBooking(data);
      bookingStatus.textContent = "⚠ Saved locally (Firebase not configured).";
      bookingForm.reset();
      return;
    }

    const db = fb.getFirestore(firebaseApp);
    await fb.addDoc(fb.collection(db, "bookings"), {
      ...data,
      createdAt: fb.serverTimestamp(),
      status: "Pending"
    });

    bookingStatus.textContent = "✅ Booking submitted! Admin will confirm your slot soon.";
    bookingStatus.style.color = "#0f6b37";
    bookingForm.reset();
    setTimeout(() => closeBookingModal(), 2200);

  } catch (err) {
    console.error(err);
    saveLocalBooking(data);
    bookingStatus.textContent = "⚠ " + friendlyError(err);
    bookingStatus.style.color = "#d91f52";
  } finally {
    bookingSubmitBtn.disabled = false;
    bookingSubmitBtn.textContent = "Submit Booking";
  }
});

// ─── Local fallback ───────────────────────────────────────────────────────────
function saveLocalBooking(data) {
  try {
    const key = "decorMySpaceBookings";
    const arr = JSON.parse(localStorage.getItem(key) || "[]");
    arr.unshift({ ...data, id: crypto.randomUUID?.() || String(Date.now()), createdAt: new Date().toISOString() });
    localStorage.setItem(key, JSON.stringify(arr.slice(0, 50)));
  } catch (e) { console.warn("localStorage failed", e); }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function formatMoney(n) { return `Rs. ${Number(n || 0).toLocaleString("en-IN")}`; }

function friendlyError(err) {
  const m = err?.message || String(err);
  if (m.includes("permission-denied"))
    return "Firestore rules blocked this. Update rules in Firebase Console → Firestore → Rules (see README).";
  if (m.includes("Firebase: Error") || m.includes("FirebaseError"))
    return m.replace("Firebase: ", "");
  return `Error: ${m}`;
}

// ─── Mobile hamburger (same behavior as the home page nav) ────────────────────
const hamburgerBtn = document.querySelector("#hamburgerBtn");
const navCloseBtn  = document.querySelector("#navCloseBtn");
hamburgerBtn?.addEventListener("click", () => {
  const open = document.documentElement.classList.toggle("nav-open");
  hamburgerBtn.setAttribute("aria-expanded", String(open));
});
navCloseBtn?.addEventListener("click", () => {
  document.documentElement.classList.remove("nav-open");
  hamburgerBtn?.setAttribute("aria-expanded", "false");
});