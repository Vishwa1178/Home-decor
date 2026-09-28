"use strict";

const { z } = require("zod");
const { BOOKING_STATUSES } = require("../constants/booking");
const { PAYMENT_OPTIONS, PAYMENT_STATUSES, PAYMENT_METHODS } = require("../constants/payment");
const { bookingDate } = require("./booking.schema");
const { packageSchema } = require("./catalog.schema");
const { slotSchema, slotId } = require("./slot.schema");
const { isRealDate } = require("../utils/dates");

// Input schemas for the admin API. Bodies are .strict(): an unknown field is a 400, not
// silently ignored, so a typo never looks like a successful edit.

// Query strings arrive as strings; the UI may send empty values for "no filter".
const blankToUndefined = (v) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = (schema) => z.preprocess(blankToUndefined, schema.optional());

// Any real calendar date (filters may look at the past, unlike booking dates).
const anyDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").refine(isRealDate, "must be a real calendar date");
const idParam = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, "invalid id");

const listBookingsQuery = z
  .object({
    limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(50).default(20)),
    cursor: opt(z.string().max(400)),
    sort: z.preprocess(blankToUndefined, z.enum(["newest", "upcoming"]).default("newest")),
    status: opt(z.enum(BOOKING_STATUSES)),
    paymentStatus: opt(z.enum(PAYMENT_STATUSES)),
    paymentOption: opt(z.enum(PAYMENT_OPTIONS)),
    paymentMethod: opt(z.enum(PAYMENT_METHODS)),
    packageId: opt(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80)),
    slotId: opt(slotId),
    dateFrom: opt(anyDate),
    dateTo: opt(anyDate),
    q: opt(z.string().trim().min(1).max(100)),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.dateFrom && v.dateTo && v.dateFrom > v.dateTo) ctx.addIssue({ code: "custom", path: ["dateTo"], message: "dateTo must not be before dateFrom" });
  });

const statusBody = z
  .object({
    status: z.enum(BOOKING_STATUSES),
    reason: z.string().trim().max(500).optional(),
    expectedStatus: z.enum(BOOKING_STATUSES).optional(), // optimistic check: fails if someone else changed it first
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.status === "Cancelled" && (!v.reason || v.reason.length < 3)) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "A reason (at least 3 characters) is required to cancel a booking" });
    }
  });

const rescheduleBody = z
  .object({
    date: bookingDate,
    slotId,
    reason: z.string().trim().max(500).optional(),
    expectedDate: anyDate.optional(),
    expectedSlotId: slotId.optional(),
  })
  .strict();

// ── packages ────────────────────────────────────────────────────────────────────
const packageFields = packageSchema.omit({ id: true });

const slugify = (name) => name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

const createPackageBody = packageFields
  .partial({ description: true, image: true, active: true, featured: true, sortOrder: true })
  .extend({ id: packageSchema.shape.id.optional() })
  .strict();

// A PATCH must contain ONLY what the admin sent. Zod applies .default() even inside
// .partial(), which would silently reset description/image/featured on a price-only edit,
// so every field here has its default removed before being made optional.
const updatePackageBody = z
  .object({
    name: packageSchema.shape.name.optional(),
    category: packageSchema.shape.category.optional(),
    price: packageSchema.shape.price.optional(),
    description: packageSchema.shape.description.removeDefault().optional(),
    image: packageSchema.shape.image.removeDefault().optional(),
    active: packageSchema.shape.active.optional(),
    featured: packageSchema.shape.featured.removeDefault().optional(),
    sortOrder: packageSchema.shape.sortOrder.optional(),
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "expectedUpdatedAt"), "Nothing to update");

// ── slots ───────────────────────────────────────────────────────────────────────
const createSlotBody = slotSchema
  .omit({ id: true })
  .partial({ label: true, enabled: true, days: true, sortOrder: true })
  .strict();

const updateSlotBody = z
  .object({
    label: slotSchema.shape.label.optional(),
    capacity: slotSchema.shape.capacity.optional(),
    enabled: z.boolean().optional(),
    days: slotSchema.shape.days.optional(),
    sortOrder: z.number().int().optional(),
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "expectedUpdatedAt"), "Nothing to update");

const dateParam = anyDate;
const blockBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();
const rangeQuery = z
  .object({ from: anyDate, to: anyDate })
  .strict()
  .superRefine((v, ctx) => {
    if (v.from > v.to) ctx.addIssue({ code: "custom", path: ["to"], message: "to must not be before from" });
    const days = (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000;
    if (days > 400) ctx.addIssue({ code: "custom", path: ["to"], message: "range is limited to 400 days" });
  });

const auditQuery = z
  .object({
    limit: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100).default(20)),
    cursor: opt(z.string().max(400)),
    entityType: opt(z.enum(["booking", "package", "slot", "blockedDate"])),
    entityId: opt(z.string().max(100)),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.entityId && !v.entityType) ctx.addIssue({ code: "custom", path: ["entityType"], message: "entityType is required with entityId" });
  });

module.exports = {
  idParam, dateParam, slugify, listBookingsQuery, statusBody, rescheduleBody, createPackageBody, updatePackageBody,
  createSlotBody, updateSlotBody, blockBody, rangeQuery, auditQuery,
};
