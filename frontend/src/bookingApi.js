// Client for POST /api/bookings. The browser never writes to Firestore and never
// sends a price: it sends a packageId and the customer's details, and the server
// prices the booking from the catalog.

export class BookingError extends Error {
  // code: server error code (VALIDATION_ERROR, PACKAGE_NOT_FOUND, RATE_LIMITED, ...)
  //       or NETWORK_ERROR / TIMEOUT / NO_API for failures before a response.
  constructor({ code, message, status = 0, issues = [] }) {
    super(message);
    this.name = "BookingError";
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

// Only these fields are ever sent. The customer chooses WHAT (a package, HALF or FULL,
// a method); there is deliberately no amount, total, status or provider field.
const BOOKING_FIELDS = [
  "packageId", "name", "phone", "email", "occasion", "date", "slotId",
  "balloonColor", "address", "notes", "paymentOption", "paymentMethod",
];

export function pickBookingFields(data) {
  const out = {};
  for (const key of BOOKING_FIELDS) if (data[key] !== undefined) out[key] = data[key];
  return out;
}

export function newRequestId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // Fallback for non-secure contexts: RFC 4122 v4 from getRandomValues.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Idempotency: retrying the SAME submission (e.g. after a timeout, when the first
// attempt may have succeeded) must reuse the same requestId so the server can
// de-duplicate. Changing any field starts a new booking with a new requestId.
export function createAttemptTracker() {
  let last = null;
  return {
    requestIdFor(payload) {
      const fingerprint = JSON.stringify(Object.keys(payload).sort().map(k => [k, payload[k]]));
      if (!last || last.fingerprint !== fingerprint) last = { fingerprint, requestId: newRequestId() };
      return last.requestId;
    },
    reset() { last = null; },
  };
}

// Resolves { booking, replay } on 201/200. Rejects with BookingError otherwise.
export async function submitBooking(baseUrl, payload, requestId, { timeoutMs = 30000, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new BookingError({ code: "NO_API", message: "Booking service is not configured" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...pickBookingFields(payload), requestId }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new BookingError({
      code: err?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR",
      message: "Could not reach the booking service",
    });
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }

  if (res.ok) return { booking: json.booking, replay: res.status === 200 };
  throw new BookingError({
    status: res.status,
    code: json?.code || "HTTP_ERROR",
    message: json?.message || `Booking failed (${res.status})`,
    issues: json?.issues || [],
  });
}

// "Amount to pay: Rs. 5,000 of Rs. 10,000" from the server's booking receipt. Never
// says anything was paid: at this stage nothing has been charged.
export function describeAmountDue(payment, formatMoney) {
  const due = formatMoney(payment.requiredAmount);
  return payment.remainingAmount > 0
    ? `Amount to pay: ${due} of ${formatMoney(payment.totalAmount)}.`
    : `Amount to pay: ${due}.`;
}

// Customer-facing wording for a failed booking.
export function bookingErrorMessage(err) {
  switch (err.code) {
    case "VALIDATION_ERROR": return err.issues[0]?.message || "Please check the form and try again.";
    case "PACKAGE_NOT_FOUND":
    case "PACKAGE_INACTIVE": return "This package is no longer available. Please choose another.";
    case "RATE_LIMITED": return "Too many booking attempts. Please wait a few minutes and try again.";
    case "SLOT_FULL": return "That time was just booked by someone else. Please choose another time.";
    case "SLOT_NOT_FOUND":
    case "SLOT_UNAVAILABLE": return "That time is no longer available. Please choose another time.";
    case "IDEMPOTENCY_KEY_REUSED": return "Something changed while submitting. Please press Submit again.";
    case "NETWORK_ERROR":
    case "TIMEOUT":
    case "NO_API":
    case "SERVICE_UNAVAILABLE": return "We couldn't reach the booking service. Please try again in a moment.";
    default: return "Something went wrong. Please try again.";
  }
}
