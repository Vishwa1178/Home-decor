"use strict";

const { z } = require("zod");
const slotsService = require("../services/slots.service");
const { bookingDate } = require("../schemas/booking.schema");
const { ValidationError, zodIssues } = require("../utils/errors");

const querySchema = z.object({ date: bookingDate });

// GET /api/availability?date=YYYY-MM-DD
exports.getAvailability = async (req, res) => {
  const parsed = querySchema.safeParse({ date: req.query.date });
  if (!parsed.success) throw new ValidationError(zodIssues(parsed.error), "A valid date is required");

  const availability = await slotsService.getAvailability(parsed.data.date);
  // Capacity changes with every booking: never cache.
  res.set("Cache-Control", "no-store").json(availability);
};
