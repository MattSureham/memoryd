# HANDOFF

This file is the canonical collaboration state for this repository. It is designed to let a new human, agent, or subprocess continue the project without access to prior chat history.

## Collaboration Protocol

### Mandatory rules

1. Read this entire file before inspecting or changing the repository.
2. Use repository evidence over assumptions, summaries, model memory, or prior chat.
3. Label material statements as **Confirmed**, **Inferred**, or **Unknown**:
   - **Confirmed** — directly supported by inspected repository evidence or a command that the participant actually ran.
   - **Inferred** — a reasoned interpretation whose premises are cited but which has not been directly verified.
   - **Unknown** — evidence is absent, ambiguous, stale, or has not yet been inspected.
4. Record a verification as passed only when it was actually executed. Include the command, result, date, and relevant environment when useful.
5. Update only self-owned structured state:
   - append a new, attributed entry to **Recent Activity**;
   - append attributed evidence to an existing issue rather than rewriting another participant's evidence;
   - only an issue owner may change that issue's mutable status or resolution fields; an unowned issue may be claimed explicitly;
   - shared snapshots may be updated only as part of a recorded handoff, with evidence and the updating participant identified.
6. Preserve previous participants' evidence, authorship, findings, and activity records. Never silently rewrite or delete them.
7. Record disagreement as new attributed evidence. Do not overwrite the claim being disputed.
8. Keep **Current State** present-tense and independently understandable. Keep historical reasoning in **Recent Activity**.
9. Leave exactly one bounded, immediately actionable item in **Next Action** before finishing.
10. Keep the collaboration history understandable when every participant changes between turns.

### Participant and record identity

- Use a stable participant label when available, such as `human:<name>`, `agent:<product>/<session>`, or `process:<name>`.
- Activity IDs use `ACT-YYYY-MM-DD-NNN`.
- Issue IDs use `COL-NNN`.
- Next-action IDs use `NA-NNN`.
- Archived batches use `ARC-YYYY-NNN`.
- Every new evidence item identifies its author and the repository path, symbol, command output, commit, or other artifact that supports it.

### Updating shared state

1. Read **Current State**, all **Active Issues**, the single **Next Action**, and recent entries.
2. Inspect the referenced repository evidence before relying on it.
3. Perform only the assigned or approved task.
4. Add evidence under the relevant issue. If an issue is new, allocate the next stable `COL-NNN` ID.
5. Update the present-tense snapshot only when evidence changes what is currently accepted.
6. Add a self-authored **Recent Activity** entry at the top of that section.
7. Replace **Next Action** with exactly one bounded successor action, even when the action is to obtain a specific decision.
8. Run proportionate verification and report anything not run as **Unknown**, not as passed.

### Current State versus Recent Activity

- **Current State** is the authoritative, present-tense snapshot: what exists, what is accepted, what remains incomplete, applicable constraints, and verification actually performed.
- **Recent Activity** is an append-only, newest-first evidence log explaining how the repository reached the snapshot.
- A reader should be able to operate the current project using **Current State** without reading the history; the history exists for attribution, decisions, disagreement, and audit.

### Why this schema exists

The snapshot minimizes takeover time; stable issues prevent unresolved findings from disappearing; one next action prevents ambiguous ownership; attributed activity preserves reasoning without contaminating present state; bounded archival keeps this file usable without erasing important evidence.

### Protocol evolution

This protocol may change only through all of the following steps:

1. Propose the change in an attributed **Recent Activity** entry.
2. Explain the motivation.
3. Describe compatibility with existing history and record ownership.
4. Register the proposal as an **Active Issue**.
5. Wait for explicit human approval.
6. After approval, adopt the change in a separate recorded update.

No participant may silently modify the protocol.

## Current State

### Authoritative snapshot

