## Task too broad — split required: {{task_id}}: {{task_title}}

Reviewer determined the current diff covers multiple concerns and should be decomposed into sub-tasks.

### Proposed sub-tasks
{{#each sub_prs}}
- **{{title}}**: {{purpose}}
{{/each}}

### Next actions
1. Commit your current work-in-progress to a `wip/{{task_id}}-pre-split` branch (safety net; preserved for operator review).
2. For each sub-task above, create a separate branch directly from `origin/main` without touching the wip branch:
   `git fetch origin main && git checkout -b <sub-task-branch> origin/main`
3. Implement only that sub-task's scope on its branch.
4. Add the sub-tasks to `.local/ai-supervisor/queue.json` (with derived `allowedFiles`/`mustNotChange`).
5. Pick the first sub-task from the queue and continue.

### Constraints
- No mixing of sub-tasks in a single branch.
- The original task is marked `status: split` in state.json (do not re-add it).
- Do not `git reset --hard`, `git branch -D`, or delete the wip branch — it is the operator's record of what triggered the split.
