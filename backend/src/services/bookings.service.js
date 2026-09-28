"use strict";

// Canonical list of packages surfaced to the frontend.
// Kept server-side so pricing can be managed without a redeploy of the SPA.
const PACKAGES = [
  { id: "birthday", name: "Birthday Decor", price: 2499 },
  { id: "anniversary", name: "Anniversary Decor", price: 2999 },
  { id: "baby-shower", name: "Baby Shower Decor", price: 3499 },
  { id: "house-warming", name: "House Warming Decor", price: 3999 },
  { id: "engagement", name: "Engagement Decor", price: 4999 },
  { id: "festival", name: "Festival Decor", price: 2799 },
];

function listPackages() {
  return PACKAGES;
}

function validateBookingPayload(body) {
  const issues = [];
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const email = String(body.email || "").trim();
  const date = String(body.date || "").trim();
  const packageId = String(body.packageId || "").trim();

  if (name.length < 2) issues.push({ field: "name", message: "Name is required" });
  if (!/^\+?[0-9\s-]{7,}$/.test(phone)) issues.push({ field: "phone", message: "Valid phone required" });
  if (email && !/^\S+@\S+\.\S+$/.test(email)) issues.push({ field: "email", message: "Invalid email" });
  if (!date || Number.isNaN(Date.parse(date))) issues.push({ field: "date", message: "Valid date required" });
  if (!PACKAGES.some((p) => p.id === packageId)) issues.push({ field: "packageId", message: "Unknown package" });

  if (issues.length) return { ok: false, issues };
  return { ok: true, data: { name, phone, email, date, packageId } };
}

module.exports = { listPackages, validateBookingPayload };
