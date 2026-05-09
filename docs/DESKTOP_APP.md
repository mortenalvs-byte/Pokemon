# Desktop app

Private local desktop wrapper for **Morten's Pokémon Tracker**.

The desktop app is the same TypeScript / Vite / Dexie frontend you already know — wrapped in [Tauri v2](https://v2.tauri.app/) so it can run as a native window with its own icon, dock entry, and persistent IndexedDB store. Nothing about the data model changes; the WebView hosts the same code the browser dev server hosts.

## Stack

- **Tauri v2** (Rust shell + system WebView)
- **Vite** dev server / production bundler
- **TypeScript (strict)** application code
- **Dexie / IndexedDB** local persistence

## Windows prerequisites

You need all of these installed before `npm run desktop:dev` or `npm run desktop:build` will work:

1. **Node.js** ≥ 20.19 and **npm** ≥ 10 (already required for the browser app).
2. **Rust toolchain** including **Cargo**. Install via [rustup](https://rustup.rs/). The `cargo` and `rustc` commands must be on your PATH.
3. **Microsoft C++ Build Tools** (MSVC) — usually installed as part of the "Desktop development with C++" workload in Visual Studio Installer. Tauri's Rust crates link against the MSVC toolchain on Windows.
4. **Microsoft Edge WebView2** — pre-installed on Windows 11 and most Windows 10 setups. If missing, install the [Evergreen WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).
5. **VBSCRIPT** is only relevant if you switch the bundle target to MSI. The default `targets: "all"` config creates `.exe` and `.msi`; if you only want `.exe`, see [Tauri bundle docs](https://v2.tauri.app/distribute/).

The browser app continues to work without any of the desktop prerequisites — `npm run dev` and `npm run build` only need Node + npm.

## Commands

```bash
# install deps (browser + desktop)
npm install

# dev: runs Vite on :5173 and opens a Tauri window pointing at it
npm run desktop:dev

# release build: produces a Windows .exe (and .msi) under
# src-tauri/target/release/bundle/
npm run desktop:build

# CI-style verification of the browser app — runs typecheck, all
# Vitest suites, and a production browser build. Does NOT require
# the Rust toolchain.
npm run desktop:check
```

## Data note

- All data lives in the WebView's IndexedDB store. The desktop window has its **own** WebView profile separate from your normal browser, so the desktop app and the browser dev server do **not** share the same database.
- To move data between them, use the existing **Backup → Eksporter / Restore fra fil** flow.
- Backup is still your single source of truth. The desktop app does not change anything about how the JSON backup format works — the same file moves cleanly between browser and desktop installs.

## Security note

- **No filesystem access** is granted to the frontend. The capability file (`src-tauri/capabilities/main.json`) only requests `core:default`; there is no `fs:`, `shell:`, or `clipboard:` permission.
- **No shell execution** is exposed.
- **No cloud / backend / login** — the app stays fully local.
- **No auto-update** — desktop builds are produced manually.
- **No code signing** — installers are unsigned. Windows SmartScreen will warn the first time you run a freshly built `.exe`; this is expected for an unsigned, locally-built personal app.

## Troubleshooting

- **`error: cannot find command "cargo"`** — Rust is not installed. Install via [rustup](https://rustup.rs/) and reopen your terminal.
- **`error: linker 'link.exe' not found` or `error MSB8036`** — Microsoft C++ Build Tools missing. Install the "Desktop development with C++" workload in the Visual Studio Installer.
- **WebView2 missing / window opens blank** — install the [Evergreen WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) and reboot.
- **`port 5173 is already in use`** — another Vite/dev server is running on the same port. `vite.config.ts` uses `strictPort: true` on purpose so the desktop shell never silently moves to a different port. Stop the other process or change the port in both `vite.config.ts` and `src-tauri/tauri.conf.json` (`build.devUrl`).
- **`npm run desktop:build` fails on this machine** — verify the Windows prerequisites list above. If a prerequisite is missing, the desktop build is genuinely unavailable on this machine; the browser build (`npm run build`) continues to work and is the canonical artifact for normal use.
