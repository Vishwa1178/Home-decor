# Phase 5: The admin dashboard becomes a management system

Bookings, packages and slots can now be managed from `/admin`. The dashboard **no longer reads Firestore**:
it asks backend APIs for one bounded page at a time, and every change is executed on the server behind the admin
check, inside a Firestore transaction, with its audit entry written in that same transaction. Razorpay is not
integrated, and payments are view-only.

## What an admin can do

| Area | Capabilities |
| --- | --- |
| **Bookings** | list (cursor-paginated, 20 per page, "Load more"), search, filter, sort, view the complete booking, confirm, cancel (reason required), update status, reopen a cancelled booking, reschedule |
| **Payments** (view-only) | total, payment option, required, paid, remaining, payment status, payment method, Razorpay order/payment IDs (shown when they exist; the signature is never sent to the browser) |
| **Packages** | add, edit (name, category, description, image, order, featured), change price, enable/disable |
| **Slots** | add, edit label/capacity/weekdays, enable/disable, block and unblock dates, see booked capacity per date |
| **Audit trail** | every change, by whom, when, why, before/after; shown in each booking's history; `GET /api/admin/audit` |

## How it stays safe

**Every admin route** passes `requireAuth` (Firebase ID token verified by the Admin SDK on the server) and
`requireAdmin` (the `admin: true` custom claim in that verified token) before any handler runs
(`routes/admin.routes.js`, one place). Nothing the browser says about itself is trusted. A test walks all 17
routes with no token (401), a garbage token (401) and an ordinary user's real token (403) and checks that nothing
changed and no audit entry was written.

**Audit entries** (`auditLogs/{id}`) are created in the same transaction as the change, so a change cannot exist
without its record. The actor is the verified token's uid/email; a body that tries to supply an actor is rejected.
`before`/`after` contain only the changed fields (no customer PII). No route edits or deletes entries, and
Firestore rules deny every client read and write of `auditLogs`.

**Firestore rules** now deny every client read of `bookings`, `slotBookings`, `blockedDates` and `auditLogs`,
admins included, so the dashboard cannot quietly go back to loading the whole collection. `packages` and `slots`
remain publicly readable when active/enabled, and no client can write anything.

