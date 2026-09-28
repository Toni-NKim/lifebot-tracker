# Product decisions

- Asia/Seoul calendar, Monday weeks, timezone fixed after initialization.
- Daily/selected-weekday/weekday/weekend/every-N-day schedules produce dated obligations. Exact time is descriptive, not a deadline.
- Weekly/monthly quotas are flexible; no daily quota failure. One credited completion per date. Excess activity is retained but progress is capped at 100%.
- New Habits start today by default. Existing edits begin tomorrow; quota cadence/deactivation/deletion changes wait for the current quota's next boundary.
- First quota target: `min(activeDays, ceil(N * activeDays / periodDays))`. Short months cap monthly targets to available days.
- A Habit can belong to multiple Routines. Membership belongs to the Habit; each Routine owns its display order. A shared Habit still has one execution, one quota credit and one statistical obligation per eligible day.
- Habit cadence remains independent of grouping. Schedule inheritance uses one explicitly selected defaults Routine; a shared daily Habit should use its own daily schedule. Today shows the Habit in each member Routine scheduled for that date, or ungrouped if none is scheduled. Inherited time follows the displayed Routine; an explicit Habit time (including null) overrides it. The stored resolved default time remains the fallback for ungrouped display.
- Deletion is a tombstone. Routine deletion removes only that membership. Removing the defaults Routine freezes its resolved schedule/time as explicit settings without deleting other memberships. No physical deletion of history.
- The current date is editable; all prior execution fields are locked through the app/API. No backfill. Machine owners can still edit their own Markdown; explicit rebuild accepts valid external changes.
- Completion is user-declared. Duration/actual amount below target do not force failure. No skip status.
- One tap on a Habit's check completes it immediately, saving any details drafted on this device in the same write. Details are optional and never saved on their own before completion. Today's details stay editable after completion without changing the original completion time. An incomplete record has no details; undo removes them.
- Current streak ignores an open incomplete unit and includes an open successful unit provisionally. Closed failure resets. Units are occurrences/weeks/months, never mixed. Reactivation starts a new series.
- Dated completion rates include today and exclude future dates. Quota rates use finalized periods ending in the selected range; live progress stays separate. Zero denominator is null. Aggregate counts, not percentages.
- MVP includes basic amounts/context notes and a date-rate heatmap. Timers, multiple completions, offline sync, detailed weekday/hour/trend analysis and Lifebot stay V2.

## PRD traceability

PRD 3–5,14–16 → Today and management; 6–12 → domain scheduling/statistics; 7 → date-locked commands; 18 → execution context; 19–21 → canonical storage and rebuild; 22 → private deployment; 23–25 → deferred integrations; 26–29 → tests and incremental milestones.
