# Dumont Agent — OSA Connect Orchestrator

> Named after Santos-Dumont. The Brazilian who flew first. Now an AI that brokers flights.

## What This Is

Dumont Agent is the AI-powered charter brokerage engine for Orange Sunshine Aviation (OSA).
It is a single orchestrator with six callable capabilities — not six independent agents.
It follows the Cartage (YC) service-as-software model applied to private aviation,
built with ruvnet's SPARC spec-first methodology and Ruflo-inspired orchestration patterns.

## Current State (April 3, 2026)

- **628 tests passing** across 19 test files, **0 type errors** (Vitest + TSC strict)
- **Engine complete**: Intake, Guardian, Quote (estimate + real), Sourcing, Scenario, Learning Loop, Orchestrator
- **Communication layer complete**: 7 sprints — schemas, router, 4 channel adapters, voice copilot, respond capability, stage regression
- **Dashboard**: `dashboard/` (Vite + React, port 5174) — 74.2 KB gzip, 5 tabs + command bar, PWA-enabled
- **Scenario runner**: `npm run sim` — 92% pass rate (23/25 scenarios)
- **3 polish sessions complete**: architecture, tests, dashboard
- **Root workspace**: `~/osa/dumont-agent/`
- **Old simulator preserved at `~/osa/simulator/`** — do not modify

## Architecture — One PIC, Six Crew Positions

```
Orchestrator (holds Deal Context — single source of truth)
  ├── calls Intake capability     → parse request + qualify client
  ├── calls Guardian validation   → continuous — runs at EVERY stage (like EGPWS)
  ├── calls Quote/Estimate        → Aviapages Price Calculator API + budget gate
  ├── calls Sourcing capability   → lane intelligence → ONE operator + ONE backup
  ├── calls Scenario capability   → client presentation + backup activation logic
  ├── calls Respond capability    → draft generation + evaluator-optimizer + confidence gate
  └── writes to Learning Loop     → deal outcome → DealStore → pricing/operator intelligence
```

Pipeline: INTAKE → GUARDIAN → ESTIMATE → GUARDIAN → SOURCE → GUARDIAN → QUOTE → GUARDIAN → PRESENT → GUARDIAN → CLOSE → LEARN

Guardian is NOT a final checkpoint. It is a continuous validation layer.
It runs after every stage and blocks the pipeline on critical failures.

Stage regression allows re-pricing/re-sourcing when new information arrives via comms.

## Communication Layer (Complete — 7 Sprints)

Spec: `specs/comms/communication-layer.md` (SPARC v2.2, 1056 lines)

| Sprint | What | Tests |
|--------|------|-------|
| 1 | Schemas + Message Router + Thread Matcher | 38 |
| 2 | Bland AI Adapter — voice SDR + iMessage (blue bubble) + SMS | 26 |
| 3 | Email Adapter (Resend) + Web Form + MessageStore | 31 |
| 4 | Voice Copilot — Twilio conference bridge + Deepgram transcription (Nova-2, aviation vocab) | 34 |
| 5 | Respond + Draft Evaluator + Edit Memory + SDR + Confidence Gate | 30 |
| 6 | Mission Control Extensions — 6 new components, 5 tabs | UI |
| 7 | Integration Testing + Stage Regression through comms | 16 |

### Provider Stack (~$37/mo)

- **Vapi**: client-facing voice AI (replaced Bland AI)
- **Resend**: email (operator RFQs, formal client quotes)
- **Twilio**: conference bridge (copilot during broker-operator calls)
- **Deepgram**: real-time streaming transcription (Nova-2, aviation vocabulary)

## Key Design Decisions

1. **One quote, one operator, one deal.** Never blast RFQs. Never hold aircraft you won't book.
2. **Qualify before sourcing.** Budget confirmed before any operator is contacted.
3. **Price-anchor via Aviapages API.** Silent internal estimate. Client never sees "Aviapages."
4. **Fair margins (8-10%).** Operators are partners, not cost centers.
5. **Fast pay.** Operator gets paid before departure. Every time.
6. **Learning loop.** Every deal teaches the system. Deal 50 is smarter than deal 1.
7. **One dashboard, two modes.** SIM and LIVE. Same interface. Same orchestrator.

## Tech Stack

- TypeScript (strict)
- Zod for schemas
- Anthropic Claude API for LLM calls (intake parser fallback)
- Aviapages API for pricing/flight calc/directories
- Vapi + Resend + Twilio + Deepgram for comms
- Vite + React for Mission Control dashboard
- Vitest for testing

