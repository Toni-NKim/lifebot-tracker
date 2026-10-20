# Lifebot MCP V0.2 — scratch safe writes (Phase 2A)

By default, the local stdio executable exposes exactly the original eight read tools. Its transport-independent
`ReadTools` calls `TrackerReader`; the production reader only issues allowlisted HTTP
GET requests to the existing `/api/v1` routes. No Tracker services, canonical schemas,
storage, indexes or recovery implementation are imported by the adapter. Explicit scratch configuration additionally enables eight named write tools using the same HTTP boundary.
Their journal stores transport requests only; it is outside the repository, Vault and Tracker state.

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
not your production Tracker. Machine credentials are optional for reads and required for writes. No forged Tailscale headers are used.

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

## Phase 2A architecture and approval boundary

The verified integration base is `origin/codex/lifebot-mcp-readonly` at
`1ac944942b097cfc0c6793ac2d39a032834dc596`, not main; V0.1 is unmerged.
The adapter still has no Tracker implementation imports, Markdown access, SQLite access,
recurrence calculation, commit-intent handling or domain persistence. Server locking,
receipts and recovery remain authoritative. No frontend or canonical format is changed.
The only domain-response addition is `data.execution_changes: [{id,habit_id,date}]` on
Habit mutation responses, selected by the command receipt. It preserves stable identity
when a lost response is retried after midnight. It does not change execution semantics.

**Deliberate scope adjustment:** allocation is an operator-only CLI, not a generic MCP
write/allocation tool. Hermes is not installed in the development environment; its public
MCP lifecycle documentation does not establish durable business-command identity across
restarts. MCP JSON-RPC request IDs are not durable operation IDs. Therefore an operator
reviews a complete intent and explicitly allocates it with `--approved`. The CLI generates
a UUID, validates Tracker targets and versions, freezes the expanded request, synchronizes
it to disk, then returns the ID. Each MCP write tool takes that ID only. Lost allocation
output is recovered with `list`; do not allocate again because output was lost.

Hermes must not have shell access to this allocator or unrestricted access to the journal,
credentials, Vault or Tracker state in a future production design. `--approved` records
an operator assertion, not an OS-enforced authorization boundary against a local shell
agent. Production machine access is intentionally rejected by the server, and the normal
Tracker launcher does not load the scratch credential configuration. No production
write capability is enabled by this phase.

## Machine authentication and scopes

The scratch launcher accepts a randomly generated 256-bit credential as
`LIFEBOT_MACHINE_TOKEN` (64 lowercase hexadecimal characters), outside the repository.
The adapter sends `Authorization: Bearer …` on reads and writes. The server uses
constant-time comparison, rejects invalid/revoked credentials, and redacts Authorization
from request logs. Credentials never enter request journals or semantic write responses.
No credential or `.env` is read from the repository by the adapter or scratch launcher.

`LIFEBOT_MACHINE_SCOPES` is a comma-separated list, default `read`. Allowed entries:
`read,capture_inbox,create_todo,start_todo,complete_todo,undo_todo,start_habit,complete_habit,undo_habit`.
Grant only necessary operations. Invalid scope configuration fails startup. The server
checks method, exact route and parsed operation body, including `recurrence:null` for
creation and `plan_ref:null` for starts/Todo execution. Maintenance, definitions,
Projects, recurrence edits, rescheduling, deletion and every other route default-deny.
Revocation is available on the server principal; for the environment-configured scratch
launcher, remove/rotate the token and restart it. Old tokens then fail. There is no token
administration HTTP endpoint.

Machine requests must use the configured loopback Host and have **no Origin header**.
Only this authenticated path is exempt from the browser mutation Origin requirement.
Content-Type checks remain enforced. Browser owner, Host and Origin protections remain
in place; production Tailscale identity headers are not fabricated. Loopback without TLS
is permitted for synthetic development only.

## Exact write contracts (schema version 1)

Every enabled MCP write tool has the same strict input:

```json
{ "command_id": "<programmatically allocated UUID>" }
```

No additional fields are accepted. Arbitrary or model-generated IDs cannot dispatch
without a matching persisted request. Reusing an ID with another tool or changed input
is rejected locally. The runtime schemas in
`app/integrations/lifebot/contracts/writes.ts` are authoritative; `tools/list` advertises
strict JSON Schema inputs and outputs. The original eight read DTOs are unchanged.

The **operator allocation inputs**, read as JSON from stdin, are:

| Operation / MCP tool | Required fields beyond expected_versions | Optional fields and defaults        | Existing HTTP mutation                                                    |
| -------------------- | ---------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `capture_inbox`      | `title`                                  | none                                | POST `/api/v1/todo/inbox`                                                 |
| `create_todo`        | `title`                                  | fields below                        | POST `/api/v1/todo/items`                                                 |
| `start_todo`         | `target`                                 | none                                | POST `/api/v1/todo/items/{todo_id}/execute`, action `start`               |
| `complete_todo`      | `target`                                 | `note` (omitted preserves existing) | same, action `complete`                                                   |
| `undo_todo`          | `target`                                 | none                                | same, action `undo`                                                       |
| `start_habit`        | `habit_id`, `date`                       | none                                | POST `/api/v1/days/{date}/habits/{habit_id}/start`                        |
| `complete_habit`     | `habit_id`, `date`                       | completion details below            | PUT `/api/v1/days/{date}/habits/{habit_id}/execution`, status `completed` |
| `undo_habit`         | `habit_id`, `date`                       | none                                | same, status `incomplete`, details null                                   |

