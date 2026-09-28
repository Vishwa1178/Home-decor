"use strict";

// Tests the real firestore.rules against the Firestore emulator.
// Run with: npm run test:emulator  (from backend/)

const { test, describe, before, after } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, orderBy, where,
} = require("firebase/firestore");

let env;

const bookingData = { name: "Asha", phone: "+919999999999", address: "12 Lake Rd", status: "Pending" };

before(async () => {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
  env = await initializeTestEnvironment({
    projectId: "demo-home-decor",
    firestore: {
      host,
      port: Number(port),
      rules: fs.readFileSync(path.join(__dirname, "..", "..", "..", "firestore.rules"), "utf8"),
    },
  });
  // Seed with rules disabled (this is what the backend's Admin SDK does).
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "bookings/b1"), { ...bookingData, createdAt: new Date() });
    await setDoc(doc(db, "packages/birthday"), { name: "Birthday Decor", active: true, price: 999 });
    await setDoc(doc(db, "packages/draft"), { name: "Draft", active: false, price: 1 });
    await setDoc(doc(db, "packages/noflag"), { name: "No active flag", price: 1 });
    await setDoc(doc(db, "categories/birthday"), { name: "Birthday", active: true });
    await setDoc(doc(db, "categories/hidden"), { name: "Hidden", active: false });
    await setDoc(doc(db, "slots/t1000"), { label: "10:00 AM", time: "10:00", capacity: 1, enabled: true, days: [0, 1, 2, 3, 4, 5, 6], sortOrder: 10 });
    await setDoc(doc(db, "slots/t0900"), { label: "9:00 AM", time: "09:00", capacity: 1, enabled: false, days: [1], sortOrder: 5 });
    await setDoc(doc(db, "blockedDates/2030-01-01"), { reason: "private: owner away" });
    await setDoc(doc(db, "slotBookings/2030-01-01_t1000"), { bookedCount: 1, bookingIds: ["secret-booking-id"], capacity: 1 });
    await setDoc(doc(db, "secrets/s1"), { v: 1 });
    await setDoc(doc(db, "auditLogs/a1"), { action: "booking.status_changed", actor: { uid: "x" } });
  });
});

after(async () => {
  await env.cleanup();
});

const unauth = () => env.unauthenticatedContext().firestore();
const user = () => env.authenticatedContext("user-1").firestore();
const emailOnlyAdmin = () =>
  env.authenticatedContext("user-2", { email: "admin@example.com", email_verified: true }).firestore();
const adminStringClaim = () => env.authenticatedContext("user-3", { admin: "true" }).firestore();
const adminFalse = () => env.authenticatedContext("user-4", { admin: false }).firestore();
const admin = () => env.authenticatedContext("admin-1", { admin: true }).firestore();

describe("bookings: unauthenticated", () => {
  test("cannot read a booking", () => assertFails(getDoc(doc(unauth(), "bookings/b1"))));
  test("cannot list bookings", () => assertFails(getDocs(collection(unauth(), "bookings"))));
  test("cannot create a booking (the old public-create hole is closed)", () =>
    assertFails(addDoc(collection(unauth(), "bookings"), bookingData)));
  test("cannot update a booking", () =>
    assertFails(updateDoc(doc(unauth(), "bookings/b1"), { status: "Confirmed" })));
  test("cannot delete a booking", () => assertFails(deleteDoc(doc(unauth(), "bookings/b1"))));
});

describe("bookings: signed-in normal user", () => {
  test("cannot read", () => assertFails(getDoc(doc(user(), "bookings/b1"))));
  test("cannot list", () => assertFails(getDocs(collection(user(), "bookings"))));
  test("cannot create", () => assertFails(addDoc(collection(user(), "bookings"), bookingData)));
  test("cannot create even with a forged status/price", () =>
    assertFails(addDoc(collection(user(), "bookings"), { ...bookingData, status: "Confirmed", packagePrice: 1 })));
  test("cannot update", () => assertFails(updateDoc(doc(user(), "bookings/b1"), { status: "Confirmed" })));
  test("cannot delete", () => assertFails(deleteDoc(doc(user(), "bookings/b1"))));
});

describe("bookings: identities that must NOT count as admin", () => {
  test("verified admin-looking email without the claim cannot read", () =>
    assertFails(getDoc(doc(emailOnlyAdmin(), "bookings/b1"))));
  test('admin claim as a string "true" cannot read', () =>
    assertFails(getDoc(doc(adminStringClaim(), "bookings/b1"))));
  test("admin: false cannot read", () => assertFails(getDoc(doc(adminFalse(), "bookings/b1"))));
});

describe("bookings: admin (custom claim admin: true)", () => {
  // The dashboard reads through the paginated backend API; a browser can never read the
  // collection, even an admin's, so it cannot be pulled wholesale.
  test("cannot read a booking directly", () => assertFails(getDoc(doc(admin(), "bookings/b1"))));
  test("cannot list bookings directly (with or without ordering)", async () => {
    await assertFails(getDocs(collection(admin(), "bookings")));
    await assertFails(getDocs(query(collection(admin(), "bookings"), orderBy("createdAt", "desc"))));
  });
  test("cannot create from the client (writes go through the backend)", () =>
    assertFails(addDoc(collection(admin(), "bookings"), bookingData)));
  test("cannot update from the client", () =>
    assertFails(updateDoc(doc(admin(), "bookings/b1"), { status: "Confirmed" })));
  test("cannot delete from the client", () => assertFails(deleteDoc(doc(admin(), "bookings/b1"))));
});

