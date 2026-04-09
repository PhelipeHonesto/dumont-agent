# Dumont Agent — Forensic Analysis

> Generated 2026-04-08. Based on reading every file in the repository and running every command.

---

## WHAT EXISTS

### Root Configuration
| File | What it does |
|------|-------------|
| `package.json` | 4 deps (anthropic, express, zod, cors), 5 devDeps. Scripts: test, sim, deal, server, dashboard, typecheck |
| `tsconfig.json` | Strict mode, ES2022, NodeNext modules. Tests excluded |
| `vitest.config.ts` | Discovers `tests/**/*.test.ts`, global APIs |
| `scenarios/scenarios.json` | 25 validation scenarios (9 categories, 72% target pass rate) |

### Source Code — `src/` (53 TypeScript files)

#### Orchestrator (3 files)
| File | What it defines |
|------|----------------|
| `orchestrator/index.ts` | `runPipeline()` + `closeDeal()` — full pipeline engine with pre/post hooks |
| `orchestrator/deal-context-manager.ts` | `createDealContext()`, `updateDealContext()`, `snapshotContext()` with structuredClone isolation |
| `orchestrator/stage-transitions.ts` | `advanceStage()`, `regressStage()` — forward pipeline + backward transitions for re-pricing |

#### Capabilities (10 files)
| File | What it defines |
|------|----------------|
| `capabilities/intake.ts` | Two-layer parser (regex first, Claude fallback). 30+ airport mappings. Repeat client detection |
| `capabilities/guardian.ts` | 5 stage-specific validation passes. Embedded aircraft perf DB (10 types). Continuous — runs every stage |
| `capabilities/quote.ts` | Phase 1 estimate (Aviapages + historical delta). Phase 2 real quote (operator price + margin calc) |
| `capabilities/sourcing.ts` | 5-factor weighted scoring (proximity 30%, lane 25%, response 15%, pricing 15%, relationship 15%) |
| `capabilities/scenario.ts` | Client presentation builder + backup activation logic + timer alerts (70%/90% validity) |
| `capabilities/respond.ts` | Draft generation with edit memory. Confidence scoring per intent (prices/commitments = "never") |
| `capabilities/sdr.ts` | Lead qualification classifier (qualified_with_budget / no_budget / not_qualified / budget_mismatch) |
| `capabilities/draft-evaluator.ts` | Evaluator-optimizer pattern: code checks + injectable LLM eval + optional revision |
| `capabilities/transcript-processor.ts` | Real-time entity extraction from voice (prices, tail numbers, aircraft, airports, negotiation signals) |
| `capabilities/index.ts` | Barrel export |

#### Schemas (7 files)
| File | What it defines |
|------|----------------|
| `schemas/deal-context.ts` | Single source of truth: 9 stages, 5 aircraft classes, all deal fields via Zod |
| `schemas/deal-record.ts` | What persists after deal closes (route, pricing, operator stats, outcome) |
| `schemas/message.ts` | Unified message: 5 channels, 9 intents, confidence levels, `generateMessageId()` |
| `schemas/conversation.ts` | Thread container: `createConversation()`, `addMessageToConversation()` |
| `schemas/call.ts` | Voice pipeline: call session, transcript chunks, 9 entity types |
| `schemas/channel-config.ts` | Per-channel configuration and autonomy rules |
| `schemas/index.ts` | Barrel export |

#### Channel Adapters (6 files)
| File | What it defines |
|------|----------------|
| `channels/adapter.ts` | `ChannelAdapter` interface (receive inbound, deliver outbound, supportsRealtime) |
| `channels/bland-ai.ts` | Bland AI: voice SDR + iMessage (blue bubble) + SMS. Webhook discrimination |
| `channels/email.ts` | Resend: inbound normalization, template rendering, In-Reply-To threading |
| `channels/voice.ts` | Twilio conference + Deepgram transcription. Call brief generation |
| `channels/web-form.ts` | Website "Get a Quote" form → Message normalization. Inbound only |
| `channels/index.ts` | Barrel export |

