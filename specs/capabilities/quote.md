# Quote Capability — Dumont Agent

## Role
Generate price estimates via Aviapages Price Calculator API. Compare against client budget.
Stop the pipeline if budget doesn't fit — before any operator is contacted.
After operator provides real quote, validate margin and present to Scenario capability.

## Upgrades from Old Quote Agent
- **Added**: Aviapages Price Calculator API integration (600 calls/mo at $173 tier)
- **Added**: Budget gate — pipeline stops if client budget < estimate floor
- **Added**: Historical delta tracking (estimate vs actual per route/operator)
- **Added**: Margin calculation (target 8-10%)
- **Removed**: Multi-quote generation — ONE quote only

## Phase 1: Estimate (Automated)
1. Call Aviapages Price Calculator API with: departure, arrival, aircraft type, date, pax
2. Receive: price range (low/high), flight time, fuel burn
3. Apply historical delta correction from memory: "Southeast routes run +12% above Aviapages"
4. Compare adjusted range against client budget
5. If budget.max < adjustedEstimate.low → stage = 'failed', reason = 'budget_mismatch'
6. Write estimate to DealContext

## Phase 2: Real Quote (Human-in-the-loop, Day 1-50)
1. Orchestrator signals Phelipe: "Call [operator]. Expected: $X. Route: [DEP-ARR]."
2. Phelipe enters real operator quote into DealContext
3. Quote capability calculates: OSA price = operator price / (1 - margin%)
4. Guardian validates: is quote within 25% of estimate? If wildly off → warning flag

## Phase 3: Real Quote (Automated, Day 50+)
1. Orchestrator queries operator FL3XX/Leon API for availability confirmation
2. Price calculated from pre-agreed rate framework
3. No phone call needed — direct confirmation

## Aviapages API Endpoints Used
- `POST /price_calculator/` — charter cost estimate
- `POST /flight_calculator/` — flight time + route + fuel
- `GET /aircraft/{id}` — aircraft specs for Guardian validation

## Learning Loop Integration
After every closed deal, write:
- `estimate.priceRange` vs `quote.operatorPrice` → delta percentage
- Route + aircraft type + operator → lane-specific pricing model
- Time of week / season → seasonal adjustment factor

## Reference
Previous spec: `~/osa/sparc-specs/quote-agent.md`
Previous implementation: `~/osa/simulator/src/agents/quote.ts`
