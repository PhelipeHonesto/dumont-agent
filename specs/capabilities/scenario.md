# Scenario Capability — Dumont Agent

## Role
Generate the client-facing OSA-branded quote presentation. One quote. Clean, professional,
with all information the client needs to say yes. Also pre-rank backup option in case
primary falls through — but never present backup unless needed.

## Upgrades from Old Scenario Agent
- **Changed**: From "generate 3 alternatives" → "generate 1 primary presentation"
- **Added**: Backup pre-ranking (sourced but not contacted, activated only on failure)
- **Added**: Client substitution preference logic
- **Added**: Validity timer with alert thresholds
- **Removed**: Options comparison — single quote, single decision

## Primary Quote Presentation
Generate an OSA-branded quote containing:
- Route (departure city → arrival city)
- Date and time
- Aircraft: type, year, tail (if available), cabin details, photos
- All-in price (no hidden fees)
- What's included: crew, fuel, landing fees, FBO, taxes
- Safety: operator name, certificate, insurance status (Guardian-verified)
- Validity window: "This quote is valid for [X] minutes"
- One action: Confirm & Pay

## Backup Activation Logic
If primary falls through (aircraft sold, operator cancels):
1. Check `client.substitutionPref`:
   - `auto_within_10pct`: If backup price is within 10% → auto-present new quote, notify client
   - `always_approve`: Call client, present backup, wait for approval
   - `cancel_if_unavailable`: Inform client, close deal as failed
2. If no preference set (new client) → call client, present backup

## Timer Management
- Quote presented → timer starts
- At 70% of validity → alert Phelipe via Mission Control (amber)
- At 90% of validity → alert Phelipe (red) + prepare backup activation
- At 100% → quote expires → follow substitution logic or close as expired

## Reference
Previous spec: `~/osa/sparc-specs/scenario-agent.md`
Previous implementation: `~/osa/simulator/src/agents/scenario.ts`
