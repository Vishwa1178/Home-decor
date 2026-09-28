# Phase 3: Payment model (HALF / FULL) and UI, without a payment provider

> Phase 5 (`docs/PHASE5.md`) rebuilt the admin dashboard on paginated backend APIs (the 10-column table described below is now an 8-column list plus a detail view). Phase 4 (`docs/PHASE4.md`) replaced the booking's free-form `time` with a server-validated `slotId`; everything about payments below still applies.

The customer chooses **Pay 50% Advance** or **Pay Full Amount**. The browser sends only
`paymentOption: "HALF" | "FULL"` (plus `paymentMethod`); the **server** calculates every amount from the
catalog price and stores the payment state inside the booking. Razorpay is **not** integrated: no API keys, no
orders, nothing is ever marked paid. Every new booking is `paymentStatus: "PENDING"` with `paidAmount: 0`.

## Amounts (`backend/src/utils/pricing.js`, the only place they are calculated)

| Option | totalAmount | requiredAmount | remainingAmount |
| --- | --- | --- | --- |
| HALF, package Rs. 10,000 | 10,000 | 5,000 | 5,000 |
| FULL, package Rs. 10,000 | 10,000 | 10,000 | 0 |
| HALF, package Rs. 999 | 999 | **500** | 499 |

- `requiredAmount = ceil(total / 2)` for HALF, `total` for FULL. Prices are whole rupees and most seeded prices are
  odd, so HALF **rounds up** to a whole rupee (the customer pays at least half). Change it in one line if you prefer
  rounding down.
- `remainingAmount = totalAmount − requiredAmount`: the balance left **after the required payment**. It is not
  "total minus paid" (at creation that would be the full total). `paidAmount` is tracked separately.
- **This replaces the old flat Rs. 500 advance** (`min(500, price)`); `ADVANCE_AMOUNT` no longer exists.
- Amounts are whole rupees. Razorpay works in paise: multiply by 100 when it is integrated.

## Payment fields on the booking document

Flat, with exactly the names from the spec:

| Field | Value at creation |
| --- | --- |
| `paymentOption` | `HALF` \| `FULL` (from the customer) |
| `paymentMethod` | `RAZORPAY` \| `CASH` \| `UPI` (from the customer) |
| `paymentStatus` | `PENDING` (allowed: `PENDING`, `PARTIALLY_PAID`, `PAID`, `FAILED`, `REFUNDED`) |
| `currency` | `INR` |
| `totalAmount`, `requiredAmount`, `remainingAmount` | calculated by the server |
| `paidAmount` | `0` |
| `razorpayOrderId`, `razorpayPaymentId`, `razorpaySignature` | `null` |

Removed from the booking (money is stored once): `paymentType`, `payableAmount`, `balanceAmount`, `packagePrice`.
`package`, `packageId`, `packageCategory` and the amounts are snapshots taken at booking time.
Constants: `backend/src/constants/payment.js`.

## API

`POST /api/bookings` now requires `paymentOption` (`HALF`/`FULL`, exact, case-sensitive, **no default**: the customer
must choose) and `paymentMethod` (`RAZORPAY`/`CASH`/`UPI`). The old values (`Advance`, `Full Payment`,
`Razorpay Online`, `Cash after confirmation`) are rejected with `400 VALIDATION_ERROR`.

These are **never trusted** (stripped and never stored; a warning is logged when a client sends them):
`totalAmount`, `requiredAmount`, `remainingAmount`, `paidAmount`, `paymentStatus`, `payment`, `razorpay*`,
`packagePrice`, `price`, `amount`, `payableAmount`, `status`.

Booking receipt (`201`/`200`), no personal data and no provider fields:

```json
{ "booking": { "id": "…", "status": "Pending", "package": { "id": "premium-decoration", "name": "Premium Decoration" },
  "payment": { "option": "HALF", "method": "RAZORPAY", "status": "PENDING", "currency": "INR",
               "totalAmount": 10000, "requiredAmount": 5000, "paidAmount": 0, "remainingAmount": 5000 },
  "date": "2027-03-05", "time": "18:30" } }
```

`GET /api/packages` gives every package a server-calculated `paymentOptions: { HALF: {totalAmount, requiredAmount,
remainingAmount}, FULL: {…} }` so the storefront only **displays** numbers; it never computes an amount. The catalog's
old `advanceAmount` is gone. `POST /api/bookings/validate` (dry run) returns the same quote for the chosen option.

Idempotency is unchanged and now covers the payment choice: the same `requestId` with a different `paymentOption` or
`paymentMethod` is `409 IDEMPOTENCY_KEY_REUSED`; a replay returns the original amounts even if the price changed later.

## Customer UI

- Two options: **Pay 50% Advance** (preselected) and **Pay Full Amount**, each showing its amount
  (e.g. "Rs. 5,000 to pay, Rs. 5,000 balance" / "Rs. 10,000 to pay").
