// Approval-record parser. Reads YAML frontmatter from .local/ai-supervisor/approvals/*.md
// and validates the schema. NO yaml dependency — purpose-built for the subset we use.
//
// Schema:
//   ---
//   approval_id: appr-<date>-<slug>
//   task_id: task-<...>
//   status: active        # only 'active' is honored
//   issued_at: <ISO 8601 with Z or +HH:MM>
//   expires_at: <ISO 8601 with Z or +HH:MM>
//   operator: <string, min 1 alnum char>
//   approved_paths:
//     - path: <relative path>
//       type: exact | glob
//   restrictions: [<string>, ...]    # optional
//   max_renewals: <integer >=0>
//   renewal_count: <integer >=0>
//   rationale: |
//     <multi-line, min 20 chars>
//   ---
//
// Path canonicalization: rejects approved_paths containing '..' or absolute paths.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const APPROVALS_DIR_DEFAULT = path.join(process.cwd(), '.local', 'ai-supervisor', 'approvals');

// ---- Minimal YAML subset parser ----

/**
 * Extract frontmatter block (between leading --- and second ---) from markdown.
 * Returns the raw frontmatter text or null if not found.
 */
function extractFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

/**
 * Parse the YAML subset we expect. Supports:
 *   key: value
 *   key: |
 *     multi-line
 *     block
 *   key:
 *     - item
 *     - key2: value2
 *       key3: value3
 * Returns { ok: true, data } or { ok: false, error }.
 */
function parseYamlSubset(text) {
  const lines = text.split('\n');
  const data = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }

    // Key at top level (no leading whitespace)
    const topMatch = line.match(/^([a-zA-Z_][\w]*)\s*:(.*)$/);
    if (!topMatch) {
      return { ok: false, error: `Line ${i + 1}: unexpected format: ${line}` };
    }

    const key = topMatch[1];
    const rest = topMatch[2].trim();

    if (rest === '|') {
      // Block scalar — collect indented lines
      const block = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i] === '')) {
        block.push(lines[i].slice(2));
        i++;
      }
      data[key] = block.join('\n').replace(/\n+$/, '');
      continue;
    }

    if (rest === '') {
      // Could be a list or nested map starting on next line
      const items = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() === '') { i++; continue; }
        if (!next.startsWith('  ')) break;

        // List item or sub-key
        if (next.startsWith('  - ')) {
          // List item; possibly a sub-map
          const itemStart = next.slice(4);
          const subItemMatch = itemStart.match(/^([a-zA-Z_][\w]*)\s*:\s*(.*)$/);
          if (subItemMatch) {
            // Sub-map starting on this item
            const subObj = {};
            subObj[subItemMatch[1]] = parseScalar(subItemMatch[2]);
            i++;
            while (i < lines.length && lines[i].startsWith('    ')) {
              const subLine = lines[i].slice(4);
              const subMatch = subLine.match(/^([a-zA-Z_][\w]*)\s*:\s*(.*)$/);
              if (subMatch) subObj[subMatch[1]] = parseScalar(subMatch[2]);
              i++;
            }
            items.push(subObj);
          } else {
            items.push(parseScalar(itemStart));
            i++;
          }
        } else {
          break;
        }
      }
      data[key] = items;
      continue;
    }

    // Inline value (string, number, boolean, inline list)
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      data[key] = inner === '' ? [] : inner.split(',').map(s => parseScalar(s.trim()));
    } else {
      data[key] = parseScalar(rest);
    }
    i++;
  }

  return { ok: true, data };
}

function parseScalar(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  // Strip surrounding quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---- Approval record schema validation ----

const ISO_8601_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const REQUIRED_KEYS = [
  'approval_id', 'task_id', 'status', 'issued_at', 'expires_at',
  'operator', 'approved_paths', 'rationale',
];

/**
 * Validate a parsed approval object.
 * @returns {{ok: true, approval} | {ok: false, error: string}}
 */
export function validateApproval(approval, opts = {}) {
  for (const key of REQUIRED_KEYS) {
    if (!(key in approval)) {
      return { ok: false, error: `Missing required field: ${key}` };
    }
  }

  if (approval.status !== 'active') {
    return { ok: false, error: `Approval status is '${approval.status}', expected 'active'` };
  }

  for (const tsField of ['issued_at', 'expires_at']) {
    if (typeof approval[tsField] !== 'string' || !ISO_8601_WITH_TZ.test(approval[tsField])) {
      return { ok: false, error: `${tsField} must be ISO 8601 with explicit timezone (Z or +HH:MM), got: ${approval[tsField]}` };
    }
  }

  const expiresAt = Date.parse(approval.expires_at);
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(expiresAt)) {
    return { ok: false, error: `expires_at unparseable: ${approval.expires_at}` };
  }
  if (expiresAt <= now) {
    return { ok: false, error: `expired: expires_at=${approval.expires_at} is in the past` };
  }

  if (typeof approval.operator !== 'string' || !/[a-zA-Z0-9]/.test(approval.operator)) {
    return { ok: false, error: `operator must be a string containing at least one alphanumeric char` };
  }

  if (!Array.isArray(approval.approved_paths) || approval.approved_paths.length === 0) {
    return { ok: false, error: `approved_paths must be a non-empty array` };
  }

  for (const entry of approval.approved_paths) {
    if (!entry || typeof entry.path !== 'string') {
      return { ok: false, error: `each approved_paths entry must have a 'path' string` };
    }
    if (entry.path.includes('..')) {
      return { ok: false, error: `approved_paths.path may not contain '..': ${entry.path}` };
    }
    if (path.isAbsolute(entry.path)) {
      return { ok: false, error: `approved_paths.path may not be absolute: ${entry.path}` };
    }
    if (entry.type && entry.type !== 'exact' && entry.type !== 'glob') {
      return { ok: false, error: `approved_paths[].type must be 'exact' or 'glob', got: ${entry.type}` };
    }
  }

  if (typeof approval.rationale !== 'string' || approval.rationale.trim().length < 20) {
    return { ok: false, error: `rationale must be a non-empty string of at least 20 chars` };
  }

  if (approval.max_renewals !== undefined && (typeof approval.max_renewals !== 'number' || approval.max_renewals < 0)) {
    return { ok: false, error: `max_renewals must be a non-negative integer when set` };
  }
  if (approval.renewal_count !== undefined) {
    if (typeof approval.renewal_count !== 'number' || approval.renewal_count < 0) {
      return { ok: false, error: `renewal_count must be a non-negative integer when set` };
    }
    if (approval.max_renewals !== undefined && approval.renewal_count > approval.max_renewals) {
      return { ok: false, error: `renewal_count (${approval.renewal_count}) exceeds max_renewals (${approval.max_renewals})` };
    }
  }

  return { ok: true, approval };
}

