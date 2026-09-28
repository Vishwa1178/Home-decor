"use strict";

const firebaseAdmin = require("../config/firebaseAdmin");
const { env } = require("../config/env");
const { AppError } = require("../utils/errors");
const logger = require("../utils/logger");
const { categoryDocSchema, packageDocSchema } = require("../schemas/catalog.schema");
const { quotesFor } = require("../utils/pricing");

// The catalog lives in Firestore (`categories/{id}`, `packages/{id}`) so it can be
// edited by an admin without a deploy. Firestore is the single source of truth;
// backend/data/catalog.seed.json only seeds it (scripts/seed-catalog.js).

let cache = { at: 0, value: null };
let inflight = null;

const bySortThenName = (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

// Shape sent to browsers. Only what the storefront needs; never internal fields.
function toPublicPackage(id, data) {
  return {
    id,
    name: data.name,
    category: data.category,
    price: data.price,
    // What the customer would pay under each option, calculated by the server
    // (the storefront only displays these numbers).
    paymentOptions: quotesFor(data.price),
    description: data.description,
    image: data.image,
    featured: data.featured,
    sortOrder: data.sortOrder,
  };
}

// Reads and validates one package document snapshot. Returns null when the doc is
// missing or corrupt (a corrupt catalog entry must never become a price).
function parsePackageSnapshot(snap) {
  if (!snap.exists) return null;
  const parsed = packageDocSchema.safeParse(snap.data());
  if (!parsed.success) {
    logger.error(`Invalid package document "${snap.id}", ignoring it`, parsed.error.issues);
    return null;
  }
  return { id: snap.id, ...parsed.data };
}

async function loadCatalog() {
  const db = firebaseAdmin.getDb();
  const [categorySnap, packageSnap] = await Promise.all([
    db.collection("categories").where("active", "==", true).get(),
    db.collection("packages").where("active", "==", true).get(),
  ]);

  const categories = [];
  for (const doc of categorySnap.docs) {
    const parsed = categoryDocSchema.safeParse(doc.data());
    if (parsed.success) categories.push({ id: doc.id, ...parsed.data });
    else logger.error(`Invalid category document "${doc.id}", ignoring it`, parsed.error.issues);
  }

  const packages = packageSnap.docs.map(parsePackageSnapshot).filter(Boolean);

  return {
    currency: "INR",
    categories: categories
      .sort(bySortThenName)
      .map(({ id, name, description, sortOrder }) => ({ id, name, description, sortOrder })),
    packages: packages.sort(bySortThenName).map((p) => toPublicPackage(p.id, p)),
  };
}

// Public catalog: active categories and packages only. Cached briefly in memory;
// bookings do NOT use this cache (see bookings.service).
async function getCatalog() {
  const ttl = env.CATALOG_CACHE_TTL_MS;
  if (ttl > 0 && cache.value && Date.now() - cache.at < ttl) return cache.value;

  // Share one Firestore read between concurrent requests.
  inflight ??= loadCatalog()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });

  try {
    return await inflight;
  } catch (err) {
    logger.error("Catalog load failed", err);
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Catalog is temporarily unavailable");
  }
}

// One package, read fresh from Firestore. Inactive packages count as not found.
async function getActivePackage(id) {
  try {
    const pkg = parsePackageSnapshot(await firebaseAdmin.getDb().collection("packages").doc(id).get());
    return pkg && pkg.active ? pkg : null;
  } catch (err) {
    logger.error(`Package lookup failed for "${id}"`, err);
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Catalog is temporarily unavailable");
  }
}

function clearCache() {
  cache = { at: 0, value: null };
}

module.exports = { getCatalog, getActivePackage, parsePackageSnapshot, toPublicPackage, clearCache };
