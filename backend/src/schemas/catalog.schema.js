"use strict";

const { z } = require("zod");

// Shape of catalog documents in Firestore (`categories/{id}`, `packages/{id}`).
// Used by the seed script and by the catalog service when reading, and it is the
// schema the future admin create/edit endpoints should validate against.
//
// Prices are whole Indian rupees (integers).

const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase letters, digits and single hyphens")
  .max(80);

const categorySchema = z.object({
  id: slug,
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).default(""),
  active: z.boolean(),
  sortOrder: z.number().int(),
});

const packageSchema = z.object({
  id: slug,
  category: slug,
  name: z.string().trim().min(2).max(100),
  price: z.number().int().min(1).max(1_000_000),
  description: z.string().trim().max(2000).default(""),
  // http(s) only: z.url() alone also accepts javascript:, data: and file: URLs.
  image: z.url({ protocol: /^https?$/, error: "must be an http(s) URL" }).nullable().default(null),
  active: z.boolean(),
  featured: z.boolean().default(false),
  sortOrder: z.number().int(),
});

const seedSchema = z.object({
  categories: z.array(categorySchema).min(1),
  packages: z.array(packageSchema).min(1),
});

// Stored documents do not repeat the id (it is the document ID).
const categoryDocSchema = categorySchema.omit({ id: true });
const packageDocSchema = packageSchema.omit({ id: true });

module.exports = { categorySchema, packageSchema, seedSchema, categoryDocSchema, packageDocSchema };
