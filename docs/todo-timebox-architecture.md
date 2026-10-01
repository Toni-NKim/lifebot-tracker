# Todo + Timebox implementation decisions

Phase 0 was approved on 2026-10-01. Work stays on the `todo-timebox-v1` feature branch; architectural milestones are tested and committed separately. Existing Habit canonical files, endpoints and recovery behavior remain compatible.

## Ownership and persistence

- Habit owns Habit/Routine definitions and Habit executions. Routine progress aggregates the same shared Habit executions; V1 has no Routine timer/session.
- Todo owns separate InboxItems, Todos/templates, occurrences, Projects, executions and durable staged-action records. Inbox processing creates Next or Someday Todos, not duplicate Inbox-status Todos.
- Timebox owns immutable Plan history, daily priorities and Manual Actuals. It never owns copies of Habit/Todo execution state.
- Every module owns a separate SQLite projection, source fingerprint, accepted-source marker and commit intent. Keep the existing Habit files at the state root; Todo and Timebox use `state/todo/` and `state/timebox/`. No tables are added to the Habit database for another module.
- Canonical roots are `Life/HabitTracker` (or the existing configured path), `Life/TodoTracker`, and `Life/Timebox`. Roots must not overlap. Initialization is explicit, not a side effect of configuration or reading Today.
- Use the existing per-root Vault locks, acquired in Habit → Todo → Timebox order for combined operations. Within those locks, call lock-held operations without nesting public service locks.
- Keep the legacy Habit fingerprint ETag. New module tokens include module name, canonical module ID and source fingerprint. An aggregate agenda token is not a token for mutating an individual module.
- New module writes use immutable full revisions followed by a commit manifest. Partial revisions are invisible; canonical commit comes before acceptance and derived indexing. State failure before intent refuses writes. A failed acceptance must be settled before replacing its recovery proof.
- Cross-module actions use durable canonical staged records and stable command IDs, not a global transaction. Partial completion is visible and recoverable; a stale dependency requires review rather than blindly rebasing its token.

## Approved product defaults

- A Habit represented in a Routine block is not automatically duplicated as a standalone block. Completion remains shared across contexts.
- Automatic Plan fallback duration is 30 minutes, independently of Habit minimum duration. Users can resize it.
- Recurrence is calendar-based; no completion-relative recurrence, multiple occurrences per day or multiple execution sessions per occurrence in V1. Moving do_date preserves occurrence identity.
- Habit execution keeps its current-day edit lock. An unfinished session is never auto-completed at midnight. Todo and Manual Actual may span midnight; Todo historical Undo preserves revision history.
- Automatic Plans become canonical only when Today planning was actually prepared/confirmed. Do not fabricate saved historical Plans for unused days.
- Project completion denominator includes single Todo items and recurring occurrences due through the reference date, excludes Waiting/Someday and infinite future occurrences.
- Habit Actual timing and colors require versioned schemas. Read v1 permanently without rewriting history; never infer actual timestamps from old durations. UI work follows storage, recovery and version compatibility foundations.

## Milestones

1. Module/state/lock/ETag boundaries.
2. New-module canonical commit/recovery and isolated rebuild foundation.
3. Versioned Habit compatibility and Todo domain, then priorities and Timebox plans.
4. Shared Actual integration, UI, history/statistics and device acceptance.

The baseline implementation and test suite are the compatibility contract. Milestone-specific verification is recorded in each commit.

## New-module canonical protocol

`Module.md` binds a module UUID to its Habit tracker UUID, timezone, Monday week calendar and activation date. New records use registered, strict `(kind, schema_version)` contracts in `<Collection>/<uuid>/<six-digit revision>.md`. Every revision includes module ID, command ID, immutable creation time, recording time and a validated domain payload. `Commits/<command-id>.md` publishes one or more revisions together and persists the request hash for idempotency. Unreferenced revisions are invisible but remain part of the source fingerprint.

Commands validate the full proposal, settle prior acceptance, check the module ETag, write a durable intent, write immutable revisions, recheck both the prior source and prepared revisions, and publish the manifest last. Index failure after canonical success returns a warning and a canonical projection. Exact interrupted commits recover acceptance; unpublished revisions are removed only when all their hashes and the remaining baseline match. Cleanup itself is restartable. Unexpected edits never become trusted through ordinary index rebuilding.

Each module rebuilds only its own SQLite file. Its source index stores source hashes, canonical command receipts, all revisions and a `current_records` view. Readers open short-lived connections because rebuild replaces the database file. Future domain-specific projections require a projector/schema version change. SQLite never supplies missing Markdown.

Unlike legacy Habit installs, new modules have no SQLite-based trust bootstrap. Removing only accepted-source from existing state blocks writes/reads until explicit validation/rebuild. Removing the whole module state directory allows cold recovery from valid Markdown. Corrupt markers can be repaired by explicit rebuild; they are not treated as missing automatically.

## Explicit maintenance

The server may start with Habit alone. Merely constructing module services or visiting status does not initialize new canonical roots. The existing Habit maintenance commands remain Habit-only.

```
npm run module:maintain -- initialize todo
npm run module:maintain -- initialize timebox
npm run module:maintain -- validate todo
npm run module:maintain -- rebuild timebox
npm run module:maintain -- status todo
```

Initialize reads the accepted Habit calendar and refuses a nonempty target directory. New `/api/v1/system/modules` status and `/api/v1/system/modules/:module/{initialize,validate,rebuild}` endpoints retain the existing owner, host and mutation-origin checks. Initial Module.md publication also has a durable intent. There is no generic record-writing HTTP endpoint: domain services must validate commands before using the storage foundation.

Crash tests include real child-process SIGKILL after revision and manifest rename. The parent confirms termination and ages only the synthetic lock's timestamp to simulate the stale-lock interval; production lock behavior is unchanged. These tests cover process interruption, not power-loss hardware guarantees.
