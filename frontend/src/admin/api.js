// Client for the admin API (/api/admin/*). Every call sends the signed-in user's Firebase ID
// token; the SERVER verifies it and the admin claim on every request. Nothing here decides
// who is an admin, and nothing here reads Firestore: the dashboard only ever asks the API
// for one bounded page at a time.

export class AdminApiError extends Error {
  // code: the server's error code, or NO_API / NETWORK_ERROR / TIMEOUT / AUTH for failures
  // that happen before a response.
  constructor({ status = 0, code, message, issues = [] }) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

// Drops empty values so "no filter" is never sent.
export function toQueryString(query = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && String(v).trim() !== "") params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function createAdminApi({ baseUrl, getIdToken, fetchImpl = fetch, timeoutMs = 30000 }) {
  async function request(method, path, { query, body } = {}) {
    if (!baseUrl) throw new AdminApiError({ code: "NO_API", message: "The API address is not configured" });

    let token;
    try {
      token = await getIdToken();
    } catch {
      throw new AdminApiError({ status: 401, code: "AUTH", message: "You are signed out. Please sign in again." });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/api/admin${path}${toQueryString(query)}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new AdminApiError({ code: err?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR", message: "Could not reach the server. Check your connection and try again." });
    } finally {
      clearTimeout(timer);
    }

    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    if (res.ok) return json;
    throw new AdminApiError({ status: res.status, code: json?.code || "HTTP_ERROR", message: json?.message || `Request failed (${res.status})`, issues: json?.issues || [] });
  }

  const enc = encodeURIComponent;
  return {
    request,
    me: () => request("GET", "/me"),
    stats: () => request("GET", "/stats"),
    listBookings: (query) => request("GET", "/bookings", { query }),
    getBooking: (id) => request("GET", `/bookings/${enc(id)}`),
    setStatus: (id, body) => request("PATCH", `/bookings/${enc(id)}/status`, { body }),
    reschedule: (id, body) => request("POST", `/bookings/${enc(id)}/reschedule`, { body }),
    catalog: () => request("GET", "/catalog"),
    createPackage: (body) => request("POST", "/packages", { body }),
    updatePackage: (id, body) => request("PATCH", `/packages/${enc(id)}`, { body }),
    slots: () => request("GET", "/slots"),
    createSlot: (body) => request("POST", "/slots", { body }),
    updateSlot: (id, body) => request("PATCH", `/slots/${enc(id)}`, { body }),
    blockedDates: (from, to) => request("GET", "/blocked-dates", { query: { from, to } }),
    blockDate: (date, reason) => request("PUT", `/blocked-dates/${enc(date)}`, { body: reason ? { reason } : {} }),
    unblockDate: (date) => request("DELETE", `/blocked-dates/${enc(date)}`),
    occupancy: (from, to) => request("GET", "/slots/occupancy", { query: { from, to } }),
    audit: (query) => request("GET", "/audit", { query }),
  };
}
