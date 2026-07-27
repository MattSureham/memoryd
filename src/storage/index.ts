import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  type AgentProfile,
  type Contradiction,
  type CorrectionInput,
  type EpisodeMemory,
  type InputEvent,
  type MaintenanceAction,
  type MaintenanceJob,
  type MaintenanceJobStatus,
  type MaintenanceJobType,
  type MemoryObject,
  type MemoryObjectMember,
  type MemoryPartition,
  type MemoryQualityMetrics,
  type MemoryRelation,
  type MemoryTemperature,
  type MemoryVersion,
  type Observation,
  type RetrievalTrace,
  type ScopeRef,
  type SourceEvent,
  type SourceRef,
  type StageGate,
  type TurnPlan,
  type WorldClaim,
} from "../contracts.js";
import {
  canonicalJson,
  decryptJson,
  encryptJson,
  loadOrCreateKey,
  normalizeKey,
  sha256,
} from "./crypto.js";
import { redactSensitiveContent, redactSensitiveValue } from "./redaction.js";
import { migrate, SCHEMA_VERSION } from "./schema.js";
import type {
  AppendSourceEventArgs,
  CalibrationPatternRecord,
  ExportOptions,
  FailureClusterRecord,
  ForgetResult,
  ForgetSelector,
  ImportOptions,
  ImportResult,
  MemoryStoreOptions,
  LearningJobRecord,
  LearningJobType,
  MaintenanceAuditRecord,
  MemoryObjectRouteHit,
  OwnerMetadata,
  PolicyApprovalEligibility,
  ReindexResult,
  EntityOwnerHit,
  SearchHit,
  SearchKind,
  SearchOptions,
  SourceEventListOptions,
  StoredEmbedding,
  SessionLifecycleRecord,
  StorageSearchResult,
  StoredCorrection,
  StoredObservation,
  StoredPolicy,
  StoredTrace,
  StoredTurn,
  StoreHealth,
  TriggerRecord,
  TriggerActivationRecord,
  TurnUpdate,
} from "./types.js";

export * from "./crypto.js";
export * from "./redaction.js";
export * from "./types.js";
export { SCHEMA_VERSION } from "./schema.js";

type Row = Record<string, unknown>;

interface IdempotencyRow extends Row {
  entity_id: string;
  record_hash: string;
}

interface ExportPackage {
  format: "memoryd-export";
  version: 1;
  schemaVersion: number;
  exportedAt: string;
  deviceId: string;
  revision: number;
  records: {
    sourceEvents: Array<{ value: SourceEvent; idempotencyKey: string; originRevision: number }>;
    turns: StoredTurn[];
    observations: StoredObservation[];
    worldClaims: WorldClaim[];
    policies: StoredPolicy[];
    episodes: EpisodeMemory[];
    corrections: StoredCorrection[];
    traces: StoredTrace[];
    triggers: TriggerRecord[];
    failureClusters: FailureClusterRecord[];
    calibrationPatterns: CalibrationPatternRecord[];
    sessions: SessionLifecycleRecord[];
    triggerActivations: TriggerActivationRecord[];
    memoryPartitions?: MemoryPartition[];
    memoryObjects?: MemoryObject[];
    memoryObjectMembers?: MemoryObjectMember[];
    memoryRelations?: MemoryRelation[];
    memoryVersions?: MemoryVersion[];
    contradictions?: Contradiction[];
    memoryTemperatures?: MemoryTemperature[];
    retrievalTraces?: RetrievalTrace[];
    tombstones: Array<Record<string, unknown>>;
  };
}

const OWNER_ID_SEPARATOR = "\u001f";

export class MemoryStore {
  readonly database: Database.Database;
  readonly deviceId: string;

  private readonly key: Buffer;
  private readonly now: () => Date;
  private readonly readonly: boolean;

  constructor(options: MemoryStoreOptions | string) {
    const normalized: MemoryStoreOptions =
      typeof options === "string" ? { path: options } : options;
    this.readonly = normalized.readonly ?? false;
    this.now = normalized.now ?? (() => new Date());
    if (normalized.path !== ":memory:") {
      mkdirSync(dirname(normalized.path), { recursive: true });
    }
    this.key = loadOrCreateKey(normalized.path, normalized.encryptionKey);
    this.database = new Database(normalized.path, { readonly: this.readonly });
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    if (!this.readonly) {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = NORMAL");
      migrate(this.database);
    }

    const storedDevice = this.getMetadata("device_id");
    if (storedDevice && normalized.deviceId && storedDevice !== normalized.deviceId) {
      this.database.close();
      throw new Error(`Configured deviceId ${normalized.deviceId} does not match database deviceId ${storedDevice}`);
    }
    this.deviceId = normalized.deviceId ?? storedDevice ?? randomUUID();
    if (!this.readonly && !storedDevice) {
      this.database
        .prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('device_id', ?)")
        .run(this.deviceId);
    }
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  /** Compose several store operations into one SQLite transaction/savepoint. */
  transact<T>(operation: () => T): T {
    this.requireWritable();
    return this.database.transaction(operation)();
  }

  getRevision(): number {
    return this.getMetadataNumber("revision");
  }

  getIndexRevision(): number {
    return this.getMetadataNumber("index_revision");
  }

  getMemoryGeneration(): number {
    return this.getMetadataNumber("memory_generation");
  }

  appendSourceEvent(args: AppendSourceEventArgs): SourceEvent;
  appendSourceEvent(
    input: InputEvent,
    scope: ScopeRef,
    agent: AgentProfile,
    selectedEvidence?: boolean,
  ): SourceEvent;
  appendSourceEvent(
    argsOrInput: AppendSourceEventArgs | InputEvent,
    optionalScope?: ScopeRef,
    optionalAgent?: AgentProfile,
    optionalSelectedEvidence = false,
  ): SourceEvent {
    const args: AppendSourceEventArgs = "input" in argsOrInput
      ? argsOrInput
      : {
          input: argsOrInput,
          scope: this.required(optionalScope, "scope"),
          agent: this.required(optionalAgent, "agent"),
          selectedEvidence: optionalSelectedEvidence,
        };
    this.requireWritable();
    this.requireSession(args.scope);

    const redactedContent = redactSensitiveContent(args.input.content);
    const redactedAttachments = redactSensitiveValue(args.input.attachments ?? []);
    const redactedMetadata = redactSensitiveValue(args.input.metadata ?? {});
    const redactions = [
      ...new Set([
        ...redactedContent.redactions,
        ...redactedAttachments.redactions,
        ...redactedMetadata.redactions,
      ]),
    ].sort();
    const sanitizedInput = {
      ...args.input,
      content: redactedContent.value,
      attachments: redactedAttachments.value,
      metadata: redactedMetadata.value,
    };
    const requestHash = sha256(canonicalJson({
      input: sanitizedInput,
      scope: args.scope,
      agent: args.agent,
      selectedEvidence: args.selectedEvidence ?? false,
    }));
    const prior = this.lookupIdempotency("append_source_event", args.input.idempotencyKey);
    if (prior) {
      this.assertIdempotencyHash(prior, requestHash, "append_source_event");
      return this.required(this.getSourceEvent(prior.entity_id), "idempotent source event");
    }
    const importedPrior = this.database
      .prepare("SELECT * FROM source_events WHERE idempotency_key = ?")
      .get(args.input.idempotencyKey) as Row | undefined;
    if (importedPrior) {
      const existing = this.decodeSourceEvent(importedPrior);
      const same =
        existing.kind === sanitizedInput.kind &&
        existing.content === sanitizedInput.content &&
        canonicalJson(existing.attachments) === canonicalJson(sanitizedInput.attachments) &&
        canonicalJson(existing.metadata) === canonicalJson(sanitizedInput.metadata) &&
        canonicalJson(existing.scope) === canonicalJson(args.scope) &&
        canonicalJson(existing.agent) === canonicalJson(args.agent) &&
        existing.selectedEvidence === (args.selectedEvidence ?? false) &&
        (sanitizedInput.eventId === undefined || sanitizedInput.eventId === existing.eventId) &&
        (sanitizedInput.occurredAt === undefined || sanitizedInput.occurredAt === existing.occurredAt);
      if (!same) {
        this.versionConflict("Source event idempotency key was reused with different content");
      }
      return existing;
    }

    if (this.hasTombstone("session", args.scope.sessionId)) {
      this.versionConflict(`Session ${args.scope.sessionId} has been forgotten and cannot be reused`);
    }
    if (this.isSessionEnded(args.scope)) {
      this.versionConflict(`Session ${args.scope.sessionId} has ended and no longer accepts events`);
    }

    const eventId = args.input.eventId ?? randomUUID();
    const existingById = this.getSourceEvent(eventId);
    if (existingById) {
      const same =
        existingById.kind === sanitizedInput.kind &&
        existingById.content === sanitizedInput.content &&
        canonicalJson(existingById.attachments) === canonicalJson(sanitizedInput.attachments) &&
        canonicalJson(existingById.metadata) === canonicalJson(sanitizedInput.metadata) &&
        canonicalJson(existingById.scope) === canonicalJson(args.scope) &&
        canonicalJson(existingById.agent) === canonicalJson(args.agent) &&
        existingById.selectedEvidence === (args.selectedEvidence ?? false) &&
        (sanitizedInput.occurredAt === undefined || sanitizedInput.occurredAt === existingById.occurredAt);
      if (!same) this.versionConflict(`Source event ${eventId} already exists with different content`);
      return existingById;
    }
    this.assertNotTombstoned("source_event", eventId);
    const capturedAt = this.isoNow();
    const occurredAt = args.input.occurredAt ?? capturedAt;
    const contentHash = sha256(redactedContent.value);

    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const event: SourceEvent = {
        eventId,
        revision,
        deviceId: this.deviceId,
        scope: args.scope,
        agent: args.agent,
        kind: args.input.kind,
        content: redactedContent.value,
        contentHash,
        capturedAt,
        occurredAt,
        selectedEvidence: args.selectedEvidence ?? false,
        redactions,
        attachments: redactedAttachments.value,
        metadata: redactedMetadata.value,
      };
      const recordHash = sha256(canonicalJson(event));
      this.database.prepare(`
        INSERT INTO source_events(
          event_id, revision, origin_revision, device_id, idempotency_key,
          user_id, workspace_id, session_id, kind, content_hash,
          captured_at, occurred_at, selected_evidence, encrypted_payload, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        revision,
        revision,
        event.deviceId,
        args.input.idempotencyKey,
        args.scope.userId,
        args.scope.workspaceId ?? null,
        args.scope.sessionId,
        event.kind,
        contentHash,
        capturedAt,
        occurredAt,
        event.selectedEvidence ? 1 : 0,
        this.seal("source_event", event.eventId, event),
        recordHash,
      );
      this.database
        .prepare("INSERT INTO source_events_fts(event_id, user_id, workspace_id, content) VALUES (?, ?, ?, ?)")
        .run(event.eventId, args.scope.userId, args.scope.workspaceId ?? null, event.content);
      this.rememberIdempotency(
        "append_source_event",
        args.input.idempotencyKey,
        event.eventId,
        requestHash,
        revision,
      );
      this.touchMemoryScope(event.scope, capturedAt);
      this.touchIndex(revision);
      return event;
    })();
  }

  appendEvent(args: AppendSourceEventArgs): SourceEvent {
    return this.appendSourceEvent(args);
  }

  getSourceEvent(eventId: string, scope?: ScopeRef): SourceEvent | undefined {
    const row = this.database.prepare("SELECT * FROM source_events WHERE event_id = ?").get(eventId) as Row | undefined;
    if (!row) return undefined;
    if (scope) this.assertAcl(row, scope, false);
    return this.decodeSourceEvent(row);
  }

  getSourceEvents(refs: readonly SourceRef[], scope?: ScopeRef): SourceEvent[] {
    return refs.map((ref) => {
      const event = this.getSourceEvent(ref.eventId, scope);
      if (!event) this.notFound(`Source event ${ref.eventId} was not found`);
      this.assertSourceRef(ref, event);
      return event;
    });
  }

  listSourceEvents(scope: ScopeRef, options: SourceEventListOptions = {}): SourceEvent[] {
    const maxRevision = Math.min(options.maxRevision ?? this.getRevision(), this.getRevision());
    const limit = Math.max(1, Math.min(options.limit ?? 200, 5_000));
    const kinds = options.kinds ?? [];
    if (kinds.length > 0) {
      const positionalRows = this.database.prepare(`
        SELECT * FROM source_events
        WHERE ${this.aclSql(false)} AND revision <= @maxRevision
          AND kind IN (${kinds.map((_, index) => `@kind${index}`).join(", ")})
        ORDER BY occurred_at DESC, revision DESC, event_id DESC
        LIMIT @limit
      `).all({
        ...this.aclParams(scope),
        maxRevision,
        limit,
        ...Object.fromEntries(kinds.map((kind, index) => [`kind${index}`, kind])),
      }) as Row[];
      return positionalRows.map((row) => this.decodeSourceEvent(row));
    }
    const rows = this.database.prepare(`
      SELECT * FROM source_events
      WHERE ${this.aclSql(false)} AND revision <= @maxRevision
      ORDER BY occurred_at DESC, revision DESC, event_id DESC
      LIMIT @limit
    `).all({ ...this.aclParams(scope), maxRevision, limit }) as Row[];
    return rows.map((row) => this.decodeSourceEvent(row));
  }

  getSources(refs: readonly SourceRef[], scope?: ScopeRef): SourceEvent[] {
    return this.getSourceEvents(refs, scope);
  }

  toSourceRef(event: SourceEvent): SourceRef {
    const ref: SourceRef = {
      eventId: event.eventId,
      sessionId: this.required(event.scope.sessionId, `session for event ${event.eventId}`),
      contentHash: event.contentHash,
      capturedAt: event.capturedAt,
    };
    if (event.scope.workspaceId !== undefined) ref.workspaceId = event.scope.workspaceId;
    if (event.scope.commit !== undefined) ref.commit = event.scope.commit;
    const path = event.metadata.path;
    if (typeof path === "string") ref.path = path;
    return ref;
  }

  createTurn(plan: TurnPlan, scope: ScopeRef, idempotencyKey = `turn:${plan.turnId}`): StoredTurn {
    this.requireWritable();
    const sanitized = redactSensitiveValue(plan).value;
    const planSources = this.sourceRefsInValue(sanitized);
    this.assertSourceRefs(planSources, scope);
    const requestHash = sha256(canonicalJson({ plan: sanitized, scope }));
    const prior = this.lookupIdempotency("create_turn", idempotencyKey);
    if (prior) {
      this.assertIdempotencyHash(prior, requestHash, "create_turn");
      return this.required(this.getTurn(prior.entity_id), "idempotent turn");
    }
    const existing = this.getTurn(plan.turnId);
    if (existing) {
      if (canonicalJson({ plan: existing.plan, scope: existing.scope }) !== canonicalJson({ plan: sanitized, scope })) {
        this.versionConflict(`Turn ${plan.turnId} already exists with different content`);
      }
      return existing;
    }
    this.assertNotTombstoned("turn", plan.turnId);
    const timestamp = this.isoNow();
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const stored: StoredTurn = {
        turnId: plan.turnId,
        revision,
        scope,
        plan: sanitized,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.database.prepare(`
        INSERT INTO turns(
          turn_id, revision, user_id, workspace_id, session_id, agent_profile_key,
          snapshot_revision, gate_satisfied, retry_count, status, created_at,
          updated_at, encrypted_plan, record_hash, branch, commit_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        stored.turnId,
        revision,
        scope.userId,
        scope.workspaceId ?? null,
        scope.sessionId ?? null,
        sanitized.agentProfileKey,
        sanitized.snapshotRevision,
        sanitized.gate.satisfied ? 1 : 0,
        sanitized.retryCount,
        stored.status,
        timestamp,
        timestamp,
        this.seal("turn", stored.turnId, sanitized),
        sha256(canonicalJson(stored)),
        scope.branch ?? null,
        scope.commit ?? null,
      );
      this.rememberIdempotency("create_turn", idempotencyKey, stored.turnId, requestHash, revision);
      this.linkSources("turn", stored.turnId, planSources);
      return stored;
    })();
  }

  getTurn(turnId: string, scope?: ScopeRef): StoredTurn | undefined {
    const row = this.database.prepare("SELECT * FROM turns WHERE turn_id = ?").get(turnId) as Row | undefined;
    if (!row) return undefined;
    if (scope) this.assertAcl(row, scope, true);
    return this.decodeTurn(row);
  }

