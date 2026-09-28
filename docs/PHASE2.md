# Phase 2: One catalog, bookings behind the backend

> **Superseded in part by Phase 3 (`docs/PHASE3.md`):** the payment fields and amount rules below
> (`paymentType`, `payableAmount`, `balanceAmount`, the flat Rs. 500 advance and `ADVANCE_AMOUNT`) were replaced by
> `paymentOption` HALF/FULL with server-calculated `totalAmount`/`requiredAmount`/`remainingAmount`. Everything else
> here (catalog, idempotency, validation, rate limiting, error shapes) still applies.

```
Frontend ─ GET /api/packages ─▶ Backend ─▶ Firestore categories/, packages/   (public catalog)
Frontend ─ POST /api/bookings {requestId, packageId, customer details}
             ▼
          Backend: rate limit → Zod validation → Firestore transaction:
                     bookings/{requestId} exists?  → replay (same payload) / 409 (different)
                     read packages/{packageId} → active? → price
                     calculate amounts on the server → create booking
```

The browser never writes to Firestore and never sends a price. Razorpay is not integrated.

## The catalog

Firestore is the single source of truth (`categories/{id}`, `packages/{id}`), so an admin can later
add/edit/re-price/enable/disable packages without a deploy. The initial content is
`backend/data/catalog.seed.json`, **extracted from the existing pages (no new prices)**; load it with
`npm run catalog:seed` (creates missing documents only; `--overwrite` resets; `--dry-run` previews).

Package document: `name`, `category` (a category id), `price` (integer rupees), `description`,
`image` (URL or null), `active`, `featured`, `sortOrder`, `createdAt`, `updatedAt`.
Category document: `name`, `description`, `active`, `sortOrder`. Schemas: `backend/src/schemas/catalog.schema.js`
(the future admin endpoints should validate against the same schema).

### Where the 32 packages came from

- 25 items on the six theme pages (identical to the home-page nav dropdown, no conflicts).
- 7 items that exist only on the home page: 5 "Trending" cards, "Festival Decoration", "Custom Home Decoration".
- 5 name variants merged into the matching theme-page item at the same price:
  "Birthday/Anniversary/Baby Shower/House Warming/Engagement Decoration" → "…Decor".
- Category descriptions are the hero text of each theme page. Package descriptions are empty (none existed).
- **To confirm:** categories inferred for Luxury Balloon Canopy and Princess Theme (→ Birthday),
  Festival Decoration (→ Festival), Custom Home Decoration (→ new "Custom" category).
- Not catalog data (left in the HTML): star ratings, review counts, the "Popular" tag.

### How the pages use it

Buttons and cards say *which* package (`data-package-id="birthday-decor"`); price labels say which
package they show (`data-price-of="birthday-decor"`, optional `data-price-prefix="From "`). `catalog.js`
fills the labels from `GET /api/packages` and hides packages that are not in it (disabled). The static
label text in the HTML equals the seed price and is only a loading/failure fallback; a test enforces that.
If the catalog cannot be loaded, the page shows a notice and booking is disabled (it never guesses a price).
`GET /api/packages` responds `Cache-Control: no-cache` + ETag (browsers revalidate; unchanged catalogs cost a 304).

## Booking API

`POST /api/bookings` (JSON, max 20 KB). Fields: `requestId` (UUID v4), `packageId`, `name`, `phone`,
`email?`, `occasion?`, `date` (YYYY-MM-DD, not in the past in `BUSINESS_TIMEZONE`, ≤ 2 years ahead), `time`
(HH:MM), `balloonColor?`, `address`, `notes?`, `paymentType` (Advance | Full Payment, default Advance),
`paymentMethod` (Razorpay Online | UPI | Cash after confirmation). Unknown fields, including
`packagePrice`, `payableAmount`, `status`, `createdAt`, are stripped and never stored.

| Result | When |
| --- | --- |
| `201 { booking }` | created |
| `200 { booking }` + `Idempotent-Replay: true` | same `requestId` and same payload (safe retry) |
| `400 VALIDATION_ERROR` + `issues[{field,message}]` | bad input; `INVALID_JSON` for a malformed body |
| `409 IDEMPOTENCY_KEY_REUSED` | same `requestId`, different payload |
| `413 PAYLOAD_TOO_LARGE` | body over 20 KB |
| `422 PACKAGE_NOT_FOUND` / `PACKAGE_INACTIVE` | unknown or disabled package |
| `429 RATE_LIMITED` (+ `Retry-After`) | more than 10 requests / 15 min / IP (configurable) |
| `503 SERVICE_UNAVAILABLE` | Firestore/credentials problem; never reported as success |

All errors: `{ error, code, message, issues? }`. The receipt contains no personal data.

Amounts: `advance = min(ADVANCE_AMOUNT, price)` (default 500, the value the site already used),
`Full Payment = price`; `balanceAmount = price − payable`; whole rupees, currency `INR`
(`backend/src/utils/pricing.js`, the only place amounts are calculated).