// ---- File reading ----

/**
 * Parse a single approval-record markdown file.
 * @returns {{ok: true, approval} | {ok: false, error: string}}
 */
export async function parseApprovalFile(filePath, opts = {}) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    return { ok: false, error: `Cannot read ${filePath}: ${err.message}` };
  }
  const fm = extractFrontmatter(raw);
  if (!fm) {
    return { ok: false, error: `${filePath}: no YAML frontmatter found (expected leading --- block)` };
  }
  const yamlResult = parseYamlSubset(fm);
  if (!yamlResult.ok) {
    return { ok: false, error: `${filePath}: ${yamlResult.error}` };
  }
  return validateApproval(yamlResult.data, opts);
}

/**
 * Load all active approval records from .local/ai-supervisor/approvals/*.md
 * Returns { active: [], invalid: [{file, error}] }.
 */
export async function loadActiveApprovals(approvalsDir = APPROVALS_DIR_DEFAULT, opts = {}) {
  let entries;
  try {
    entries = await readdir(approvalsDir);
  } catch (err) {
    if (err.code === 'ENOENT') return { active: [], invalid: [] };
    throw err;
  }
  const mdFiles = entries.filter(e => e.endsWith('.md'));

  const active = [];
  const invalid = [];
  for (const f of mdFiles) {
    const full = path.join(approvalsDir, f);
    const result = await parseApprovalFile(full, opts);
    if (result.ok) {
      active.push({ file: f, approval: result.approval });
    } else {
      invalid.push({ file: f, error: result.error });
    }
  }
  return { active, invalid };
}

/**
 * Check if a given file path is covered by an active approval for a specific task.
 * Path comparison is canonicalized (resolves dots; rejects path-traversal).
 *
 * @param {string} filePath — relative path being checked (no leading slash)
 * @param {string} taskId
 * @param {Array} activeApprovals — output of loadActiveApprovals().active
 * @returns {{approved: boolean, approval_id?: string, note?: string}}
 */
export function isPathCoveredByApproval(filePath, taskId, activeApprovals) {
  // Canonicalize: normalize separators, resolve dots, reject .. that escapes root
  const canonical = path.posix.normalize(filePath.replace(/\\/g, '/'));
  if (canonical.startsWith('../') || canonical.startsWith('/')) {
    return { approved: false, note: `path canonicalizes outside repo root: ${canonical}` };
  }

  for (const { approval } of activeApprovals) {
    if (approval.task_id !== taskId) continue;

    for (const entry of approval.approved_paths) {
      const entryPath = path.posix.normalize(entry.path.replace(/\\/g, '/'));
      const type = entry.type ?? 'exact';
      if (type === 'exact' && entryPath === canonical) {
        return { approved: true, approval_id: approval.approval_id };
      }
      if (type === 'glob' && matchGlob(canonical, entryPath)) {
        return { approved: true, approval_id: approval.approval_id };
      }
    }
  }
  return { approved: false };
}

function matchGlob(target, pattern) {
  // Convert minimal glob to regex: ** = any (including /), * = any except /
  // The `**` token must be protected via a placeholder so the later `*` →
  // `[^/]*` substitution does not corrupt it (otherwise `**` ends up as
  // `.[^/]*` because the `*` inside `.*` from the first replace gets re-matched).
  const DOUBLE_STAR_SENTINEL = ' DOUBLESTAR ';
  const re = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')        // escape regex specials (not *)
    .replace(/\*\*/g, DOUBLE_STAR_SENTINEL)      // protect ** from the next pass
    .replace(/\*/g, '[^/]*')                      // single * → any except /
    .replace(new RegExp(DOUBLE_STAR_SENTINEL, 'g'), '.*') // restore ** → any
    + '$';
  return new RegExp(re).test(target);
}