describe("public catalog (active entries only)", () => {
  test("anyone can read an active package", () => assertSucceeds(getDoc(doc(unauth(), "packages/birthday"))));
  test("anyone can list ACTIVE packages (the query the storefront uses)", () =>
    assertSucceeds(getDocs(query(collection(unauth(), "packages"), where("active", "==", true)))));
  test("an unfiltered list is refused (it would include inactive entries)", () =>
    assertFails(getDocs(collection(unauth(), "packages"))));
  test("inactive package: hidden from the public and from normal users", async () => {
    await assertFails(getDoc(doc(unauth(), "packages/draft")));
    await assertFails(getDoc(doc(user(), "packages/draft")));
  });
  test("a package without an active flag is not public", () => assertFails(getDoc(doc(unauth(), "packages/noflag"))));
  test("admin can read inactive packages", () => assertSucceeds(getDoc(doc(admin(), "packages/draft"))));

  test("categories follow the same rule", async () => {
    await assertSucceeds(getDoc(doc(unauth(), "categories/birthday")));
    await assertFails(getDoc(doc(unauth(), "categories/hidden")));
    await assertSucceeds(getDoc(doc(admin(), "categories/hidden")));
  });

  test("nobody can write packages or categories from the client, not even admin", async () => {
    for (const db of [unauth(), user(), admin()]) {
      await assertFails(setDoc(doc(db, "packages/x"), { name: "x", active: true, price: 1 }));
      await assertFails(setDoc(doc(db, "categories/x"), { name: "x", active: true }));
    }
    await assertFails(updateDoc(doc(admin(), "packages/birthday"), { price: 1 }));
    await assertFails(deleteDoc(doc(admin(), "packages/birthday")));
  });
});

describe("slots, blocked dates and occupancy", () => {
  test("an enabled slot's configuration is public; a disabled one is admin-only", async () => {
    await assertSucceeds(getDoc(doc(unauth(), "slots/t1000")));
    await assertFails(getDoc(doc(unauth(), "slots/t0900")));
    await assertFails(getDoc(doc(user(), "slots/t0900")));
    await assertSucceeds(getDoc(doc(admin(), "slots/t0900")));
  });
  test("listing enabled slots is allowed (the query a storefront would use)", () =>
    assertSucceeds(getDocs(query(collection(unauth(), "slots"), where("enabled", "==", true)))));
  test("blocked dates (with private reasons) are backend-only, admins included", async () => {
    await assertFails(getDoc(doc(unauth(), "blockedDates/2030-01-01")));
    await assertFails(getDoc(doc(user(), "blockedDates/2030-01-01")));
    await assertFails(getDoc(doc(admin(), "blockedDates/2030-01-01")));
  });
  test("occupancy documents (booking ids) are backend-only, admins included", async () => {
    await assertFails(getDoc(doc(unauth(), "slotBookings/2030-01-01_t1000")));
    await assertFails(getDocs(collection(unauth(), "slotBookings")));
    await assertFails(getDoc(doc(user(), "slotBookings/2030-01-01_t1000")));
    await assertFails(getDoc(doc(admin(), "slotBookings/2030-01-01_t1000")));
  });
  test("the old public 'availability' collection no longer exists", () =>
    assertFails(getDoc(doc(unauth(), "availability/2030-01-01_1100"))));
  test("nobody can write slots, blocked dates or occupancy from the client, not even admin: capacity can only change in the backend transaction", async () => {
    for (const db of [unauth(), user(), admin()]) {
      await assertFails(setDoc(doc(db, "slots/t2000"), { label: "8 PM", time: "20:00", capacity: 99, enabled: true, days: [1], sortOrder: 1 }));
      await assertFails(setDoc(doc(db, "blockedDates/2031-01-01"), { reason: "x" }));
      await assertFails(setDoc(doc(db, "slotBookings/2031-01-01_t1000"), { bookedCount: 0, bookingIds: [] }));
    }
    await assertFails(updateDoc(doc(admin(), "slotBookings/2030-01-01_t1000"), { bookedCount: 0 }));
    await assertFails(updateDoc(doc(admin(), "slots/t1000"), { capacity: 50 }));
    await assertFails(deleteDoc(doc(admin(), "slotBookings/2030-01-01_t1000")));
  });
});

describe("audit log: backend-only", () => {
  test("nobody can read or write audit entries from a browser, not even an admin", async () => {
    for (const db of [unauth(), user(), admin()]) {
      await assertFails(getDoc(doc(db, "auditLogs/a1")));
      await assertFails(getDocs(collection(db, "auditLogs")));
      await assertFails(setDoc(doc(db, "auditLogs/a2"), { action: "forged" }));
      await assertFails(addDoc(collection(db, "auditLogs"), { action: "forged" }));
    }
    await assertFails(updateDoc(doc(admin(), "auditLogs/a1"), { action: "edited" }));
    await assertFails(deleteDoc(doc(admin(), "auditLogs/a1")));
  });
});

describe("everything else is closed (default deny)", () => {
  test("unknown collection: no read or write for anonymous, user or admin", async () => {
    for (const db of [unauth(), user(), admin()]) {
      await assertFails(getDoc(doc(db, "secrets/s1")));
      await assertFails(setDoc(doc(db, "secrets/s2"), { v: 2 }));
    }
  });
  test("nested path under bookings is closed", () =>
    assertFails(getDoc(doc(admin(), "bookings/b1/notes/n1"))));
});
