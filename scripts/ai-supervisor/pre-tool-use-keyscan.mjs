#!/usr/bin/env node
// PreToolUse hook: API-key leak prevention.
// Scans Claude's Write/Edit/MultiEdit content AND Bash command strings for
// secret patterns. Exit code 2 blocks the tool execution with a stderr message.

import path from 'node:path';

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

// Per-pattern detector. Returns { matched, name } if any pattern triggers.
const PATTERNS = [
  { name: 'openai-key-proj',   re: /sk-proj-[A-Za-z0-9_-]{40,}/g },
  { name: 'openai-key',        re: /sk-[A-Za-z0-9_-]{40,}/g },
  { name: 'github-token',      re: /ghp_[A-Za-z0-9]{36,}/g },
  { name: 'github-pat',        re: /github_pat_[A-Za-z0-9_]{60,}/g },
  { name: 'anthropic-key',     re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'aws-key',           re: /AKIA[A-Z0-9]{16}/g },
  { name: 'jwt',               re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]+PRIVATE KEY-----/ },
];

// Bash-specific: detect env-var expansions piped to writes
const BASH_ENV_VAR_LEAK_RE = /(?:^|;|&&|\|\|)\s*echo\s+[^|>]*\$(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)[^|>]*\s*(?:>|>>|\||tee)/;
const BASH_ENV_VAR_BARE = /\$\{?(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\}?/;

// Path whitelist: files that legitimately contain pattern-like literals (regexes).
// Strictly narrow: only the two scanner-source files themselves, which embed
// the secret-pattern regexes as their core data. docs/governance/** is NOT
// whitelisted — a real key written into a committed doc must be blocked.
const PATH_WHITELIST = [
  /^scripts\/ai-supervisor\/redact\.mjs$/,
  /^scripts\/ai-supervisor\/pre-tool-use-keyscan\.mjs$/,
  /^tests\/ai-supervisor-redact\.test\.ts$/,    // test file constructs synthetic patterns
  /^tests\/ai-supervisor-keyscan\.test\.ts$/,   // (future test file; safe to pre-list)
];

function isWhitelistedPath(p) {
  const rel = path.relative(REPO_ROOT, p).replace(/\\/g, '/');
  return PATH_WHITELIST.some(re => re.test(rel));
}

function checkSecretPatterns(text) {
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) return { matched: true, name };
  }
  return { matched: false };
}

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) { process.exit(0); return; }

  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); return; }

  const toolName = input?.tool_name ?? '';
  const toolInput = input?.tool_input ?? {};

  // ---- Write / Edit / MultiEdit ----
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    if (toolInput.file_path && isWhitelistedPath(toolInput.file_path)) {
      process.exit(0); return;
    }

    const candidates = [];
    if (typeof toolInput.content === 'string') candidates.push(toolInput.content);
    if (typeof toolInput.new_string === 'string') candidates.push(toolInput.new_string);
    if (Array.isArray(toolInput.edits)) {
      for (const e of toolInput.edits) {
        if (typeof e?.new_string === 'string') candidates.push(e.new_string);
      }
    }

    for (const text of candidates) {
      const result = checkSecretPatterns(text);
      if (result.matched) {
        process.stderr.write(`API key pattern (${result.name}) detected in proposed file content. Refusing to write — supervisor PreToolUse keyscan.\n`);
        process.exit(2);
      }
    }
  }

  // ---- Bash ----
  if (toolName === 'Bash') {
    const cmd = toolInput.command ?? '';
    // 1. Direct secret pattern in the command itself
    const result = checkSecretPatterns(cmd);
    if (result.matched) {
      process.stderr.write(`API key pattern (${result.name}) detected in Bash command. Refusing to execute — supervisor PreToolUse keyscan.\n`);
      process.exit(2);
    }
    // 2. Env-var expansion piped to file write
    if (BASH_ENV_VAR_LEAK_RE.test(cmd)) {
      process.stderr.write(`Bash command appears to redirect a secret env var to a file. Refusing — supervisor PreToolUse keyscan. (e.g. \`echo $OPENAI_API_KEY > file\`)\n`);
      process.exit(2);
    }
    // 3. Bare env-var expansion in a logging context (more permissive — only warn-block on combination with > / |)
    if (BASH_ENV_VAR_BARE.test(cmd) && /(>|>>|tee|\|)/.test(cmd)) {
      process.stderr.write(`Bash command references a secret env var alongside redirection. Refusing — supervisor PreToolUse keyscan.\n`);
      process.exit(2);
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
