"use strict";

// End-to-end auth test against the real Firebase Auth emulator, the real Admin
// SDK, the real Express app and the real operator script. Nothing is stubbed.
// Run with: npm run test:emulator  (from backend/)
//
// Caveat: the emulator issues unsigned tokens, so signature verification against
// Google's public certificates is not exercised here (that is the SDK's job).

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-home-decor";
process.env.FIREBASE_CHECK_REVOKED = "true"; // the production setting

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const app = require("../../src/app");

const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
const BACKEND_DIR = path.join(__dirname, "..", "..");

let server;
let base;

async function idp(action, body) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:${action}?key=fake-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, returnSecureToken: true }),
  });
  const json = await res.json();
  assert.equal(res.status, 200, `emulator ${action} failed: ${JSON.stringify(json)}`);
  return json;
}
const signUp = (email, password) => idp("signUp", { email, password });
const signIn = (email, password) => idp("signInWithPassword", { email, password });

function claimScript(target, ...flags) {
  return spawnSync(process.execPath, ["scripts/set-admin-claim.js", target, ...flags], {
    cwd: BACKEND_DIR,
    env: { ...process.env },
    encoding: "utf8",
  });
}

const me = (token, extraHeaders = {}) =>
  fetch(`${base}/api/admin/me`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
  });

const stamp = Date.now();
const admin = { email: `admin-${stamp}@example.test`, password: "Str0ng-pass!" };
const normal = { email: `user-${stamp}@example.test`, password: "Str0ng-pass!" };
let adminUser;
let normalUser;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  adminUser = await signUp(admin.email, admin.password);
  normalUser = await signUp(normal.email, normal.password);
});

after(() => new Promise((resolve) => server.close(resolve)));

describe("unauthenticated", () => {
  test("no token -> 401", async () => assert.equal((await me()).status, 401));
  test("garbage token -> 401", async () => assert.equal((await me("not.a.jwt")).status, 401));
  test("empty bearer -> 401", async () =>
    assert.equal((await me(null, { Authorization: "Bearer " })).status, 401));
});

describe("normal user (self-registered, no admin claim)", () => {
  test("valid token but not admin -> 403", async () => {
    const res = await me(normalUser.idToken);
    assert.equal(res.status, 403);
  });

  test("still 403 after re-sign-in", async () => {
    const fresh = await signIn(normal.email, normal.password);
    assert.equal((await me(fresh.idToken)).status, 403);
  });

  test("spoofed admin headers do not help", async () => {
    const res = await me(normalUser.idToken, {
      "X-Admin": "true",
      "X-User-Email": admin.email,
    });
    assert.equal(res.status, 403);
  });

  test("the operator script is the only way in: it refuses an unknown user", () => {
    const r = claimScript(`nobody-${stamp}@example.test`);
    assert.notEqual(r.status, 0);
  });
});

describe("admin lifecycle via the operator script", () => {
  test("before grant: the would-be admin is just a normal user -> 403", async () => {
    assert.equal((await me(adminUser.idToken)).status, 403);
  });

  test("grant: script sets the claim", () => {
    const r = claimScript(admin.email);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Granted admin/);
  });

  test("old token does not have the claim yet -> 403 (claims live in the token)", async () => {
    assert.equal((await me(adminUser.idToken)).status, 403);
  });

  test("fresh sign-in token carries admin: true -> 200 with server-verified identity", async () => {
    const fresh = await signIn(admin.email, admin.password);
    const res = await me(fresh.idToken);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.admin, true);
    assert.equal(body.uid, adminUser.localId);
    assert.equal(body.email, admin.email);
  });

  test("the other (normal) user is unaffected by granting someone else", async () => {
    const fresh = await signIn(normal.email, normal.password);
    assert.equal((await me(fresh.idToken)).status, 403);
  });

  test("revoke: existing admin token is rejected immediately (revocation check) -> 401", async () => {
    const before = await signIn(admin.email, admin.password);
    assert.equal((await me(before.idToken)).status, 200);

    // Firebase compares token auth_time with the revocation time at 1-second
    // granularity, so a token issued in the same second as the revocation is not
    // considered revoked. Real revocations happen long after sign-in.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const r = claimScript(admin.email, "--revoke");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Revoked admin/);

    assert.equal((await me(before.idToken)).status, 401);
  });

  test("after revoke, a fresh sign-in is a normal user -> 403", async () => {
    const fresh = await signIn(admin.email, admin.password);
    assert.equal((await me(fresh.idToken)).status, 403);
  });
});
