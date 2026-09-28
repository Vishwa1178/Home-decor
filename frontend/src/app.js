import { firebaseConfig, API_BASE_URL } from "./firebase-config.js";
import { fetchAdminProfile } from "./adminApi.js";
import { initBookingModal } from "./bookingModal.js";
import { createAdminApi } from "./admin/api.js";
import { initAdminDashboard } from "./admin/dashboard.js";
import { loadAvailability } from "./availability.js";

// ─── DOM refs ────────────────────────────────────────────────────────────────
const pages           = { "/": document.querySelector('[data-page="home"]'), "/admin": document.querySelector('[data-page="admin"]') };
const publicNav       = document.querySelector("#publicNav");
const publicActions   = document.querySelector("#publicActions");
const siteFooter      = document.querySelector(".footer");
const mobileCta       = document.querySelector(".mobile-cta");
const navLinks        = document.querySelectorAll("[data-route]");

// admin dashboard
const adminLogout   = document.querySelector("#adminLogout");
const adminTopbarArea  = document.querySelector("#adminTopbarArea");
const adminTopbarEmail = document.querySelector("#adminTopbarEmail");

// login overlay
const adminLoginOverlay  = document.querySelector("#adminLoginOverlay");
const adminEmailInput    = document.querySelector("#adminEmailInput");
const adminPasswordInput = document.querySelector("#adminPasswordInput");
const adminLoginBtn      = document.querySelector("#adminLoginBtn");
const adminLoginStatus   = document.querySelector("#adminLoginStatus");

// ─── State ───────────────────────────────────────────────────────────────────
let firebaseApp, firebaseModules;
let dashboard = null;         // the admin dashboard (created once, started/stopped per session)
let dashboardRunning = false;
let dashboardAuth = null;     // { fb, auth } of the current admin session
let authUnsubscribe = null;   // onAuthStateChanged listener (admin route only)
let adminCheckId = 0;         // invalidates in-flight admin checks that became stale
let pendingLoginMessage = null; // message to show once the sign-out below completes
const FB_TIMEOUT = 15000;
const ADMIN_CHECK_TIMEOUT = 30000; // allows for a cold-starting API host

// ─── Router ──────────────────────────────────────────────────────────────────
function routeFromLocation() {
  if (location.hash === "#admin") return "/admin";
  return location.pathname === "/admin" ? "/admin" : "/";
}

function renderRoute(path = routeFromLocation()) {
  Object.entries(pages).forEach(([r, p]) => p.classList.toggle("active", r === path));
  navLinks.forEach(l => l.classList.toggle("active", l.dataset.route === path));

  const isAdmin = path === "/admin";
  document.body.classList.toggle("admin-route", isAdmin);
  publicNav?.toggleAttribute("hidden", isAdmin);
  publicActions?.toggleAttribute("hidden", isAdmin);
  siteFooter?.toggleAttribute("hidden", isAdmin);
  mobileCta?.toggleAttribute("hidden", isAdmin);

  if (isAdmin) {
    showLoginOverlay("Checking session…");
    startAdminSession();
  } else {
    stopAdminSession();
    hideLoginOverlay();
    hideAdminTopbar();
    stopDashboard();
  }
}

