## Continue work on task {{task_id}}: {{task_title}}

Your previous attempt was reviewed and needs adjustment.

### Why blocked
{{summary}}

### Failing checks
{{#each failing_checks}}
- **{{check}}**: {{detail}}
{{/each}}

### Next actions (do in order)
{{#each fix_instructions}}
{{@index}}. {{this}}
{{/each}}

### Constraints
- Only touch files in: {{allowedFiles_csv}}
- Must not change: {{mustNotChange_csv}}
- Repair counter: {{repairCount}}/{{maxRepairs}} (further attempts on the same error signature will quarantine)

Continue. Do not stop until verification is clean.
