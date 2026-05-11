#!/usr/bin/env node
// Idempotent installer for the AI Supervisor hooks.
// Writes .claude/settings.local.json with Stop + PostToolUse + PreToolUse entries.
// Computes SHA pins of the supervisor's own modules into code-pins.json.

import { readFile, writeFile, mkdir, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const REPO_ROOT = process.cwd();
const CLAUDE_DIR = path.join(REPO_ROOT, '.claude');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.local.json');
const LOCAL_DIR = path.join(REPO_ROOT, '.local', 'ai-supervisor');
const PINS_PATH = path.join(LOCAL_DIR, 'code-pins.json');
const APPROVAL_DOC_PATH = 'docs/governance/AI_SUPERVISOR_APPROVAL.md';

// Modules whose SHA we pin to detect tampering / self-modification.
const PINNED_MODULES = [
  'stop-review.mjs',
  'state.mjs',
  'scope-guard.mjs',
  'openai-client.mjs',
  'validate-verdict.mjs',
  'verdict-router.mjs',
  'redact.mjs',
  'pre-tool-use-keyscan.mjs',
];

// ---- Args parsing ----

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const UPDATE_PINS = args.has('--update-pins');
const RESET = args.has('--reset');

async function main() {
  console.log('=== AI Supervisor install-hook ===\n');

  // PR-A dependency check
  await verifyPrA();

  if (RESET) {
    await doReset();
    return;
  }

  if (UPDATE_PINS) {
    await updatePins();
    return;
  }

  await installHooks();
  await ensurePins();
  console.log('\nDone. Open Claude Code and trigger any Stop to verify supervisor fires.');
}

async function verifyPrA() {
  try {
    // Check that PR-A's approval doc is on origin/main
    await exec('git', ['cat-file', '-e', `origin/main:${APPROVAL_DOC_PATH}`], { cwd: REPO_ROOT });
    console.log(`✓ PR-A approval doc present on origin/main (${APPROVAL_DOC_PATH})`);
  } catch {
    console.error(`✗ PR-A approval doc not found on origin/main.`);
    console.error(`  Expected: ${APPROVAL_DOC_PATH}`);
    console.error(`  Did you fetch latest? Try: git fetch origin main`);
    console.error(`  This installer refuses to run until PR-A is merged.`);
    process.exit(1);
  }
}

async function installHooks() {
  await mkdir(CLAUDE_DIR, { recursive: true });

  // Load existing settings if present
  let existing = {};
  let hadExisting = false;
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf8');
    existing = JSON.parse(raw);
    hadExisting = true;
  } catch { /* fresh install */ }

  // Backup existing settings
  if (hadExisting) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bakPath = `${SETTINGS_PATH}.backup-${ts}`;
    await copyFile(SETTINGS_PATH, bakPath);
    console.log(`✓ Backed up existing settings to ${path.relative(REPO_ROOT, bakPath)}`);
  }

  // Detect committed Claude settings.json — warn about merge behavior
  const committedSettings = path.join(CLAUDE_DIR, 'settings.json');
  try {
    await stat(committedSettings);
    console.warn(`⚠ ${committedSettings} (committed) exists. Reminder: top-level "hooks" key in .local.json REPLACES (not merges) the committed version. Operator should consolidate if both have Stop hooks.`);
  } catch { /* no committed settings — fine */ }

  // Compose hooks
  const newSettings = {
    ...existing,
    _purpose: 'ai-supervisor',
    _installed_at: new Date().toISOString(),
    hooks: {
      ...(existing.hooks ?? {}),
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `node "${path.posix.join('${CLAUDE_PROJECT_DIR}', 'scripts', 'ai-supervisor', 'stop-review.mjs')}"`,
              timeout: 900,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit',
          hooks: [
            {
              type: 'command',
              command: `node "${path.posix.join('${CLAUDE_PROJECT_DIR}', 'scripts', 'ai-supervisor', 'post-tool-use.mjs')}"`,
              timeout: 60,
              async: true,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit|Bash',
          hooks: [
            {
              type: 'command',
              command: `node "${path.posix.join('${CLAUDE_PROJECT_DIR}', 'scripts', 'ai-supervisor', 'pre-tool-use-keyscan.mjs')}"`,
              timeout: 30,
            },
          ],
        },
      ],
    },
  };

  await writeFile(SETTINGS_PATH, JSON.stringify(newSettings, null, 2) + '\n', 'utf8');
  console.log(`✓ Wrote ${path.relative(REPO_ROOT, SETTINGS_PATH)}`);
  console.log(`  - Stop hook        → stop-review.mjs (timeout 900s)`);
  console.log(`  - PostToolUse hook → post-tool-use.mjs (async, timeout 60s)`);
  console.log(`  - PreToolUse hook  → pre-tool-use-keyscan.mjs (timeout 30s)`);
}

