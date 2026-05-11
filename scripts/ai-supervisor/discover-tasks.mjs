// Task discovery. Pipeline:
//   1. Mechanical scan (local, fast): roadmap PRs + TODO/FIXME/HACK + dead files
//   2. (Future PR3) OpenAI structures + ranks the raw list
//   3. Result becomes queue.json items
//
// PR1 emits raw candidates. PR3 adds the OpenAI ranking step.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const ROADMAP_PATH = 'docs/PR30_CLEANUP_ROADMAP.md';

const TODO_MARKER_RE = /(?:^|[\s/*])((?:TODO|FIXME|XXX|HACK))(?:\s*\(([^)]+)\))?:?\s*(.+)$/;

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', '.local', '.claude', 'coverage', 'src-tauri']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.html']);

/**
 * Main entry: scan repo and return raw candidates.
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {object} [opts.state] — to check quarantine_fingerprints
 * @returns {Promise<{candidates: object[], parse_warnings: string[]}>}
 */
export async function discoverTasks(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const candidates = [];
  const parse_warnings = [];

  // 1. Roadmap PRs (highest priority)
  const roadmapResult = await discoverRoadmapPrs(cwd);
  candidates.push(...roadmapResult.candidates);
  if (roadmapResult.parse_warning) parse_warnings.push(roadmapResult.parse_warning);

  // 2. TODOs / FIXMEs / XXX / HACK markers
  const todoCandidates = await discoverTodoMarkers(cwd);
  candidates.push(...todoCandidates);

  // 3. Dead-file candidates (PR3 implements full import-graph; PR1 stub: just count)
  // Intentionally skipped in PR1 to keep this module short — see plan R3-12 → R3-13.

  // Filter out candidates matching active quarantine fingerprints (<7 days)
  if (opts.state?.quarantine_fingerprints) {
    const NOW = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const filtered = candidates.filter(c => {
      for (const fp of opts.state.quarantine_fingerprints) {
        const ageMs = NOW - Date.parse(fp.quarantined_at);
        if (ageMs > sevenDays) continue;
        if (fp.signature && c.signature === fp.signature) return false;
      }
      return true;
    });
    return { candidates: filtered, parse_warnings };
  }

  return { candidates, parse_warnings };
}

async function discoverRoadmapPrs(cwd) {
  const candidates = [];
  let parse_warning = null;

  try {
    const raw = await readFile(path.join(cwd, ROADMAP_PATH), 'utf8');
    // Find PR sections: "## PR 35 — CSS modular cleanup"
    const re = /^## PR (\d+) — (.+)$/gm;
    let m;
    const found = [];
    while ((m = re.exec(raw)) !== null) {
      found.push({ pr: parseInt(m[1], 10), title: m[2].trim(), offset: m.index });
    }

    if (found.length < 3) {
      parse_warning = `Roadmap parse: expected ≥3 PR entries, found ${found.length}. Format may have changed.`;
    }

    // Check git log for merged PR numbers
    const { stdout: gitLog } = await exec('git', ['log', '--oneline', 'origin/main'], { cwd, maxBuffer: 10_000_000 });
    const mergedPrs = new Set();
    for (const line of gitLog.split('\n')) {
      const prMatch = line.match(/PR (\d+):/);
      if (prMatch) mergedPrs.add(parseInt(prMatch[1], 10));
    }

    // Preference order from plan R16-2: PR 35 → PR 38 → PR 37
    const priority = { 35: 0, 38: 1, 37: 2 };
    const unmerged = found.filter(p => !mergedPrs.has(p.pr));
    unmerged.sort((a, b) => (priority[a.pr] ?? 99) - (priority[b.pr] ?? 99));

    for (const { pr, title } of unmerged) {
      candidates.push({
        kind: 'roadmap-pr',
        roadmap_pr_ref: `PR ${pr}`,
        title: `PR ${pr} — ${title}`,
        description: `From docs/PR30_CLEANUP_ROADMAP.md. Operator should derive allowedFiles + mustNotChange from the roadmap entry's "Files likely touched" and "Must not change" sections.`,
        signature: `roadmap-${pr}`,
      });
    }
  } catch (err) {
    parse_warning = `Could not parse roadmap: ${err.message}`;
  }
  return { candidates, parse_warning };
}

async function discoverTodoMarkers(cwd, dir = cwd) {
  const candidates = [];
  const seen = new Set(); // dedup by (marker_text + basename)

  async function walk(currentDir) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        await walk(path.join(currentDir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SOURCE_EXTS.has(ext)) continue;
        // Skip test fixtures + the supervisor's own source (avoid recursive markers)
        const rel = path.relative(cwd, path.join(currentDir, entry.name));
        if (rel.includes('tests/fixtures/')) continue;
        if (rel.startsWith('scripts/ai-supervisor/')) continue;

        await scanFile(path.join(currentDir, entry.name), rel);
      }
    }
  }

  async function scanFile(absPath, rel) {
    let content;
    try { content = await readFile(absPath, 'utf8'); } catch { return; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(TODO_MARKER_RE);
      if (!m) continue;
      const [, marker, , textRaw] = m;
      const text = textRaw.trim();
      const key = `${marker}|${path.basename(rel)}|${text.slice(0, 100)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        kind: 'marker',
        marker,
        file: rel,
        line: i + 1,
        text,
        title: `${marker} in ${path.basename(rel)}:${i + 1} — ${text.slice(0, 80)}`,
        description: `Marker at ${rel}:${i + 1}: "${text}". Operator/AI decide if this is a fix candidate or a won't-fix candidate.`,
        signature: `${marker}-${path.basename(rel)}-${text.slice(0, 60)}`,
      });
    }
  }

  await walk(dir);
  // Sort by file then line for determinism
  candidates.sort((a, b) => {
    const fa = a.file ?? '';
    const fb = b.file ?? '';
    if (fa !== fb) return fa.localeCompare(fb);
    return (a.line ?? 0) - (b.line ?? 0);
  });
  return candidates;
}
