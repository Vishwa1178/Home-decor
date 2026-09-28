"use strict";

// HTTP-level behaviour that needs no Firestore: error shapes, 503 mapping,
// and that Firestore failures never look like success.

process.env.NODE_ENV = "test";

const { test, describe, before, after, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const app = require("../../src/app");
const firebaseAdmin = require("../../src/config/firebaseAdmin");
const catalogService = require("../../src/services/catalog.service");
const { addDays, todayInTimezone } = require("../../src/utils/dates");

let server;
let base;
before(async () => {
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));
afterEach(() => mock.restoreAll());

const body = () => ({
  requestId: crypto.randomUUID(), packageId: "birthday-decor", name: "Asha Rao", phone: "9876543210",
  date: addDays(todayInTimezone("Asia/Kolkata"), 2), slotId: "t1000", address: "12 Lake Road", paymentOption: "HALF", paymentMethod: "UPI",
});
const post = (b, headers = {}) =>
  fetch(`${base}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof b === "string" ? b : JSON.stringify(b) });

describe("error responses share one shape", () => {
  test("validation error: 400, code, message, issues[]", async () => {
    const res = await post({});
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.equal(j.error, "ValidationError");
    assert.equal(j.code, "VALIDATION_ERROR");
    assert.ok(j.message);
    assert.ok(Array.isArray(j.issues) && j.issues.every((i) => i.field && i.message));
    assert.ok(j.issues.some((i) => i.field === "requestId"));
    assert.equal("stack" in j, false);
  });

  test("malformed JSON -> 400 INVALID_JSON, no stack, no parser internals", async () => {
    const res = await post("{bad json");
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.equal(j.code, "INVALID_JSON");
    assert.equal("stack" in j, false);
    assert.ok(!JSON.stringify(j).includes("position"));
  });

  test("oversized body -> 413 PAYLOAD_TOO_LARGE", async () => {
    const res = await post(JSON.stringify({ ...body(), notes: "x".repeat(30_000) }));
    assert.equal(res.status, 413);
    assert.equal((await res.json()).code, "PAYLOAD_TOO_LARGE");
  });

  test("unknown route -> 404 with code", async () => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "NOT_FOUND");
  });

  test("auth errors carry a code too", async () => {
    const res = await fetch(`${base}/api/admin/me`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, "UNAUTHORIZED");
  });
});

describe("Firestore failures fail closed as 503, never as success", () => {
  test("booking: transaction failure -> 503 SERVICE_UNAVAILABLE, no internal detail", async () => {
    mock.method(firebaseAdmin, "getDb", () => {
      throw new Error("Could not load the default credentials: secret-internal-detail");
    });
    const res = await post(body());
    assert.equal(res.status, 503);
    const j = await res.json();
    assert.equal(j.code, "SERVICE_UNAVAILABLE");
    assert.ok(!JSON.stringify(j).includes("secret-internal-detail"));
  });

  test("catalog: load failure -> 503", async () => {
    catalogService.clearCache();
    mock.method(firebaseAdmin, "getDb", () => {
      throw new Error("boom");
    });
    const res = await fetch(`${base}/api/packages`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "SERVICE_UNAVAILABLE");
  });
});