function navigate(path) {
  history.pushState({}, "", path);
  renderRoute(path);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

navLinks.forEach(link => {
  link.addEventListener("click", e => {
    const route = link.dataset.route;
    if (!route) return;
    e.preventDefault();
    navigate(route);
  });
});

window.addEventListener("popstate", () => renderRoute());
renderRoute();

// Booking modal (catalog-driven prices, POST /api/bookings). Owns all booking DOM.
const { openBooking, setLastTrigger } = initBookingModal({ selectedCardSelector: ".occasion-card" });

// ─── Hamburger / dropdown navigation ──────────────────────────────────────────
const hamburgerBtn = document.querySelector("#hamburgerBtn");
const navItems     = document.querySelectorAll("[data-nav-item]");

hamburgerBtn?.addEventListener("click", () => {
  const open = document.documentElement.classList.toggle("nav-open");
  hamburgerBtn.setAttribute("aria-expanded", String(open));
  hamburgerBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  if (!open) navItems.forEach(item => closeDropdown(item));
});

document.querySelector("#navCloseBtn")?.addEventListener("click", closeMobileNav);

function closeDropdown(item) {
  item.classList.remove("open");
  item.querySelector(".nav-drop-trigger")?.setAttribute("aria-expanded", "false");
}

function closeMobileNav() {
  document.documentElement.classList.remove("nav-open");
  hamburgerBtn?.setAttribute("aria-expanded", "false");
  hamburgerBtn?.setAttribute("aria-label", "Open menu");
}

navItems.forEach(item => {
  const trigger = item.querySelector(".nav-drop-trigger");
  if (!trigger) return;

  trigger.addEventListener("click", () => {
    const willOpen = !item.classList.contains("open");
    navItems.forEach(other => other !== item && closeDropdown(other));
    item.classList.toggle("open", willOpen);
    trigger.setAttribute("aria-expanded", String(willOpen));
  });
});

document.addEventListener("click", e => {
  if (!e.target.closest("[data-nav-item]")) {
    navItems.forEach(item => closeDropdown(item));
  }
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    navItems.forEach(item => closeDropdown(item));
    if (document.documentElement.classList.contains("nav-open")) closeMobileNav();
  }
});

// Dropdown links now navigate to their theme page (e.g. birthday.html) —
// only close the open mobile drawer/dropdown state, don't block navigation.
document.querySelectorAll(".nav-dropdown a").forEach(link => {
  link.addEventListener("click", () => {
    closeMobileNav();
    navItems.forEach(item => closeDropdown(item));
  });
});

// Quick-category thumbnails in the mobile drawer still link to an in-page
// anchor (#decorations), so they open the booking modal directly.
document.querySelectorAll(".mnav-quick-thumb[data-package]").forEach(link => {
  link.addEventListener("click", e => {
    e.preventDefault();
    setLastTrigger(link);
    openBooking(link.dataset.packageId);
    closeMobileNav();
    navItems.forEach(item => closeDropdown(item));
  });
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 900 && document.documentElement.classList.contains("nav-open")) {
    closeMobileNav();
  }
});

// ─── Package cards ────────────────────────────────────────────────────────────
// (Buttons with [data-open-booking] are wired inside bookingModal.js.)
document.querySelectorAll(".package-card").forEach(card => {
  card.addEventListener("click", e => {
    if (e.target.closest("button")) return;
    const btn = card.querySelector("[data-open-booking]");
    if (btn) openBooking(btn.dataset.packageId);
  });
});

document.querySelectorAll("[data-filter]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-filter]").forEach(b => b.classList.toggle("active", b === btn));
    const f = btn.dataset.filter;
    document.querySelectorAll(".gallery-grid img").forEach(img => { img.hidden = f !== "all" && img.dataset.category !== f; });
  });
});

// ─── Firebase init ────────────────────────────────────────────────────────────
function hasFirebaseConfig() {
  return ["apiKey","authDomain","projectId","messagingSenderId","appId"].every(k => {
    const v = firebaseConfig[k];
    return v && !v.startsWith("PASTE_");
  });
}

async function getFirebase() {
  if (!hasFirebaseConfig()) return null;
  if (firebaseApp && firebaseModules) return { app: firebaseApp, ...firebaseModules };

  // Auth only. The admin dashboard uses the backend API, never Firestore, and the
  // security rules would refuse a browser's Firestore reads of bookings anyway.
  const [appMod, authMod] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js"),
  ]);

  firebaseApp     = appMod.initializeApp(firebaseConfig);
  firebaseModules = { ...authMod };
  return { app: firebaseApp, ...firebaseModules };
}

function withTimeout(p, msg, ms = FB_TIMEOUT) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(msg)), ms))]);
}

