// Prevents an extra console window on Windows release builds. The
// non-Windows attribute lets `cargo run` keep working on macOS/Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// PR 28 — desktop shell entrypoint. Intentionally minimal:
//   - no custom Tauri commands
//   - no filesystem helpers
//   - no shell helpers
//   - no network code
// All app logic stays in the existing TypeScript / IndexedDB
// frontend. The Rust side just hosts the WebView.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
