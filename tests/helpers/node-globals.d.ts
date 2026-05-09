// PR 28 — minimal Node globals so test files can import `node:fs` /
// `node:path` and read `process.cwd()` without pulling in the full
// `@types/node` package as a project dep. Only declares what the
// PR 28 desktop-config + recommended-placement source-grep tests
// actually use.

declare module 'node:fs' {
  export function readFileSync(
    path: string,
    encoding: 'utf-8' | 'utf8',
  ): string;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
}

declare module 'node:path' {
  export function join(...segments: string[]): string;
}

declare const process: {
  cwd(): string;
};
