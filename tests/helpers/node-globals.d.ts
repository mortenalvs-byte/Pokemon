// PR 28 — minimal Node globals so test files can import `node:fs` /
// `node:path` and read `process.cwd()` without pulling in the full
// `@types/node` package as a project dep. Only declares what the
// PR 28 desktop-config + recommended-placement source-grep tests
// actually use. PR 39 (AI Supervisor) extends with fs/promises + os
// for the parse-approval test's tmpdir round-trip.

declare module 'node:fs' {
  export function readFileSync(
    path: string,
    encoding: 'utf-8' | 'utf8',
  ): string;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
}

declare module 'node:fs/promises' {
  export function mkdtemp(prefix: string): Promise<string>;
  export function mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<string | undefined>;
  export function writeFile(
    path: string,
    data: string,
    encoding?: 'utf-8' | 'utf8',
  ): Promise<void>;
  export function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...segments: string[]): string;
  const _default: { join: typeof join };
  export default _default;
}

declare const process: {
  cwd(): string;
};
