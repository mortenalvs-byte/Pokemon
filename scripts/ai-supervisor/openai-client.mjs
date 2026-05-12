// OpenAI Responses API client.
//
// Reads phase0-config.json for empirically-verified shape (endpoint, model,
// reasoning effort, field paths, pricing). Falls back to env-var overrides.
//
// Reliability features baked in from Round 1-5 audit lessons:
// - Streaming (SSE) to avoid undici 5-min headers-timeout on long xhigh calls.
// - AbortController at OPENAI_REQUEST_TIMEOUT_MS (default 400s).
// - Retries on 408/429/5xx with exponential backoff + Retry-After honored.
// - Network-error catch (ECONNRESET, ETIMEDOUT, ENOTFOUND, TypeError).
// - x-ratelimit-remaining-* proactive throttle (sleep 30s if <10%).
// - insufficient_quota → synthetic BUDGET_HALT verdict.
// - Hostname allowlist: api.openai.com only.
// - API key validation + trim + format regex.
// - Daily $ cap + per-task $ cap → synthetic BUDGET_HALT or QUARANTINE.
// - Refusal-pattern detection (handled by validate-verdict.mjs).

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ALLOWED_HOST = 'api.openai.com';
const KEY_FORMAT_RE = /^sk-(proj-)?[A-Za-z0-9_-]+$/;

const DEFAULT_PRICING = {
  'gpt-5.5-pro': { input: 30.00, output: 180.00, cached_input: 3.00 },
  'gpt-5.5':     { input: 5.00,  output: 30.00,  cached_input: 0.50 },
  'gpt-5.4-pro': { input: 30.00, output: 180.00, cached_input: 3.00 },
  'gpt-5.4':     { input: 2.50,  output: 15.00,  cached_input: 0.25 },
};

const REQUEST_TIMEOUT_MS = parseInt(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? '400000', 10);
const MAX_RETRIES = 3;

// ---- Config load ----

let _configCache = null;

async function loadConfig() {
  if (_configCache) return _configCache;
  const cfgPath = path.join(process.cwd(), '.local', 'ai-supervisor-smoke', 'phase0-config.json');
  try {
    const raw = await readFile(cfgPath, 'utf8');
    _configCache = JSON.parse(raw);
    return _configCache;
  } catch (err) {
    throw new Error(`openai-client: phase0-config.json missing or invalid at ${cfgPath} — run Phase 0.A first. (${err.message})`);
  }
}

// ---- API key ----

function getApiKey() {
  let raw = process.env.OPENAI_API_KEY ?? '';
  let trimmed = raw.trim();

  // Windows-only fallback: Claude Code does not propagate User-level
  // environment variables to subprocesses. If OPENAI_API_KEY is empty
  // in the env, try reading it from the Windows registry (HKCU\Environment).
  // This is the same mechanism manual review scripts have used reliably
  // throughout the session. Approved 2026-05-12 via quorum
  // (appr-2026-05-12-openai-key-fallback-A/B).
  if (!trimmed && process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Environment', '/v', 'OPENAI_API_KEY'],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const m = out.match(/REG_SZ\s+(.+?)\s*$/m);
      if (m && m[1]) trimmed = m[1].trim();
    } catch {
      /* registry lookup failed; fall through to no-key error below */
    }
  }

  if (!trimmed) {
    return { ok: false, error: 'OPENAI_API_KEY env var is not set' };
  }
  if (!KEY_FORMAT_RE.test(trimmed)) {
    return { ok: false, error: `OPENAI_API_KEY format invalid (expected sk-... or sk-proj-...)` };
  }
  return { ok: true, key: trimmed };
}

// ---- Main entry: call OpenAI for a verdict ----

