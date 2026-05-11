## Source documentation required for task {{task_id}}: {{task_title}}

Reviewer indicates the diff touches an external system whose behavior needs authoritative documentation before proceeding.

### Missing sources
{{#each missing_sources}}
- **{{topic}}**: {{url}}
  Rationale: {{rationale}}
  Max age allowed: {{max_age_days}} days
{{/each}}

### Next actions
1. Use the Claude Code WebFetch tool to fetch each URL above.
2. Save fetched content to `.local/ai-supervisor/source-cache/<sha1-of-url>.json` with structure:
   ```json
   {
     "url": "...",
     "fetched_at": "<ISO 8601 UTC>",
     "content_sha256": "...",
     "content": "...markdown or text...",
     "source_kind": "openai-docs|claude-hooks|tauri-docs|github|pokemontcg|other"
   }
   ```
3. Once cached, the next supervisor iteration will see the cache entries and proceed.

### Constraints
- Do not implement the change without source backing.
- Cache hostname must be in allowlist for the declared `source_kind`.
