# Deployment Guide

This project ships as two independent services:

- **Frontend** → Vercel (static build produced by Vite)
- **Backend** → Render (Node/Express web service)

Deploy the backend first, then wire its public URL into the frontend as `VITE_API_URL`.

---

## 1. Deploy the backend to Render

1. Push this repository to GitHub (or GitLab/Bitbucket).
2. In [Render](https://dashboard.render.com), click **New → Web Service** and select the repo.
3. Configure:
   - **Root Directory**: `backend`
   - **Runtime**: Node (22 or newer; set `NODE_VERSION=22` if Render does not pick it up from `package.json` `engines`)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
4. Add environment variables (see `backend/.env.example`):

   | Key                  | Example                                                                  |
   | -------------------- | ------------------------------------------------------------------------ |
   | `NODE_ENV`           | `production`                                                             |
   | `PORT`               | *(leave unset — Render provides it)*                                     |
   | `CORS_ORIGIN`        | `https://your-frontend.vercel.app`                                       |
   | `FIREBASE_PROJECT_ID`| `your-project-id` *(required; the server refuses to start in production without it)* |
   | `FIREBASE_SERVICE_ACCOUNT_JSON` | *service-account key JSON, or its base64 (see `backend/.env.example`)* |

5. Deploy. When the service is live, copy its URL, e.g. `https://home-decor-api.onrender.com`, and verify:

   ```bash
   curl https://home-decor-api.onrender.com/health
   ```

---

## 2. Deploy the frontend to Vercel

1. In [Vercel](https://vercel.com/new), import the same repository.
2. Configure the project:
   - **Root Directory**: `frontend`
   - **Framework Preset**: Vite (auto-detected)
   - **Node.js Version**: 22.x (Project Settings → General)
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
3. Add environment variables (see `frontend/.env.example`). All must be prefixed `VITE_`:

   | Key                                | Value                                                    |
   | ---------------------------------- | -------------------------------------------------------- |
   | `VITE_API_URL`                     | `https://home-decor-api.onrender.com` (from step 1)      |
   | `VITE_FIREBASE_API_KEY`            | *from Firebase console → Project settings → Web app*     |
   | `VITE_FIREBASE_AUTH_DOMAIN`        | `your-project.firebaseapp.com`                           |
   | `VITE_FIREBASE_PROJECT_ID`         | `your-project-id`                                        |
   | `VITE_FIREBASE_STORAGE_BUCKET`     | `your-project.appspot.com`                               |
   | `VITE_FIREBASE_MESSAGING_SENDER_ID`| `000000000000`                                           |
   | `VITE_FIREBASE_APP_ID`             | `1:000000000000:web:...`                                 |
   | `VITE_FIREBASE_MEASUREMENT_ID`     | `G-XXXXXXXXXX` *(optional)*                              |

4. Deploy. Vercel will build with `vite build` and serve `dist/`.

---

## 3. Connect frontend to backend

1. After the Vercel deployment succeeds, copy its production URL.
2. On Render, update `CORS_ORIGIN` on the backend to include that URL (comma-separate multiple origins if you also want preview URLs allowed).
3. Redeploy the backend so the new CORS setting takes effect.
4. On Vercel, confirm `VITE_API_URL` points to the Render URL and trigger a redeploy so the value is baked into the static bundle.

---

## 4. Firebase configuration

Firebase rules, indexes and emulator settings are version-controlled in this repo
(`firebase.json`, `firestore.rules`, `firestore.indexes.json`). See `docs/PHASE1.md`
for the full authorization model.

1. **Authentication → Sign-in method**: enable **Email/Password**.
2. **Authentication → Settings → User actions**: turn off **Enable create (sign-up)** if
   your project offers it. Nothing in the app needs public sign-up, and admin status no
   longer depends on it (see below), but there is no reason to leave it open.
3. **Authentication → Settings → Authorized domains**: add your Vercel domain (and
   `localhost` for local dev).
4. **Create the admin user** under **Authentication → Users → Add user**, then grant the
   admin claim from a trusted machine (there is no other way to become an admin):

   ```bash
   cd backend
   # .env needs FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON (or GOOGLE_APPLICATION_CREDENTIALS)
   npm run admin:claim -- admin@yourdomain.com            # grant
   npm run admin:claim -- admin@yourdomain.com --revoke   # revoke (also ends existing sessions)
   ```

   The user must sign in again afterwards. Admin status is the `admin: true` custom claim in
   the user's ID token, verified by the backend and by Firestore rules. Email addresses are
   never used for authorization.
5. **Seed the catalog** (once, from a trusted machine with the same env as the backend):

   ```bash
   cd backend
   npm run catalog:seed            # creates missing categories/packages; never overwrites edits
   npm run catalog:seed -- --dry-run
   npm run catalog:seed -- --overwrite   # deliberate reset to the seed values

   npm run slots:seed              # booking slots: 10:00 AM, 1:00 PM, 4:00 PM, 7:00 PM (capacity 1 each)
   npm run slots:seed -- --dry-run
   ```

   The catalog (`categories`, `packages` in Firestore) is the single source of truth for
   package names, categories, descriptions, prices and enabled/disabled state, and `slots` holds
   the bookable time slots (time, label, capacity, weekdays, enabled). Edit the slot list in
   `backend/data/slots.seed.json` **before** the first `slots:seed` if the initial slots are not what
   you want; afterwards Firestore is the source of truth. The booking form cannot work until both
   are seeded (customers pick a slot; there is no free-form time).
6. **Firestore rules**: deploy `firestore.rules` with the Firebase CLI:

   ```bash
   npx firebase-tools deploy --only firestore:rules,firestore:indexes --project <your-project-id>
   ```

   Also deploy the **Firestore indexes** (the admin dashboard's list queries need them; the emulator
   does not enforce indexes, so a missing one only shows up in production as a 400/`FAILED_PRECONDITION`):

   ```bash
   npx firebase-tools deploy --only firestore:indexes --project <your-project-id>
   ```

   Wait until every index shows **Enabled** in the Firebase console (Firestore → Indexes) before opening
   the admin dashboard. Bookings created before Phase 5 need one back-fill so name search finds them:

   ```bash
   cd backend && npm run bookings:backfill -- --dry-run && npm run bookings:backfill
   ```

   > ⚠ **Deploy order matters.** The rules deny all client writes to `bookings`. Deploy them
   > only **after** the new backend (with `POST /api/bookings`) and the new frontend are live and
   > the catalog is seeded. Anything that still writes bookings from the browser (an old cached
   > frontend, or the legacy root app in this repo) will get `permission-denied` once the rules are
   > live. Rolling the rules back is a one-command redeploy of the previous `firestore.rules`.
   >
   > The rules also stop browsers reading `bookings`, `slotBookings`, `blockedDates` and `auditLogs`
   > altogether (even admins): the admin dashboard uses the backend API only.

---

## 5. Verify the deployment

- **Backend health**: `curl https://<render-url>/health` returns `{"status":"ok",...}`.
- **Backend API**: `curl https://<render-url>/api/bookings/packages` returns the package list.
- **Frontend**: open the Vercel URL and confirm:
  - Home page renders with all styling intact.
  - Booking form submits (writes appear in Firestore `bookings`).
  - `/admin` route loads, the admin can log in and see live bookings, and a non-admin account is
    refused ("Access denied").
- **Catalog**: `curl https://<render-url>/api/packages` returns the packages with their prices.
- **Availability**: `curl "https://<render-url>/api/availability?date=YYYY-MM-DD"` (a future date) lists the slots with `remaining` seats.
- **Booking**: submit a booking on the site; a document appears in Firestore `bookings` with the server-calculated `packagePrice` and `payableAmount`.
- **Admin API**: `curl https://<render-url>/api/admin/me` returns `401`; with an admin's ID token it returns `200`.
- **CORS**: browser devtools show no CORS errors on requests to the Render URL.
- **Env vars**: no `Missing environment variable` warnings in the browser console.

---

## Local development

Run backend and frontend in two terminals:

```bash
# Terminal 1
cd backend && cp .env.example .env && npm install && npm start

# Terminal 2
cd frontend && cp .env.example .env && npm install && npm run dev
```

Then open http://localhost:5173.