async function ensurePins() {
  let existingPins = null;
  try {
    const raw = await readFile(PINS_PATH, 'utf8');
    existingPins = JSON.parse(raw);
  } catch { /* fresh */ }

  const newPins = await computePins();

  if (existingPins) {
    // Compare; warn if any pinned SHA changed since install
    const changes = [];
    for (const [mod, sha] of Object.entries(newPins.pins)) {
      if (existingPins.pins[mod] && existingPins.pins[mod] !== sha) {
        changes.push(`${mod}: ${existingPins.pins[mod].slice(0,12)} → ${sha.slice(0,12)}`);
      }
    }
    if (changes.length > 0 && !FORCE) {
      console.error(`✗ Supervisor module SHAs differ from pinned values:`);
      for (const c of changes) console.error(`    ${c}`);
      console.error(`  Run \`node scripts/ai-supervisor/install-hook.mjs --update-pins\` to accept the new pins,`);
      console.error(`  OR re-run with \`--force\` to overwrite without confirmation.`);
      process.exit(2);
    }
  }

  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(PINS_PATH, JSON.stringify(newPins, null, 2) + '\n', 'utf8');
  console.log(`✓ Wrote code-pins.json (${PINNED_MODULES.length} modules pinned)`);
}

async function updatePins() {
  const pins = await computePins();
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(PINS_PATH, JSON.stringify(pins, null, 2) + '\n', 'utf8');
  console.log(`✓ Updated code-pins.json (${PINNED_MODULES.length} modules)`);
}

async function computePins() {
  const supervisorDir = path.join(REPO_ROOT, 'scripts', 'ai-supervisor');
  const pins = {};
  for (const mod of PINNED_MODULES) {
    const filePath = path.join(supervisorDir, mod);
    const content = await readFile(filePath, 'utf8');
    pins[mod] = 'sha256:' + createHash('sha256').update(content).digest('hex');
  }
  return {
    version: 1,
    pins,
    pinned_at: new Date().toISOString(),
    pinned_by: process.env.USER ?? process.env.USERNAME ?? 'unknown',
  };
}

async function doReset() {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(r => rl.question(
    `This will clear .local/ai-supervisor/state.json + state.json.bak.* (cost-day counter, repair counts, queue all reset). Approval records and review-packets are preserved.\nType "RESET" to confirm: `,
    a => { rl.close(); r(a); }
  ));
  if (answer.trim() !== 'RESET') {
    console.log('Aborted.');
    process.exit(0);
  }
  const { readdir, unlink } = await import('node:fs/promises');
  try {
    const entries = await readdir(LOCAL_DIR);
    for (const e of entries) {
      if (e === 'state.json' || e.startsWith('state.json.bak.') || e === 'state.lock' || e === 'queue.json') {
        await unlink(path.join(LOCAL_DIR, e));
        console.log(`  Removed ${e}`);
      }
    }
    console.log(`✓ Reset complete. Re-run install-hook.mjs to reinstall.`);
  } catch (err) {
    console.error(`Reset failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`install-hook failed: ${err.message}`);
  process.exit(1);
});