| ID | State | Evidence status | Repository evidence | Last confirmed by |
|---|---|---|---|---|
| `CS-001` | `memoryd` is a private, source-built TypeScript package (`0.1.0`) requiring Node.js 22+ and pnpm. | **Confirmed** | `package.json` (`name`, `version`, `private`, `engines`, `packageManager`) | `agent:codex/bootstrap` |
| `CS-002` | Public runtime surfaces are the embedded `MemoryRuntime`/`MemoryStore`, HTTP `MemoryClient`, `memoryd` daemon, `memory-mcp`, and `memoryctl`. | **Confirmed** | `src/index.ts`, `src/client.ts`, `src/daemon.ts`, `src/mcp/server.ts`, `src/cli.ts`, `package.json` | `agent:codex/bootstrap` |
| `CS-003` | The durable authority is SQLite WAL with AES-256-GCM encrypted payloads, append-oriented SourceEvents, FTS5, scoped ACLs, revisions, idempotency keys, and automatic migrations. Current SQLite schema version is 7. | **Confirmed** | `src/storage/index.ts`, `src/storage/crypto.ts`, `src/storage/schema.ts` (`SCHEMA_VERSION`) | `agent:codex/bootstrap` |
| `CS-004` | Protocol version 1.2 supports risk-aware turn planning, evidence checkpoints, staged recall, object-routed retrieval, source provenance, abstention signals, correction submission, and turn completion. | **Confirmed** | `src/contracts.ts` (`PROTOCOL_VERSION`), `src/runtime.ts`, `schemas/memory-protocol-v1.schema.json` | `agent:codex/bootstrap` |
| `CS-005` | The daemon runs learning and Curator timers; embedded callers must explicitly process queued jobs. Curator jobs are durable, leased, bounded, retryable, auditable, optionally dry-run, and selected actions can be rolled back. | **Confirmed** | `src/daemon.ts` (`startDaemon`), `src/runtime.ts` (`processLearningJobs`, `processMaintenanceJobs`), `src/curator.ts` | `agent:codex/bootstrap` |
| `CS-006` | Claude Code, Codex, MCP, HTTP, hooks, and CLI integration assets exist. English is the default README and Chinese is available in `README.zh-CN.md`. | **Confirmed** | `integrations/`, `src/install.ts`, `README.md`, `README.zh-CN.md` | `agent:codex/bootstrap` |
| `CS-007` | The repository is a local-first MVP, not an internet-facing, strongly isolated multi-tenant or continuously synchronized service. | **Confirmed** | `README.md` sections “Data & security”, “MVP boundaries”, and “Known boundaries”; `src/http/server.ts`, `src/config.ts` | `agent:codex/bootstrap` |
| `CS-008` | Behavioral learning retains a human approval gate; ordinary conversation does not automatically become a confirmed WorldClaim. | **Confirmed** | `src/runtime.ts` (`submitCorrection`, learning pipeline), `README.md` “MVP boundaries” | `agent:codex/bootstrap` |

### Unfinished or constrained

- **Confirmed:** `getSources()` does not currently authorize evidence solely from a same-turn `object_retrieval` trace; see `COL-001`.
- **Confirmed:** the package is private/unpublished and its root export includes low-level internals; see `COL-002`.
- **Confirmed:** generic ANN, automatic arbitrary relation extraction, and a full semantic entailment verifier are absent; see `COL-003`.
- **Confirmed:** strong multi-tenant authentication, built-in TLS, key rotation, automated backups, HA, and rate limiting are absent; see `COL-004`.
- **Confirmed:** automatic lifecycle coverage and several configured quality thresholds are partial; see `COL-005`.
- **Confirmed:** the hook failure spool lacks a continuous retry worker, backoff scheduler, corrupt-entry quarantine, and automatic cleanup; see `COL-006`.
- **Confirmed:** export/import exists, but continuous cross-device synchronization and atomic whole-import semantics do not; see `COL-007`.

### Constraints and invariants

- Raw SourceEvents are authority records and are append-oriented; explicit `forget` is the deletion exception.
- Derived summaries, embeddings, object topology, and FTS indexes must remain rebuildable and traceable to evidence.
- Scope ACLs, snapshot visibility, evidence gates, and source authorization are enforced server-side.
- LLM or self-reflection output is not automatically a confirmed fact or approved Policy.
- Maintenance must remain incremental, bounded, idempotent, audited, retryable, and off the synchronous answer path.
- Protocol changes require the approval process in **Collaboration Protocol → Protocol evolution**.

### Verification actually performed

| Date | Command | Result | Evidence status | Performed by |
|---|---|---|---|---|
| 2026-07-28 | `pnpm typecheck` | Passed | **Confirmed** | `agent:codex/bootstrap` |
| 2026-07-28 | `pnpm test` | 19 files passed; 136 tests passed | **Confirmed** | `agent:codex/bootstrap` |
| 2026-07-28 | `pnpm build` | Passed | **Confirmed** | `agent:codex/bootstrap` |
| 2026-07-28 | `pnpm bench` | Not run during protocol initialization | **Unknown** | `agent:codex/bootstrap` |
| 2026-07-28 | Real Claude Code/Codex end-to-end host exercise | Not run during protocol initialization | **Unknown** | `agent:codex/bootstrap` |

## Active Issues