All Todo intents require `expected_versions:{todo:"<original token>"}`; all Habit
intents require `expected_versions:{habit:"<original fingerprint>"}`. No other version
keys are accepted. `target` is exactly `{todo_id,occurrence_id,anchor_date}` from Tracker,
with UUID identifiers and nullable ISO calendar anchor date. The allocator verifies all
three against Tracker at the original ETag. HTTP uses the existing todo_id/anchor_date
contract; occurrence_id remains bound in the journal. It is never computed by the adapter.
A rescheduled occurrence retains its anchor and ID. Ambiguous targets require clarification.

`create_todo` optional fields: `description:""`, `workflow_status:"next"` (next/waiting/someday),
`importance:"normal"` (high/normal/low), `project_id:null`, `do_date:null`, `due_at:null`,
`scheduled_time:null`, `estimated_duration_seconds:null`, `recurrence:null`, `color:null`.
Title is 1–200 characters and must contain non-whitespace; description and note are at most
10000 characters. Project IDs must name an existing active Project. Calendar dates must
exist; due_at must be an ISO instant with an offset. do_date is a calendar scheduling date,
not due_at. Time is HH:mm; duration is an integer 0–86400; color is #RRGGBB. Recurrence must
be null; recurrence configuration and arbitrary fields are rejected.

Habit dates must match Tracker today during allocation and execution. Completion details:
`duration_seconds` (nonnegative integer/null), `actual_amount` (nonnegative decimal string,
max 40 characters/null), `difficulty_or_quality` and `energy_note` (max 10000 characters/null).
Omitted values are copied from the original observation and frozen; explicit null clears.
Undo clears completion and timing according to Tracker policy. Start supplies no invented
time and never means complete. There is no implicit Plan creation or prepare_today call.

All results have `schema_version:"1"`, `outcome`, `command_id` (UUID, or null if no valid
command was loaded), and optional `operation`. Committed results return
`entities:[{kind,id,todo_id?,occurrence_id?,habit_id?,date?}]` with Tracker-provided IDs;
kind is inbox_item/todo/todo_occurrence/todo_execution/habit_execution. If the authoritative
saved acknowledgement survives but a response projection is missing, the result remains
committed with an empty entities array; never retry as a fresh operation to obtain an ID.

Failures have `error:{code,category,message,retry,expected_versions,resolution_options}`.
Category is conflict/authorization/validation/transport/unavailable. Retry is
requires_user_review/exact_request_only/never. Resolution options are review_current,
cancel_request, retry_exact as applicable. No raw server messages, stack traces, paths,
recovery manifests, credential values or raw journal contents are returned.

```json
{
  "schema_version": "1",
  "outcome": "rejected",
  "command_id": "<allocated UUID>",
  "operation": "complete_todo",
  "error": {
    "code": "REVISION_CONFLICT",
    "category": "conflict",
    "message": "The request was rejected. Review the original intent and observed versions.",
    "retry": "requires_user_review",
    "expected_versions": { "todo": "<original token>" },
    "resolution_options": ["review_current", "cancel_request"]
  }
}
```

## Journal, concurrency and outcomes

`npm run --silent mcp:command -- init` creates a private `lifebot-commands-*` directory
directly under the real platform temp root (`/tmp` on Unix, resolved through symlinks).
The returned absolute path becomes `LIFEBOT_COMMAND_JOURNAL`; no user-specific path is
hardcoded. The stable Unix root avoids differing TMPDIR inheritance in MCP clients.
Arbitrary repository, Vault and state locations, symlink directories and group/world
accessible journal directories are rejected. Journal files are 0600; directory is 0700.
Only the dedicated journal module imports filesystem APIs inside the adapter.

Allocation stores operation, complete validated/defaulted arguments, target, original
versions, origin, method, path, exact serialized body and all non-secret headers.
A temporary file is fsynced, atomically hard-linked without overwrite, and its directory
fsynced **before dispatch**. Requests never change. Append-only attempt/result files are
also synchronized. A crash after an attempt marker without a result means unknown.
There is no queue, background replay, scheduler or startup mutation. `list` reports only
IDs, operation names and prepared/committed/rejected/unknown status.

Exact retries reuse the ID, method/path, body, headers and original ETag. Authorization is
injected from current configuration, never persisted. Confirmed terminal results are
returned from the journal without issuing another mutation; server receipts independently
protect replay after adapter or Tracker restart. A cached committed result is a historical
acknowledgement, not a new authorized write. Simultaneous delivery uses Tracker locks and
receipts. Different approved allocations always get different IDs even for identical titles.

