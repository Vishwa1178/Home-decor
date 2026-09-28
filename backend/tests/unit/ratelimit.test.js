"use strict";

// Rate limits (small limits set before the app loads; each test file is its own process).

process.env.NODE_ENV = "test";
process.env.RATE_LIMIT_BOOKINGS_MAX = "3";
process.env.RATE_LIMIT_BOOKINGS_WINDOW_MS = "60000";
process.env.RATE_LIMIT_CATALOG_MAX = "4";
process.env.RATE_LIMIT_ADMIN_MAX = "2";

const { test, before, after, mock } = require("node:test");
const assert = require("node:assert/strict");

const app = require("../../src/app");
const catalogService = require("../../src/services/catalog.service");

let server;
let base;
before(async () => {
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
  mock.method(catalogService, "getCatalog", async () => ({ packages: [] }));
});
after(() => new Promise((r) => server.close(r)));

test("POST /api/bookings: 4th request in the window -> 429 JSON with Retry-After", async () => {
  const post = () => fetch(`${base}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  for (let i = 0; i < 3; i++) assert.equal((await post()).status, 400); // invalid, but they still count
  const res = await post();
  assert.equal(res.status, 429);
  const j = await res.json();
  assert.equal(j.code, "RATE_LIMITED");
  assert.equal(j.error, "TooManyRequests");
  assert.ok(Number(res.headers.get("retry-after")) > 0);
  assert.ok(res.headers.get("ratelimit"));
});

test("the validate dry-run shares the booking limit", async () => {
  const res = await fetch(`${base}/api/bookings/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 429);
});

test("GET /api/packages: limited separately", async () => {
  for (let i = 0; i < 4; i++) assert.equal((await fetch(`${base}/api/packages`)).status, 200);
  assert.equal((await fetch(`${base}/api/packages`)).status, 429);
});

test("/api/admin/*: limited (401s count)", async () => {
  for (let i = 0; i < 2; i++) assert.equal((await fetch(`${base}/api/admin/me`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/me`)).status, 429);
});

test("/health is never limited", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/health`)).status, 200);
});
