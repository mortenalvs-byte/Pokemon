// Templates renderer for AI Supervisor.
//
// Minimal Handlebars-subset: supports {{variable}}, {{#each list}}...{{/each}}
// with {{this}} / {{@index}}, and {{#if cond}}...{{/if}}. NO Handlebars dep.
//
// Normalizes line endings (\r\n → \n) on read.
// Throws on referenced-but-missing variable.
//
// LIMITATIONS (intentional, none used by our 6 PR1 templates):
// - No NESTED {{#each}} blocks. Each {{#each}} must close before another opens.
// - No `{{else}}` clause inside {{#if}}.
// - No `{{else}}` clause inside {{#each}} for empty arrays.
// - No escape sequence for literal `{{` (our templates never contain it).
// If a future template needs any of these, extend the renderer + add tests.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const TEMPLATES_DIR = path.join(import.meta.dirname, 'templates');

const cache = new Map();

async function loadTemplate(name) {
  if (cache.has(name)) return cache.get(name);
  const filePath = path.join(TEMPLATES_DIR, `${name}.md`);
  const raw = await readFile(filePath, 'utf8');
  const normalized = raw.replace(/\r\n/g, '\n');
  cache.set(name, normalized);
  return normalized;
}

// Resolve a dotted property path on a context object.
// 'a.b.c' on {a: {b: {c: 42}}} -> 42
// Special-case: 'this' resolves to ctx.this (the per-iteration item set by {{#each}}),
// not to ctx itself. Bare ctx is meaningful only at the top level.
function resolveDotted(ctx, dotted) {
  const parts = dotted.split('.');
  let cur = ctx;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Render a section by repeatedly substituting until no more constructs remain.
// Order: first handle {{#each}} (outer-most), then {{#if}}, then plain {{var}}.
function render(template, vars) {
  let out = template;

  // {{#each list}}...{{/each}} — non-greedy, ungrouped
  out = renderEach(out, vars);

  // {{#if cond}}...{{/if}}
  out = renderIf(out, vars);

  // Plain {{var}} substitution (after each/if so nested vars also get resolved)
  out = renderVars(out, vars);

  return out;
}

function renderEach(template, vars) {
  // Match the outermost {{#each X}}...{{/each}} non-greedily.
  // Then recursively render the inner body for each item.
  const re = /\{\{#each\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/;
  while (re.test(template)) {
    template = template.replace(re, (_match, listExpr, body) => {
      const list = resolveDotted(vars, listExpr);
      if (!Array.isArray(list)) {
        throw new Error(`Template {{#each ${listExpr}}}: value is not an array (got ${typeof list})`);
      }
      return list.map((item, idx) => {
        // For each item, build a per-iteration context where {{this}} is the item.
        // Also surface item's properties at top-level (so {{title}} works for object items).
        const itemCtx = (typeof item === 'object' && item != null)
          ? { ...vars, ...item, this: item, '@index': idx }
          : { ...vars, this: item, '@index': idx };
        // Recurse to handle nested {{#each}}/{{#if}} inside the body.
        let rendered = renderEach(body, itemCtx);
        rendered = renderIf(rendered, itemCtx);
        rendered = renderVars(rendered, itemCtx);
        return rendered;
      }).join('');
    });
  }
  return template;
}

function renderIf(template, vars) {
  const re = /\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/;
  while (re.test(template)) {
    template = template.replace(re, (_match, condExpr, body) => {
      const v = resolveDotted(vars, condExpr);
      return v ? body : '';
    });
  }
  return template;
}

function renderVars(template, vars) {
  return template.replace(/\\\{\{/g, '\0LBRACE\0')  // escape: \{{ → literal {{
    .replace(/\{\{\s*([\w.]+|@index)\s*\}\}/g, (_m, expr) => {
      // {{@index}} resolves to the index when inside an each context
      if (expr === '@index') {
        const idx = vars['@index'];
        if (idx === undefined) throw new Error(`Template {{@index}} used outside an {{#each}} block`);
        return String(idx);
      }
      const v = resolveDotted(vars, expr);
      if (v === undefined) {
        throw new Error(`Template variable not provided: {{${expr}}}`);
      }
      return v == null ? '' : String(v);
    })
    .replace(/\0LBRACE\0/g, '{{');
}

/**
 * Render a named template against a variables context.
 * @param {string} name — template name without .md extension (e.g. 'continue-claude')
 * @param {object} vars — variables map
 * @returns {Promise<string>}
 */
export async function renderTemplate(name, vars) {
  const tpl = await loadTemplate(name);
  return render(tpl, vars);
}

/**
 * Render a raw template string (useful for testing without filesystem).
 * @param {string} template
 * @param {object} vars
 * @returns {string}
 */
export function renderString(template, vars) {
  return render(template.replace(/\r\n/g, '\n'), vars);
}