### `COL-001` — Object-retrieval source authorization mismatch

- **Status:** Open
- **Severity:** Medium
- **Owner:** Unassigned
- **Evidence:**
  - **Confirmed** — `MemoryRuntime.retrieveMemory()` persists authorized refs in a turn trace with `kind: "object_retrieval"` (`src/runtime.ts`). — `agent:codex/bootstrap`
  - **Confirmed** — `MemoryRuntime.assertTurnSourceAccess()` only reads traces whose kind is `"recall"` (`src/runtime.ts`). — `agent:codex/bootstrap`
  - **Confirmed** — `README.md` documents the mismatch, while `docs/architecture.md` describes recall/retrieve traces as authorizing source expansion. — `agent:codex/bootstrap`
- **Current resolution state:** No code change exists. Object retrieval returns raw items inline when selected; callers needing separate expansion must first use staged recall.

### `COL-002` — Public SDK boundary is unstable

- **Status:** Open
- **Severity:** Medium
- **Owner:** Unassigned
- **Evidence:**
  - **Confirmed** — `package.json` is `"private": true` and the root export in `src/index.ts` exposes client, config, contracts, Curator, core, runtime, provider, and storage modules. — `agent:codex/bootstrap`
  - **Confirmed** — `README.md` recommends `MemoryClient` but also requires users to understand lower-level turn, confirmation, source-expansion, and embedded-worker lifecycles. — `agent:codex/bootstrap`
- **Current resolution state:** Protocol 1.2 and `MemoryClient` are the safest current integration boundary; no stable high-level facade or npm release exists.

### `COL-003` — Semantic retrieval and verification are bounded heuristics

- **Status:** Accepted boundary
- **Severity:** Medium
- **Owner:** Unassigned
- **Evidence:**
  - **Confirmed** — the default embedding is local hash-ngram rather than a learned general-purpose ANN index; arbitrary LLM relation extraction is absent. — `src/core/embedding.ts`, `src/core/evolution.ts`, `README.md`; `agent:codex/bootstrap`
  - **Confirmed** — verifier coverage establishes reference resolution, not semantic entailment of an answer. — `src/core/verifier.ts`, `README.md`; `agent:codex/bootstrap`
- **Current resolution state:** The system uses bounded local routing, direct provenance, risk-driven raw expansion, and abstention signals. External semantic judgment remains the caller's responsibility.

### `COL-004` — Production security and operations are incomplete

- **Status:** Open
- **Severity:** High
- **Owner:** Unassigned
- **Evidence:**
  - **Confirmed** — the HTTP server has optional service-wide Bearer authentication but no built-in TLS or per-user authentication. — `src/http/server.ts`, `src/config.ts`; `agent:codex/bootstrap`
  - **Confirmed** — automatic backup, key rotation, HA, and rate limiting are not implemented. — `README.md` “Known boundaries”; `agent:codex/bootstrap`
- **Current resolution state:** Keep deployment on loopback for a single trusted user. Remote or multi-user deployment is unsupported without external controls.

### `COL-005` — Lifecycle and quality automation are partial

- **Status:** Open
- **Severity:** Medium
- **Owner:** Unassigned
- **Evidence:**
  - **Confirmed** — models support episode/semantic/object temperatures, while automatic Curator temperature maintenance currently targets Memory Objects. — `src/contracts.ts`, `src/curator.ts`, `README.md`; `agent:codex/bootstrap`
  - **Confirmed** — some configured quality thresholds are reporting-only or currently unused as action gates. — `src/config.ts`, `src/curator.ts`, `README.md`; `agent:codex/bootstrap`
- **Current resolution state:** Object lifecycle and quality reports work; callers must not assume all configured thresholds automatically block, alert, or archive.

### `COL-006` — Hook failure spool needs a complete background lifecycle

- **Status:** Open
- **Severity:** Medium
- **Owner:** Unassigned
- **Evidence:**
  - **Confirmed** — hook failures enter an encrypted idempotent spool and are replayed on a later SessionStart or explicit CLI request. — `src/adapters/hook.ts`, `src/cli.ts`, `README.md`; `agent:codex/bootstrap`
  - **Confirmed** — no continuous spool worker, backoff scheduler, corrupt-entry quarantine, or automatic cleanup exists. — `README.md` “Degraded behavior”; `agent:codex/bootstrap`
- **Current resolution state:** Replay is manual or opportunistic and sequential.

### `COL-007` — Continuous synchronization is absent