The allocator may read for validation but requires a caller-supplied original module
version and refuses any mismatch. It never substitutes a new version. A stale write returns
REVISION_CONFLICT with original expected_versions; IDEMPOTENCY_CONFLICT and SOURCE_CHANGED
also require review. A new read is allowed; a replacement requires new operator approval
and a new allocation. Do not allocate a replacement for an unresolved unknown operation.

Outcomes:

- `committed`: existing API's authoritative `data.saved:true`, not HTTP 2xx alone. No
  post-write refresh is performed. A failed refresh/index projection cannot erase this acknowledgement.
- `rejected`: recognized pre-commit application/authentication rejection, or local invalid
  binding. HTTP error status alone does not imply rejection.
- `unknown`: timeout/reset/response loss, malformed acknowledgement, internal failure or
  post-commit ambiguity (including EXTERNAL_CHANGE). Keep the same command. Explicit retry only.
- `pending`: reserved in the versioned result schema for authoritative staged operations.
  None of these eight single-module endpoints creates a staged operation, so this phase
  does not emit pending or interpret arbitrary upstream JSON as a pending acknowledgement.

If a result cannot be journaled after a confirmed server response, return the authoritative
response; the existing attempt marker remains unknown after restart and exact server receipt
replay is safe. If journaling fails before dispatch, no request is sent and the adapter
conservatively reports unknown. Do not repair or delete unresolved journals automatically.
Temp cleanup/reboot may remove a scratch journal: **stop and reconcile; do not recreate
unknown commands**. This is process-restart durability on a local filesystem, not a promise
of retention across OS temp cleanup, disk loss or unsupported network filesystems.

## Scratch acceptance procedure

Use Node 24 in an isolated terminal. These commands print no credential value:

```sh
export LIFEBOT_MACHINE_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export LIFEBOT_MACHINE_SCOPES=read,capture_inbox,create_todo,start_todo,complete_todo,undo_todo,start_habit,complete_habit,undo_habit
export LIFEBOT_TRACKER_URL=http://127.0.0.1:4317
export LIFEBOT_SCRATCH_ONLY=true
export LIFEBOT_ENABLE_WRITES=scratch
export LIFEBOT_COMMAND_JOURNAL="$(npm run --silent mcp:command -- init)"
npm run mcp:scratch
```

In another operator terminal with the same external environment, use the eight read tools
to obtain current module versions and exact targets. Review the intended action with the
user. Pipe the approved JSON (including original expected_versions) into:

```sh
npm run --silent mcp:command -- allocate capture_inbox --approved
```

The CLI reads stdin through EOF and returns a programmatically allocated command_id.
Call MCP `capture_inbox` with just that ID. After response loss, restart the MCP process
with the same journal and call the same tool/ID. Recover IDs using:

```sh
npm run --silent mcp:command -- list
```

Set the same external values in Hermes' stdio subprocess environment; avoid committing
secret-bearing config. Leaving LIFEBOT_ENABLE_WRITES unset exposes only the original eight
read tools. Any other supplied enablement value fails startup. Do not use real Vault data.
The scratch launcher seeds only synthetic modules, binds loopback and removes its data on
clean shutdown. Its clock is fixed at startup; automated tests also cover Seoul midnight.
Stopping/restarting that launcher creates a **new dataset**, not a recovery test. The test
suite separately restarts a Tracker process against preserved synthetic storage to verify
receipt recovery. A new scratch dataset requires new reviewed observations, not reuse of
an unresolved old command.

## Hermes, Windows/WSL2 and Phase 2B prerequisites

The official MCP SDK is pinned at 1.32.0; Zod is 3.25.76. Real stdio SDK sessions exercise
discovery, schema validation and writes/restart. No live Hermes runtime was used. The
[Hermes MCP guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
describes subprocess configuration, discovery and reconnect behavior; it does not replace
application command receipts. Do not assume a model remembers IDs or approvals.

For Windows, run Node 24, Tracker, allocator and MCP adapter inside the same WSL2 Linux
environment. Use Linux filesystem paths and a filesystem supporting fsync/hard links;
do not place journals in a Windows-mounted/shared/network filesystem. Native Windows
filesystem durability and WSL2 deployment have not been acceptance-tested here. The code
contains no MacBook username or macOS-only domain assumptions. Native Windows is not the
supported Phase 2A execution target.

Before production: establish a real machine principal, persistent private journal storage
outside temp/Vault/state/repo, authenticated transport appropriate to deployment, credential
rotation/revocation management, and an OS boundary preventing Hermes from running the
allocator or accessing Vault/state/secrets directly. An agent with the same unrestricted
OS account can defeat application-level boundaries; this phase does not provision isolation.
Production activation requires separate review and code changes, not changing a scratch flag.

Before Phase 2B: provide a reviewable staged-action inspection/resume/cancel path and tests
for cross-module recovery and target-state acceptance. Then separately specify Plan creation,
movement and cancellation, Inbox→Todo→Plan placement and their authorization scopes. None of
those tools, automatic plan preparation, bulk mutations, recurring creation, Health/Food or
coaching is included here. Preserve the original ETags and command identities across stages.
