"use strict";

// Shared helpers for emulator tests. Requires the Firestore emulator
// (`npm run test:emulator` starts it and sets FIRESTORE_EMULATOR_HOST).

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const PROJECT_ID = "demo-home-decor";
const BACKEND_DIR = path.join(__dirname, "..", "..");

function setupEnv(extra = {}) {
  process.env.NODE_ENV = "test";
  process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
  Object.assign(process.env, extra);
}

// Wipes every Firestore document in the emulator.
async function clearFirestore() {
  const res = await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`clearFirestore failed: ${res.status}`);
}

function runScript(script, ...args) {
  return spawnSync(process.execPath, [`scripts/${script}`, ...args], {
    cwd: BACKEND_DIR,
    env: { ...process.env },
    encoding: "utf8",
  });
}

// Fresh, seeded catalog and slots.
async function resetAndSeed() {
  await clearFirestore();
  for (const script of ["seed-catalog.js", "seed-slots.js"]) {
    const r = runScript(script);
    if (r.status !== 0) throw new Error(`${script} failed: ${r.stderr}`);
  }
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// ── real Firebase Auth emulator users (real ID tokens, real Admin SDK verification) ──
async function identity(action, body) {
  const res = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:${action}?key=fake-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, returnSecureToken: true }),
  });
  const json = await res.json();
  if (res.status !== 200) throw new Error(`auth emulator ${action} failed: ${JSON.stringify(json)}`);
  return json;
}

// One admin (custom claim granted by the real operator script) and one ordinary user.
async function createAdminAndUser() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const admin = { email: `admin-${stamp}@example.test`, password: "Str0ng-pass!" };
  const user = { email: `user-${stamp}@example.test`, password: "Str0ng-pass!" };
  await identity("signUp", admin);
  await identity("signUp", user);
  const r = runScript("set-admin-claim.js", admin.email);
  if (r.status !== 0) throw new Error(`grant failed: ${r.stderr}`);
  const adminSession = await identity("signInWithPassword", admin); // fresh token carries the claim
  const userSession = await identity("signInWithPassword", user);
  return { admin: { ...admin, token: adminSession.idToken, uid: adminSession.localId }, user: { ...user, token: userSession.idToken, uid: userSession.localId } };
}

module.exports = { identity, createAdminAndUser, PROJECT_ID, BACKEND_DIR, setupEnv, clearFirestore, runScript, resetAndSeed, listen };
