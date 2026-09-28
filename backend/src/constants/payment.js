"use strict";

// What the customer chooses at booking time.
const PAYMENT_OPTIONS = Object.freeze(["HALF", "FULL"]);

// Where a booking's payment stands. Everything starts as PENDING; nothing in the
// app moves it (no payment provider is integrated yet).
const PAYMENT_STATUSES = Object.freeze(["PENDING", "PARTIALLY_PAID", "PAID", "FAILED", "REFUNDED"]);

// How the customer intends to pay.
const PAYMENT_METHODS = Object.freeze(["RAZORPAY", "CASH", "UPI"]);

const CURRENCY = "INR";

module.exports = { PAYMENT_OPTIONS, PAYMENT_STATUSES, PAYMENT_METHODS, CURRENCY };
