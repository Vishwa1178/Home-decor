"use strict";

const bookingService = require("../services/bookings.service");
const { createBookingSchema } = require("../schemas/booking.schema");
const { ValidationError, zodIssues } = require("../utils/errors");
const logger = require("../utils/logger");

// Fields only the server may set.
const CLIENT_FORBIDDEN_FIELDS = [
  "packagePrice", "price", "amount", "totalAmount", "requiredAmount", "remainingAmount", "paidAmount",
  "payableAmount", "paymentStatus", "payment", "status", "razorpayOrderId", "razorpayPaymentId", "razorpaySignature",
];

function parseBooking(body) {
  const result = createBookingSchema.safeParse(body ?? {});
  if (!result.success) throw new ValidationError(zodIssues(result.error));

  // The server prices from the catalog. Client-supplied money or payment-state fields
  // are ignored, but flag it: it means a stale page or tampering.
  const ignored = CLIENT_FORBIDDEN_FIELDS.filter((k) => body && body[k] !== undefined);
  if (ignored.length) logger.warn(`Ignored client-supplied fields [${ignored.join(", ")}] (requestId=${result.data.requestId})`);
  return result.data;
}

// 201 when the booking was created, 200 when the same requestId was replayed.
exports.createBooking = async (req, res) => {
  const { booking, created } = await bookingService.createBooking(parseBooking(req.body));
  res.set("Cache-Control", "no-store");
  if (!created) res.set("Idempotent-Replay", "true");
  res.status(created ? 201 : 200).json({ booking });
};

// Dry run: validates and prices a booking without writing anything.
exports.validateBooking = async (req, res) => {
  const input = parseBooking(req.body);
  const quote = await bookingService.previewBooking(input);
  res.set("Cache-Control", "no-store").json({ ok: true, quote });
};
