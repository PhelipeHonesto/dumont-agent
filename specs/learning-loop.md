# Learning Loop Specification — Dumont Agent

## Role
Every deal teaches the system. The learning loop captures deal outcomes and feeds them
back into the orchestrator's decision-making. This is what makes deal 50 smarter than deal 1.
Inspired by Cartage's Wilson: "learns from freight history to optimize every move."

## This Is New — No Previous Implementation

The original simulator had no learning loop. Agents executed the same logic regardless
of history. This is the single biggest architectural addition in Dumont Agent.

## What Gets Stored (per deal)

```typescript
interface DealRecord {
  id: string;
  timestamp: Date;
  mode: 'sim' | 'live';

  // Route
  route: { departure: string; arrival: string; distance: number };

  // Pricing
  aviapagesEstimate: { low: number; high: number } | null;
  operatorQuote: number | null;
  osaPrice: number | null;
  estimateDelta: number | null;    // (operatorQuote - estimate.median) / estimate.median

  // Operator
  operatorName: string | null;
  operatorBase: string | null;
  operatorResponseTime: number | null;  // seconds
  operatorConversion: boolean;     // did they quote? 

  // Aircraft
  aircraftType: string | null;
  aircraftClass: string | null;

  // Client
  clientType: 'new' | 'repeat';
  clientBudget: { min: number; max: number } | null;
  clientConversion: boolean;       // did they confirm?
  decisionTime: number | null;     // seconds from presentation to decision

  // Outcome
  result: 'closed' | 'lost_to_competition' | 'client_declined' | 'budget_mismatch' | 'aircraft_unavailable' | 'operator_no_response' | 'expired';
  revenue: number | null;
  margin: number | null;

  // Timing
  totalDealTime: number | null;    // seconds from intake to resolution
  dayOfWeek: number;
  season: 'peak' | 'shoulder' | 'off';

  // Meta
  guardianFlags: string[];         // any warnings that fired
}
```

## What The System Learns

### Pricing Intelligence
- Per route: "KTEB→KPBI light jets average $26K, Aviapages underestimates by 8%"
- Per operator: "Elite Aviation quotes 5% above Aviapages median consistently"
- Per season: "Holiday weekends carry 15-20% premium on Southeast routes"
- Per day: "Weekend departures from KTEB run 8% above weekday"

### Operator Intelligence (Lane Performance)
- Per operator per route: conversion rate, average response time, pricing consistency
- Ranking model weights adjust as data accumulates
- New operators start with proximity-weighted defaults, earn history-weighted scores

### Client Intelligence
- Repeat client preferences: aircraft class, budget range, decision speed
- Conversion probability by client type (new vs repeat)
- Budget calibration: do clients' stated budgets match reality?

### Pipeline Intelligence
- Which Guardian checks fire most often? (identifies common edge cases)
- Where do deals fail most? (intake? budget? operator? client decision?)
- Average deal velocity per route type

## Query Interface

The orchestrator queries memory before making decisions:

```typescript
// Get pricing adjustment for a route
memory.getPricingDelta(departure, arrival, aircraftClass): number

// Get best operator for a route
memory.getOperatorRanking(departure, arrival, aircraftClass): OperatorScore[]

// Get client history
memory.getClientHistory(clientName): DealRecord[]

// Get conversion probability
memory.getConversionProbability(route, clientType, budget): number
```

## Storage (Day 1)
JSON file on disk. Simple. No database needed for <100 deals.

## Storage (Day 50+)
SQLite or PostgreSQL. Structured queries. Possibly ruvnet's RuVector for
vector similarity on routes (find "routes similar to KTEB→KPBI").

## Cold Start Problem
Deal 1-10: No history. System uses Aviapages estimates with zero correction.
Operator ranking is pure proximity. This is expected and acceptable.
The learning loop starts producing value at ~20 deals.