// ─── Admin login (Email / Password via Firebase Auth) ─────────────────────────
adminLoginBtn?.addEventListener("click", async () => {
  const email    = adminEmailInput?.value.trim();
  const password = adminPasswordInput?.value;

  if (!email || !password) {
    setLoginStatus("Please enter both email and password.", true);
    return;
  }

  setLoginStatus("Signing in…");
  adminLoginBtn.disabled = true;

  try {
    const fb = await withTimeout(getFirebase(), "Firebase did not load. Check your internet.");
    if (!fb) { setLoginStatus("Firebase config missing.", true); return; }

    attachAuthListener(fb);

    // Sign-in only. Whether this account is an admin is decided by the API from
    // the verified ID token (see handleAuthState), never by comparing emails here.
    await fb.signInWithEmailAndPassword(fb.getAuth(firebaseApp), email, password);

  } catch (err) {
    console.error(err);
    setLoginStatus(friendlyError(err), true);
  } finally {
    adminLoginBtn.disabled = false;
  }
});

// Allow Enter key to submit
adminPasswordInput?.addEventListener("keydown", e => { if (e.key === "Enter") adminLoginBtn?.click(); });
adminEmailInput?.addEventListener("keydown", e => { if (e.key === "Enter") adminPasswordInput?.focus(); });

// ─── Admin logout ─────────────────────────────────────────────────────────────
adminLogout?.addEventListener("click", async () => {
  pendingLoginMessage = { text: "You have been logged out." };
  try {
    const fb = await getFirebase();
    if (fb) await fb.signOut(fb.getAuth(firebaseApp));
  } catch(e) { console.warn(e); }
  stopDashboard();
  hideAdminTopbar();
  showLoginOverlay("You have been logged out.");
});

// ─── Admin session (Firebase Auth state + server-side authorization) ──────────
// The browser only proves *who* the user is (Firebase sign-in). Whether they are
// an admin is decided by the API, which verifies the ID token and its `admin`
// custom claim. Firestore rules enforce the same claim on reads.
async function startAdminSession() {
  try {
    const fb = await withTimeout(getFirebase(), "Firebase did not load. Check your internet.");
    if (!fb) { setLoginStatus("Firebase config missing.", true); return; }
    // The user may have navigated away while the SDK was loading.
    if (routeFromLocation() !== "/admin") return;
    attachAuthListener(fb);
  } catch (err) {
    console.error(err);
    setLoginStatus(friendlyError(err), true);
  }
}

function attachAuthListener(fb) {
  if (authUnsubscribe) return;
  authUnsubscribe = fb.onAuthStateChanged(fb.getAuth(firebaseApp), user => handleAuthState(fb, user));
}

function stopAdminSession() {
  adminCheckId++;
  if (authUnsubscribe) { authUnsubscribe(); authUnsubscribe = null; }
}

async function handleAuthState(fb, user) {
  const checkId = ++adminCheckId;

  if (!user) {
    stopDashboard();
    hideAdminTopbar();
    const msg = pendingLoginMessage;
    pendingLoginMessage = null;
    showLoginOverlay(msg?.text || "Enter your credentials to access the dashboard", !!msg?.isError);
    return;
  }

  setLoginStatus("Verifying admin access…");
  const auth = fb.getAuth(firebaseApp);
  try {
    // Force a refresh so a newly granted or revoked admin claim is picked up.
    const idToken = await user.getIdToken(true);
    const me = await fetchAdminProfile(API_BASE_URL, idToken, { timeoutMs: ADMIN_CHECK_TIMEOUT });
    if (checkId !== adminCheckId) return; // superseded by a newer auth event

    hideLoginOverlay();
    showAdminTopbar(me.email || user.email);
    startDashboard(fb);
  } catch (err) {
    if (checkId !== adminCheckId) return;
    console.error(err);
    if (err.code === "not-admin" || err.code === "unauthorized") {
      pendingLoginMessage = {
        text: err.code === "not-admin"
          ? "Access denied. This account is not an administrator."
          : "Your session is invalid or expired. Please sign in again.",
        isError: true
      };
      await fb.signOut(auth); // triggers handleAuthState(null), which shows the message
    } else {
      // API unreachable/misconfigured: fail closed. Do not show the dashboard.
      stopDashboard();
      hideAdminTopbar();
      showLoginOverlay("Could not verify admin access right now. Please try again.", true);
    }
  }
}