  ensureSession(scope: ScopeRef & { sessionId: string }, startedAt = this.isoNow()): SessionLifecycleRecord {
    this.requireWritable();
    const existing = this.getSession(scope.sessionId, scope);
    if (existing !== undefined) return existing;
    this.assertNotTombstoned("session", scope.sessionId);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const record: SessionLifecycleRecord = {
        scope,
        status: "active",
        startedAt,
        revision,
      };
      this.database.prepare(`
        INSERT INTO session_lifecycle(
          session_id, revision, user_id, workspace_id, status, started_at,
          ended_at, end_idempotency_key, record_hash
        ) VALUES (?, ?, ?, ?, 'active', ?, NULL, NULL, ?)
      `).run(
        scope.sessionId,
        revision,
        scope.userId,
        scope.workspaceId ?? null,
        startedAt,
        sha256(canonicalJson(record)),
      );
      return record;
    })();
  }

  getSession(sessionId: string, scope?: ScopeRef): SessionLifecycleRecord | undefined {
    const row = this.database.prepare("SELECT * FROM session_lifecycle WHERE session_id = ?").get(sessionId) as Row | undefined;
    if (row === undefined) return undefined;
    if (scope !== undefined) this.assertAcl(row, scope, false);
    const record: SessionLifecycleRecord = {
      scope: {
        ...this.scopeFromRow(row),
        sessionId,
      },
      status: String(row.status) as SessionLifecycleRecord["status"],
      startedAt: String(row.started_at),
      revision: Number(row.revision),
    };
    if (typeof row.ended_at === "string") record.endedAt = row.ended_at;
    if (typeof row.end_idempotency_key === "string") record.endIdempotencyKey = row.end_idempotency_key;
    return record;
  }

  endSession(
    scope: ScopeRef & { sessionId: string },
    idempotencyKey: string,
    endedAt = this.isoNow(),
  ): SessionLifecycleRecord {
    this.requireWritable();
    const existing = this.getSession(scope.sessionId, scope);
    if (existing?.status === "ended") return existing;
    const started = existing ?? this.ensureSession(scope, endedAt);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const record: SessionLifecycleRecord = {
        ...started,
        scope,
        status: "ended",
        endedAt,
        endIdempotencyKey: idempotencyKey,
        revision,
      };
      this.database.prepare(`
        UPDATE session_lifecycle SET revision = ?, status = 'ended', ended_at = ?,
          end_idempotency_key = ?, record_hash = ? WHERE session_id = ?
      `).run(revision, endedAt, idempotencyKey, sha256(canonicalJson(record)), scope.sessionId);
      return record;
    })();
  }

  isSessionEnded(scope: ScopeRef & { sessionId: string }): boolean {
    return this.getSession(scope.sessionId, scope)?.status === "ended";
  }

  listTurns(
    scope: ScopeRef,
    options: { includeAllSessions?: boolean; maxRevision?: number; limit?: number } = {},
  ): StoredTurn[] {
    const rows = this.database.prepare(`
      SELECT * FROM turns
      WHERE ${this.aclSql(!options.includeAllSessions)} AND revision <= @maxRevision
      ORDER BY created_at DESC, revision DESC, turn_id DESC
      LIMIT @limit
    `).all({
      ...this.aclParams(scope),
      maxRevision: Math.min(options.maxRevision ?? this.getRevision(), this.getRevision()),
      limit: Math.max(1, Math.min(options.limit ?? 100, 2_000)),
    }) as Row[];
    return rows.map((row) => this.decodeTurn(row));
  }

  updateTurn(turnId: string, patch: TurnUpdate): StoredTurn {
    this.requireWritable();
    return this.database.transaction(() => {
      const current = this.getTurn(turnId);
      if (!current) this.notFound(`Turn ${turnId} was not found`);
      let plan = patch.plan ? redactSensitiveValue(patch.plan).value : current.plan;
      if (patch.gateSatisfied !== undefined) {
        const gate: StageGate = { ...plan.gate, satisfied: patch.gateSatisfied };
        plan = { ...plan, gate };
      }
      if (patch.retryCount !== undefined) plan = { ...plan, retryCount: patch.retryCount };
      const revision = this.nextRevision();
      const updatedAt = this.isoNow();
      const stored: StoredTurn = {
        ...current,
        revision,
        plan,
        status: patch.status ?? current.status,
        updatedAt,
      };
      this.database.prepare(`
        UPDATE turns SET revision = ?, agent_profile_key = ?, snapshot_revision = ?,
          gate_satisfied = ?, retry_count = ?, status = ?, updated_at = ?,
          encrypted_plan = ?, record_hash = ? WHERE turn_id = ?
      `).run(
        revision,
        plan.agentProfileKey,
        plan.snapshotRevision,
        plan.gate.satisfied ? 1 : 0,
        plan.retryCount,
        stored.status,
        updatedAt,
        this.seal("turn", turnId, plan),
        sha256(canonicalJson(stored)),
        turnId,
      );
      return stored;
    })();
  }

  addObservations(turnId: string, observations: readonly Observation[]): StoredObservation[] {
    this.requireWritable();
    return this.database.transaction(() => {
      const turn = this.getTurn(turnId);
      if (!turn) this.notFound(`Turn ${turnId} was not found`);
      const results: StoredObservation[] = [];
      for (const observation of observations) {
        const sanitized = redactSensitiveValue(observation).value;
        const observationId = sanitized.observationId ?? randomUUID();
        const payloadHash = sha256(canonicalJson(sanitized));
        const existing = this.database
          .prepare("SELECT * FROM observations WHERE observation_id = ?")
          .get(observationId) as Row | undefined;
        if (existing) {
          if (String(existing.record_hash) !== payloadHash) {
            this.versionConflict(`Observation ${observationId} already exists with different content`);
          }
          results.push(this.decodeObservation(existing));
          continue;
        }
        this.assertNotTombstoned("observation", observationId);
        if (sanitized.source?.eventId) this.validatePartialSource(sanitized.source, turn.scope);
        const revision = this.nextRevision();
        const createdAt = this.isoNow();
        const stored: StoredObservation = {
          ...sanitized,
          observationId,
          turnId,
          revision,
          contentHash: sha256(sanitized.content),
          createdAt,
        };
        this.database.prepare(`
          INSERT INTO observations(
            observation_id, revision, turn_id, user_id, workspace_id, session_id,
            kind, content_hash, created_at, encrypted_payload, record_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          observationId,
          revision,
          turnId,
          turn.scope.userId,
          turn.scope.workspaceId ?? null,
          turn.scope.sessionId ?? null,
          stored.kind,
          stored.contentHash,
          createdAt,
          this.seal("observation", observationId, stored),
          payloadHash,
        );
        if (sanitized.source?.eventId) {
          this.linkSources("observation", observationId, [sanitized.source as SourceRef]);
        }
        results.push(stored);
      }
      return results;
    })();
  }

  listObservations(turnId: string): StoredObservation[] {
    return (this.database
      .prepare("SELECT * FROM observations WHERE turn_id = ? ORDER BY created_at, observation_id")
      .all(turnId) as Row[]).map((row) => this.decodeObservation(row));
  }

  putWorldClaim(claim: WorldClaim, idempotencyKey?: string): WorldClaim {
    this.requireWritable();
    const redacted = redactSensitiveValue(claim).value;
    const sanitized: WorldClaim = {
      ...redacted,
      conflictGroup: redacted.conflictGroup ?? this.worldConflictGroup(redacted),
    };
    if (sanitized.sources.length === 0) {
      throw new ProtocolError({
        code: "INVALID_REQUEST",
        message: "World claims require at least one authoritative SourceRef",
      });
    }
    if (!Number.isFinite(sanitized.confidence) || sanitized.confidence < 0 || sanitized.confidence > 1) {
      throw new ProtocolError({ code: "INVALID_REQUEST", message: "World claim confidence must be between 0 and 1" });
    }
    this.assertSourceRefs(sanitized.sources, sanitized.scope);
    const rowKey = this.versionedId(sanitized.claimId, sanitized.version);
    this.assertNotTombstoned("world_claim", rowKey);
    const requestHash = sha256(canonicalJson(sanitized));
    if (idempotencyKey) {
      const prior = this.lookupIdempotency("put_world_claim", idempotencyKey);
      if (prior) {
        this.assertIdempotencyHash(prior, requestHash, "put_world_claim");
        const [claimId, version] = this.parseVersionedId(prior.entity_id);
        return this.required(this.getWorldClaim(claimId, version), "idempotent world claim");
      }
    }
    const existing = this.getWorldClaim(sanitized.claimId, sanitized.version);
    if (existing) {
      if (sha256(canonicalJson(existing)) !== requestHash) {
        this.versionConflict(`World claim ${rowKey} already exists with different content`);
      }
      return existing;
    }

    return this.database.transaction(() => {
      const revision = this.nextRevision();
      this.database.prepare(`
        INSERT INTO world_claims(
          claim_id, version, revision, user_id, workspace_id, session_id, subject,
          predicate, status, authority, confidence, supersedes, conflict_group,
          encrypted_payload, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sanitized.claimId,
        sanitized.version,
        revision,
        sanitized.scope.userId,
        sanitized.scope.workspaceId ?? null,
        sanitized.scope.sessionId ?? null,
        sanitized.subject,
        sanitized.predicate,
        sanitized.status,
        sanitized.authority,
        sanitized.confidence,
        sanitized.supersedes ?? null,
        this.worldConflictGroup(sanitized),
        this.seal("world_claim", rowKey, sanitized),
        requestHash,
      );
      this.database.prepare(`
        INSERT INTO world_claims_fts(row_key, user_id, workspace_id, subject, predicate, value)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        rowKey,
        sanitized.scope.userId,
        sanitized.scope.workspaceId ?? null,
        sanitized.subject,
        sanitized.predicate,
        this.searchableValue(sanitized.value),
      );
      this.linkSources("world_claim", rowKey, sanitized.sources);
      if (sanitized.status === "disputed") {
        this.database
          .prepare(`
            UPDATE world_claims SET status = 'disputed'
            WHERE claim_id = ? AND status = 'active'
              AND NOT (claim_id = ? AND version = ?)
          `)
          .run(sanitized.claimId, sanitized.claimId, sanitized.version);
      } else if (sanitized.supersedes) {
        this.database
          .prepare(`
            UPDATE world_claims SET status = 'superseded'
            WHERE claim_id = ? AND status IN ('active', 'disputed')
              AND NOT (claim_id = ? AND version = ?)
          `)
          .run(sanitized.supersedes, sanitized.claimId, sanitized.version);
      }
      if (idempotencyKey) {
        this.rememberIdempotency("put_world_claim", idempotencyKey, rowKey, requestHash, revision);
      }
      this.touchIndex(revision);
      return sanitized;
    })();
  }

  getWorldClaim(claimId: string, version?: number, scope?: ScopeRef): WorldClaim | undefined {
    const row = version === undefined
      ? this.database
          .prepare("SELECT * FROM world_claims WHERE claim_id = ? ORDER BY version DESC LIMIT 1")
          .get(claimId) as Row | undefined
      : this.database
          .prepare("SELECT * FROM world_claims WHERE claim_id = ? AND version = ?")
          .get(claimId, version) as Row | undefined;
    if (!row) return undefined;
    if (scope) this.assertAcl(row, scope, true);
    return this.decodeWorldClaim(row);
  }

  getWorldClaimStorageRevision(claimId: string, version?: number, scope?: ScopeRef): number | undefined {
    const row = version === undefined
      ? this.database.prepare("SELECT * FROM world_claims WHERE claim_id = ? ORDER BY version DESC LIMIT 1").get(claimId) as Row | undefined
      : this.database.prepare("SELECT * FROM world_claims WHERE claim_id = ? AND version = ?").get(claimId, version) as Row | undefined;
    if (row === undefined) return undefined;
    if (scope !== undefined) this.assertAcl(row, scope, true);
    return Number(row.revision);
  }

  listWorldClaims(
    scope: ScopeRef,
    includeInactive = false,
    maxRevision?: number,
    includeAllSessions = false,
  ): WorldClaim[] {
    const rows = this.database.prepare(`
      SELECT * FROM world_claims
      WHERE ${this.aclSql(!includeAllSessions)}
        AND (@includeInactive = 1 OR status IN ('active', 'disputed'))
        AND revision <= @maxRevision
      ORDER BY revision DESC
    `).all({
      ...this.aclParams(scope),
      includeInactive: includeInactive ? 1 : 0,
      maxRevision: Math.min(maxRevision ?? this.getRevision(), this.getRevision()),
    }) as Row[];
    return rows.map((row) => this.decodeWorldClaim(row));
  }

  listUnassignedWorldClaims(
    scope: ScopeRef,
    includeAllSessions = false,
    limit = 500,
  ): WorldClaim[] {
    const rows = this.database.prepare(`
      SELECT w.* FROM world_claims w
      WHERE ${this.aclSql(!includeAllSessions, "w")}
        AND w.status IN ('active', 'disputed')
        AND NOT EXISTS (
          SELECT 1 FROM memory_object_members m
          WHERE m.member_type = 'semantic'
            AND m.member_id = (w.claim_id || '${OWNER_ID_SEPARATOR}' || w.version)
            AND m.status = 'active'
        )
      ORDER BY w.revision, w.claim_id, w.version
      LIMIT @limit
    `).all({
      ...this.aclParams(scope),
      limit: Math.max(1, Math.min(limit, 5_000)),
    }) as Row[];
    return rows.map((row) => this.decodeWorldClaim(row));
  }

  putPolicy(policy: StoredPolicy, idempotencyKey?: string): StoredPolicy {
    this.requireWritable();
    const sanitized = redactSensitiveValue(policy).value;
    const effective: StoredPolicy = {
      ...sanitized,
      scope: this.normalizePolicyScope(sanitized.scope, sanitized.scopeLevel),
      reviewStatus: sanitized.reviewStatus ?? "approved",
    };
    const sources = effective.sources ?? [];
    if (sources.length === 0) {
      throw new ProtocolError({
        code: "INVALID_REQUEST",
        message: "Policies require at least one authoritative SourceRef",
      });
    }
    this.assertSourceRefs(sources, effective.scope);
    const rowKey = this.versionedId(effective.policyId, effective.version);
    this.assertNotTombstoned("policy", rowKey);
    const requestHash = sha256(canonicalJson(effective));
    if (idempotencyKey) {
      const prior = this.lookupIdempotency("put_policy", idempotencyKey);
      if (prior) {
        this.assertIdempotencyHash(prior, requestHash, "put_policy");
        const [policyId, version] = this.parseVersionedId(prior.entity_id);
        return this.required(this.getPolicy(policyId, version), "idempotent policy");
      }
    }
    const existing = this.getPolicy(effective.policyId, effective.version);
    if (existing) {
      if (sha256(canonicalJson(existing)) !== requestHash) {
        this.versionConflict(`Policy ${rowKey} already exists with different content`);
      }
      return existing;
    }

    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const reviewStatus = effective.reviewStatus ?? "approved";
      this.database.prepare(`
        INSERT INTO policies(
          policy_id, version, revision, user_id, workspace_id, session_id,
          scope_level, authority, review_status, text, encrypted_payload, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        effective.policyId,
        effective.version,
        revision,
        effective.scope.userId,
        effective.scope.workspaceId ?? null,
        effective.scope.sessionId ?? null,
        effective.scopeLevel,
        effective.authority,
        reviewStatus,
        effective.text,
        this.seal("policy", rowKey, effective),
        requestHash,
      );
      this.database.prepare(`
        INSERT INTO policies_fts(row_key, user_id, workspace_id, text) VALUES (?, ?, ?, ?)
      `).run(rowKey, effective.scope.userId, effective.scope.workspaceId ?? null, effective.text);
      this.linkSources("policy", rowKey, sources);
      if (idempotencyKey) {
        this.rememberIdempotency("put_policy", idempotencyKey, rowKey, requestHash, revision);
      }
      this.touchIndex(revision);
      return effective;
    })();
  }

  getPolicy(policyId: string, version?: number, scope?: ScopeRef): StoredPolicy | undefined {
    const row = version === undefined
      ? this.database
          .prepare("SELECT * FROM policies WHERE policy_id = ? ORDER BY version DESC LIMIT 1")
          .get(policyId) as Row | undefined
      : this.database
          .prepare("SELECT * FROM policies WHERE policy_id = ? AND version = ?")
          .get(policyId, version) as Row | undefined;
    if (!row) return undefined;
    if (scope) this.assertAcl(row, scope, true);
    return this.decodePolicy(row);
  }

  listPolicies(scope: ScopeRef, includeCandidates = false, includeAllSessions = false): StoredPolicy[] {
    const rows = this.database.prepare(`
      WITH latest AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY policy_id ORDER BY version DESC) AS version_rank
        FROM policies
      )
      SELECT * FROM latest
      WHERE version_rank = 1 AND ${this.aclSql(!includeAllSessions)}
        AND (@includeCandidates = 1 OR review_status = 'approved')
      ORDER BY
        CASE scope_level WHEN 'session' THEN 3 WHEN 'workspace' THEN 2 ELSE 1 END DESC,
        CASE authority WHEN 'user_explicit' THEN 2 ELSE 1 END DESC,
        revision DESC
    `).all({ ...this.aclParams(scope), includeCandidates: includeCandidates ? 1 : 0 }) as Row[];
    return rows.map((row) => this.decodePolicy(row));
  }

  getActivePolicies(scope: ScopeRef): StoredPolicy[] {
    const ended = scope.sessionId === undefined ? false : this.isSessionEnded(scope as ScopeRef & { sessionId: string });
    return this.listPolicies(scope, false).filter((policy) => !ended || policy.scopeLevel !== "session");
  }

  policyApprovalEligibility(policyId: string): PolicyApprovalEligibility {
    const policy = this.getPolicy(policyId);
    if (policy === undefined) {
      return { eligible: false, reason: `Policy ${policyId} was not found`, correctionCount: 0, sessionCount: 0 };
    }
    if (policy.authority === "user_explicit" || policy.reviewStatus === "approved") {
      return {
        eligible: true,
        reason: "Explicit user policies and already approved policies do not require a learned-pattern threshold",
        correctionCount: 0,
        sessionCount: 0,
      };
    }
    const sourceIds = new Set((policy.sources ?? []).map((source) => source.eventId));
    const policyCorrections = this.listCorrections(policy.scope, true)
      .filter((correction) => correction.source !== undefined && sourceIds.has(correction.source.eventId));
    const correctionIds = new Set(policyCorrections.map((correction) => correction.correctionId));
    const cluster = this.listFailureClusters(policy.scope).find((candidate) =>
      (candidate.status === "reviewed" || candidate.status === "promoted") &&
      candidate.correctionIds.length >= 3 &&
      new Set(candidate.sessionIds).size >= 2 &&
      candidate.correctionIds.some((correctionId) => correctionIds.has(correctionId)));
    if (cluster === undefined) {
      return {
        eligible: false,
        reason: "Learned policies require a matching cluster with at least 3 independent corrections across 2 sessions",
        correctionCount: 0,
        sessionCount: 0,
      };
    }
    return {
      eligible: true,
      reason: "Threshold met; this CLI approval is the required human confirmation",
      correctionCount: cluster.correctionIds.length,
      sessionCount: new Set(cluster.sessionIds).size,
      clusterId: cluster.clusterId,
    };
  }

  putEpisode(episode: EpisodeMemory, idempotencyKey?: string): EpisodeMemory {
    this.requireWritable();
    const sanitized = redactSensitiveValue(episode).value;
    if (sanitized.eventRefs.length === 0) {
      throw new ProtocolError({
        code: "INVALID_REQUEST",
        message: "Episodes require at least one authoritative SourceRef",
      });
    }
    this.assertSourceRefs(sanitized.eventRefs, sanitized.scope);
    this.assertNotTombstoned("episode", sanitized.episodeId);
    const requestHash = sha256(canonicalJson(sanitized));
    if (idempotencyKey) {
      const prior = this.lookupIdempotency("put_episode", idempotencyKey);
      if (prior) {
        this.assertIdempotencyHash(prior, requestHash, "put_episode");
        return this.required(this.getEpisode(prior.entity_id), "idempotent episode");
      }
    }
    const existing = this.getEpisode(sanitized.episodeId);
    if (existing) {
      if (sha256(canonicalJson(existing)) !== requestHash) {
        this.versionConflict(`Episode ${sanitized.episodeId} already exists with different content`);
      }
      return existing;
    }

    return this.database.transaction(() => {
      const revision = this.nextRevision();
      this.database.prepare(`
        INSERT INTO episodes(
          episode_id, revision, user_id, workspace_id, session_id, title,
          started_at, ended_at, encrypted_payload, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sanitized.episodeId,
        revision,
        sanitized.scope.userId,
        sanitized.scope.workspaceId ?? null,
        sanitized.scope.sessionId ?? null,
        sanitized.title,
        sanitized.startedAt,
        sanitized.endedAt,
        this.seal("episode", sanitized.episodeId, sanitized),
        requestHash,
      );
      this.database.prepare(`
        INSERT INTO episodes_fts(episode_id, user_id, workspace_id, title, summary)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        sanitized.episodeId,
        sanitized.scope.userId,
        sanitized.scope.workspaceId ?? null,
        sanitized.title,
        this.episodeSearchableSummary(sanitized),
      );
      this.linkSources("episode", sanitized.episodeId, sanitized.eventRefs);
      if (idempotencyKey) {
        this.rememberIdempotency("put_episode", idempotencyKey, sanitized.episodeId, requestHash, revision);
      }
      this.touchIndex(revision);
      return sanitized;
    })();
  }

  /** Episodes are rebuildable narrative indexes; extending a chunk never mutates SourceEvent history. */
  updateEpisode(episode: EpisodeMemory): EpisodeMemory {
    this.requireWritable();
    const sanitized = redactSensitiveValue(episode).value;
    if (sanitized.eventRefs.length === 0) {
      throw new ProtocolError({ code: "INVALID_REQUEST", message: "Episodes require SourceRefs" });
    }
    this.assertSourceRefs(sanitized.eventRefs, sanitized.scope);
    const existing = this.getEpisode(sanitized.episodeId, sanitized.scope);
    if (existing === undefined) this.notFound(`Episode ${sanitized.episodeId} was not found`);
    const recordHash = sha256(canonicalJson(sanitized));
    if (sha256(canonicalJson(existing)) === recordHash) return existing;
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      this.database.prepare(`
        UPDATE episodes SET revision = ?, title = ?, started_at = ?, ended_at = ?,
          encrypted_payload = ?, record_hash = ? WHERE episode_id = ?
      `).run(
        revision,
        sanitized.title,
        sanitized.startedAt,
        sanitized.endedAt,
        this.seal("episode", sanitized.episodeId, sanitized),
        recordHash,
        sanitized.episodeId,
      );
      this.database.prepare("DELETE FROM episodes_fts WHERE episode_id = ?").run(sanitized.episodeId);
      this.database.prepare(`
        INSERT INTO episodes_fts(episode_id, user_id, workspace_id, title, summary)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        sanitized.episodeId,
        sanitized.scope.userId,
        sanitized.scope.workspaceId ?? null,
        sanitized.title,
        this.episodeSearchableSummary(sanitized),
      );
      this.database.prepare("DELETE FROM source_links WHERE owner_type = 'episode' AND owner_id = ?")
        .run(sanitized.episodeId);
      this.linkSources("episode", sanitized.episodeId, sanitized.eventRefs);
      this.database.prepare("DELETE FROM embeddings WHERE owner_type = 'episode' AND owner_id = ?")
        .run(sanitized.episodeId);
      this.database.prepare("DELETE FROM embedding_buckets WHERE owner_type = 'episode' AND owner_id = ?")
        .run(sanitized.episodeId);
      this.touchIndex(revision);
      return sanitized;
    })();
  }

  getEpisode(episodeId: string, scope?: ScopeRef): EpisodeMemory | undefined {
    const row = this.database.prepare("SELECT * FROM episodes WHERE episode_id = ?").get(episodeId) as Row | undefined;
    if (!row) return undefined;
    if (scope) this.assertAcl(row, scope, false);
    return this.open<EpisodeMemory>("episode", episodeId, String(row.encrypted_payload));
  }

  listEpisodes(scope: ScopeRef, maxRevision?: number, limit = 500): EpisodeMemory[] {
    const rows = this.database.prepare(`
      SELECT * FROM episodes WHERE ${this.aclSql(false)} AND revision <= @maxRevision
      ORDER BY ended_at DESC, revision DESC LIMIT @limit
    `).all({
      ...this.aclParams(scope),
      maxRevision: Math.min(maxRevision ?? this.getRevision(), this.getRevision()),
      limit: Math.max(1, Math.min(limit, 5_000)),
    }) as Row[];
    return rows.map((row) => this.open<EpisodeMemory>("episode", String(row.episode_id), String(row.encrypted_payload)));
  }

  listUnassignedEpisodes(scope: ScopeRef, limit = 500): EpisodeMemory[] {
    const rows = this.database.prepare(`
      SELECT e.* FROM episodes e
      WHERE ${this.aclSql(false, "e")}
        AND NOT EXISTS (
          SELECT 1 FROM memory_object_members m
          WHERE m.member_type = 'episode'
            AND m.member_id = e.episode_id
            AND m.status = 'active'
        )
      ORDER BY e.revision, e.episode_id
      LIMIT @limit
    `).all({
      ...this.aclParams(scope),
      limit: Math.max(1, Math.min(limit, 5_000)),
    }) as Row[];
    return rows.map((row) =>
      this.open<EpisodeMemory>("episode", String(row.episode_id), String(row.encrypted_payload)));
  }

  /** Remove only the rebuildable Episode index; authoritative SourceEvents remain untouched. */
  clearEpisodesForRebuild(scope: ScopeRef): number {
    this.requireWritable();
    const rows = this.database.prepare(`
      SELECT episode_id FROM episodes WHERE ${this.aclSql(false)}
    `).all(this.aclParams(scope)) as Row[];
    if (rows.length === 0) return 0;
    return this.database.transaction(() => {
      for (const row of rows) {
        const episodeId = String(row.episode_id);
        this.database.prepare("DELETE FROM episodes_fts WHERE episode_id = ?").run(episodeId);
        this.database.prepare("DELETE FROM source_links WHERE owner_type = 'episode' AND owner_id = ?").run(episodeId);
        this.database.prepare("DELETE FROM embeddings WHERE owner_type = 'episode' AND owner_id = ?").run(episodeId);
        this.database.prepare("DELETE FROM embedding_buckets WHERE owner_type = 'episode' AND owner_id = ?").run(episodeId);
        this.database.prepare(`
          DELETE FROM entity_edges WHERE (from_type = 'episode' AND from_id = ?)
            OR (to_type = 'episode' AND to_id = ?)
        `).run(episodeId, episodeId);
        this.database.prepare("DELETE FROM idempotency_keys WHERE operation = 'put_episode' AND entity_id = ?")
          .run(episodeId);
        this.database.prepare("DELETE FROM episodes WHERE episode_id = ?").run(episodeId);
      }
      const revision = this.nextRevision();
      this.touchIndex(revision);
      return rows.length;
    })();
  }

  putCorrection(
    input: CorrectionInput,
    source?: SourceRef,
    correctionId: string = randomUUID(),
  ): StoredCorrection {
    this.requireWritable();
    const turn = this.getTurn(input.turnId);
    if (!turn) this.notFound(`Turn ${input.turnId} was not found`);
    const sanitizedInput = redactSensitiveValue(input).value;
    const sanitizedSource = source ? redactSensitiveValue(source).value : undefined;
    if (sanitizedSource) this.assertSourceRefs([sanitizedSource], turn.scope);
    const requestHash = sha256(canonicalJson({ input: sanitizedInput, source: sanitizedSource }));
    const prior = this.lookupIdempotency("put_correction", input.idempotencyKey);
    if (prior) {
      this.assertIdempotencyHash(prior, requestHash, "put_correction");
      return this.required(this.getCorrection(prior.entity_id), "idempotent correction");
    }
    const existing = this.getCorrection(correctionId);
    if (existing) {
      const existingRequest = {
        input: {
          turnId: existing.turnId,
          kind: existing.kind,
          ...(existing.wrongStatement === undefined ? {} : { wrongStatement: existing.wrongStatement }),
          correction: existing.correction,
          ...(existing.subject === undefined ? {} : { subject: existing.subject }),
          ...(existing.predicate === undefined ? {} : { predicate: existing.predicate }),
          ...(existing.value === undefined ? {} : { value: existing.value }),
          ...(existing.scopeLevel === undefined ? {} : { scopeLevel: existing.scopeLevel }),
          ...(existing.origin === undefined ? {} : { origin: existing.origin }),
          explicit: existing.explicit,
          idempotencyKey: existing.idempotencyKey,
        },
        source: existing.source,
      };
      if (sha256(canonicalJson(existingRequest)) !== requestHash) {
        this.versionConflict(`Correction ${correctionId} already exists with different content`);
      }
      return existing;
    }
    this.assertNotTombstoned("correction", correctionId);

    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const createdAt = this.isoNow();
      const base: StoredCorrection = {
        correctionId,
        turnId: sanitizedInput.turnId,
        revision,
        scope: turn.scope,
        kind: sanitizedInput.kind,
        correction: sanitizedInput.correction,
        explicit: sanitizedInput.explicit,
        idempotencyKey: sanitizedInput.idempotencyKey,
        createdAt,
      };
      if (sanitizedInput.wrongStatement !== undefined) base.wrongStatement = sanitizedInput.wrongStatement;
      if (sanitizedInput.subject !== undefined) base.subject = sanitizedInput.subject;
      if (sanitizedInput.predicate !== undefined) base.predicate = sanitizedInput.predicate;
      if (sanitizedInput.value !== undefined) base.value = sanitizedInput.value;
      if (sanitizedInput.scopeLevel !== undefined) base.scopeLevel = sanitizedInput.scopeLevel;
      if (sanitizedInput.origin !== undefined) base.origin = sanitizedInput.origin;
      if (sanitizedSource !== undefined) base.source = sanitizedSource;

      this.database.prepare(`
        INSERT INTO corrections(
          correction_id, revision, turn_id, idempotency_key, user_id, workspace_id,
          session_id, kind, explicit, created_at, encrypted_payload, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        correctionId,
        revision,
        sanitizedInput.turnId,
        sanitizedInput.idempotencyKey,
        turn.scope.userId,
        turn.scope.workspaceId ?? null,
        turn.scope.sessionId ?? null,
        sanitizedInput.kind,
        sanitizedInput.explicit ? 1 : 0,
        createdAt,
        this.seal("correction", correctionId, base),
        requestHash,
      );
      if (sanitizedSource) this.linkSources("correction", correctionId, [sanitizedSource]);
      this.rememberIdempotency(
        "put_correction",
        sanitizedInput.idempotencyKey,
        correctionId,
        requestHash,
        revision,
      );
      return base;
    })();
  }

  getCorrection(correctionId: string, scope?: ScopeRef): StoredCorrection | undefined {
    const row = this.database
      .prepare("SELECT * FROM corrections WHERE correction_id = ?")
      .get(correctionId) as Row | undefined;
    if (!row) return undefined;
    if (scope) this.assertAcl(row, scope, true);
    return this.open<StoredCorrection>("correction", correctionId, String(row.encrypted_payload));
  }

  listCorrections(scope: ScopeRef, includeAllSessions = false): StoredCorrection[] {
    const rows = this.database.prepare(`
      SELECT * FROM corrections WHERE ${this.aclSql(!includeAllSessions)} ORDER BY created_at DESC
    `).all(this.aclParams(scope)) as Row[];
    return rows.map((row) => this.open<StoredCorrection>("correction", String(row.correction_id), String(row.encrypted_payload)));
  }

  putTrace(turnId: string, trace: Record<string, unknown>, traceId: string = randomUUID()): StoredTrace {
    this.requireWritable();
    const turn = this.getTurn(turnId);
    if (!turn) this.notFound(`Turn ${turnId} was not found`);
    const sanitized = redactSensitiveValue(trace).value;
    const traceSources = this.sourceRefsInValue(sanitized);
    this.assertSourceRefs(traceSources, turn.scope);
    const recordHash = sha256(canonicalJson(sanitized));
    const existing = this.database
      .prepare("SELECT * FROM turn_traces WHERE trace_id = ?")
      .get(traceId) as Row | undefined;
    if (existing) {
      if (String(existing.record_hash) !== recordHash) {
        this.versionConflict(`Trace ${traceId} already exists with different content`);
      }
      return this.decodeTrace(existing);
    }
    this.assertNotTombstoned("trace", traceId);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const createdAt = this.isoNow();
      const stored: StoredTrace = {
        traceId,
        turnId,
        revision,
        scope: turn.scope,
        createdAt,
        trace: sanitized,
      };
      this.database.prepare(`
        INSERT INTO turn_traces(
          trace_id, revision, turn_id, user_id, workspace_id, session_id,
          created_at, encrypted_payload, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        traceId,
        revision,
        turnId,
        turn.scope.userId,
        turn.scope.workspaceId ?? null,
        turn.scope.sessionId ?? null,
        createdAt,
        this.seal("trace", traceId, stored),
        recordHash,
      );
      this.linkSources("trace", traceId, traceSources);
      return stored;
    })();
  }

  listTraces(turnId: string): StoredTrace[] {
    return (this.database
      .prepare("SELECT * FROM turn_traces WHERE turn_id = ? ORDER BY created_at, trace_id")
      .all(turnId) as Row[]).map((row) => this.decodeTrace(row));
  }

  putTrigger(record: TriggerRecord): TriggerRecord {
    this.assertSourceRefs(record.sourceRefs ?? [], record.scope);
    const written = this.putAuxiliary(
      "trigger",
      "triggers",
      "trigger_id",
      record.triggerId,
      record,
      [
        "user_id", "workspace_id", "session_id", "policy_id", "risk_code",
        "priority", "activation_count", "last_activated_at",
      ],
      [
        record.scope.userId,
        record.scope.workspaceId ?? null,
        record.scope.sessionId ?? null,
        record.policyId ?? null,
        record.riskCode ?? null,
        record.priority,
        record.activationCount,
        record.lastActivatedAt ?? null,
      ],
    );
    if ((written.sourceRefs ?? []).length > 0) {
      this.linkSources("trigger", written.triggerId, written.sourceRefs ?? []);
    }
    return written;
  }

  upsertTrigger(record: TriggerRecord): TriggerRecord {
    this.assertSourceRefs(record.sourceRefs ?? [], record.scope);
    const existing = this.getTrigger(record.triggerId);
    const timestamped: TriggerRecord = {
      ...record,
      status: record.status ?? "active",
      createdAt: record.createdAt ?? existing?.createdAt ?? this.isoNow(),
      updatedAt: this.isoNow(),
    };
    const written = this.upsertAuxiliary(
      "trigger",
      "triggers",
      "trigger_id",
      record.triggerId,
      timestamped,
      [
        "user_id", "workspace_id", "session_id", "policy_id", "risk_code",
        "priority", "activation_count", "last_activated_at",
      ],
      [
        record.scope.userId,
        record.scope.workspaceId ?? null,
        record.scope.sessionId ?? null,
        record.policyId ?? null,
        record.riskCode ?? null,
        record.priority,
        record.activationCount,
        record.lastActivatedAt ?? null,
      ],
    );
    this.database.prepare("DELETE FROM source_links WHERE owner_type = 'trigger' AND owner_id = ?").run(written.triggerId);
    if ((written.sourceRefs ?? []).length > 0) {
      this.linkSources("trigger", written.triggerId, written.sourceRefs ?? []);
    }
    return written;
  }

  getTrigger(triggerId: string): TriggerRecord | undefined {
    const row = this.database.prepare("SELECT * FROM triggers WHERE trigger_id = ?").get(triggerId) as Row | undefined;
    return row === undefined
      ? undefined
      : this.open<TriggerRecord>("trigger", triggerId, String(row.encrypted_payload));
  }

  listTriggers(scope: ScopeRef, includeAllSessions = false): TriggerRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM triggers WHERE ${this.aclSql(!includeAllSessions)} ORDER BY priority DESC, revision DESC
    `).all(this.aclParams(scope)) as Row[];
    return rows.map((row) => this.open<TriggerRecord>("trigger", String(row.trigger_id), String(row.encrypted_payload)));
  }

  putTriggerActivation(input: Omit<TriggerActivationRecord, "activationId" | "revision">): TriggerActivationRecord {
    this.requireWritable();
    const turn = this.getTurn(input.turnId, input.scope);
    if (turn === undefined) this.notFound(`Turn ${input.turnId} was not found`);
    const activationId = `activation_${sha256(`${input.triggerId}\u001f${input.turnId}`).slice(0, 32)}`;
    const existing = this.database.prepare("SELECT * FROM trigger_activations WHERE activation_id = ?")
      .get(activationId) as Row | undefined;
    if (existing !== undefined) return this.decodeTriggerActivation(existing);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const record: TriggerActivationRecord = { ...input, activationId, revision };
      this.database.prepare(`
        INSERT INTO trigger_activations(
          activation_id, revision, trigger_id, turn_id, user_id, workspace_id, session_id,
          structural_score, similarity_score, effective_score, activated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        activationId,
        revision,
        input.triggerId,
        input.turnId,
        input.scope.userId,
        input.scope.workspaceId ?? null,
        input.scope.sessionId ?? null,
        Math.max(0, Math.min(1, input.structuralScore)),
        Math.max(0, Math.min(1, input.similarityScore)),
        Math.max(0, Math.min(1, input.effectiveScore)),
        input.activatedAt,
      );
      return record;
    })();
  }

  listTriggerActivations(triggerId: string): TriggerActivationRecord[] {
    return (this.database.prepare(`
      SELECT * FROM trigger_activations WHERE trigger_id = ? ORDER BY activated_at DESC, revision DESC
    `).all(triggerId) as Row[]).map((row) => this.decodeTriggerActivation(row));
  }

  enqueueLearningJob(
    type: LearningJobType,
    scope: ScopeRef,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): LearningJobRecord {
    this.requireWritable();
    const jobId = `job_${sha256(idempotencyKey).slice(0, 32)}`;
    const existing = this.getLearningJob(jobId);
    const sanitizedPayload = redactSensitiveValue(payload).value;
    const requestHash = sha256(canonicalJson({ type, scope, payload: sanitizedPayload, idempotencyKey }));
    if (existing !== undefined) {
      const existingHash = this.database.prepare("SELECT record_hash FROM learning_jobs WHERE job_id = ?")
        .get(jobId) as Row;
      if (String(existingHash.record_hash) !== requestHash) {
        this.versionConflict(`Learning job idempotency key ${idempotencyKey} was reused`);
      }
      return existing;
    }
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const availableAt = this.isoNow();
      const record: LearningJobRecord = {
        jobId,
        revision,
        idempotencyKey,
        scope,
        type,
        status: "pending",
        attempts: 0,
        availableAt,
        payload: sanitizedPayload,
      };
      this.database.prepare(`
        INSERT INTO learning_jobs(
          job_id, revision, idempotency_key, user_id, workspace_id, session_id,
          job_type, status, attempts, available_at, leased_at, last_error,
          encrypted_payload, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)
      `).run(
        jobId,
        revision,
        idempotencyKey,
        scope.userId,
        scope.workspaceId ?? null,
        scope.sessionId ?? null,
        type,
        availableAt,
        this.seal("learning_job", jobId, record),
        requestHash,
      );
      return record;
    })();
  }

  getLearningJob(jobId: string): LearningJobRecord | undefined {
    const row = this.database.prepare("SELECT * FROM learning_jobs WHERE job_id = ?").get(jobId) as Row | undefined;
    return row === undefined ? undefined : this.decodeLearningJob(row);
  }

  listLearningJobs(status?: LearningJobRecord["status"], scope?: ScopeRef): LearningJobRecord[] {
    const rows = scope === undefined
      ? status === undefined
        ? this.database.prepare("SELECT * FROM learning_jobs ORDER BY revision").all() as Row[]
        : this.database.prepare("SELECT * FROM learning_jobs WHERE status = ? ORDER BY revision").all(status) as Row[]
      : this.database.prepare(`
          SELECT * FROM learning_jobs
          WHERE ${this.aclSql(false)} AND (@status IS NULL OR status = @status)
          ORDER BY revision
        `).all({ ...this.aclParams(scope), status: status ?? null }) as Row[];
    return rows.map((row) => this.decodeLearningJob(row));
  }

  claimLearningJobs(limit = 25, now = this.isoNow()): LearningJobRecord[] {
    this.requireWritable();
    const staleBefore = new Date(Date.parse(now) - 5 * 60_000).toISOString();
    return this.database.transaction(() => {
      this.database.prepare(`
        UPDATE learning_jobs SET status = 'pending', leased_at = NULL
        WHERE status = 'running' AND leased_at < ?
      `).run(staleBefore);
      const rows = this.database.prepare(`
        SELECT * FROM learning_jobs
        WHERE status = 'pending' AND available_at <= ?
        ORDER BY revision LIMIT ?
      `).all(now, Math.max(1, Math.min(limit, 100))) as Row[];
      const claimed: LearningJobRecord[] = [];
      for (const row of rows) {
        const job = this.decodeLearningJob(row);
        const revision = this.nextRevision();
        const updated: LearningJobRecord = {
          ...job,
          revision,
          status: "running",
          attempts: job.attempts + 1,
          leasedAt: now,
        };
        this.database.prepare(`
          UPDATE learning_jobs SET revision = ?, status = 'running', attempts = ?, leased_at = ?,
            encrypted_payload = ? WHERE job_id = ?
        `).run(revision, updated.attempts, now, this.seal("learning_job", job.jobId, updated), job.jobId);
        claimed.push(updated);
      }
      return claimed;
    })();
  }

  completeLearningJob(jobId: string): LearningJobRecord {
    return this.updateLearningJobState(jobId, "completed");
  }

  failLearningJob(jobId: string, error: string, now = this.isoNow()): LearningJobRecord {
    const job = this.getLearningJob(jobId);
    if (job === undefined) this.notFound(`Learning job ${jobId} was not found`);
    const failed = job.attempts >= 5;
    const nextAt = new Date(Date.parse(now) + Math.min(60_000, 1_000 * (2 ** Math.max(0, job.attempts - 1))))
      .toISOString();
    return this.updateLearningJobState(jobId, failed ? "failed" : "pending", {
      availableAt: nextAt,
      lastError: redactSensitiveContent(error).value.slice(0, 500),
    });
  }

  putFailureCluster(record: FailureClusterRecord): FailureClusterRecord {
    return this.putAuxiliary(
      "failure_cluster",
      "failure_clusters",
      "cluster_id",
      record.clusterId,
      record,
      ["user_id", "workspace_id", "status", "correction_count", "session_count"],
      [
        record.scope.userId,
        record.scope.workspaceId ?? null,
        record.status,
        record.correctionIds.length,
        new Set(record.sessionIds).size,
      ],
    );
  }

  upsertFailureCluster(record: FailureClusterRecord): FailureClusterRecord {
    return this.upsertAuxiliary(
      "failure_cluster",
      "failure_clusters",
      "cluster_id",
      record.clusterId,
      record,
      ["user_id", "workspace_id", "status", "correction_count", "session_count"],
      [
        record.scope.userId,
        record.scope.workspaceId ?? null,
        record.status,
        record.correctionIds.length,
        new Set(record.sessionIds).size,
      ],
    );
  }

  listFailureClusters(scope: ScopeRef): FailureClusterRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM failure_clusters WHERE ${this.aclSql(false)} ORDER BY revision DESC
    `).all(this.aclParams(scope)) as Row[];
    return rows.map((row) => this.open<FailureClusterRecord>("failure_cluster", String(row.cluster_id), String(row.encrypted_payload)));
  }

  putCalibrationPattern(record: CalibrationPatternRecord): CalibrationPatternRecord {
    this.assertUnscopedSourceRefs(record.sourceRefs ?? []);
    const written = this.putAuxiliary(
      "calibration_pattern",
      "calibration_patterns",
      "pattern_id",
      record.patternId,
      record,
      ["agent_profile_key", "status"],
      [record.agentProfileKey, record.status],
    );
    if ((written.sourceRefs ?? []).length > 0) this.linkSources("calibration_pattern", written.patternId, written.sourceRefs ?? []);
    return written;
  }

  upsertCalibrationPattern(record: CalibrationPatternRecord): CalibrationPatternRecord {
    this.assertUnscopedSourceRefs(record.sourceRefs ?? []);
    const written = this.upsertAuxiliary(
      "calibration_pattern",
      "calibration_patterns",
      "pattern_id",
      record.patternId,
      record,
      ["agent_profile_key", "status"],
      [record.agentProfileKey, record.status],
    );
    this.database.prepare("DELETE FROM source_links WHERE owner_type = 'calibration_pattern' AND owner_id = ?")
      .run(written.patternId);
    if ((written.sourceRefs ?? []).length > 0) this.linkSources("calibration_pattern", written.patternId, written.sourceRefs ?? []);
    return written;
  }

  getCalibrationPattern(patternId: string): CalibrationPatternRecord | undefined {
    const row = this.database.prepare("SELECT * FROM calibration_patterns WHERE pattern_id = ?")
      .get(patternId) as Row | undefined;
    return row === undefined
      ? undefined
      : this.open<CalibrationPatternRecord>("calibration_pattern", patternId, String(row.encrypted_payload));
  }

  listCalibrationPatterns(agentProfileKey: string, includeInactive = false): CalibrationPatternRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM calibration_patterns
      WHERE agent_profile_key = ? AND (? = 1 OR status = 'active')
      ORDER BY revision DESC
    `).all(agentProfileKey, includeInactive ? 1 : 0) as Row[];
    return rows.map((row) => this.open<CalibrationPatternRecord>(
      "calibration_pattern",
      String(row.pattern_id),
      String(row.encrypted_payload),
    ));
  }

  listCalibrationPatternsForScope(scope: ScopeRef, includeInactive = false): CalibrationPatternRecord[] {
    const visible = this.aclSql(false, "e");
    const rows = this.database.prepare(`
      SELECT c.* FROM calibration_patterns c
      WHERE (@includeInactive = 1 OR c.status = 'active')
        AND EXISTS (
          SELECT 1 FROM source_links l
          JOIN source_events e ON e.event_id = l.event_id
          WHERE l.owner_type = 'calibration_pattern' AND l.owner_id = c.pattern_id
            AND ${visible}
        )
        AND NOT EXISTS (
          SELECT 1 FROM source_links l
          JOIN source_events e ON e.event_id = l.event_id
          WHERE l.owner_type = 'calibration_pattern' AND l.owner_id = c.pattern_id
            AND NOT (${visible})
        )
      ORDER BY c.revision DESC
    `).all({ ...this.aclParams(scope), includeInactive: includeInactive ? 1 : 0 }) as Row[];
    return rows.map((row) => this.open<CalibrationPatternRecord>(
      "calibration_pattern",
      String(row.pattern_id),
      String(row.encrypted_payload),
    ));
  }

  putMemoryPartition(partition: MemoryPartition): MemoryPartition {
    this.requireWritable();
    const sanitized = redactSensitiveValue(partition).value;
    if (sanitized.capacity < 1 || sanitized.depth < 0 || sanitized.version < 1) {
      throw new ProtocolError({ code: "INVALID_REQUEST", message: "Memory partition bounds are invalid" });
    }
    const existing = this.getMemoryPartition(sanitized.partitionId);
    if (existing !== undefined && existing.version > sanitized.version) {
      this.versionConflict(`Memory partition ${sanitized.partitionId} version moved backwards`);
    }
    const recordHash = sha256(canonicalJson(sanitized));
    const existingRow = this.database.prepare("SELECT * FROM memory_partitions WHERE partition_id = ?")
      .get(sanitized.partitionId) as Row | undefined;
    if (existingRow !== undefined && String(existingRow.record_hash) === recordHash) return existing as MemoryPartition;
    if (existingRow === undefined) this.assertNotTombstoned("memory_partition", sanitized.partitionId);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      if (existingRow === undefined) {
        this.database.prepare(`
          INSERT INTO memory_partitions(
            partition_id, revision, user_id, workspace_id, session_id, namespace,
            partition_key, strategy, status, parent_partition_id, depth, child_count,
            object_count, capacity, version, created_at, updated_at, encrypted_payload, record_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sanitized.partitionId,
          revision,
          sanitized.scope.userId,
          sanitized.scope.workspaceId ?? null,
          sanitized.scope.sessionId ?? null,
          sanitized.namespace,
          sanitized.partitionKey,
          sanitized.strategy,
          sanitized.status,
          sanitized.parentPartitionId ?? null,
          sanitized.depth,
          sanitized.childCount,
          sanitized.objectCount,
          sanitized.capacity,
          sanitized.version,
          sanitized.createdAt,
          sanitized.updatedAt,
          this.seal("memory_partition", sanitized.partitionId, sanitized),
          recordHash,
        );
      } else {
        this.assertAcl(existingRow, sanitized.scope, true);
        this.database.prepare(`
          UPDATE memory_partitions SET revision = ?, namespace = ?, partition_key = ?,
            strategy = ?, status = ?, parent_partition_id = ?, depth = ?, child_count = ?,
            object_count = ?, capacity = ?, version = ?, updated_at = ?,
            encrypted_payload = ?, record_hash = ? WHERE partition_id = ?
        `).run(
          revision,
          sanitized.namespace,
          sanitized.partitionKey,
          sanitized.strategy,
          sanitized.status,
          sanitized.parentPartitionId ?? null,
          sanitized.depth,
          sanitized.childCount,
          sanitized.objectCount,
          sanitized.capacity,
          sanitized.version,
          sanitized.updatedAt,
          this.seal("memory_partition", sanitized.partitionId, sanitized),
          recordHash,
          sanitized.partitionId,
        );
      }
      this.bumpMemoryGeneration();
      return sanitized;
    })();
  }

  getMemoryPartition(partitionId: string, scope?: ScopeRef): MemoryPartition | undefined {
    const row = this.database.prepare("SELECT * FROM memory_partitions WHERE partition_id = ?")
      .get(partitionId) as Row | undefined;
    if (row === undefined) return undefined;
    if (scope !== undefined) this.assertAcl(row, scope, true);
    return this.decodeMemoryPartition(row);
  }

  listMemoryPartitions(
    scope: ScopeRef,
    options: { includeArchived?: boolean; parentPartitionId?: string; limit?: number } = {},
  ): MemoryPartition[] {
    const rows = this.database.prepare(`
      SELECT * FROM memory_partitions
      WHERE ${this.aclSql(true)}
        AND (@includeArchived = 1 OR status != 'archived')
        AND (@parentPartitionId IS NULL OR parent_partition_id = @parentPartitionId)
      ORDER BY depth, updated_at DESC, partition_id
      LIMIT @limit
    `).all({
      ...this.aclParams(scope),
      includeArchived: options.includeArchived ? 1 : 0,
      parentPartitionId: options.parentPartitionId ?? null,
      limit: Math.max(1, Math.min(options.limit ?? 500, 5_000)),
    }) as Row[];
    return rows.map((row) => this.decodeMemoryPartition(row));
  }

  putMemoryObject(object: MemoryObject): MemoryObject {
    this.requireWritable();
    const sanitized = redactSensitiveValue(object).value;
    if (sanitized.evidenceRefs.length === 0) {
      throw new ProtocolError({ code: "INVALID_REQUEST", message: "Memory objects require authoritative evidence" });
    }
    this.assertSourceRefs(sanitized.evidenceRefs, sanitized.scope);
    if (
      sanitized.version < 1 ||
      sanitized.schemaVersion < 1 ||
      sanitized.tokenEstimate < 0 ||
      sanitized.memberCount < 0 ||
      sanitized.childCount < 0 ||
      !Number.isFinite(sanitized.confidence) ||
      sanitized.confidence < 0 ||
      sanitized.confidence > 1
    ) {
      throw new ProtocolError({ code: "INVALID_REQUEST", message: "Memory object bounds are invalid" });
    }
    const partition = this.getMemoryPartition(sanitized.partitionId, sanitized.scope);
    if (partition === undefined) this.notFound(`Memory partition ${sanitized.partitionId} was not found`);
    const existingRow = this.database.prepare("SELECT * FROM memory_objects WHERE object_id = ?")
      .get(sanitized.objectId) as Row | undefined;
    const existing = existingRow === undefined ? undefined : this.decodeMemoryObject(existingRow);
    if (existing !== undefined && existing.version > sanitized.version) {
      this.versionConflict(`Memory object ${sanitized.objectId} version moved backwards`);
    }
    const recordHash = sha256(canonicalJson(sanitized));
    if (existingRow !== undefined && String(existingRow.record_hash) === recordHash) return existing as MemoryObject;
    if (existingRow === undefined) this.assertNotTombstoned("memory_object", sanitized.objectId);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      if (existingRow === undefined) {
        this.database.prepare(`
          INSERT INTO memory_objects(
            object_id, revision, user_id, workspace_id, session_id, partition_id,
            parent_object_id, object_type, title, status, temperature, token_estimate,
            child_count, member_count, confidence, version, schema_version,
            summarizer_version, created_at, updated_at, encrypted_payload, record_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sanitized.objectId,
          revision,
          sanitized.scope.userId,
          sanitized.scope.workspaceId ?? null,
          sanitized.scope.sessionId ?? null,
          sanitized.partitionId,
          sanitized.parentObjectId ?? null,
          sanitized.objectType,
          sanitized.title,
          sanitized.status,
          sanitized.temperature,
          sanitized.tokenEstimate,
          sanitized.childCount,
          sanitized.memberCount,
          sanitized.confidence,
          sanitized.version,
          sanitized.schemaVersion,
          sanitized.summarizerVersion,
          sanitized.createdAt,
          sanitized.updatedAt,
          this.seal("memory_object", sanitized.objectId, sanitized),
          recordHash,
        );
      } else {
        this.assertAcl(existingRow, sanitized.scope, true);
        this.database.prepare(`
          UPDATE memory_objects SET revision = ?, partition_id = ?, parent_object_id = ?,
            object_type = ?, title = ?, status = ?, temperature = ?, token_estimate = ?,
            child_count = ?, member_count = ?, confidence = ?, version = ?,
            schema_version = ?, summarizer_version = ?, updated_at = ?,
            encrypted_payload = ?, record_hash = ? WHERE object_id = ?
        `).run(
          revision,
          sanitized.partitionId,
          sanitized.parentObjectId ?? null,
          sanitized.objectType,
          sanitized.title,
          sanitized.status,
          sanitized.temperature,
          sanitized.tokenEstimate,
          sanitized.childCount,
          sanitized.memberCount,
          sanitized.confidence,
          sanitized.version,
          sanitized.schemaVersion,
          sanitized.summarizerVersion,
          sanitized.updatedAt,
          this.seal("memory_object", sanitized.objectId, sanitized),
          recordHash,
          sanitized.objectId,
        );
      }
      this.database.prepare("DELETE FROM memory_objects_fts WHERE object_id = ?").run(sanitized.objectId);
      // Object retrieval is deliberately partition-local. Keeping every
      // object in one physical FTS posting list would simply move the
      // unbounded-index problem up one layer. The legacy v7 FTS table remains
      // empty for migration compatibility and can be removed in a future
      // major schema cleanup.
      this.database.prepare("DELETE FROM source_links WHERE owner_type = 'memory_object' AND owner_id = ?")
        .run(sanitized.objectId);
      this.linkSources("memory_object", sanitized.objectId, sanitized.evidenceRefs);
      this.touchIndex(revision);
      this.bumpMemoryGeneration();
      return sanitized;
    })();
  }

  getMemoryObject(objectId: string, scope?: ScopeRef): MemoryObject | undefined {
    const row = this.database.prepare("SELECT * FROM memory_objects WHERE object_id = ?")
      .get(objectId) as Row | undefined;
    if (row === undefined) return undefined;
    if (scope !== undefined) this.assertAcl(row, scope, true);
    return this.decodeMemoryObject(row);
  }

  listMemoryObjects(
    scope: ScopeRef,
    options: {
      partitionIds?: readonly string[];
      statuses?: readonly MemoryObject["status"][];
      temperatures?: readonly MemoryObject["temperature"][];
      maxRevision?: number;
      limit?: number;
    } = {},
  ): MemoryObject[] {
    const partitions = options.partitionIds ?? [];
    const statuses = options.statuses ?? [];
    const temperatures = options.temperatures ?? [];
    const partitionSql = partitions.length === 0
      ? ""
      : `AND partition_id IN (${partitions.map((_, index) => `@partition${index}`).join(", ")})`;
    const statusSql = statuses.length === 0
      ? ""
      : `AND status IN (${statuses.map((_, index) => `@status${index}`).join(", ")})`;
    const temperatureSql = temperatures.length === 0
      ? ""
      : `AND temperature IN (${temperatures.map((_, index) => `@temperature${index}`).join(", ")})`;
    const rows = this.database.prepare(`
      SELECT * FROM memory_objects
      WHERE ${this.aclSql(true)} AND revision <= @maxRevision
        ${partitionSql} ${statusSql} ${temperatureSql}
      ORDER BY
        CASE temperature WHEN 'hot' THEN 4 WHEN 'warm' THEN 3 WHEN 'cold' THEN 2 ELSE 1 END DESC,
        updated_at DESC, object_id
      LIMIT @limit
    `).all({
      ...this.aclParams(scope),
      maxRevision: Math.min(options.maxRevision ?? this.getRevision(), this.getRevision()),
      limit: Math.max(1, Math.min(options.limit ?? 500, 5_000)),
      ...Object.fromEntries(partitions.map((value, index) => [`partition${index}`, value])),
      ...Object.fromEntries(statuses.map((value, index) => [`status${index}`, value])),
      ...Object.fromEntries(temperatures.map((value, index) => [`temperature${index}`, value])),
    }) as Row[];
    return rows.map((row) => this.decodeMemoryObject(row));
  }

  /** Workspace-level scopes with authoritative or derived memory, for bounded background maintenance. */
  listMemoryScopes(limit = 500): ScopeRef[] {
    const rows = this.database.prepare(`
      SELECT user_id, workspace_id FROM memory_scope_registry
      ORDER BY
        CASE WHEN last_scheduled_at IS NULL THEN 0 ELSE 1 END,
        last_scheduled_at,
        last_activity_at DESC,
        user_id,
        workspace_key
      LIMIT ?
    `).all(Math.max(1, Math.min(limit, 5_000))) as Row[];
    return rows.map((row) => ({
      userId: String(row.user_id),
      ...(row.workspace_id === null || row.workspace_id === undefined
        ? {}
        : { workspaceId: String(row.workspace_id) }),
    }));
  }

  markMemoryScopeScheduled(scope: ScopeRef, at = this.isoNow()): void {
    this.requireWritable();
    this.database.prepare(`
      UPDATE memory_scope_registry SET last_scheduled_at = ?
      WHERE user_id = ? AND workspace_key = ?
    `).run(at, scope.userId, scope.workspaceId ?? "");
  }

  routeMemoryPartitions(
    query: string,
    scope: ScopeRef,
    options: {
      includeArchive?: boolean;
      maxRevision?: number;
      limit?: number;
      maxDepth?: number;
    } = {},
  ): MemoryPartition[] {
    const maxRevision = Math.min(options.maxRevision ?? this.getRevision(), this.getRevision());
    const limit = Math.max(1, Math.min(options.limit ?? 8, 40));
    const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 3, 12));
    const statusSql = options.includeArchive
      ? "status IN ('active', 'router', 'archived')"
      : "status IN ('active', 'router')";
    const roots = (this.database.prepare(`
      SELECT * FROM memory_partitions
      WHERE ${this.aclSql(true)} AND parent_partition_id IS NULL
        AND revision <= @maxRevision AND ${statusSql}
      ORDER BY updated_at DESC, partition_id
      LIMIT @limit
    `).all({
      ...this.aclParams(scope),
      maxRevision,
      limit,
    }) as Row[]).map((row) => this.decodeMemoryPartition(row));
    if (roots.length === 0) return [];

    const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase("und");
    const queryTokens = new Set(normalizedQuery.match(/[\p{L}\p{N}_.:/#-]{2,}/gu) ?? []);
    const score = (partition: MemoryPartition): number => {
      if (queryTokens.size === 0) return 0;
      const keys = [
        partition.partitionKey,
        partition.namespace,
        ...partition.routingKeys,
      ].map((value) => value.normalize("NFKC").toLocaleLowerCase("und"));
      const matches = keys.filter((key) =>
        queryTokens.has(key) || normalizedQuery.includes(key) ||
        [...queryTokens].some((token) => key.includes(token)));
      if (matches.length === 0) return 0;
      // A specific entity/project key must outrank a short shared topic such as
      // "deployment"; otherwise a bounded partition router can select the
      // wrong local shard even when the query names the entity exactly.
      const specificity = Math.max(...matches.map((key) => Math.min(160, key.length))) / 160;
      return specificity + matches.length / Math.max(1, keys.length) / 10;
    };
    const rank = (partitions: MemoryPartition[]): MemoryPartition[] =>
      [...partitions].sort((left, right) =>
        score(right) - score(left) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.partitionId.localeCompare(right.partitionId)).slice(0, limit);

    let frontier = rank(roots);
    const leaves: MemoryPartition[] = [];
    const visited = new Set<string>();
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const children: MemoryPartition[] = [];
      for (const partition of frontier) {
        if (visited.has(partition.partitionId)) continue;
        visited.add(partition.partitionId);
        if (partition.status !== "router") {
          leaves.push(partition);
          continue;
        }
        const rows = this.database.prepare(`
          SELECT * FROM memory_partitions
          WHERE ${this.aclSql(true)} AND parent_partition_id = @parentPartitionId
            AND revision <= @maxRevision AND ${statusSql}
          ORDER BY updated_at DESC, partition_id
          LIMIT @limit
        `).all({
          ...this.aclParams(scope),
          parentPartitionId: partition.partitionId,
          maxRevision,
          limit: Math.max(limit, Math.min(partition.capacity, 100)),
        }) as Row[];
        if (rows.length === 0) leaves.push(partition);
        else children.push(...rows.map((row) => this.decodeMemoryPartition(row)));
      }
      frontier = rank(children);
    }
    leaves.push(...frontier);
    const unique = new Map(leaves.map((partition) => [partition.partitionId, partition]));
    return rank([...unique.values()]);
  }

  routeMemoryObjects(
    query: string,
    scope: ScopeRef,
    options: {
      includeArchive?: boolean;
      maxRevision?: number;
      limit?: number;
      candidateLimit?: number;
      partitionLimit?: number;
      maxPartitionDepth?: number;
    } = {},
  ): MemoryObjectRouteHit[] {
    const maxRevision = Math.min(options.maxRevision ?? this.getRevision(), this.getRevision());
    const candidateLimit = Math.max(4, Math.min(options.candidateLimit ?? 80, 500));
    const requestedLimit = Math.max(1, Math.min(options.limit ?? 8, 40));
    const partitions = this.routeMemoryPartitions(query, scope, {
      maxRevision,
      limit: options.partitionLimit ?? requestedLimit,
      ...(options.includeArchive === undefined ? {} : { includeArchive: options.includeArchive }),
      ...(options.maxPartitionDepth === undefined ? {} : { maxDepth: options.maxPartitionDepth }),
    });
    if (partitions.length === 0) return [];
    const partitionParams = Object.fromEntries(
      partitions.map((partition, index) => [`routePartition${index}`, partition.partitionId]),
    );
    const partitionSql = `o.partition_id IN (${
      partitions.map((_, index) => `@routePartition${index}`).join(", ")
    })`;
    const rawRows = this.database.prepare(`
      SELECT o.* FROM memory_objects o
      WHERE ${this.aclSql(true, "o")} AND o.revision <= @maxRevision
        AND ${partitionSql}
        AND o.status IN ('active', 'router', 'archived')
      ORDER BY
        CASE o.temperature WHEN 'hot' THEN 3 WHEN 'warm' THEN 2 WHEN 'cold' THEN 1 ELSE 0 END DESC,
        o.updated_at DESC, o.object_id
      LIMIT @candidateLimit
    `).all({
      ...this.aclParams(scope),
      ...partitionParams,
      maxRevision,
      candidateLimit,
    }) as Row[];
    const queryNormalized = query.normalize("NFKC").toLocaleLowerCase("und");
    const queryTokens = new Set(queryNormalized.match(/[\p{L}\p{N}_.:/#-]{2,}/gu) ?? []);
    const hits: MemoryObjectRouteHit[] = [];
    for (const row of rawRows) {
      const storedObject = this.decodeMemoryObject(row);
      const effectiveTemperature = this.getMemoryTemperature("object", storedObject.objectId, scope)?.tier
        ?? storedObject.temperature;
      const object = effectiveTemperature === storedObject.temperature
        ? storedObject
        : { ...storedObject, temperature: effectiveTemperature };
      const keys = [object.title, ...object.routingKeys, ...object.entityKeys]
        .map((value) => value.normalize("NFKC").toLocaleLowerCase("und"));
      const keyMatches = (key: string): boolean =>
        key.length > 1 && (queryTokens.has(key) || queryNormalized.includes(key));
      const exact = keys.some(keyMatches);
      const exactEntity = object.entityKeys
        .map((value) => value.normalize("NFKC").toLocaleLowerCase("und"))
        .some(keyMatches);
      const exactTitle = keyMatches(object.title.normalize("NFKC").toLocaleLowerCase("und"));
      const longestMatch = Math.max(0, ...keys.filter(keyMatches).map((key) => key.length));
      const searchable = [
        object.title,
        object.summary,
        ...object.routingKeys,
        ...object.entityKeys,
      ].join("\n").normalize("NFKC").toLocaleLowerCase("und");
      const lexicalMatches = [...queryTokens].filter((token) =>
        searchable.includes(token) || token.includes(object.title.normalize("NFKC").toLocaleLowerCase("und")));
      const lexical = queryTokens.size === 0 ? 0 : lexicalMatches.length / queryTokens.size;
      if (queryTokens.size === 0 && object.temperature !== "hot" && object.temperature !== "warm") continue;
      if (queryTokens.size > 0 && lexical === 0 && !exact) continue;
      if (object.temperature === "cold" && !exact) continue;
      if (object.temperature === "archive" && !options.includeArchive) continue;
      const tierBoost = object.temperature === "hot" ? 0.2 : object.temperature === "warm" ? 0.1 : 0;
      const exactBoost = exactEntity
        ? 1
        : exactTitle
          ? 0.8
          : Math.min(0.6, longestMatch / 40);
      hits.push({ object, score: Number((lexical + tierBoost + exactBoost).toFixed(6)), exact });
    }
    return hits
      .sort((left, right) => right.score - left.score || right.object.updatedAt.localeCompare(left.object.updatedAt))
      .slice(0, requestedLimit);
  }

  putMemoryObjectMember(member: MemoryObjectMember): MemoryObjectMember {
    this.requireWritable();
    const object = this.getMemoryObject(member.objectId);
    if (object === undefined) this.notFound(`Memory object ${member.objectId} was not found`);
    const sanitized = redactSensitiveValue(member).value;
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      this.database.prepare(`
        INSERT INTO memory_object_members(
          object_id, member_type, member_id, role, score, status, revision,
          added_at, updated_at, origin_action_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(object_id, member_type, member_id) DO UPDATE SET
          role = excluded.role, score = excluded.score, status = excluded.status,
          revision = excluded.revision, updated_at = excluded.updated_at,
          origin_action_id = excluded.origin_action_id
      `).run(
        sanitized.objectId,
        sanitized.memberType,
        sanitized.memberId,
        sanitized.role,
        sanitized.score,
        sanitized.status,
        revision,
        sanitized.addedAt,
        sanitized.updatedAt,
        sanitized.originActionId ?? null,
      );
      this.bumpMemoryGeneration();
      return sanitized;
    })();
  }

  listMemoryObjectMembers(
    objectId: string,
    scope?: ScopeRef,
    includeRemoved = false,
  ): MemoryObjectMember[] {
    const object = this.getMemoryObject(objectId, scope);
    if (object === undefined) return [];
    const rows = this.database.prepare(`
      SELECT * FROM memory_object_members
      WHERE object_id = ? AND (? = 1 OR status = 'active')
      ORDER BY score DESC, added_at, member_type, member_id
    `).all(objectId, includeRemoved ? 1 : 0) as Row[];
    return rows.map((row) => this.decodeMemoryObjectMember(row));
  }

  listObjectsForMember(
    memberType: MemoryObjectMember["memberType"],
    memberId: string,
    scope: ScopeRef,
  ): MemoryObject[] {
    const rows = this.database.prepare(`
      SELECT o.* FROM memory_object_members m
      JOIN memory_objects o ON o.object_id = m.object_id
      WHERE m.member_type = @memberType AND m.member_id = @memberId AND m.status = 'active'
        AND ${this.aclSql(true, "o")}
      ORDER BY o.updated_at DESC, o.object_id
    `).all({ memberType, memberId, ...this.aclParams(scope) }) as Row[];
    return rows.map((row) => this.decodeMemoryObject(row));
  }

  putMemoryRelation(relation: MemoryRelation): MemoryRelation {
    this.requireWritable();
    const sanitized = redactSensitiveValue(relation).value;
    if (!Number.isFinite(sanitized.confidence) || sanitized.confidence < 0 || sanitized.confidence > 1) {
      throw new ProtocolError({ code: "INVALID_REQUEST", message: "Memory relation confidence is invalid" });
    }
    this.assertSourceRefs(sanitized.evidenceRefs, sanitized.scope);
    const existingRow = this.database.prepare("SELECT * FROM memory_relations WHERE relation_id = ?")
      .get(sanitized.relationId) as Row | undefined;
    const existing = existingRow === undefined ? undefined : this.decodeMemoryRelation(existingRow);
    if (existing !== undefined && existing.version > sanitized.version) {
      this.versionConflict(`Memory relation ${sanitized.relationId} version moved backwards`);
    }
    const recordHash = sha256(canonicalJson(sanitized));
    if (existingRow !== undefined && String(existingRow.record_hash) === recordHash) return existing as MemoryRelation;
    if (existingRow === undefined) this.assertNotTombstoned("memory_relation", sanitized.relationId);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      if (existingRow === undefined) {
        this.database.prepare(`
          INSERT INTO memory_relations(
            relation_id, revision, user_id, workspace_id, session_id,
            from_type, from_id, to_type, to_id, relation_type, status,
            confidence, version, created_at, updated_at, encrypted_payload, record_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sanitized.relationId,
          revision,
          sanitized.scope.userId,
          sanitized.scope.workspaceId ?? null,
          sanitized.scope.sessionId ?? null,
          sanitized.from.type,
          sanitized.from.id,
          sanitized.to.type,
          sanitized.to.id,
          sanitized.relation,
          sanitized.status,
          sanitized.confidence,
          sanitized.version,
          sanitized.createdAt,
          sanitized.updatedAt,
          this.seal("memory_relation", sanitized.relationId, sanitized),
          recordHash,
        );
      } else {
        this.assertAcl(existingRow, sanitized.scope, true);
        this.database.prepare(`
          UPDATE memory_relations SET revision = ?, from_type = ?, from_id = ?,
            to_type = ?, to_id = ?, relation_type = ?, status = ?, confidence = ?,
            version = ?, updated_at = ?, encrypted_payload = ?, record_hash = ?
          WHERE relation_id = ?
        `).run(
          revision,
          sanitized.from.type,
          sanitized.from.id,
          sanitized.to.type,
          sanitized.to.id,
          sanitized.relation,
          sanitized.status,
          sanitized.confidence,
          sanitized.version,
          sanitized.updatedAt,
          this.seal("memory_relation", sanitized.relationId, sanitized),
          recordHash,
          sanitized.relationId,
        );
      }
      this.database.prepare("DELETE FROM source_links WHERE owner_type = 'memory_relation' AND owner_id = ?")
        .run(sanitized.relationId);
      if (sanitized.evidenceRefs.length > 0) {
        this.linkSources("memory_relation", sanitized.relationId, sanitized.evidenceRefs);
      }
      this.bumpMemoryGeneration();
      return sanitized;
    })();
  }

  getMemoryRelation(relationId: string, scope?: ScopeRef): MemoryRelation | undefined {
    const row = this.database.prepare("SELECT * FROM memory_relations WHERE relation_id = ?")
      .get(relationId) as Row | undefined;
    if (row === undefined) return undefined;
    if (scope !== undefined) this.assertAcl(row, scope, true);
    return this.decodeMemoryRelation(row);
  }

  listMemoryRelations(
    scope: ScopeRef,
    options: {
      nodeType?: string;
      nodeId?: string;
      relation?: MemoryRelation["relation"];
      includeInactive?: boolean;
      limit?: number;
    } = {},
  ): MemoryRelation[] {
    const rows = this.database.prepare(`
      SELECT * FROM memory_relations
      WHERE ${this.aclSql(true)}
        AND (@includeInactive = 1 OR status IN ('active', 'disputed'))
        AND (@nodeId IS NULL OR (
          (from_id = @nodeId AND (@nodeType IS NULL OR from_type = @nodeType))
          OR (to_id = @nodeId AND (@nodeType IS NULL OR to_type = @nodeType))
        ))
        AND (@relation IS NULL OR relation_type = @relation)
      ORDER BY updated_at DESC, relation_id
      LIMIT @limit
    `).all({
      ...this.aclParams(scope),
      includeInactive: options.includeInactive ? 1 : 0,
      nodeType: options.nodeType ?? null,
      nodeId: options.nodeId ?? null,
      relation: options.relation ?? null,
      limit: Math.max(1, Math.min(options.limit ?? 500, 5_000)),
    }) as Row[];
    return rows.map((row) => this.decodeMemoryRelation(row));
  }

  putMemoryVersion(version: MemoryVersion): MemoryVersion {
    this.requireWritable();
    const sanitized = redactSensitiveValue(version).value;
    this.assertUnscopedSourceRefs(sanitized.evidenceRefs);
    const written = this.putAuxiliary(
      "memory_version",
      "memory_versions",
      "version_id",
      sanitized.versionId,
      sanitized,
      ["memory_type", "memory_id", "version", "operation", "maintenance_action_id", "created_at"],
      [
        sanitized.memoryType,
        sanitized.memoryId,
        sanitized.version,
        sanitized.operation,
        sanitized.maintenanceActionId ?? null,
        sanitized.createdAt,
      ],
    );
    if (written.evidenceRefs.length > 0) {
      this.linkSources("memory_version", written.versionId, written.evidenceRefs);
    }
    return written;
  }

  listMemoryVersions(memoryType: MemoryVersion["memoryType"], memoryId: string): MemoryVersion[] {
    const rows = this.database.prepare(`
      SELECT * FROM memory_versions WHERE memory_type = ? AND memory_id = ?
      ORDER BY version, revision
    `).all(memoryType, memoryId) as Row[];
    return rows.map((row) =>
      this.open<MemoryVersion>("memory_version", String(row.version_id), String(row.encrypted_payload)));
  }

  putContradiction(contradiction: Contradiction): Contradiction {
    this.requireWritable();
    const sanitized = redactSensitiveValue(contradiction).value;
    if (sanitized.evidenceRefs.length === 0) {
      throw new ProtocolError({ code: "INVALID_REQUEST", message: "Contradictions require evidence" });
    }
    this.assertSourceRefs(sanitized.evidenceRefs, sanitized.scope);
    const oldClaim = this.getWorldClaim(
      sanitized.oldClaim.claimId,
      sanitized.oldClaim.version,
      sanitized.scope,
    );
    const newClaim = this.getWorldClaim(
      sanitized.newClaim.claimId,
      sanitized.newClaim.version,
      sanitized.scope,
    );
    if (oldClaim === undefined || newClaim === undefined) {
      this.notFound("Contradiction claim dependency was not found");
    }
    const existingRow = this.database.prepare("SELECT * FROM contradictions WHERE contradiction_id = ?")
      .get(sanitized.contradictionId) as Row | undefined;
    const existing = existingRow === undefined ? undefined : this.decodeContradiction(existingRow);
    if (existing !== undefined && existing.version > sanitized.version) {
      this.versionConflict(`Contradiction ${sanitized.contradictionId} version moved backwards`);
    }
    const recordHash = sha256(canonicalJson(sanitized));
    if (existingRow !== undefined && String(existingRow.record_hash) === recordHash) return existing as Contradiction;
    if (existingRow === undefined) this.assertNotTombstoned("contradiction", sanitized.contradictionId);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const values = [
        sanitized.scope.userId,
        sanitized.scope.workspaceId ?? null,
        sanitized.scope.sessionId ?? null,
        sanitized.oldClaim.claimId,
        sanitized.oldClaim.version,
        sanitized.newClaim.claimId,
        sanitized.newClaim.version,
        sanitized.currentPreferredClaim?.claimId ?? null,
        sanitized.currentPreferredClaim?.version ?? null,
        sanitized.status,
        sanitized.version,
        sanitized.createdAt,
        sanitized.updatedAt,
        this.seal("contradiction", sanitized.contradictionId, sanitized),
        recordHash,
      ];
      if (existingRow === undefined) {
        this.database.prepare(`
          INSERT INTO contradictions(
            contradiction_id, revision, user_id, workspace_id, session_id,
            old_claim_id, old_claim_version, new_claim_id, new_claim_version,
            preferred_claim_id, preferred_claim_version, status, version,
            created_at, updated_at, encrypted_payload, record_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(sanitized.contradictionId, revision, ...values);
      } else {
        this.assertAcl(existingRow, sanitized.scope, true);
        this.database.prepare(`
          UPDATE contradictions SET revision = ?, user_id = ?, workspace_id = ?, session_id = ?,
            old_claim_id = ?, old_claim_version = ?, new_claim_id = ?, new_claim_version = ?,
            preferred_claim_id = ?, preferred_claim_version = ?, status = ?, version = ?,
            created_at = ?, updated_at = ?, encrypted_payload = ?, record_hash = ?
          WHERE contradiction_id = ?
        `).run(revision, ...values, sanitized.contradictionId);
      }
      this.database.prepare("DELETE FROM source_links WHERE owner_type = 'contradiction' AND owner_id = ?")
        .run(sanitized.contradictionId);
      this.linkSources("contradiction", sanitized.contradictionId, sanitized.evidenceRefs);
      this.bumpMemoryGeneration();
      return sanitized;
    })();
  }

  getContradiction(contradictionId: string, scope?: ScopeRef): Contradiction | undefined {
    const row = this.database.prepare("SELECT * FROM contradictions WHERE contradiction_id = ?")
      .get(contradictionId) as Row | undefined;
    if (row === undefined) return undefined;
    if (scope !== undefined) this.assertAcl(row, scope, true);
    return this.decodeContradiction(row);
  }

  listContradictions(
    scope: ScopeRef,
    options: { claimIds?: readonly string[]; includeResolved?: boolean; limit?: number } = {},
  ): Contradiction[] {
    const claimIds = options.claimIds ?? [];
    const claimSql = claimIds.length === 0
      ? ""
      : `AND (old_claim_id IN (${claimIds.map((_, index) => `@claim${index}`).join(", ")})
        OR new_claim_id IN (${claimIds.map((_, index) => `@claim${index}`).join(", ")}))`;
    const rows = this.database.prepare(`
      SELECT * FROM contradictions
      WHERE ${this.aclSql(true)}
        AND (@includeResolved = 1 OR status = 'unresolved')
        ${claimSql}
      ORDER BY updated_at DESC, contradiction_id
      LIMIT @limit
    `).all({
      ...this.aclParams(scope),
      includeResolved: options.includeResolved ? 1 : 0,
      limit: Math.max(1, Math.min(options.limit ?? 200, 2_000)),
      ...Object.fromEntries(claimIds.map((claimId, index) => [`claim${index}`, claimId])),
    }) as Row[];
    return rows.map((row) => this.decodeContradiction(row));
  }

  putMemoryTemperature(temperature: MemoryTemperature): MemoryTemperature {
    this.requireWritable();
    const sanitized = redactSensitiveValue(temperature).value;
    const recordHash = sha256(canonicalJson(sanitized));
    const existing = this.database.prepare(`
      SELECT * FROM memory_temperatures WHERE memory_type = ? AND memory_id = ?
    `).get(sanitized.memoryType, sanitized.memoryId) as Row | undefined;
    if (existing !== undefined && String(existing.record_hash) === recordHash) {
      return this.decodeMemoryTemperature(existing);
    }
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      this.database.prepare(`
        INSERT INTO memory_temperatures(
          memory_type, memory_id, revision, user_id, workspace_id, session_id,
          tier, score, access_count, retrieval_count, mention_count,
          last_accessed_at, last_mentioned_at, explicit_remember, active_project,
          pinned, updated_at, encrypted_payload, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_type, memory_id) DO UPDATE SET
          revision = excluded.revision, user_id = excluded.user_id,
          workspace_id = excluded.workspace_id, session_id = excluded.session_id,
          tier = excluded.tier, score = excluded.score, access_count = excluded.access_count,
          retrieval_count = excluded.retrieval_count, mention_count = excluded.mention_count,
          last_accessed_at = excluded.last_accessed_at, last_mentioned_at = excluded.last_mentioned_at,
          explicit_remember = excluded.explicit_remember, active_project = excluded.active_project,
          pinned = excluded.pinned, updated_at = excluded.updated_at,
          encrypted_payload = excluded.encrypted_payload, record_hash = excluded.record_hash
      `).run(
        sanitized.memoryType,
        sanitized.memoryId,
        revision,
        sanitized.scope.userId,
        sanitized.scope.workspaceId ?? null,
        sanitized.scope.sessionId ?? null,
        sanitized.tier,
        sanitized.score,
        sanitized.accessCount,
        sanitized.retrievalCount,
        sanitized.mentionCount,
        sanitized.lastAccessedAt ?? null,
        sanitized.lastMentionedAt ?? null,
        sanitized.explicitRemember ? 1 : 0,
        sanitized.activeProject ? 1 : 0,
        sanitized.pinned ? 1 : 0,
        sanitized.updatedAt,
        this.seal(
          "memory_temperature",
          `${sanitized.memoryType}${OWNER_ID_SEPARATOR}${sanitized.memoryId}`,
          sanitized,
        ),
        recordHash,
      );
      return sanitized;
    })();
  }

  getMemoryTemperature(
    memoryType: MemoryTemperature["memoryType"],
    memoryId: string,
    scope?: ScopeRef,
  ): MemoryTemperature | undefined {
    const row = this.database.prepare(`
      SELECT * FROM memory_temperatures WHERE memory_type = ? AND memory_id = ?
    `).get(memoryType, memoryId) as Row | undefined;
    if (row === undefined) return undefined;
    if (scope !== undefined) this.assertAcl(row, scope, true);
    return this.decodeMemoryTemperature(row);
  }

  listMemoryTemperatures(scope: ScopeRef, tier?: MemoryTemperature["tier"]): MemoryTemperature[] {
    const rows = this.database.prepare(`
      SELECT * FROM memory_temperatures
      WHERE ${this.aclSql(true)} AND (@tier IS NULL OR tier = @tier)
      ORDER BY score DESC, updated_at DESC
    `).all({ ...this.aclParams(scope), tier: tier ?? null }) as Row[];
    return rows.map((row) => this.decodeMemoryTemperature(row));
  }

  recordMemoryAccess(
    memoryType: MemoryTemperature["memoryType"],
    memoryId: string,
    scope: ScopeRef,
    options: { retrieved?: boolean; mentioned?: boolean; explicitRoute?: boolean; at?: string } = {},
  ): MemoryTemperature {
    const at = options.at ?? this.isoNow();
    const current = this.getMemoryTemperature(memoryType, memoryId, scope);
    const tier =
      options.explicitRoute && (current?.tier === "cold" || current?.tier === "archive")
        ? "warm"
        : current?.tier ?? "warm";
    return this.putMemoryTemperature({
      memoryType,
      memoryId,
      scope,
      tier,
      score: options.explicitRoute ? Math.max(0.4, current?.score ?? 0) : current?.score ?? 0.4,
      accessCount: (current?.accessCount ?? 0) + 1,
      retrievalCount: (current?.retrievalCount ?? 0) + (options.retrieved === false ? 0 : 1),
      mentionCount: (current?.mentionCount ?? 0) + (options.mentioned ? 1 : 0),
      lastAccessedAt: at,
      ...(options.mentioned ? { lastMentionedAt: at } : current?.lastMentionedAt === undefined
        ? {}
        : { lastMentionedAt: current.lastMentionedAt }),
      explicitRemember: current?.explicitRemember ?? false,
      activeProject: current?.activeProject ?? false,
      pinned: current?.pinned ?? false,
      updatedAt: at,
    });
  }

  putRetrievalTrace(trace: RetrievalTrace): RetrievalTrace {
    this.requireWritable();
    const sanitized = redactSensitiveValue(trace).value;
    const turn = this.getTurn(sanitized.turnId, sanitized.scope);
    if (turn === undefined) this.notFound(`Turn ${sanitized.turnId} was not found`);
    const refs = this.sourceRefsInValue(sanitized);
    if (refs.length > 0) this.assertSourceRefs(refs, turn.scope);
    return this.putAuxiliary(
      "retrieval_trace",
      "retrieval_traces",
      "retrieval_id",
      sanitized.retrievalId,
      sanitized,
      [
        "turn_id",
        "user_id",
        "workspace_id",
        "session_id",
        "evidence_coverage",
        "should_abstain",
        "created_at",
      ],
      [
        sanitized.turnId,
        sanitized.scope.userId,
        sanitized.scope.workspaceId ?? null,
        sanitized.scope.sessionId ?? null,
        sanitized.evidenceCoverage,
        sanitized.shouldAbstain ? 1 : 0,
        sanitized.createdAt,
      ],
    );
  }

  listRetrievalTraces(turnId: string): RetrievalTrace[] {
    const rows = this.database.prepare(`
      SELECT * FROM retrieval_traces WHERE turn_id = ? ORDER BY created_at, retrieval_id
    `).all(turnId) as Row[];
    return rows.map((row) =>
      this.open<RetrievalTrace>("retrieval_trace", String(row.retrieval_id), String(row.encrypted_payload)));
  }

  /** Bounded history used by the offline Curator to derive routing-quality proxies. */
  listRetrievalTracesForScope(scope: ScopeRef, limit = 1_000): RetrievalTrace[] {
    const rows = this.database.prepare(`
      SELECT * FROM retrieval_traces
      WHERE ${this.aclSql(false)}
      ORDER BY created_at DESC, retrieval_id
      LIMIT @limit
    `).all({
      ...this.aclParams(scope),
      limit: Math.max(1, Math.min(limit, 10_000)),
    }) as Row[];
    return rows.map((row) =>
      this.open<RetrievalTrace>("retrieval_trace", String(row.retrieval_id), String(row.encrypted_payload)));
  }

  putMemoryQualityMetrics(metrics: MemoryQualityMetrics): MemoryQualityMetrics {
    const metricId = sha256(canonicalJson([
      metrics.ownerType,
      metrics.ownerId,
      metrics.scope,
      metrics.measuredAt,
    ]));
    return this.putAuxiliary(
      "memory_quality",
      "memory_quality_metrics",
      "metric_id",
      metricId,
      metrics,
      ["owner_type", "owner_id", "user_id", "workspace_id", "session_id", "measured_at"],
      [
        metrics.ownerType,
        metrics.ownerId,
        metrics.scope.userId,
        metrics.scope.workspaceId ?? null,
        metrics.scope.sessionId ?? null,
        metrics.measuredAt,
      ],
    );
  }

  listMemoryQualityMetrics(
    scope: ScopeRef,
    owner?: { type: MemoryQualityMetrics["ownerType"]; id: string },
    limit = 500,
  ): MemoryQualityMetrics[] {
    const rows = this.database.prepare(`
      SELECT * FROM memory_quality_metrics
      WHERE ${this.aclSql(true)}
        AND (@ownerType IS NULL OR (owner_type = @ownerType AND owner_id = @ownerId))
      ORDER BY measured_at DESC, metric_id
      LIMIT @limit
    `).all({
      ...this.aclParams(scope),
      ownerType: owner?.type ?? null,
      ownerId: owner?.id ?? null,
      limit: Math.max(1, Math.min(limit, 5_000)),
    }) as Row[];
    return rows.map((row) =>
      this.open<MemoryQualityMetrics>("memory_quality", String(row.metric_id), String(row.encrypted_payload)));
  }

  enqueueMaintenanceJob(
    type: MaintenanceJobType,
    scope: ScopeRef,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    dryRun = false,
  ): MaintenanceJob {
    this.requireWritable();
    const jobId = `maintenance_${sha256(idempotencyKey).slice(0, 32)}`;
    const sanitizedPayload = redactSensitiveValue(payload).value;
    const requestHash = sha256(canonicalJson({ type, scope, payload: sanitizedPayload, idempotencyKey, dryRun }));
    const existingRow = this.database.prepare("SELECT * FROM maintenance_jobs WHERE job_id = ?")
      .get(jobId) as Row | undefined;
    if (existingRow !== undefined) {
      if (String(existingRow.record_hash) !== requestHash) {
        this.versionConflict(`Maintenance idempotency key ${idempotencyKey} was reused`);
      }
      return this.decodeMaintenanceJob(existingRow);
    }
    this.assertNotTombstoned("maintenance_job", jobId);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const now = this.isoNow();
      const job: MaintenanceJob = {
        jobId,
        scope,
        type,
        status: "pending",
        dryRun,
        idempotencyKey,
        attempts: 0,
        payload: sanitizedPayload,
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      };
      this.database.prepare(`
        INSERT INTO maintenance_jobs(
          job_id, revision, idempotency_key, user_id, workspace_id, session_id,
          job_type, status, dry_run, attempts, cursor, available_at, leased_at,
          completed_at, last_error, created_at, updated_at, encrypted_payload, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?)
      `).run(
        jobId,
        revision,
        idempotencyKey,
        scope.userId,
        scope.workspaceId ?? null,
        scope.sessionId ?? null,
        type,
        dryRun ? 1 : 0,
        now,
        now,
        now,
        this.seal("maintenance_job", jobId, job),
        requestHash,
      );
      this.putMaintenanceAudit({
        auditId: randomUUID(),
        revision: 0,
        scope,
        jobId,
        event: "job_enqueued",
        details: { type, dryRun },
        createdAt: now,
      });
      return job;
    })();
  }

  getMaintenanceJob(jobId: string, scope?: ScopeRef): MaintenanceJob | undefined {
    const row = this.database.prepare("SELECT * FROM maintenance_jobs WHERE job_id = ?")
      .get(jobId) as Row | undefined;
    if (row === undefined) return undefined;
    if (scope !== undefined) this.assertAcl(row, scope, true);
    return this.decodeMaintenanceJob(row);
  }

  listMaintenanceJobs(
    scope?: ScopeRef,
    status?: MaintenanceJobStatus,
    limit = 500,
  ): MaintenanceJob[] {
    const rows = scope === undefined
      ? this.database.prepare(`
          SELECT * FROM maintenance_jobs
          WHERE (? IS NULL OR status = ?)
          ORDER BY revision DESC LIMIT ?
        `).all(status ?? null, status ?? null, Math.max(1, Math.min(limit, 5_000))) as Row[]
      : this.database.prepare(`
          SELECT * FROM maintenance_jobs
          WHERE ${this.aclSql(true)} AND (@status IS NULL OR status = @status)
          ORDER BY revision DESC LIMIT @limit
        `).all({
          ...this.aclParams(scope),
          status: status ?? null,
          limit: Math.max(1, Math.min(limit, 5_000)),
        }) as Row[];
    return rows.map((row) => this.decodeMaintenanceJob(row));
  }

  claimMaintenanceJobs(
    limit = 25,
    options: { now?: string; leaseMs?: number; maxAttempts?: number } = {},
  ): MaintenanceJob[] {
    this.requireWritable();
    const now = options.now ?? this.isoNow();
    const leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);
    const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    const staleBefore = new Date(Date.parse(now) - leaseMs).toISOString();
    return this.database.transaction(() => {
      this.database.prepare(`
        UPDATE maintenance_jobs SET status = 'pending', leased_at = NULL, updated_at = ?
        WHERE status = 'running' AND leased_at < ? AND attempts < ?
      `).run(now, staleBefore, maxAttempts);
      this.database.prepare(`
        UPDATE maintenance_jobs SET status = 'failed', leased_at = NULL,
          last_error = COALESCE(last_error, 'maximum attempts exceeded'), updated_at = ?
        WHERE status IN ('pending', 'running') AND attempts >= ?
      `).run(now, maxAttempts);
      const rows = this.database.prepare(`
        SELECT * FROM maintenance_jobs
        WHERE status = 'pending' AND available_at <= ? AND attempts < ?
        ORDER BY revision, job_id LIMIT ?
      `).all(now, maxAttempts, Math.max(1, Math.min(limit, 100))) as Row[];
      const claimed: MaintenanceJob[] = [];
      for (const row of rows) {
        const job = this.decodeMaintenanceJob(row);
        const revision = this.nextRevision();
        const updated: MaintenanceJob = {
          ...job,
          status: "running",
          attempts: job.attempts + 1,
          leasedAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          UPDATE maintenance_jobs SET revision = ?, status = 'running', attempts = ?,
            leased_at = ?, updated_at = ?, encrypted_payload = ? WHERE job_id = ?
        `).run(
          revision,
          updated.attempts,
          now,
          now,
          this.seal("maintenance_job", job.jobId, updated),
          job.jobId,
        );
        claimed.push(updated);
      }
      return claimed;
    })();
  }

  completeMaintenanceJob(jobId: string, cursor?: string): MaintenanceJob {
    return this.updateMaintenanceJobState(jobId, "completed", {
      ...(cursor === undefined ? {} : { cursor }),
      completedAt: this.isoNow(),
    });
  }

  failMaintenanceJob(
    jobId: string,
    error: string,
    options: { now?: string; maxAttempts?: number } = {},
  ): MaintenanceJob {
    const job = this.getMaintenanceJob(jobId);
    if (job === undefined) this.notFound(`Maintenance job ${jobId} was not found`);
    const now = options.now ?? this.isoNow();
    const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    const terminal = job.attempts >= maxAttempts;
    const availableAt = new Date(
      Date.parse(now) + Math.min(300_000, 1_000 * (2 ** Math.max(0, job.attempts - 1))),
    ).toISOString();
    return this.updateMaintenanceJobState(jobId, terminal ? "failed" : "pending", {
      availableAt,
      lastError: redactSensitiveContent(error).value.slice(0, 500),
    });
  }

  putMaintenanceAction(action: MaintenanceAction): MaintenanceAction {
    this.requireWritable();
    const sanitized = redactSensitiveValue(action).value;
    const recordHash = sha256(canonicalJson(sanitized));
    const existingRow = this.database.prepare("SELECT * FROM maintenance_actions WHERE action_id = ?")
      .get(sanitized.actionId) as Row | undefined;
    if (existingRow !== undefined) {
      const existing = this.decodeMaintenanceAction(existingRow);
      if (String(existingRow.record_hash) !== recordHash) {
        this.versionConflict(`Maintenance action ${sanitized.actionId} already exists with different content`);
      }
      return existing;
    }
    const job = this.getMaintenanceJob(sanitized.jobId);
    if (job === undefined) this.notFound(`Maintenance job ${sanitized.jobId} was not found`);
    this.assertNotTombstoned("maintenance_action", sanitized.actionId);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      this.database.prepare(`
        INSERT INTO maintenance_actions(
          action_id, revision, job_id, sequence, action_type, target_type,
          target_id, status, reversible, created_at, applied_at, rolled_back_at,
          encrypted_payload, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sanitized.actionId,
        revision,
        sanitized.jobId,
        sanitized.sequence,
        sanitized.type,
        sanitized.targetType,
        sanitized.targetId,
        sanitized.status,
        sanitized.reversible ? 1 : 0,
        sanitized.createdAt,
        sanitized.appliedAt ?? null,
        sanitized.rolledBackAt ?? null,
        this.seal("maintenance_action", sanitized.actionId, sanitized),
        recordHash,
      );
      return sanitized;
    })();
  }

  updateMaintenanceAction(action: MaintenanceAction): MaintenanceAction {
    this.requireWritable();
    const current = this.getMaintenanceAction(action.actionId);
    if (current === undefined) this.notFound(`Maintenance action ${action.actionId} was not found`);
    const sanitized = redactSensitiveValue(action).value;
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const recordHash = sha256(canonicalJson(sanitized));
      this.database.prepare(`
        UPDATE maintenance_actions SET revision = ?, status = ?, reversible = ?,
          applied_at = ?, rolled_back_at = ?, encrypted_payload = ?, record_hash = ?
        WHERE action_id = ?
      `).run(
        revision,
        sanitized.status,
        sanitized.reversible ? 1 : 0,
        sanitized.appliedAt ?? null,
        sanitized.rolledBackAt ?? null,
        this.seal("maintenance_action", sanitized.actionId, sanitized),
        recordHash,
        sanitized.actionId,
      );
      return sanitized;
    })();
  }

  getMaintenanceAction(actionId: string): MaintenanceAction | undefined {
    const row = this.database.prepare("SELECT * FROM maintenance_actions WHERE action_id = ?")
      .get(actionId) as Row | undefined;
    return row === undefined ? undefined : this.decodeMaintenanceAction(row);
  }

  listMaintenanceActions(jobId: string): MaintenanceAction[] {
    const rows = this.database.prepare(`
      SELECT * FROM maintenance_actions WHERE job_id = ? ORDER BY sequence, action_id
    `).all(jobId) as Row[];
    return rows.map((row) => this.decodeMaintenanceAction(row));
  }

  putMaintenanceAudit(record: MaintenanceAuditRecord): MaintenanceAuditRecord {
    this.requireWritable();
    const auditId = record.auditId || randomUUID();
    const sanitized = redactSensitiveValue({ ...record, auditId }).value;
    return this.putAuxiliary(
      "memory_audit",
      "memory_audit_log",
      "audit_id",
      auditId,
      sanitized,
      ["user_id", "workspace_id", "session_id", "job_id", "action_id", "event", "created_at"],
      [
        sanitized.scope.userId,
        sanitized.scope.workspaceId ?? null,
        sanitized.scope.sessionId ?? null,
        sanitized.jobId ?? null,
        sanitized.actionId ?? null,
        sanitized.event,
        sanitized.createdAt,
      ],
    );
  }

  listMaintenanceAudit(scope: ScopeRef, limit = 500): MaintenanceAuditRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM memory_audit_log WHERE ${this.aclSql(true)}
      ORDER BY created_at DESC, audit_id LIMIT @limit
    `).all({ ...this.aclParams(scope), limit: Math.max(1, Math.min(limit, 5_000)) }) as Row[];
    return rows.map((row) => {
      const record = this.open<MaintenanceAuditRecord>(
        "memory_audit",
        String(row.audit_id),
        String(row.encrypted_payload),
      );
      return { ...record, revision: Number(row.revision) };
    });
  }

  getOwnerMetadata(
    kind: SearchKind,
    id: string,
    scope: ScopeRef,
    maxRevision = this.getRevision(),
  ): OwnerMetadata | undefined {
    const row = kind === "source_event"
      ? this.database.prepare("SELECT * FROM source_events WHERE event_id = ?").get(id) as Row | undefined
      : kind === "world_claim"
        ? (() => {
            const [claimId, version] = this.parseVersionedId(id);
            return this.database.prepare("SELECT * FROM world_claims WHERE claim_id = ? AND version = ?")
              .get(claimId, version) as Row | undefined;
          })()
        : kind === "policy"
          ? (() => {
              const [policyId, version] = this.parseVersionedId(id);
              return this.database.prepare("SELECT * FROM policies WHERE policy_id = ? AND version = ?")
                .get(policyId, version) as Row | undefined;
            })()
          : kind === "episode"
            ? this.database.prepare("SELECT * FROM episodes WHERE episode_id = ?").get(id) as Row | undefined
            : this.database.prepare("SELECT * FROM memory_objects WHERE object_id = ?").get(id) as Row | undefined;
    if (row === undefined || Number(row.revision) > Math.min(maxRevision, this.getRevision())) return undefined;
    try {
      this.assertAcl(row, scope, kind === "world_claim" || kind === "policy" || kind === "memory_object");
    } catch (error) {
      if (error instanceof ProtocolError && error.shape.code === "SCOPE_DENIED") return undefined;
      throw error;
    }
    const occurredAt = kind === "source_event"
      ? String(row.occurred_at)
      : kind === "episode"
        ? String(row.ended_at)
        : kind === "memory_object"
          ? String(row.updated_at)
        : undefined;
    return {
      kind,
      id,
      revision: Number(row.revision),
      ...(occurredAt === undefined ? {} : { occurredAt }),
      ...(typeof row.session_id === "string" ? { sessionId: row.session_id } : {}),
    };
  }

  putEmbedding(
    ownerType: SearchKind,
    ownerId: string,
    scope: ScopeRef,
    provider: string,
    model: string,
    vector: readonly number[],
  ): StoredEmbedding {
    this.requireWritable();
    const metadata = this.getOwnerMetadata(ownerType, ownerId, scope);
    if (metadata === undefined) this.notFound(`${ownerType} ${ownerId} was not found in scope`);
    if (vector.length < 8 || vector.length > 4_096 || vector.some((value) => !Number.isFinite(value))) {
      throw new ProtocolError({ code: "INVALID_REQUEST", message: "Embedding vector is invalid" });
    }
    const normalized = Float32Array.from(vector);
    const bytes = Buffer.from(normalized.buffer, normalized.byteOffset, normalized.byteLength);
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO embeddings(owner_type, owner_id, provider, model, vector)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(owner_type, owner_id, provider, model)
        DO UPDATE SET vector = excluded.vector
      `).run(ownerType, ownerId, provider, model, bytes);
      this.database.prepare(`
        DELETE FROM embedding_buckets
        WHERE owner_type = ? AND owner_id = ? AND provider = ? AND model = ?
      `).run(ownerType, ownerId, provider, model);
      const insertBucket = this.database.prepare(`
        INSERT OR IGNORE INTO embedding_buckets(provider, model, bucket, owner_type, owner_id)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const bucket of this.embeddingBuckets(vector)) {
        insertBucket.run(provider, model, bucket, ownerType, ownerId);
      }
    })();
    return { ...metadata, ownerType, ownerId, provider, model, vector: [...normalized] };
  }

  getEmbedding(
    ownerType: SearchKind,
    ownerId: string,
    scope: ScopeRef,
    provider: string,
    model: string,
    maxRevision = this.getRevision(),
  ): StoredEmbedding | undefined {
    const metadata = this.getOwnerMetadata(ownerType, ownerId, scope, maxRevision);
    if (metadata === undefined) return undefined;
    const row = this.database.prepare(`
      SELECT vector FROM embeddings WHERE owner_type = ? AND owner_id = ? AND provider = ? AND model = ?
    `).get(ownerType, ownerId, provider, model) as Row | undefined;
    if (row === undefined || !Buffer.isBuffer(row.vector)) return undefined;
    const bytes = row.vector;
    const copied = Uint8Array.from(bytes);
    return {
      ...metadata,
      ownerType,
      ownerId,
      provider,
      model,
      vector: [...new Float32Array(copied.buffer)],
    };
  }

  listEmbeddings(
    scope: ScopeRef,
    provider: string,
    model: string,
    options: { kinds?: SearchKind[]; maxRevision?: number; limit?: number; queryVector?: readonly number[] } = {},
  ): StoredEmbedding[] {
    const kinds = new Set(options.kinds ?? ["source_event", "world_claim", "policy", "episode"]);
    const requestedLimit = Math.max(1, Math.min(options.limit ?? 1_000, 10_000));
    const buckets = options.queryVector === undefined ? [] : this.embeddingBuckets(options.queryVector);
    const rows = buckets.length === 0
      ? this.database.prepare(`
          SELECT * FROM embeddings WHERE provider = ? AND model = ?
          ORDER BY owner_type, owner_id LIMIT ?
        `).all(provider, model, Math.min(5_000, requestedLimit * 5)) as Row[]
      : this.database.prepare(`
          SELECT e.*, count(*) AS bucket_overlap
          FROM embedding_buckets b
          JOIN embeddings e ON e.provider = b.provider AND e.model = b.model
            AND e.owner_type = b.owner_type AND e.owner_id = b.owner_id
          WHERE b.provider = @provider AND b.model = @model
            AND b.bucket IN (${buckets.map((_, index) => `@bucket${index}`).join(", ")})
          GROUP BY e.owner_type, e.owner_id, e.provider, e.model
          ORDER BY bucket_overlap DESC, e.owner_type, e.owner_id
          LIMIT @candidateLimit
        `).all({
          provider,
          model,
          candidateLimit: Math.min(5_000, requestedLimit * 5),
          ...Object.fromEntries(buckets.map((bucket, index) => [`bucket${index}`, bucket])),
        }) as Row[];
    const result: StoredEmbedding[] = [];
    for (const row of rows) {
      const ownerType = String(row.owner_type) as SearchKind;
      if (!kinds.has(ownerType) || !Buffer.isBuffer(row.vector)) continue;
      const ownerId = String(row.owner_id);
      const metadata = this.getOwnerMetadata(ownerType, ownerId, scope, options.maxRevision);
      if (metadata === undefined) continue;
      const copied = Uint8Array.from(row.vector);
      result.push({
        ...metadata,
        ownerType,
        ownerId,
        provider,
        model,
        vector: [...new Float32Array(copied.buffer)],
      });
      if (result.length >= requestedLimit) break;
    }
    return result;
  }

  replaceEntityIndex(ownerType: SearchKind, ownerId: string, scope: ScopeRef, tokens: readonly string[]): void {
    this.requireWritable();
    if (this.getOwnerMetadata(ownerType, ownerId, scope) === undefined) {
      this.notFound(`${ownerType} ${ownerId} was not found in scope`);
    }
    this.database.prepare(`DELETE FROM entity_edges WHERE to_type = ? AND to_id = ? AND relation = 'mentions'`)
      .run(ownerType, ownerId);
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO entity_edges(
        edge_id, user_id, workspace_id, from_type, from_id, to_type, to_id, relation
      ) VALUES (?, ?, ?, 'entity', ?, ?, ?, 'mentions')
    `);
    for (const token of this.normalizedEntityTokens(tokens)) {
      const entityId = this.entityTokenId(scope, token);
      const edgeId = sha256(canonicalJson([scope.userId, scope.workspaceId ?? null, entityId, ownerType, ownerId]));
      insert.run(edgeId, scope.userId, scope.workspaceId ?? null, entityId, ownerType, ownerId);
    }
  }

  linkEntityRelation(scope: ScopeRef, fromToken: string, toToken: string, relation: string): void {
    this.requireWritable();
    const [from, to] = this.normalizedEntityTokens([fromToken, toToken]);
    if (from === undefined || to === undefined || from === to) return;
    const fromId = this.entityTokenId(scope, from);
    const toId = this.entityTokenId(scope, to);
    const safeRelation = `relation:${sha256(relation.trim().toLowerCase()).slice(0, 16)}`;
    const edgeId = sha256(canonicalJson([scope.userId, scope.workspaceId ?? null, fromId, toId, safeRelation]));
    this.database.prepare(`
      INSERT OR IGNORE INTO entity_edges(
        edge_id, user_id, workspace_id, from_type, from_id, to_type, to_id, relation
      ) VALUES (?, ?, ?, 'entity', ?, 'entity', ?, ?)
    `).run(edgeId, scope.userId, scope.workspaceId ?? null, fromId, toId, safeRelation);
  }

  findEntityOwners(
    tokens: readonly string[],
    scope: ScopeRef,
    options: { kinds?: SearchKind[]; maxRevision?: number; maxDistance?: number; limit?: number } = {},
  ): EntityOwnerHit[] {
    const kinds = new Set(options.kinds ?? ["source_event", "world_claim", "policy", "episode"]);
    const maxDistance = Math.max(0, Math.min(options.maxDistance ?? 1, 2));
    const normalized = this.normalizedEntityTokens(tokens);
    const seedIds = new Set<string>();
    for (const token of normalized) {
      seedIds.add(this.entityTokenId({ userId: scope.userId }, token));
      if (scope.workspaceId !== undefined) seedIds.add(this.entityTokenId(scope, token));
    }
    const distance = new Map([...seedIds].map((id) => [id, 0]));
    let frontier = [...seedIds];
    for (let hop = 0; hop < maxDistance && frontier.length > 0; hop += 1) {
      const placeholders = frontier.map((_, index) => `@entity${index}`).join(", ");
      const rows = this.database.prepare(`
        SELECT from_id, to_id FROM entity_edges
        WHERE user_id = @userId
          AND (workspace_id IS NULL OR workspace_id = @workspaceId)
          AND from_type = 'entity' AND to_type = 'entity'
          AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))
      `).all({
        ...this.aclParams(scope),
        ...Object.fromEntries(frontier.map((id, index) => [`entity${index}`, id])),
      }) as Row[];
      const next: string[] = [];
      for (const row of rows) {
        for (const id of [String(row.from_id), String(row.to_id)]) {
          if (distance.has(id)) continue;
          distance.set(id, hop + 1);
          next.push(id);
        }
      }
      frontier = next;
    }
    if (distance.size === 0) return [];
    const ids = [...distance.keys()];
    const placeholders = ids.map((_, index) => `@entity${index}`).join(", ");
    const rows = this.database.prepare(`
      SELECT from_id, to_type, to_id FROM entity_edges
      WHERE user_id = @userId AND (workspace_id IS NULL OR workspace_id = @workspaceId)
        AND from_type = 'entity' AND relation = 'mentions' AND from_id IN (${placeholders})
    `).all({
      ...this.aclParams(scope),
      ...Object.fromEntries(ids.map((id, index) => [`entity${index}`, id])),
    }) as Row[];
    const best = new Map<string, EntityOwnerHit>();
    for (const row of rows) {
      const kind = String(row.to_type) as SearchKind;
      const id = String(row.to_id);
      if (!kinds.has(kind) || this.getOwnerMetadata(kind, id, scope, options.maxRevision) === undefined) continue;
      const hit: EntityOwnerHit = { kind, id, distance: distance.get(String(row.from_id)) ?? maxDistance };
      const key = `${kind}\u001f${id}`;
      const prior = best.get(key);
      if (prior === undefined || hit.distance < prior.distance) best.set(key, hit);
    }
    return [...best.values()]
      .sort((left, right) => left.distance - right.distance || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, Math.min(options.limit ?? 200, 2_000)));
  }

  search(query: string, scope: ScopeRef, options: SearchOptions = {}): StorageSearchResult {
    const ftsQuery = this.ftsQuery(query);
    const revision = Math.min(options.maxRevision ?? this.getRevision(), this.getRevision());
    const indexRevision = this.getIndexRevision();
    if (!ftsQuery) {
      return {
        snapshotRevision: revision,
        indexRevision,
        candidateCount: 0,
        hits: [],
        eventRefs: [],
        worldClaims: [],
        policies: [],
        episodes: [],
        memoryObjects: [],
      };
    }

    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const requestedKinds = new Set<SearchKind>(
      options.kinds ?? ["source_event", "world_claim", "policy", "episode"],
    );
    const rawHits: Array<{ kind: SearchKind; id: string; rank: number }> = [];
    const acl = { ...this.aclParams(scope), snapshotRevision: revision };

    if (requestedKinds.has("source_event")) {
      const rows = this.database.prepare(`
        SELECT source_events_fts.event_id AS id, bm25(source_events_fts) AS rank
        FROM source_events_fts
        JOIN source_events e ON e.event_id = source_events_fts.event_id
        WHERE source_events_fts MATCH @query
          AND ${this.aclSql(false, "e")} AND e.revision <= @snapshotRevision
        ORDER BY rank LIMIT @limit
      `).all({ ...acl, query: ftsQuery, limit }) as Row[];
      rawHits.push(...rows.map((row) => ({
        kind: "source_event" as const,
        id: String(row.id),
        rank: Number(row.rank),
      })));
    }

    if (requestedKinds.has("world_claim")) {
      const statusClause = options.includeInactive ? "" : "AND w.status IN ('active', 'disputed')";
      const rows = this.database.prepare(`
        SELECT world_claims_fts.row_key AS id, bm25(world_claims_fts) AS rank
        FROM world_claims_fts
        JOIN world_claims w
          ON world_claims_fts.row_key = (w.claim_id || '${OWNER_ID_SEPARATOR}' || w.version)
        WHERE world_claims_fts MATCH @query
          AND ${this.aclSql(true, "w")} AND w.revision <= @snapshotRevision ${statusClause}
        ORDER BY rank LIMIT @limit
      `).all({ ...acl, query: ftsQuery, limit }) as Row[];
      rawHits.push(...rows.map((row) => ({
        kind: "world_claim" as const,
        id: String(row.id),
        rank: Number(row.rank),
      })));
    }

    if (requestedKinds.has("policy")) {
      const statusClause = options.includeInactive ? "" : "AND p.review_status = 'approved'";
      const rows = this.database.prepare(`
        SELECT policies_fts.row_key AS id, bm25(policies_fts) AS rank
        FROM policies_fts
        JOIN policies p
          ON policies_fts.row_key = (p.policy_id || '${OWNER_ID_SEPARATOR}' || p.version)
        WHERE policies_fts MATCH @query
          AND ${this.aclSql(true, "p")} AND p.revision <= @snapshotRevision ${statusClause} AND NOT EXISTS (
            SELECT 1 FROM policies newer
            WHERE newer.policy_id = p.policy_id AND newer.version > p.version
              AND newer.revision <= @snapshotRevision
          )
        ORDER BY rank LIMIT @limit
      `).all({ ...acl, query: ftsQuery, limit }) as Row[];
      rawHits.push(...rows.map((row) => ({
        kind: "policy" as const,
        id: String(row.id),
        rank: Number(row.rank),
      })));
    }

    if (requestedKinds.has("episode")) {
      const rows = this.database.prepare(`
        SELECT episodes_fts.episode_id AS id, bm25(episodes_fts) AS rank
        FROM episodes_fts
        JOIN episodes e ON e.episode_id = episodes_fts.episode_id
        WHERE episodes_fts MATCH @query
          AND ${this.aclSql(false, "e")} AND e.revision <= @snapshotRevision
        ORDER BY rank LIMIT @limit
      `).all({ ...acl, query: ftsQuery, limit }) as Row[];
      rawHits.push(...rows.map((row) => ({
        kind: "episode" as const,
        id: String(row.id),
        rank: Number(row.rank),
      })));
    }

    if (requestedKinds.has("memory_object")) {
      const routes = this.routeMemoryObjects(query, scope, {
        maxRevision: revision,
        limit,
        candidateLimit: limit,
        partitionLimit: Math.min(limit, 40),
        ...(options.includeInactive === undefined ? {} : { includeArchive: options.includeInactive }),
      });
      rawHits.push(...routes.map((route) => ({
        kind: "memory_object" as const,
        id: route.object.objectId,
        rank: -route.score,
      })));
    }

    rawHits.sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
    const selected = rawHits.slice(0, limit);
    const eventRefs: SourceRef[] = [];
    const worldClaims: WorldClaim[] = [];
    const policies: StoredPolicy[] = [];
    const episodes: EpisodeMemory[] = [];
    const memoryObjects: MemoryObject[] = [];
    const hits: SearchHit[] = [];

    for (const hit of selected) {
      let sourceRefs: SourceRef[] = [];
      if (hit.kind === "source_event") {
        const event = this.required(this.getSourceEvent(hit.id, scope), `search event ${hit.id}`);
        const ref = this.toSourceRef(event);
        sourceRefs = [ref];
        eventRefs.push(ref);
      } else if (hit.kind === "world_claim") {
        const [claimId, version] = this.parseVersionedId(hit.id);
        const claim = this.required(this.getWorldClaim(claimId, version, scope), `search claim ${hit.id}`);
        this.assertSourceRefs(claim.sources, scope);
        sourceRefs = claim.sources;
        worldClaims.push(claim);
      } else if (hit.kind === "policy") {
        const [policyId, version] = this.parseVersionedId(hit.id);
        const policy = this.required(this.getPolicy(policyId, version, scope), `search policy ${hit.id}`);
        sourceRefs = policy.sources ?? [];
        this.assertSourceRefs(sourceRefs, scope);
        policies.push(policy);
      } else if (hit.kind === "episode") {
        const episode = this.required(this.getEpisode(hit.id, scope), `search episode ${hit.id}`);
        this.assertSourceRefs(episode.eventRefs, scope);
        sourceRefs = episode.eventRefs;
        episodes.push(episode);
      } else {
        const object = this.required(this.getMemoryObject(hit.id, scope), `search memory object ${hit.id}`);
        this.assertSourceRefs(object.evidenceRefs, scope);
        sourceRefs = object.evidenceRefs;
        memoryObjects.push(object);
      }
      hits.push({ kind: hit.kind, id: hit.id, score: -hit.rank, sourceRefs });
    }

    return {
      snapshotRevision: revision,
      indexRevision,
      candidateCount: rawHits.length,
      hits,
      eventRefs: this.uniqueSourceRefs(eventRefs),
      worldClaims,
      policies,
      episodes,
      memoryObjects,
    };
  }

  forget(selector: ForgetSelector): ForgetResult {
    this.requireWritable();
    if ((selector.entityType === undefined) !== (selector.entityId === undefined)) {
      throw new TypeError("entityType and entityId must be provided together");
    }

    return this.database.transaction(() => {
      const ids = selector.entityType
        ? [{
            type: selector.entityType,
            id: this.resolveForgetEntityId(selector.entityType, this.required(selector.entityId, "entityId")),
          }]
        : this.collectScopedEntities(selector);
      if (
        selector.entityType === undefined &&
        selector.sessionId !== undefined &&
        !ids.some((entity) => entity.type === "session" && entity.id === selector.sessionId)
      ) {
        ids.push({ type: "session", id: selector.sessionId });
      }
      if (ids.length === 0 && !selector.entityType) {
        return { revision: this.getRevision(), deleted: {}, tombstonesCreated: 0 };
      }
      const revision = this.nextRevision();
      const deletedAt = this.isoNow();
      const deleted: Record<string, number> = {};
      const seen = new Set<string>();
      let tombstonesCreated = 0;
      for (const entity of ids) {
        tombstonesCreated += this.deleteEntity(
          entity.type,
          entity.id,
          selector,
          revision,
          deletedAt,
          deleted,
          seen,
        );
      }
      this.database.prepare(`
        DELETE FROM memory_scope_registry
        WHERE NOT EXISTS (
          SELECT 1 FROM source_events e
          WHERE e.user_id = memory_scope_registry.user_id
            AND (
              (memory_scope_registry.workspace_id IS NULL AND e.workspace_id IS NULL)
              OR e.workspace_id = memory_scope_registry.workspace_id
            )
        )
      `).run();
      this.touchIndex(revision);
      return { revision, deleted, tombstonesCreated };
    })();
  }

  exportData(options: ExportOptions = {}): string {
    const rows = <T extends Row>(sql: string): T[] => this.database.prepare(sql).all() as T[];
    const sourceEvents = rows("SELECT * FROM source_events ORDER BY revision, event_id").map((row) => ({
      value: this.decodeSourceEvent(row),
      idempotencyKey: String(row.idempotency_key),
      originRevision: Number(row.origin_revision),
    }));
    const turns = rows("SELECT * FROM turns ORDER BY revision, turn_id").map((row) => this.decodeTurn(row));
    const observations = rows("SELECT * FROM observations ORDER BY revision, observation_id").map((row) => this.decodeObservation(row));
    const worldClaims = rows("SELECT * FROM world_claims ORDER BY revision, claim_id, version").map((row) => this.decodeWorldClaim(row));
    const policies = rows("SELECT * FROM policies ORDER BY revision, policy_id, version").map((row) => this.decodePolicy(row));
    const episodes = rows("SELECT * FROM episodes ORDER BY revision, episode_id").map((row) =>
      this.open<EpisodeMemory>("episode", String(row.episode_id), String(row.encrypted_payload)));
    const corrections = rows("SELECT * FROM corrections ORDER BY revision, correction_id").map((row) =>
      this.open<StoredCorrection>("correction", String(row.correction_id), String(row.encrypted_payload)));
    const traces = rows("SELECT * FROM turn_traces ORDER BY revision, trace_id").map((row) => this.decodeTrace(row));
    const triggers = rows("SELECT * FROM triggers ORDER BY revision, trigger_id").map((row) =>
      this.open<TriggerRecord>("trigger", String(row.trigger_id), String(row.encrypted_payload)));
    const failureClusters = rows("SELECT * FROM failure_clusters ORDER BY revision, cluster_id").map((row) =>
      this.open<FailureClusterRecord>("failure_cluster", String(row.cluster_id), String(row.encrypted_payload)));
    const calibrationPatterns = rows("SELECT * FROM calibration_patterns ORDER BY revision, pattern_id").map((row) =>
      this.open<CalibrationPatternRecord>("calibration_pattern", String(row.pattern_id), String(row.encrypted_payload)));
    const sessions = rows("SELECT * FROM session_lifecycle ORDER BY revision, session_id").map((row) =>
      this.required(this.getSession(String(row.session_id)), `session ${String(row.session_id)}`));
    const triggerActivations = rows("SELECT * FROM trigger_activations ORDER BY revision, activation_id")
      .map((row) => this.decodeTriggerActivation(row));
    const memoryPartitions = rows("SELECT * FROM memory_partitions ORDER BY revision, partition_id")
      .map((row) => this.decodeMemoryPartition(row));
    const memoryObjects = rows("SELECT * FROM memory_objects ORDER BY revision, object_id")
      .map((row) => this.decodeMemoryObject(row));
    const memoryObjectMembers = rows(`
      SELECT * FROM memory_object_members ORDER BY revision, object_id, member_type, member_id
    `).map((row) => this.decodeMemoryObjectMember(row));
    const memoryRelations = rows("SELECT * FROM memory_relations ORDER BY revision, relation_id")
      .map((row) => this.decodeMemoryRelation(row));
    const memoryVersions = rows("SELECT * FROM memory_versions ORDER BY revision, version_id")
      .map((row) => this.open<MemoryVersion>(
        "memory_version",
        String(row.version_id),
        String(row.encrypted_payload),
      ));
    const contradictions = rows("SELECT * FROM contradictions ORDER BY revision, contradiction_id")
      .map((row) => this.decodeContradiction(row));
    const memoryTemperatures = rows(`
      SELECT * FROM memory_temperatures ORDER BY revision, memory_type, memory_id
    `).map((row) => this.decodeMemoryTemperature(row));
    const retrievalTraces = rows("SELECT * FROM retrieval_traces ORDER BY revision, retrieval_id")
      .map((row) => this.open<RetrievalTrace>(
        "retrieval_trace",
        String(row.retrieval_id),
        String(row.encrypted_payload),
      ));
    const tombstones = rows("SELECT * FROM tombstones ORDER BY revision, entity_type, entity_id");
    const payload: ExportPackage = {
      format: "memoryd-export",
      version: 1,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: this.isoNow(),
      deviceId: this.deviceId,
      revision: this.getRevision(),
      records: {
        sourceEvents,
        turns,
        observations,
        worldClaims,
        policies,
        episodes,
        corrections,
        traces,
        triggers,
        failureClusters,
        calibrationPatterns,
        sessions,
        triggerActivations,
        memoryPartitions,
        memoryObjects,
        memoryObjectMembers,
        memoryRelations,
        memoryVersions,
        contradictions,
        memoryTemperatures,
        retrievalTraces,
        tombstones,
      },
    };
    const exportKey = options.encryptionKey === undefined ? this.key : normalizeKey(options.encryptionKey);
    return encryptJson(payload, exportKey, "memoryd-export:v1");
  }

  export(options: ExportOptions = {}): string {
    return this.exportData(options);
  }

  importData(encoded: string, options: ImportOptions = {}): ImportResult {
    this.requireWritable();
    const importKey = options.encryptionKey === undefined ? this.key : normalizeKey(options.encryptionKey);
    const payload = decryptJson<ExportPackage>(encoded, importKey, "memoryd-export:v1");
    if (payload.format !== "memoryd-export" || payload.version !== 1) {
      throw new Error("Unsupported memory export format");
    }
    if (payload.schemaVersion > SCHEMA_VERSION) {
      throw new Error(`Export schema ${payload.schemaVersion} is newer than supported schema ${SCHEMA_VERSION}`);
    }
    this.assertImportUsers(payload, options.allowDifferentUser ?? false);

    const imported: Record<string, number> = {};
    const conflicts: ImportResult["conflicts"] = [];
    let skipped = 0;
    const addImported = (kind: string): void => {
      imported[kind] = (imported[kind] ?? 0) + 1;
    };
    const run = (entityType: string, entityId: string, existed: boolean, operation: () => unknown): void => {
      if (this.hasTombstone(entityType, entityId)) {
        skipped += 1;
        return;
      }
      try {
        operation();
        if (existed) skipped += 1;
        else addImported(entityType);
      } catch (error) {
        if (error instanceof ProtocolError && error.shape.code === "VERSION_CONFLICT") {
          conflicts.push({ entityType, entityId, reason: error.message });
          return;
        }
        if (error instanceof ProtocolError && error.shape.code === "NOT_FOUND") {
          conflicts.push({ entityType, entityId, reason: `Missing dependency: ${error.message}` });
          return;
        }
        throw error;
      }
    };

    // Tombstones are applied first, so a delayed export cannot resurrect forgotten content.
    for (const tombstone of payload.records.tombstones ?? []) {
      const entityType = String(tombstone.entity_type);
      const entityId = String(tombstone.entity_id);
      const userId = String(tombstone.user_id);
      const selector: ForgetSelector = { userId, entityType, entityId };
      if (typeof tombstone.workspace_id === "string") selector.workspaceId = tombstone.workspace_id;
      if (typeof tombstone.session_id === "string") selector.sessionId = tombstone.session_id;
      if (typeof tombstone.reason === "string") selector.reason = tombstone.reason;
      const existed = this.hasTombstone(entityType, entityId);
      if (existed) {
        skipped += 1;
      } else {
        this.forget(selector);
        addImported("tombstone");
      }
    }

    for (const record of payload.records.sourceEvents ?? []) {
      const event = record.value;
      const existed = this.getSourceEvent(event.eventId) !== undefined || this.hasTombstone("source_event", event.eventId);
      run("source_event", event.eventId, existed, () => this.insertImportedEvent(record));
    }

    for (const turn of payload.records.turns ?? []) {
      const existed = this.getTurn(turn.turnId) !== undefined || this.hasTombstone("turn", turn.turnId);
      run("turn", turn.turnId, existed, () => {
        const created = this.createTurn(turn.plan, turn.scope, `import:turn:${turn.turnId}`);
        if (!existed && created.status !== turn.status) {
          this.updateTurn(turn.turnId, { status: turn.status });
        }
      });
    }

    for (const observation of payload.records.observations ?? []) {
      const existed = this.hasRow("observations", "observation_id", observation.observationId)
        || this.hasTombstone("observation", observation.observationId);
      run("observation", observation.observationId, existed, () => this.addObservations(observation.turnId, [{
        observationId: observation.observationId,
        kind: observation.kind,
        content: observation.content,
        ...(observation.source === undefined ? {} : { source: observation.source }),
        ...(observation.metadata === undefined ? {} : { metadata: observation.metadata }),
      }]));
    }

    for (const claim of payload.records.worldClaims ?? []) {
      const rowKey = this.versionedId(claim.claimId, claim.version);
      const existed = this.getWorldClaim(claim.claimId, claim.version) !== undefined || this.hasTombstone("world_claim", rowKey);
      run("world_claim", rowKey, existed, () => this.putWorldClaim(claim, `import:claim:${rowKey}`));
    }

    for (const policy of payload.records.policies ?? []) {
      const rowKey = this.versionedId(policy.policyId, policy.version);
      const existed = this.getPolicy(policy.policyId, policy.version) !== undefined || this.hasTombstone("policy", rowKey);
      run("policy", rowKey, existed, () => this.putPolicy(policy, `import:policy:${rowKey}`));
    }
    for (const episode of payload.records.episodes ?? []) {
      const existed = this.getEpisode(episode.episodeId) !== undefined || this.hasTombstone("episode", episode.episodeId);
      run("episode", episode.episodeId, existed, () => this.putEpisode(episode, `import:episode:${episode.episodeId}`));
    }
    for (const correction of payload.records.corrections ?? []) {
      const existed = this.getCorrection(correction.correctionId) !== undefined || this.hasTombstone("correction", correction.correctionId);
      const input: CorrectionInput = {
        turnId: correction.turnId,
        kind: correction.kind,
        correction: correction.correction,
        explicit: correction.explicit,
        idempotencyKey: `import:${correction.idempotencyKey}`,
      };
      if (correction.wrongStatement !== undefined) input.wrongStatement = correction.wrongStatement;
      if (correction.subject !== undefined) input.subject = correction.subject;
      if (correction.predicate !== undefined) input.predicate = correction.predicate;
      if (correction.value !== undefined) input.value = correction.value;
      if (correction.scopeLevel !== undefined) input.scopeLevel = correction.scopeLevel;
      run("correction", correction.correctionId, existed, () =>
        this.putCorrection(input, correction.source, correction.correctionId));
    }
    for (const trace of payload.records.traces ?? []) {
      const existed = this.hasRow("turn_traces", "trace_id", trace.traceId) || this.hasTombstone("trace", trace.traceId);
      run("trace", trace.traceId, existed, () => this.putTrace(trace.turnId, trace.trace, trace.traceId));
    }
    for (const trigger of payload.records.triggers ?? []) {
      const existed = this.hasRow("triggers", "trigger_id", trigger.triggerId) || this.hasTombstone("trigger", trigger.triggerId);
      run("trigger", trigger.triggerId, existed, () => this.putTrigger(trigger));
    }
    for (const cluster of payload.records.failureClusters ?? []) {
      const existed = this.hasRow("failure_clusters", "cluster_id", cluster.clusterId)
        || this.hasTombstone("failure_cluster", cluster.clusterId);
      run("failure_cluster", cluster.clusterId, existed, () => this.putFailureCluster(cluster));
    }
    for (const pattern of payload.records.calibrationPatterns ?? []) {
      const existed = this.hasRow("calibration_patterns", "pattern_id", pattern.patternId)
        || this.hasTombstone("calibration_pattern", pattern.patternId);
      run("calibration_pattern", pattern.patternId, existed, () => this.putCalibrationPattern(pattern));
    }
    for (const session of payload.records.sessions ?? []) {
      const existed = this.getSession(session.scope.sessionId) !== undefined;
      run("session", session.scope.sessionId, existed, () => {
        this.ensureSession(session.scope, session.startedAt);
        if (session.status === "ended") {
          this.endSession(
            session.scope,
            session.endIdempotencyKey ?? `import:end:${session.scope.sessionId}`,
            session.endedAt ?? session.startedAt,
          );
        }
      });
    }
    for (const activation of payload.records.triggerActivations ?? []) {
      const existed = this.database.prepare("SELECT 1 FROM trigger_activations WHERE activation_id = ?")
        .get(activation.activationId) !== undefined;
      run("trigger_activation", activation.activationId, existed, () => this.putTriggerActivation({
        triggerId: activation.triggerId,
        turnId: activation.turnId,
        scope: activation.scope,
        structuralScore: activation.structuralScore,
        similarityScore: activation.similarityScore,
        effectiveScore: activation.effectiveScore,
        activatedAt: activation.activatedAt,
      }));
    }
    for (const partition of payload.records.memoryPartitions ?? []) {
      const existed = this.getMemoryPartition(partition.partitionId) !== undefined
        || this.hasTombstone("memory_partition", partition.partitionId);
      run("memory_partition", partition.partitionId, existed, () => this.putMemoryPartition(partition));
    }
    for (const object of payload.records.memoryObjects ?? []) {
      const existed = this.getMemoryObject(object.objectId) !== undefined
        || this.hasTombstone("memory_object", object.objectId);
      run("memory_object", object.objectId, existed, () => this.putMemoryObject(object));
    }
    for (const member of payload.records.memoryObjectMembers ?? []) {
      const entityId = `${member.objectId}${OWNER_ID_SEPARATOR}${member.memberType}${OWNER_ID_SEPARATOR}${member.memberId}`;
      const existed = this.database.prepare(`
        SELECT 1 FROM memory_object_members
        WHERE object_id = ? AND member_type = ? AND member_id = ?
      `).get(member.objectId, member.memberType, member.memberId) !== undefined;
      run("memory_object_member", entityId, existed, () => this.putMemoryObjectMember(member));
    }
    for (const relation of payload.records.memoryRelations ?? []) {
      const existed = this.getMemoryRelation(relation.relationId) !== undefined
        || this.hasTombstone("memory_relation", relation.relationId);
      run("memory_relation", relation.relationId, existed, () => this.putMemoryRelation(relation));
    }
    for (const version of payload.records.memoryVersions ?? []) {
      const existed = this.hasRow("memory_versions", "version_id", version.versionId)
        || this.hasTombstone("memory_version", version.versionId);
      run("memory_version", version.versionId, existed, () => this.putMemoryVersion(version));
    }
    for (const contradiction of payload.records.contradictions ?? []) {
      const existed = this.getContradiction(contradiction.contradictionId) !== undefined
        || this.hasTombstone("contradiction", contradiction.contradictionId);
      run("contradiction", contradiction.contradictionId, existed, () =>
        this.putContradiction(contradiction));
    }
    for (const temperature of payload.records.memoryTemperatures ?? []) {
      const entityId = `${temperature.memoryType}${OWNER_ID_SEPARATOR}${temperature.memoryId}`;
      const existed = this.getMemoryTemperature(temperature.memoryType, temperature.memoryId) !== undefined;
      run("memory_temperature", entityId, existed, () => this.putMemoryTemperature(temperature));
    }
    for (const trace of payload.records.retrievalTraces ?? []) {
      const existed = this.database.prepare("SELECT 1 FROM retrieval_traces WHERE retrieval_id = ?")
        .get(trace.retrievalId) !== undefined || this.hasTombstone("retrieval_trace", trace.retrievalId);
      run("retrieval_trace", trace.retrievalId, existed, () => this.putRetrievalTrace(trace));
    }

    return { imported, skipped, conflicts, revision: this.getRevision() };
  }

  import(encoded: string, options: ImportOptions = {}): ImportResult {
    return this.importData(encoded, options);
  }

  reindex(): ReindexResult {
    this.requireWritable();
    return this.database.transaction(() => {
      this.database.exec(`
        DELETE FROM source_events_fts;
        DELETE FROM world_claims_fts;
        DELETE FROM policies_fts;
        DELETE FROM episodes_fts;
        DELETE FROM memory_objects_fts;
        DELETE FROM source_links;
        DELETE FROM embeddings;
        DELETE FROM embedding_buckets;
        DELETE FROM entity_edges;
      `);
      const indexed: Record<string, number> = {
        source_event: 0,
        world_claim: 0,
        policy: 0,
        episode: 0,
        memory_object: 0,
        memory_relation: 0,
        contradiction: 0,
        memory_version: 0,
        embedding: 0,
        entity_edge: 0,
      };
      for (const row of this.database.prepare("SELECT * FROM source_events").all() as Row[]) {
        const event = this.decodeSourceEvent(row);
        this.database.prepare(`
          INSERT INTO source_events_fts(event_id, user_id, workspace_id, content) VALUES (?, ?, ?, ?)
        `).run(event.eventId, event.scope.userId, event.scope.workspaceId ?? null, event.content);
        indexed.source_event = (indexed.source_event ?? 0) + 1;
      }
      for (const row of this.database.prepare("SELECT * FROM world_claims").all() as Row[]) {
        const claim = this.decodeWorldClaim(row);
        const rowKey = this.versionedId(claim.claimId, claim.version);
        this.database.prepare(`
          INSERT INTO world_claims_fts(row_key, user_id, workspace_id, subject, predicate, value)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          rowKey,
          claim.scope.userId,
          claim.scope.workspaceId ?? null,
          claim.subject,
          claim.predicate,
          this.searchableValue(claim.value),
        );
        this.linkSources("world_claim", rowKey, claim.sources);
        indexed.world_claim = (indexed.world_claim ?? 0) + 1;
      }
      for (const row of this.database.prepare("SELECT * FROM policies").all() as Row[]) {
        const policy = this.decodePolicy(row);
        const rowKey = this.versionedId(policy.policyId, policy.version);
        this.database.prepare(`INSERT INTO policies_fts(row_key, user_id, workspace_id, text) VALUES (?, ?, ?, ?)`)
          .run(rowKey, policy.scope.userId, policy.scope.workspaceId ?? null, policy.text);
        this.linkSources("policy", rowKey, policy.sources ?? []);
        indexed.policy = (indexed.policy ?? 0) + 1;
      }
      for (const row of this.database.prepare("SELECT * FROM episodes").all() as Row[]) {
        const episode = this.open<EpisodeMemory>("episode", String(row.episode_id), String(row.encrypted_payload));
        this.database.prepare(`
          INSERT INTO episodes_fts(episode_id, user_id, workspace_id, title, summary)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          episode.episodeId,
          episode.scope.userId,
          episode.scope.workspaceId ?? null,
          episode.title,
          this.episodeSearchableSummary(episode),
        );
        this.linkSources("episode", episode.episodeId, episode.eventRefs);
        indexed.episode = (indexed.episode ?? 0) + 1;
      }
      for (const row of this.database.prepare("SELECT * FROM memory_objects").all() as Row[]) {
        const object = this.decodeMemoryObject(row);
        // Object routing uses bounded partition-local rows rather than a
        // rebuilt global FTS layer.
        this.linkSources("memory_object", object.objectId, object.evidenceRefs);
        indexed.memory_object = (indexed.memory_object ?? 0) + 1;
      }
      for (const row of this.database.prepare("SELECT * FROM memory_relations").all() as Row[]) {
        const relation = this.decodeMemoryRelation(row);
        if (relation.evidenceRefs.length > 0) {
          this.linkSources("memory_relation", relation.relationId, relation.evidenceRefs);
        }
        indexed.memory_relation = (indexed.memory_relation ?? 0) + 1;
      }
      for (const row of this.database.prepare("SELECT * FROM contradictions").all() as Row[]) {
        const contradiction = this.decodeContradiction(row);
        this.linkSources("contradiction", contradiction.contradictionId, contradiction.evidenceRefs);
        indexed.contradiction = (indexed.contradiction ?? 0) + 1;
      }
      for (const row of this.database.prepare("SELECT * FROM memory_versions").all() as Row[]) {
        const version = this.open<MemoryVersion>(
          "memory_version",
          String(row.version_id),
          String(row.encrypted_payload),
        );
        if (version.evidenceRefs.length > 0) {
          this.linkSources("memory_version", version.versionId, version.evidenceRefs);
        }
        indexed.memory_version = (indexed.memory_version ?? 0) + 1;
      }
      for (const row of this.database.prepare("SELECT * FROM observations").all() as Row[]) {
        const observation = this.decodeObservation(row);
        if (observation.source?.eventId) {
          this.validatePartialSource(observation.source, this.scopeFromRow(row));
          this.linkSources("observation", observation.observationId, [observation.source as SourceRef]);
        }
      }
      for (const row of this.database.prepare("SELECT * FROM turns").all() as Row[]) {
        const turn = this.decodeTurn(row);
        const refs = this.sourceRefsInValue(turn.plan);
        if (refs.length > 0) {
          this.assertSourceRefs(refs, turn.scope);
          this.linkSources("turn", turn.turnId, refs);
        }
      }
      for (const row of this.database.prepare("SELECT * FROM corrections").all() as Row[]) {
        const correction = this.open<StoredCorrection>(
          "correction",
          String(row.correction_id),
          String(row.encrypted_payload),
        );
        if (correction.source) this.linkSources("correction", correction.correctionId, [correction.source]);
      }
      for (const row of this.database.prepare("SELECT * FROM turn_traces").all() as Row[]) {
        const trace = this.decodeTrace(row);
        const refs = this.sourceRefsInValue(trace.trace);
        if (refs.length > 0) {
          this.assertSourceRefs(refs, trace.scope);
          this.linkSources("trace", trace.traceId, refs);
        }
      }
      const indexRevision = this.getRevision();
      this.setMetadata("index_revision", String(indexRevision));
      return { indexRevision, indexed };
    })();
  }

  health(): StoreHealth {
    const issues: string[] = [];
    let integrityCheck = "unknown";
    let ftsAvailable = false;
    try {
      integrityCheck = String(this.database.pragma("quick_check", { simple: true }));
      if (integrityCheck !== "ok") issues.push(`SQLite quick_check: ${integrityCheck}`);
    } catch (error) {
      issues.push(`SQLite quick_check failed: ${this.errorMessage(error)}`);
    }
    try {
      this.database.prepare("SELECT count(*) AS count FROM source_events_fts").get();
      ftsAvailable = true;
    } catch (error) {
      issues.push(`FTS5 unavailable: ${this.errorMessage(error)}`);
    }
    const revision = this.getRevision();
    const indexRevision = this.getIndexRevision();
    if (indexRevision > revision) issues.push("Index revision is ahead of authoritative revision");
    const journalMode = String(this.database.pragma("journal_mode", { simple: true }));
    if (journalMode !== "wal" && journalMode !== "memory") {
      issues.push(`Unexpected journal mode: ${journalMode}`);
    }
    const eventCount = Number((this.database.prepare("SELECT count(*) AS count FROM source_events").get() as Row).count);
    const count = (sql: string): number => Number((this.database.prepare(sql).get() as Row).count);
    return {
      ok: issues.length === 0,
      schemaVersion: Number(this.database.pragma("user_version", { simple: true })),
      journalMode,
      revision,
      indexRevision,
      ftsAvailable,
      integrityCheck,
      eventCount,
      pendingLearningJobs: count("SELECT count(*) AS count FROM learning_jobs WHERE status IN ('pending', 'running')"),
      failedLearningJobs: count("SELECT count(*) AS count FROM learning_jobs WHERE status = 'failed'"),
      endedSessions: count("SELECT count(*) AS count FROM session_lifecycle WHERE status = 'ended'"),
      embeddingCount: count("SELECT count(*) AS count FROM embeddings"),
      entityEdgeCount: count("SELECT count(*) AS count FROM entity_edges"),
      memoryObjectCount: count("SELECT count(*) AS count FROM memory_objects"),
      partitionCount: count("SELECT count(*) AS count FROM memory_partitions"),
      pendingMaintenanceJobs: count(
        "SELECT count(*) AS count FROM maintenance_jobs WHERE status IN ('pending', 'running')",
      ),
      failedMaintenanceJobs: count("SELECT count(*) AS count FROM maintenance_jobs WHERE status = 'failed'"),
      maintenanceBacklog: count(
        "SELECT count(*) AS count FROM maintenance_jobs WHERE status IN ('pending', 'running', 'failed')",
      ),
      issues,
    };
  }

  doctor(): StoreHealth {
    return this.health();
  }

  private getMetadata(key: string): string | undefined {
    try {
      const row = this.database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as Row | undefined;
      return row ? String(row.value) : undefined;
    } catch (error) {
      if (this.readonly) throw error;
      return undefined;
    }
  }

  private getMetadataNumber(key: string): number {
    const value = this.getMetadata(key);
    return value === undefined ? 0 : Number(value);
  }

  private setMetadata(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private nextRevision(): number {
    this.database.prepare("UPDATE metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'").run();
    return this.getRevision();
  }

  private touchIndex(revision: number): void {
    this.setMetadata("index_revision", String(revision));
  }

  private bumpMemoryGeneration(): number {
    this.database.prepare(`
      UPDATE metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'memory_generation'
    `).run();
    return this.getMemoryGeneration();
  }

  private seal(type: string, id: string, payload: unknown): string {
    return encryptJson(payload, this.key, `${type}:${id}`);
  }

  private open<T>(type: string, id: string, payload: string): T {
    return decryptJson<T>(payload, this.key, `${type}:${id}`);
  }

  private decodeMemoryPartition(row: Row): MemoryPartition {
    const partitionId = String(row.partition_id);
    const value = this.open<MemoryPartition>(
      "memory_partition",
      partitionId,
      String(row.encrypted_payload),
    );
    return {
      ...value,
      partitionId,
      scope: this.scopeFromRow(row),
      namespace: String(row.namespace),
      partitionKey: String(row.partition_key),
      strategy: String(row.strategy) as MemoryPartition["strategy"],
      status: String(row.status) as MemoryPartition["status"],
      depth: Number(row.depth),
      childCount: Number(row.child_count),
      objectCount: Number(row.object_count),
      capacity: Number(row.capacity),
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(typeof row.parent_partition_id === "string"
        ? { parentPartitionId: row.parent_partition_id }
        : {}),
    };
  }

  private decodeMemoryObject(row: Row): MemoryObject {
    const objectId = String(row.object_id);
    const value = this.open<MemoryObject>("memory_object", objectId, String(row.encrypted_payload));
    return {
      ...value,
      objectId,
      scope: this.scopeFromRow(row),
      partitionId: String(row.partition_id),
      objectType: String(row.object_type) as MemoryObject["objectType"],
      title: String(row.title),
      status: String(row.status) as MemoryObject["status"],
      temperature: String(row.temperature) as MemoryObject["temperature"],
      tokenEstimate: Number(row.token_estimate),
      childCount: Number(row.child_count),
      memberCount: Number(row.member_count),
      confidence: Number(row.confidence),
      version: Number(row.version),
      schemaVersion: Number(row.schema_version),
      summarizerVersion: String(row.summarizer_version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(typeof row.parent_object_id === "string" ? { parentObjectId: row.parent_object_id } : {}),
    };
  }

  private decodeMemoryObjectMember(row: Row): MemoryObjectMember {
    return {
      objectId: String(row.object_id),
      memberType: String(row.member_type) as MemoryObjectMember["memberType"],
      memberId: String(row.member_id),
      role: String(row.role) as MemoryObjectMember["role"],
      score: Number(row.score),
      status: String(row.status) as MemoryObjectMember["status"],
      addedAt: String(row.added_at),
      updatedAt: String(row.updated_at),
      ...(typeof row.origin_action_id === "string" ? { originActionId: row.origin_action_id } : {}),
    };
  }

  private decodeMemoryRelation(row: Row): MemoryRelation {
    const relationId = String(row.relation_id);
    const value = this.open<MemoryRelation>("memory_relation", relationId, String(row.encrypted_payload));
    return {
      ...value,
      relationId,
      scope: this.scopeFromRow(row),
      from: { type: String(row.from_type) as MemoryRelation["from"]["type"], id: String(row.from_id) },
      to: { type: String(row.to_type) as MemoryRelation["to"]["type"], id: String(row.to_id) },
      relation: String(row.relation_type) as MemoryRelation["relation"],
      status: String(row.status) as MemoryRelation["status"],
      confidence: Number(row.confidence),
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private decodeContradiction(row: Row): Contradiction {
    const contradictionId = String(row.contradiction_id);
    const value = this.open<Contradiction>(
      "contradiction",
      contradictionId,
      String(row.encrypted_payload),
    );
    return {
      ...value,
      contradictionId,
      scope: this.scopeFromRow(row),
      status: String(row.status) as Contradiction["status"],
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private decodeMemoryTemperature(row: Row): MemoryTemperature {
    const memoryType = String(row.memory_type) as MemoryTemperature["memoryType"];
    const memoryId = String(row.memory_id);
    const value = this.open<MemoryTemperature>(
      "memory_temperature",
      `${memoryType}${OWNER_ID_SEPARATOR}${memoryId}`,
      String(row.encrypted_payload),
    );
    return {
      ...value,
      memoryType,
      memoryId,
      scope: this.scopeFromRow(row),
      tier: String(row.tier) as MemoryTemperature["tier"],
      score: Number(row.score),
      accessCount: Number(row.access_count),
      retrievalCount: Number(row.retrieval_count),
      mentionCount: Number(row.mention_count),
      explicitRemember: Number(row.explicit_remember) === 1,
      activeProject: Number(row.active_project) === 1,
      pinned: Number(row.pinned) === 1,
      updatedAt: String(row.updated_at),
      ...(typeof row.last_accessed_at === "string" ? { lastAccessedAt: row.last_accessed_at } : {}),
      ...(typeof row.last_mentioned_at === "string" ? { lastMentionedAt: row.last_mentioned_at } : {}),
    };
  }

  private decodeMaintenanceJob(row: Row): MaintenanceJob {
    const jobId = String(row.job_id);
    const value = this.open<MaintenanceJob>("maintenance_job", jobId, String(row.encrypted_payload));
    return {
      ...value,
      jobId,
      scope: this.scopeFromRow(row),
      type: String(row.job_type) as MaintenanceJobType,
      status: String(row.status) as MaintenanceJobStatus,
      dryRun: Number(row.dry_run) === 1,
      idempotencyKey: String(row.idempotency_key),
      attempts: Number(row.attempts),
      availableAt: String(row.available_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(typeof row.cursor === "string" ? { cursor: row.cursor } : {}),
      ...(typeof row.leased_at === "string" ? { leasedAt: row.leased_at } : {}),
      ...(typeof row.completed_at === "string" ? { completedAt: row.completed_at } : {}),
      ...(typeof row.last_error === "string" ? { lastError: row.last_error } : {}),
    };
  }

  private decodeMaintenanceAction(row: Row): MaintenanceAction {
    const actionId = String(row.action_id);
    const value = this.open<MaintenanceAction>(
      "maintenance_action",
      actionId,
      String(row.encrypted_payload),
    );
    return {
      ...value,
      actionId,
      jobId: String(row.job_id),
      sequence: Number(row.sequence),
      type: String(row.action_type) as MaintenanceAction["type"],
      targetType: String(row.target_type) as MaintenanceAction["targetType"],
      targetId: String(row.target_id),
      status: String(row.status) as MaintenanceAction["status"],
      reversible: Number(row.reversible) === 1,
      createdAt: String(row.created_at),
      ...(typeof row.applied_at === "string" ? { appliedAt: row.applied_at } : {}),
      ...(typeof row.rolled_back_at === "string" ? { rolledBackAt: row.rolled_back_at } : {}),
    };
  }

  private decodeSourceEvent(row: Row): SourceEvent {
    const eventId = String(row.event_id);
    const value = this.open<SourceEvent>("source_event", eventId, String(row.encrypted_payload));
    return {
      ...value,
      eventId,
      revision: Number(row.revision),
      deviceId: String(row.device_id),
      contentHash: String(row.content_hash),
      capturedAt: String(row.captured_at),
      occurredAt: String(row.occurred_at),
      selectedEvidence: Number(row.selected_evidence) === 1,
    };
  }

  private decodeTurn(row: Row): StoredTurn {
    const turnId = String(row.turn_id);
    const persistedPlan = this.open<Omit<TurnPlan, "protocolVersion"> & { protocolVersion: string }>(
      "turn",
      turnId,
      String(row.encrypted_plan),
    );
    const plan: TurnPlan = persistedPlan.protocolVersion === PROTOCOL_VERSION
      ? persistedPlan as TurnPlan
      : persistedPlan.protocolVersion === "1.0" || persistedPlan.protocolVersion === "1.1"
        ? { ...persistedPlan, protocolVersion: PROTOCOL_VERSION }
        : (() => {
            throw new ProtocolError({
              code: "VERSION_CONFLICT",
              message: `Turn ${turnId} uses unsupported stored protocol ${persistedPlan.protocolVersion}; start a new turn`,
            });
          })();
    return {
      turnId,
      revision: Number(row.revision),
      scope: this.scopeFromRow(row),
      plan: {
        ...plan,
        gate: { ...plan.gate, satisfied: Number(row.gate_satisfied) === 1 },
        retryCount: Number(row.retry_count),
      },
      status: String(row.status) as StoredTurn["status"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private decodeTriggerActivation(row: Row): TriggerActivationRecord {
    return {
      activationId: String(row.activation_id),
      revision: Number(row.revision),
      triggerId: String(row.trigger_id),
      turnId: String(row.turn_id),
      scope: this.scopeFromRow(row),
      structuralScore: Number(row.structural_score),
      similarityScore: Number(row.similarity_score),
      effectiveScore: Number(row.effective_score),
      activatedAt: String(row.activated_at),
    };
  }

  private decodeLearningJob(row: Row): LearningJobRecord {
    const jobId = String(row.job_id);
    const stored = this.open<LearningJobRecord>("learning_job", jobId, String(row.encrypted_payload));
    return {
      ...stored,
      jobId,
      revision: Number(row.revision),
      idempotencyKey: String(row.idempotency_key),
      scope: this.scopeFromRow(row),
      type: String(row.job_type) as LearningJobType,
      status: String(row.status) as LearningJobRecord["status"],
      attempts: Number(row.attempts),
      availableAt: String(row.available_at),
      ...(typeof row.leased_at === "string" ? { leasedAt: row.leased_at } : {}),
      ...(typeof row.last_error === "string" ? { lastError: row.last_error } : {}),
    };
  }

  private decodeObservation(row: Row): StoredObservation {
    const id = String(row.observation_id);
    const stored = this.open<StoredObservation>("observation", id, String(row.encrypted_payload));
    return {
      ...stored,
      observationId: id,
      revision: Number(row.revision),
      contentHash: String(row.content_hash),
      createdAt: String(row.created_at),
    };
  }

  private decodeWorldClaim(row: Row): WorldClaim {
    const claimId = String(row.claim_id);
    const version = Number(row.version);
    const rowKey = this.versionedId(claimId, version);
    const claim = this.open<WorldClaim>("world_claim", rowKey, String(row.encrypted_payload));
    return {
      ...claim,
      claimId,
      version,
      status: String(row.status) as WorldClaim["status"],
      confidence: Number(row.confidence),
      conflictGroup: String(row.conflict_group),
    };
  }

  private decodePolicy(row: Row): StoredPolicy {
    const policyId = String(row.policy_id);
    const version = Number(row.version);
    const rowKey = this.versionedId(policyId, version);
    const policy = this.open<StoredPolicy>("policy", rowKey, String(row.encrypted_payload));
    return {
      ...policy,
      policyId,
      version,
      reviewStatus: String(row.review_status) as NonNullable<StoredPolicy["reviewStatus"]>,
    };
  }

  private decodeTrace(row: Row): StoredTrace {
    const traceId = String(row.trace_id);
    const trace = this.open<StoredTrace>("trace", traceId, String(row.encrypted_payload));
    return { ...trace, traceId, revision: Number(row.revision), createdAt: String(row.created_at) };
  }

  private scopeFromRow(row: Row): ScopeRef {
    const scope: ScopeRef = { userId: String(row.user_id) };
    if (typeof row.workspace_id === "string") scope.workspaceId = row.workspace_id;
    if (typeof row.session_id === "string") scope.sessionId = row.session_id;
    if (typeof row.branch === "string") scope.branch = row.branch;
    if (typeof row.commit_hash === "string") scope.commit = row.commit_hash;
    return scope;
  }

  private lookupIdempotency(operation: string, key: string): IdempotencyRow | undefined {
    return this.database.prepare(`
      SELECT entity_id, record_hash FROM idempotency_keys
      WHERE operation = ? AND idempotency_key = ?
    `).get(operation, key) as IdempotencyRow | undefined;
  }

  private rememberIdempotency(
    operation: string,
    key: string,
    entityId: string,
    recordHash: string,
    revision: number,
  ): void {
    this.database.prepare(`
      INSERT INTO idempotency_keys(operation, idempotency_key, entity_id, record_hash, revision)
      VALUES (?, ?, ?, ?, ?)
    `).run(operation, key, entityId, recordHash, revision);
  }

  private assertIdempotencyHash(row: IdempotencyRow, requestHash: string, operation: string): void {
    if (row.record_hash !== requestHash) {
      this.versionConflict(`Idempotency key for ${operation} was reused with different content`);
    }
  }

  private requireSession(scope: ScopeRef): asserts scope is ScopeRef & { sessionId: string } {
    if (!scope.sessionId) throw new TypeError("Source events require scope.sessionId for stable SourceRef values");
  }

  private assertSourceRefs(refs: readonly SourceRef[], ownerScope: ScopeRef): void {
    for (const ref of refs) {
      const event = this.getSourceEvent(ref.eventId, ownerScope);
      if (!event) this.notFound(`Source event ${ref.eventId} was not found`);
      this.assertSourceRef(ref, event);
    }
  }

  /**
   * Calibration overlays are keyed by agent profile instead of a memory scope, but
   * their provenance must still resolve to an exact authoritative SourceEvent.
   */
  private assertUnscopedSourceRefs(refs: readonly SourceRef[]): void {
    for (const ref of refs) {
      const event = this.getSourceEvent(ref.eventId);
      if (!event) this.notFound(`Source event ${ref.eventId} was not found`);
      this.assertSourceRef(ref, event);
    }
  }

  private assertSourceRef(ref: SourceRef, event: SourceEvent): void {
    const expected = this.toSourceRef(event);
    if (
      ref.eventId !== expected.eventId ||
      ref.sessionId !== expected.sessionId ||
      ref.contentHash !== expected.contentHash ||
      ref.capturedAt !== expected.capturedAt ||
      ref.workspaceId !== expected.workspaceId ||
      (ref.commit !== undefined && ref.commit !== expected.commit) ||
      (ref.path !== undefined && ref.path !== expected.path)
    ) {
      this.versionConflict(`SourceRef for ${ref.eventId} does not match the authoritative event`);
    }
    const length = event.content.length;
    if (
      (ref.startOffset !== undefined && (ref.startOffset < 0 || ref.startOffset > length)) ||
      (ref.endOffset !== undefined && (ref.endOffset < 0 || ref.endOffset > length)) ||
      (ref.startOffset !== undefined && ref.endOffset !== undefined && ref.startOffset > ref.endOffset)
    ) {
      throw new RangeError(`SourceRef offsets for ${ref.eventId} are outside the event content`);
    }
  }

  private validatePartialSource(ref: Partial<SourceRef>, scope: ScopeRef): void {
    if (!ref.eventId) return;
    const event = this.getSourceEvent(ref.eventId, scope);
    if (!event) this.notFound(`Source event ${ref.eventId} was not found`);
    const expected = this.toSourceRef(event);
    for (const key of ["sessionId", "contentHash", "capturedAt", "workspaceId", "path", "commit"] as const) {
      if (ref[key] !== undefined && ref[key] !== expected[key]) {
        this.versionConflict(`Observation source field ${key} does not match event ${ref.eventId}`);
      }
    }
  }

  private linkSources(ownerType: string, ownerId: string, refs: readonly SourceRef[]): void {
    const statement = this.database.prepare(`
      INSERT OR IGNORE INTO source_links(owner_type, owner_id, event_id) VALUES (?, ?, ?)
    `);
    for (const ref of refs) statement.run(ownerType, ownerId, ref.eventId);
  }

  private touchMemoryScope(scope: ScopeRef, at: string): void {
    this.database.prepare(`
      INSERT INTO memory_scope_registry(user_id, workspace_key, workspace_id, last_activity_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, workspace_key) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        last_activity_at = CASE
          WHEN excluded.last_activity_at > memory_scope_registry.last_activity_at
          THEN excluded.last_activity_at
          ELSE memory_scope_registry.last_activity_at
        END
    `).run(scope.userId, scope.workspaceId ?? "", scope.workspaceId ?? null, at);
  }

  private aclSql(sessionScoped: boolean, alias?: string): string {
    const prefix = alias ? `${alias}.` : "";
    const workspace = `(
      (@workspaceId IS NULL AND ${prefix}workspace_id IS NULL)
      OR ${prefix}workspace_id IS NULL
      OR ${prefix}workspace_id = @workspaceId
    )`;
    const session = sessionScoped
      ? ` AND (${prefix}session_id IS NULL OR (@sessionId IS NOT NULL AND ${prefix}session_id = @sessionId))`
      : "";
    return `${prefix}user_id = @userId AND ${workspace}${session}`;
  }

  private normalizedEntityTokens(tokens: readonly string[]): string[] {
    return [...new Set(tokens
      .map((token) => token.normalize("NFKC").trim().toLocaleLowerCase())
      .filter((token) => token.length >= 2 && token.length <= 160))]
      .sort((left, right) => left.localeCompare(right));
  }

  private embeddingBuckets(vector: readonly number[]): string[] {
    const strongest = vector
      .map((value, index) => ({ index, value, magnitude: Math.abs(value) }))
      .filter((item) => Number.isFinite(item.value) && item.magnitude > 0)
      .sort((left, right) => right.magnitude - left.magnitude || left.index - right.index)
      .slice(0, 6);
    const singles = strongest.map((item) => `v1:d${item.index}:${item.value >= 0 ? "+" : "-"}`);
    const pairs = strongest.slice(0, 3).flatMap((item, index, values) => {
      const next = values[index + 1];
      return next === undefined
        ? []
        : [`v1:p${Math.min(item.index, next.index)}:${Math.max(item.index, next.index)}:${item.value >= 0 ? "+" : "-"}${next.value >= 0 ? "+" : "-"}`];
    });
    return [...new Set([...singles, ...pairs])];
  }

  private entityTokenId(scope: Pick<ScopeRef, "userId" | "workspaceId">, token: string): string {
    // Entity names never enter the plaintext graph; matching uses a keyed local digest.
    return createHmac("sha256", this.key)
      .update(canonicalJson([scope.userId, scope.workspaceId ?? null, token]))
      .digest("hex");
  }

  private aclParams(scope: ScopeRef): { userId: string; workspaceId: string | null; sessionId: string | null } {
    return {
      userId: scope.userId,
      workspaceId: scope.workspaceId ?? null,
      sessionId: scope.sessionId ?? null,
    };
  }

  private assertAcl(row: Row, scope: ScopeRef, sessionScoped: boolean): void {
    const rowScope = this.scopeFromRow(row);
    const workspaceAllowed = rowScope.workspaceId === undefined || rowScope.workspaceId === scope.workspaceId;
    const sessionAllowed = !sessionScoped || rowScope.sessionId === undefined || rowScope.sessionId === scope.sessionId;
    if (rowScope.userId !== scope.userId || !workspaceAllowed || !sessionAllowed) {
      throw new ProtocolError({
        code: "SCOPE_DENIED",
        message: "The requested memory is outside the caller scope",
      });
    }
  }

  private worldConflictGroup(claim: WorldClaim): string {
    return sha256(canonicalJson({
      userId: claim.scope.userId,
      workspaceId: claim.scope.workspaceId,
      sessionId: claim.scope.sessionId,
      subject: claim.subject,
      predicate: claim.predicate,
    }));
  }

  private searchableValue(value: unknown): string {
    return typeof value === "string" ? value : canonicalJson(value);
  }

  private episodeSearchableSummary(episode: EpisodeMemory): string {
    const extended = episode as EpisodeMemory & { topicTerms?: unknown; entityKeys?: unknown };
    const topicTerms = Array.isArray(extended.topicTerms)
      ? extended.topicTerms.filter((value): value is string => typeof value === "string")
      : [];
    const entityKeys = Array.isArray(extended.entityKeys)
      ? extended.entityKeys.filter((value): value is string => typeof value === "string")
      : [];
    return [episode.summary ?? "", ...episode.tags, ...topicTerms, ...entityKeys].join(" ");
  }

  private versionedId(id: string, version: number): string {
    return `${id}${OWNER_ID_SEPARATOR}${version}`;
  }

  private parseVersionedId(value: string): [string, number] {
    const index = value.lastIndexOf(OWNER_ID_SEPARATOR);
    if (index <= 0) throw new Error(`Malformed versioned entity id: ${value}`);
    const version = Number(value.slice(index + OWNER_ID_SEPARATOR.length));
    if (!Number.isSafeInteger(version)) throw new Error(`Malformed entity version: ${value}`);
    return [value.slice(0, index), version];
  }

  private ftsQuery(query: string): string {
    const terms = query.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [];
    return [...new Set(terms.slice(0, 32))]
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(" OR ");
  }

  private uniqueSourceRefs(refs: readonly SourceRef[]): SourceRef[] {
    const seen = new Set<string>();
    return refs.filter((ref) => {
      const key = canonicalJson(ref);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private sourceRefsInValue(value: unknown): SourceRef[] {
    const found: SourceRef[] = [];
    const seen = new WeakSet<object>();
    const visit = (candidate: unknown): void => {
      if (candidate === null || typeof candidate !== "object") return;
      if (seen.has(candidate)) return;
      seen.add(candidate);
      if (Array.isArray(candidate)) {
        for (const item of candidate) visit(item);
        return;
      }
      const record = candidate as Record<string, unknown>;
      if (
        typeof record.eventId === "string" &&
        typeof record.sessionId === "string" &&
        typeof record.contentHash === "string" &&
        typeof record.capturedAt === "string"
      ) {
        const ref: SourceRef = {
          eventId: record.eventId,
          sessionId: record.sessionId,
          contentHash: record.contentHash,
          capturedAt: record.capturedAt,
        };
        if (typeof record.workspaceId === "string") ref.workspaceId = record.workspaceId;
        if (typeof record.startOffset === "number") ref.startOffset = record.startOffset;
        if (typeof record.endOffset === "number") ref.endOffset = record.endOffset;
        if (typeof record.path === "string") ref.path = record.path;
        if (typeof record.commit === "string") ref.commit = record.commit;
        found.push(ref);
        return;
      }
      for (const nested of Object.values(record)) visit(nested);
    };
    visit(value);
    return this.uniqueSourceRefs(found);
  }

  private putAuxiliary<T extends object>(
    entityType: string,
    table: string,
    idColumn: string,
    id: string,
    value: T,
    columns: readonly string[],
    columnValues: readonly unknown[],
  ): T {
    this.requireWritable();
    this.assertSqlIdentifier(table);
    this.assertSqlIdentifier(idColumn);
    for (const column of columns) this.assertSqlIdentifier(column);
    const sanitized = redactSensitiveValue(value).value;
    const recordHash = sha256(canonicalJson(sanitized));
    const existing = this.database.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ?`).get(id) as Row | undefined;
    if (existing) {
      if (String(existing.record_hash) !== recordHash) {
        this.versionConflict(`${entityType} ${id} already exists with different content`);
      }
      return this.open<T>(entityType, id, String(existing.encrypted_payload));
    }
    this.assertNotTombstoned(entityType, id);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const names = [idColumn, "revision", ...columns, "encrypted_payload", "record_hash"];
      const placeholders = names.map(() => "?").join(", ");
      this.database.prepare(`
        INSERT INTO ${table}(${names.join(", ")}) VALUES (${placeholders})
      `).run(id, revision, ...columnValues, this.seal(entityType, id, sanitized), recordHash);
      return sanitized;
    })();
  }

  /** Mutable helper reserved for derived learning/index records, never authoritative events. */
  private upsertAuxiliary<T extends object>(
    entityType: string,
    table: string,
    idColumn: string,
    id: string,
    value: T,
    columns: readonly string[],
    columnValues: readonly unknown[],
  ): T {
    this.requireWritable();
    this.assertSqlIdentifier(table);
    this.assertSqlIdentifier(idColumn);
    for (const column of columns) this.assertSqlIdentifier(column);
    const sanitized = redactSensitiveValue(value).value;
    const recordHash = sha256(canonicalJson(sanitized));
    const existing = this.database.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ?`).get(id) as Row | undefined;
    if (existing !== undefined && String(existing.record_hash) === recordHash) {
      return this.open<T>(entityType, id, String(existing.encrypted_payload));
    }
    if (existing === undefined) this.assertNotTombstoned(entityType, id);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      if (existing === undefined) {
        const names = [idColumn, "revision", ...columns, "encrypted_payload", "record_hash"];
        const placeholders = names.map(() => "?").join(", ");
        this.database.prepare(`INSERT INTO ${table}(${names.join(", ")}) VALUES (${placeholders})`)
          .run(id, revision, ...columnValues, this.seal(entityType, id, sanitized), recordHash);
      } else {
        const assignments = ["revision = ?", ...columns.map((column) => `${column} = ?`), "encrypted_payload = ?", "record_hash = ?"];
        this.database.prepare(`UPDATE ${table} SET ${assignments.join(", ")} WHERE ${idColumn} = ?`)
          .run(revision, ...columnValues, this.seal(entityType, id, sanitized), recordHash, id);
      }
      return sanitized;
    })();
  }

  private updateMaintenanceJobState(
    jobId: string,
    status: MaintenanceJobStatus,
    patch: Partial<Pick<
      MaintenanceJob,
      "availableAt" | "lastError" | "cursor" | "completedAt"
    >> = {},
  ): MaintenanceJob {
    this.requireWritable();
    const job = this.getMaintenanceJob(jobId);
    if (job === undefined) this.notFound(`Maintenance job ${jobId} was not found`);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const now = this.isoNow();
      const updated: MaintenanceJob = {
        ...job,
        ...patch,
        status,
        updatedAt: now,
      };
      if (status !== "running") delete updated.leasedAt;
      this.database.prepare(`
        UPDATE maintenance_jobs SET revision = ?, status = ?, cursor = ?,
          available_at = ?, leased_at = ?, completed_at = ?, last_error = ?,
          updated_at = ?, encrypted_payload = ? WHERE job_id = ?
      `).run(
        revision,
        status,
        updated.cursor ?? null,
        updated.availableAt,
        updated.leasedAt ?? null,
        updated.completedAt ?? null,
        updated.lastError ?? null,
        now,
        this.seal("maintenance_job", jobId, updated),
        jobId,
      );
      this.putMaintenanceAudit({
        auditId: randomUUID(),
        revision: 0,
        scope: updated.scope,
        jobId,
        event: `job_${status}`,
        details: {
          attempts: updated.attempts,
          ...(updated.lastError === undefined ? {} : { lastError: updated.lastError }),
        },
        createdAt: now,
      });
      return updated;
    })();
  }

  private updateLearningJobState(
    jobId: string,
    status: LearningJobRecord["status"],
    patch: Pick<LearningJobRecord, "availableAt" | "lastError"> | Partial<Pick<LearningJobRecord, "availableAt" | "lastError">> = {},
  ): LearningJobRecord {
    this.requireWritable();
    const job = this.getLearningJob(jobId);
    if (job === undefined) this.notFound(`Learning job ${jobId} was not found`);
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const { leasedAt: _leasedAt, ...withoutLease } = job;
      const updated: LearningJobRecord = status === "running"
        ? { ...job, ...patch, revision, status }
        : { ...withoutLease, ...patch, revision, status };
      this.database.prepare(`
        UPDATE learning_jobs SET revision = ?, status = ?, available_at = ?, leased_at = NULL,
          last_error = ?, encrypted_payload = ? WHERE job_id = ?
      `).run(
        revision,
        status,
        updated.availableAt,
        updated.lastError ?? null,
        this.seal("learning_job", jobId, updated),
        jobId,
      );
      return updated;
    })();
  }

  private collectScopedEntities(selector: ForgetSelector): Array<{ type: string; id: string }> {
    const where: string[] = ["user_id = @userId"];
    const params: Record<string, unknown> = { userId: selector.userId };
    if (selector.workspaceId !== undefined) {
      where.push("workspace_id = @workspaceId");
      params.workspaceId = selector.workspaceId;
    }
    if (selector.sessionId !== undefined) {
      where.push("session_id = @sessionId");
      params.sessionId = selector.sessionId;
    }
    const clause = where.join(" AND ");
    const collect = (table: string, idExpression: string, type: string, hasSession = true): Array<{ type: string; id: string }> => {
      this.assertSqlIdentifier(table);
      const effective = hasSession ? clause : where.filter((item) => !item.startsWith("session_id")).join(" AND ");
      return (this.database.prepare(`SELECT ${idExpression} AS id FROM ${table} WHERE ${effective}`).all(params) as Row[])
        .map((row) => ({ type, id: String(row.id) }));
    };

    // Source-bearing and turn-owned records precede their parents to ensure each deletion is audited.
    return [
      ...collect("world_claims", `claim_id || '${OWNER_ID_SEPARATOR}' || version`, "world_claim"),
      ...collect("policies", `policy_id || '${OWNER_ID_SEPARATOR}' || version`, "policy"),
      ...collect("episodes", "episode_id", "episode"),
      ...collect("memory_objects", "object_id", "memory_object"),
      ...collect("memory_relations", "relation_id", "memory_relation"),
      ...collect("contradictions", "contradiction_id", "contradiction"),
      ...collect("observations", "observation_id", "observation"),
      ...collect("corrections", "correction_id", "correction"),
      ...collect("turn_traces", "trace_id", "trace"),
      ...collect("retrieval_traces", "retrieval_id", "retrieval_trace"),
      ...collect("triggers", "trigger_id", "trigger"),
      ...(selector.sessionId === undefined
        ? collect("failure_clusters", "cluster_id", "failure_cluster", false)
        : []),
      ...collect("source_events", "event_id", "source_event"),
      ...collect("turns", "turn_id", "turn"),
      ...collect("maintenance_jobs", "job_id", "maintenance_job"),
      ...collect("memory_audit_log", "audit_id", "memory_audit"),
      ...collect("memory_quality_metrics", "metric_id", "memory_quality"),
      ...collect(
        "memory_temperatures",
        `memory_type || '${OWNER_ID_SEPARATOR}' || memory_id`,
        "memory_temperature",
      ),
      ...collect("memory_partitions", "partition_id", "memory_partition"),
      ...collect("session_lifecycle", "session_id", "session"),
    ];
  }

  private resolveForgetEntityId(entityType: string, entityId: string): string {
    if (entityType !== "world_claim" && entityType !== "policy") return entityId;
    if (entityId.includes(OWNER_ID_SEPARATOR)) {
      this.parseVersionedId(entityId);
      return entityId;
    }
    const descriptor = entityType === "world_claim"
      ? { table: "world_claims", idColumn: "claim_id" }
      : { table: "policies", idColumn: "policy_id" };
    const row = this.database
      .prepare(`SELECT version FROM ${descriptor.table} WHERE ${descriptor.idColumn} = ? ORDER BY version DESC LIMIT 1`)
      .get(entityId) as Row | undefined;
    if (row === undefined) this.notFound(`${entityType} ${entityId} was not found`);
    return this.versionedId(entityId, Number(row.version));
  }

  private deleteEntity(
    entityType: string,
    entityId: string,
    selector: ForgetSelector,
    revision: number,
    deletedAt: string,
    deleted: Record<string, number>,
    seen: Set<string>,
  ): number {
    const seenKey = `${entityType}:${entityId}`;
    if (seen.has(seenKey)) return 0;
    seen.add(seenKey);

    const descriptor = this.entityDescriptor(entityType, entityId);
    const row = descriptor
      ? this.database.prepare(`SELECT * FROM ${descriptor.table} WHERE ${descriptor.where}`).get(...descriptor.args) as Row | undefined
      : undefined;
    if (row && "user_id" in row) this.assertForgetScope(row, selector);

    let tombstonesCreated = 0;
    if (row && entityType === "source_event") {
      const cascadeSelector: ForgetSelector = { userId: selector.userId };
      if (selector.reason !== undefined) cascadeSelector.reason = selector.reason;
      const owners = this.database
        .prepare("SELECT owner_type, owner_id FROM source_links WHERE event_id = ?")
        .all(entityId) as Row[];
      for (const owner of owners) {
        tombstonesCreated += this.deleteEntity(
          String(owner.owner_type),
          String(owner.owner_id),
          cascadeSelector,
          revision,
          deletedAt,
          deleted,
          seen,
        );
      }
    }
    if (
      row &&
      [
        "world_claim",
        "policy",
        "episode",
        "correction",
        "observation",
        "memory_object",
        "memory_relation",
        "memory_version",
        "contradiction",
      ].includes(entityType)
    ) {
      const linkedEvents = this.database
        .prepare("SELECT event_id FROM source_links WHERE owner_type = ? AND owner_id = ?")
        .all(entityType, entityId) as Row[];
      const cascadeSelector: ForgetSelector = { userId: selector.userId };
      if (selector.reason !== undefined) cascadeSelector.reason = selector.reason;
      for (const linked of linkedEvents) {
        tombstonesCreated += this.deleteEntity(
          "source_event",
          String(linked.event_id),
          cascadeSelector,
          revision,
          deletedAt,
          deleted,
          seen,
        );
      }
    }
    if (row && (entityType === "policy" || entityType === "world_claim")) {
      const [stableId] = this.parseVersionedId(entityId);
      const descriptor = entityType === "policy"
        ? { table: "policies", idColumn: "policy_id" }
        : { table: "world_claims", idColumn: "claim_id" };
      const versions = this.database
        .prepare(`SELECT ${descriptor.idColumn} AS stable_id, version FROM ${descriptor.table} WHERE ${descriptor.idColumn} = ?`)
        .all(stableId) as Row[];
      for (const version of versions) {
        const versionedId = this.versionedId(String(version.stable_id), Number(version.version));
        if (versionedId === entityId) continue;
        tombstonesCreated += this.deleteEntity(
          entityType,
          versionedId,
          selector,
          revision,
          deletedAt,
          deleted,
          seen,
        );
      }
    }
    if (row && entityType === "turn") {
      for (const [table, idColumn, type] of [
        ["observations", "observation_id", "observation"],
        ["corrections", "correction_id", "correction"],
        ["turn_traces", "trace_id", "trace"],
        ["retrieval_traces", "retrieval_id", "retrieval_trace"],
      ] as const) {
        const children = this.database.prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE turn_id = ?`).all(entityId) as Row[];
        for (const child of children) {
          tombstonesCreated += this.deleteEntity(
            type,
            String(child.id),
            selector,
            revision,
            deletedAt,
            deleted,
            seen,
          );
        }
      }
    }

    if (row && entityType === "session") {
      const sessionSelector: ForgetSelector = {
        userId: String(row.user_id),
        sessionId: entityId,
      };
      if (typeof row.workspace_id === "string") sessionSelector.workspaceId = row.workspace_id;
      if (selector.reason !== undefined) sessionSelector.reason = selector.reason;
      for (const child of this.collectScopedEntities(sessionSelector)) {
        if (child.type === "session" && child.id === entityId) continue;
        tombstonesCreated += this.deleteEntity(
          child.type,
          child.id,
          sessionSelector,
          revision,
          deletedAt,
          deleted,
          seen,
        );
      }
    }

    if (row && entityType === "correction") {
      const clusterRows = this.database.prepare(`
        SELECT * FROM failure_clusters
        WHERE user_id = ? AND (workspace_id IS NULL OR workspace_id = ?)
      `).all(String(row.user_id), row.workspace_id ?? null) as Row[];
      for (const clusterRow of clusterRows) {
        const clusterId = String(clusterRow.cluster_id);
        const cluster = this.open<FailureClusterRecord>(
          "failure_cluster",
          clusterId,
          String(clusterRow.encrypted_payload),
        );
        if (!this.failureClusterReferencesCorrection(cluster, entityId)) continue;
        const clusterSelector: ForgetSelector = { userId: cluster.scope.userId };
        if (cluster.scope.workspaceId !== undefined) clusterSelector.workspaceId = cluster.scope.workspaceId;
        if (selector.reason !== undefined) clusterSelector.reason = selector.reason;
        tombstonesCreated += this.deleteEntity(
          "failure_cluster",
          clusterId,
          clusterSelector,
          revision,
          deletedAt,
          deleted,
          seen,
        );
      }
    }

    if (row && entityType === "failure_cluster") {
      const cluster = this.open<FailureClusterRecord>(
        "failure_cluster",
        entityId,
        String(row.encrypted_payload),
      );
      const artifactIds = [entityId, ...cluster.correctionIds];
      const triggerRows = this.database.prepare(`
        SELECT * FROM triggers
        WHERE user_id = ? AND (workspace_id IS NULL OR workspace_id = ?)
      `).all(cluster.scope.userId, cluster.scope.workspaceId ?? null) as Row[];
      for (const triggerRow of triggerRows) {
        const triggerId = String(triggerRow.trigger_id);
        const trigger = this.open<TriggerRecord>("trigger", triggerId, String(triggerRow.encrypted_payload));
        if (trigger.learnedFromClusterId !== entityId) continue;
        const triggerSelector: ForgetSelector = { userId: trigger.scope.userId };
        if (trigger.scope.workspaceId !== undefined) triggerSelector.workspaceId = trigger.scope.workspaceId;
        if (trigger.scope.sessionId !== undefined) triggerSelector.sessionId = trigger.scope.sessionId;
        if (selector.reason !== undefined) triggerSelector.reason = selector.reason;
        tombstonesCreated += this.deleteEntity(
          "trigger",
          triggerId,
          triggerSelector,
          revision,
          deletedAt,
          deleted,
          seen,
        );
      }
      const calibrationRows = this.database.prepare("SELECT * FROM calibration_patterns").all() as Row[];
      for (const calibrationRow of calibrationRows) {
        const patternId = String(calibrationRow.pattern_id);
        const calibration = this.open<CalibrationPatternRecord>(
          "calibration_pattern",
          patternId,
          String(calibrationRow.encrypted_payload),
        );
        if (!this.valueReferencesAnyIdentifier(calibration.pattern, artifactIds)) continue;
        const calibrationSelector: ForgetSelector = { userId: cluster.scope.userId };
        if (selector.reason !== undefined) calibrationSelector.reason = selector.reason;
        tombstonesCreated += this.deleteEntity(
          "calibration_pattern",
          patternId,
          calibrationSelector,
          revision,
          deletedAt,
          deleted,
          seen,
        );
      }
      this.deleteLearningJobsReferencing(cluster.scope, artifactIds, deleted);
    }

    if (row && entityType === "trigger") {
      this.database.prepare("DELETE FROM trigger_activations WHERE trigger_id = ?").run(entityId);
    }
    if (row && entityType === "world_claim") {
      const [claimId] = this.parseVersionedId(entityId);
      const contradictions = this.database.prepare(`
        SELECT contradiction_id AS id FROM contradictions
        WHERE old_claim_id = ? OR new_claim_id = ?
      `).all(claimId, claimId) as Row[];
      for (const contradiction of contradictions) {
        tombstonesCreated += this.deleteEntity(
          "contradiction",
          String(contradiction.id),
          selector,
          revision,
          deletedAt,
          deleted,
          seen,
        );
      }
    }
    if (row && entityType === "memory_object") {
      const relations = this.database.prepare(`
        SELECT relation_id AS id FROM memory_relations
        WHERE (from_type = 'object' AND from_id = ?)
           OR (to_type = 'object' AND to_id = ?)
      `).all(entityId, entityId) as Row[];
      for (const relation of relations) {
        tombstonesCreated += this.deleteEntity(
          "memory_relation",
          String(relation.id),
          selector,
          revision,
          deletedAt,
          deleted,
          seen,
        );
      }
      const versions = this.database.prepare(`
        SELECT version_id AS id FROM memory_versions
        WHERE memory_type = 'object' AND memory_id = ?
      `).all(entityId) as Row[];
      for (const version of versions) {
        tombstonesCreated += this.deleteEntity(
          "memory_version",
          String(version.id),
          selector,
          revision,
          deletedAt,
          deleted,
          seen,
        );
      }
      const memberDelete = this.database.prepare(`
        DELETE FROM memory_object_members WHERE object_id = ?
          OR (member_type = 'object' AND member_id = ?)
      `).run(entityId, entityId);
      if (memberDelete.changes > 0) {
        deleted.memory_object_member = (deleted.memory_object_member ?? 0) + memberDelete.changes;
      }
      this.database.prepare(`
        DELETE FROM memory_temperatures WHERE memory_type = 'object' AND memory_id = ?
      `).run(entityId);
      this.database.prepare(`
        DELETE FROM memory_quality_metrics WHERE owner_type = 'object' AND owner_id = ?
      `).run(entityId);
    }
    if (row && entityType === "memory_partition") {
      const objects = this.database.prepare(`
        SELECT object_id AS id FROM memory_objects WHERE partition_id = ?
      `).all(entityId) as Row[];
      for (const object of objects) {
        tombstonesCreated += this.deleteEntity(
          "memory_object",
          String(object.id),
          selector,
          revision,
          deletedAt,
          deleted,
          seen,
        );
      }
    }
    if (row && entityType === "maintenance_job") {
      const actions = this.database.prepare(`
        SELECT action_id AS id FROM maintenance_actions WHERE job_id = ?
      `).all(entityId) as Row[];
      for (const action of actions) {
        tombstonesCreated += this.deleteEntity(
          "maintenance_action",
          String(action.id),
          selector,
          revision,
          deletedAt,
          deleted,
          seen,
        );
      }
      const auditDelete = this.database.prepare("DELETE FROM memory_audit_log WHERE job_id = ?").run(entityId);
      if (auditDelete.changes > 0) {
        deleted.memory_audit = (deleted.memory_audit ?? 0) + auditDelete.changes;
      }
    }
    if (row && "user_id" in row) {
      const rowScope: ScopeRef = { userId: String(row.user_id) };
      if (typeof row.workspace_id === "string") rowScope.workspaceId = row.workspace_id;
      if (typeof row.session_id === "string") rowScope.sessionId = row.session_id;
      this.deleteLearningJobsReferencing(rowScope, [entityId], deleted);
      if (["source_event", "world_claim", "correction"].includes(entityType)) {
        const relationDelete = this.database.prepare(`
          DELETE FROM entity_edges
          WHERE user_id = ?
            AND ((? IS NULL AND workspace_id IS NULL) OR workspace_id = ?)
            AND from_type = 'entity' AND to_type = 'entity'
        `).run(rowScope.userId, rowScope.workspaceId ?? null, rowScope.workspaceId ?? null);
        if (relationDelete.changes > 0) {
          deleted.entity_relation = (deleted.entity_relation ?? 0) + relationDelete.changes;
        }
      }
    }

    if (row && descriptor) {
      if (entityType === "source_event") {
        this.database.prepare("DELETE FROM source_events_fts WHERE event_id = ?").run(entityId);
      } else if (entityType === "world_claim") {
        this.database.prepare("DELETE FROM world_claims_fts WHERE row_key = ?").run(entityId);
      } else if (entityType === "policy") {
        this.database.prepare("DELETE FROM policies_fts WHERE row_key = ?").run(entityId);
      } else if (entityType === "episode") {
        this.database.prepare("DELETE FROM episodes_fts WHERE episode_id = ?").run(entityId);
      } else if (entityType === "memory_object") {
        this.database.prepare("DELETE FROM memory_objects_fts WHERE object_id = ?").run(entityId);
      }
      this.database.prepare("DELETE FROM source_links WHERE owner_type = ? AND owner_id = ?").run(entityType, entityId);
      this.database.prepare("DELETE FROM embeddings WHERE owner_type = ? AND owner_id = ?").run(entityType, entityId);
      this.database.prepare("DELETE FROM embedding_buckets WHERE owner_type = ? AND owner_id = ?").run(entityType, entityId);
      this.database.prepare("DELETE FROM cache_entries WHERE owner_type = ? AND owner_id = ?").run(entityType, entityId);
      this.database.prepare(`
        DELETE FROM entity_edges
        WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)
      `).run(entityType, entityId, entityType, entityId);
      this.database.prepare(`DELETE FROM ${descriptor.table} WHERE ${descriptor.where}`).run(...descriptor.args);
      this.database.prepare("DELETE FROM idempotency_keys WHERE entity_id = ?").run(entityId);
      deleted[entityType] = (deleted[entityType] ?? 0) + 1;
    }

    const info = this.database.prepare(`
      INSERT OR IGNORE INTO tombstones(
        entity_type, entity_id, revision, device_id, user_id, workspace_id, session_id, deleted_at, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entityType,
      entityId,
      revision,
      this.deviceId,
      selector.userId,
      selector.workspaceId ?? (row && typeof row.workspace_id === "string" ? row.workspace_id : null),
      selector.sessionId ?? (row && typeof row.session_id === "string" ? row.session_id : null),
      deletedAt,
      selector.reason === undefined ? null : redactSensitiveContent(selector.reason).value.slice(0, 500),
    );
    if (info.changes > 0) tombstonesCreated += 1;
    return tombstonesCreated;
  }

  private entityDescriptor(
    entityType: string,
    entityId: string,
  ): { table: string; where: string; args: unknown[] } | undefined {
    switch (entityType) {
      case "source_event": return { table: "source_events", where: "event_id = ?", args: [entityId] };
      case "turn": return { table: "turns", where: "turn_id = ?", args: [entityId] };
      case "observation": return { table: "observations", where: "observation_id = ?", args: [entityId] };
      case "world_claim": {
        const [id, version] = this.parseVersionedId(entityId);
        return { table: "world_claims", where: "claim_id = ? AND version = ?", args: [id, version] };
      }
      case "policy": {
        const [id, version] = this.parseVersionedId(entityId);
        return { table: "policies", where: "policy_id = ? AND version = ?", args: [id, version] };
      }
      case "episode": return { table: "episodes", where: "episode_id = ?", args: [entityId] };
      case "memory_object": return { table: "memory_objects", where: "object_id = ?", args: [entityId] };
      case "memory_partition": return { table: "memory_partitions", where: "partition_id = ?", args: [entityId] };
      case "memory_relation": return { table: "memory_relations", where: "relation_id = ?", args: [entityId] };
      case "memory_version": return { table: "memory_versions", where: "version_id = ?", args: [entityId] };
      case "contradiction": return { table: "contradictions", where: "contradiction_id = ?", args: [entityId] };
      case "retrieval_trace": return { table: "retrieval_traces", where: "retrieval_id = ?", args: [entityId] };
      case "maintenance_job": return { table: "maintenance_jobs", where: "job_id = ?", args: [entityId] };
      case "maintenance_action": return { table: "maintenance_actions", where: "action_id = ?", args: [entityId] };
      case "memory_audit": return { table: "memory_audit_log", where: "audit_id = ?", args: [entityId] };
      case "memory_quality": return { table: "memory_quality_metrics", where: "metric_id = ?", args: [entityId] };
      case "memory_temperature": {
        const separator = entityId.indexOf(OWNER_ID_SEPARATOR);
        if (separator < 1) throw new TypeError(`Invalid memory temperature ID ${entityId}`);
        return {
          table: "memory_temperatures",
          where: "memory_type = ? AND memory_id = ?",
          args: [entityId.slice(0, separator), entityId.slice(separator + 1)],
        };
      }
      case "correction": return { table: "corrections", where: "correction_id = ?", args: [entityId] };
      case "trace": return { table: "turn_traces", where: "trace_id = ?", args: [entityId] };
      case "trigger": return { table: "triggers", where: "trigger_id = ?", args: [entityId] };
      case "failure_cluster": return { table: "failure_clusters", where: "cluster_id = ?", args: [entityId] };
      case "calibration_pattern": return { table: "calibration_patterns", where: "pattern_id = ?", args: [entityId] };
      case "session": return { table: "session_lifecycle", where: "session_id = ?", args: [entityId] };
      default: throw new TypeError(`Unsupported forget entity type: ${entityType}`);
    }
  }

  private failureClusterReferencesCorrection(cluster: FailureClusterRecord, correctionId: string): boolean {
    if (cluster.correctionIds.includes(correctionId)) return true;
    if (cluster.signature === null || typeof cluster.signature !== "object" || Array.isArray(cluster.signature)) return false;
    const selfReflectionIds = (cluster.signature as Record<string, unknown>).selfReflectionIds;
    return Array.isArray(selfReflectionIds) && selfReflectionIds.includes(correctionId);
  }

  private valueReferencesAnyIdentifier(value: unknown, identifiers: readonly string[]): boolean {
    if (identifiers.length === 0) return false;
    const serialized = canonicalJson(value);
    return identifiers.some((identifier) => serialized.includes(identifier));
  }

  private deleteLearningJobsReferencing(
    scope: ScopeRef,
    identifiers: readonly string[],
    deleted: Record<string, number>,
  ): void {
    if (identifiers.length === 0) return;
    const rows = this.database.prepare(`
      SELECT * FROM learning_jobs
      WHERE user_id = ? AND (workspace_id IS NULL OR workspace_id = ?)
    `).all(scope.userId, scope.workspaceId ?? null) as Row[];
    const remove = this.database.prepare("DELETE FROM learning_jobs WHERE job_id = ?");
    for (const row of rows) {
      const job = this.decodeLearningJob(row);
      if (!this.valueReferencesAnyIdentifier(job, identifiers)) continue;
      if (remove.run(job.jobId).changes > 0) {
        deleted.learning_job = (deleted.learning_job ?? 0) + 1;
      }
    }
  }

  private assertForgetScope(row: Row, selector: ForgetSelector): void {
    if (String(row.user_id) !== selector.userId) {
      throw new ProtocolError({ code: "SCOPE_DENIED", message: "Cannot forget memory owned by another user" });
    }
    if (selector.workspaceId !== undefined && row.workspace_id !== selector.workspaceId) {
      throw new ProtocolError({ code: "SCOPE_DENIED", message: "Cannot forget memory outside the selected workspace" });
    }
    if (selector.sessionId !== undefined && row.session_id !== selector.sessionId) {
      throw new ProtocolError({ code: "SCOPE_DENIED", message: "Cannot forget memory outside the selected session" });
    }
  }

  private insertImportedEvent(record: ExportPackage["records"]["sourceEvents"][number]): SourceEvent {
    const event = redactSensitiveValue(record.value).value;
    this.requireSession(event.scope);
    if (sha256(event.content) !== event.contentHash) {
      this.versionConflict(`Imported source event ${event.eventId} has an invalid content hash or requires redaction`);
    }
    const existing = this.getSourceEvent(event.eventId);
    if (existing) {
      if (sha256(canonicalJson({ ...existing, revision: 0 })) !== sha256(canonicalJson({ ...event, revision: 0 }))) {
        this.versionConflict(`Source event ${event.eventId} already exists with different content`);
      }
      return existing;
    }
    this.assertNotTombstoned("source_event", event.eventId);
    this.assertNotTombstoned("session", event.scope.sessionId);
    const sameKey = this.database
      .prepare("SELECT event_id FROM source_events WHERE idempotency_key = ?")
      .get(record.idempotencyKey) as Row | undefined;
    if (sameKey && String(sameKey.event_id) !== event.eventId) {
      this.versionConflict(`Source event idempotency key is already bound to ${String(sameKey.event_id)}`);
    }
    return this.database.transaction(() => {
      const revision = this.nextRevision();
      const imported: SourceEvent = { ...event, revision };
      this.database.prepare(`
        INSERT INTO source_events(
          event_id, revision, origin_revision, device_id, idempotency_key,
          user_id, workspace_id, session_id, kind, content_hash, captured_at,
          occurred_at, selected_evidence, encrypted_payload, record_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        revision,
        record.originRevision,
        event.deviceId,
        record.idempotencyKey,
        event.scope.userId,
        event.scope.workspaceId ?? null,
        event.scope.sessionId,
        event.kind,
        event.contentHash,
        event.capturedAt,
        event.occurredAt,
        event.selectedEvidence ? 1 : 0,
        this.seal("source_event", event.eventId, imported),
        sha256(canonicalJson(imported)),
      );
      this.database.prepare(`
        INSERT INTO source_events_fts(event_id, user_id, workspace_id, content) VALUES (?, ?, ?, ?)
      `).run(event.eventId, event.scope.userId, event.scope.workspaceId ?? null, event.content);
      this.touchMemoryScope(imported.scope, imported.capturedAt);
      this.touchIndex(revision);
      return imported;
    })();
  }

  private hasTombstone(entityType: string, entityId: string): boolean {
    return this.database
      .prepare("SELECT 1 FROM tombstones WHERE entity_type = ? AND entity_id = ?")
      .get(entityType, entityId) !== undefined;
  }

  private assertNotTombstoned(entityType: string, entityId: string): void {
    if (this.hasTombstone(entityType, entityId)) {
      this.versionConflict(`${entityType} ${entityId} has been forgotten and cannot be resurrected`);
    }
  }

  private hasRow(table: string, idColumn: string, id: string): boolean {
    this.assertSqlIdentifier(table);
    this.assertSqlIdentifier(idColumn);
    return this.database.prepare(`SELECT 1 FROM ${table} WHERE ${idColumn} = ?`).get(id) !== undefined;
  }

  private assertImportUsers(payload: ExportPackage, allowDifferentUser: boolean): void {
    const packageUsers = new Set<string>();
    const incomingEvents = new Map(
      (payload.records.sourceEvents ?? []).map((record) => [record.value.eventId, record.value] as const),
    );
    const addScope = (scope: Pick<ScopeRef, "userId">): void => {
      packageUsers.add(scope.userId);
    };
    const validateArtifactSources = (
      artifact: string,
      refs: readonly SourceRef[],
      required: boolean,
    ): void => {
      if (required && refs.length === 0) {
        throw new ProtocolError({
          code: "SCOPE_DENIED",
          message: `${artifact} has no authoritative SourceRef and cannot be attributed during import`,
        });
      }
      for (const ref of refs) {
        const event = incomingEvents.get(ref.eventId) ?? this.getSourceEvent(ref.eventId);
        if (event === undefined) {
          throw new ProtocolError({
            code: "SCOPE_DENIED",
            message: `${artifact} references source event ${ref.eventId} outside the import package and local store`,
          });
        }
        this.assertSourceRef(ref, event);
        addScope(event.scope);
      }
    };

    for (const record of payload.records.sourceEvents ?? []) addScope(record.value.scope);
    for (const record of payload.records.turns ?? []) addScope(record.scope);
    for (const record of payload.records.worldClaims ?? []) addScope(record.scope);
    for (const record of payload.records.policies ?? []) addScope(record.scope);
    for (const record of payload.records.episodes ?? []) addScope(record.scope);
    for (const record of payload.records.corrections ?? []) addScope(record.scope);
    for (const record of payload.records.traces ?? []) addScope(record.scope);
    for (const record of payload.records.triggers ?? []) {
      addScope(record.scope);
      validateArtifactSources(
        `Trigger ${record.triggerId}`,
        record.sourceRefs ?? [],
        record.learnedFromClusterId !== undefined,
      );
    }
    for (const record of payload.records.failureClusters ?? []) addScope(record.scope);
    for (const record of payload.records.sessions ?? []) addScope(record.scope);
    for (const record of payload.records.triggerActivations ?? []) addScope(record.scope);
    for (const record of payload.records.memoryPartitions ?? []) addScope(record.scope);
    for (const record of payload.records.memoryObjects ?? []) {
      addScope(record.scope);
      validateArtifactSources(`MemoryObject ${record.objectId}`, record.evidenceRefs, true);
    }
    for (const record of payload.records.memoryRelations ?? []) {
      addScope(record.scope);
      validateArtifactSources(`MemoryRelation ${record.relationId}`, record.evidenceRefs, false);
    }
    for (const record of payload.records.memoryVersions ?? []) {
      validateArtifactSources(`MemoryVersion ${record.versionId}`, record.evidenceRefs, false);
    }
    for (const record of payload.records.contradictions ?? []) {
      addScope(record.scope);
      validateArtifactSources(`Contradiction ${record.contradictionId}`, record.evidenceRefs, true);
    }
    for (const record of payload.records.memoryTemperatures ?? []) addScope(record.scope);
    for (const record of payload.records.retrievalTraces ?? []) addScope(record.scope);
    for (const record of payload.records.calibrationPatterns ?? []) {
      validateArtifactSources(`Calibration ${record.patternId}`, record.sourceRefs ?? [], true);
    }
    for (const record of payload.records.tombstones ?? []) {
      if (typeof record.user_id === "string") packageUsers.add(record.user_id);
    }
    if (allowDifferentUser) return;
    if (packageUsers.size > 1) {
      throw new ProtocolError({ code: "SCOPE_DENIED", message: "Import contains more than one user scope" });
    }
    const existing = this.database.prepare(`
      SELECT DISTINCT user_id FROM (
        SELECT user_id FROM source_events
        UNION ALL SELECT user_id FROM turns
        UNION ALL SELECT user_id FROM observations
        UNION ALL SELECT user_id FROM world_claims
        UNION ALL SELECT user_id FROM policies
        UNION ALL SELECT user_id FROM episodes
        UNION ALL SELECT user_id FROM corrections
        UNION ALL SELECT user_id FROM turn_traces
        UNION ALL SELECT user_id FROM triggers
        UNION ALL SELECT user_id FROM failure_clusters
        UNION ALL SELECT user_id FROM session_lifecycle
        UNION ALL SELECT user_id FROM trigger_activations
        UNION ALL SELECT user_id FROM memory_partitions
        UNION ALL SELECT user_id FROM memory_objects
        UNION ALL SELECT user_id FROM memory_relations
        UNION ALL SELECT user_id FROM contradictions
        UNION ALL SELECT user_id FROM memory_temperatures
        UNION ALL SELECT user_id FROM retrieval_traces
        UNION ALL SELECT user_id FROM maintenance_jobs
        UNION ALL SELECT user_id FROM memory_audit_log
        UNION ALL SELECT user_id FROM memory_quality_metrics
        UNION ALL SELECT user_id FROM tombstones
      ) LIMIT 2
    `).all() as Row[];
    const incoming = [...packageUsers][0];
    if (incoming !== undefined && existing.some((row) => String(row.user_id) !== incoming)) {
      throw new ProtocolError({ code: "SCOPE_DENIED", message: "Import user scope differs from this store" });
    }
  }

  private assertSqlIdentifier(value: string): void {
    if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new TypeError(`Unsafe SQL identifier: ${value}`);
  }

  private normalizePolicyScope(scope: ScopeRef, level: StoredPolicy["scopeLevel"]): ScopeRef {
    if (level === "user") return { userId: scope.userId };
    if (level === "workspace") {
      if (!scope.workspaceId) {
        throw new ProtocolError({ code: "INVALID_REQUEST", message: "Workspace policy requires workspaceId" });
      }
      return { userId: scope.userId, workspaceId: scope.workspaceId };
    }
    if (!scope.sessionId) {
      throw new ProtocolError({ code: "INVALID_REQUEST", message: "Session policy requires sessionId" });
    }
    const normalized: ScopeRef = { userId: scope.userId, sessionId: scope.sessionId };
    if (scope.workspaceId !== undefined) normalized.workspaceId = scope.workspaceId;
    return normalized;
  }

  private requireWritable(): void {
    if (this.readonly) throw new Error("MemoryStore is read-only");
  }

  private required<T>(value: T | undefined, label: string): T {
    if (value === undefined) throw new Error(`Missing ${label}`);
    return value;
  }

  private isoNow(): string {
    return this.now().toISOString();
  }

  private notFound(message: string): never {
    throw new ProtocolError({ code: "NOT_FOUND", message });
  }

  private versionConflict(message: string): never {
    throw new ProtocolError({ code: "VERSION_CONFLICT", message });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
