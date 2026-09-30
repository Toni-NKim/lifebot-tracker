# Habit & Routine Tracker

A single-user, responsive Habit tracker for a Mac mini, Galaxy and Mac browsers. Obsidian Markdown is canonical; SQLite is a disposable statistics/history index. No AI or cloud database is required.

## Development

Requires Node.js 24 LTS and npm.

1. Run `npm ci`.
2. Copy `.env.example` to `.env` and set absolute paths for a **scratch** Obsidian Vault and a separate local state directory. Do not use `tests/fixtures/obsidian-vault` as your working Vault.
3. Run `npm run vault:init` once. It only initializes an empty tracker subdirectory, with Asia/Seoul timezone and Monday weeks. It never overwrites an existing tracker.
4. Run `npm run dev` and `npm run dev:web` in separate terminals.
5. Open `http://127.0.0.1:5173`.

To serve the production frontend locally, run `npm run build`, use `APP_ORIGIN=http://127.0.0.1:3000` in development mode, and run `npm start`. Production remote deployment is documented below.

## Checks

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium webkit
npm run test:e2e
```

Browser tests start their own server with a temporary synthetic Vault. They never read `.env` or a real Vault.

## Maintenance

```sh
npm run vault:validate
npm run index:rebuild
# Explicit deterministic calendar cutoff, if needed:
npm run index:rebuild -- 2026-09-27T12:00:00Z
```

The System screen also validates and rebuilds. Valid external Markdown changes require an explicit rebuild. Missing/invalid source documents are reported without replacing a valid index. If SQLite is deleted, startup recreates it from Markdown. Never repair source data by editing SQLite.

## Product behavior

- All seven recurrence types, Routine inheritance/overrides, exact optional scheduled times.
- Habits can belong to several Routines while sharing one daily completion and streak. For a daily Habit split between weekday evenings and weekends, select both Routines, disable schedule inheritance and choose Every day. Enable Routine time inheritance to use each group's time. Existing membership changes start tomorrow.
- One completion per Habit/day; quantities and duration are optional and do not override declared completion.
- One tap on a Habit's check completes it, saving any details drafted on that card in the same write. Today's details can be edited after completion without changing the completion time. Undo cancels the completion and clears its details. An incomplete record never stores details.
- Only today's execution is editable. Definition changes start tomorrow; existing quota cadence/deactivation/deletion waits for its next week/month.
- Weekly/monthly quota progress is separate from dated completion rates. No daily failures are manufactured for flexible quotas.
- Deletion preserves history. New Habits may start today or a future date.
- History, streaks, daily/weekly/monthly/all-time statistics and a basic heatmap. Dated and quota completion rates are reported separately.
- Writes are crash-safe: after a crash the app recovers its own interrupted commit on restart; changes it did not make still require an explicit rebuild. If the state directory is not writable, changes are refused and viewing still works.
- No offline saving, timers, multiple completions, Routine-level statistics, weekday/time-of-day/trend analytics or Lifebot integration in V1. See the [decisions](docs/decisions.md) for deviations from the PRD.

See [architecture](docs/architecture.md), [storage schemas](docs/storage-schema.md), [decisions](docs/decisions.md), and [Mac mini deployment](docs/deployment.md).