#### Message Router (4 files)
| File | What it defines |
|------|----------------|
| `router/message-router.ts` | Air traffic controller: match inbound → deal, re-extract fields, classify intent, determine action |
| `router/thread-matcher.ts` | 4-strategy matching: responseToId → phone → email+recency(48h) → threadId |
| `router/intent-classifier.ts` | Pure code-layer intent + sender role classification. No LLM |
| `router/confidence-gate.ts` | Outbound autonomy gatekeeper. Hard "never" list. Graduated autonomy after 10 zero-edit approvals |

#### Integrations (5 files)
| File | What it defines |
|------|----------------|
| `integrations/aviapages.ts` | Price Calculator + Flight Calculator API client. Injectable fetch |
| `integrations/bland-ai.ts` | Bland AI API client (voice SDR, iMessage, SMS) |
| `integrations/resend.ts` | Resend email API client |
| `integrations/twilio.ts` | Twilio conference bridge + participant management + media streams |
| `integrations/deepgram.ts` | Deepgram streaming transcription (Nova-2). 50+ aviation vocabulary terms |

#### Memory / Persistence (7 files)
| File | What it defines |
|------|----------------|
| `memory/deal-store.ts` | JSON file-backed deal record storage. Query by route, operator, client |
| `memory/learning-loop.ts` | DealContext → DealRecord conversion. Season detection, route distance, pricing delta |
| `memory/message-store.ts` | JSON file-backed message history. Query by deal, message, contact |
| `memory/call-store.ts` | Call session + transcript persistence |
| `memory/edit-memory.ts` | Learns broker voice from past corrections. Queries MessageStore for edit patterns |
| `memory/autonomy-store.ts` | Per-template approval tracking. 10 zero-edit approvals → auto-send graduation |
| `memory/index.ts` | Barrel export |

#### Server (4 files + 3 routes) — **Separate from main orchestrator**
| File | What it defines |
|------|----------------|
| `server/index.ts` | Express server on port 3001. Mounts 3 routers |
| `server/dumont-brain.ts` | Conversational engine: extracts fields turn-by-turn, runs estimate + sourcing, returns what to say next. Uses fixture data (not real APIs) |
| `server/claude-sdr.ts` | Claude Haiku generates natural spoken responses over dumont-brain's structured output |
| `server/routes/vapi-llm.ts` | `POST /chat/completions` — OpenAI-compatible SSE endpoint for Vapi voice platform. Streaming + non-streaming |
| `server/routes/conversation.ts` | `POST /api/dumont/respond` — direct REST endpoint for curl testing |
| `server/routes/health.ts` | `GET /health` — health check |

#### Utilities + Fixtures + Templates
| File | What it defines |
|------|----------------|
| `utils/safe-llm-call.ts` | Type-safe LLM wrapper with retry, backoff, Zod validation, JSON recovery |
| `utils/haversine.ts` | Great-circle distance in nautical miles |
| `utils/recover-json.ts` | 3-strategy JSON recovery (strip fences, extract braces, Haiku fix) |
| `utils/errors.ts` | Typed error hierarchy: DumontError → 6 subclasses, each carries dealId/stage/timestamp |
| `fixtures/sim-data.ts` | 18 airports, 14 operators (Priester, Jet Linx, CMC, etc.), route pricing, `mockAviapagesEstimate()` |
| `config.ts` | Models, timeouts, margin policy (8% target), quote validity (120min), sourcing weights |
| `run-sim.ts` | Scenario runner CLI: reads scenarios.json, runs full pipeline, reports pass/fail |
| `templates/render.ts` | `{{placeholder}}` template engine with in-memory cache |
| `templates/email/*.html` | 4 email templates: operator-rfq, client-quote, follow-up, confirmation |

