# Phase 7 timestamp bug — root cause + fix + cleanup

## The bug

Test backfill for 2026-01-07 produced 15,174 legs with **clustered-at-midnight
departures and impossibly-long flight times**:

```
N788QS  DAL → PHL   departure_time: 2026-01-07T00:00:00.400Z   ft_min: 1286
```

1,286 minutes is 21.4 hours. DAL→PHL is a ~2.5 hour flight.

## Root cause

Two bugs in `src/ingestion/adsblol-ingest.ts`, both surfaced during Tier 2's
introduction of the in-memory leg detector.

### Bug 1 (the main one) — `detectLegs` assumed start-on-ground

```ts
// OLD
let wasGround = true;
for (const p of points) {
  if (wasGround && !p.onGround && !legStart) {
    legStart = { lat, lon, ts: data.timestamp + p.offsetSec };
  }
  ...
  wasGround = p.onGround;
}
```

`wasGround = true` initialized the loop *assuming* the aircraft started on
the ground. Fine for aircraft parked at a gate at UTC midnight. But adsb.lol's
daily globe-history tar includes **aircraft mid-flight at UTC midnight** — the
first entry of that day's trace has `offset_s ≈ 0.4` and `on_ground = false`.

With `wasGround = true`, the *first airborne point* of the file was
mis-detected as a takeoff. For a N788QS mid-flight at midnight:

- `legStart.ts = data.timestamp + 0.4 = 2026-01-07T00:00:00.400Z` (fake takeoff)
- Aircraft actually lands at ~21:26 UTC in the same trace
- `flight_time_min = (arrival − fake_midnight_takeoff) = 1,286 min`
- `distance_nm` was correct (1,122 — computed from positions, not time)

**Fix:** tri-state initialization. Only emit `legStart` on a *confirmed*
ground→airborne transition:

```ts
let wasGround: boolean | null = null;
for (const p of points) {
  if (wasGround === true && !p.onGround && !legStart) {      // confirmed takeoff
    legStart = { ... };
  } else if (wasGround === false && p.onGround && legStart) { // confirmed landing
    legs.push({ ... });
    legStart = null;
  }
  wasGround = p.onGround;
}
```

