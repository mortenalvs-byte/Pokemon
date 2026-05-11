## Rebuild branch from scratch: {{task_id}}: {{task_title}}

Reviewer determined this branch is contaminated (interleaved unrelated changes, broken-then-patched-then-broken cycles, or a fundamentally wrong approach) and cannot be salvaged piecemeal.

### Reason
{{rebuild_reason}}

### Original goal (preserve)
{{original_goal}}

### What was tried and didn't work
{{#each lessons_learned}}
- {{this}}
{{/each}}

### Next actions
1. Commit current state to `wip/{{task_id}}-rebuild-archive` (the contaminated branch stays intact for forensics; do NOT delete it).
2. From the existing worktree, create a fresh branch from origin/main without touching the contaminated branch:
   `git fetch origin main && git checkout -b {{task_branch_v2}} origin/main`
3. Start over, applying the lessons above.
4. Use a smaller initial scope than last time.

### Constraints
- Do not copy commits from the contaminated branch.
- Do not revisit the failed approaches listed above.
- Do not `git reset --hard`, `git branch -D`, or otherwise destroy the contaminated branch — it is the forensic record.