- "Amount to pay: Rs. 5,000" in the payment header, and a summary box: Package total, **Amount to pay**,
  Remaining balance, and "No payment is taken when you submit this request."
- After submitting: "✅ Booking submitted! Amount to pay: Rs. 5,000 of Rs. 10,000. No payment has been taken yet.
  Admin will confirm your slot soon." (amounts come from the server's receipt). Nothing says a payment happened.
- Payment method options are now `RAZORPAY` (labelled "Razorpay Online"), `UPI`, `CASH` ("Cash after confirmation").
  Choosing Razorpay Online does not start any payment yet.

## Admin dashboard

The bookings table now has ten columns: **Booking ID**, Customer (name, phone, email), Package, **Amounts**
(Total / Required / Paid / Remaining), **Payment** (option, payment-status badge, method, and Payment ID or Order ID
when available, otherwise "No transaction yet"), Date, Balloon Color, Address, Notes, Status. Search matches booking
ID, payment option/method/status and order/payment IDs. Bookings created before this model (with
`paymentType`/`payableAmount`) still render, marked "(older booking)", without inventing a payment status.
The Razorpay signature is never displayed. Rendering lives in `frontend/src/adminRows.js` (all values HTML-escaped).

## Changes

| Area | Files |
| --- | --- |
| Backend | `src/constants/payment.js` (new), `src/utils/pricing.js`, `src/schemas/booking.schema.js`, `src/services/bookings.service.js`, `src/services/catalog.service.js`, `src/controllers/bookings.controller.js`, `src/config/env.js` (`ADVANCE_AMOUNT` removed), `.env.example` |
| Frontend | `src/bookingModal.js`, `src/bookingApi.js`, `src/catalog.js`, `src/adminRows.js` (new), `src/app.js`, `src/styles.css`, `index.html`, six theme pages |
| Tests | `tests/unit/{pricing-and-schema,api-behaviour,frontend-pages}.test.js`, `tests/emulator/{bookings,catalog,cache}.test.js` |

No new dependencies. Firestore rules are unchanged (still no client writes).

## Tests

```bash
cd backend
npm test                 # unit tests
npm run test:emulator    # emulator tests (Firestore + Auth)
```

Covered: HALF and FULL for the spec's Rs. 10,000 example and for odd prices (with a property check over every seeded
price and 2,000 random prices: `required + remaining = total`, integers, HALF ≥ 50%); every method combination stays
`PENDING` / `paidAmount 0` / provider ids `null`; forged amounts, statuses, paid flags and provider ids (also as strings,
negatives and huge numbers) are ignored; 22 invalid `paymentOption`/`paymentMethod` values (15 + 7) are rejected with
nothing written; a missing option is rejected; quotes in the catalog follow price edits; changed option with the same `requestId`
is 409; admin rendering of new, FULL, order-id and older bookings, HTML-escaping and no signature; page markup
(exact HALF/FULL radios, method values, summary elements, no copy claiming a payment).

Also in real Chrome (script outside the repo): the customer flow on a theme page and the home page for HALF and FULL
with forged fields injected into the DOM (never sent); an invalid option smuggled through the DOM (error shown,
nothing stored); and the **admin dashboard through the real `app.js`** with real booking data: all fields displayed,
search, older bookings, non-admin (403) refused and signed out, API-down fails closed, signed-out login prompt with an
empty email field. Only Google's CDN Firebase SDK was stubbed there.

Final counts: 162 unit tests, 95 emulator tests, 46 browser checks, all passing; the frontend builds.

## A regression from Phase 1, found and fixed here

The admin **search box had stopped working since Phase 1**: when `fetchAdminProfile` was extracted into
`adminApi.js`, the cut also removed the `bookingSearch` "input" listener that sat next to it. Nothing tested the
admin page in a browser until this phase, and the first version of this phase's own search check was too weak
(`>= 1` row) to notice. The listener is restored, the browser check now asserts exactly which rows match (order id,
booking id, payment option, no match, cleared), and `frontend-pages.test.js` has a static guard for it. I diffed every
event listener in `app.js` against the original: the only others that moved were the booking-modal ones, deliberately,
into `bookingModal.js` in Phase 2.

## Remaining risks / notes

- **`remainingAmount` meaning.** Implemented as `total − required` (matches the spec example). If you meant
  `total − paid` (outstanding balance), it is a one-line change, but decide before Razorpay writes to it.
- **Rounding** of HALF for odd prices (up). See above.
- The admin table shows amounts but there are still no admin actions (confirm/cancel, mark paid): those need the
  payment provider (Phase 4) and admin endpoints.
- "Razorpay Online" is selectable although it cannot be paid yet; the copy says nothing is charged, but consider
  hiding it until Phase 4.
- Same as before: no slot rule, per-instance rate limits, legacy root app untouched (it still writes the old fields
  directly and will look "older" in the admin table), stale-price-on-open-page risk (the server bills the current
  price).
