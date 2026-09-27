# Architecture

Accepted implementation baseline: single-user Mac mini application; React/Vite frontend and Fastify API in one production process. TypeScript domain functions calculate schedules, quota periods, streaks and rates without I/O or implicit clock access. The original PRD is unchanged.

## Persistence

The external Obsidian Vault is authoritative. `Tracker.md`, versioned Habit/Routine documents, definition commit manifests and daily execution documents contain all persistent domain state. SQLite is a disposable projection. Commands always commit Markdown first; indexing failure never rolls back an acknowledged canonical write. Database loss is recovered with a full rebuild.

Definition revisions are full snapshots, selected by effective date and then revision. Commit manifests make batches visible only after every referenced file is durable. Daily records use atomic replacement. All writers, including CLI maintenance, share a Vault lock. An API source fingerprint is an optimistic concurrency token; an idempotency key is retained in Markdown. External source edits require explicit validation/rebuild.

## Boundaries

`app/shared/contracts` validates wire and file schemas. `app/shared/domain` contains pure calculations. `app/server/storage/markdown` owns canonical persistence. `app/server/index/sqlite` owns SQL writes. `app/server/services` orchestrates commands. Routes expose services; the browser never accesses the Vault directly.

Production requires an explicit external Vault and local state directory. Test fixtures are synthetic and copied into temporary directories. No real Vault is assumed. Private remote access uses Tailscale Serve with loopback binding, owner allowlisting and same-origin mutation checks. No AI dependency, public hosting, cloud database or SaaS account system.

## Delivery checkpoints

1. Architecture/contracts; 2. tooling; 3. Markdown validation; 4. schedules; 5. quotas/streaks/rates; 6. safe persistence; 7. rebuild; 8. definition API; 9. execution locking; 10. Today; 11. management; 12. history/statistics; 13. maintenance UX; 14. Mac deployment.

Each checkpoint is verified before proceeding. V2: timers, multiple daily completions, offline capture, detailed analytical charts and Lifebot integration. V3: cross-tracker integrations/coaching.
