## Next task: {{task_id}}: {{task_title}}

Previous task reached AUTO_READY. Time for the next one.

{{#if should_switch_branch}}
### Branch switch required
The next task uses a different branch. Take these steps in order:

1. Verify clean worktree: `git status --short` should be empty (or only contain `.local/` changes).
2. If uncommitted work exists on the current branch, commit it now with a clear message.
3. `git fetch origin main` to refresh the base.
4. `git checkout main && git pull` (or `git checkout origin/main -b temp` if in a worktree where main is checked out elsewhere).
5. `git checkout -b {{task_branch_hint}}` (or `git checkout {{task_branch_hint}}` if it already exists).
{{/if}}

### Task description
{{task_description}}

### Acceptance criteria
{{#each acceptance}}
- {{this}}
{{/each}}

### Constraints (mustNotChange)
{{#each mustNotChange}}
- {{this}}
{{/each}}

### Allowed file scope
{{#each allowedFiles}}
- {{this}}
{{/each}}

### Approach
Plan step-by-step. Edit files. Verify. Continue until AUTO_READY.
