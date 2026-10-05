# Lifebot MCP V0.1 — scratch, read-only

The local stdio executable exposes exactly eight read tools. Its transport-independent
`ReadTools` calls `TrackerReader`; the production reader only issues allowlisted HTTP
GET requests to the existing `/api/v1` routes. No Tracker services, canonical schemas,
storage, indexes or recovery implementation are imported by the adapter. No new HTTP
façade, authentication, write tool or command journal is added.

## Run a scratch Tracker

Use Node 24 and `npm ci`. In a terminal at the repository root:

```sh
npm run mcp:scratch
```

This separate operator script initializes and seeds synthetic Habit, Todo and Timebox
modules in an OS temporary directory. It does not read `.env` or a personal Vault. It
listens at `http://127.0.0.1:4317`, holds its calendar clock at startup, and removes its
temporary data on SIGINT/SIGTERM. Set `LIFEBOT_SCRATCH_PORT` to change the port. SIGKILL
can leave the temporary scratch directory behind. The adapter does not initialize it.

The adapter requires both `LIFEBOT_TRACKER_URL` and `LIFEBOT_SCRATCH_ONLY=true`.
Only literal loopback HTTP origins are allowed; remote hosts, credentials, URL paths,
query strings, fragments and redirects are rejected. The flag is an operator assertion,
not proof that any arbitrary loopback service is a scratch service. Use this launcher,
not your production Tracker. No machine credentials or forged Tailscale headers are used.

## Hermes configuration

Add to Hermes `config.yaml`, substituting absolute paths for your Node 24 binary and
checkout. Do not launch the executable with Tracker's `--env-file=.env` option.

```yaml
mcp_servers:
  lifebot:
    command: /ABSOLUTE/PATH/TO/node
    args:
      - /ABSOLUTE/PATH/TO/lifebot-tracker/node_modules/tsx/dist/cli.mjs
      - /ABSOLUTE/PATH/TO/lifebot-tracker/app/integrations/lifebot/mcp/main.ts
    env:
      LIFEBOT_TRACKER_URL: http://127.0.0.1:4317
      LIFEBOT_SCRATCH_ONLY: 'true'
    timeout: 60
```

Hermes owns the stdio subprocess lifecycle. Stdout is exclusively MCP JSON-RPC;
startup diagnostics go to stderr. A manual launch can use `npm run --silent mcp:lifebot`
with those two environment variables. The scratch server runs separately.
See the [Hermes MCP configuration guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).

## Version 1 contracts

The precise runtime schemas are in `app/integrations/lifebot/contracts/tools.ts` and
advertised as JSON Schema through `tools/list`, including output schemas. Inputs reject
unknown fields. All tools accept `offset` (default 0, maximum 100000) and `limit`
(default 50, maximum 200). Each collection is `{items,total,offset,limit}`. In aggregate
results this page applies independently to every collection, including nested membership
lists; it is not a shared global offset. Dates are validated calendar dates; timestamps
are ISO instants. `query` is an optional case-insensitive title substring, at most 200 characters.

| Tool           | Additional inputs                                                                                  | Data                                                       |
| -------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `get_today`    | none                                                                                               | Integrated Today; never prepares Plans                     |
| `get_agenda`   | `date?`                                                                                            | One day's integrated agenda                                |
| `get_habits`   | `view: today \| definitions` (today), `include_pending: boolean` (false), `routine_id?`            | Today executions or current/pending definitions            |
| `get_todos`    | `date?`, `status: open \| next \| waiting \| someday \| completed` (open), `project_id?`, `query?` | Todo occurrences; excludes deleted Todos                   |
| `get_inbox`    | `query?`                                                                                           | Unprocessed captures                                       |
| `get_projects` | `status: active \| archived \| all` (active)                                                       | Project progress                                           |
| `get_history`  | `domain: habit \| todo`, required `from`, `to`                                                     | Scheduled/quota Habit history or currently completed Todos |
| `get_stats`    | `domain: habit`, `from?`, `to?`, `habit_id?`; OR `domain: agenda`, `date?`                         | Existing Habit statistics or daily agenda statistics       |

