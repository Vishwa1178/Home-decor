# Phase 1: Secure Firebase, Firestore and admin authentication

> Superseded in part by Phase 5 (`docs/PHASE5.md`): the dashboard no longer reads Firestore at all, and `firestore.rules` now denies every client read of bookings (admins included). The sign-in and `admin` custom-claim design below is unchanged.

Booking behavior, pricing, payments and the UI are unchanged. Only how *admin* access is decided
changed, plus version-controlled Firestore rules.

## Authorization model

```
Admin browser ── Firebase Auth sign-in ──▶ ID token (contains custom claim admin:true)
      │
      ├── GET /api/admin/me  (Authorization: Bearer <ID token>)
      │        backend: Admin SDK verifyIdToken (signature, expiry, audience, revocation)
      │                 then requires claims.admin === true
      │        401 no/invalid/expired/revoked token · 403 valid but not admin · 200 admin
      │        503 verification unavailable (fails closed)
      │
      └── Firestore onSnapshot(bookings)   allowed by rules only if token.admin == true
```

Never trusted: an email address (frontend or token), an `admin` flag from the frontend, request
headers/query/body hints, `localStorage`. The dashboard opens only after the API answers 200.
Firebase persists the sign-in session itself; `onAuthStateChanged` re-verifies with the API on
every page load and on every sign-in/out, and a `permission-denied` from Firestore signs the user
out.

The claim can only be set with the Admin SDK, by an operator:

```bash
cd backend
npm run admin:claim -- someone@example.com           # grant
npm run admin:claim -- someone@example.com --revoke  # revoke + revoke refresh tokens
```

## Firestore rules (`firestore.rules`)

| Path | Client read | Client write |
| --- | --- | --- |
| `bookings/{id}` | `request.auth.token.admin == true` only | never (create/update/delete all denied) |
| `packages/{id}` | public | never |
| `availability/{id}` | public | never |
| anything else | denied | denied |

Backend writes use the Admin SDK, which bypasses rules. `packages` and `availability` are reserved
for Phase 2; `availability` must only ever hold date/slot flags, never customer data.

> ⚠ **(Superseded by Phase 2, see `docs/PHASE2.md`.)** Do not deploy `firestore.rules` before Phase 2. The booking form still calls `addDoc()` from
> the browser (`frontend/src/app.js`, `frontend/src/theme_booking.js`). Under these rules that fails
> with `permission-denied` and the form falls back to a `localStorage` copy nobody reads. Deploy the
> rules together with the Phase 2 backend booking endpoint. Nothing was deployed by this phase.

## Changes

| Area | Files |
| --- | --- |
| Firebase config | `firebase.json`, `firestore.rules`, `firestore.indexes.json` (new) |
| Admin SDK + token verification | `backend/src/config/firebaseAdmin.js`, `services/auth.service.js`, `middleware/auth.js` (new) |
| Admin route | `backend/src/routes/admin.routes.js`, `controllers/admin.controller.js` (new); `routes/index.js` |
| Operator tool | `backend/scripts/set-admin-claim.js` (new) |
| Backend config | `backend/src/config/env.js`: removed `ADMIN_EMAIL`; added `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_CHECK_REVOKED`; production refuses to start without `FIREBASE_PROJECT_ID` or with `FIREBASE_AUTH_EMULATOR_HOST` set |
| Frontend | `frontend/src/app.js` (auth-state handling, no email check, no email pre-fill), `frontend/src/adminApi.js` (new), `frontend/src/firebase-config.js` (removed `ADMIN_EMAIL`/`VITE_ADMIN_EMAIL`) |
| Env templates / docs | both `.env.example`, `DEPLOYMENT_GUIDE.md`, `README.md` |
| Dependencies | backend: `firebase-admin`; dev: `@firebase/rules-unit-testing`, `firebase` |
| Tests | `backend/tests/unit/auth.test.js`, `backend/tests/emulator/{rules,auth,adminApi}.test.js` |

The **legacy root app is untouched** and still uses the old email check and the committed admin
email. It is superseded by `frontend/` and slated for removal.

## Environment variables (changes)

- Removed: `VITE_ADMIN_EMAIL` (frontend), `ADMIN_EMAIL` (backend). Both were the mechanism this phase replaces.
- Backend: `FIREBASE_PROJECT_ID` (now used, required in production), `FIREBASE_SERVICE_ACCOUNT_JSON`
  (JSON or base64) or `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_CHECK_REVOKED` (default on in production).
- Frontend: `VITE_API_URL` is now required for the admin dashboard (it fails closed without it).

## Running the tests

```bash
cd backend
npm test                 # 33 unit tests, no external services
npm run test:emulator    # 47 tests against Firebase Auth + Firestore emulators
                         # needs Java 21+; downloads firebase-tools@15.31.0 via npx
```

Emulator suites exercise: the real `firestore.rules` for unauthenticated / signed-in / email-only /
malformed-claim / admin identities; real Auth-emulator ID tokens through the real Admin SDK, the real
Express app and the real `set-admin-claim.js`; and the frontend's `adminApi.js` against the real backend.

Limitations of the tests:

- The Auth emulator issues **unsigned** tokens, so signature verification against Google's certificates
  is not covered by the suite. It was checked separately by running the backend in production mode
  (no emulator) and sending forged `RS256` and `alg: none` tokens claiming `admin: true`: both got 401.
- Token revocation compares `auth_time` with the revocation time at **one-second** granularity. A token
  issued in the same second as the revocation is not treated as revoked. Irrelevant in practice, but it
  is why the revoke test waits 2 s.
- Revocation checks (`FIREBASE_CHECK_REVOKED`) need service-account credentials in production.
- The browser flow (login form → `onAuthStateChanged` → dashboard) is not covered by automated tests: the
  page loads the Firebase SDK from Google's CDN against a real project. Manual checklist below.

## Manual browser checklist (needs your real Firebase project)

1. Signed out, open `/admin`: login overlay ("Enter your credentials…"), email field empty.
2. Sign in as a user **without** the claim: "Access denied. This account is not an administrator.", signed out again.
3. Grant the claim, sign in again: dashboard opens, bookings load, top bar shows the email.
4. Refresh `/admin`: "Checking session…" then the dashboard (session restored, re-verified by the API).
5. Logout: overlay "You have been logged out."
6. Stop the API (or unset `VITE_API_URL`) and reload `/admin`: dashboard stays hidden, "Could not verify admin access right now."

## Remaining risks

- Rules are not deployed (see the warning above); until then the console's current rules apply. If they
  are still the old documented ones, `create: if true` and email-based admin reads remain live.
- Public sign-up: if "Enable create (sign-up)" is on, strangers can create accounts. They get no claim, so
  they can't read bookings or pass the API check, but turn it off anyway.
- Admin login now depends on the API being up (Render free-tier cold starts can take ~30 s; the check waits up to 30 s).
- No rate limiting on `/api/admin/me` yet (Phase 2).
- Backend `CORS_ORIGIN` unset still reflects any origin; harmless for bearer-token auth but should be set.
- Legacy root app still contains the old email-based admin check and the committed admin email.
- Booking writes are still client-side and client-priced until Phase 2.
- npm audit findings, see the Phase 1 summary.
