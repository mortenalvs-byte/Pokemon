# BACKUP_FORMAT — Pokemon TCG Tracker

Backup and restore are **MVP requirements**, not future scope. No PR may merge if it breaks JSON export, JSON import, backup validation, or `schemaVersion` handling.

This document defines the JSON backup file format, the restore behaviour, and the CSV export rules.

---

## 1. File name and identity

- Default file name when exporting: `pokemon-tracker-backup-v1-<YYYYMMDD-HHMMSS>.json`.
- Encoding: UTF-8, no BOM.
- Top-level value: a single JSON object that conforms to `BackupFile` (see [DATA_MODEL.md §7](DATA_MODEL.md#7-typescript-types--record-shapes)).
- The first line of the file must be valid JSON; pretty-printing (two-space indent) is allowed and recommended.

---

## 2. Required structure

```jsonc
{
  "app": "Pokemon TCG Tracker",
  "schemaVersion": 1,
  "exportedAt": "2026-05-06T14:30:00.000Z",

  "settings": [
    /* SettingsRecord[] — pokemonTcgApiKey is EXCLUDED by default */
  ],

  "sets":         [ /* SetRecord[]         */ ],
  "cards":        [ /* CardRecord[]        */ ],
  "holdings":     [ /* HoldingRecord[]     */ ],
  "lots":         [ /* LotRecord[]         */ ],
  "lotItems":     [ /* LotItemRecord[]     */ ],
  "binders":      [ /* BinderRecord[]      */ ],
  "binderSlots":  [ /* BinderSlotRecord[]  */ ],
  "wishlist":     [ /* WishlistRecord[]    */ ],
  "auditLog":     [ /* AuditLogRecord[]    */ ],
  "appMeta":      [ /* AppMetaRecord[]     */ ]
}
```

All twelve top-level keys must be present. An empty store is represented by `[]`. Reordering keys is not significant.

The `app` literal **must** be the exact string `"Pokemon TCG Tracker"`. Any other value causes the backup to be rejected.

---

## 3. Sensitive fields

### API key handling
- The `pokemonTcgApiKey` setting is **excluded from default exports**. The exporter walks `settings` and removes that key.
- An optional "include API key in this backup" mode may exist later. It must require explicit user confirmation **per export** and must label the resulting file plainly (e.g. `…-with-api-key.json`).
- The API key must never be logged, never printed to the console, and never sent anywhere by the app.

### Other sensitive metadata
- `auditLog.message` is short and human-readable. Implementers must not put secrets, tokens, or full card images into audit messages.

---

## 4. Validation rules (run before any read of `data.holdings` etc.)

Reject the backup, surface the reason, and leave the database untouched if any of the following fails.

1. The file parses as JSON.
2. The root value is a non-null object.
3. `app === "Pokemon TCG Tracker"`.
4. `schemaVersion` is a positive integer.
5. `exportedAt` is a valid ISO 8601 timestamp.
6. Every top-level array key listed in §2 exists and is an array.
7. Every record in `holdings`, `binders`, `binderSlots`, `lots`, `lotItems`, `wishlist` has a string `id`.
8. Foreign keys referenced inside one user-data array can be resolved within the same file (e.g. `BinderSlotRecord.binderId` exists in `binders[]`, `BinderSlotRecord.holdingId`, when not null, exists in `holdings[]`). Cross-references that are missing are reported but do not by themselves abort the import in MVP — the restore preview surfaces them as warnings.
9. `schemaVersion` is supported by the running app:
   - If `schemaVersion === currentSchemaVersion`, restore proceeds without migration.
   - If `schemaVersion < currentSchemaVersion`, the backup is migrated forward through the same Dexie migrations used by the live database.
   - If `schemaVersion > currentSchemaVersion`, the restore is **rejected** with a clear error: "This backup was created by a newer version of the app and cannot be restored here. Please update the app first."

---

## 5. Restore preview

Before any write to the database, the user sees a preview panel containing:

- File name
- `exportedAt`
- `schemaVersion`
- Counts per store: cards, holdings, binders, binderSlots, lots, lotItems, wishlist, auditLog
- Whether the file contains an API key (when the optional include-API-key mode is used)
- Any cross-reference warnings

The preview ends with three actions:

- **Cancel** — close the dialog, do nothing.
- **Replace** — wipe the current database and write the backup. **MVP default.**
- **Merge** — _disabled in MVP_. The button is shown for future use but rejects with "Merge restore is planned for a later release."

---

## 6. Replace restore (MVP behaviour)

Replace is a destructive operation. The flow:

1. The app attempts to **export the current database** to a file named `pre-restore-backup-<YYYYMMDD-HHMMSS>.json` and offers it to the user (download or save dialog, depending on browser).
2. If the pre-restore export **fails** for any reason, the user must explicitly confirm a second time before the replace continues. The confirmation dialog must say, in plain text, that the current database will be overwritten and the safety net is unavailable.
3. The app opens a single Dexie write transaction covering all user-owned and cache stores.
4. Inside that transaction:
   - All cache stores (`sets`, `cards`) are cleared and repopulated.
   - All user-owned stores (`holdings`, `lots`, `lotItems`, `binders`, `binderSlots`, `wishlist`, `auditLog`) are cleared and repopulated.
   - `settings` are cleared and repopulated. The current `pokemonTcgApiKey`, if any, is **preserved** unless the user explicitly opted into restoring an API key from the backup.
   - `appMeta` is updated:
     - `schemaVersion` reflects the post-migration version.
     - `lastBackupAt` is set to the imported `exportedAt`.
     - `lastMigrationAt` is set to "now".
5. An `auditLog` entry `backup_restored` is appended (timestamp = "now", message describes file name and counts).
6. The transaction commits atomically. On any error, Dexie rolls back and the original database is intact.

---

## 7. Export procedure

1. Open a single Dexie read transaction over every store.
2. Read every record (no filtering, no pagination — backups are complete snapshots).
3. Strip `pokemonTcgApiKey` from `settings` unless the user opted in.
4. Build the JSON object in the order documented in §2.
5. Stringify with two-space indentation.
6. Offer the file as a download via `Blob` + `URL.createObjectURL` + a synthetic `<a download>` click.
7. Update `appMeta.lastBackupAt` and `appMeta.lastBackupHoldingCount`.
8. Append an `auditLog` entry `backup_exported`.

The export must not block the UI for more than one frame at a time on a database with 20 000 cards and 5 000 holdings. If profiling shows it does, chunk the read by store.

---

## 8. CSV export rules

The MVP exports CSV files for collection, missing cards, duplicates, wishlist, and binder checklist.

| Setting | Value |
|---|---|
| Delimiter | `,` |
| Encoding | UTF-8 (a UTF-8 BOM is allowed for Excel compatibility) |
| Line ending | `\r\n` (CRLF) — friendly to Excel on Windows |
| Quoting | RFC 4180: fields containing commas, quotes, or newlines are quoted with `"…"`; embedded `"` is escaped as `""` |
| Header row | Always present |
| Dates | ISO 8601 (`YYYY-MM-DD` for date-only fields, full RFC 3339 timestamp otherwise) |
| Currency columns | Always followed by an explicit currency-code column. Example: `purchasePrice`, `purchaseCurrency`. Currency codes use `NOK`, `USD`, `EUR`, `PHP`. |
| Boolean columns | `true` / `false` (lowercase) |
| Empty values | Empty string |
| Numbers | Use `.` as decimal separator, no thousands separator |

### Required CSV files

| File | One row per |
|---|---|
| `collection.csv` | Holding (raw + graded as separate rows) |
| `binder-checklist.csv` | BinderSlot, scoped to a chosen binder |
| `missing-cards.csv` | BinderSlot where `status !== 'owned'` (or its holding is soft-deleted) |
| `duplicates.csv` | Duplicate holding aggregated per cardId+condition+location |
| `wishlist.csv` | WishlistRecord |

Column lists are owned by `src/domain/csv.ts` (added in PR 6 / PR 8 / PR 10). Adding or renaming a CSV column is a documentation change to this file plus a code change.

Imports of foreign CSV formats (Collectr, Dragon Shield, etc.) are out of scope for MVP.

---

## 9. Future-only fields

If a future schema version adds optional fields to a record type, those fields appear in newer backups but are absent from older ones. Restore must tolerate missing optional fields; the migration applied during restore is the same one used for live database upgrades.

If a future schema version adds a new store, older backups simply omit it and the migration creates an empty store.

If a future schema version removes a field, the migration during restore drops the field. The pre-restore auto-backup preserves the original file untouched on disk.

---

## 10. Out of scope for this document

- Cloud-side backup (no cloud sync in MVP).
- Encrypted backups (the file is plain JSON; if the user wants encryption they encrypt the file themselves).
- Differential / incremental backups.
- Automatic scheduled backups (the dashboard *reminds* the user, but it does not act).