### Tests (16 files, 510 tests)
| File | Tests | Coverage |
|------|-------|----------|
| `deal-context.test.ts` | 12 | Schema validation, context creation, history |
| `guardian.test.ts` | 52 | All 5 validation passes, aircraft perf, cert checks |
| `intake.test.ts` | 68 | Airport resolution, parsing, qualification, repeat detection |
| `quote.test.ts` | 37 | Aviapages integration, estimate/quote phases, margin math |
| `sourcing.test.ts` | 37 | 5-factor scoring, proximity tiers, backup selection |
| `scenario.test.ts` | 36 | Presentation building, timer alerts, substitution prefs |
| `learning-loop.test.ts` | 39 | Deal record building, DealStore queries, operator stats |
| `stage-regression.test.ts` | 25 | Backward transitions, allowed regression rules |
| `edge-cases.test.ts` | 29 | Unicode, empty strings, 1000+ char input, zero pax |
| `comms-sprint1.test.ts` | 38 | Schemas, thread matcher, intent classifier, message router |
| `bland-ai-adapter.test.ts` | 26 | Voice/SMS/iMessage webhook handling |
| `email-webform-adapter.test.ts` | 31 | Resend adapter, web form ingestion, message store |
| `voice-copilot.test.ts` | 34 | Twilio conference, Deepgram transcription, transcript processing |
| `sprint5-respond.test.ts` | 30 | Draft generation, evaluator, edit memory, confidence gate, SDR |
| `integration/end-to-end.test.ts` | 7 | Full pipeline: email → deal → estimate → source → quote → present → close |
| `integration/error-paths.test.ts` | 9 | Budget mismatch, operator unavailable, client decline, expired quote |

### Dashboard (12 components, fixture-only)
| File | What it renders |
|------|----------------|
| `App.tsx` | Main layout: 5 tabs, sidebar + detail panel, SIM/LIVE toggle |
| `PipelineView.tsx` | Deal list with 8-stage progress bars, Guardian badges, budget bars |
| `DealDetail.tsx` | Full deal context: client, trip, pricing, operator, timeline |
| `InboxFeed.tsx` | 5-channel message feed with SDR classification |
| `SDRQueue.tsx` | 4-column Kanban: qualified / no budget / not qualified / mismatch |
| `CallAssist.tsx` | Live call transcript, entity sidebar, talking points brief |
| `AutonomyDashboard.tsx` | Autonomy rules table, graduation progress, edit rates |
| `DraftApproval.tsx` | Pending draft display, confidence badge, inline edit, approve/discard |
| `CommandBar.tsx` | Terminal-style command bar (18 commands, 4 categories, history) |
| `LearningMetrics.tsx` | Deal metrics and learning loop stats |
| `OperatorNetwork.tsx` | Operator stats visualization |
| `StatusLine.tsx` | Footer with SIM/LIVE toggle and deal count |

### Specs (7 documents, 1,644 lines)
| File | What it specifies |
|------|-------------------|
| `specs/orchestrator.md` | Pipeline flow, PIC model, SIM vs LIVE, migration notes |
| `specs/capabilities/intake.md` | Parse rules, qualification gates, repeat detection |
| `specs/capabilities/guardian.md` | 5 validation passes, blocking vs warning, EGPWS analogy |
| `specs/capabilities/quote.md` | Phase 1/2/3 pricing, Aviapages endpoints, learning loop feed |
| `specs/capabilities/sourcing.md` | 5-factor algorithm, weights, one primary + one backup |
| `specs/capabilities/scenario.md` | Presentation format, backup logic, substitution prefs |
| `specs/comms/communication-layer.md` | 1,056-line SPARC v2.2 spec: 8 functional requirements, 4 providers |
| `specs/learning-loop.md` | DealRecord schema, query patterns, feedback loop |

---

## WHAT RUNS

### Commands I ran and their results:

