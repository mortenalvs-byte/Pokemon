# TECH_STACK — Pokemon TCG Tracker

Locked technical decisions for the MVP. Changes require an explicit docs PR.

---

## 1. Stack summary

| Concern | Choice |
|---|---|
| Language | TypeScript, **strict** mode |
| App type | Local-first browser app |
| Build tool | Vite (`vanilla-ts` template) |
| UI framework | None |
| Styling | Plain CSS with CSS variables |
| Database | IndexedDB via [Dexie](https://dexie.org/) |
| Tests | [Vitest](https://vitest.dev/) (with `jsdom` + `fake-indexeddb`) |
| Package manager | npm |
| Card data API | [pokemontcg.io](https://pokemontcg.io) |
| Storage strategy | IndexedDB + JSON backup/restore |
| Offline | App must work offline after first successful sync |

---

## 2. Why each choice

### TypeScript (strict)
The data model is the heart of the app. Strict types catch shape mistakes (a missing `deletedAt`, a wrong allocation method, a misspelled enum value) before they corrupt user data. Strict mode is non-negotiable; it is what lets us treat user-owned data as sacred at the type level.

### Vite (vanilla-ts)
Vite gives us a fast dev server, native ES module loading, and a TypeScript build pipeline without dragging in a UI framework. The `vanilla-ts` template ships only what we need: an `index.html`, a `src/main.ts`, and a working `tsc` + bundler chain. We use Vite for local development and for producing a static build that can be served from any HTTP server.

### No UI framework
React, Vue, Svelte, and friends would each pull in their own state-management story, ecosystem dependencies, and rebuild model. For a private, local-first app whose hottest path is "open a paginated table fast", they are overkill. We use vanilla DOM with small typed view modules. This keeps the bundle small, the codebase readable, and the "no framework unless approved" rule easy to enforce.

### Plain CSS + CSS variables
Tailwind, shadcn, and CSS-in-JS each add tooling and indirection. CSS variables give us theming, design tokens, and consistent spacing/colors with zero build cost. The UI is data-dense and table-heavy — readability wins over visual polish.

### Dexie over IndexedDB
Raw IndexedDB is verbose, callback-based, and easy to misuse. Dexie is a thin, well-tested wrapper that gives us a typed schema, versioned migrations, transactions, and `liveQuery`. It does not lock us in (we can still drop to raw IndexedDB if needed) and it lets the data layer ship in a single PR.

### Vitest
Vitest reuses Vite's transform pipeline so the test runner sees the same TypeScript and ES modules the app does. It supports `jsdom` for DOM-aware tests and runs fast. Combined with [`fake-indexeddb`](https://github.com/dumbmatter/fakeIndexedDB), it lets us test Dexie schemas, migrations, and backup/restore round-trips entirely in Node.

### npm
Default Node package manager. No reason to add yarn/pnpm complexity for a single-developer project.

### pokemontcg.io
Free, well-documented REST API covering English Pokemon TCG cards and sets. Rate limits: 1000 requests/day without a key, 20 000 requests/day with a free key.

---

## 3. What this stack explicitly does **not** include

The following are forbidden in MVP and may not be added without an explicit, separate approval PR:

- React, Vue, Svelte, Solid, Lit, or any other UI framework
- Tailwind, shadcn, Bootstrap, or any other CSS framework
- Backend server (Node/Express/Fastify/etc.), serverless functions, or edge workers
- Login / accounts / OAuth
- Cloud sync of any kind
- External paid APIs *(does not include local-only dev/review tools — see [PR_RULES.md §7](PR_RULES.md#7-forbidden-without-explicit-approval) and [docs/governance/AI_SUPERVISOR_APPROVAL.md](docs/governance/AI_SUPERVISOR_APPROVAL.md))*
- Image upload / image storage in IndexedDB
- Service workers (Service workers may be revisited later, but they are not MVP.)
- Any storage of API keys outside the IndexedDB `settings` store

---

## 4. Repository structure (after PR 2)

```
Pokemon/
├── README.md
├── KRAVSPEC.md
├── TECH_STACK.md
├── DATA_MODEL.md
├── BACKUP_FORMAT.md
├── DASHBOARD_SPEC.md
├── UI_DESIGN_SPEC.md
├── PR_RULES.md
├── USER_FLOWS.md
├── MVP_ACCEPTANCE.md
├── CHANGELOG.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── index.html
├── public/
├── src/
│   ├── main.ts
│   ├── app.ts
│   ├── config.ts
│   ├── styles.css
│   ├── db/                # Dexie schema, migrations, audit, backup
│   ├── api/               # pokemontcg.io wrapper
│   ├── repositories/      # store-level CRUD
│   ├── domain/            # types, pricing, bulk, completion, validators
│   ├── ui/                # one file per view + components/
│   ├── seed/              # demo seed data
│   └── utils/             # ids, dates, validation
└── tests/
    ├── setup.ts
    ├── schema.test.ts
    ├── migrations.test.ts
    ├── backup.test.ts
    ├── bulk.test.ts
    ├── pricing.test.ts
    └── audit.test.ts
```

---

## 5. Initial scaffold

The scaffold lands across two PRs. PR 2 brings in the build tool, type-checker, test runner, and DOM polyfill. PR 3 adds the IndexedDB layer and its in-memory test polyfill on top.

### PR 2 — app shell + tooling (no database)

```bash
# Inside the empty repo, on branch feat/app-shell
npm create vite@latest . -- --template vanilla-ts
npm install
npm install -D vitest @vitest/ui jsdom
```

### PR 3 — Dexie + IndexedDB tests

```bash
# On branch feat/dexie-schema-v1
npm install dexie
npm install -D fake-indexeddb
```

`tests/setup.ts` stays a placeholder in PR 2 and adds `import 'fake-indexeddb/auto';` in PR 3 alongside the first Dexie schema.

After PR 2 scaffold:
- Update `tsconfig.json` to ensure `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`.
- Add `vitest.config.ts` with `environment: 'jsdom'` and `setupFiles: ['./tests/setup.ts']`.
- Leave `tests/setup.ts` empty for now.

After PR 3 scaffold:
- In `tests/setup.ts`: `import 'fake-indexeddb/auto';` so Dexie schema and migrations can be tested in Node.

---

## 6. npm scripts

These are the canonical scripts for the project. They land in `package.json` in PR 2.

| Script | Command | Purpose |
|---|---|---|
| `dev` | `vite` | Start the dev server with hot reload |
| `build` | `tsc && vite build` | Type-check then produce a production build in `dist/` |
| `preview` | `vite preview` | Serve the production build locally |
| `test` | `vitest run` | Run all tests once |
| `test:watch` | `vitest` | Run tests in watch mode |
| `test:ui` | `vitest --ui` | Open the Vitest interactive UI |
| `typecheck` | `tsc --noEmit` | Type-check without emitting output |

---

## 7. Daily developer workflow

1. `npm run dev` — start the local server, open the printed URL in Chromium.
2. `npm run test:watch` in a second terminal — tests re-run on every save.
3. Before pushing: `npm run typecheck && npm test` must be green.
4. CI (later) runs `typecheck`, `test`, and `build` on every PR.

---

## 8. TypeScript conventions

- `strict: true` in `tsconfig.json`. Additionally enable `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Identifiers in English. Variables and functions in `camelCase`. Classes in `PascalCase`. Filenames in `kebab-case`. Constants in `UPPER_SNAKE_CASE`.
- All public types live in `src/domain/types.ts`. Repositories and UI modules import from there; they do not redefine types.
- Comments are short, English, and only when the *why* is non-obvious. Prefer self-explanatory names.

---

## 9. Browser support

- **Primary:** the latest two stable Chromium-based browsers (Chrome, Edge).
- **Best effort:** Firefox.
- **Not a priority for MVP:** Safari. (Some IndexedDB / persistent-storage quirks differ on Safari; we will revisit if needed.)

---

## 10. Testing strategy

| Test layer | Tool | What it covers |
|---|---|---|
| Unit | Vitest (Node) | Pure domain logic: pricing priority, bulk allocation, completion math, validators |
| Schema / migrations | Vitest + `fake-indexeddb` | Open the database, apply migrations, assert object stores and indexes |
| Backup round-trip | Vitest + `fake-indexeddb` | Export → wipe → import → assert byte-for-byte equivalent state |
| Smoke | Vitest + `jsdom` | App boots, renders the dashboard shell, no console errors |

UI snapshot tests and end-to-end browser tests are not MVP. They may be added later if real bugs slip through the lower layers.

---

## 11. Code review and quality gates

- Every PR is reviewed before merge — see [PR_RULES.md](PR_RULES.md).
- `typecheck`, `test`, and `build` must all pass locally before opening the PR.
- The PR description must include a "User data impact" line and a "Backup/restore impact" line.
- Hooks (pre-commit, pre-push) are optional in MVP. If added, they must run `typecheck` and `test` and may not be skipped via `--no-verify` without an explicit reason in the PR.
