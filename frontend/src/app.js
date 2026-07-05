import { firebaseConfig, ADMIN_EMAIL } from "./firebase-config.js";

// ─── DOM refs ────────────────────────────────────────────────────────────────
const pages           = { "/": document.querySelector('[data-page="home"]'), "/admin": document.querySelector('[data-page="admin"]') };
const publicNav       = document.querySelector("#publicNav");
const publicActions   = document.querySelector("#publicActions");
const siteFooter      = document.querySelector(".footer");
const mobileCta       = document.querySelector(".mobile-cta");
const navLinks        = document.querySelectorAll("[data-route]");

// booking form
const bookingForm         = document.querySelector("#bookingForm");
const bookingStatus       = document.querySelector("#bookingStatus");
const packageSelect       = document.querySelector("#packageSelect");
const packagePrice        = document.querySelector("#packagePrice");
const payableAmountInput  = document.querySelector("#payableAmountInput");
const bookingModal        = document.querySelector("#bookingModal");
const closeBooking        = document.querySelector("#closeBooking");
const selectedPackageName = document.querySelector("#selectedPackageName");
const selectedPackagePrice= document.querySelector("#selectedPackagePrice");
const payableAmount       = document.querySelector("#payableAmount");
const firebaseAlert       = document.querySelector("#firebaseAlert");
const bookingSubmitBtn    = bookingForm?.querySelector('button[type="submit"]');
const bookingDateInput    = bookingForm?.querySelector('input[name="date"]');

// admin dashboard
const bookingRows   = document.querySelector("#bookingRows");
const totalBookings = document.querySelector("#totalBookings");
const todayBookings = document.querySelector("#todayBookings");
const adminStatus   = document.querySelector("#adminStatus");
const bookingSearch = document.querySelector("#bookingSearch");
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
let unsubscribeBookings = null;
let latestBookings = [];
let lastBookingTrigger;
const FB_TIMEOUT = 15000;

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
    showLoginOverlay("Enter your credentials to access the dashboard");
    // Pre-fill email for convenience
    if (adminEmailInput && !adminEmailInput.value) {
      adminEmailInput.value = ADMIN_EMAIL;
    }
  } else {
    hideLoginOverlay();
    hideAdminTopbar();
    stopWatchingBookings();
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
setMinimumBookingDate();
renderFirebaseNotice();

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

document.querySelectorAll(".nav-dropdown a[data-package], .mnav-quick-thumb[data-package]").forEach(link => {
  link.addEventListener("click", e => {
    e.preventDefault();
    lastBookingTrigger = link;
    openBooking(link.dataset.package, Number(link.dataset.price || 999));
    closeMobileNav();
    navItems.forEach(item => closeDropdown(item));
  });
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 900 && document.documentElement.classList.contains("nav-open")) {
    closeMobileNav();
  }
});

// ─── Booking triggers ─────────────────────────────────────────────────────────
document.querySelectorAll("[data-open-booking]").forEach(btn => {
  btn.addEventListener("click", () => {
    lastBookingTrigger = btn;
    openBooking(btn.dataset.package || "Birthday Decoration", Number(btn.dataset.price || 999));
  });
});

document.querySelectorAll(".package-card").forEach(card => {
  card.addEventListener("click", e => {
    if (e.target.closest("button")) return;
    const btn = card.querySelector("[data-open-booking]");
    if (btn) openBooking(btn.dataset.package || "Birthday Decoration", Number(btn.dataset.price || 999));
  });
});

document.querySelectorAll("[data-filter]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-filter]").forEach(b => b.classList.toggle("active", b === btn));
    const f = btn.dataset.filter;
    document.querySelectorAll(".gallery-grid img").forEach(img => { img.hidden = f !== "all" && img.dataset.category !== f; });
  });
});

document.querySelectorAll('input[name="paymentType"]').forEach(i => i.addEventListener("change", updatePayableAmount));
closeBooking?.addEventListener("click", closeBookingModal);
bookingModal?.addEventListener("click", e => { if (e.target === bookingModal) closeBookingModal(); });
window.addEventListener("keydown", e => { if (e.key === "Escape") closeBookingModal(); });

// ─── Booking modal ────────────────────────────────────────────────────────────
function openBooking(packageName, price) {
  packageSelect.value = packageName;
  packagePrice.value  = String(price);
  selectedPackageName.textContent  = packageName;
  selectedPackagePrice.textContent = formatMoney(price);
  document.querySelectorAll(".occasion-card").forEach(c => c.classList.toggle("selected", c.dataset.package === packageName));
  updatePayableAmount();
  bookingModal.classList.add("open");
  bookingModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  bookingForm.querySelector("input[name='name']").focus();
}

