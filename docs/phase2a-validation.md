# Phase 2A implementation and validation report

Validation date: 2026-10-20 (Asia/Seoul).

## Integration base and scope

Branch: `codex/lifebot-safe-write-foundation`.
Base/dependency: `origin/codex/lifebot-mcp-readonly`,
`1ac944942b097cfc0c6793ac2d39a032834dc596`.
Remote refs were refreshed before choosing the base. V0.1 was not merged into main;
this branch includes that unmerged dependency. No branch was merged. The pre-existing
untracked `audits/` directory was left untouched.

Preflight inspected actual routes, TypeBox contracts, MCP registration, semantic read
projections, browser authentication, Todo/Habit receipts, module-specific ETags, recovery,
locking and tests. Existing single-module APIs support all eight requested operations.
Todo HTTP execution accepts todo_id/anchor_date; the adapter binds and verifies the full
Tracker-provided occurrence target before freezing. It never computes occurrence IDs.

Installed runtime: Node v24.10.0, MCP SDK 1.32.0, Zod 3.25.76, tsx 4.23.15,
TypeScript 7.0.2 (`npm ls @modelcontextprotocol/sdk zod tsx typescript --depth=0`).
No Hermes executable was found on PATH. No actual Hermes run is claimed.

## Implementation and exact contracts