If the trace starts airborne, no `legStart` is ever created — we correctly
**skip the in-progress leg** (we can't emit a valid takeoff time because
it happened in the previous day's trace). The next real takeoff later in
the trace emits a clean leg.

### Bug 2 (secondary, same PR) — `"ground"` string altitude was mis-classified

adsb.lol encodes altitude as either a number (feet AGL/MSL) or the string
`"ground"` for aircraft reported stationary on the field. The pre-fix
onGround heuristic:

```ts
const altFt = point[3] as number | null;
const onGround = (altFt != null && altFt <= 500) && (speedKts == null || speedKts < 60);
```

With `altFt = "ground"`: `"ground" <= 500` → string coerced to `NaN` → `NaN <= 500`
is `false` → `onGround = false`. A plane literally parked on the taxiway was
marked airborne.

**Fix:** check for the string explicitly and short-circuit:

```ts
const rawAlt = point[3] as number | string | null;
const altIsGroundString = rawAlt === "ground";
const altFt: number | null = typeof rawAlt === "number" ? rawAlt : null;
const onGround = altIsGroundString
  || ((altFt != null && altFt <= 500) && (speedKts == null || speedKts < 60));
```

Without this, plenty of legitimate landings were missed because the final
trace entry (aircraft coming to a stop on the taxiway, alt='ground') never
registered the airborne→ground transition.

## Verification

### Real-trace regression test

Pulled a real trace from the adsb.lol 2026-01-07 globe-history tar
(`trace_full_a0802e.json` — N131PA, a Piper PA-28). Observed results:

**Before fix:**
```
data.timestamp: 1767744000 (2026-01-07T00:00:00Z)
first kept point: offset=48434.33 (13:27:14Z)
last kept point:  offset=74107.37 (20:35:07Z) alt='ground' gs=19.5
                  → wrongly classified as onGround=false

detected legs: 2
  #1: dep=13:27:14 arr=15:02:26 ft_min=95 nm=33    ← lucky: this trace's first
                                                      airborne point was actually
                                                      during real takeoff roll
  #2: dep=15:02:35 arr=15:10:43 ft_min=8  nm=0
```

**After fix:**
```
first kept point: offset=48434.33 (13:27:14Z)     ← still starts airborne
last kept point:  offset=74107.37 (20:35:07Z) alt='ground' gs=19.5
                  → correctly classified as onGround=true

detected legs: 2
  #1: dep=15:02:35 arr=15:10:43 ft_min=8   nm=0    ← real pattern work
  #2: dep=15:21:11 arr=20:35:07 ft_min=314 nm=32   ← real local flight
                                                      (314 min = 5.2h — trainer doing patterns)
```

The pre-fix code got a **false leg** at the start of the trace (dep=13:27)
because it treated the first airborne point as takeoff. Post-fix, that fake
leg is correctly dropped.

### Unit tests

`tests/adsblol-ingest.test.ts` — six cases, all passing:

1. Aircraft mid-flight at UTC midnight with a landing later in the day →
   **zero legs emitted** (correct: we don't know the takeoff time).
2. Proper ground→airborne→ground sequence → **one leg with correct 95 min
   flight time**.
3. Trace is entirely airborne (long-haul crossing both day boundaries) →
   **zero legs** (correct: no takeoff, no landing in this trace).
4. Takeoff→land→takeoff→land sequence → **two legs**, each 20–40 min range.
5. `alt="ground"` with speed 75 kt (fast taxi) → `onGround=true`.
6. `alt="ground"` → `altFt` reported as `null`, not `NaN`.

Full test suite: **655 passed** (up from 649, +6 for this bug).

## Cleanup SQL — run in Supabase before re-backfill

The previous partial-backfill wrote 15,174 bad rows for 2026-01-07. Delete
them and reset the progress row so the backfill re-processes this day
cleanly:

```sql
-- Remove the bad legs for 2026-01-07
DELETE FROM adsb_completed_legs
WHERE departure_time::date = '2026-01-07';

-- Reset backfill_progress so history-backfill.ts re-runs this day
UPDATE backfill_progress
SET status = 'pending',
    legs_found = 0,
    charter_legs = 0,
    duration_seconds = 0
WHERE date = '2026-01-07';
```

Expected row counts after:
- `adsb_completed_legs` for 2026-01-07 → **0**
- `backfill_progress` 2026-01-07 status → **pending**

## Re-run command to verify the fix

From the Lightsail host (or locally with PG env):

```bash
DATABASE_TYPE=postgres npx tsx src/ingestion/history-backfill.ts \
  --from 2026-01-07 --to 2026-01-07
```

Then spot-check a couple of the new rows:

```sql
-- Reasonable flight_time values? (no 1000+ minute outliers)
SELECT tail_number, origin_icao, destination_icao,
       departure_time, arrival_time, flight_time_min, distance_nm
FROM adsb_completed_legs
WHERE departure_time::date = '2026-01-07'
  AND flight_time_min > 300
ORDER BY flight_time_min DESC
LIMIT 20;

-- Departure times distributed across the day (not clustered at midnight)?
SELECT date_trunc('hour', departure_time::timestamp) AS hour, COUNT(*)
FROM adsb_completed_legs
WHERE departure_time::date = '2026-01-07'
GROUP BY 1 ORDER BY 1;
```

If the fix works, `flight_time_min > 300` should return only a handful of
genuine long-haul flights (transcontinental, transoceanic), not thousands
of fake 20-hour "flights." And the per-hour histogram should show the
familiar diurnal traffic pattern, not a spike at 00:00.

## Files changed

```
M  src/ingestion/adsblol-ingest.ts
    - detectLegs: wasGround boolean → boolean|null tri-state; only emit
      legStart on confirmed ground→airborne; only emit landing on
      confirmed airborne→ground AND legStart exists
    - downsampleTrace: handle alt === "ground" (string) as onGround=true;
      altFt now null (not NaN) when alt is non-numeric

A  tests/adsblol-ingest.test.ts
    - 6 tests covering mid-flight-at-midnight, ground string handling,
      and multi-leg detection
```

No schema changes. No new deps. 655 tests pass. Typecheck clean.

**Do not re-run the full 89-day backfill** until you've verified 2026-01-07
looks clean post-cleanup. After that day checks out, the rest of the
Phase 7 backfill is safe to proceed.