**Concurrency.** Status changes and reschedules use the same per-slot queue and transaction retry as customer
bookings. Cancelling frees exactly the seat that booking holds (an old/inconsistent record never frees someone
else's seat); reopening takes a seat back or fails with `SLOT_FULL`; a reschedule moves the seat atomically under the
customer availability rule. Optimistic checks (`expectedStatus`, `expectedDate/SlotId`, `expectedUpdatedAt`) refuse
edits made from a stale screen.

## Pagination, indexes and search

`GET /api/admin/bookings?limit&cursor&sort&status&paymentStatus&paymentOption&paymentMethod&packageId&slotId&dateFrom&dateTo&q`

- **Cursor pagination** (opaque, bound to its query: a cursor from another search/filter is `400 INVALID_CURSOR`),
  `limit` 1–50 (default 20). A page reads at most `limit + 1` documents when Firestore does all the filtering.
- **Bounded scan.** Firestore can filter cheaply on one field, so **one** equality filter (first present of status,
  paymentStatus, packageId, slotId, paymentMethod, paymentOption) plus the sort go into the query; any other filters
  run on the server over the page being scanned, capped at **250 documents per request**. A very selective filter
  may return a short (even empty) page with `hasMore: true`; "Load more" continues. Nothing ever reads the whole
  collection in one request.
- **Sort**: `newest` (createdAt desc) or `upcoming` (event date, then time). A date range is pushed into Firestore
  only with `upcoming`; with `newest` it is applied in memory.
- **Search is not "contains"** (Firestore has no substring search): booking ID (exact), email (exact), phone (starts
  with the stored number, so include `+91` if it was stored with it), name (starts with, case-insensitive).
  Filters still apply to search results.
- **Stats** (`GET /api/admin/stats`): total, pending, confirmed, cancelled and today's events via count queries.

### Indexes (`firestore.indexes.json`, 16 composite indexes)

For each of the six filter fields F: `(F, createdAt desc)` and `(F, date, time)`; plus `(date, time)`;
`auditLogs (entityType, entityId, at desc)` and `(entityType, at desc)`; `slotBookings (slotId, date)`.

**The Firestore emulator does not enforce indexes**, so a missing one would only fail in production. A unit test
therefore enumerates every query shape the API can issue (more than 10,000 filter/sort/search combinations),
computes the index each needs, and asserts it is declared, and that no declared index is unused. I could not verify
the index rules against a real Firestore project from here. **Deploy them and wait for "Enabled"** before using the
dashboard (`DEPLOYMENT_GUIDE.md`). Bookings created before this phase need `npm run bookings:backfill` once so name
search finds them.

## API

All under `/api/admin`, all audited where they change data. Mutations return `{ changed, … }`; repeating a change is
a harmless no-op (`changed: false`, no second audit entry).

| Route | Purpose |
| --- | --- |
| `GET /stats`, `GET /bookings`, `GET /bookings/:id` | dashboard numbers, paginated list, one booking + its last 20 audit entries |
| `PATCH /bookings/:id/status` `{status, reason?, expectedStatus?}` | Pending↔Confirmed, →Cancelled (reason ≥ 3 chars; frees the seat), Cancelled→Pending/Confirmed (retakes the seat or `409 SLOT_FULL`) |
| `POST /bookings/:id/reschedule` `{date, slotId, reason?, expected…}` | move the booking and its seat; `409 SLOT_FULL`, `422 SLOT_UNAVAILABLE`, `409 BOOKING_CANCELLED` |
| `GET /catalog`, `POST /packages`, `PATCH /packages/:id` | list everything incl. disabled; create; partial edit (price, active, …) |
| `GET /slots`, `POST /slots`, `PATCH /slots/:id`, `GET /slots/occupancy` | slots, capacity, booked capacity for a date range |
| `GET /blocked-dates`, `PUT/DELETE /blocked-dates/:date` | list, block (reports existing bookings, which are **not** cancelled), unblock |
| `GET /audit` | cursor-paginated trail, filter by record |

Bodies are strict (unknown fields are a 400). There is **no delete** for bookings, packages or slots: disable
instead. A **slot's start time cannot be edited** (its id and the per-date occupancy keys derive from it); add a new
slot and disable the old one. Package price changes apply to new bookings only, immediately (the public catalog cache
is cleared; other server instances within `CATALOG_CACHE_TTL_MS`).

## The dashboard (frontend)

`frontend/src/admin/{api,views,dashboard}.js`, `adminRows.js`, and the admin section of `index.html`. Tabs:
Bookings (filters, table, Load more, detail modal with actions and history), Packages (table, add/edit modal,
enable/disable), Slots & availability (slots, add/edit, block dates, booked-capacity viewer). Only changed fields
are sent on edit, so a price edit never overwrites another admin's concurrent change to the description. A 401 signs
the admin out; the dashboard never calls the API after sign-out.

## Bugs found while building this (all fixed, all now pinned by tests)

- **A price-only edit would have wiped a package's description, image and featured flag.** Zod applies `.default()`
  inside `.partial()`; the patch schema now removes defaults.
- **`z.url()` accepts `javascript:` URLs**; package images are now `http(s)` only.
- **"Created —"**: the list/detail could not format the API's ISO timestamps (found by looking at the screenshots).
- A request was made after sign-out (reset handler firing during `stop()`), and success notices appeared before the
  table had refreshed.

## Changes

| Area | Files |
| --- | --- |
| Backend services | `services/{adminBookings,adminCatalog,adminSlots,audit,bookingQuery}.service.js` |
| Backend API | `routes/admin.routes.js`, `controllers/admin{Bookings,Catalog,Slots}.controller.js`, `schemas/admin.schema.js` |
| Utilities | `utils/{cursor,serialize,txRetry,validate}.js`, `utils/keyedLock.js` (multi-key), `constants/booking.js` |
| Data | `firestore.rules`, `firestore.indexes.json`, `scripts/backfill-bookings.js`; bookings gain `nameLower`, `updatedAt` |
| Frontend | `admin/*`, `adminRows.js`, `app.js` (Firestore removed), `index.html`, `styles.css` |
| Config | `RATE_LIMIT_ADMIN_MAX` default 60 → 240 |

No new dependencies.

## Tests

```bash
cd backend
npm test                 # unit tests
npm run test:emulator    # emulator tests
```

- **Authorization:** all 17 routes × {no token, garbage token, non-admin} with nothing changed; spoofed headers/query/body
  ignored; no route can write the audit log; no deletes.
- **Reading:** 57-booking pagination proven exact (no duplicates, no gaps) for every filter, combinations, both sorts,
  date ranges, every search kind; cursor tampering/replay/deleted-document; a 320-booking case proves one request never
  reads more than 250 documents.
- **Mutations:** confirm/cancel/reopen/reschedule and their seat effects; 10 simultaneous cancels free the seat once;
  two bookings racing for the last seat (6 rounds); cancel/reschedule/customer-booking interleavings keep the counters
  exact; packages and slots (validation, stale edits, price/capacity/disable effects on customers); blocked dates;
  audit trail (actor, before/after, no PII, no entry for failed calls, none missing for successful ones).
- **Index coverage** for every query shape (see above), **rules** (no client read of bookings even for admins).
- **Real Chrome** against the real backend with **real Auth-emulator tokens**: 81 checks covering the full workflow,
  including 45 seeded bookings paged 20/20/5 with the cursor, filters, search, detail, confirm, cancel with reason,
  reopen refused when the seat is taken, reschedule through the availability picker, package and slot management
  reflected on the public site, blocked dates, a non-admin refused by the real server, a bad token mid-session
  (signed out exactly once), zero Firestore traffic, and the audit trail. Mutation checks: removing the admin claim
  check fails the authorization suite; not releasing seats on cancel fails six tests.

Not covered: real Firestore (emulator only: notably index behaviour and contention limits), real Google Auth sign-in
(Firebase's CDN SDK is stubbed in the browser test; tokens and the server-side verification are real).

## Remaining risks

- **Indexes are unverified against real Firestore.** Deploy `firestore.indexes.json` and wait for "Enabled"; the
  first production query that hits a missing one returns an error (Firestore's message links to create it).
- Search is prefix/exact, not "contains". Multi-filter queries scan up to 250 documents per request (a very selective
  filter may need several "Load more" clicks).
- Payments are view-only: nothing marks a booking paid, and cancelling does not refund (the form says so). That needs
  the payment provider.
- Blocking a date does not cancel bookings already on it (the admin is told how many exist).
- No bulk actions, CSV export, admin user management, or per-slot blocking (only whole dates).
- Cancelling/reopening/rescheduling does not notify the customer (no email/SMS/WhatsApp integration).
- The per-slot queue is per server process (see Phase 4); several instances rely on the transaction and retry.
- Older bookings (no `nameLower`) are not found by name until `bookings:backfill` runs; older bookings without a slot
  seat can be rescheduled but have no seat to free when cancelled.
- 6 moderate backend `npm audit` findings remain; the legacy root app is untouched and still writes bookings directly.