| Command | Result |
|---------|--------|
| `npm test` | **510 tests pass** in 1.48s across 16 files. Zero failures |
| `npm run typecheck` | **0 type errors**. Clean |
| `npm run sim` | **20/25 scenarios pass (80%)**. Target 72% — met. 5 failures in domestic_light, budget_mismatch, special_requirements |
| `npm run server` | **Express starts on port 3001**. Health check returns `{"status":"ok"}` |
| `curl POST /chat/completions` | **Works**. Parses "Chicago to Miami for 4 people next Friday" → returns estimate ($28K-$36K), top operator (Priester), and `transferCall` tool call. Falls back to template response when no ANTHROPIC_API_KEY is set |
| `curl POST /api/dumont/respond` | **Works**. Direct REST endpoint for testing dumont-brain |
| `npm run dashboard` | **Not tested** (requires interactive Vite server). Has its own package.json, React 19, port 5174 |

### What actually works end-to-end right now:

1. **Voice SDR via Vapi** — A caller hits the Vapi voice number → Vapi sends transcript to `/chat/completions` → dumont-brain extracts fields turn by turn → Claude Haiku generates natural spoken response → once all 4 fields collected, gives estimate + transfers to Phelipe's phone. **This is a deployable product.**

2. **Scenario simulator** — `npm run sim` runs 25 real-world charter scenarios through the full pipeline (intake → guardian → estimate → source → quote → present → close). 80% pass rate.

3. **Test suite** — 510 tests covering every capability, every adapter, every schema, edge cases, and 2 integration test suites.

### What does NOT run:

- **No live Bland AI** — no account configured, no webhooks wired
- **No live Resend** — no domain verified, no sending
- **No live Twilio** — no conference bridge, no number
- **No live Deepgram** — no streaming transcription
- **No live Aviapages** — using `mockAviapagesEstimate()` from fixtures
- **Dashboard has no backend** — renders fixture data only, WebSocket hook exists but connects to nothing

---

## ARCHITECTURE SUMMARY

### What's actually built (not what's planned):

```
TWO SEPARATE SYSTEMS EXIST:

SYSTEM 1: Voice SDR (LIVE-READY)
============================================
  Vapi Voice Platform
       │
       ▼
  POST /chat/completions (Express, port 3001)
       │
       ▼
  dumont-brain.ts (stateful session per call_id)
       │ ├── intake extractors (regex, code-layer)
       │ ├── mockAviapagesEstimate() (fixture pricing)
       │ ├── scoreOperator() (5-factor ranking)
       │ └── classifyLead() (SDR qualification)
       ▼
  claude-sdr.ts (Haiku generates spoken response)
       │
       ▼
  SSE stream back to Vapi → caller hears response
       │
       ▼ (when all 4 fields collected)
  transferCall → Phelipe's phone


SYSTEM 2: Full Orchestrator (TESTED, NOT WIRED TO ANYTHING)
============================================
  [No entry point serving live traffic]
       │
       ▼
  runPipeline(request, options)
       │
       ├── intake() ─── parse + qualify
       ├── guardian() ── validate (runs 5x)
       ├── estimate() ── Aviapages price calc
       ├── sourcing() ── 5-factor operator ranking
       ├── quote() ──── operator price + margin
       ├── scenario() ── client presentation
       └── closeDeal() → learning loop → DealStore
       │
       ├── Channel adapters (Bland, Email, Voice, WebForm)
       ├── Message router (thread matching, intent classification)
       ├── Respond + Draft evaluator + Confidence gate
       └── Memory layer (deals, messages, calls, edits, autonomy)

  ALL exercised via test suite only.
  NOT connected to System 1.
```

### The gap:

System 1 (the voice SDR) is a simplified extraction loop that reuses `intake.ts` extractors and `sourcing.ts` scoring — but it **does not use** `runPipeline()`, `guardian()`, `respond()`, `draft-evaluator`, message router, channel adapters, or any of the communication layer. It's a parallel implementation in `dumont-brain.ts` that duplicates core logic in a simpler form.

System 2 (the orchestrator) is the real architecture with 510 tests — but no HTTP server, no webhook handler, no way for a real request to enter it.

---

## CAPABILITIES MATRIX