## Project Structure

```
dumont-agent/
├── CLAUDE.md                     ← you are here
├── README.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── specs/                        ← SPARC specs (source of truth)
│   ├── orchestrator.md
│   ├── capabilities/
│   │   ├── intake.md
│   │   ├── guardian.md
│   │   ├── quote.md
│   │   ├── sourcing.md
│   │   └── scenario.md
│   ├── learning-loop.md
│   └── comms/
│       └── communication-layer.md  ← SPARC v2.2, 1056 lines
├── src/
│   ├── orchestrator/             ← pipeline engine + closeDeal + stage transitions
│   │   ├── index.ts
│   │   ├── deal-context-manager.ts
│   │   └── stage-transitions.ts
│   ├── capabilities/             ← callable modules
│   │   ├── intake.ts             ← code-layer parser + LLM fallback + qualification
│   │   ├── guardian.ts           ← 5 stage-specific validation passes
│   │   ├── quote.ts              ← Phase 1 estimate + Phase 2 real quote + margin calc
│   │   ├── sourcing.ts           ← 5-factor weighted ranking algorithm
│   │   ├── scenario.ts           ← presentation builder + backup logic + timer
│   │   ├── transcript-processor.ts ← call transcript → structured data
│   │   ├── sdr.ts                ← AI sales development rep (voice + text)
│   │   ├── draft-evaluator.ts    ← evaluator-optimizer pattern for outbound drafts
│   │   ├── respond.ts            ← response generation + confidence-gated autonomy
│   │   └── index.ts
│   ├── schemas/                  ← Zod schemas (single source of truth)
│   │   ├── deal-context.ts
│   │   ├── deal-record.ts
│   │   ├── message.ts            ← inbound/outbound message schemas
│   │   ├── conversation.ts       ← thread + conversation state
│   │   ├── call.ts               ← call session + transcript schemas
│   │   ├── channel-config.ts     ← per-channel configuration
│   │   └── index.ts
│   ├── channels/                 ← channel adapters
│   │   ├── adapter.ts            ← base adapter interface
│   │   ├── bland-ai.ts           ← voice SDR + iMessage + SMS
│   │   ├── email.ts              ← Resend adapter
│   │   ├── web-form.ts           ← website intake form
│   │   ├── voice.ts              ← Twilio conference bridge
│   │   └── index.ts
│   ├── router/                   ← message routing + classification
│   │   ├── message-router.ts     ← route inbound → capability
│   │   ├── thread-matcher.ts     ← match messages to deals
│   │   ├── intent-classifier.ts  ← classify message intent
│   │   └── confidence-gate.ts    ← autonomy threshold logic
│   ├── integrations/             ← external APIs
│   │   ├── aviapages.ts          ← price calculator + flight calculator
│   │   ├── bland-ai.ts           ← Bland AI API client
│   │   ├── resend.ts             ← Resend email API client
│   │   ├── twilio.ts             ← Twilio voice API client
│   │   └── deepgram.ts           ← Deepgram transcription client
│   ├── memory/                   ← persistence layer
│   │   ├── deal-store.ts         ← JSON file-backed storage + query interface
│   │   ├── learning-loop.ts      ← DealContext → DealRecord + persist
│   │   ├── message-store.ts      ← conversation history persistence
│   │   ├── call-store.ts         ← call session + transcript persistence
│   │   ├── edit-memory.ts        ← draft revision history (evaluator feedback)
│   │   ├── autonomy-store.ts     ← confidence gate decisions + escalation log
│   │   └── index.ts
│   ├── templates/                ← email templates
│   │   ├── render.ts             ← template engine
│   │   └── email/
│   │       ├── operator-rfq.html
│   │       ├── client-quote.html
│   │       ├── follow-up.html
│   │       └── confirmation.html
│   ├── utils/                    ← shared utilities
│   │   ├── haversine.ts
│   │   ├── safe-llm-call.ts
│   │   ├── recover-json.ts
│   │   └── index.ts
│   ├── fixtures/                 ← simulation data (operators, airports, pricing)
│   │   └── sim-data.ts
│   ├── config.ts                 ← models, timeouts, margin policy, quote validity
│   └── run-sim.ts                ← scenario runner CLI
├── tests/                        ← 628 tests across 19 files
│   ├── deal-context.test.ts      ← 12 tests
│   ├── guardian.test.ts          ← 52 tests
│   ├── intake.test.ts            ← 68 tests
│   ├── quote.test.ts             ← 37 tests
│   ├── sourcing.test.ts          ← 37 tests
│   ├── scenario.test.ts          ← 36 tests
│   ├── learning-loop.test.ts     ← 39 tests
│   ├── stage-regression.test.ts  ← 25 tests
│   ├── message-router.test.ts    ← 38 tests (Sprint 1)
│   ├── bland-ai.test.ts          ← 26 tests (Sprint 2)
│   ├── email-adapter.test.ts     ← 31 tests (Sprint 3)
│   ├── voice-copilot.test.ts     ← 34 tests (Sprint 4)
│   ├── respond.test.ts           ← 30 tests (Sprint 5)
│   ├── draft-evaluator.test.ts   ← included in Sprint 5
│   ├── sdr.test.ts               ← included in Sprint 5
│   └── comms-integration.test.ts ← 16 tests (Sprint 7)
├── scenarios/                    ← 25 validation scenarios
│   └── scenarios.json
├── dashboard/                    ← Mission Control (Vite + React, port 5174, PWA)
│   ├── package.json
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── components/
│       │   ├── PipelineView.tsx
│       │   ├── DealDetail.tsx
│       │   ├── OperatorNetwork.tsx
│       │   ├── ConversationThread.tsx  ← Sprint 6
│       │   ├── DraftApproval.tsx       ← Sprint 6
│       │   ├── CallAssist.tsx          ← Sprint 6
│       │   ├── InboxFeed.tsx           ← Sprint 6
│       │   ├── SDRQueue.tsx            ← Sprint 6
│       │   ├── AutonomyDashboard.tsx   ← Sprint 6
│       │   └── CommandBar.tsx          ← Sprint 6
│       ├── hooks/
│       │   └── useWebSocket.ts
│       └── fixtures/
├── data/                         ← runtime deal storage (gitignored)
└── archive/
    └── REFERENCE.md              ← pointers to old simulator + SPARC specs
```

