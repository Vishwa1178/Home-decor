"use strict";

// Unit tests for the auth middleware and token-verification error mapping.
// The Firebase Admin SDK is stubbed here; tests/emulator/ covers the real SDK.

process.env.NODE_ENV = "test";

const { test, describe, before, after, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const app = require("../../src/app");
const authService = require("../../src/services/auth.service");
const firebaseAdmin = require("../../src/config/firebaseAdmin");

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));
afterEach(() => mock.restoreAll());

const get = (url, headers = {}) => fetch(base + url, { headers });
const bearer = (token = "good-token") => ({ Authorization: `Bearer ${token}` });
const stubVerify = (impl) => mock.method(authService, "verifyToken", impl);

describe("GET /api/admin/me: unauthenticated", () => {
  test("no Authorization header -> 401, verifier never called", async () => {
    const verify = stubVerify(async () => ({ uid: "x", admin: true }));
    const res = await get("/api/admin/me");
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /Bearer/);
    assert.equal(verify.mock.callCount(), 0);
  });

  for (const header of ["Basic dXNlcjpwYXNz", "Bearer", "Bearer ", "bearer a b", "token abc"]) {
    test(`malformed Authorization "${header}" -> 401`, async () => {
      const verify = stubVerify(async () => ({ uid: "x", admin: true }));
      const res = await get("/api/admin/me", { Authorization: header });
      assert.equal(res.status, 401);
      assert.equal(verify.mock.callCount(), 0);
    });
  }

  test("invalid/expired token -> 401", async () => {
    stubVerify(async () => {
      throw new authService.AuthError(401, "Invalid or expired authentication token");
    });
    const res = await get("/api/admin/me", bearer("bad"));
    assert.equal(res.status, 401);
  });

  test("unknown /api/admin/* path is also 401 (existence not leaked)", async () => {
    const res = await get("/api/admin/does-not-exist");
    assert.equal(res.status, 401);
  });
});

describe("GET /api/admin/me: authenticated but not admin", () => {
  const nonAdminClaims = [
    ["no admin claim", { uid: "u1", email: "user@example.com" }],
    ["admin: false", { uid: "u1", admin: false }],
    ['admin: "true" (string)', { uid: "u1", admin: "true" }],
    ["admin: 1 (number)", { uid: "u1", admin: 1 }],
    ["admin-looking email but no claim", { uid: "u1", email: "admin@example.com", email_verified: true }],
  ];

  for (const [name, claims] of nonAdminClaims) {
    test(`${name} -> 403`, async () => {
      stubVerify(async () => claims);
      const res = await get("/api/admin/me", bearer());
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, "Forbidden");
    });
  }

  test("client-supplied admin hints are ignored (headers, query, body)", async () => {
    const verify = stubVerify(async () => ({ uid: "u1", email: "user@example.com" }));
    const res = await fetch(`${base}/api/admin/me?admin=true&isAdmin=1&email=admin@example.com`, {
      method: "GET",
      headers: {
        ...bearer("user-token"),
        "X-Admin": "true",
        "X-User-Email": "admin@example.com",
        "X-Firebase-Claims": JSON.stringify({ admin: true }),
      },
    });
    assert.equal(res.status, 403);
    // The only thing handed to the verifier is the bearer token itself.
    assert.deepEqual(verify.mock.calls[0].arguments, ["user-token"]);
  });
});

describe("GET /api/admin/me: admin", () => {
  test("admin: true -> 200 with identity from the verified token", async () => {
    stubVerify(async () => ({ uid: "admin-uid", email: "boss@example.com", admin: true }));
    const res = await get("/api/admin/me", bearer());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { uid: "admin-uid", email: "boss@example.com", admin: true });
  });
});

describe("GET /api/admin/me: verification failures fail closed", () => {
  test("auth service unavailable -> 503, no identity granted", async () => {
    stubVerify(async () => {
      throw new authService.AuthError(503, "Authentication service unavailable");
    });
    const res = await get("/api/admin/me", bearer());
    assert.equal(res.status, 503);
  });

  test("unexpected exception -> 503 without leaking details", async () => {
    stubVerify(async () => {
      throw new Error("secret internal detail");
    });
    const res = await get("/api/admin/me", bearer());
    assert.equal(res.status, 503);
    assert.ok(!JSON.stringify(await res.json()).includes("secret internal detail"));
  });
});

describe("verifyToken error mapping (Admin SDK stubbed)", () => {
  const stubSdk = (impl) =>
    mock.method(firebaseAdmin, "getAdminAuth", () => ({ verifyIdToken: impl }));

  for (const code of [
    "auth/id-token-expired",
    "auth/id-token-revoked",
    "auth/argument-error",
    "auth/invalid-id-token",
    "auth/user-disabled",
  ]) {
    test(`${code} -> AuthError 401`, async () => {
      stubSdk(async () => {
        throw Object.assign(new Error("x"), { code });
      });
      await assert.rejects(authService.verifyToken("t"), (e) => e.status === 401);
    });
  }

  for (const code of ["auth/internal-error", "app/invalid-credential", undefined]) {
    test(`${code ?? "no code"} -> AuthError 503 (fail closed)`, async () => {
      stubSdk(async () => {
        throw Object.assign(new Error("x"), { code });
      });
      await assert.rejects(authService.verifyToken("t"), (e) => e.status === 503);
    });
  }

  test("passes the FIREBASE_CHECK_REVOKED setting through to the SDK", async () => {
    const { env } = require("../../src/config/env");
    const verify = mock.fn(async () => ({ uid: "u" }));
    stubSdk(verify);
    await authService.verifyToken("tok");
    assert.deepEqual(verify.mock.calls[0].arguments, ["tok", env.FIREBASE_CHECK_REVOKED]);
  });

  test("returns decoded claims from the SDK on success", async () => {
    stubSdk(async () => ({ uid: "u", admin: true }));
    assert.deepEqual(await authService.verifyToken("t"), { uid: "u", admin: true });
  });

  test("isAdmin is strictly `admin === true`", () => {
    assert.equal(authService.isAdmin({ admin: true }), true);
    for (const v of [false, "true", 1, null, undefined, {}]) {
      assert.equal(authService.isAdmin({ admin: v }), false);
    }
    assert.equal(authService.isAdmin(undefined), false);
  });
});

describe("public endpoints stay public", () => {
  test("/health needs no token", async () => {
    assert.equal((await get("/health")).status, 200);
  });
  test("/api/bookings/packages (catalog alias) needs no token", async () => {
    // The catalog now comes from Firestore; stub it so this stays a no-service unit test.
    mock.method(require("../../src/services/catalog.service"), "getCatalog", async () => ({ packages: [] }));
    assert.equal((await get("/api/bookings/packages")).status, 200);
  });
});

describe("production config guards", () => {
  const run = (envOverrides) =>
    spawnSync(process.execPath, ["-e", 'require("./src/config/env")'], {
      cwd: path.join(__dirname, "..", ".."),
      env: { PATH: process.env.PATH, ...envOverrides },
      encoding: "utf8",
    });

  test("production without FIREBASE_PROJECT_ID refuses to start", () => {
    const r = run({ NODE_ENV: "production" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /FIREBASE_PROJECT_ID is required/);
  });

  test("production with the Auth emulator host set refuses to start", () => {
    const r = run({
      NODE_ENV: "production",
      FIREBASE_PROJECT_ID: "p",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /FIREBASE_AUTH_EMULATOR_HOST must not be set/);
  });

  test("production with a project ID starts", () => {
    assert.equal(run({ NODE_ENV: "production", FIREBASE_PROJECT_ID: "p" }).status, 0);
  });
});
