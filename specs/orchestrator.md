# Orchestrator Specification — Dumont Agent

## Role

The Orchestrator is the PIC (Pilot in Command) of every deal. It holds the Deal Context
from first client contact to deal close, calling capabilities in sequence, running Guardian
validation at every stage, and writing outcomes to the learning loop.

It is NOT an agent. It is a pipeline controller that invokes specialized capabilities.

## Inspired By

- **Cartage/Wilson**: Single system coordinates the full transaction
- **ruvnet/Ruflo**: Router → Capabilities → Memory → Learning Loop
- **SPARC**: Spec-first, test-driven, modular architecture

## Deal Context — Single Source of Truth

Every deal creates one DealContext object. It is created by the Orchestrator at intake
and updated by each capability as the deal progresses. No capability owns the context.
The Orchestrator owns it. Capabilities read from and write to it.

```typescript
interface DealContext {
  // Identity
  id: string;
  createdAt: Date;
  updatedAt: Date;
  mode: 'sim' | 'live';

  // Stage tracking
  stage: 'intake' | 'qualified' | 'estimated' | 'sourced' | 'quoted' | 'presented' | 'confirmed' | 'closed' | 'failed';
  stageHistory: { stage: string; timestamp: Date; duration: number }[];

  // Client
  client: {
    name: string;
    contact: string;
    type: 'new' | 'repeat';
    budget: { min: number; max: number } | null;
    substitutionPref: 'auto_within_10pct' | 'always_approve' | 'cancel_if_unavailable' | null;
    qualified: boolean;
    qualificationReason: string | null;
  };

  // Trip
  trip: {
    departure: string;      // ICAO
    arrival: string;        // ICAO
    date: string;           // ISO date
    pax: number;
    aircraftClass: string | null;
    aircraftType: string | null;
    isRoundTrip: boolean;
    specialRequirements: string[];
  };

  // Guardian (populated at every validation pass)
  guardian: {
    passes: { stage: string; passed: boolean; checks: GuardianCheck[]; timestamp: Date }[];
    currentStatus: 'clear' | 'warning' | 'blocked';
    blockReason: string | null;
  };

  // Estimate (from Aviapages)
  estimate: {
    source: 'aviapages' | 'historical' | 'manual';
    flightTime: number | null;       // minutes
    priceRange: { low: number; high: number } | null;
    fuelBurn: number | null;
    positioning: number | null;       // nm from operator base
    calculatedAt: Date | null;
  };

  // Sourcing
  sourcing: {
    selectedOperator: OperatorMatch | null;
    backupOperator: OperatorMatch | null;
    rankingReason: string;
    laneHistory: LaneRecord[];
  };

  // Quote (real quote from operator)
  quote: {
    operatorPrice: number | null;
    osaPrice: number | null;          // with margin
    margin: number | null;            // percentage
    validUntil: Date | null;
    aircraft: { type: string; tail: string; year: number } | null;
    quotedAt: Date | null;
  };

  // Presentation
  presentation: {
    sentAt: Date | null;
    viewedAt: Date | null;
    clientDecision: 'confirmed' | 'declined' | 'expired' | 'pending' | null;
    decisionAt: Date | null;
    timerStarted: Date | null;
  };

  // Outcome (learning loop data)
  outcome: {
    result: 'closed' | 'lost_to_competition' | 'client_declined' | 'budget_mismatch' | 'aircraft_unavailable' | 'operator_no_response' | null;
    estimateVsActual: number | null;  // percentage delta
    operatorResponseTime: number | null; // seconds
    totalDealTime: number | null;     // seconds from intake to close
    revenue: number | null;
    notes: string | null;
  };
}
```

## Pipeline Execution

