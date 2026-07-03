"use strict";

const bookingService = require("../services/bookings.service");

exports.listPackages = async (_req, res) => {
  const packages = await bookingService.listPackages();
  res.json({ packages });
};

exports.validateBooking = async (req, res) => {
  const result = bookingService.validateBookingPayload(req.body || {});
  if (!result.ok) {
    res.status(400).json({ error: "ValidationError", issues: result.issues });
    return;
  }
  res.json({ ok: true, normalized: result.data });
};