Stored booking = the fields the admin dashboard already reads (`name, email, phone, package,
packagePrice, paymentType, payableAmount, paymentMethod, date, time, balloonColor, address, notes,
status, createdAt`) plus `packageId, packageCategory, balanceAmount, currency, occasion, requestId,
requestFingerprint, source`. `package`/`packagePrice` are snapshots: later catalog edits never rewrite history.

### Idempotency

The booking document ID is the `requestId`. The client reuses one `requestId` while the form content is
unchanged (so a retry after a lost response cannot create a second booking) and creates a new one when any
field changes or after success. Verified in a real browser: the server created the booking, the reply was
dropped, the customer pressed Submit again, and there was still exactly one booking.

## Changes

| Area | Files |
| --- | --- |
| Catalog | `backend/data/catalog.seed.json`, `scripts/seed-catalog.js`, `src/schemas/catalog.schema.js`, `src/services/catalog.service.js`, `controllers/catalog.controller.js`, `routes/catalog.routes.js` |
| Bookings | `src/schemas/booking.schema.js` (Zod), `src/services/bookings.service.js` (rewritten; old 6-item price list removed), `controllers/bookings.controller.js`, `routes/bookings.routes.js`, `src/utils/{pricing,dates,errors}.js` |
| Cross-cutting | `middleware/rateLimit.js`, `middleware/errorHandler.js`, `config/env.js`, `config/firebaseAdmin.js` (`getDb`), `app.js` (20 KB body limit), `middleware/auth.js` (error `code`) |
| Rules | `firestore.rules`: active-only public catalog reads, still no client writes |
| Frontend | `src/catalog.js`, `src/bookingApi.js`, `src/bookingModal.js` (new, shared); `src/app.js`, `src/theme_booking.js` (simplified); `index.html` + 6 theme pages (data attributes, hidden inputs) |
| Docs/env | `.env.example`, `DEPLOYMENT_GUIDE.md`, `README.md` |
| Dependencies | `zod`, `express-rate-limit` |

Removed from the frontend booking path (because the backend now owns it): the direct Firestore `addDoc`,
the Firebase SDK load on public pages, and the silent `localStorage` "saved locally" fallback (bookings that
failed were stored where nobody could ever read them). Failures now show an error and keep the form so the
customer can retry. The legacy root app is untouched and still writes to Firestore directly.

## Tests

```bash
cd backend
npm test                 # 118 unit tests (no services)
npm run test:emulator    # 88 tests against the Firestore/Auth emulators
```

Covered: package retrieval; booking creation (server price, snapshots, timestamps, dashboard fields);
client-modified prices/status ignored; unknown, disabled and malformed packages; 23 validation cases;
duplicate requests (sequential, 15 concurrent, changed payload, replay after price change/disable);
price read inside the transaction vs. a stale catalog cache; rate limits; error shapes; Firestore failure → 503;
seed script (create/skip/overwrite/dry-run, never clobbers admin edits); rules for the public catalog;
consistency of every page with the catalog; the client modules. A mutation check (idempotency guard disabled)
made exactly the 4 idempotency tests fail.

Also run in a real Chrome against the real backend + Firestore emulator (script kept outside the repo; needs
Chrome): 31 checks, including catalog-driven prices and hiding, the full booking flow on the home page and a
theme page, DOM-tampered price fields never sent, no Firebase requests on public pages, lost-reply retry,
disabled-package error + catalog refresh, server validation messages, catalog outage (notice, submit disabled).
That run found and fixed a real bug: `max-age=30` on the catalog let browsers show stale prices/packages.

Not covered by automated tests: the admin dashboard in a browser (needs your real Firebase project); real
Firestore (only the emulator).

## Remaining risks

- **Stale price on an open page.** A customer who loaded the page before an admin price change sees the old price
  but is billed the current one (the server never uses the displayed price). Recommended follow-up: the client
  echoes the price it *displayed* and the server answers `409 PRICE_CHANGED` if it differs (a staleness check, not
  a trusted price), and/or show the confirmed amounts in the success message.
- No slot/capacity rule: two customers can book the same date and time (needs your business rule).
- Different `requestId`s with identical content create separate bookings (double-clicks are covered by the
  disabled button and the tracker; a customer re-typing the form is not).
- Rate limiting is in-memory per instance and per IP (fine for one Render instance; needs a shared store to scale
  out; many customers behind one NAT share a limit).
- Deploy order (see `DEPLOYMENT_GUIDE.md`): seed the catalog and ship backend + frontend **before** deploying
  `firestore.rules`; the legacy root app breaks under the new rules.
- Admin-editing endpoints for the catalog do not exist yet (edit Firestore directly for now); cache TTL means the
  public list can lag an edit by up to `CATALOG_CACHE_TTL_MS` (30 s), bookings never lag.
- 6 moderate `npm audit` findings remain in the backend (see the Phase 2 summary).
