# Archive Reference — Previous OSA Connect Work

This project (Dumont Agent) is a clean rebuild. The previous work is preserved
at the following locations for reference. Do NOT modify these — they are read-only history.

## Previous Simulator
Location: `~/osa/simulator/`
- 5 independent agents (intake, sourcing, quote, scenario, guardian)
- 100 test scenarios across multiple categories
- Pipeline orchestrator with relay-chain handoffs
- Mission Control dashboard (terminal-based, localhost:5173)
- 72% pass rate at last run (Pricing Engine weakest at 80%)

Key files to reference:
- `~/osa/simulator/src/agents/` — all agent implementations
- `~/osa/simulator/src/pipeline/` — pipeline.ts, deal-context-manager.ts
- `~/osa/simulator/src/utils/` — haversine.ts, safe-llm-call.ts, recover-json.ts
- `~/osa/simulator/src/agents/__tests__/` — 5 test files, 84+ tests

## Previous SPARC Specs
Location: `~/osa/sparc-specs/`
- 12 specification documents covering all agents
- Written in SPARC methodology (Specification, Pseudocode, Architecture, Refinement, Completion)
- These specs are the FOUNDATION for the Dumont Agent capability specs

## Previous Mission Control
Location: `~/osa/mission-control/`
- Browser-based dashboard
- Scenario queue, pipeline visualization, agent health monitors
- Category pass/fail tracking

## What Changed in Dumont Agent
1. Five agents → one orchestrator with five capabilities
2. Relay-chain pipeline → single controller with callable modules
3. Guardian at end → Guardian at every stage
4. No pricing API → Aviapages Price Calculator API integrated
5. No learning loop → deal memory with feedback into decisions
6. Separate sim + dashboard → unified SIM/LIVE toggle
7. Find 3 options → find 1 best + 1 backup
8. No client qualification → budget gate before operator contact
9. No operator CRM → lane intelligence with performance tracking
10. No payment awareness → fast-pay as core relationship strategy

## Migration Plan
- Test scenarios: copy from `~/osa/simulator/scenarios/` to `dumont-agent/scenarios/`
- Utility functions: copy haversine, safe-llm-call, recover-json from `~/osa/simulator/src/utils/`
- Zod schemas: adapt from `~/osa/simulator/src/schemas/` to new DealContext interface
- Tests: rewrite for orchestrator pattern (not agent-by-agent)
