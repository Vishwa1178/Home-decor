"use strict";

// Shared setup for the admin API suites: the real app, the real Firestore + Auth emulators,
// real ID tokens (one admin, one ordinary user).

const helpers = require("./helpers");
const crypto = require("node:crypto");

function setup(extraEnv = {}) {
  helpers.setupEnv({
    CATALOG_CACHE_TTL_MS: "60000", // long on purpose: admin edits must clear it, not wait it out
    RATE_LIMIT_BOOKINGS_MAX: "100000",
    RATE_LIMIT_ADMIN_MAX: "100000",
    RATE_LIMIT_AVAILABILITY_MAX: "100000",
    RATE_LIMIT_CATALOG_MAX: "100000",
    ...extraEnv,
  });
  // Require lazily so setupEnv runs before the app reads its configuration.
  const app = require("../../src/app");
  const { getDb } = require("../../src/config/firebaseAdmin");
  const { addDays, todayInTimezone } = require("../../src/utils/dates");
  const today = todayInTimezone("Asia/Kolkata");

  const ctx = { srv: null, db: getDb, today, tokens: null };
  let dayCounter = 0;
  ctx.nextDate = () => addDays(today, 2 + ++dayCounter);
  ctx.addDays = addDays;

  ctx.start = async () => {
    await helpers.resetAndSeed();
    ctx.srv = await helpers.listen(app);
    ctx.tokens = await helpers.createAdminAndUser();
  };
  ctx.stop = () => ctx.srv.close();

  // call(method, path, { token, body, headers, query })
  ctx.call = async (method, path, { token = ctx.tokens.admin.token, body, headers = {}, query } = {}) => {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString()}` : "";
    const res = await fetch(`${ctx.srv.base}${path}${qs}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json, headers: res.headers };
  };
  ctx.get = (path, opts) => ctx.call("GET", `/api/admin${path}`, opts);
  ctx.patch = (path, body, opts) => ctx.call("PATCH", `/api/admin${path}`, { ...opts, body });
  ctx.post = (path, body, opts) => ctx.call("POST", `/api/admin${path}`, { ...opts, body });
  ctx.put = (path, body, opts) => ctx.call("PUT", `/api/admin${path}`, { ...opts, body: body ?? {} });
  ctx.del = (path, opts) => ctx.call("DELETE", `/api/admin${path}`, opts);

  // A customer booking through the public API (so slots, seats and prices are real).
  ctx.book = async (over = {}) => {
    const body = {
      requestId: crypto.randomUUID(), packageId: "birthday-decor", name: "Asha Rao", phone: "9876543210", email: "asha@example.com",
      date: ctx.nextDate(), slotId: "t1000", address: "12 Lake Road, Bangalore", paymentOption: "HALF", paymentMethod: "UPI", ...over,
    };
    const res = await fetch(`${ctx.srv.base}/api/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json(), body, id: body.requestId };
  };
  ctx.availability = async (date) => (await (await fetch(`${ctx.srv.base}/api/availability?date=${date}`)).json());
  ctx.occupancy = async (date, slotId) => (await ctx.db().collection("slotBookings").doc(`${date}_${slotId}`).get()).data();
  ctx.auditCount = async () => (await ctx.db().collection("auditLogs").count().get()).data().count;
  ctx.auditFor = async (entityType, entityId) =>
    (await ctx.db().collection("auditLogs").where("entityType", "==", entityType).where("entityId", "==", entityId).get()).docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.at.toMillis() - b.at.toMillis());
  ctx.resetSlots = async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "slots.seed.json"), "utf8")).slots;
    const db = ctx.db();
    const batch = db.batch();
    const { FieldValue } = require("firebase-admin/firestore");
    for (const { id, ...data } of seed) batch.set(db.collection("slots").doc(id), { ...data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();
    for (const extra of (await db.collection("slots").get()).docs) if (!seed.some((s) => s.id === extra.id)) await extra.ref.delete();
  };
  return ctx;
}

// After any scenario: every occupancy counter equals its booking list and the live bookings
// that hold that seat; nothing is over capacity.
async function auditCapacity(db) {
  const problems = [];
  const occSnap = await db().collection("slotBookings").get();
  for (const d of occSnap.docs) {
    const o = d.data();
    const holders = (await db().collection("bookings").where("slotKey", "==", d.id).get()).docs.filter((b) => b.data().status !== "Cancelled").map((b) => b.id);
    if (o.bookedCount !== o.bookingIds.length) problems.push(`${d.id}: bookedCount ${o.bookedCount} != ids ${o.bookingIds.length}`);
    if ([...holders].sort().join() !== [...o.bookingIds].sort().join()) problems.push(`${d.id}: seat holders ${JSON.stringify(holders)} != bookingIds ${JSON.stringify(o.bookingIds)}`);
    if (o.bookedCount > o.capacity) problems.push(`${d.id}: OVERBOOKED ${o.bookedCount} > ${o.capacity}`);
  }
  return problems;
}

module.exports = { setup, auditCapacity };
