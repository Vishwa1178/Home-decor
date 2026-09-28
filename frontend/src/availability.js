// Slot availability, as reported by the backend (GET /api/availability?date=...).
//
// The backend is the only authority: it says which slots exist for a date, how many
// seats are left and whether each can be booked. This module only fetches that and turns
// it into <option>s. Nothing about capacity or opening times is decided in the browser,
// and the server re-checks everything when the booking is submitted.

// Rejects on network errors, timeouts and bad responses so the caller can tell
// "couldn't load" from "no times available".
export async function loadAvailability(baseUrl, date, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error("VITE_API_URL is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/api/availability?date=${encodeURIComponent(date)}`, {
      signal: controller.signal,
      cache: "no-store", // capacity changes with every booking
    });
    if (!res.ok) throw new Error(`Availability request failed (${res.status})`);
    const availability = await res.json();
    if (!availability || !Array.isArray(availability.slots)) throw new Error("Availability response is malformed");
    return availability;
  } finally {
    clearTimeout(timer);
  }
}

const UNAVAILABLE_TEXT = { FULL: "Fully booked", PAST: "Not available", BLOCKED: "Not available" };

// What the time <select> should show for one date's availability.
//   { placeholder, disabled, options: [{ value, text, disabled }] }
export function slotSelectModel(availability) {
  if (availability.blocked) {
    return { placeholder: "This date is not available", disabled: true, options: [] };
  }
  if (!availability.slots.length) {
    return { placeholder: "No times available on this date", disabled: true, options: [] };
  }

  const options = availability.slots.map(slot => {
    if (slot.available) {
      // Only mention seats when a slot can hold more than one booking.
      const left = slot.capacity > 1 ? ` (${slot.remaining} left)` : "";
      return { value: slot.id, text: `${slot.label}${left}`, disabled: false };
    }
    return { value: slot.id, text: `${slot.label} — ${UNAVAILABLE_TEXT[slot.reason] || "Not available"}`, disabled: true };
  });

  const anyAvailable = options.some(o => !o.disabled);
  return {
    placeholder: anyAvailable ? "Choose a time" : "All times are booked for this date",
    disabled: !anyAvailable,
    options,
  };
}

export function messageModel(placeholder) {
  return { placeholder, disabled: true, options: [] };
}

// Renders a model into a <select>, keeping the previous choice only if it is still bookable.
export function applySlotModel(select, model, previousValue = "") {
  const doc = select.ownerDocument;
  const placeholder = doc.createElement("option");
  placeholder.value = "";
  placeholder.textContent = model.placeholder;

  const items = model.options.map(o => {
    const el = doc.createElement("option");
    el.value = o.value;
    el.textContent = o.text;
    el.disabled = o.disabled;
    return el;
  });

  select.replaceChildren(placeholder, ...items);
  select.disabled = model.disabled;
  const keep = model.options.find(o => o.value === previousValue && !o.disabled);
  select.value = keep ? previousValue : "";
}