| Capability | Status | External Dependencies | Tests | Notes |
|-----------|--------|----------------------|-------|-------|
| **Intake** | FUNCTIONAL | Claude API (optional LLM fallback) | 68 passing | Code-layer parser handles 80%+ of requests without LLM |
| **Guardian** | FUNCTIONAL | None | 52 passing | Embedded aircraft perf DB. No external API calls |
| **Quote/Estimate** | PARTIAL | Aviapages API (not connected) | 37 passing | Tests use mock. `mockAviapagesEstimate()` provides fixture prices. Real `AviapagesClient` exists but untested against live API |
| **Sourcing** | FUNCTIONAL | None (uses fixture operators) | 37 passing | Algorithm works. Operator data is hardcoded fixtures, not a live directory |
| **Scenario** | FUNCTIONAL | None | 36 passing | Presentation builder + timer + backup logic all work |
| **Learning Loop** | FUNCTIONAL | Filesystem (JSON files) | 39 passing | Builds records, persists, queries work. `data/sim-deals.json` has ~34 deals from sim runs |
| **Comms: Bland AI** | TESTED (not live) | Bland AI API + webhooks | 26 passing | Adapter code exists. No account, no webhooks configured |
| **Comms: Email** | TESTED (not live) | Resend API + webhooks | 31 passing | Adapter + 4 HTML templates exist. No domain verified |
| **Comms: Voice Copilot** | TESTED (not live) | Twilio + Deepgram | 34 passing | Conference bridge + transcription code exists. No accounts |
| **Comms: Web Form** | TESTED (not live) | None (receives POST) | Included in email tests | No web form frontend exists |
| **Message Router** | TESTED | None | 38 passing | Thread matching, intent classification, re-extraction all work |
| **Respond + Evaluator** | TESTED | Claude API (for draft generation) | 30 passing | Draft generation, confidence gate, edit memory all work in tests |
| **Voice SDR (Server)** | FUNCTIONAL | Vapi + Claude API (optional) | 0 tests | `dumont-brain.ts` works without Claude (template fallback). Separate from orchestrator. **No tests** |
| **Dashboard** | RENDERED (fixture only) | None | 0 tests | 12 components render fixture data. No backend connection |

---

## WHAT'S MISSING FOR DEAL #1

### Minimum path to processing a real charter request:

**Option A: Use what's already live-ready (Voice SDR via Vapi) — 2-4 hours**

This is by far the shortest path. The Express server already works.

1. **Get an Anthropic API key set** → `export ANTHROPIC_API_KEY=sk-...` so Claude generates natural responses instead of templates
2. **Deploy `npm run server` somewhere** → Railway (already has Procfile), Render, or Vercel Functions. It's one Express app, port 3001
3. **Create a Vapi account** → point the "Custom LLM" URL at your deployed `/chat/completions` endpoint
4. **Get a Vapi phone number** → caller dials in, Vapi sends transcript, Dumont responds, transfers to your cell when qualified
5. **Set `BROKER_PHONE`** to your real number in env vars

What you get: A working voice SDR that collects departure, arrival, date, pax → gives a price estimate → transfers to you. You handle the rest manually (call operator, negotiate, quote the client).

What you don't get: Full pipeline, Guardian validation, real Aviapages pricing, operator outreach, automated quoting, learning loop from live deals.

**Option B: Wire the full orchestrator to handle a deal — 2-3 days**

1. **Create an HTTP entry point for `runPipeline()`** — `src/server/routes/deal.ts` that accepts a POST with client request text, calls `runPipeline()`, returns the result
2. **Get Aviapages API credentials** — replace `mockAviapagesEstimate()` with real `AviapagesClient` calls in the server. The client code exists in `integrations/aviapages.ts`
3. **Decide on operator data source** — right now sourcing uses `OPERATORS` from fixtures. For deal #1 with Priester Aviation (KPWK), you could hardcode their data accurately or get Aviapages directory access
4. **Resend domain verification** — verify `charter@osa.aero` so you can send operator RFQs and client quotes via the email adapter
5. **Connect dashboard to server** — add a WebSocket endpoint to the Express server that emits deal state. Point `useWebSocket` hook at it
6. **Bridge System 1 → System 2** — when voice SDR qualifies a lead and transfers to you, create a DealContext in the orchestrator so the rest of the pipeline picks it up

