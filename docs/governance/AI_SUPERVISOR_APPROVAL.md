# AI Supervisor — Local Dev Tool Approval Record

**Approved:** 2026-05-11 by repo owner (Morten)
**Status:** Active for V1 implementation (PR1: `chore/ai-supervisor-foundation`)
**Scope:** Local dev tooling carve-out under [PR_RULES.md §7](../../PR_RULES.md#7-forbidden-without-explicit-approval)

## What is approved

Use of the OpenAI API (Responses API, `gpt-5.5-pro` reviewer model, `reasoning.effort=xhigh`) as a
**local development and code-review tool**, invoked exclusively by:

- `scripts/ai-supervisor/**` Node scripts.
- Claude Code Stop / PostToolUse / PreToolUse hooks configured in the gitignored
  `.claude/settings.local.json`.

The OpenAI API is NOT used by the application runtime (`src/**`, `src-tauri/**`), the production
bundle (`dist/`), or any code path that ships to end users.

## Hard constraints (non-negotiable)

1. **No OpenAI calls from app runtime.** A banned-string assertion in
   [tests/ai-supervisor-stop-review-pipeline.test.ts](../../tests/ai-supervisor-stop-review-pipeline.test.ts)
   covers `src/**` and `src-tauri/src/**`. Any import or fetch of `api.openai.com` outside
   `scripts/ai-supervisor/**` fails the test suite.

2. **No API keys in the repo.** `OPENAI_API_KEY` lives in the developer's shell environment only
   (Windows User Environment Variable). It is never committed, never default-logged, never written
   to backups. A three-layer redaction (`scripts/ai-supervisor/redact.mjs`) plus a PreToolUse
   key-scan hook (`scripts/ai-supervisor/pre-tool-use-keyscan.mjs`) prevent leakage at packet-build
   time and at Claude-write time.

3. **No user-owned data sent.** Review packets sent to OpenAI contain: code diffs (with sensitive
   files stripped), `npm` script output (typecheck/test/build/audit), supervisor state, current
   task description. Excluded: IndexedDB content, backup JSONs, `.local/`, `.env*`, anything
   matching `**/*.{key,pem,backup-*.json,fixture.json}`.

4. **No auto-merge to `main`.** Ever. V1 produces locally-AUTO_READY branches; operator pushes
   and opens PRs manually. PR4 may add auto-merge to a separate `auto/integration` staging
   branch (NEVER `main`) after operator confidence in the loop. The rule from
   [PR_RULES.md §1](../../PR_RULES.md#1-core-rule) stands: `main` is human-merged.

5. **No remote push, no branch deletion, no worktree deletion** in V1. The supervisor's
   blast radius is purely local-filesystem under `.local/` and `.claude/`.

6. **Hostname allowlist.** `openai-client.mjs` permits only `api.openai.com`. Other hostnames
   throw immediately. No telemetry, no analytics, no third-party calls.

## Why this is OK under §7

PR_RULES §7 forbids "external paid APIs" added to the project. The supervisor is **local dev
tooling**, not a project runtime dependency. It is functionally equivalent to a developer using
ChatGPT in a browser to review their own diff before push — but encoded so the workflow can run
for days unattended. The app itself remains 100% offline-first and frame-independent: end users
are unaffected by this approval.

The supervisor's billing relationship is between the developer and OpenAI directly; the project
does not include API keys, payment information, or any reference to a paid service in code that
ships.

## Revocation

This approval is revoked when any of the following occurs:

- This file is deleted or its `Status:` field changes from `Active` to `Revoked`.
- `.local/ai-supervisor/state.json` is set to `{"approval_revoked": true}`.
- The repo owner explicitly rescinds via a separate `docs/` PR.

Upon revocation, the supervisor (`scripts/ai-supervisor/install-hook.mjs`) refuses to start with
a clear operator-readable message pointing back to this document.

## Versioning

Material changes to this approval (e.g. adding new external APIs, expanding the scope to ship
AI in the production app) require a separate approval PR amending this document and
referencing [PR_RULES.md §7](../../PR_RULES.md#7-forbidden-without-explicit-approval).