function closeBookingModal() {
  bookingModal?.classList.remove("open");
  bookingModal?.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  lastBookingTrigger?.focus?.();
}

function updatePayableAmount() {
  const price = Number(packagePrice.value || 0);
  const type  = bookingForm.querySelector('input[name="paymentType"]:checked')?.value || "Advance";
  const amt   = type === "Full Payment" ? price : Math.min(500, price);
  payableAmount.textContent    = `Payable now: ${formatMoney(amt)}`;
  payableAmountInput.value     = String(amt);
}

function setMinimumBookingDate() {
  if (!bookingDateInput) return;
  const t = new Date();
  t.setMinutes(t.getMinutes() - t.getTimezoneOffset());
  bookingDateInput.min = t.toISOString().slice(0, 10);
}

// ─── Firebase init ────────────────────────────────────────────────────────────
function hasFirebaseConfig() {
  return ["apiKey","authDomain","projectId","messagingSenderId","appId"].every(k => {
    const v = firebaseConfig[k];
    return v && !v.startsWith("PASTE_");
  });
}

function renderFirebaseNotice() {
  if (!firebaseAlert) return;
  if (hasFirebaseConfig()) {
    firebaseAlert.textContent = "✓ Firebase connected — bookings save to Firestore.";
    firebaseAlert.classList.add("ready");
  } else {
    firebaseAlert.textContent = "⚠ Firebase config incomplete. Add apiKey, messagingSenderId and appId.";
  }
}

async function getFirebase() {
  if (!hasFirebaseConfig()) return null;
  if (firebaseApp && firebaseModules) return { app: firebaseApp, ...firebaseModules };

  const [appMod, fsMod, authMod] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js"),
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js"),
  ]);

  firebaseApp     = appMod.initializeApp(firebaseConfig);
  firebaseModules = { ...fsMod, ...authMod };
  return { app: firebaseApp, ...firebaseModules };
}

function withTimeout(p, msg, ms = FB_TIMEOUT) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(msg)), ms))]);
}

// ─── Submit booking → Firestore ───────────────────────────────────────────────
bookingForm?.addEventListener("submit", async e => {
  e.preventDefault();
  bookingStatus.textContent = "";
  bookingSubmitBtn.disabled = true;
  bookingSubmitBtn.textContent = "Saving…";

  const data = Object.fromEntries(new FormData(bookingForm));

  try {
    const fb = await withTimeout(getFirebase(), "Firebase SDK did not load. Check your internet and try again.");

    if (!fb) {
      saveLocalBooking(data);
      bookingStatus.textContent = "⚠ Saved locally (Firebase not configured).";
      bookingForm.reset();
      return;
    }

    const db = fb.getFirestore(firebaseApp);
    await fb.addDoc(fb.collection(db, "bookings"), {
      ...data,
      createdAt: fb.serverTimestamp(),
      status: "Pending"
    });

    bookingStatus.textContent = "✅ Booking submitted! Admin will confirm your slot soon.";
    bookingStatus.style.color = "#0f6b37";
    bookingForm.reset();
    setTimeout(() => closeBookingModal(), 2200);

  } catch (err) {
    console.error(err);
    saveLocalBooking(data);
    bookingStatus.textContent = "⚠ " + friendlyError(err);
    bookingStatus.style.color = "#d91f52";
  } finally {
    bookingSubmitBtn.disabled = false;
    bookingSubmitBtn.textContent = "Submit Booking";
  }
});

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

    const auth = fb.getAuth(firebaseApp);

    // Sign in with email + password
    const cred = await fb.signInWithEmailAndPassword(auth, email, password);
    const user = cred.user;

    // Check it's the authorised admin email
    if (user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      await fb.signOut(auth);
      setLoginStatus(`Access denied for ${user.email}.`, true);
      return;
    }

    // ✅ Authorised — enter dashboard
    hideLoginOverlay();
    showAdminTopbar(user.email);
    loadBookings(fb);

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
  try {
    const fb = await getFirebase();
    if (fb) await fb.signOut(fb.getAuth(firebaseApp));
  } catch(e) { console.warn(e); }
  stopWatchingBookings();
  latestBookings = [];
  renderBookings([]);
  hideAdminTopbar();
  showLoginOverlay("You have been logged out.");
  if (adminEmailInput) adminEmailInput.value = ADMIN_EMAIL;
});

bookingSearch?.addEventListener("input", () => renderBookings(latestBookings));

