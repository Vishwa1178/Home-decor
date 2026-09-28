// Asks the backend whether the bearer of a Firebase ID token is an admin.
// The answer comes from the server (verified token + `admin` custom claim);
// the browser never decides this itself.
//
// Resolves with the profile ({ uid, email, admin: true }) on 200. Rejects with an
// Error whose `code` is one of:
//   "no-api"       API base URL not configured
//   "not-admin"    403: valid identity, but not an administrator
//   "unauthorized" 401: token missing, invalid, expired or revoked
//   "unavailable"  network error, timeout or any other status (fail closed)
export async function fetchAdminProfile(baseUrl, idToken, { timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (!baseUrl) throw fail("no-api", "VITE_API_URL is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/api/admin/me`, {
      headers: { Authorization: `Bearer ${idToken}` },
      signal: controller.signal
    });
  } catch {
    throw fail("unavailable", "Admin API unreachable");
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 200) return res.json();
  if (res.status === 403) throw fail("not-admin", "Not an administrator");
  if (res.status === 401) throw fail("unauthorized", "Token rejected");
  throw fail("unavailable", `Admin API responded ${res.status}`);
}
