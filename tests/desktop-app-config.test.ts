// PR 28 — desktop app config + scaffold sanity checks. Drives the
// "is the desktop scaffold actually wired up correctly" verification
// without requiring Rust / Cargo to be installed locally.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function readJson(relative: string): unknown {
  const raw = readFileSync(join(repoRoot, relative), 'utf-8');
  return JSON.parse(raw);
}

interface PackageJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface TauriConfig {
  productName?: string;
  identifier?: string;
  build?: {
    beforeDevCommand?: string;
    beforeBuildCommand?: string;
    devUrl?: string;
    frontendDist?: string;
  };
  app?: {
    windows?: ReadonlyArray<{
      label?: string;
      title?: string;
      width?: number;
      height?: number;
      minWidth?: number;
      minHeight?: number;
      resizable?: boolean;
      fullscreen?: boolean;
    }>;
    security?: {
      csp?: string | null;
    };
  };
}

interface CapabilityConfig {
  identifier?: string;
  windows?: readonly string[];
  permissions?: readonly string[];
  description?: string;
}

describe('desktop app config (PR 28)', () => {
  // -- package.json scripts ------------------------------------------
  describe('package.json', () => {
    const pkg = readJson('package.json') as PackageJson;

    it('has a `tauri` script', () => {
      expect(pkg.scripts?.['tauri']).toBe('tauri');
    });

    it('has a `desktop:dev` script', () => {
      expect(pkg.scripts?.['desktop:dev']).toBe('tauri dev');
    });

    it('has a `desktop:build` script', () => {
      expect(pkg.scripts?.['desktop:build']).toBe('tauri build');
    });

    it('has a `desktop:check` script that chains typecheck + test + build', () => {
      const check = pkg.scripts?.['desktop:check'] ?? '';
      expect(check).toContain('typecheck');
      expect(check).toContain('test');
      expect(check).toContain('build');
    });

    it('keeps the existing browser scripts', () => {
      expect(pkg.scripts?.['dev']).toBe('vite');
      expect(pkg.scripts?.['build']).toContain('vite build');
      expect(pkg.scripts?.['preview']).toBe('vite preview');
      // PR A1: the `test` script excludes the 11 qa:browser test files
      // (they're already run separately by `npm run qa:browser`) so the
      // supervisor's per-step test cap fits comfortably. Assertion
      // relaxed from strict equality to substring + exclude-flag presence.
      expect(pkg.scripts?.['test']).toMatch(/^vitest run\b/);
      expect(pkg.scripts?.['test']).toContain('--exclude=tests/qa-seed.test.ts');
      expect(pkg.scripts?.['typecheck']).toBe('tsc --noEmit');
    });

    it('declares @tauri-apps/cli as a dev dependency', () => {
      expect(pkg.devDependencies?.['@tauri-apps/cli']).toBeDefined();
    });
  });

  // -- vite.config.ts ------------------------------------------------
  describe('vite.config.ts', () => {
    const config = readFileSync(join(repoRoot, 'vite.config.ts'), 'utf-8');

    it('uses port 5173', () => {
      expect(config).toMatch(/port:\s*5173/);
    });

    it('uses strictPort', () => {
      expect(config).toMatch(/strictPort:\s*true/);
    });

    it('ignores src-tauri in the watcher', () => {
      expect(config).toContain('src-tauri');
    });
  });

  // -- src-tauri/tauri.conf.json ------------------------------------
  describe('src-tauri/tauri.conf.json', () => {
    it('exists and parses', () => {
      const path = join(repoRoot, 'src-tauri', 'tauri.conf.json');
      expect(existsSync(path)).toBe(true);
      const cfg = readJson('src-tauri/tauri.conf.json') as TauriConfig;
      expect(cfg.productName).toBe("Morten's Pokémon Tracker");
      expect(cfg.identifier).toBe('com.morten.pokemontracker');
    });

    const cfg = readJson('src-tauri/tauri.conf.json') as TauriConfig;

    it('frontendDist points at ../dist', () => {
      expect(cfg.build?.frontendDist).toBe('../dist');
    });

    it('devUrl points at the fixed Vite dev port', () => {
      expect(cfg.build?.devUrl).toBe('http://localhost:5173');
    });

    it('beforeDevCommand and beforeBuildCommand match npm scripts', () => {
      expect(cfg.build?.beforeDevCommand).toBe('npm run dev');
      expect(cfg.build?.beforeBuildCommand).toBe('npm run build');
    });

    it('main window has the configured title and dimensions', () => {
      const win = cfg.app?.windows?.[0];
      expect(win?.label).toBe('main');
      expect(win?.title).toBe("Morten's Pokémon Tracker");
      expect(win?.width).toBe(1440);
      expect(win?.height).toBe(950);
      expect(win?.minWidth).toBe(1000);
      expect(win?.minHeight).toBe(700);
      expect(win?.resizable).toBe(true);
      expect(win?.fullscreen).toBe(false);
    });
  });

  // -- src-tauri/capabilities/main.json -----------------------------
  describe('src-tauri/capabilities/main.json', () => {
    const cap = readJson(
      'src-tauri/capabilities/main.json',
    ) as CapabilityConfig;

    it('targets only the main window', () => {
      expect(cap.windows).toEqual(['main']);
    });

    it('does not request any fs: permission', () => {
      const has = (cap.permissions ?? []).some((p) => p.startsWith('fs:'));
      expect(has).toBe(false);
    });

    it('does not request any shell: permission', () => {
      const has = (cap.permissions ?? []).some((p) => p.startsWith('shell:'));
      expect(has).toBe(false);
    });

    it('does not request any clipboard: permission', () => {
      const has = (cap.permissions ?? []).some((p) =>
        p.startsWith('clipboard:'),
      );
      expect(has).toBe(false);
    });

    it('does not declare any remote URL capability', () => {
      // The capability file uses `windows` (a string list), not
      // `remote`. If a future revision starts adding a remote URL
      // section it must be reviewed; assert absence for now.
      const raw = readFileSync(
        join(repoRoot, 'src-tauri', 'capabilities', 'main.json'),
        'utf-8',
      );
      expect(raw).not.toMatch(/"remote"\s*:/);
    });
  });

  // -- src-tauri/src/main.rs ----------------------------------------
  describe('src-tauri/src/main.rs', () => {
    const main = readFileSync(
      join(repoRoot, 'src-tauri', 'src', 'main.rs'),
      'utf-8',
    );

    it('uses the standard Tauri builder entrypoint', () => {
      expect(main).toContain('tauri::Builder::default()');
      expect(main).toContain('tauri::generate_context!()');
    });

    it('does not register custom shell or fs commands', () => {
      expect(main).not.toMatch(/std::process::Command/);
      expect(main).not.toMatch(/std::fs::/);
      expect(main).not.toMatch(/reqwest/);
    });
  });

  // -- src-tauri/Cargo.toml & build.rs ------------------------------
  describe('src-tauri/Cargo.toml + build.rs', () => {
    const cargo = readFileSync(
      join(repoRoot, 'src-tauri', 'Cargo.toml'),
      'utf-8',
    );
    const build = readFileSync(
      join(repoRoot, 'src-tauri', 'build.rs'),
      'utf-8',
    );

    it('depends on tauri v2', () => {
      expect(cargo).toMatch(/tauri\s*=\s*\{\s*version\s*=\s*"2"/);
    });

    it('uses tauri-build v2 in build dependencies', () => {
      expect(cargo).toMatch(/tauri-build\s*=\s*\{\s*version\s*=\s*"2"/);
    });

    it('build.rs invokes tauri_build::build()', () => {
      expect(build).toContain('tauri_build::build()');
    });
  });

  // -- docs/DESKTOP_APP.md ------------------------------------------
  describe('docs/DESKTOP_APP.md', () => {
    const path = join(repoRoot, 'docs', 'DESKTOP_APP.md');
    const docs = readFileSync(path, 'utf-8');

    it('exists', () => {
      expect(existsSync(path)).toBe(true);
    });

    it('mentions Rust', () => {
      expect(docs).toMatch(/rust/i);
    });

    it('mentions WebView2', () => {
      expect(docs).toContain('WebView2');
    });

    it('mentions Microsoft C++ Build Tools', () => {
      expect(docs).toMatch(/c\+\+ build tools/i);
    });

    it('mentions backup and that data stays local', () => {
      expect(docs.toLowerCase()).toContain('backup');
      expect(docs.toLowerCase()).toContain('local');
    });

    it('mentions no auto-update and no code signing yet', () => {
      expect(docs.toLowerCase()).toContain('auto-update');
      expect(docs.toLowerCase()).toContain('code sign');
    });
  });
});
