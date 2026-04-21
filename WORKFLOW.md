# OSA Dumont Workflow

The loop for every meaningful change to this codebase.
Based on Boris Cherny's Claude Code patterns, adapted for OSA.

## The loop

`Research → Plan → Execute → Verify → Ship → Learn`

## Step-by-step

### 1. Research (for non-trivial work)

Before Plan Mode, if the change touches code you haven't recently worked on:

```
Use a subagent to explore [what you're touching]. Report back:
- Current structure
- Key files and their responsibilities
- Any existing patterns we should follow
- Any lessons from .claude/lessons.md that apply
```

Subagent keeps main context clean. You get a summary, not the exploration noise.

### 2. Plan (always, for non-trivial work)

```
/plan [description of what you want to do]
```

This enters Plan Mode, reads `lessons.md`, identifies the subsystem, states assumptions, and proposes a plan. Iterate until you approve.

For simple tasks (single file, <20 lines, clear scope): skip Plan Mode, just execute.

### 3. Execute

Switch to Normal Mode. Let Claude Code implement the approved plan. Don't babysit — intervene only if it goes sideways.

If it goes sideways: stop, say "this isn't right, here's why...", and have it re-plan from the correction.

### 4. Verify (NEVER skip this)

```
/verify
```

Runs typecheck, tests, audit-fix regression checks. Returns PASS/FAIL. Do NOT proceed to ship if FAIL.

### 5. Ship

```
/ship
```

Generates commit message from staged diff. Shows you the message. On approval: commits + pushes.

### 6. Learn

If anything went wrong during the task (Claude made a mistake you corrected, assumption that turned out false, workflow friction):

Add a lesson to `.claude/lessons.md`:

```
**LESSON**: [one-line rule]
Context: [2-3 sentences of what went wrong]
```

Newest at top. Commit it with a `docs:` message.

When lessons.md grows past ~30 entries, promote the stable ones to CLAUDE.md and delete them from lessons.md.

## When to use subagents

- Multi-file exploration ("how does X work across the codebase?")
- Verification (via `/verify`, which uses `verify-dumont` subagent)
- Parallel research tasks
- Anything that would eat >5k tokens of main context

When NOT to use subagents:
- Single-file edits
- Quick answers you know from context
- Writing prose

## CLAUDE.md vs lessons.md

- **CLAUDE.md** (131 lines) — stable operating manual. Read every session automatically. Principles and rules.
- **`.claude/lessons.md`** — appendable incident ledger. Context of WHY each rule exists. Specific pitfalls. Reverse-chron.

Rule of thumb: if a new lesson repeats 3+ times, promote to CLAUDE.md. Otherwise keep in lessons.md.

## What's automated vs manual

**Automated** (via slash commands):
- Plan generation with context
- Full verification suite
- Commit message generation + push

**Manual** (requires human judgment):
- Approving plans
- Approving commit messages before push
- Deciding if a lesson promotes to CLAUDE.md
- Triaging audit findings into Critical/High/Medium/Low

## When NOT to follow this

- Throwaway experiments in scratch branches
- Emergency hotfixes (skip Plan, but never skip Verify)
- Single-line doc typo fixes

For everything else, the loop.
