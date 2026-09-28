# Canonical storage contract — version 1

Runtime schemas and TypeScript types: `app/shared/contracts/index.ts`. Complete, parseable examples: `tests/fixtures/obsidian-vault/Life/HabitTracker/`. All example records are synthetic. The original PRD is unchanged.

## Layout

Under the explicitly configured external Vault, `Life/HabitTracker/` contains `Tracker.md`, `Habits/<uuid>/<revision padded to six digits>.md`, `Routines/<uuid>/<revision>.md`, `Daily/YYYY/MM/YYYY-MM-DD.md`, and `Commits/<command-uuid>.md`. Database, the `accepted-source` marker, locks and runtime logs are disposable; the lock is adjacent to the tracker directory to coordinate different processes configured for the same Vault.

Every document starts with YAML frontmatter between `---` lines. UTF-8, LF, YAML 1.2, no aliases or duplicate keys. The body is a readable presentation only. Strings written by the serializer are quoted. Application writes preserve complete structured values, not Markdown checkbox interpretations. Unknown properties and schema versions are rejected.

## Scalars

IDs: UUID strings. Dates: real ISO calendar dates `YYYY-MM-DD`. Instants: UTC RFC 3339 ending in `Z`. Time: `HH:mm` or null. Durations: nonnegative integer seconds or null. Amounts: nonnegative decimal strings or null; definition targets must be positive and have a unit. Status: `completed | incomplete`. Every nullable field is present. All documents have `schema_version: 1` and a discriminating `kind`.

## Tracker

`kind: tracker`, `id`, `created_at`, `tracking_started_on`, `timezone`, `week_starts_on: monday`. Tracker ID, timezone and calendar configuration are fixed after initialization. No migration is performed implicitly.

## Definition revision envelope

Both Habits and Routines contain `id`, positive integer `revision`, `command_id`, stable `created_at`, `recorded_at`, and `effective_from`. Revisions are full snapshots. For a date, choose the greatest effective date not after that date, then the highest revision at that effective date. Only files referenced by a valid definition commit manifest are visible.

### Habit fields

`kind: habit`, `name`, `description`, `active`, `deleted`, `parent_routine_id`, optional `routine_ids`, `schedule`, `scheduled_time`, `minimum_duration_seconds`, `target_amount`, `unit`.

`routine_ids: UUID[]` is the authoritative membership list when present; IDs must be unique and reference Routines available at the effective date. An empty array means no membership. For older version-1 files without this field, membership is `[parent_routine_id]` or `[]` when null. Reading/rebuilding never rewrites older files.

`parent_routine_id` now identifies the source of inherited defaults and must belong to `routine_ids` when the list is present. It may be null for a Habit with entirely explicit settings and multiple memberships. Changing membership does not union or intersect schedules: the Habit retains one cadence. New revisions preserve all memberships unless explicitly removed.

Schedule binding: `{ mode: explicit | routine, source_routine_revision: positive integer | null, rule: Schedule }`.

Time binding: `{ mode: explicit | routine, source_routine_revision: positive integer | null, value: HH:mm | null }`.

Explicit bindings have null provenance. Routine bindings require a defaults source and exact matching Routine revision; the stored resolved value must match that revision. Schedule and time inherit independently. Deleted Habits must be inactive. Membership is authoritative here, not in Routine ordering.

Today returns one item per eligible Habit, with `routine_contexts` for its member Routines scheduled that day. The frontend displays the shared item in each context without duplicating counts or writes. Each context uses that Routine's current time when time inheritance is enabled, otherwise the Habit time. If no member Routine is scheduled, the Habit remains available ungrouped with its stored fallback time. Routine quotas are grouping availability, not additional Habit quota targets.

### Schedule union

| type              | Additional fields                                           |
| ----------------- | ----------------------------------------------------------- |
| daily             | none                                                        |
| weekdays          | none                                                        |
| weekends          | none                                                        |
| selected_weekdays | `weekdays`: nonempty sorted unique ISO weekday integers 1–7 |
| weekly_quota      | `count`: integer 1–7                                        |
| monthly_quota     | `count`: integer 1–31                                       |
| every_n_days      | `interval_days`: positive integer; `anchor_date`: date      |

No fields from other variants are allowed. Native quota targets are adjusted only for first partial periods and short months. Cadence/deactivation/deletion changes of existing quotas take effect at the next native boundary.

