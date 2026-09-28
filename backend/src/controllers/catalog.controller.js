"use strict";

const catalogService = require("../services/catalog.service");
const { AppError } = require("../utils/errors");

// Browsers must revalidate on every request (cheap 304s via the ETag Express adds),
// never serve a stale copy: a customer must not see an old price or a disabled
// package. Server load is bounded by the in-memory cache in catalog.service.
// Bookings never trust any of this: they re-read the package price on the server.
const CACHE_CONTROL = "no-cache";

exports.listPackages = async (_req, res) => {
  const catalog = await catalogService.getCatalog();
  res.set("Cache-Control", CACHE_CONTROL).json(catalog);
};

exports.getPackage = async (req, res) => {
  const pkg = await catalogService.getActivePackage(req.params.id);
  if (!pkg) throw new AppError(404, "PACKAGE_NOT_FOUND", "Package not found");
  res.set("Cache-Control", CACHE_CONTROL).json({ package: catalogService.toPublicPackage(pkg.id, pkg) });
};
