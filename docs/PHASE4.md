# Phase 4: Booking slots and availability

Customers no longer type a time. They pick one of the slots the backend offers for a date, and the seat is
reserved **in the same Firestore transaction that creates the booking**, so a slot can never be double-booked
and capacity can never be exceeded, however many requests arrive at once. No Razorpay.

## The initial slots

**The project had no fixed time slots before this phase**: the form's Time field was a free-form `<input
type="time">` on every page (including the original baseline and the legacy root app), and the only related copy
was "Same day slots" and "2-hour setup window". So there was nothing to extract; you chose these:

| id | Time | Label | Capacity per date | Days | Enabled |
| --- | --- | --- | --- | --- | --- |
| `t1000` | 10:00 | 10:00 AM | 1 | every day | yes |
| `t1300` | 13:00 | 1:00 PM | 1 | every day | yes |
| `t1600` | 16:00 | 4:00 PM | 1 | every day | yes |
| `t1900` | 19:00 | 7:00 PM | 1 | every day | yes |

They live in `backend/data/slots.seed.json`; `npm run slots:seed` loads them into Firestore (create-missing only;
`--overwrite` resets; `--dry-run` previews). **Edit that file before the first seed if you want different slots.**
After seeding, Firestore is the source of truth. No time is hardcoded anywhere in the frontend (a test enforces it).

## Data model (Firestore)

| Collection | Document ID | Purpose |
| --- | --- | --- |
| `slots` | `t1000` … (`t` + HHMM, deterministic) | Configuration, **admin-editable**: `time`, `label`, `capacity`, `enabled`, `days` (weekdays 0=Sun…6=Sat), `sortOrder` |
| `blockedDates` | `YYYY-MM-DD` | A date on which no slot can be booked (`reason` is private) |
| `slotBookings` | `YYYY-MM-DD_t1000` (deterministic) | Occupancy of one slot on one date: `date`, `slotId`, `time`, `capacity` (snapshot), `bookedCount`, `bookingIds[]` |

Bookings gain `slotId`, `slotKey` (= the occupancy document id), `time` (`"10:00"`) and `timeLabel` (`"10:00 AM"`),
all snapshots. The booking API takes `slotId` instead of `time`; a free-form `time` from an old client is ignored.
This covers everything an admin will eventually manage: add/edit a slot, enable/disable, capacity, availability by
day (`days`), blocked dates, and viewing booked capacity (`slotBookings`).

## How a booking reserves a seat (`backend/src/services/bookings.service.js`)

One Firestore transaction:

1. read the booking, package, slot config, blocked-date marker and the slot's occupancy document (one batched read);
2. **if the booking already exists** (same `requestId`) → return the original receipt (or 409 if the payload
   differs). A replay **never touches capacity**, so a retry can never take a second seat;
3. apply the shared rule `evaluateSlot` → refuse when the slot is disabled, does not run that weekday, the date is
   blocked, the time has passed (business timezone) or `bookedCount ≥ capacity`;
4. create the booking **and** write the occupancy document (`bookedCount + 1`, `bookingIds`) atomically.

`evaluateSlot` (`slots.service.js`) is the single rule used by **both** `GET /api/availability` and the booking
transaction, so what the page shows and what is enforced cannot disagree (a test checks every state). The backend is
the authority; the browser only displays what it is told.

### Handling a burst on one slot

Firestore serialises transactions on the same document with locks and aborts those that wait too long. A first
version of this phase failed under 50 simultaneous requests for one slot (`ABORTED: Transaction lock timeout`, a
safe failure, never an oversell, but customers were told "try again" instead of "slot full"). Fixed with:

- a **per-slot in-process queue** (`utils/keyedLock.js`): requests for the same date+slot run one at a time, so each
  gets an uncontended transaction and the latecomers get a fast `SLOT_FULL`;
- an outer **retry on transaction contention** (jittered, 5 attempts), then `503` + `Retry-After: 1` if it never clears
  (nothing is reserved; the same `requestId` can be retried safely).

The queue is an optimisation. **Correctness comes from the transaction**, which also protects across several server
instances (where the retry absorbs the extra contention).

## API

`GET /api/availability?date=YYYY-MM-DD` (never cached, own rate limit):

```json
{ "date": "2027-03-05", "timezone": "Asia/Kolkata", "blocked": false,
  "slots": [ { "id": "t1000", "label": "10:00 AM", "time": "10:00", "capacity": 1, "booked": 0, "remaining": 1,
               "available": true, "reason": null },
             { "id": "t1300", "label": "1:00 PM", "time": "13:00", "capacity": 1, "booked": 1, "remaining": 0,
               "available": false, "reason": "FULL" } ] }
