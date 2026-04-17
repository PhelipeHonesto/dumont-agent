---
name: plan
description: Enter planning mode with full Dumont context for a non-trivial task. Use for any task with 3+ decision points or 2+ file changes.
---

Enter Plan Mode for the following task: $ARGUMENTS

Before proposing a plan:
1. Read .claude/lessons.md for relevant past pitfalls
2. Identify which agent capability (intake/sourcing/quote/scenario/guardian) or subsystem (orchestrator/memory/mcp/server/ingestion/analytics) this touches
3. State assumptions about host (Mac dev vs Lightsail prod) and database (PG vs SQLite)
4. Flag any Karpathy principles that apply (especially "simplicity over cleverness" and "surgical changes only")

Then propose a plan including:
- Files that will change
- Test impact (will 681 tests still pass?)
- Commit strategy (single commit vs tier-by-tier)
- Rollback path if something breaks

Wait for my approval before switching to execution mode.
