---
name: ship
description: Commit current changes and push. Only invoke after /verify has passed. Generates commit message from staged diff.
---

Ship the current staged changes:

1. `git diff --cached --stat` — show what's staged
2. If nothing is staged, stop and tell me
3. If changes span multiple logical concerns, stop and recommend breaking into separate commits
4. Generate a commit message following the conventional format:

   ```
   <type>: <one-line summary> (<finding-id or scope>)

   [body: 1-2 paragraphs explaining the what and why]

   [references: commit hashes, finding IDs, or audit reports]
   ```

5. Show me the proposed message and wait for approval
6. On approval: `git commit` + `git push`
7. Report the commit hash and confirm push succeeded