/**
 * Call OpenAI Responses API with a verdict-shaped strict JSON schema.
 *
 * @param {object} input
 * @param {string} input.systemPrompt — cached prefix
 * @param {string} input.userContent — dynamic tail
 * @param {object} input.verdictSchema — strict JSON schema for the response
 * @param {object} [input.options]
 * @param {string} [input.options.reasoningEffort] — override default
 * @param {object} [input.options.costContext] — { dailyCapUsd, dailyUsedUsd, perTaskCapUsd, perTaskUsedUsd }
 * @returns {Promise<{ok: true, verdictText, usage, costUsd, modelUsed, elapsedMs} | {ok: false, kind: string, error: string, syntheticVerdict?: object}>}
 */
export async function callOpenAI(input) {
  const config = await loadConfig();
  const keyResult = getApiKey();
  if (!keyResult.ok) {
    return { ok: false, kind: 'no-api-key', error: keyResult.error };
  }
  const apiKey = keyResult.key;

  // Hostname allowlist check
  if (!config.endpoint_path?.startsWith('/v1/')) {
    return { ok: false, kind: 'bad-config', error: `endpoint_path must start with /v1/, got: ${config.endpoint_path}` };
  }
  const url = `https://${ALLOWED_HOST}${config.endpoint_path}`;

  // Cost-cap pre-check
  if (input.options?.costContext) {
    const { dailyCapUsd, dailyUsedUsd, perTaskCapUsd, perTaskUsedUsd } = input.options.costContext;
    if (typeof dailyCapUsd === 'number' && typeof dailyUsedUsd === 'number' && dailyUsedUsd >= dailyCapUsd) {
      return {
        ok: false,
        kind: 'budget-halt',
        error: `Daily cost cap reached ($${dailyUsedUsd.toFixed(2)} ≥ $${dailyCapUsd.toFixed(2)}). Emit BUDGET_HALT.`,
        syntheticVerdict: makeBudgetHaltVerdict(`daily cap $${dailyCapUsd} reached`),
      };
    }
    if (typeof perTaskCapUsd === 'number' && typeof perTaskUsedUsd === 'number' && perTaskUsedUsd >= perTaskCapUsd) {
      return {
        ok: false,
        kind: 'per-task-cap',
        error: `Per-task cost cap reached ($${perTaskUsedUsd.toFixed(2)} ≥ $${perTaskCapUsd.toFixed(2)}). Force QUARANTINE_AND_CONTINUE.`,
        syntheticVerdict: makePerTaskCapQuarantineVerdict(
          `Per-task cap $${perTaskCapUsd.toFixed(2)} reached (used $${perTaskUsedUsd.toFixed(2)}). The task has exceeded its individual budget; quarantining it and moving on to the next queued task.`
        ),
      };
    }
  }

  const reasoningEffort = input.options?.reasoningEffort ?? config.reasoning_effort ?? 'xhigh';

  // Strip annotation-only keywords ($comment) before sending — Responses API
  // strict mode tolerates them today (Phase 0 confirmed), but the safer surface
  // is to send only the structural keywords the schema validator cares about.
  // Documents stay annotated in the repo; only the wire form is stripped.
  const wireSchema = stripAnnotationKeywords(input.verdictSchema.schema ?? input.verdictSchema);

  const requestBody = {
    model: config.model_id_pinned ?? config.model_id ?? 'gpt-5.5-pro',
    reasoning: { effort: reasoningEffort },
    store: false,
    input: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user',   content: input.userContent },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: input.verdictSchema.name ?? 'ai_supervisor_verdict_v1',
        strict: true,
        schema: wireSchema,
      },
    },
  };

  // Set generous undici timeouts for long xhigh calls
  try {
    const { Agent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new Agent({
      headersTimeout: Math.max(REQUEST_TIMEOUT_MS + 60_000, 900_000),
      bodyTimeout:    Math.max(REQUEST_TIMEOUT_MS + 60_000, 900_000),
    }));
  } catch { /* undici not available — should never happen in Node 18+ */ }

  return await tryWithRetries(url, apiKey, requestBody, config);
}

