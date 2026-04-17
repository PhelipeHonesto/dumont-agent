# Dumont Agent

[![CI](https://github.com/PhelipeHonesto/dumont-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/PhelipeHonesto/dumont-agent/actions/workflows/ci.yml)

> *Named after Santos-Dumont — the Brazilian who flew first. Now an AI that brokers flights.*

**Dumont Agent** is the AI-powered charter brokerage orchestrator for [OSA Connect](https://orangesunshineaviation.com) (Orange Sunshine Aviation). It replaces the traditional RFQ-based charter booking process with a single intelligent pipeline that qualifies clients, estimates pricing, selects operators, and closes deals — protecting both sides of every transaction.

## Architecture

Single orchestrator with 6 callable capabilities + Guardian at every stage + learning loop.

```
Client Request
     ↓
┌─────────────────────────────────────────────┐
│            ORCHESTRATOR (PIC)               │
│                                             │
│  INTAKE → GUARDIAN → ESTIMATE → GUARDIAN    │
│     → SOURCE → GUARDIAN → QUOTE → GUARDIAN  │
│     → PRESENT → GUARDIAN → CLOSE → LEARN   │
│                                             │
│  Guardian runs continuously (like EGPWS)    │
│  Learning loop feeds back into all stages   │
└─────────────────────────────────────────────┘
     ↓
  Deal Closed → Revenue Captured → System Learns
```

| Capability | Role |
|------------|------|
| **Intake** | Parse raw requests (text/email/SMS), resolve airports, qualify client, detect repeat clients |
| **Guardian** | Continuous validation — runway, range, pax, budget overlap, operator certs, quote sanity |
| **Quote** | Phase 1: Aviapages estimate + historical delta correction. Phase 2: real operator price + margin |
| **Sourcing** | 5-factor weighted ranking (proximity 30%, lane history 25%, response time 15%, pricing accuracy 15%, relationship 15%) |
| **Scenario** | Client-facing presentation, backup activation logic (auto/approve/cancel), validity timer |
| **Learning Loop** | Every deal → DealRecord → pricing/operator/client intelligence for future deals |

## Quick Start

```bash
cd ~/osa/dumont-agent

# Install dependencies
npm install

# Run all tests (281 tests)
npm test

# Run scenario simulation (25 scenarios, 92% pass rate)
npm run sim

# Run a single scenario
npm run sim -- --scenario S01

# Start Mission Control dashboard (port 5174)
npm run dashboard

# Type check
npm run typecheck
```

## File Structure

```
dumont-agent/
├── src/
│   ├── orchestrator/        ← pipeline engine, closeDeal, stage transitions
│   ├── capabilities/        ← intake, guardian, quote, sourcing, scenario
│   ├── schemas/             ← Zod schemas (DealContext, DealRecord)
│   ├── integrations/        ← Aviapages API client
│   ├── memory/              ← DealStore + learning loop
│   ├── utils/               ← haversine, safe-llm-call, recover-json
│   ├── fixtures/            ← simulation data (operators, airports, pricing)
│   ├── config.ts            ← models, timeouts, margin policy
│   └── run-sim.ts           ← scenario runner CLI
├── tests/                   ← 281 tests across 7 files
├── specs/                   ← SPARC specifications (source of truth)
├── scenarios/               ← 25 validation scenarios (JSON)
├── dashboard/               ← Mission Control (Vite + React)
├── data/                    ← runtime deal storage
└── archive/                 ← reference to old simulator
```

## Test Results

```
281 tests passing across 7 test files:
  deal-context    12 tests    ← schema validation, stage transitions
  guardian        52 tests    ← 5 stage-specific validation passes
  intake          68 tests    ← parsing, qualification, repeat detection
  quote           37 tests    ← estimate, budget fit, margin, delta
  sourcing        37 tests    ← ranking algorithm, cold start, proximity
  scenario        36 tests    ← presentation, backup logic, timer
  learning-loop   39 tests    ← deal recording, closeDeal, store queries

Scenario runner: 23/25 pass (92%) — target was 72%
```

## Build Status

| Step | Description | Status |
|------|-------------|--------|
| 1 | Orchestrator + Deal Context schema | Done |
| 2 | Guardian capability (continuous validation) | Done |
| 3 | Intake capability (parse + qualify) | Done |
| 4 | Quote capability (Aviapages API) | Done |
| 5 | Sourcing capability (operator ranking) | Done |
| 6 | Scenario capability (client presentation) | Done |
| 7 | Learning loop (deal memory) | Done |
| 8 | Dashboard (unified SIM/LIVE) | Done |
| 9 | Scenario runner (migrated from simulator) | Done |
| 10 | First real deal | **Pending** |

## License

Proprietary — Orange Sunshine Aviation, LLC