// ─── Admin dashboard (API-driven: it never reads Firestore) ────────────────────
// Bookings, packages and slots are loaded one bounded page at a time from /api/admin/*, and
// every change is an API call the SERVER authorises (verified ID token + admin claim) and audits.
function startDashboard(fb) {
  dashboardAuth = { fb, auth: fb.getAuth(firebaseApp) };
  if (dashboardRunning) return;
  dashboardRunning = true;

  // Created once: it attaches its event listeners a single time.
  dashboard ??= initAdminDashboard({
    api: createAdminApi({
      baseUrl: API_BASE_URL,
      // Always the CURRENT user's token (refreshed by Firebase when needed).
      getIdToken: async () => {
        const user = dashboardAuth?.auth.currentUser;
        if (!user) throw new Error("signed out");
        return user.getIdToken();
      }
    }),
    loadAvailability: date => loadAvailability(API_BASE_URL, date),
    onUnauthorized: () => {
      pendingLoginMessage = { text: "Your session is invalid or expired. Please sign in again.", isError: true };
      dashboardAuth?.fb.signOut(dashboardAuth.auth).catch(e => console.warn(e));
    }
  });
  dashboard.start();
}

function stopDashboard() {
  if (!dashboardRunning) return;
  dashboardRunning = false;
  dashboard?.stop();
}

// ─── Login overlay helpers ────────────────────────────────────────────────────
function showLoginOverlay(msg = "", isError = false) {
  adminLoginOverlay?.classList.add("visible");
  setLoginStatus(msg, isError);
  if (adminPasswordInput) adminPasswordInput.value = "";
}

function hideLoginOverlay() {
  adminLoginOverlay?.classList.remove("visible");
}

function setLoginStatus(msg, isError = false) {
  if (!adminLoginStatus) return;
  adminLoginStatus.textContent = msg;
  adminLoginStatus.style.color = isError ? "#d91f52" : "#686a75";
}

function showAdminTopbar(email) {
  if (adminTopbarArea)  adminTopbarArea.style.display  = "flex";
  if (adminTopbarEmail) adminTopbarEmail.textContent   = email || "";
}

function hideAdminTopbar() {
  if (adminTopbarArea) adminTopbarArea.style.display = "none";
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function friendlyError(err) {
  const m = err?.message || String(err);
  if (m.includes("auth/wrong-password") || m.includes("auth/invalid-credential"))
    return "Incorrect email or password. Double-check and try again.";
  if (m.includes("auth/user-not-found"))
    return "No account found. Create the admin user in Firebase Console → Authentication → Users → Add user.";
  if (m.includes("auth/invalid-email"))
    return "Invalid email address.";
  if (m.includes("auth/too-many-requests"))
    return "Too many attempts. Please wait a few minutes.";
  if (m.includes("auth/unauthorized-domain"))
    return "Domain not authorised. Add it in Firebase Console → Authentication → Settings → Authorized domains.";
  if (m.includes("auth/configuration-not-found") || m.includes("auth/operation-not-allowed"))
    return "Email/Password sign-in is not enabled. Go to Firebase Console → Authentication → Sign-in method → Email/Password → Enable.";
  if (m.includes("permission-denied"))
    return "Firestore rules blocked this. Update rules in Firebase Console → Firestore → Rules (see README).";
  if (m.includes("Firebase: Error") || m.includes("FirebaseError"))
    return m.replace("Firebase: ", "");
  return `Error: ${m}`;
}