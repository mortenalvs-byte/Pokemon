// Git state collector. Cross-platform via child_process.execFile.
// Refuses to proceed when on main branch, detached HEAD, or rebase-in-progress.
// Strips binary file content from diffs; only file names + sizes are reported.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

const exec = promisify(execFile);

const EXCLUDE_PATHS = [
  ':(exclude)node_modules',
  ':(exclude)dist',
  ':(exclude).git',
  ':(exclude).local',
  ':(exclude).claude',
  ':(exclude)coverage',
  ':(exclude)src-tauri/target',
];

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bin', '.lock',
  '.woff', '.woff2', '.ttf', '.eot', '.zip', '.gz', '.tar',
]);

async function runGit(args, opts = {}) {
  try {
    const { stdout, stderr } = await exec('git', args, { maxBuffer: 50_000_000, ...opts });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code };
  }
}

/**
 * Collect git evidence for the current worktree state.
 * Returns { ok, evidence, gate } where gate is a fatal pre-check result.
 */
export async function collectGitEvidence(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();

  // ---- Pre-checks: must not be on main, no detached HEAD, no in-progress operations
  const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (!branchResult.ok) {
    return { ok: false, gate: { reason: 'git rev-parse failed', detail: branchResult.stderr } };
  }
  const branch = branchResult.stdout.trim();

  if (branch === 'main') {
    return {
      ok: false,
      gate: { reason: 'on-main-branch', detail: 'Supervisor refuses to run on main (PR_RULES §1). Switch to a feature branch first.' },
    };
  }

  if (branch === 'HEAD') {
    return {
      ok: false,
      gate: { reason: 'detached-head', detail: 'HEAD is detached. Complete or abort the in-progress git operation first.' },
    };
  }

  // Detect rebase/merge/cherry-pick in progress
  const inProgress = await detectInProgressOps(cwd);
  if (inProgress) {
    return {
      ok: false,
      gate: { reason: 'git-op-in-progress', detail: `${inProgress} in progress. Complete or abort before running the supervisor.` },
    };
  }

  // ---- Collect evidence
  // We need to see the FULL worktree state: committed diff origin/main..HEAD
  // PLUS staged + unstaged changes + untracked files. The Stop hook fires
  // AFTER Claude's last action; that action almost always leaves uncommitted
  // work that scope-guard MUST see. Reviewing only origin/main..HEAD is a
  // critical bypass.
  const [statusR, headShaR, mergeBaseR,
         committedFilesR, committedDiffR, diffStatR,
         stagedFilesR, stagedDiffR,
         unstagedFilesR, unstagedDiffR,
         untrackedR, aheadR] = await Promise.all([
    runGit(['status', '--porcelain', '--branch'], { cwd }),
    runGit(['rev-parse', 'HEAD'], { cwd }),
    runGit(['merge-base', 'HEAD', 'origin/main'], { cwd }),
    runGit(['diff', '--name-only', 'origin/main...HEAD', '--', '.', ...EXCLUDE_PATHS], { cwd }),
    runGit(['diff', '--no-color', '--unified=3', 'origin/main...HEAD', '--', '.', ...EXCLUDE_PATHS], { cwd }),
    runGit(['diff', '--stat', 'origin/main...HEAD', '--', '.', ...EXCLUDE_PATHS], { cwd }),
    runGit(['diff', '--name-only', '--cached', '--', '.', ...EXCLUDE_PATHS], { cwd }),
    runGit(['diff', '--no-color', '--unified=3', '--cached', '--', '.', ...EXCLUDE_PATHS], { cwd }),
    runGit(['diff', '--name-only', '--', '.', ...EXCLUDE_PATHS], { cwd }),
    runGit(['diff', '--no-color', '--unified=3', '--', '.', ...EXCLUDE_PATHS], { cwd }),
    runGit(['ls-files', '--others', '--exclude-standard', '--', '.', ...EXCLUDE_PATHS], { cwd }),
    runGit(['rev-list', '--count', 'HEAD', '^origin/main'], { cwd }),
  ]);

  const committedFiles = (committedFilesR.stdout ?? '').split('\n').filter(Boolean);
  const stagedFiles    = (stagedFilesR.stdout    ?? '').split('\n').filter(Boolean);
  const unstagedFiles  = (unstagedFilesR.stdout  ?? '').split('\n').filter(Boolean);
  const untrackedFiles = (untrackedR.stdout      ?? '').split('\n').filter(Boolean);
  const changedFiles   = Array.from(new Set([...committedFiles, ...stagedFiles, ...unstagedFiles, ...untrackedFiles])).sort();
  const aheadCount     = parseInt((aheadR.stdout ?? '0').trim(), 10);

  // Build the FULL composite diff (no truncation) — scope-guard runs against this.
  const fullDiffParts = [];
  if (committedDiffR.stdout && committedDiffR.stdout.length > 0) {
    fullDiffParts.push(`### Committed (origin/main..HEAD)\n${committedDiffR.stdout}`);
  }
  if (stagedDiffR.stdout && stagedDiffR.stdout.length > 0) {
    fullDiffParts.push(`### Staged (uncommitted, in index)\n${stagedDiffR.stdout}`);
  }
  if (unstagedDiffR.stdout && unstagedDiffR.stdout.length > 0) {
    fullDiffParts.push(`### Unstaged (working tree)\n${unstagedDiffR.stdout}`);
  }
  // Untracked files: synthesize a pseudo-diff so scope-guard sees their content.
  for (const f of untrackedFiles) {
    const ext = path.extname(f).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;
    try {
      const content = await readFile(path.join(cwd, f), 'utf8');
      const numbered = content.split('\n').map(line => `+${line}`).join('\n');
      fullDiffParts.push(`### Untracked: ${f}\ndiff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n${numbered}`);
    } catch { /* unreadable; skip */ }
  }
  const fullDiff = fullDiffParts.join('\n\n');

  // Sanitize + truncate for the OpenAI packet only (safety uses fullDiff).
  const packetDiffSanitized = await sanitizeDiff(fullDiff, changedFiles, cwd);

  return {
    ok: true,
    evidence: {
      branch,
      head_sha: (headShaR.stdout ?? '').trim(),
      merge_base: (mergeBaseR.stdout ?? '').trim(),
      ahead_of_main: aheadCount,
      changed_files: changedFiles,
      committed_files: committedFiles,
      staged_files: stagedFiles,
      unstaged_files: unstagedFiles,
      untracked_files: untrackedFiles,
      full_diff: fullDiff,
      packet_diff: packetDiffSanitized.diff,
      diff: packetDiffSanitized.diff,  // legacy alias for callers expecting `diff`
      diff_truncated: packetDiffSanitized.truncated,
      diff_stat: (diffStatR.stdout ?? '').trim(),
      status: (statusR.stdout ?? '').trim(),
      binary_files: packetDiffSanitized.binaryFiles,
    },
  };
}

