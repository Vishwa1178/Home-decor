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
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
4. Add environment variables (see `backend/.env.example`):

   | Key                  | Example                                                                  |
   | -------------------- | ------------------------------------------------------------------------ |
   | `NODE_ENV`           | `production`                                                             |
   | `PORT`               | *(leave unset — Render provides it)*                                     |
   | `CORS_ORIGIN`        | `https://your-frontend.vercel.app`                                       |
   | `FIREBASE_PROJECT_ID`| `home-decor-74a7c`                                                        |
   | `ADMIN_EMAIL`        | `admin@example.com`                                                      |

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
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
3. Add environment variables (see `frontend/.env.example`). All must be prefixed `VITE_`:

   | Key                                | Value                                                    |
   | ---------------------------------- | -------------------------------------------------------- |
   | `VITE_API_URL`                     | `https://home-decor-api.onrender.com` (from step 1)      |
   | `VITE_ADMIN_EMAIL`                 | `admin@example.com`                                      |
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

Firebase itself is configured in the Firebase console — no code changes required:

1. **Authentication → Sign-in method**: enable **Email/Password**.
2. **Authentication → Users**: create the admin account matching `VITE_ADMIN_EMAIL` / `ADMIN_EMAIL`.
3. **Authentication → Settings → Authorized domains**: add your Vercel domain (and `localhost` for local dev).
4. **Firestore → Rules**: publish rules that allow public creates on `bookings` and restrict reads to the admin, e.g.:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /bookings/{id} {
         allow create: if true;
         allow read, update, delete:
           if request.auth != null
              && request.auth.token.email == "admin@example.com";
       }
     }
   }
   ```

---

## 5. Verify the deployment

- **Backend health**: `curl https://<render-url>/health` returns `{"status":"ok",...}`.
- **Backend API**: `curl https://<render-url>/api/bookings/packages` returns the package list.
- **Frontend**: open the Vercel URL and confirm:
  - Home page renders with all styling intact.
  - Booking form submits (writes appear in Firestore `bookings`).
  - `/admin` route loads, admin can log in and see live bookings.
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