```
1. INTAKE
   │  Intake capability parses raw request → populates trip + client
   │  Guardian validates: is trip physically possible?
   │  If client budget is null → ask for budget (pipeline pauses)
   │  If client not qualified → stage = 'failed', log reason
   │
2. ESTIMATE  
   │  Quote capability hits Aviapages Price Calculator API
   │  Returns price range for aircraft class on this route
   │  Guardian validates: does client budget overlap estimate range?
   │  If budget below range → stage = 'failed', reason = 'budget_mismatch'
   │  Pipeline stops. Orchestrator flags for human conversation.
   │
3. SOURCE
   │  Sourcing capability queries lane intelligence
   │  Ranks operators by: proximity, conversion history, response time, pricing accuracy
   │  Selects ONE primary + ONE backup (backup is never contacted)
   │  Guardian validates: is operator certified? Active AOC? Insurance current?
   │
4. QUOTE (Human Step — Day 1-50)
   │  Orchestrator signals: "Call [Operator Name] at [phone]. 
   │  Expected price: $X. Route: [DEP]-[ARR]. Aircraft: [Type]."
   │  Phelipe calls, gets real quote, enters it into Deal Context.
   │  Guardian validates: is quote within reasonable range of estimate?
   │
5. PRESENT
   │  Scenario capability generates OSA-branded client quote
   │  Includes aircraft details, safety verification, all-in price
   │  Timer starts. Client has validity window to decide.
   │  Orchestrator monitors: if timer > 70% of validity → alert Phelipe
   │
6. CONFIRM / FAIL
   │  Client confirms → payment captured → operator notified → stage = 'closed'
   │  Client declines → log reason → stage = 'failed'  
   │  Quote expires → attempt backup if client pref allows → or stage = 'failed'
   │  Aircraft sold → activate backup → re-present if client pref = 'auto'
   │
7. LEARN
   │  Orchestrator writes full DealContext to memory
   │  Key metrics logged: estimate vs actual, operator response time, conversion
   │  Lane intelligence updated for this route + operator combination
   │  Pricing model adjusted based on delta
```

## Hooks (ruvnet pattern)

### Pre-hooks (run before each capability)
- Log stage entry timestamp
- Check Guardian status (abort if blocked)
- Load relevant historical data from memory

### Post-hooks (run after each capability)
- Log stage completion + duration
- Update Deal Context
- Push state change to Mission Control dashboard
- Write to memory if deal is terminal (closed or failed)

## SIM vs LIVE Mode

The Orchestrator accepts a `mode` parameter:
- `sim`: Deal Context is created from a scenario fixture. Step 4 (QUOTE) is simulated with fixture data. No real operator call.
- `live`: Deal Context is created from a real client request. Step 4 requires human input. Real operator call.

The pipeline logic is IDENTICAL in both modes. Only the data source differs.

## Dashboard Integration

Every stage transition emits an event that the Mission Control dashboard subscribes to.
The dashboard renders the current state of all active deals from the Orchestrator's deal registry.
No separate data layer. The dashboard reads directly from Deal Context objects.

## Migration from Previous Agents

| Old Agent | New Capability | Key Changes |
|-----------|---------------|-------------|
| Intake Agent | intake.ts | Added client qualification, budget capture |
| Sourcing Agent | sourcing.ts | Single operator selection, lane intelligence |
| Quote Agent | quote.ts | Aviapages API integration, budget gate |
| Scenario Agent | scenario.ts | Single quote presentation, backup ranking |
| Guardian Agent | guardian.ts | Continuous (every stage), not final checkpoint |
| Pipeline.ts | orchestrator/index.ts | Single controller, not relay chain |
| DealContextManager | orchestrator/deal-context.ts | Same concept, richer schema |

## Success Metrics

- Guardian catch rate: >95% of invalid trips blocked before operator call
- Quote accuracy: estimate within 10% of actual operator quote
- Conversion rate: >70% of presented quotes result in confirmed deals
- Operator satisfaction: <5% of quote requests result in "not available"
- Deal velocity: intake to presentation in <20 minutes (day 1-50)
