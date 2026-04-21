## Claude Code Guidelines (Karpathy Principles)

1. **Think Before Coding** — State assumptions explicitly. Present tradeoffs. Push back when a simpler approach exists. Stop and ask when confused rather than guessing.

2. **Simplicity First** — Minimum code that solves the problem. No speculative features, no abstractions for single-use code, no "flexibility" that wasn't requested. If 200 lines could be 50, rewrite it.

3. **Surgical Changes** — Touch only what you must. Don't "improve" adjacent code, comments, or formatting. Don't refactor things that aren't broken. Every changed line should trace directly to the request.

4. **Goal-Driven Execution** — Define success criteria before coding. Transform tasks into verifiable goals:
   - "Add validation" → "Write tests for invalid inputs, then make them pass"
   - "Fix the bug" → "Write a test that reproduces it, then make it pass"
   - For multi-step tasks, state a plan with verification at each step.
