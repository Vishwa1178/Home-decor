# Home Decor — Production

Production-ready split of the Home Decor booking site.

```
Home-Decor-Production/
├── frontend/   # React-style Vite app (static site + Firebase Web SDK)
├── backend/    # Express.js REST API
├── README.md
└── DEPLOYMENT_GUIDE.md
```

The original UI and end-user functionality are preserved verbatim. What changed:

- Secrets (Firebase config, admin email) are now sourced from environment variables.
- The frontend is built and served by Vite (Vercel-ready).
- A dedicated Express backend (Render-ready) hosts health checks and REST endpoints and is where any additional server-side logic should live.
- Hardcoded URLs were replaced with `VITE_API_URL` on the frontend.

## Quick start

### Frontend

```bash
cd frontend
cp .env.example .env       # fill in Firebase + VITE_API_URL
npm install
npm run dev                # http://localhost:5173
npm run build              # production build to dist/
npm run preview            # preview the built site
```

### Backend

```bash
cd backend
cp .env.example .env       # fill in PORT, CORS_ORIGIN, etc.
npm install
npm start                  # http://localhost:5000
# Health check:
curl http://localhost:5000/health
```

## API

| Method | Path                    | Description                              |
| ------ | ----------------------- | ---------------------------------------- |
| GET    | `/health`               | Service liveness + metadata              |
| GET    | `/api/bookings/packages`| List decoration packages                 |
| POST   | `/api/bookings/validate`| Server-side validation for booking form  |

Firestore reads/writes still happen through the Firebase Web SDK on the client (unchanged behavior), governed by Firestore security rules in the Firebase console.

## Environment variables

See `frontend/.env.example` and `backend/.env.example`. No secrets are committed. Deployment guidance lives in `DEPLOYMENT_GUIDE.md`.
