"use strict";

const { Router } = require("express");
const asyncHandler = require("../utils/asyncHandler");
const bookingsController = require("../controllers/bookings.controller");
const catalogController = require("../controllers/catalog.controller");
const { bookingLimiter, catalogLimiter } = require("../middleware/rateLimit");

const router = Router();

// Create a booking (idempotent on `requestId`). The only way bookings are written.
router.post("/", bookingLimiter, asyncHandler(bookingsController.createBooking));

// Dry run: same validation and pricing as POST /, writes nothing.
router.post("/validate", bookingLimiter, asyncHandler(bookingsController.validateBooking));

// Kept for compatibility: same response as GET /api/packages (the one catalog).
router.get("/packages", catalogLimiter, asyncHandler(catalogController.listPackages));

module.exports = router;