// ─── Load & watch bookings from Firestore (real-time) ─────────────────────────
function loadBookings(fb) {
  adminStatus.textContent = "Connecting…";
  adminStatus.style.color = "#686a75";
  const db = fb.getFirestore(firebaseApp);

  const q = fb.query(
    fb.collection(db, "bookings"),
    fb.orderBy("createdAt", "desc")
  );

  unsubscribeBookings = fb.onSnapshot(
    q,
    snapshot => {
      latestBookings = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      adminStatus.textContent = "● Live";
      adminStatus.style.color = "#0f6b37";
      renderBookings(latestBookings);
    },
    err => {
      console.error(err);
      adminStatus.textContent = "Error loading";
      adminStatus.style.color = "#d91f52";
      bookingRows.innerHTML = `<tr><td colspan="9" style="color:#d91f52;padding:20px;">${escHtml(friendlyError(err))}</td></tr>`;
    }
  );
}

function stopWatchingBookings() {
  if (unsubscribeBookings) { unsubscribeBookings(); unsubscribeBookings = null; }
}

// ─── Render booking table ─────────────────────────────────────────────────────
function renderBookings(bookings) {
  const q = bookingSearch?.value.trim().toLowerCase() || "";
  const list = q ? bookings.filter(b => bookingMatchesSearch(b, q)) : bookings;

  totalBookings.textContent = bookings.length;
  const today = new Date().toISOString().slice(0, 10);
  todayBookings.textContent = bookings.filter(b => b.date === today).length;

  if (!list.length) {
    bookingRows.innerHTML = `<tr><td colspan="9" style="padding:30px;text-align:center;color:#686a75;">${bookings.length ? "No bookings match your search." : "No bookings yet."}</td></tr>`;
    return;
  }

  bookingRows.innerHTML = list.map(b => {
    const createdAt = b.createdAt?.toDate?.()
      ? b.createdAt.toDate().toLocaleString("en-IN", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" })
      : "—";
    const statusBadge = statusBadgeHtml(b.status || "Pending");
    return `
    <tr>
      <td><strong>${escHtml(b.name || "Guest")}</strong><br/><small style="color:#686a75;">${escHtml(b.email || "—")}</small></td>
      <td><a href="tel:${escHtml(b.phone || "")}">${escHtml(b.phone || "—")}</a></td>
      <td><strong>${escHtml(b.package || "Custom")}</strong><br/><small>${formatMoney(b.packagePrice)}</small></td>
      <td><strong>${escHtml(b.paymentType || "—")}</strong><br/><small>${formatMoney(b.payableAmount)} via ${escHtml(b.paymentMethod || "—")}</small></td>
      <td>${escHtml(b.date || "—")}<br/><small>${escHtml(b.time || "")}</small></td>
      <td>${escHtml(b.balloonColor || "—")}</td>
      <td>${escHtml(b.address || "—")}</td>
      <td>${escHtml(b.notes || "—")}</td>
      <td>${statusBadge}<br/><small style="color:#686a75;font-size:11px;">${createdAt}</small></td>
    </tr>`;
  }).join("");
}

function statusBadgeHtml(status) {
  const colors = {
    "Pending":   { bg: "#fff7e6", text: "#b45309" },
    "Confirmed": { bg: "#ecfdf5", text: "#0f6b37" },
    "Cancelled": { bg: "#fef2f2", text: "#b91c1c" },
  };
  const c = colors[status] || { bg: "#f3f4f6", text: "#374151" };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;background:${c.bg};color:${c.text};">${escHtml(status)}</span>`;
}

function bookingMatchesSearch(b, q) {
  return [b.name, b.phone, b.email, b.package, b.occasion, b.balloonColor, b.address, b.notes, b.date]
    .some(v => String(v || "").toLowerCase().includes(q));
}

// ─── Login overlay helpers ────────────────────────────────────────────────────
function showLoginOverlay(msg = "") {
  adminLoginOverlay?.classList.add("visible");
  setLoginStatus(msg, false);
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

// ─── Local fallback ───────────────────────────────────────────────────────────
function saveLocalBooking(data) {
  try {
    const key = "decorMySpaceBookings";
    const arr = JSON.parse(localStorage.getItem(key) || "[]");
    arr.unshift({ ...data, id: crypto.randomUUID?.() || String(Date.now()), createdAt: new Date().toISOString() });
    localStorage.setItem(key, JSON.stringify(arr.slice(0, 50)));
  } catch(e) { console.warn("localStorage failed", e); }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function formatMoney(n) { return `Rs. ${Number(n || 0).toLocaleString("en-IN")}`; }

function escHtml(v) {
  return String(v)
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

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