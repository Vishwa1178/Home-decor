"use strict";

const { Router } = require("express");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const asyncHandler = require("../utils/asyncHandler");
const adminController = require("../controllers/admin.controller");
const bookings = require("../controllers/adminBookings.controller");
const catalog = require("../controllers/adminCatalog.controller");
const slots = require("../controllers/adminSlots.controller");

const router = Router();

// EVERY admin route is authenticated (Firebase ID token verified server-side) and
// admin-authorized (the `admin` custom claim in that verified token) here, in one place,
// before any handler runs. Nothing below trusts anything the browser says about who it is.
router.use(requireAuth, requireAdmin);

router.get("/me", adminController.getMe);

// Bookings: paginated reads, and the mutations (each writes an audit entry in its transaction).
router.get("/stats", asyncHandler(bookings.stats));
router.get("/bookings", asyncHandler(bookings.list));
router.get("/bookings/:id", asyncHandler(bookings.get));
router.patch("/bookings/:id/status", asyncHandler(bookings.setStatus));
router.post("/bookings/:id/reschedule", asyncHandler(bookings.reschedule));

// Packages (no delete: disable instead).
router.get("/catalog", asyncHandler(catalog.list));
router.post("/packages", asyncHandler(catalog.create));
router.patch("/packages/:id", asyncHandler(catalog.update));

// Slots, blocked dates and booked capacity (no delete: disable instead).
router.get("/slots", asyncHandler(slots.list));
router.post("/slots", asyncHandler(slots.create));
router.get("/slots/occupancy", asyncHandler(slots.occupancy));
router.patch("/slots/:id", asyncHandler(slots.update));
router.get("/blocked-dates", asyncHandler(slots.listBlocked));
router.put("/blocked-dates/:date", asyncHandler(slots.block));
router.delete("/blocked-dates/:date", asyncHandler(slots.unblock));

// The audit trail (read-only: there is no route that edits or deletes entries).
router.get("/audit", asyncHandler(bookings.auditLog));

module.exports = router;
