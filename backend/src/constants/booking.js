"use strict";

// Booking lifecycle. Payment state is separate (constants/payment.js).
const BOOKING_STATUSES = Object.freeze(["Pending", "Confirmed", "Cancelled"]);

module.exports = { BOOKING_STATUSES };