Specific files needed:
- `src/server/routes/deal.ts` — new. HTTP endpoint for `runPipeline()` intake
- `src/server/routes/deal.ts` → import `runPipeline` from orchestrator, create DealContext from parsed request, return pipeline result
- Modify `src/server/dumont-brain.ts` → after `processConversation()` returns `action: "transfer"`, write deal data to orchestrator's DealStore so it persists
- Set env vars: `AVIAPAGES_API_KEY`, `RESEND_API_KEY`, `BROKER_PHONE`, `ANTHROPIC_API_KEY`

**Option C (recommended): Deal #1 the honest way — 1 day**

1. Deploy the voice SDR (Option A, 2 hours)
2. Use it to receive the first call and qualify the lead
3. When it transfers to you, handle everything else manually for deal #1
4. After deal #1 closes, manually create a DealRecord and feed it to the learning loop
5. Build the bridge (Option B) informed by what you actually needed during the real deal

This is what Cartage (YC) did. Ship the SDR, be the human in the loop, automate what hurts.

---

## HONEST ASSESSMENT

### Architecture Vision: A

The SPARC specs are excellent. The PIC/crew model, Guardian-as-continuous-validation, single-operator-per-deal, graduated autonomy, edit memory — these are genuinely sophisticated design decisions. The communication layer spec (1,056 lines) is one of the most thorough AI system specs I've seen. The Cartage model (service-as-software) is the right frame.

### Implementation Progress: B+

53 source files, 510 passing tests, 0 type errors, 80% scenario pass rate. The orchestrator engine is complete and well-tested. The communication layer adapters exist with correct interfaces. The server directory has a working Vapi integration that actually processes voice calls.

Deductions:
- **Two disconnected systems** — the voice SDR (server/) and the orchestrator (src/) aren't wired together
- **CLAUDE.md claims 92% pass rate** but actual run shows **80%** (20/25). Documentation drift
- **Voice SDR has 0 tests** despite being the most production-ready component
- **All external integrations use mocks/fixtures** — none have been validated against live APIs
- **Dashboard connects to nothing** — 12 components rendering demo data

### Launch Readiness: C+

The voice SDR can deploy today with Vapi + an API key. That's real. But the full orchestrator pipeline — the thing that makes this an AI brokerage instead of a phone answering service — has no entry point for live traffic. The gap between "tests pass" and "processes a real deal" is the HTTP glue, API credentials, and the bridge between the two systems.

### What a YC partner would say:

> "You've built an impressive engine and a working voice SDR. Ship the SDR today. Get a phone number. Run your first deal through it this week. The orchestrator tests are great but tests aren't customers. I want to see deal #1 closed before you write another line of spec. The fact that your voice server already works and you haven't deployed it tells me you're building instead of selling. Deploy what works, be the human in the loop for everything else, and let real deals tell you what to automate next."

### Specific risks:
1. **Aviapages API** — all pricing is mocked. First real API call may reveal schema mismatches, rate limits, or pricing that doesn't match fixtures
2. **Operator data** — 14 hardcoded operators with made-up stats. Real sourcing needs real data
3. **Bland AI blue bubble** — iMessage via Bland is a capability claim in the spec but hasn't been tested. iMessage delivery is notoriously finicky
4. **Dashboard disconnection** — the dashboard exists as a separate SPA with no data pipeline. Connecting it requires WebSocket server code that doesn't exist yet

### Bottom line:

You have a working voice SDR that can deploy in hours and a thoroughly tested orchestrator engine that needs a thin HTTP layer to go live. The architecture is sound. The implementation is real (not vaporware). But you're one deployment away from deal #1 and you should have shipped yesterday.

---

*Analysis generated by forensic read of all 53 source files, 16 test files, 7 specs, 12 dashboard components, and live execution of `npm test` (510 pass), `npm run typecheck` (0 errors), `npm run sim` (20/25 pass), and `npm run server` (Express + Vapi endpoint verified).*
