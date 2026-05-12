// Pokemon-specific scope guard. Runs BEFORE OpenAI is called.
// Returns { passed: true } or { passed: false, violations: [...] } with a list
// of hard-forbidden path/content violations.
//
// All 19 gates implemented; see scripts/ai-supervisor/CLAUDE.md (Layer 8) for
// canonical list. Approval-record unblock: if a violation is covered by a
// matching active approval record, it's downgraded to a noted-but-allowed pass.

import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { isPathCoveredByApproval, loadActiveApprovals } from './parse-approval.mjs';

// Sacred user-data store names from DATA_MODEL.md §2 + src/db/schema.ts:31-43.
const SACRED_STORE_NAMES = [
  'holdings', 'lots', 'lotItems', 'binders', 'binderSlots',
  'wishlist', 'auditLog', 'settings', 'appMeta',
];

// Reserved settings/appMeta keys per DATA_MODEL.md §7.
const RESERVED_SETTINGS_KEYS = ['pokemonTcgApiKey', 'preferredCurrency', 'defaultCondition', 'defaultBinderSlotsPerPage'];
const RESERVED_APPMETA_KEYS = ['schemaVersion', 'appVersion', 'lastSyncAt', 'lastBackupAt', 'lastBackupHoldingCount', 'persistentStorageGranted', 'lastMigrationAt'];

