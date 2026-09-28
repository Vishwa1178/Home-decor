// Client for the central package catalog (GET /api/packages).
//
// The catalog lives in the backend (Firestore). Pages no longer carry prices in
// `data-price` attributes: buttons/cards only say WHICH package they mean
// (`data-package-id`) and price labels say which package they show
// (`data-price-of`). Everything the customer sees is filled in from the catalog.

// Containers that represent one bookable package on a page (hidden when the
// package is disabled in the catalog).
const CARD_SELECTOR = ".theme-card, .package-card, .occasion-card, .nav-dropdown a, .mnav-quick-thumb";

export function formatMoney(n) {
  return `Rs. ${Number(n || 0).toLocaleString("en-IN")}`;
}

// Loads the public catalog. Rejects on network errors, timeouts and bad responses,
// so callers can distinguish "catalog unavailable" from "package not in catalog".
export async function loadCatalog(baseUrl, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error("VITE_API_URL is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/api/packages`, { signal: controller.signal, cache: "no-cache" });
    if (!res.ok) throw new Error(`Catalog request failed (${res.status})`);
    const catalog = await res.json();
    if (!catalog || !Array.isArray(catalog.packages)) throw new Error("Catalog response is malformed");
    return {
      ...catalog,
      byId: new Map(catalog.packages.map(p => [p.id, p])),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Fills price labels from the catalog and hides packages that are not in it
// (disabled by an admin). Only call with a successfully loaded catalog: if the
// catalog could not be loaded, leave the page as it is.
export function applyCatalog(root, catalog) {
  root.querySelectorAll("[data-price-of]").forEach(el => {
    const pkg = catalog.byId.get(el.dataset.priceOf);
    if (pkg) el.textContent = `${el.dataset.pricePrefix || ""}${formatMoney(pkg.price)}`;
  });

  root.querySelectorAll("[data-package-id]").forEach(el => {
    const card = el.closest?.(CARD_SELECTOR) ?? el;
    card.hidden = !catalog.byId.has(el.dataset.packageId);
  });
}
