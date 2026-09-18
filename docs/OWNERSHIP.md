# Ghost Route — Ownership (v1)

Mirrors `PROJECT_BRIEF.md` §50-64. Brief is authoritative on conflicts; this doc only flags risks.

## 1. Confirmed ownership (exclusive)

- **architect:** `docs/SYSTEM_DESIGN.md`, `docs/OWNERSHIP.md`
- **backend:** `server/src/index.ts`, `server/src/jev.ts`, `server/src/services/*.ts`
- **api:** `shared/types.ts`, `server/src/routes/*.ts`, `client/src/lib/api.ts`
- **frontend:** `client/src/App.tsx`, `client/src/main.tsx`, `client/index.html`, `client/src/components/*.tsx`, `client/src/*.css`
- **data:** `server/src/store.ts`, `server/data/*`, `scripts/import-deflock.mjs`
- **test:** `tests/*.test.ts`, `tests/helpers.ts`
- **debug:** `server/src/avoid.ts`, `scripts/repro-avoid.mjs`
- **security:** `server/src/security.ts`, `.env.example`
- **perf:** `server/src/cache.ts`, `client/src/hooks/*.ts`
- **orchestrator only:** `package.json`, `server/package.json`, `client/package.json`, `*/tsconfig.json`, `client/vite.config.ts`

## 2. Proposed adjustment (one)

- `server/src/avoid.ts` is shared in practice: debug owns the algorithm, but backend's routing svc calls it. Propose: **debug owns the file; backend may import but not edit** — avoidance signature changes need debug sign-off. No file move (surgical).

## 3. Shared-file risks + resolver

| # | Risk | Resolver |
|---|---|---|
| 1 | `shared/types.ts` (api-owned) drift vs `lib/api.ts` and server routes | api agent; others open read-only, request changes via orchestrator |
| 2 | Route-response shape touched from both routes/ and jev sides | api approves shape, backend approves scorer; orchestrator breaks ties |
| 3 | `store.ts` seed format vs `import-deflock.mjs` output | data agent owns both ends; backend consumes read-only |
| 4 | `cache.ts` (perf) wrapping OSRM calls backend owns | perf adds cache behind existing function signatures; backend approves |

## 4. Rules

Never touch another agent's files. Missing deps go in your report — orchestrator installs. No edits to orchestrator-owned configs.
