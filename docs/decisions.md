# Product decisions

## Calendar and scheduling

- Asia/Seoul calendar, Monday weeks, timezone fixed after initialization.
- Daily/selected-weekday/weekday/weekend/every-N-day schedules produce dated obligations. Exact time is descriptive, not a deadline.
- Weekly/monthly quotas are flexible; no daily quota failure. One credited completion per date. Excess activity is retained but progress is capped at 100%.
- New Habits start today by default. Existing edits begin tomorrow; quota cadence/deactivation/deletion changes wait for the current quota's next boundary.
- First quota target: `min(activeDays, ceil(N * activeDays / periodDays))`. Short months cap monthly targets to available days.
- A Habit can belong to multiple Routines. Membership belongs to the Habit; each Routine owns its display order. A shared Habit still has one execution, one quota credit and one statistical obligation per eligible day.
- Habit cadence remains independent of grouping. Schedule inheritance uses one explicitly selected defaults Routine; a shared daily Habit should use its own daily schedule. Today shows the Habit in each member Routine scheduled for that date, or ungrouped if none is scheduled. Inherited time follows the displayed Routine; an explicit Habit time (including null) overrides it. The stored resolved default time remains the fallback for ungrouped display.
- Today lists Routine groups by scheduled time (untimed last), then creation time.
- Deletion is a tombstone. Routine deletion removes only that membership. Removing the defaults Routine freezes its resolved schedule/time as explicit settings without deleting other memberships. No physical deletion of history.

## Completion workflow

- Completion is user-declared. Duration/actual amount below target do not force failure. No skip status.
- **One-tap completion.** Tapping a Habit's check completes it immediately. Details are optional; completion works with none.
- **Details draft.** Details entered before completion (duration, actual amount, difficulty/quality, energy note) are a draft kept only in that browser card. They are never saved on their own. Tapping the check saves the completion and the current draft together in one write.
- **Editing completed details.** On the current day, a completed Habit's details can be changed with Save details. This writes `status: completed` again, and the server keeps the original `completed_at`; only undoing and completing again records a new completion time.
- **Incomplete records carry no details.** A persisted `incomplete` execution has `completed_at`, `duration_seconds`, `actual_amount`, `difficulty_or_quality` and `energy_note` all null. The execution command rejects an incomplete write that carries details with `400 VALIDATION_ERROR`; it never silently drops them. This applies to every client, including a future Lifebot. Existing files written before the rule stay readable.
- **Undo** cancels the completion: the record becomes incomplete without details, and the local draft is emptied in every copy of the Habit. If Undo fails (for example because another device changed the record), nothing is changed and the draft is kept as it was.
- The current date is editable; all prior execution fields are locked through the app/API. No backfill. Machine owners can still edit their own Markdown; explicit rebuild accepts valid external changes.

## Streaks and statistics

- Current streak ignores an open incomplete unit and includes an open successful unit provisionally. Closed failure resets. Units are occurrences/weeks/months, never mixed. Reactivation starts a new series; an inactive or deleted Habit has no current streak but keeps its longest.
- **Dated and quota completion rates are separate.** PRD §12 describes one formula (completed ÷ scheduled occurrences). Dated schedules have scheduled occurrences, but flexible quotas do not have per-day obligations. Therefore statistics report the dated-schedule rate and the weekly/monthly quota rates as separate figures instead of mixing them into one percentage:
  - Dated rates count occurrences in the selected range, include today and exclude future dates.
  - Quota rates use credited ÷ target counts of finalized periods whose end date falls in the range; a week spanning two months counts in the later month. Live (open) periods are shown as progress only.
  - A zero denominator is null. Aggregates are computed from counts, never by averaging percentages.

## Deferred to V2

- **Routine-level statistics.** Today shows each Routine's completed/total count for the day; Routine completion rates, streaks and trends are not in V1 (PRD §13 "if needed").
- **Additional analytics.** Weekday completion rates, time-of-day patterns and per-Habit trend charts are not in V1 (PRD §13 "if possible"). V1 includes the calendar heatmap for dated schedules.
- Timers and Pomodoro, multiple completions per day (the `slot` field is fixed to 1), offline capture and sync, and Lifebot read/write integration.

## Source authority and crash recovery

Obsidian Markdown is the only authority. The state directory holds disposable data: the SQLite index and two small markers.