Implemented `capture_inbox`, `create_todo`, `start_todo`, `complete_todo`, `undo_todo`,
`start_habit`, `complete_habit`, `undo_habit`. Every MCP write input is strictly
`{command_id: UUID}` referring to an operator-allocated journal entry. Tool output is the
version-1 `WriteResult` schema in `app/integrations/lifebot/contracts/writes.ts`.
Allocation inputs, field limits/defaults, HTTP mappings, outputs and examples are documented
in [Hermes integration](hermes-integration.md#exact-write-contracts-schema-version-1).

The allocation CLI is the intentional architectural adjustment: human approval and
programmatic identity generation happen outside the agent's MCP tool surface. This avoids
assuming Hermes/model memory can preserve a logical operation ID. It is not proof of
human approval against an agent with unrestricted shell access; production is blocked.

The second narrow adjustment is an additive receipt-scoped Habit mutation response:
`data.execution_changes:[{id,habit_id,date}]`, needed for stable identity on a retry after
midnight. Canonical files, recurrence logic, commit-intent/recovery and UI were not changed.

Machine credentials are external 256-bit random bearer secrets with independent read and
operation scopes. Method/route/body allowlists default-deny all maintenance, definition,
recurrence, Project, destructive and planning operations. Machine access requires the
configured loopback Host with no Origin. Browser authentication remains intact.

Journal requests include validated arguments, target, module preconditions, serialized
body and non-secret headers. They are published without overwrite after file fsync and
directory fsync in a separate private scratch temp directory. Attempts/results are separate
append-only files. No credentials, domain state or recovery manifests are stored there.
The journal is durable across process restarts; OS temp cleanup/reboot retention is not
promised. It must not be deleted while an operation is unresolved.

No missing-version fallback, rebasing, automatic retry, offline queue or implicit Plan
preparation exists. Conflicts require review. Retry uses exactly the original command ID,
HTTP request and ETag. Unknown results are never compensated by a new command.
Saved acknowledgement means committed; ambiguous transport/server failure means unknown.
Recognized pre-commit rejection means rejected. Pending is reserved in the schema; these
single-module operations do not produce staged pending actions.

## Files changed

- `app/integrations/lifebot/contracts/writes.ts`: independent strict intent/result/request schemas.
- `app/integrations/lifebot/journal.ts`: private durable transport bookkeeping.
- `app/integrations/lifebot/prepare.ts`: validate observation/target, expand and freeze intent.
- `app/integrations/lifebot/http-client.ts`: authenticated reads and allowlisted exact writes.
- `app/integrations/lifebot/write-config.ts`: explicit scratch-only enablement.
- `app/integrations/lifebot/tools/write-tools.ts`: approved-ID dispatch and result handling.
- `app/integrations/lifebot/mcp/main.ts`, `mcp/server.ts`: optional write tool registration.
- `app/server/machine-auth.ts`, `app/server/api.ts`: machine principal and security hooks.
- `app/server/services/tracker.ts`: receipt-scoped execution identity response.
- `scripts/lifebot-command.ts`, `scripts/lifebot-scratch.ts`, `package.json`: operator workflow.
- `tests/integration/lifebot/boundary.test.ts`, `machine-auth.test.ts`, `write-tools.test.ts`:
  boundary/authentication/write acceptance coverage.
- `tests/support/lifebot-server-worker.ts`: separate Tracker process restart fixture.
- `docs/hermes-integration.md`, `docs/phase2a-validation.md`: contracts, deployment and evidence.

## Commands and results

| Exact command                                                                                                                                                                | Final result                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `npm run typecheck`                                                                                                                                                          | passed, no diagnostics                               |
| `npm run test:lifebot`                                                                                                                                                       | 31 tests passed, 5 files                             |
| `npm test`                                                                                                                                                                   | 201 tests passed, 26 files                           |
| `npm run build`                                                                                                                                                              | passed; existing frontend chunk-size warning remains |
| `npx playwright test tests/e2e/planner.spec.ts tests/e2e/planner-integrity.spec.ts tests/e2e/concurrency.spec.ts tests/e2e/details-modal.spec.ts --project=desktop-chromium` | 36 passed                                            |
| `git diff --check`                                                                                                                                                           | passed                                               |

The initial sandboxed integration run failed to bind local sockets/start SDK subprocesses
(EPERM); rerunning with the required local execution permissions passed. During development,
a filtered TMPDIR difference in MCP subprocesses and stale pooled connections on server
restart were found. The journal now uses the stable real temp root; restart tests explicitly
retain the same request when a connection is uncertain. No automatic retry was added.

## Scratch acceptance evidence

All tests use generated synthetic Vaults and temporary Tracker state. The documented
scratch launcher was started as a subprocess with a temporary random credential. The
operator CLI allocated approved stdin JSON; a write committed via HTTP and was read back.
The launcher shut down and removed its synthetic data. Separate tests used the actual
stdio MCP executable and official SDK client for tool discovery, structured writes and
adapter restart. A separate Tracker process was started against retained synthetic
storage and replayed an existing command receipt without duplicate capture.

Coverage includes valid/invalid/revoked/read-only credentials; forbidden routes; production
browser Host/owner protection; distinct identical-title captures; repeated and concurrent
same-ID delivery; payload mismatch; original-request preservation; stale Todo/Habit and
wrong-module versions; competing browser writes; no rebase; missing journal dispatch
prevention; lost responses after commit; timeout/reset uncertainty; no refresh dependency;
failed result journaling; recurring/rescheduled targets; Todo start/complete/Undo; Habit
start/detail preservation/explicit-null clearing/Undo; historical-day locks and Seoul
midnight; stable replay identity after midnight; no implicit Timebox changes; credentials
and diagnostic redaction; strict HTTP/storage boundaries; unchanged read-only regressions.
The four outcome values are schema-supported, but staged pending behavior is not claimed
as tested or implemented: it belongs to Phase 2B.

## Deployment limits and next decisions

Windows target is Node 24 inside WSL2, with Tracker, allocator and adapter in the same
Linux environment and journal on a local Linux filesystem. WSL2/native Windows were not
run here. Native Windows fsync/hard-link semantics are not an acceptance-tested target.
No macOS-only domain behavior or committed user-specific paths were introduced.

Production remains blocked pending machine-principal lifecycle/transport review, persistent
private journal retention, an OS-enforced approval boundary and isolation preventing Hermes
from directly accessing Vault/state/secrets or invoking the allocator. These are production
rollout decisions, not reasons to weaken this scratch implementation. Real Hermes runtime
acceptance also remains required. No additional Phase 2A domain feature is blocked.

Phase 2B should first supply reviewable staged-action inspection/resume/cancel and recovery
acceptance tests. Then specify narrowly scoped Plan create/move/cancel and Inbox→Todo→Plan
operations with explicit cross-module observations and approval. No Phase 2B work started.

## Explicit safety status

- Actual personal Vault data accessed: **no**.
- Machine authentication implemented: **yes**, enabled only for temporary scratch acceptance;
  no persistent production principal configured.
- Write tools disabled by default: **yes**, the default remains eight read tools.
- Production write capability enabled: **no**; production machine configuration is rejected.
- Existing V0.1 read DTOs/behavior changed: **no**; optional bearer authentication was added.
- Branch merged: **no**.
