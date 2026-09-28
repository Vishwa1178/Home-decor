"use strict";

// Seed script + catalog API against the real Firestore emulator.

const helpers = require("./helpers");
helpers.setupEnv({ CATALOG_CACHE_TTL_MS: "0" });

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const app = require("../../src/app");
const { getDb } = require("../../src/config/firebaseAdmin");

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "catalog.seed.json"), "utf8"));
let srv;
const get = (p) => fetch(srv.base + p);

before(async () => {
  await helpers.clearFirestore();
  srv = await helpers.listen(app);
});
after(() => srv.close());

describe("seed script", () => {
  test("--dry-run writes nothing", async () => {
    const r = helpers.runScript("seed-catalog.js", "--dry-run");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[dry run\].*created: 39/);
    assert.equal((await getDb().collection("packages").get()).size, 0);
  });

  test("first run creates 7 categories + 32 packages", () => {
    const r = helpers.runScript("seed-catalog.js");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /categories: 7, packages: 32 \| created: 39, overwritten: 0, left unchanged: 0/);
  });

  test("re-run leaves everything unchanged and never clobbers admin edits", async () => {
    await getDb().collection("packages").doc("birthday-decor").update({ price: 1111, description: "edited by admin" });
    const r = helpers.runScript("seed-catalog.js");
    assert.match(r.stdout, /created: 0, overwritten: 0, left unchanged: 39/);
    const doc = (await getDb().collection("packages").doc("birthday-decor").get()).data();
    assert.equal(doc.price, 1111);
    assert.equal(doc.description, "edited by admin");
  });

  test("--overwrite deliberately resets to the seed values", async () => {
    const r = helpers.runScript("seed-catalog.js", "--overwrite");
    assert.match(r.stdout, /overwritten: 39/);
    const doc = (await getDb().collection("packages").doc("birthday-decor").get()).data();
    assert.equal(doc.price, 999);
    assert.equal(doc.description, "");
  });
});

describe("GET /api/packages", () => {
  test("returns the full seeded catalog with the existing prices", async () => {
    const res = await get("/api/packages");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.ok(res.headers.get("etag"), "ETag lets browsers revalidate cheaply");
    const body = await res.json();

    assert.equal(body.currency, "INR");
    assert.ok(!("advanceAmount" in body), "the flat advance amount is retired");
    assert.equal(body.packages.length, 32);
    assert.equal(body.categories.length, 7);

    const byId = Object.fromEntries(body.packages.map((p) => [p.id, p]));
    for (const s of seed.packages) {
      assert.equal(byId[s.id].price, s.price, s.id);
      assert.equal(byId[s.id].name, s.name, s.id);
      assert.equal(byId[s.id].category, s.category, s.id);
    }
    // spot checks against the prices the site showed before this phase
    assert.equal(byId["birthday-decor"].price, 999);
    assert.equal(byId["balloon-decor"].price, 899);
    assert.equal(byId["reception-stage"].price, 4999);
    assert.equal(byId["luxury-balloon-canopy-decor"].price, 3499);
  });

  test("public shape only: no active flag, timestamps or internals", async () => {
    const { packages } = await (await get("/api/packages")).json();
    for (const p of packages) {
      assert.deepEqual(Object.keys(p).sort(), ["category", "description", "featured", "id", "image", "name", "paymentOptions", "price", "sortOrder"]);
    }
  });

  test("every package carries server-calculated HALF/FULL quotes", async () => {
    const { packages } = await (await get("/api/packages")).json();
    for (const p of packages) {
      assert.deepEqual(Object.keys(p.paymentOptions).sort(), ["FULL", "HALF"]);
      assert.deepEqual(p.paymentOptions.FULL, { totalAmount: p.price, requiredAmount: p.price, remainingAmount: 0 });
      const h = p.paymentOptions.HALF;
      assert.equal(h.totalAmount, p.price);
      assert.equal(h.requiredAmount, Math.ceil(p.price / 2));
      assert.equal(h.requiredAmount + h.remainingAmount, p.price);
    }
    const bd = packages.find((p) => p.id === "birthday-decor");
    assert.deepEqual(bd.paymentOptions.HALF, { totalAmount: 999, requiredAmount: 500, remainingAmount: 499 });
  });

  test("a price edit changes the quotes too", async () => {
    await getDb().collection("packages").doc("balloon-decor").update({ price: 10000 });
    const p = (await (await get("/api/packages")).json()).packages.find((x) => x.id === "balloon-decor");
    assert.deepEqual(p.paymentOptions.HALF, { totalAmount: 10000, requiredAmount: 5000, remainingAmount: 5000 });
    assert.deepEqual(p.paymentOptions.FULL, { totalAmount: 10000, requiredAmount: 10000, remainingAmount: 0 });
    await getDb().collection("packages").doc("balloon-decor").update({ price: 899 });
  });

  test("sorted by sortOrder; every package's category is in the categories list", async () => {
    const { packages, categories } = await (await get("/api/packages")).json();
    const catIds = new Set(categories.map((c) => c.id));
    assert.ok(packages.every((p) => catIds.has(p.category)));
    const orders = packages.map((p) => p.sortOrder);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  });

  test("legacy alias /api/bookings/packages returns the same catalog", async () => {
    const a = await (await get("/api/packages")).json();
    const b = await (await get("/api/bookings/packages")).json();
    assert.deepEqual(a, b);
  });
});

