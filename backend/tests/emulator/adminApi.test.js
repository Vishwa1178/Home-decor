"use strict";

// Tests the frontend's fetchAdminProfile() (frontend/src/adminApi.js) against the
// real backend with real Firebase Auth emulator tokens.
// Run with: npm run test:emulator  (from backend/)

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-home-decor";
process.env.FIREBASE_CHECK_REVOKED = "true";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const app = require("../../src/app");

const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
const stamp = Date.now();
let base;
let server;
let flaky; // server that answers 500
let flakyBase;
let fetchAdminProfile;
let adminToken;
let userToken;

async function idp(action, body) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:${action}?key=fake-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, returnSecureToken: true }),
  });
  return res.json();
}

const listen = (srv) => new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${srv.address().port}`)));

before(async () => {
  ({ fetchAdminProfile } = await import(pathToFileURL(path.join(__dirname, "..", "..", "..", "frontend", "src", "adminApi.js")).href));

  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  flaky = http.createServer((_req, res) => { res.statusCode = 500; res.end("boom"); });
  flakyBase = await listen(flaky);

  const adminEmail = `api-admin-${stamp}@example.test`;
  const userEmail = `api-user-${stamp}@example.test`;
  await idp("signUp", { email: adminEmail, password: "Str0ng-pass!" });
  await idp("signUp", { email: userEmail, password: "Str0ng-pass!" });
  const r = spawnSync(process.execPath, ["scripts/set-admin-claim.js", adminEmail], {
    cwd: path.join(__dirname, "..", ".."), env: { ...process.env }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  adminToken = (await idp("signInWithPassword", { email: adminEmail, password: "Str0ng-pass!" })).idToken;
  userToken = (await idp("signInWithPassword", { email: userEmail, password: "Str0ng-pass!" })).idToken;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => flaky.close(r));
});

const code = (p) => p.then(() => null, (e) => e.code);

describe("frontend fetchAdminProfile", () => {
  test("admin token -> profile", async () => {
    const me = await fetchAdminProfile(base, adminToken);
    assert.equal(me.admin, true);
    assert.match(me.email, /^api-admin-/);
  });
  test("normal user token -> not-admin", async () => assert.equal(await code(fetchAdminProfile(base, userToken)), "not-admin"));
  test("garbage token -> unauthorized", async () => assert.equal(await code(fetchAdminProfile(base, "garbage")), "unauthorized"));
  test("no API URL configured -> no-api (fails closed)", async () => assert.equal(await code(fetchAdminProfile("", adminToken)), "no-api"));
  test("API answers 500 -> unavailable (fails closed)", async () => assert.equal(await code(fetchAdminProfile(flakyBase, adminToken)), "unavailable"));
  test("API unreachable -> unavailable (fails closed)", async () => assert.equal(await code(fetchAdminProfile("http://127.0.0.1:1", adminToken)), "unavailable"));
  test("timeout -> unavailable", async () => {
    const slow = http.createServer(() => { /* never answers */ });
    const slowBase = await listen(slow);
    try {
      assert.equal(await code(fetchAdminProfile(slowBase, adminToken, { timeoutMs: 100 })), "unavailable");
    } finally {
      slow.closeAllConnections();
      await new Promise((r) => slow.close(r));
    }
  });
});
