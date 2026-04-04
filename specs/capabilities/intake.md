# Intake Capability — Dumont Agent

## Role
Parse raw client requests into structured trip briefs. Qualify the client before anything moves downstream. This is the first gate — if the client isn't a real buyer, the pipeline stops here.

## Upgrades from Old Intake Agent
- **Added**: Client qualification (budget capture, decision-maker check)
- **Added**: Substitution preference capture for repeat clients
- **Added**: Integration with memory to detect repeat clients
- **Removed**: Independent agent context — now receives DealContext from Orchestrator

## Inputs
- Raw client request (text, email, SMS, voice transcript, web form)
- Client history from memory (if repeat client)

## Outputs (writes to DealContext)
- `trip.departure` — ICAO code
- `trip.arrival` — ICAO code
- `trip.date` — ISO date
- `trip.pax` — passenger count
- `trip.aircraftClass` — light / midsize / super-mid / heavy / ultra-long
- `trip.aircraftType` — specific type if mentioned
- `trip.isRoundTrip` — boolean
- `trip.specialRequirements` — pets, catering, wheelchair, cargo, etc.
- `client.name`
- `client.contact`
- `client.type` — new or repeat
- `client.budget` — min/max range (REQUIRED for pipeline to continue)
- `client.substitutionPref` — from memory if repeat, null if new
- `client.qualified` — boolean
- `client.qualificationReason` — why qualified or not

## Qualification Logic
1. Can we parse a valid route? (departure + arrival must resolve to ICAO)
2. Is there a date? (must be in the future)
3. Is there a passenger count? (must be > 0)
4. Is there a budget? If not → pipeline PAUSES, Orchestrator asks client
5. Is the client a decision-maker? (inferred from language / history)

If any of 1-3 fail → `qualified: false`, pipeline stops.
If 4 is missing → pipeline pauses, not fails. Client gets asked.
If 5 is uncertain → flag as warning, proceed with caution.

## Repeat Client Detection
Query memory for client name/contact. If found:
- Pre-populate substitution preference
- Pre-populate aircraft class preference
- Flag as repeat (higher conversion probability)

## Guardian Interaction
After Intake writes to DealContext, Orchestrator calls Guardian with stage='intake'.
Guardian checks: runway length at both airports for aircraft class, range feasibility, 
pax capacity for aircraft class. If blocked → pipeline stops before any pricing.

## Reference
Previous spec: `~/osa/sparc-specs/intake-agent.md`
Previous implementation: `~/osa/simulator/src/agents/intake.ts`
Previous tests: `~/osa/simulator/src/agents/__tests__/intake.test.ts`