describe("browser revalidation", () => {
  // Node's fetch() adds `Cache-Control: no-cache` to conditional requests, which
  // makes Express skip the 304. Browsers revalidate with `max-age=0`, so use raw
  // http and send exactly that.
  const conditional = (etag) =>
    new Promise((resolve, reject) => {
      const { port } = new URL(srv.base);
      http
        .get({ port, path: "/api/packages", headers: { "If-None-Match": etag, "Cache-Control": "max-age=0" } }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        })
        .on("error", reject);
    });

  test("matching ETag -> 304; after a catalog change -> 200 with fresh data", async () => {
    const etag = (await get("/api/packages")).headers.get("etag");
    assert.equal((await conditional(etag)).status, 304);

    await getDb().collection("packages").doc("balloon-decor").update({ price: 901 });
    const changed = await conditional(etag);
    assert.equal(changed.status, 200);
    assert.equal(JSON.parse(changed.body).packages.find((p) => p.id === "balloon-decor").price, 901);
    await getDb().collection("packages").doc("balloon-decor").update({ price: 899 });
  });
});

describe("admin-editable catalog (changes in Firestore show up)", () => {
  test("price change is reflected", async () => {
    await getDb().collection("packages").doc("balloon-decor").update({ price: 949 });
    const { packages } = await (await get("/api/packages")).json();
    assert.equal(packages.find((p) => p.id === "balloon-decor").price, 949);
  });

  test("disabling a package hides it from the list and the single lookup; enabling restores it", async () => {
    const ref = getDb().collection("packages").doc("pooja-setup");
    await ref.update({ active: false });
    let list = (await (await get("/api/packages")).json()).packages;
    assert.equal(list.length, 31);
    assert.ok(!list.some((p) => p.id === "pooja-setup"));
    assert.equal((await get("/api/packages/pooja-setup")).status, 404);

    await ref.update({ active: true });
    list = (await (await get("/api/packages")).json()).packages;
    assert.ok(list.some((p) => p.id === "pooja-setup"));
    assert.equal((await get("/api/packages/pooja-setup")).status, 200);
  });

  test("description and category changes are reflected; new packages appear", async () => {
    await getDb().collection("packages").doc("haldi-decor").update({ description: "Yellow florals", category: "festival" });
    await getDb().collection("packages").doc("brand-new").set({
      name: "Brand New Package", category: "custom", price: 1500, description: "", image: null,
      active: true, featured: false, sortOrder: 999,
    });
    const { packages } = await (await get("/api/packages")).json();
    const haldi = packages.find((p) => p.id === "haldi-decor");
    assert.equal(haldi.description, "Yellow florals");
    assert.equal(haldi.category, "festival");
    assert.equal(packages.find((p) => p.id === "brand-new").price, 1500);
  });

  test("a corrupt document (bad price) is ignored, never served", async () => {
    await getDb().collection("packages").doc("corrupt").set({
      name: "Corrupt", category: "custom", price: "free", description: "", image: null, active: true, featured: false, sortOrder: 1,
    });
    const { packages } = await (await get("/api/packages")).json();
    assert.ok(!packages.some((p) => p.id === "corrupt"));
  });
});

describe("GET /api/packages/:id", () => {
  test("known id", async () => {
    const res = await get("/api/packages/room-surprise");
    assert.equal(res.status, 200);
    const { package: p } = await res.json();
    assert.equal(p.price, 1299);
    assert.equal(p.name, "Room Surprise");
  });
  test("unknown id -> 404 PACKAGE_NOT_FOUND", async () => {
    const res = await get("/api/packages/does-not-exist");
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "PACKAGE_NOT_FOUND");
  });
});