// Files that may not be touched without approval. Each entry: { matcher, gate, severity }
const HARD_FORBIDDEN_PATTERNS = [
  // 1. schema.ts (any change)
  { matcher: /^src\/db\/schema\.ts$/, gate: 'src-db-schema', detail: 'src/db/schema.ts is the IndexedDB schema authority (SCHEMA_VERSION=2). No changes without approval.' },
  // 2. db logic files (any change)
  { matcher: /^src\/db\/(backup|restore|auto-backup)\.ts$/, gate: 'src-db-logic', detail: 'src/db/{backup,restore,auto-backup}.ts logic changes require approval (only PR33-style hardening permitted via approval_change_kind=hardening).' },
  // 3. BACKUP_FORMAT.md
  { matcher: /^BACKUP_FORMAT\.md$/, gate: 'backup-format-doc', detail: 'BACKUP_FORMAT.md is the on-disk backup contract. No changes without approval (and no schemaVersion bump in V1).' },
  // 4. Tauri capabilities
  { matcher: /^src-tauri\/capabilities\/.*\.json$/, gate: 'tauri-capabilities', detail: 'src-tauri/capabilities/*.json controls Tauri capability scope (stays at core:default only per roadmap stop conditions).' },
  // 4b. Tauri CSP (only the security.csp section of tauri.conf.json)
  // Note: tauri.conf.json may have other allowed changes; CSP-specific check is done in content scanner below.
  // 5. package.json dependency changes - content-scanner below
  // 6. New external-API hostnames in src/api/** - content-scanner below
  // 7. Sacred-store-name deletions - content-scanner below
  // 8. auditLog UPDATE/DELETE - content-scanner below
  // 9. backup file 12-key invariant - content-scanner below
  // 10. pokemonTcgApiKey logged outside settings - content-scanner below
  // 11. binderSlotsRepo direct writes - content-scanner below
  // 12. Reserved key renames - content-scanner below
  // 13. supervisor self-modification
  { matcher: /^scripts\/ai-supervisor\//, gate: 'supervisor-self-mod', detail: 'scripts/ai-supervisor/** changes require a QUORUM approval record (two distinct operator fields). Single-operator approval is insufficient.', requiresQuorum: true },
  // 14. .claude/plans/**
  { matcher: /^\.claude\/plans\//, gate: 'claude-plans', detail: '.claude/plans/** is operator-owned planning area. Supervisor must not let Claude edit its own plan files.' },
  // 15. Test infrastructure
  { matcher: /^(tests\/setup\.ts|tests\/setup-app\.ts|tests\/setup-supervisor\.ts|vitest\.config\.ts|tests\/.*vitest\.config\.ts)$/, gate: 'test-infrastructure', detail: 'Test setup files and vitest config require approval; changes here can silently break all tests.' },
  // 16. tsconfig.json strictness - content-scanner below
  // 17. .claude/projects/**
  { matcher: /^\.claude\/projects\//, gate: 'claude-projects', detail: '.claude/projects/** is Claude Code\'s own transcript storage; never modify.' },
  // 18. CLAUDE.md files (root or subdir, but NOT the supervisor\'s own internal one)
  { matcher: /(?:^|\/)CLAUDE\.md$/, gate: 'claude-md', detail: 'CLAUDE.md files are operator-curated context. Changes require approval. (Exception: scripts/ai-supervisor/CLAUDE.md is governed by supervisor-self-mod gate.)' },
];

// Content-pattern checks against the diff text itself.
const CONTENT_CHECKS = [
  // 5. package.json deps add/remove (any "+ key": "value" addition in package.json requires review)
  {
    gate: 'package-json-deps',
    appliesTo: (filePath) => filePath === 'package.json' || filePath === 'package-lock.json',
    test: (diffText) => /^\+\s*"[^"]+":\s*"[^"]*"/m.test(diffText),
    detail: 'package.json edits (including dep adds/version bumps/script changes) require approval. No new deps in V1.',
  },
  // 7. Sacred-store-name deletions
  {
    gate: 'sacred-store-deletion',
    appliesTo: (filePath) => filePath.startsWith('src/db/'),
    test: (diffText) => SACRED_STORE_NAMES.some(name => new RegExp(`^-\\s*${name}\\s*:`, 'm').test(diffText)),
    detail: 'A sacred user-data store name has been deleted from src/db/. This is forbidden without a separate KRAVSPEC-level approval PR.',
  },
  // 8. auditLog UPDATE/DELETE — broadened to cover Dexie direct-table forms.
  // Catches all reasonable mutation entry points whether the code goes through
  // a repo wrapper or hits Dexie directly. Inserts (.add / .bulkAdd / .put on
  // a NEW key) are allowed by gate intent, but Dexie's `.put` can also overwrite;
  // we flag `.put` on auditLog conservatively — the operator can use approval
  // records to greenlight a legitimate audit-log INSERT path that uses .put().
  {
    gate: 'audit-log-mutation',
    appliesTo: (filePath) => filePath.endsWith('.ts') && !filePath.startsWith('tests/'),
    test: (diffText) => {
      const PATTERNS = [
        /^\+.*auditLog(?:Repo)?\.(update|delete|put|bulkPut|bulkDelete|clear)\s*\(/m,
        /^\+.*\bdb\.auditLog\.(update|delete|put|bulkPut|bulkDelete|clear)\s*\(/m,
        /^\+.*\bdb\.table\(\s*['"]auditLog['"]\s*\)\.(update|delete|put|bulkPut|bulkDelete|clear)\s*\(/m,
        /^\+.*\.where\(\s*['"]?auditLog['"]?[^)]*\)\.(modify|delete)\s*\(/m,
      ];
      return PATTERNS.some(re => re.test(diffText));
    },
    detail: 'auditLog is append-only (DATA_MODEL.md §4). UPDATE/DELETE/PUT/CLEAR on auditLog rows is forbidden in any form (auditLogRepo, db.auditLog, db.table("auditLog"), .where(...).modify/delete). Only INSERT via .add/.bulkAdd is permitted.',
  },
  // 10. pokemonTcgApiKey leak
  {
    gate: 'api-key-leak',
    appliesTo: (filePath) => !filePath.startsWith('src/db/') && !filePath.startsWith('tests/') && !filePath.endsWith('.md') && !filePath.startsWith('scripts/ai-supervisor/'),
    test: (diffText) => /^\+.*(console\.log|writeFile|appendFile|fs\.write).*pokemonTcgApiKey/m.test(diffText),
    detail: 'pokemonTcgApiKey may not be logged or written outside the IndexedDB settings store (KRAVSPEC §11, BACKUP_FORMAT.md §3).',
  },
  // 11. binderSlotsRepo direct writes
  {
    gate: 'binder-slots-bypass',
    appliesTo: (filePath) => filePath.endsWith('.ts') &&
                              !filePath.startsWith('tests/') &&
                              filePath !== 'src/services/binder-assignment-service.ts' &&
                              !filePath.includes('binder-slot-service'),
    test: (diffText) => /^\+.*binderSlots(?:Repo)?\.(update|put|bulkPut)\s*\(/m.test(diffText),
    detail: 'binderSlotsRepo.update/.put/.bulkPut may only be called from binder-assignment-service (single writer). PR 24 invariant.',
  },
  // 12. Reserved key renames - heuristic: removal of an old key + addition of a near-similar new key in same file
  // (Cheap version: just flag any DIFF that removes a reserved key name.)
  {
    gate: 'reserved-key-rename',
    appliesTo: (filePath) => filePath.startsWith('src/db/') || filePath === 'src/domain/types.ts',
    test: (diffText) => {
      for (const key of [...RESERVED_SETTINGS_KEYS, ...RESERVED_APPMETA_KEYS]) {
        if (new RegExp(`^-.*['"\`]${key}['"\`]`, 'm').test(diffText)) return true;
      }
      return false;
    },
    detail: 'Removal/rename of a reserved settings or appMeta key requires an in-PR migration. Reserved keys are tied to backup format and external tooling.',
  },
  // 16. tsconfig.json strictness loosening
  {
    gate: 'tsconfig-strictness',
    appliesTo: (filePath) => filePath === 'tsconfig.json',
    test: (diffText) => /^\+\s*"(strict|noUncheckedIndexedAccess|exactOptionalPropertyTypes|noImplicitOverride|noUnusedLocals|noUnusedParameters|verbatimModuleSyntax|isolatedModules)"\s*:\s*false/m.test(diffText) ||
                       /^-\s*"(strict|noUncheckedIndexedAccess|exactOptionalPropertyTypes|noImplicitOverride|noUnusedLocals|noUnusedParameters|verbatimModuleSyntax|isolatedModules)"\s*:\s*true/m.test(diffText),
    detail: 'tsconfig.json strictness flags must not be removed or set to false. The project depends on strict types catching data-shape mistakes.',
  },
  // 19. .skip() additions to existing test files
  {
    gate: 'test-skip-addition',
    appliesTo: (filePath) => filePath.startsWith('tests/') && (filePath.endsWith('.test.ts') || filePath.endsWith('.spec.ts')),
    test: (diffText) => /^\+.*\b(it|test|describe)\.skip\s*\(/m.test(diffText),
    detail: 'Adding .skip() to an existing test silently disables coverage. Requires explicit approval.',
  },
  // 6. New external-API hostnames in src/api/**
  {
    gate: 'new-api-hostname',
    appliesTo: (filePath) => filePath.startsWith('src/api/'),
    test: (diffText) => {
      // Look for added fetch calls with NEW hostnames (anything not pokemontcg.io)
      const added = diffText.split('\n').filter(l => l.startsWith('+'));
      for (const line of added) {
        const m = line.match(/https?:\/\/([a-z0-9.-]+)/i);
        if (m && !m[1].includes('pokemontcg.io')) return true;
      }
      return false;
    },
    detail: 'New external API hostnames in src/api/** require approval. Only pokemontcg.io is permitted by default.',
  },
  // 4b. src-tauri/tauri.conf.json security.csp changes (gate #4 path-pattern covers capabilities/*.json;
  // the CSP lives in tauri.conf.json and needs a content-pattern check to detect mutation).
  {
    gate: 'tauri-csp',
    appliesTo: (filePath) => filePath === 'src-tauri/tauri.conf.json',
    test: (diffText) => /^[+\-]\s*"csp"\s*:/m.test(diffText) ||
                         /^[+\-].*"security"\s*:\s*\{[^}]*"csp"/m.test(diffText),
    detail: 'src-tauri/tauri.conf.json security.csp must not change without explicit approval. The CSP pins what HTTP origins the desktop shell may contact.',
  },
];

// Backup-file 12-key invariant check — applied to diffs that touch src/db/backup.ts
// or scripts that produce backup files.
function checkBackupFileShape(diffText, filePath) {
  if (!filePath.includes('backup')) return null;
  // Strip the leading `+` from added diff lines BEFORE pattern-matching;
  // otherwise multiline `^app:` anchors never trigger because each line
  // starts with `+`. This was the reviewer-flagged bug.
  const added = diffText.split('\n')
    .filter(l => l.startsWith('+'))
    .map(l => l.slice(1))           // drop the '+' so line starts with actual content
    .join('\n');
  if (!/^\s*['"]?app['"]?\s*:/m.test(added)) return null;

  const required = ['app', 'schemaVersion', 'exportedAt', 'settings', 'sets', 'cards', 'holdings', 'lots', 'lotItems', 'binders', 'binderSlots', 'wishlist', 'auditLog', 'appMeta'];
  const missing = required.filter(key => !new RegExp(`['"]?${key}['"]?\\s*:`).test(added));
  if (missing.length === 0) return null;

  return {
    gate: 'backup-file-shape',
    detail: `Backup file emission appears to miss required keys: ${missing.join(', ')}. BACKUP_FORMAT.md §2 requires all 12 top-level keys + app === "Pokemon TCG Tracker".`,
  };
}

// ---- Public API ----

/**
 * Check a set of changed files against scope-guard rules.
 *
 * @param {object} input
 * @param {string[]} input.changedFiles — list of repo-relative paths
 * @param {string} input.fullDiff — `git diff origin/main..HEAD` output
 * @param {object|null} input.currentTask — task being worked on (provides task_id + allowedFiles)
 * @param {string} [input.approvalsDir] — override for approval records location
 * @returns {Promise<{passed: boolean, violations: object[], approvalsUsed: string[]}>}
 */
export async function runScopeGuard(input) {
  const { changedFiles, fullDiff, currentTask } = input;
  const approvalsDir = input.approvalsDir;

  // Post-AUTO_READY loop-pause: when there's no current task in the queue
  // (queue was emptied after AUTO_READY), the diff represents committed
  // work that was already reviewed in its owning task's iterations.
  // Re-flagging it as a violation would deadlock the loop — approvals
  // are keyed by task_id and no approval can match a null currentTask.
  // Approved 2026-05-12 via quorum (appr-2026-05-12-scopeguard-no-task-A/B).
  if (!currentTask?.id) {
    return {
      passed: true,
      violations: [],
      approvalsUsed: [],
      notes: ['no current task — committed work skipped (post-AUTO_READY loop-pause state)'],
    };
  }

  const approvalsResult = approvalsDir
    ? await loadActiveApprovals(approvalsDir)
    : await loadActiveApprovals();

  const activeApprovals = approvalsResult.active;
  const violations = [];
  const approvalsUsed = new Set();

  // ---- Per-file path checks (gates 1-4, 13-15, 17-18)
  for (const file of changedFiles) {
    for (const { matcher, gate, detail, requiresQuorum } of HARD_FORBIDDEN_PATTERNS) {
      if (!matcher.test(file)) continue;

      // Check for approval coverage
      let approved = false;
      if (currentTask?.id) {
        const cov = isPathCoveredByApproval(file, currentTask.id, activeApprovals);
        if (cov.approved) {
          // For requiresQuorum gates (supervisor self-mod), need TWO distinct approvals
          if (requiresQuorum) {
            // Respect approved_paths[].type: exact paths must literal-match (no
            // wildcard interpretation); glob paths run through matchGlobLocal.
            // A wildcard-looking path declared `type: exact` MUST NOT contribute
            // to quorum just because it superficially resembles a glob.
            const coveringApprovals = activeApprovals.filter(a =>
              a.approval.task_id === currentTask.id &&
              a.approval.approved_paths.some(p => {
                const t = p.type ?? 'exact';
                if (t === 'exact') return p.path === file;
                if (t === 'glob') return matchGlobLocal(file, p.path);
                return false;
              })
            );
            const distinctOperators = new Set(coveringApprovals.map(a => a.approval.operator));
            if (distinctOperators.size >= 2) {
              approved = true;
              for (const a of coveringApprovals) approvalsUsed.add(a.approval.approval_id);
            } else {
              violations.push({ gate, file, detail: `${detail} Found ${distinctOperators.size} distinct-operator approval(s); need ≥2.`, severity: 'HIGH' });
              continue;
            }
          } else {
            approved = true;
            approvalsUsed.add(cov.approval_id);
          }
        }
      }
      if (!approved) {
        violations.push({ gate, file, detail, severity: 'HIGH' });
      }
    }

    // ---- allowedFiles enforcement (per-task)
    if (currentTask?.allowedFiles && currentTask.allowedFiles.length > 0) {
      const isAllowed = currentTask.allowedFiles.some(pattern => matchGlobLocal(file, pattern));
      if (!isAllowed) {
        // Files outside allowedFiles are blocked UNLESS approval covers them
        if (currentTask.id) {
          const cov = isPathCoveredByApproval(file, currentTask.id, activeApprovals);
          if (cov.approved) {
            approvalsUsed.add(cov.approval_id);
            continue;
          }
        }
        violations.push({
          gate: 'allowed-files-out-of-scope',
          file,
          detail: `File is not in current task's allowedFiles list. Either add it to queue.json or revert the change.`,
          severity: 'MEDIUM',
        });
      }
    }
  }

  // ---- Content-pattern checks against the unified diff
  for (const check of CONTENT_CHECKS) {
    // Slice the diff per-file (heuristic: between "diff --git a/<file>" markers)
    const fileDiffs = splitDiffByFile(fullDiff);
    for (const [filePath, diffText] of fileDiffs) {
      if (!check.appliesTo(filePath)) continue;
      if (!check.test(diffText)) continue;

      let approved = false;
      if (currentTask?.id) {
        const cov = isPathCoveredByApproval(filePath, currentTask.id, activeApprovals);
        if (cov.approved) {
          approved = true;
          approvalsUsed.add(cov.approval_id);
        }
      }
      if (!approved) {
        violations.push({ gate: check.gate, file: filePath, detail: check.detail, severity: 'HIGH' });
      }
    }
  }

  // ---- Backup file shape (gate 9)
  const fileDiffs = splitDiffByFile(fullDiff);
  for (const [filePath, diffText] of fileDiffs) {
    const result = checkBackupFileShape(diffText, filePath);
    if (result) {
      violations.push({ ...result, file: filePath, severity: 'HIGH' });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    approvalsUsed: Array.from(approvalsUsed),
  };
}

function splitDiffByFile(fullDiff) {
  if (!fullDiff) return [];
  const out = new Map();
  const parts = fullDiff.split(/^diff --git a\/(.+?) b\/.+$/m);
  // parts[0] = preamble (empty), parts[1] = filename, parts[2] = body, parts[3] = filename, ...
  for (let i = 1; i < parts.length; i += 2) {
    const file = parts[i];
    const body = parts[i + 1] ?? '';
    out.set(file, body);
  }
  return out;
}

function matchGlobLocal(target, pattern) {
  // Convert minimal glob to regex with a sentinel for ** so the later
  // `*` -> `[^/]*` pass does not corrupt the recursive-wildcard semantics.
  const DOUBLE_STAR_SENTINEL = ' DOUBLESTAR ';
  const re = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, DOUBLE_STAR_SENTINEL)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(DOUBLE_STAR_SENTINEL, 'g'), '.*')
    + '$';
  return new RegExp(re).test(target);
}

// Re-export for use by stop-review.mjs
export { HARD_FORBIDDEN_PATTERNS, CONTENT_CHECKS, SACRED_STORE_NAMES };
