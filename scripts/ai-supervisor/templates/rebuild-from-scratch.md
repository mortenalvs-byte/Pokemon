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
1. Commit current state to `wip/{{task_id}}-rebuild-archive` for forensics.
2. Reset HEAD to `origin/main`.
3. Create fresh branch `{{task_branch_v2}}` from main.
4. Start over, applying the lessons above.
5. Use a smaller initial scope than last time.

### Constraints
- Do not copy commits from the contaminated branch.
- Do not revisit the failed approaches listed above.