`include_pending` applies to definitions. Todo `date` is the API's as-of reference date,
not a due-date filter. Todo history is not an event/audit log; undone completions no
longer appear. History date ranges are inclusive and Todo completion dates use Tracker's
timezone. Habit history does not advertise the upstream ignored `habit_id` filter.
Cadence fields are summaries of recurrence type, not editable recurrence definitions.

Every result has `schema_version:"1"`, `status`, Tracker `date`/`timezone`,
adapter `observed_at`, opaque `versions`, optional `agenda_etag`, `observations`,
`data`, `warnings`, `unavailable_modules` and optional `error`. Observation timestamps
are not Tracker execution times. Calendar fields may be null when unavailable; the
adapter never guesses the user's date or timezone. ETags are copied from response bodies
without decoding, hashing or generating identities. Agenda versions come from its
coordinated response. Separate endpoint reads retain separate observation tokens.
Conflicting Habit observations fail with `READ_CHANGED` rather than silently combining them.

Todo `execution_target` is `{todo_id,occurrence_id,anchor_date}` copied from Tracker.
Moving `do_date` does not change that target. Candidate keys and Plan IDs are similarly
opaque. Habit rates remain **percent**, Project completion remains a **fraction**, and
agenda metrics remain seconds/counts. No score, new denominator or inferred Actual is created.

The adapter validates consumed upstream fields independently from Tracker's internal
schemas. Missing fields, wrong types, unknown consumed enum variants and malformed JSON
fail closed with `UPSTREAM_CONTRACT_ERROR` and null data. Additive fields are stripped.
Responses are limited to 8 MiB and requests time out after 10 seconds. No background
polling, auto-retry, ETag-only caching or offline queue is implemented.

An empty successful page has zero items and total 0. Unavailable data is null with an
explicit module issue. `get_today`/`get_agenda` can fall back to independent Habit Today
and Todo reads with `status:"partial"`. They never substitute Habit Today for a historical
day, and never fabricate Timebox data. Other tools return `unavailable` or `error` with
null data. API contract/authentication errors do not become successful aggregate fallback.
Pending actions are read-only summaries; no resume, cancellation or target acceptance occurs.
Upstream diagnostic text is not forwarded because it can contain filesystem paths.

Normal Tracker GETs may refresh their derived indexes or reconcile Tracker-owned interrupted
commits. The adapter neither performs those operations directly nor calls maintenance APIs.
No GET prepares Plans. The scratch deployment's canonical fingerprints are asserted unchanged
by the read-tool integration tests.

## Validation and boundaries

```sh
npm run typecheck
npm run test:lifebot
npm test
npm run build
```

Integration tests use synthetic Vaults and real loopback HTTP. Protocol tests cover discovery,
structured errors and the actual stdio subprocess. Boundary checks prevent adapter imports
outside its directory except the explicitly allowlisted protocol/schema/date libraries;
runtime checks only allow the named GET routes. These checks are code constraints, not an
OS sandbox against an unrestricted agent with shell access.

V0.1 verification: typecheck and build passed; all 188 tests across 24 unit/integration
files passed (including 18 adapter tests). The existing desktop Chromium Planner and
Habit concurrency regressions passed all 16 cases. The documented scratch launcher was
started, queried through the adapter, and shut down successfully. Build retains the
frontend's existing bundle-size warning. The MCP subprocess was tested with the official
SDK client; a live Hermes installation has not been configured or exercised by this change.

Breaking tool changes require a new contract version. Additive upstream storage changes
must not flow automatically into tool output. The MCP SDK and schema dependencies are pinned.

## Before V0.2

Resolve machine authentication/scopes and isolate Hermes from personal Vault/state access.
Add programmatic durable command identity, frozen requests, exact retries, structured write
outcomes/conflicts and application-level pending-action inspection. Preserve original ETags;
never silently rebase. Planning writes require usable staged recovery. This version offers
none of those writes and must not be pointed at a personal production deployment.
