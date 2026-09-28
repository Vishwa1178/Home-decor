# Phase 0: Safety net (no behavior change)

Branch: `production-upgrade` (baseline commit `bf32331` on `main` is the untouched original).

## Decision: what we keep

`frontend/` (Vite) + `backend/` (Express) is the application going forward.

The **legacy root app** (`index.html`, `app.js`, `styles.css`, `firebase-config.js`,
`server.js`, root `package.json`) is **kept for now, not deleted**. It is superseded by
`frontend/` (it lacks the mobile nav and theme pages) and should be removed in a later phase
once you confirm it is not deployed anywhere.

## What Phase 0 changed

| Change | Files |
| --- | --- |
| Root `.gitignore` (node_modules, dist, `.env*`, service-account keys, logs) | `.gitignore` |
| Hardened app-level ignores; `.env.example` explicitly allowed | `frontend/.gitignore`, `backend/.gitignore` |
| Env templates | `frontend/.env.example`, `backend/.env.example` |
| Node target `>=18` -> `>=22` (Node 18 and 20 are end-of-life) | `package.json`, `frontend/package.json`, `backend/package.json`, both lockfile root entries, `.nvmrc` |
| Legacy server: allowlist of served files + 400 on malformed URLs | `server.js` |
| Docs: placeholder project id, Node version notes | `DEPLOYMENT_GUIDE.md` |

### Legacy `server.js` fix

Before: served every file under the repo root (verified: `/backend/.env`, `/server.js`,
`/backend/package.json`, `/package.json`, `/DEPLOYMENT_GUIDE.md` all returned 200), and a
malformed URL such as `/%E0%A4%A` threw an uncaught `URIError` and killed the process.

After: only `index.html`, `app.js`, `styles.css`, `firebase-config.js` are served; everything
else behaves like a missing file (404 for paths with an extension, SPA fallback otherwise, as
before). Malformed URLs return 400. Responses for `/`, `/admin`, `/app.js`, `/styles.css`,
`/firebase-config.js`, `/health`, SPA routes and 404s were compared before/after and are
byte-identical.

## Environment variable audit

### Frontend (build-time, all public in the bundle) - `src/firebase-config.js`

| Variable | Required | Notes |
| --- | --- | --- |
| `VITE_FIREBASE_API_KEY` | yes | Public by design; restrict by HTTP referrer |
| `VITE_FIREBASE_AUTH_DOMAIN` | yes | |
| `VITE_FIREBASE_PROJECT_ID` | yes | |
| `VITE_FIREBASE_STORAGE_BUCKET` | warns if empty | Not used by any feature yet |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | yes | |
| `VITE_FIREBASE_APP_ID` | yes | |
| `VITE_FIREBASE_MEASUREMENT_ID` | optional | |
| `VITE_ADMIN_EMAIL` | yes | **Public**; compared client-side and pre-filled on the login form |
| `VITE_API_URL` | optional | Exported as `API_BASE_URL` but **not used by any code yet** |

If any required value is missing at build time, the app builds fine, shows a "config
incomplete" notice, and saves bookings only to `localStorage` (never reaches Firestore).
Tracked for Phase 2.

### Backend (runtime) - `src/config/env.js`

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | In development, error responses include stack traces. Set `production` in deploys |
| `PORT` | `5000` | Render injects it |
| `CORS_ORIGIN` | *(unset = reflect any origin, with credentials)* | Must be set in production |
| `FIREBASE_PROJECT_ID` | `""` | **Read but unused** |
| `ADMIN_EMAIL` | `""` | **Read but unused** |

### Legacy root server - `server.js`

`PORT` (default 5173), `HOST` (default 127.0.0.1).

### Hardcoded values in tracked source

Only the legacy root `firebase-config.js` (Firebase web config + admin email
`awonderonesurprise7@gmail.com`). No private keys, service accounts, tokens or `.env` files
exist anywhere in the repo. **Left as-is on purpose:** the legacy app loads this file directly
in the browser with no build step, so replacing it would break that app. The Firebase web config
is public by design (it ships in every client bundle), and the admin email is already public via
`VITE_ADMIN_EMAIL`. Resolved when the legacy app is removed.

## Build and audit results (Node 22.22.1, npm 9.2.0)

| Check | Result |
| --- | --- |
| `frontend`: `npm ci` + `npm run build` | Pass. 15 modules, 7 HTML entries. Output identical to pre-Phase-0 build |
| `backend`: `npm ci`, boot with `NODE_ENV=production` | Pass. `GET /health` returns `ok` |
| root: `npm run check` | Pass. No dependencies, no lockfile, so no `npm ci` |
| `frontend`: `npm audit --omit=dev` | **0 vulnerabilities** (production deps) |
| `frontend`: `npm audit` | 4: `esbuild` (moderate, dev-server only), `vite` (via esbuild), `nanoid` (high), `postcss` (high). All build tooling, none ships to users. `nanoid`/`postcss` fixable with plain `npm audit fix`; `esbuild`/`vite` need Vite 8 (breaking) |
| `backend`: `npm audit` | 4 moderate: `qs` (array-limit bypass, DoS), `express` (via `qs`), `body-parser` (limit not enforced for invalid value), `morgan` (log forging). All fixable with plain `npm audit fix` |

Not applied in Phase 0 (scope: document only). Recommended for the next phase.

## Remaining risks (not addressed in Phase 0 by design)

- Firestore rules are not in the repo and still unknown (Phase 1).
- Admin auth is client-side only; admin email is public (Phase 1).
- Client-supplied prices and payable amounts; conflicting catalogs; backend is not called
  (Phase 2).
- Booking can be silently lost (`localStorage` fallback); no duplicate or slot protection
  (Phase 2).
- Backend `CORS_ORIGIN` unset reflects any origin; `NODE_ENV` unset leaks stack traces
  (config defaults unchanged in Phase 0; templates document the required values).
- Theme pages reference 30 nonexistent `./images/...` files.
- Legacy root app still present and still contains the committed Firebase config.
