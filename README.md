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
| GET    | `/api/packages`         | The central package catalog (active packages, prices, categories) |
| GET    | `/api/packages/:id`     | One active package |
| GET    | `/api/availability?date=YYYY-MM-DD` | Bookable time slots for a date with remaining capacity (never cached) |
| POST   | `/api/bookings`         | Create a booking (idempotent on `requestId`; server-side pricing; reserves a slot seat in the same transaction) |
| POST   | `/api/bookings/validate`| Dry run of the above: validates and quotes, writes nothing |
| GET    | `/api/bookings/packages`| Alias of `GET /api/packages` (compatibility) |
| GET    | `/api/admin/me`         | Admin check: needs `Authorization: Bearer <Firebase ID token>` with the `admin` custom claim (401 no/invalid token, 403 not admin) |
| GET/PATCH/POST | `/api/admin/bookings…`, `/stats` | Admin: paginated/filterable/searchable bookings, detail, status changes, reschedule (all audited) |
| GET/POST/PATCH | `/api/admin/catalog`, `/packages…` | Admin: list, add, edit, re-price, enable/disable packages (audited) |
| GET/POST/PATCH/PUT/DELETE | `/api/admin/slots…`, `/blocked-dates…` | Admin: slots, capacity, blocked dates, booked capacity (audited) |
| GET    | `/api/admin/audit`      | Admin: the audit trail (read-only) |

Bookings are created only by the backend (`POST /api/bookings`, Firebase Admin SDK); the browser never writes to Firestore and never sends a price. The admin dashboard reads live bookings through the Firebase Web SDK. Access is governed by the version-controlled `firestore.rules` and by the `admin` custom claim (see `docs/PHASE1.md`). See `docs/PHASE2.md` for the catalog and booking design and `docs/PHASE3.md` for the payment model: the customer picks `paymentOption` `HALF` (50%, rounded up to whole rupees) or `FULL`, and the server calculates `totalAmount`, `requiredAmount` and `remainingAmount`. No payment provider is integrated yet: every booking is `paymentStatus: PENDING` with nothing paid. See `docs/PHASE5.md` for the admin management system (paginated bookings, packages, slots, audit trail). See `docs/PHASE4.md` for time slots: customers pick one of the backend's slots (no free-form time), and capacity is reserved in the booking transaction so a slot can never be double-booked.

## Environment variables

See `frontend/.env.example` and `backend/.env.example`. No secrets are committed. Deployment guidance lives in `DEPLOYMENT_GUIDE.md`.
