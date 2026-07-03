"use strict";

const { Router } = require("express");
const asyncHandler = require("../utils/asyncHandler");
const bookingsController = require("../controllers/bookings.controller");

const router = Router();

// Metadata endpoint kept server-side so the frontend can fetch package
// definitions without depending on hard-coded client data.
router.get("/packages", asyncHandler(bookingsController.listPackages));

// Lightweight validation endpoint used by the booking form before it
// writes to Firestore from the client SDK.
router.post("/validate", asyncHandler(bookingsController.validateBooking));

module.exports = router;