## Build Sequence

1. ~~Orchestrator spec + Deal Context schema~~ ✓
2. ~~Guardian capability (continuous validation)~~ ✓
3. ~~Intake capability (parse + qualify)~~ ✓
4. ~~Quote capability (Aviapages API integration)~~ ✓
5. ~~Sourcing capability (operator ranking)~~ ✓
6. ~~Scenario capability (client presentation)~~ ✓
7. ~~Learning loop (deal memory)~~ ✓
8. ~~Dashboard (unified SIM/LIVE)~~ ✓
9. ~~Migrate test scenarios + scenario runner~~ ✓ (92% pass rate)
10. First real deal (Priester Aviation, KPWK) ← NEXT
11. ~~Communication layer Sprint 1 (schemas + router + thread matcher)~~ ✓
12. ~~Communication layer Sprint 2 (Bland AI — voice SDR + iMessage + SMS)~~ ✓
13. ~~Communication layer Sprint 3 (email adapter + web form + MessageStore)~~ ✓
14. ~~Communication layer Sprint 4 (voice copilot — Twilio + Deepgram)~~ ✓
15. ~~Communication layer Sprint 5 (respond + evaluator + edit memory + SDR + confidence gate)~~ ✓
16. ~~Communication layer Sprint 6 (Mission Control extensions — 6 components, 5 tabs)~~ ✓
17. ~~Communication layer Sprint 7 (integration testing + stage regression through comms)~~ ✓

### Step 10 — First Real Deal (NEXT)

- Bland AI account setup + webhook config
- Resend domain verification (charter@osa.aero)
- Twilio + Deepgram API keys
- Deploy dashboard to Vercel

## Commands

```bash
# Run all tests (628 tests)
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

## Workflow Rules

- NEVER call an operator before Guardian validates the trip
- NEVER call an operator before Quote confirms budget alignment
- NEVER present more than one quote to a client (day 1-50)
- ALWAYS log deal outcomes to memory (even failed/rejected deals)
- ALWAYS pay operators fast — this is the #1 relationship builder

## Reference — Previous Work

- Original simulator: `~/osa/simulator/` (5 independent agents, 72% pass rate)
- Original SPARC specs: `~/osa/sparc-specs/` (12 specification documents)
- Original Mission Control: `~/osa/mission-control/`
