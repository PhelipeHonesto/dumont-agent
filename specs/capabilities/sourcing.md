# Sourcing Capability — Dumont Agent

## Role
Select ONE operator for each deal based on lane intelligence. Never blast RFQs.
Rank a backup but never contact them unless primary falls through.
This is the Cartage model: targeted matching, not marketplace broadcasting.

## Upgrades from Old Sourcing Agent
- **Changed**: From "find 3 options" → "find 1 best + 1 backup"
- **Added**: Lane intelligence (operator performance per route)
- **Added**: Operator CRM — conversion rate, response time, pricing consistency
- **Added**: Proximity scoring (operator base vs departure airport)
- **Removed**: Avinode/Aviapages RFQ blasting — we call operators directly

## Operator Ranking Algorithm
Score = weighted sum of:
1. **Proximity** (30%) — haversine distance from operator base to departure. Closer = less repositioning cost.
2. **Lane history** (25%) — has this operator flown this route before via OSA? Conversion rate on similar routes.
3. **Response time** (15%) — average time to return a quote. Faster = less client wait.
4. **Pricing accuracy** (15%) — how close are their quotes to Aviapages estimates? Predictable = better.
5. **Relationship score** (15%) — total deals closed, payment speed, trust level.

Day 1-10: Proximity + aircraft match dominate (no history yet).
Day 10-50: Lane history starts weighting in.
Day 50+: Full algorithm with all five factors.

## Outputs (writes to DealContext)
- `sourcing.selectedOperator` — name, phone, base, aircraft, score breakdown
- `sourcing.backupOperator` — same structure, never contacted unless primary fails
- `sourcing.rankingReason` — human-readable explanation of why this operator was chosen
- `sourcing.laneHistory` — previous deals on this route

## Operator Data Sources
- Day 1: Manual research + Aviapages Charter Directories API (4,000+ companies)
- Day 10+: Internal CRM built from deal history
- Day 50+: FL3XX/Leon schedule access (earned through relationship)

## Guardian Interaction
After sourcing, Guardian validates:
- Operator has active AOC / Part 135 certificate
- Insurance is current
- Aircraft type matches trip requirements
- No safety flags in memory

## Reference
Previous spec: `~/osa/sparc-specs/sourcing-agent.md`
Previous implementation: `~/osa/simulator/src/agents/sourcing.ts`
