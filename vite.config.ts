import { defineConfig, loadEnv } from 'vite';

// PR 28 — Tauri-aware vite config. The fixed dev port matches
// `tauri.conf.json`'s `build.devUrl`; `strictPort` makes Tauri fail
// fast if 5173 is already taken instead of silently moving to a
// different port that the desktop shell can't find. We also ignore
// `src-tauri/**` in the watcher so Rust file edits don't churn the
// browser dev server.
//
// `TAURI_DEV_HOST` is set by Tauri itself when running mobile-bridge
// development; loading via `loadEnv` keeps us decoupled from
// `@types/node` (the project doesn't ship them).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'TAURI_');
  const host = env['TAURI_DEV_HOST'];
  return {
    clearScreen: false,
    build: {
      target: 'es2022',
      sourcemap: true,
    },
    server: {
      port: 5173,
      strictPort: true,
      host: host !== undefined && host !== '' ? host : false,
      watch: {
        ignored: ['**/src-tauri/**'],
      },
    },
  };
});
