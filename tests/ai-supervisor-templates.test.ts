// @ts-ignore — supervisor .mjs imports
import { describe, expect, it } from 'vitest';

// @ts-ignore
import { renderString, renderTemplate } from '../scripts/ai-supervisor/templates.mjs';

describe('templates.mjs — variable substitution', () => {
  it('substitutes a simple variable', () => {
    expect(renderString('Hello {{name}}', { name: 'Morten' })).toBe('Hello Morten');
  });

  it('substitutes dotted-path properties', () => {
    expect(renderString('{{task.title}}', { task: { title: 'PR 35' } })).toBe('PR 35');
  });

  it('throws when a variable is missing', () => {
    expect(() => renderString('{{nope}}', {})).toThrow(/Template variable not provided/);
  });

  it('coerces null/undefined into empty string for null', () => {
    expect(() => renderString('{{x}}', { x: undefined })).toThrow(); // undefined throws
    // For null, resolveDotted returns null which renderVars coerces to '' (the != check)
    // (Actually checking the code, null returns "")
    expect(renderString('a{{x}}b', { x: null })).toBe('ab');
  });
});

describe('templates.mjs — {{#each}}', () => {
  it('iterates over string list', () => {
    expect(renderString('{{#each xs}}-{{this}}{{/each}}', { xs: ['a', 'b', 'c'] })).toBe('-a-b-c');
  });

  it('iterates over object list with key access', () => {
    expect(renderString('{{#each tasks}}{{title}}|{{/each}}', { tasks: [{ title: 'A' }, { title: 'B' }] })).toBe('A|B|');
  });

  it('supports {{@index}}', () => {
    expect(renderString('{{#each xs}}{{@index}}={{this}};{{/each}}', { xs: ['a', 'b'] })).toBe('0=a;1=b;');
  });

  it('throws when each target is not an array', () => {
    expect(() => renderString('{{#each xs}}{{this}}{{/each}}', { xs: 'not-an-array' })).toThrow(/not an array/);
  });
});

describe('templates.mjs — {{#if}}', () => {
  it('renders body when truthy', () => {
    expect(renderString('{{#if show}}YES{{/if}}', { show: true })).toBe('YES');
    expect(renderString('{{#if show}}YES{{/if}}', { show: 'truthy' })).toBe('YES');
  });

  it('omits body when falsy', () => {
    expect(renderString('{{#if show}}YES{{/if}}NO', { show: false })).toBe('NO');
    expect(renderString('{{#if show}}YES{{/if}}NO', { show: null })).toBe('NO');
  });
});

describe('templates.mjs — line endings', () => {
  it('normalizes CRLF to LF', () => {
    expect(renderString('a\r\nb', {})).toBe('a\nb');
  });
});

describe('templates.mjs — renderTemplate (filesystem)', () => {
  it('renders continue-claude template with all required variables', async () => {
    const out = await renderTemplate('continue-claude', {
      task_id: 'task-1',
      task_title: 'Test task',
      summary: 'failing checks',
      failing_checks: [{ check: 'typecheck', detail: 'oops' }],
      fix_instructions: ['step 1', 'step 2'],
      allowedFiles_csv: 'src/a.ts',
      mustNotChange_csv: 'route names',
      repairCount: 1,
      maxRepairs: 5,
    });
    expect(out).toContain('task-1');
    expect(out).toContain('Test task');
    expect(out).toContain('- step 1');
    expect(out).toContain('- step 2');
    expect(out).not.toContain('{{');
  });

  it('renders next-task with branch-switch instructions when applicable', async () => {
    const out = await renderTemplate('next-task', {
      task_id: 'task-2',
      task_title: 'Next thing',
      task_description: 'do the thing',
      should_switch_branch: true,
      task_branch_hint: 'feat/x',
      acceptance: ['a1', 'a2'],
      mustNotChange: ['x'],
      allowedFiles: ['src/x.ts'],
    });
    expect(out).toContain('Branch switch required');
    expect(out).toContain('feat/x');
    expect(out).toContain('- a1');
  });

  it('renders next-task WITHOUT branch-switch when not needed', async () => {
    const out = await renderTemplate('next-task', {
      task_id: 'task-2',
      task_title: 'Next thing',
      task_description: 'do the thing',
      should_switch_branch: false,
      task_branch_hint: 'feat/x',
      acceptance: ['a1'],
      mustNotChange: [],
      allowedFiles: ['src/x.ts'],
    });
    expect(out).not.toContain('Branch switch required');
  });
});
