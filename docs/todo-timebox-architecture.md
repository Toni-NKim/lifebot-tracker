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

## Implemented V1 domains and API

Todo collections are `Inbox`, `Todos`, `Projects`, `Occurrences`, `Executions`, `Actions`, and `PlanningActions`. Timebox collections are `Plans`, `Days`, and `Actual`. All use the immutable revision/manifest protocol above. Occurrence UUIDs derive from module UUID + Todo UUID + original recurrence date (`single` for a nonrecurring item). Execution UUIDs derive from that occurrence. Rescheduling changes do_date/due_at without changing identity. Calendar recurrence edits apply from tomorrow; switching single ↔ recurring requires a new Todo. Completed snapshots remain historical; open snapshots follow workflow metadata. Planning materializes only the selected Todo occurrences before publishing their Plans. A durable `PlanningActions` record carries the exact target proposal and command identity, so interrupted placement/preparation can resume without re-evaluating the recurrence or generating future occurrences. Inbox planning materializes its single occurrence in the same source commit.

The module indexes retain all records, a current-records view, commits, source hashes and metadata. Domain projections are computed from accepted canonical snapshots rather than treating SQLite as authoritative. Agenda reads refresh each new module index independently; an index failure returns a warning and uses canonical records.

- `/api/v1/todo`: Inbox, priorities/occurrences, Projects and completion history.
- `/api/v1/todo/inbox`, `/inbox/:id/process`, `/items`, `/items/:id`, `/items/:id/execute`, `/items/:id/reschedule`, `/projects`, `/projects/:id`: module-scoped commands.
- `/api/v1/agenda?date=YYYY-MM-DD`: a consistent lock-held read of all three modules, returning separate `versions` tokens plus an aggregate read ETag.
- `/api/v1/timebox/prepare`, `/plans`, `/plans/:id`, `/priorities`, `/actuals`, `/actuals/:id`, `/plans/:id/execute`: Timebox-owned changes. Source-dependent Plan writes include the source versions and use a Timebox If-Match token.
- `/api/v1/timebox/inbox/:id/plan` uses the Todo If-Match token: its source commit processes the Inbox, creates one Todo and records a pending Action. A stable target command creates one Plan. A final Todo commit marks the Action done. Restart reads pending Actions from Markdown. `.../actions/:id/resume` retries the same command; `accept_current: true` explicitly acknowledges changed target state. Merely visiting Today never silently rebases a pending action.
- Habit and Todo execution buttons call their owning endpoints, including the original Habit execution PUT. Timebox stores no copies of those executions. Routine progress reads its shared Habit execution set.

Today preparation freezes automatic Plans once per prepared day. Repeating preparation does not overwrite user movement, cancellation, or completed planning history. Later additions can be placed from the candidate tray. No GET saves Plans, and preparation rejects past dates. A Plan revision preserves its source identity and source revision. Moving it changes only that day's Plan. Timed automatic sources use the original scheduled minute; user placement snaps to 15 minutes. The fallback is 30 minutes, never the Habit minimum.

Actual intervals are unsnapped. Quick completion has no inferred interval. Todo and Manual Actual intervals may span midnight; each day's duration clips the same canonical interval to that local day. Unclosed past Habit sessions remain explicitly unfinished, cannot be edited under the existing day lock, never carry into another Habit day, and contribute no invented final duration. Routine execution has no independent timer. Durations sum distinct executions, not Routine containers; overlapping independent activities remain independent durations.

A late Todo completion still marks its earlier Plan as executed, while the completion count belongs to its actual completion date. Past Todo Undo appends a revision; it does not remove old evidence. The immediate Undo control retains the completion response's ETag, so a refresh cannot silently rebase it over another device's changes.

## Enabling and rollback

1. Preserve a normal backup of the existing Vault and state before deploying this feature branch. The application never migrates or rewrites historical Habit Markdown on startup.
2. Start the new build on this feature branch. `/habits/today` is the existing Habit dashboard, `/` is Today Timebox, and `/todos` is Todo. Existing Habit APIs retain their paths.
3. Explicitly initialize Todo and Timebox from Today/Settings or the maintenance CLI. Each `Module.md` binds to the existing Habit UUID and calendar. Merely reading status cannot create a module. Initialization refuses nonempty canonical roots.
4. Prepare Today to save automatic Plans. Other dates remain free of fabricated automatic history. Partial Inbox planning remains visible as a pending action with replay/review controls.
5. To adopt external Markdown edits, validate the affected module, review its files, then explicitly rebuild that module. Never use another module's rebuild or SQLite edits to repair canonical source. Keep accepted-source and commit-intent together during backup/restore; deleting only the index is safe.
6. To recover from total disposable-state loss, retain the complete canonical module roots (including Commits and Actions); each module can regenerate its index independently. A target Plan committed before a crash is recognized by its canonical command receipt and is never duplicated.

Habit v1 files stay readable without bulk rewriting. New/edited Habit and Routine definitions and newly written daily files use schema v2 (color and nullable Actual timing); the Habit projector is version 3. An older application binary that only understands schema v1 cannot safely read new v2 writes. Binary rollback therefore requires the pre-upgrade backup, or keeping this compatible reader; it must not delete v2 canonical files or strip execution fields. Disabling the Todo/Timebox UI is not a schema downgrade.

## Verification and device acceptance

Tests cover module isolation, accepted-source protection, real SIGKILL around manifest publication, staged interruption before and after the target commit, canonical retry receipts, stale module/dependency ETags, explicit review after target changes, Todo recurrence/denominators, immutable undo, Habit v1/v2 coexistence, shared Routine execution, date locks, midnight clipping, and Markdown-only rebuilds.

Browser tests retain the original Habit concurrency, drafts, Undo and modal keyboard checks at `/habits/today`. New cases cover Inbox → Todo → Plan → Actual → History, editing workflow/Project/recurrence, unsnapped past Manual Actual, responsive overflow, and original Habit execution ownership. Playwright uses Desktop Chromium, Galaxy S9+ emulation, and Desktop WebKit against synthetic Vaults. Emulation is not a claim of acceptance on a physical Galaxy or the user's production Mac mini/Vault; those deployment checks remain an operator step.