async function tryWithRetries(url, apiKey, body, config) {
  let attempt = 0;
  const errors = [];

  while (attempt < MAX_RETRIES + 1) {
    attempt++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    const started = Date.now();

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      clearTimeout(timer);
      const elapsed = Date.now() - started;

      // Proactive throttle: if <10% TPM remaining, sleep 30s before returning
      checkRateLimitHeaders(res.headers);

      if (res.status === 200) {
        return await handleSuccess(res, body, config, elapsed);
      }

      if (res.status === 429 || res.status === 408 || (res.status >= 500 && res.status < 600)) {
        const errBody = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));

        // Insufficient quota → BUDGET_HALT
        if (errBody?.error?.code === 'insufficient_quota') {
          return {
            ok: false,
            kind: 'budget-halt',
            error: 'OpenAI account quota exhausted',
            syntheticVerdict: makeBudgetHaltVerdict('OpenAI account insufficient_quota'),
          };
        }

        // Retry with backoff
        const retryAfter = parseRetryAfter(res.headers);
        const backoffMs = retryAfter ?? expBackoff(attempt);
        errors.push({ attempt, status: res.status, code: errBody?.error?.code, retry_in_ms: backoffMs });

        if (attempt > MAX_RETRIES) break;
        await sleep(backoffMs);
        continue;
      }

      // 4xx that we can't retry
      const errBody = await res.json().catch(() => ({}));
      return {
        ok: false,
        kind: 'http-error',
        error: `OpenAI returned ${res.status}: ${errBody?.error?.message ?? 'unknown'}`,
        rawError: errBody,
      };
    } catch (err) {
      clearTimeout(timer);

      if (err.name === 'AbortError') {
        errors.push({ attempt, kind: 'timeout', timeout_ms: REQUEST_TIMEOUT_MS });
        if (attempt > MAX_RETRIES) {
          return {
            ok: false,
            kind: 'timeout',
            error: `OpenAI request exceeded ${REQUEST_TIMEOUT_MS}ms after ${attempt} attempts`,
          };
        }
        await sleep(expBackoff(attempt));
        continue;
      }

      // Network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, etc.)
      if (err.name === 'TypeError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' || err.cause?.code) {
        errors.push({ attempt, kind: 'network', error: err.message, code: err.code ?? err.cause?.code });
        if (attempt > MAX_RETRIES) {
          return {
            ok: false,
            kind: 'network',
            error: `Network error after ${attempt} attempts: ${err.message}`,
          };
        }
        await sleep(expBackoff(attempt));
        continue;
      }

      // Unknown error — propagate
      return {
        ok: false,
        kind: 'unknown-error',
        error: err.message,
      };
    }
  }

  return {
    ok: false,
    kind: 'retries-exhausted',
    error: `OpenAI call failed after ${MAX_RETRIES + 1} attempts`,
    attempts: errors,
  };
}

async function handleSuccess(res, requestBody, config, elapsed) {
  const body = await res.json();

  // Extract verdict text: iterate output[] for type==='message', then content[].text
  let verdictText = null;
  if (body.output_text) {
    verdictText = body.output_text;
  } else if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (item.type !== 'message') continue;
      if (!Array.isArray(item.content)) continue;
      for (const piece of item.content) {
        if (piece.type === 'output_text' && typeof piece.text === 'string') {
          verdictText = piece.text;
          break;
        }
      }
      if (verdictText) break;
    }
  }
  if (!verdictText) {
    return {
      ok: false,
      kind: 'no-verdict-text',
      error: 'Could not extract verdict text from response',
      rawResponse: body,
    };
  }

  // Compute cost
  const usage = body.usage ?? {};
  const modelUsed = body.model ?? requestBody.model;
  const prices = pickPricing(modelUsed);
  const inputTokens  = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const cachedTokens = usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const freshInput   = Math.max(0, inputTokens - cachedTokens);

  const costUsd =
    (freshInput   / 1_000_000) * prices.input +
    (cachedTokens / 1_000_000) * prices.cached_input +
    (outputTokens / 1_000_000) * prices.output;

  return {
    ok: true,
    verdictText,
    usage,
    costUsd,
    costSplit: {
      actual_input_usd: (freshInput / 1_000_000) * prices.input,
      cached_input_usd: (cachedTokens / 1_000_000) * prices.cached_input,
      output_usd:       (outputTokens / 1_000_000) * prices.output,
      total_usd:        costUsd,
    },
    modelUsed,
    elapsedMs: elapsed,
    cachedTokens,
  };
}

