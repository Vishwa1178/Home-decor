"use strict";

const { z } = require("zod");
const { env } = require("../config/env");
const { todayInTimezone, isRealDate, addDays } = require("../utils/dates");
const clock = require("../utils/clock");
const { PAYMENT_OPTIONS, PAYMENT_METHODS } = require("../constants/payment");

// Values offered by the booking form today.
const OCCASIONS = ["Birthday", "Anniversary", "Baby Shower", "House Warming", "Engagement", "Festival", "Custom"];

// Bookings further out than this are rejected as obvious junk.
const MAX_DAYS_AHEAD = 730;

// Empty strings from HTML forms mean "not provided".
const optional = (schema) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

// A calendar date, not in the past (business timezone), at most MAX_DAYS_AHEAD days ahead.
// Shared by the booking body and the availability query.
const bookingDate = z
  .string({ error: "Date is required" })
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .superRefine((value, ctx) => {
      if (!isRealDate(value)) {
        ctx.addIssue({ code: "custom", message: "Enter a real calendar date" });
        return;
      }
      const today = todayInTimezone(env.BUSINESS_TIMEZONE, clock.now());
      if (value < today) ctx.addIssue({ code: "custom", message: "Date cannot be in the past" });
      else if (value > addDays(today, MAX_DAYS_AHEAD)) ctx.addIssue({ code: "custom", message: "Date is too far ahead" });
    });

// Everything the client may send. The client chooses WHAT (a package, HALF or FULL,
// a method); the server decides HOW MUCH. Unknown keys are stripped and never used,
// notably totalAmount, requiredAmount, remainingAmount, paidAmount, paymentStatus,
// razorpay* and any price.
const createBookingSchema = z.object({
  requestId: z.uuid({ version: "v4", error: "requestId must be a UUID v4" }),
  packageId: z
    .string({ error: "packageId is required" })
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "packageId is invalid")
    .max(80, "packageId is invalid"),

  name: z.string({ error: "Name is required" }).trim().min(2, "Name must be at least 2 characters").max(100, "Name is too long"),
  phone: z
    .string({ error: "Phone is required" })
    .trim()
    .transform((v) => v.replace(/[\s\-()]/g, ""))
    .pipe(z.string().regex(/^\+?\d{10,15}$/, "Enter a valid phone number (10 to 15 digits)")),
  email: optional(z.string().trim().toLowerCase().max(254, "Email is too long").pipe(z.email("Enter a valid email address"))),

  occasion: optional(z.enum(OCCASIONS, { error: "Unknown decoration type" })),
  date: bookingDate,
  // The customer picks one of the slots the backend offers (GET /api/availability).
  // A free-form `time` is no longer accepted: it is ignored like any unknown field.
  slotId: z.string({ error: "Choose a time slot" }).trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slotId is invalid").max(40, "slotId is invalid"),

  balloonColor: optional(z.string().trim().max(100, "Balloon color is too long")),
  address: z.string({ error: "Address is required" }).trim().min(5, "Address is too short").max(500, "Address is too long"),
  notes: optional(z.string().trim().max(1000, "Notes are too long")),

  // Exact, case-sensitive values. No default: the customer must choose.
  paymentOption: z.enum(PAYMENT_OPTIONS, { error: "paymentOption must be HALF or FULL" }),
  paymentMethod: z.enum(PAYMENT_METHODS, { error: "paymentMethod must be RAZORPAY, CASH or UPI" }),
});

module.exports = { createBookingSchema, bookingDate, OCCASIONS, MAX_DAYS_AHEAD };
