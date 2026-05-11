// Three-layer redaction for AI Supervisor packets and logs.
//
// Layer 1: known secret patterns (OpenAI keys, GitHub tokens, AWS keys, JWTs, private key blocks, etc.)
// Layer 2: sensitive-file content stripping (.env, .local/**, *.pem, etc.)
// Layer 3: catch-all for long base64/hex runs (>40 chars) in non-source files
//
// Always run on packet body BEFORE sending to OpenAI.

// Pattern definitions. Each pattern is replaced with [REDACTED:<tag>].
const SECRET_PATTERNS = [
  { name: 'openai-key',        re: /sk-proj-[A-Za-z0-9_-]{40,}/g },
  { name: 'openai-key',        re: /sk-[A-Za-z0-9_-]{40,}/g },
  { name: 'github-token',      re: /ghp_[A-Za-z0-9]{36,}/g },
  { name: 'github-pat',        re: /github_pat_[A-Za-z0-9_]{60,}/g },
  { name: 'aws-key',           re: /AKIA[A-Z0-9]{16}/g },
  { name: 'jwt',               re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
  { name: 'anthropic-key',     re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
];

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g;

// Paths under `.local/` that ARE intended to be visible to the supervisor's
// review packet (approval records prove operator intent; source-cache provides
// authoritative API docs). Everything else under `.local/` is stripped.
const LOCAL_ALLOWLIST_PREFIXES = [
  '.local/ai-supervisor/approvals/',
  '.local/ai-supervisor/source-cache/',
];

// Sensitive file paths whose CONTENT should be replaced entirely with a marker.
const SENSITIVE_FILE_PATTERNS = [
  /(?:^|\/)\.env(?:\.[^/\s]*)?$/,         // .env, .env.local, etc.
  /(?:^|\/)id_(?:rsa|ed25519|ecdsa|dsa)$/, // SSH keys
  /\.pem$/,
  /pokemon-tracker-backup-.*\.json$/,
  /pre-restore-backup-.*\.json$/,
  /.*\.fixture\.json$/,
];

function isInsideLocalAllowlist(normalizedPath) {
  return LOCAL_ALLOWLIST_PREFIXES.some(prefix => normalizedPath.startsWith(prefix) || normalizedPath.includes(`/${prefix}`));
}

// Files we KNOW are source code; long base64-looking runs in these are likely
// legitimate (hex literals, embedded images, etc.) and should be left alone.
const SOURCE_FILE_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.css', '.html', '.svg', '.md'];

/**
 * Layer 1: scrub known secret patterns from a string.
 */
export function scrubSecretPatterns(text) {
  let out = text;
  for (const { name, re } of SECRET_PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  out = out.replace(PRIVATE_KEY_BLOCK, '[REDACTED:private-key-block]');
  return out;
}

/**
 * Check if a path is sensitive (Layer 2 file-strip target).
 *
 * Granular `.local/` handling: paths under `.local/ai-supervisor/approvals/`
 * and `.local/ai-supervisor/source-cache/` are NOT stripped (the supervisor's
 * authority order requires those to be visible in the packet). Everything
 * else under `.local/` IS stripped.
 */
export function isSensitiveFile(filePath) {
  // Normalize to forward slashes for pattern matching
  const normalized = filePath.replace(/\\/g, '/');
  // .local/** is sensitive UNLESS it's in the allowlist
  if (normalized.includes('.local/') || normalized.startsWith('.local/')) {
    return !isInsideLocalAllowlist(normalized);
  }
  return SENSITIVE_FILE_PATTERNS.some(re => re.test(normalized));
}

/**
 * Layer 3: catch-all redaction for long base64/hex runs in non-source files.
 * Only redacts in files whose extension is NOT in SOURCE_FILE_EXTS.
 *
 * @param {string} text — file content
 * @param {string} filePath — used to decide whether to apply layer 3
 */
export function scrubLongTokens(text, filePath) {
  const ext = (filePath.match(/\.[^./\\]+$/) ?? [''])[0].toLowerCase();
  if (SOURCE_FILE_EXTS.includes(ext)) {
    return text;
  }
  // base64: A-Z a-z 0-9 + / = ; allow padding
  // Run length >40 to avoid false-positives on short hashes/identifiers
  return text.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[REDACTED:long-token]')
    .replace(/[a-fA-F0-9]{40,}/g, '[REDACTED:long-token]');
}

/**
 * Full redact pipeline for a single file's content.
 * @param {string} content
 * @param {string} filePath
 * @returns {string}
 */
export function redactFile(content, filePath) {
  if (isSensitiveFile(filePath)) {
    return `[REDACTED: sensitive file content stripped — ${filePath}]`;
  }
  let out = scrubSecretPatterns(content);
  out = scrubLongTokens(out, filePath);
  return out;
}

/**
 * Redact arbitrary text (e.g. a diff blob, log output) with no file context.
 * Applies layers 1 and 3 (assumes worst-case non-source).
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  let out = scrubSecretPatterns(text);
  // For raw text without filename context, treat as non-source for layer 3.
  out = out.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[REDACTED:long-token]')
    .replace(/[a-fA-F0-9]{40,}/g, '[REDACTED:long-token]');
  return out;
}