### Routine fields

`kind: routine`, `name`, `description`, `deleted`, `schedule: Schedule`, `scheduled_time: HH:mm | null`, `habit_order: UUID[]` (unique). Ordering references known Habits, but can contain former members; only effective members display. Members omitted from ordering append by creation timestamp then ID. Deleting a Routine atomically removes that membership from effective/future members while preserving other memberships and pending edits. Only when the deleted Routine supplied defaults are resolved inherited values frozen as explicit settings.

## Daily record

`kind: daily_execution`, `tracker_id`, `date`, `timezone`, positive integer `revision`, `created_at`, `updated_at`, `executions: Execution[]`, `receipts: Receipt[]`.

Each execution has `id`, `habit_id`, `habit_revision`, `routine_id`, `routine_revision`, `slot: 1`, `status`, `completed_at`, `recorded_at`, `updated_at`, `duration_seconds`, `target_amount`, `actual_amount`, `unit`, `difficulty_or_quality`, `energy_note`.

Execution cardinality is unchanged by multiple memberships. Legacy `routine_id`/`routine_revision` snapshot the defaults Routine, not the particular card clicked. All memberships are recoverable through the exact `habit_revision`; the one execution is shared across those contexts.

Execution ID is UUIDv5 with tracker ID namespace and name `<habit-id>/<date>/1`. Exactly one per Habit/day in MVP. Definition references, targets and units must match the effective definition. Completion timestamp is non-null iff completed. Execution timestamps belong to the document's local day. An incomplete execution carries no completion details: duration, actual amount, difficulty/quality and energy note are null, like `completed_at`. The execution command rejects incomplete writes with details; details entered before completion are client draft state only. Existing files that predate this rule remain readable. A current-day undo clears completion time and details; re-completion records a new time. Editing the details of a completed execution retains its completion time. Missing execution is an implicit incomplete scheduled occurrence, not missing source state.

Receipt: `{ command_id, request_sha256, applied_revision }`. Command IDs are globally unique across daily receipts and definition manifests. Identical retries return current canonical state without creating another execution or changing timestamps. Reusing a command ID with different input is an error.

## Definition commit

`kind: definition_commit`, `id` (command UUID), `recorded_at`, `request_sha256`, `files` (unique relative definition paths). Write all new immutable revisions, flush, then atomically write/flush this manifest. Every reference must exist and identify the same command. Orphan revisions are ignored and reported. Manifests are commit markers, not cryptographic signatures.

## SQLite projection

Schema is explicit in `app/server/index/sqlite/index.ts`. Source tables retain normalized identities, versions, references, contexts and source hashes. Derived occurrence and quota tables contain query-ready rows. `data_json` columns retain the complete projected row for lossless query hydration, not independent state. Index metadata records schema/projector version, source fingerprint, cutoff, and streak-series metadata.

Index schema/projector version 2 adds `habit_routines(habit_id, habit_revision, routine_id)` with a composite primary key and foreign keys to Habit versions and Routines. Both legacy single membership and explicit membership lists project into this table. Startup rebuilds older indexes from Markdown; canonical schema version 1 remains readable without migration.

For MVP, post-command projection uses the same complete rebuild routine as the maintenance command. This intentionally avoids a second incremental algorithm until profiling justifies one. Rebuild constructs a separate database, validates foreign keys/integrity, rechecks sources, then replaces the old index. Source documents are never changed. A cutoff determines calendar visibility; the mutable daily schema does not provide historical intraday replay of prior edits.

## Durability and authority

Only today's daily file may be replaced through the API. Definitions append future-effective revisions. Atomic file replacement and a shared Vault writer lock prevent partial writes/lost updates. A source fingerprint is the optimistic concurrency token. After every app write or explicit rebuild, the accepted fingerprint is recorded in `accepted-source` in the state directory, before indexing, so an index failure or a restart is not mistaken for an external edit (installs without the marker fall back to the index metadata). Unexpected external edits block normal use until explicit validation/rebuild, including a rebuild from the CLI while the server runs. A crash between the Markdown commit and recording the marker still requires one explicit rebuild. The owner can edit historical Markdown directly; rebuilding then honors valid source content.

The app never reconstructs missing Markdown from SQLite. Source backup/restore is the recovery strategy; rebuilding the index is not a backup.
