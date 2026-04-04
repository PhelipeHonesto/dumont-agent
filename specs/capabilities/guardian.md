# Guardian Capability — Dumont Agent

## Role
Continuous validation layer. NOT a final checkpoint. Runs at EVERY pipeline stage.
Protects three things simultaneously:
1. The client (safety, feasibility, fair pricing)
2. The operator (no impossible trips, no tire-kickers, clean bookings)
3. OSA's reputation (every deal is real, every hold converts)

Think EGPWS — always watching, not just at landing.

## Upgrades from Old Guardian Agent
- **Changed**: From end-of-pipeline gate → invoked at every stage
- **Added**: Operator protection checks (valid cert, insurance, safety record)
- **Added**: Budget sanity check (is price fair for both sides?)
- **Added**: Hold quality protection (is this deal likely to convert?)
- **Fixed**: Warning double-count bug from original implementation
- **Fixed**: checkRange using proper haversine from utils

## Validation Passes

### After INTAKE (stage: 'intake')
- Departure airport exists and is operational
- Arrival airport exists and is operational
- Runway length sufficient for requested aircraft class
- Range feasible (haversine distance vs aircraft max range)
- Pax count within aircraft class capacity
- Date is in the future
- No active TFRs / NOTAMs that block the route (future: Aviapages NOTAM API)

### After ESTIMATE (stage: 'estimated')
- Aviapages estimate returned successfully
- Client budget overlaps with estimate range
- No suspiciously low estimates (possible API error)

### After SOURCING (stage: 'sourced')
- Selected operator has active AOC / Part 135
- Operator insurance is current
- No safety incidents in memory
- Aircraft type matches trip requirements (range, pax, runway)

### After QUOTE (stage: 'quoted')
- Operator quote is within 25% of Aviapages estimate (if wildly off → warning)
- OSA margin is within policy (8-15%)
- Quote validity window is reasonable (>30 min)

### Before PRESENTATION (stage: 'presenting')
- All previous checks still valid (nothing changed since intake)
- Client hasn't been flagged for fraud / non-payment
- Final sanity: everything adds up

## Output Structure
```typescript
interface GuardianPass {
  stage: string;
  passed: boolean;
  checks: {
    name: string;
    passed: boolean;
    severity: 'info' | 'warning' | 'critical';
    message: string;
    data?: any;
  }[];
  timestamp: Date;
}
```

## Blocking vs Warning
- **Critical** (blocks pipeline): runway too short, range impossible, no valid operator, budget mismatch
- **Warning** (flags but continues): estimate accuracy low, operator response slow, quote above estimate
- **Info** (logged only): repeat client detected, seasonal pricing applied, positioning required

## Reference
Previous spec: `~/osa/sparc-specs/guardian-agent.md`
Previous implementation: `~/osa/simulator/src/agents/guardian.ts`
Known bugs to fix: checkRange at line 224, warning double-count at line 361
