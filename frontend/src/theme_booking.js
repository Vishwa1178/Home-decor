// ─── Booking + nav logic for the standalone theme pages ───────────────────────
// (frontend/src/themes/birthday.html, anniversary.html, babyshower.html,
//  engagement.html, festival.html, housewarming.html)
//
// Theme pages don't need the SPA router or admin dashboard, just the
// "pick a decor type -> book it" flow, which lives in bookingModal.js (shared with
// the home page). Prices come from the central catalog; bookings go to the API.

import { initBookingModal } from "./bookingModal.js";

initBookingModal({ selectedCardSelector: ".theme-card" });

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