- **Status:** Accepted boundary
- **Severity:** Medium
- **Owner:** Unassigned
- **Evidence:**
  - **Confirmed** — encrypted export/import, revisions, device IDs, conflicts, and tombstones exist. — `src/storage/index.ts`, `src/cli.ts`, tests covering import/export; `agent:codex/bootstrap`
  - **Confirmed** — there is no continuous sync, CRDT, automatic workspace identity remapping, or all-or-nothing whole-import transaction. — `README.md` “MVP boundaries”; `agent:codex/bootstrap`
- **Current resolution state:** Use explicit encrypted export/import and inspect reported conflicts.

## Next Action

### `NA-001` — Resolve `COL-001` without weakening source ACLs

Add a regression test proving that only SourceRefs persisted in the same turn's `object_retrieval` trace can be expanded through `getSources()`, update `MemoryRuntime.assertTurnSourceAccess()` to recognize those refs while retaining turn and scope checks, reconcile the corresponding README/architecture statements, and run `pnpm typecheck && pnpm test && pnpm build`.

**Definition of done:** the new positive case passes, a negative cross-turn or untraced-ref case still returns `SCOPE_DENIED`, all existing tests pass, documentation describes the implemented behavior, and the completing participant records the evidence in `COL-001` plus a new Recent Activity entry.

## Recent Activity

> Append new entries immediately below this note; newest entries remain first. Never edit another participant's entry except to correct an objectively invalid path, symbol, or commit reference, and record that correction in a new entry.

### `ACT-2026-07-28-001` — Initialize persistent collaboration protocol

- **Participant:** `agent:codex/bootstrap`
- **Role:** Primary repository agent / protocol initializer
- **Task:** Initialize the repository-level multi-participant handoff protocol required by `BOOTSTRAP.md`.
- **Context inspected:** full `BOOTSTRAP.md`; `package.json`; `src/index.ts`; `src/client.ts`; `src/config.ts`; `src/contracts.ts`; `src/daemon.ts`; `src/runtime.ts`; `src/storage/schema.ts`; `docs/architecture.md`; README boundaries and integration guidance; current test inventory; recent Git history.
- **Actions performed:** created `HANDOFF.md`; defined evidence, ownership, issue, next-action, activity, archival, and protocol-evolution rules; initialized the authoritative snapshot and seven stable issues; added short collaboration links to both README languages.
- **Files modified:** `HANDOFF.md`, `README.md`, `README.zh-CN.md`. `BOOTSTRAP.md` was supplied by the user and is included without content edits.
- **Findings:**
  - **Confirmed:** repository versions are package `0.1.0`, protocol `1.2`, and SQLite schema `7`.
  - **Confirmed:** `retrieveMemory()` records object-retrieval refs but `getSources()` authorization currently ignores that trace kind.
  - **Confirmed:** the runtime is feature-rich for a trusted local MVP but retains the boundaries registered as `COL-002` through `COL-007`.
- **Verification performed:** `pnpm typecheck` passed; `pnpm test` passed 19 files / 136 tests; `pnpm build` passed on 2026-07-28.
- **Issues created or updated:** created `COL-001` through `COL-007`.
- **Remaining uncertainty:** benchmark targets and real host integration were not exercised in this initialization; their current results are **Unknown**.
- **Recommended next action:** `NA-001`.
- **Migration assumptions:**
  - **Confirmed:** no prior `HANDOFF.md` existed, so there were no authored activity records to migrate.
  - **Confirmed:** `BOOTSTRAP.md` is the authority for this initial schema.
  - **Inferred:** recent Git history and current repository documentation represent useful project evidence, but they do not identify enough participant metadata to create historical activity entries without inventing authorship.

## Archived Summary

### Archival mechanism

When **Recent Activity** reaches 20 detailed entries or materially impairs takeover readability, a participant may propose archiving the oldest consecutive entries while retaining at least the 10 newest entries.

Each archive batch must:

1. use a stable `ARC-YYYY-NNN` ID;
2. list every compressed activity ID, participant, date range, and commit range;
3. preserve major decisions, architectural reasoning, unresolved issues, rejected approaches, disagreements, and necessary evidence references;
4. copy any sole evidence for an active issue into that issue before compression;
5. preserve original authorship and identify the archiving participant;
6. add a new Recent Activity entry describing the archival operation;
7. rely on Git history for the verbatim old entries, never on an uncited summary alone.

Resolved issues may be moved into an archive batch only after their resolution evidence and commit are recorded. Unknowns must remain labeled **Unknown**. Archival must not silently change the collaboration protocol.

### Archive batches

None. This protocol was initialized on 2026-07-28.