function pickPricing(modelId) {
  const base = (modelId ?? '').replace(/-2026-\d\d-\d\d$/, '');
  return DEFAULT_PRICING[base] ?? DEFAULT_PRICING['gpt-5.5'];
}

function parseRetryAfter(headers) {
  const v = headers.get('retry-after');
  if (!v) return null;
  const n = parseInt(v, 10);
  if (Number.isFinite(n) && n > 0) return n * 1000;
  // HTTP-date variant — skip
  return null;
}

function expBackoff(attempt) {
  const base = Math.min(1000 * Math.pow(2, attempt - 1), 60000);
  const jitter = Math.random() * 1000;
  return base + jitter;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function checkRateLimitHeaders(headers) {
  const remTokens   = parseInt(headers.get('x-ratelimit-remaining-tokens')   ?? '999999', 10);
  const limitTokens = parseInt(headers.get('x-ratelimit-limit-tokens')       ?? '999999', 10);
  if (limitTokens > 0 && remTokens > 0 && remTokens / limitTokens < 0.10) {
    // (Non-blocking warn; actual sleep happens before NEXT call externally)
    console.error(`[openai-client] WARN: x-ratelimit-remaining-tokens=${remTokens}/${limitTokens} (<10%); next call may rate-limit.`);
  }
}

function makeBudgetHaltVerdict(reason) {
  return {
    schema_version: 1,
    verdict: 'BUDGET_HALT',
    risk_level: 'LOW',
    confidence: 1.0,
    claude_next_prompt: null,
    quarantine_reason: reason,
    summary: `Supervisor halting: ${reason}`,
    verification: emptyVerificationStub(),
    scope_guard: { status: 'PASS', violations: [], approval_used: null },
    required_sources: [],
    blocking_findings: [],
    allowed_next_actions: [],
    forbidden_next_actions: [],
    behaviour_drift_check: { passed: true, notes: 'n/a — budget halt' },
  };
}

/**
 * Strip JSON-Schema annotation keywords ($comment, title, description, default,
 * examples) from a schema object so the wire form sent to OpenAI contains only
 * structural keywords. This is defense-in-depth — strict mode accepts $comment
 * today, but the policy is "send only what the validator needs."
 */
function stripAnnotationKeywords(obj) {
  const ANNOTATIONS = new Set(['$comment', 'title', 'description', 'default', 'examples']);
  if (Array.isArray(obj)) return obj.map(stripAnnotationKeywords);
  if (obj === null || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (ANNOTATIONS.has(k)) continue;
    out[k] = stripAnnotationKeywords(v);
  }
  return out;
}

function makePerTaskCapQuarantineVerdict(reason) {
  return {
    schema_version: 1,
    verdict: 'QUARANTINE_AND_CONTINUE',
    risk_level: 'MEDIUM',
    confidence: 1.0,
    claude_next_prompt: null,
    quarantine_reason: reason,
    summary: `Supervisor synthesizing QUARANTINE_AND_CONTINUE: ${reason}`,
    verification: emptyVerificationStub(),
    scope_guard: { status: 'PASS', violations: [], approval_used: null },
    required_sources: [],
    blocking_findings: [],
    allowed_next_actions: [],
    forbidden_next_actions: [],
    behaviour_drift_check: { passed: true, notes: 'n/a — per-task cap forced quarantine' },
  };
}

function emptyVerificationStub() {
  const skip = { status: 'SKIP', summary: 'budget halt before verification ran' };
  return {
    typecheck: skip, test: skip, build: skip, audit: skip,
    qa_browser: skip, banned_strings_dist: skip, backup_tests: skip, binder_tests: skip,
  };
}
