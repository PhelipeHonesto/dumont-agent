# Benchmarks

Measured 2026-10-21 on a 2-vCPU Linux container, Node 22, SQLite deal store. These numbers describe the orchestrator and API layer only. In production, end-to-end latency is dominated by the LLM and the Aviapages pricing call, and those are **not** included here.

## Deal pipeline overhead

The 25-scenario suite (`npm run sim`), run 10 times. Intake → Guardian → Estimate → Guardian → Source → Guardian → Quote → Guardian → Present, with pricing mocked and no LLM calls. 18 scenarios per run reach a price, giving 180 timed deals.

| Metric | Value |
| --- | --- |
| Deals timed | 180 |
| p50 | 9 ms |
| p95 | 29 ms |
| p99 | 42 ms |
| Max | 45 ms |
| Mean | 10.5 ms |

Takeaway: orchestration, four Guardian gates, sourcing, and quote math add about 10 ms per deal. The pipeline itself is never the bottleneck.

Reproduce:

```bash
for i in $(seq 10); do npx tsx src/run-sim.ts | grep -oE "Time: [0-9]+ms"; done
```

## API protection

| Check | Result |
| --- | --- |
| Unauthenticated requests to all 37 non-public routes | 401 on every route (`tests/integration/auth-coverage.test.ts`) |
| Global rate limit: 120 authenticated requests in under a minute | 100 served, 20 rejected with 429 |
| Health probes (`/health`, `/ready`) | Public and exempt from the global limiter |

## Not yet measured

- Intelligence and analytics endpoints against the production Postgres dataset (21M flight legs). These need the production database; numbers from an empty local SQLite file would be misleading.
- End-to-end latency including LLM intake parsing and live pricing.