async function detectInProgressOps(cwd) {
  // Check for .git/ markers indicating in-progress operations
  const gitDirR = await runGit(['rev-parse', '--git-dir'], { cwd });
  if (!gitDirR.ok) return null;
  const gitDir = path.resolve(cwd, gitDirR.stdout.trim());

  for (const [name, label] of [
    ['MERGE_HEAD',   'merge'],
    ['REBASE_HEAD',  'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD',  'revert'],
  ]) {
    try {
      await stat(path.join(gitDir, name));
      return label;
    } catch { /* not present */ }
  }
  // rebase directories
  for (const dirName of ['rebase-merge', 'rebase-apply']) {
    try {
      await stat(path.join(gitDir, dirName));
      return 'rebase';
    } catch { /* not present */ }
  }
  return null;
}

/**
 * Strip binary file diffs; truncate overall diff if it exceeds the byte budget.
 */
async function sanitizeDiff(diff, changedFiles, cwd) {
  const byteBudget = parseInt(process.env.AI_SUPERVISOR_PACKET_BYTE_BUDGET ?? '204800', 10);

  const binaryFiles = [];

  // Identify binary files among changed files
  for (const f of changedFiles) {
    const ext = path.extname(f).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      let size = null;
      try {
        const s = await stat(path.join(cwd, f));
        size = s.size;
      } catch {}
      binaryFiles.push({ file: f, size_bytes: size });
    }
  }

  // Remove diff hunks for binary files (git's "Binary files ... differ" lines + surrounding hunk)
  let cleaned = diff.replace(/^Binary files [^\n]*\n/gm, '[binary file change; content omitted]\n');

  // Truncate if over budget
  let truncated = false;
  if (cleaned.length > byteBudget) {
    cleaned = cleaned.slice(0, byteBudget) + `\n\n[diff truncated at ${byteBudget} bytes — original size ${diff.length}]`;
    truncated = true;
  }

  return { diff: cleaned, truncated, binaryFiles };
}