- **`accepted-source`** records the source fingerprint the app last wrote or explicitly accepted (by rebuild). A difference between the Vault and this fingerprint means a change the app did not make, and blocks use (`EXTERNAL_CHANGE`) until explicit validation/rebuild. For an install that predates the marker, the first start takes the trusted fingerprint from SQLite metadata once and writes the marker immediately (if it cannot, writes are refused until it can); afterwards deleting SQLite alone never resets trust.
- **Only under the Vault lock.** The trusted baseline is determined and the marker is established or replaced only while holding the Vault lock, after re-reading the marker there. A start that cannot acquire the lock writes nothing; the first request that holds the lock starts the service from the current state.
- **`commit-intent.json`** is written before every canonical write. It holds the accepted fingerprint (`from`), the planned files with their SHA-256 in write order, and the resulting fingerprint (`to`).
- **Fail closed.** If the intent cannot be recorded, the write is refused with `503 STATE_UNAVAILABLE` before any Markdown is touched. Reads keep working.
- **One unrecorded acceptance at a time.** If a write is saved but its acceptance cannot be recorded, its intent is kept as the proof. The next mutation first records that acceptance; if it still cannot, the mutation is refused with `503 STATE_UNAVAILABLE` and no Markdown is written. Reads keep working. A pending acceptance is recorded only over the marker it was meant to replace: if another process (for example a CLI rebuild) durably accepts a newer state first, that state is adopted and the pending one is discarded, never written over it.
- **Recovery** (on startup and on every read) accepts a changed source only when the intent's `from` equals the accepted fingerprint and either:
  - the Vault equals `to` (the commit finished; acceptance was interrupted), or
  - the Vault equals `from` plus any subset of the planned definition revisions with no manifest (the commit, or the cleanup of such a commit, was interrupted before the commit became visible). Those revisions are the app's own, verified by hash, and are removed; an interrupted cleanup continues on the next read or start.
- Any other difference, including an external edit next to an interrupted commit, still requires an explicit rebuild. A committed canonical write is never rolled back.
- A rejected command (day lock, conflict) removes its own unreferenced revisions immediately.
- Deleting the whole state directory means the next start trusts the Markdown as it is; that is the documented way to rebuild from Markdown alone.

## Schema versioning policy (V2+)

Every canonical document carries `schema_version` and `kind`. V1 writes version 1 for every kind: `tracker`, `habit`, `routine`, `daily_execution` and `definition_commit`. The optional `routine_ids` field was added inside version 1 during V1 development; after the V1 freeze no field is added or changed under an existing version.

1. **Old documents stay readable.** Every schema version ever written remains readable by every later app version. Schema version 1 documents are supported permanently.
2. **Readers handle old and new.** A new field or a changed meaning requires a new schema version for that document kind. The reader dispatches on `(kind, schema_version)` and normalizes older versions into the current in-memory model with explicit, documented defaults (for example, a version 1 execution is slot 1). A reader rejects versions newer than it understands instead of guessing.
3. **No destructive rewrite.** Loading, validating and rebuilding never modify canonical files. There is no implicit or bulk migration of existing Markdown. Old files keep their version; a Vault normally contains several versions side by side. Past daily files are never rewritten. If a migration ever becomes unavoidable, it must be an explicit, separately run, backed-up command that is validated before and after; it is never performed at startup.
4. **Writers are explicit.** For each kind, the writer produces exactly one current version, listed in `storage-schema.md`. New definition revisions and today's daily file use the current version. Tests keep fixtures of every supported version, and those must load and rebuild identically.

## SQLite layout for multiple modules

- The Habit index rebuild writes a new database file and replaces `tracker.sqlite` as a whole on every write. **Tables of other modules (Todo, Health, Food) must not be added to that file**: each Habit write would erase them.
- **Decision required before V2 starts.** Choose one of:
  - **A. Module-scoped databases (recommended).** One index file per module (for example `habit.sqlite`, `todo.sqlite`), each rebuilt independently from its own canonical Markdown with the current file-replacement method. Cross-tracker analysis opens a read-only connection and `ATTACH`es the module files.
  - **B. One shared database with module-scoped rebuild.** Each module owns prefixed tables and rebuilds only those in a transaction. This replaces whole-file replacement with in-place rebuild and needs per-module metadata and fingerprints.
- **Invariant in either case.** Every module's index is derived and rebuildable from that module's canonical Markdown alone. No module writes another module's tables. Nothing exists only in SQLite. Lifebot reads SQLite read-only and changes data only through app commands that write Markdown.

## Deviations from the PRD

| PRD                                               | V1 behavior                                               | Reason                                                                  |
| ------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| §12 one completion-rate formula                   | Dated and quota rates reported separately                 | Quotas have no per-day obligations; mixing them would distort the rate. |
| §13 Routine statistics ("if needed")              | Per-day Routine count on Today only                       | Deferred to V2.                                                         |
| §13 weekday / time-of-day / trend ("if possible") | Calendar heatmap only                                     | Deferred to V2.                                                         |
| §10 multiple completions (may move to V2)         | One execution per Habit per day; `slot` fixed to 1        | Deferred to V2; the execution ID already includes the slot.             |
| §24 Lifebot edits ("내일부터 …")                  | All definition edits start tomorrow or at the next period | Keeps past and current-day records consistent.                          |

## PRD traceability

PRD 3–5,14–16 → Today and management; 6–12 → domain scheduling/statistics; 7 → date-locked commands; 18 → execution context; 19–21 → canonical storage and rebuild; 22 → private deployment; 23–25 → deferred integrations; 26–29 → tests and incremental milestones.