```

Disabled slots and slots that do not run that weekday are not listed. `reason` is `FULL`, `PAST` or `BLOCKED`.
The date must be valid, not in the past and at most 730 days ahead (`400 VALIDATION_ERROR` otherwise).

`POST /api/bookings` adds: `409 SLOT_FULL`, `422 SLOT_NOT_FOUND`, `422 SLOT_UNAVAILABLE` (disabled / not that day /
blocked date / already passed), and `503` with `Retry-After` when Firestore stays contended. Idempotency
(`requestId`) is unchanged and now also covers `slotId` and `date`: the same `requestId` with a different slot or
date is `409 IDEMPOTENCY_KEY_REUSED`. `POST /api/bookings/validate` checks the slot too but reserves nothing.
`SLOT_CUTOFF_MINUTES` (default 0) closes a slot that many minutes before it starts.

## Customer UI

The Time field is now a picker (same place in the form). It reads "Choose a date first" until a date is chosen, then
lists the slots from the backend: bookable ones selectable, others shown but disabled ("1:00 PM — Fully booked"),
"(n left)" only when a slot holds more than one booking, and clear messages for a blocked date, no slots, or all slots
booked. If the slot is taken while the customer is filling in the form, submitting shows "That time was just booked by
someone else. Please choose another time.", keeps everything they typed and refreshes the list. The retry logic reuses
the same `requestId` for an unchanged form, so pressing Submit again after a lost reply is safe.
The admin table shows the slot label next to the date.

## Rules

`slots`: enabled slots readable by anyone (configuration only), disabled ones admin-only. `blockedDates` and
`slotBookings`: admin read only. **No client can write any of them**, so capacity can only change inside the backend
transaction. The old reserved public `availability` rule was removed (real availability comes from the API).

## Changes

| Area | Files |
| --- | --- |
| Slots | `backend/data/slots.seed.json`, `scripts/seed-slots.js`, `scripts/lib/seed.js` (shared with `seed-catalog.js`), `src/schemas/slot.schema.js`, `src/services/slots.service.js`, `src/utils/keyedLock.js`, `src/utils/clock.js` |
| API | `controllers/availability.controller.js`, `routes/availability.routes.js`, `routes/index.js`, `middleware/rateLimit.js`, `middleware/errorHandler.js` + `utils/errors.js` (`Retry-After`) |
| Booking | `services/bookings.service.js`, `schemas/booking.schema.js` (`slotId`, reusable `bookingDate`), `utils/dates.js`, `config/env.js` |
| Frontend | `src/availability.js` (new), `src/bookingModal.js`, `src/bookingApi.js`, `src/adminRows.js`, `index.html` + six theme pages |
| Rules/docs | `firestore.rules`, `.env.example`, `DEPLOYMENT_GUIDE.md`, `README.md` |

No new dependencies.

## Tests

```bash
cd backend
npm test                 # unit tests
npm run test:emulator    # emulator tests (Firestore + Auth)
```

The four scenarios you asked for, on the real Firestore emulator (and again through real browsers):

- **Two users, the final slot:** 30 rounds of two simultaneous requests → exactly one 201 and one `SLOT_FULL` every
  time; with capacity 3 and 2 taken, two race for the last seat → one wins. In Chrome, two independent sessions
  submit at the same moment: one gets "Booking submitted", the other the "just booked" message, and its list refreshes.
- **10 simultaneous requests:** capacity 1 → 1 succeeds, 9 `SLOT_FULL`; capacity 3 → exactly 3; plus 50 on capacity 5
  → exactly 5, 100 on capacity 10 → exactly 10, 24 spread over four slots → exactly 2 each, and a burst mixing
  duplicates with competitors never contradicts itself. Zero server errors.
- **Duplicate request:** same `requestId` twice → 201 then 200, one seat; 15 simultaneous duplicates → one 201, fourteen
  200, never `SLOT_FULL`; same `requestId` with another slot/date → 409 and neither slot changes; replays survive the
  slot being disabled or blocked.
- **Retry after network failure:** the reply is lost but the booking exists → another customer is refused, the original
  customer's retry is a 200 replay (not "slot full") and there is one seat; 25 rounds of a client hanging up at random
  moments and a raw cut connection → always exactly one booking; a failure before commit → 503 with `Retry-After`, no
  seat leaked, and the same `requestId` then succeeds; simulated Firestore contention is retried transparently.

Also: availability display, weekdays, blocked dates, disabled slots, capacity edits (raising opens seats, lowering below
what is booked refuses new ones without touching existing bookings), same-day slots that have started (timezone-aware,
including the UTC-vs-India date boundary), atomicity (a booking that fails on the package check reserves nothing), rules
(nobody can write occupancy from a client), and a **capacity audit** at the end of the suite (every occupancy counter
equals both its `bookingIds` and the bookings that exist, none over capacity).

Stress result: the concurrency tests were run six times from a cold start after the fix (14 tests each): all passed,
no 503s. Before the fix, 2 of 3 cold runs hit lock timeouts.

## Remaining risks / notes

- **Cancelling a booking does not yet release its seat**: there is no cancel endpoint. When admin cancel/reschedule is
  added it must decrement `bookedCount` and remove the id from `bookingIds` in one transaction (the model supports it).
- **The per-slot queue is per server process.** With several instances the Firestore transaction still guarantees
  correctness, but a huge rush for one slot could again see 503 + `Retry-After` (safe to retry). One Render instance is fine.
- Firestore guidance is about 1 sustained write/second per document; a slot is one document, which is fine for
  human booking rates and the reason bursts are queued.
- **Bookings made before this phase** have a free-form `time` and no slot; they do not occupy any slot, so an old
  10:00 booking does not block the 10:00 AM slot. Migrate them if that matters.
- Availability is shown per date; there is no calendar that greys out full dates (the native date picker cannot), so a
  customer discovers a full day after picking it. A month-summary endpoint would allow that.
- The picker refreshes when the date changes, on open, after a refusal and after a booking, not continuously; a slot
  taken while a customer is idle is caught (with a friendly message) at submit.
- Slots are global: capacity 1 means one booking per slot per date for the whole business, not per area or team.
- Admin screens for editing slots, blocking dates and viewing booked capacity do not exist yet (edit Firestore directly;
  `slotBookings` shows booked capacity).
- Unchanged: 6 moderate backend `npm audit` findings, legacy root app untouched, per-instance rate limits.
