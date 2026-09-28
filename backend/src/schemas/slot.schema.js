"use strict";

const { z } = require("zod");

// Shape of slot documents in Firestore. Slot configuration (`slots/{id}`) is what an
// admin will edit: add/edit a slot, enable/disable it, set capacity, choose weekdays.
// Blocked dates (`blockedDates/{YYYY-MM-DD}`) close every slot for a whole date.

const slotId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase letters, digits and single hyphens")
  .max(40);

const slotSchema = z.object({
  id: slotId,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM (24 hour)"),
  label: z.string().trim().min(1).max(30), // what the customer sees, e.g. "10:00 AM"
  capacity: z.number().int().min(1).max(100), // bookings allowed per date for this slot
  enabled: z.boolean(),
  // Weekdays the slot runs on: 0 = Sunday ... 6 = Saturday.
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7)
    .refine((d) => new Set(d).size === d.length, "days must not repeat"),
  sortOrder: z.number().int(),
});

const slotSeedSchema = z.object({ slots: z.array(slotSchema).min(1) });

const slotDocSchema = slotSchema.omit({ id: true });

const blockedDateDocSchema = z.object({
  reason: z.string().trim().max(200).default(""),
});

module.exports = { slotId, slotSchema, slotSeedSchema, slotDocSchema, blockedDateDocSchema };
