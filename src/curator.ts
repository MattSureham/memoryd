import { randomUUID } from "node:crypto";
import {
  type Contradiction,
  type MaintenanceAction,
  type MaintenanceJob,
  type MaintenanceJobType,
  type MaintenanceRunResult,
  type MemoryObject,
  type MemoryObjectMember,
  type MemoryPartition,
  type MemoryQualityMetrics,
  type MemoryRelation,
  type MemoryTemperature,
  type MemoryVersion,
  type ScopeRef,
  type SourceRef,
  type WorldClaim,
} from "./contracts.js";
import {
  loadEvolutionConfig,
  type MemoryEvolutionConfig,
} from "./config.js";
import {
  computeMemoryTemperature,
  deriveObjectTitle,
  estimateMemoryTokens,
  evaluateObjectHealth,
  fingerprintMemory,
  memorySimilarity,
  splitMemoryMembers,
  stableEvolutionId,
  summarizeMemoryMembers,
  type FingerprintedMember,
} from "./core/evolution.js";
import {
  MemoryStore,
  type StoredTurn,
} from "./storage/index.js";

const CURATOR_VERSION = "curator-v1";
const OBJECT_SCHEMA_VERSION = 1;
const SUMMARY_VERSION = "deterministic-locator-v1";

interface CuratorOptions {
  config?: Partial<MemoryEvolutionConfig>;
  now?: () => Date;
  algorithmVersion?: string;
}

interface MaterializedMember extends FingerprintedMember {
  scope: ScopeRef;
  evidenceRefs: SourceRef[];
  confidence: number;
  explicitRemember: boolean;
}

interface ActionSpec {
  type: MaintenanceAction["type"];
  targetType: MaintenanceAction["targetType"];
  targetId: string;
  reason: string;
  reversible: boolean;
  before?: unknown;
  after?: unknown;
}

interface ProcessContext {
  job: MaintenanceJob;
  sequence: number;
  actions: MaintenanceAction[];
  metrics: MemoryQualityMetrics[];
}

function uniqueRefs(refs: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.eventId}\u001f${ref.contentHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function scopeIdentity(scope: ScopeRef): string {
  return [
    scope.userId,
    scope.workspaceId ?? "",
    scope.sessionId ?? "",
  ].join("\u001f");
}

function semanticMemberId(claim: WorldClaim): string {
  return `${claim.claimId}\u001f${claim.version}`;
}

function parseSemanticMemberId(value: string): { claimId: string; version?: number } {
  const separator = value.lastIndexOf("\u001f");
  if (separator < 0) return { claimId: value };
  const version = Number(value.slice(separator + 1));
  return {
    claimId: value.slice(0, separator),
    ...(Number.isInteger(version) ? { version } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asObjects(value: unknown): MemoryObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is MemoryObject =>
        item !== null && typeof item === "object" && typeof (item as MemoryObject).objectId === "string")
    : [];
}

function asMembers(value: unknown): MemoryObjectMember[] {
  return Array.isArray(value)
    ? value.filter((item): item is MemoryObjectMember =>
        item !== null && typeof item === "object" && typeof (item as MemoryObjectMember).objectId === "string")
    : [];
}

function asPartitions(value: unknown): MemoryPartition[] {
  return Array.isArray(value)
    ? value.filter((item): item is MemoryPartition =>
        item !== null && typeof item === "object" && typeof (item as MemoryPartition).partitionId === "string")
    : [];
}

function memberIdentity(member: MemoryObjectMember): string {
  return `${member.objectId}\u001f${member.memberType}\u001f${member.memberId}`;
}

function episodeEntityKeys(episode: { participants: string[]; entityKeys?: unknown }): string[] {
  const genericParticipants = /^(?:user|assistant|agent|system|tool|human|ai)$/iu;
  const participants = episode.participants.filter((value) => !genericParticipants.test(value.trim()));
  const indexed = Array.isArray(episode.entityKeys)
    ? episode.entityKeys.filter((value): value is string => typeof value === "string")
    : [];
  return uniqueStrings([...indexed, ...participants]);
}

export class MemoryCurator {
  readonly config: MemoryEvolutionConfig;
  readonly algorithmVersion: string;

  private readonly now: () => Date;

  constructor(
    readonly store: MemoryStore,
    options: CuratorOptions = {},
  ) {
    this.config = { ...loadEvolutionConfig({}), ...options.config };
    this.now = options.now ?? (() => new Date());
    this.algorithmVersion = options.algorithmVersion ?? CURATOR_VERSION;
  }

  enqueue(
    scope: ScopeRef,
    type: MaintenanceJobType,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    dryRun = false,
  ): MaintenanceJob {
    return this.store.enqueueMaintenanceJob(type, scope, payload, idempotencyKey, dryRun);
  }

  run(
    scope: ScopeRef,
    options: {
      type?: MaintenanceJobType;
      payload?: Record<string, unknown>;
      dryRun?: boolean;
      idempotencyKey?: string;
    } = {},
  ): MaintenanceRunResult {
    const type = options.type ?? "scan";
    const key = options.idempotencyKey ??
      `curator:${type}:${scopeIdentity(scope)}:${this.store.getRevision()}:${options.dryRun ? "dry" : "apply"}`;
    const job = this.enqueue(scope, type, options.payload ?? {}, key, options.dryRun ?? false);
    if (job.status === "completed") {
      return {
        job,
        actions: this.store.listMaintenanceActions(job.jobId),
        metrics: this.store.listMemoryQualityMetrics(scope).filter((metric) =>
          metric.measuredAt >= job.createdAt),
      };
    }
    return this.executeJob(job);
  }

  processJobs(limit = this.config.curatorBatchSize): MaintenanceRunResult[] {
    const jobs = this.store.claimMaintenanceJobs(limit, {
      leaseMs: this.config.maintenanceLeaseMs,
      maxAttempts: this.config.maintenanceMaxAttempts,
    });
    const results: MaintenanceRunResult[] = [];
    for (const job of jobs) {
      try {
        results.push(this.executeJob(job));
      } catch (error) {
        this.store.failMaintenanceJob(job.jobId, error instanceof Error ? error.message : String(error), {
          maxAttempts: this.config.maintenanceMaxAttempts,
        });
      }
    }
    return results;
  }

  executeJob(job: MaintenanceJob): MaintenanceRunResult {
    if (job.status === "completed") {
      return {
        job,
        actions: this.store.listMaintenanceActions(job.jobId),
        metrics: this.store.listMemoryQualityMetrics(job.scope).filter((metric) =>
          metric.measuredAt >= job.createdAt),
      };
    }
    const context: ProcessContext = {
      job,
      sequence: this.store.listMaintenanceActions(job.jobId).length,
      actions: [],
      metrics: [],
    };
    switch (job.type) {
      case "scan":
        this.scan(context);
        break;
      case "ingest":
        this.ingestFromPayload(context);
        break;
      case "merge":
        this.mergeFromPayload(context);
        break;
      case "split":
        this.splitFromPayload(context);
        break;
      case "rename":
        this.renameFromPayload(context);
        break;
      case "reorganize":
        this.reorganize(context);
        break;
      case "refresh_summary":
        this.refreshFromPayload(context);
        break;
      case "temperature":
      case "archive":
        this.updateTemperatures(context);
        break;
      case "reindex":
        this.reindex(context);
        break;
      case "integrity_check":
        this.integrityCheck(context);
        break;
      case "quality":
        this.measureQuality(context);
        break;
    }
    const completed = this.store.completeMaintenanceJob(job.jobId);
    return { job: completed, actions: context.actions, metrics: context.metrics };
  }

  rollback(actionId: string, idempotencyKey: string): MaintenanceAction {
    const action = this.store.getMaintenanceAction(actionId);
    if (action === undefined) throw new Error(`Maintenance action ${actionId} was not found`);
    if (!action.reversible) throw new Error(`Maintenance action ${actionId} is not reversible`);
    if (action.status === "rolled_back") return action;
    if (action.status !== "applied") throw new Error(`Maintenance action ${actionId} is not applied`);
    const job = this.store.getMaintenanceJob(action.jobId);
    if (job === undefined) throw new Error(`Maintenance job ${action.jobId} was not found`);
    const existingAudit = this.store.listMaintenanceAudit(job.scope, 5_000)
      .find((record) => record.event === "action_rollback" && record.details.idempotencyKey === idempotencyKey);
    if (existingAudit !== undefined) return this.store.getMaintenanceAction(actionId) as MaintenanceAction;

    this.store.transact(() => {
      const before = asRecord(action.before);
      const after = asRecord(action.after);
      const priorObjects = before?.objects ?? (before?.object === undefined ? [] : [before.object]);
      const beforeObjects = asObjects(priorObjects);
      const restoredObjectIds = new Set(beforeObjects.map((object) => object.objectId));
      for (const object of beforeObjects) {
        const current = this.store.getMemoryObject(object.objectId, job.scope);
        const restored: MemoryObject = {
          ...object,
          version: Math.max(object.version + 1, (current?.version ?? object.version) + 1),
          updatedAt: this.isoNow(),
          provenance: {
            actor: "curator",
            operation: "restore",
            algorithm: "rollback",
            algorithmVersion: this.algorithmVersion,
            maintenanceActionId: action.actionId,
            sourceRefs: object.evidenceRefs,
            createdAt: this.isoNow(),
          },
        };
        this.store.putMemoryObject(restored);
        this.recordVersion(restored, "restore", action.actionId, current);
      }
      const beforeMembers = asMembers(before?.members);
      const beforeMemberIds = new Set(beforeMembers.map(memberIdentity));
      for (const member of beforeMembers) {
        this.store.putMemoryObjectMember({ ...member, updatedAt: this.isoNow() });
      }
      for (const member of asMembers(after?.members)) {
        if (beforeMemberIds.has(memberIdentity(member))) continue;
        const current = this.store.listMemoryObjectMembers(member.objectId, job.scope, true)
          .find((candidate) => memberIdentity(candidate) === memberIdentity(member));
        if (current === undefined) continue;
        this.store.putMemoryObjectMember({
          ...current,
          status: "removed",
          updatedAt: this.isoNow(),
          originActionId: action.actionId,
        });
      }

      const createdObjects = asObjects(after?.createdObjects ?? after?.objects);
      for (const object of createdObjects) {
        if (restoredObjectIds.has(object.objectId)) continue;
        const current = this.store.getMemoryObject(object.objectId, job.scope);
        if (current === undefined) continue;
        const deprecated: MemoryObject = {
          ...current,
          status: "deprecated",
          version: current.version + 1,
          updatedAt: this.isoNow(),
          provenance: {
            actor: "curator",
            operation: "rollback",
            algorithm: "rollback",
            algorithmVersion: this.algorithmVersion,
            maintenanceActionId: action.actionId,
            createdAt: this.isoNow(),
          },
        };
        this.store.putMemoryObject(deprecated);
        this.recordVersion(deprecated, "restore", action.actionId, current);
        for (const member of this.store.listMemoryObjectMembers(current.objectId, job.scope)) {
          this.store.putMemoryObjectMember({
            ...member,
            status: "removed",
            updatedAt: this.isoNow(),
          });
        }
      }

      const beforePartitions = asPartitions([
        ...(before?.partition === undefined ? [] : [before.partition]),
        ...(Array.isArray(before?.partitions) ? before.partitions : []),
      ]);
      const restoredPartitionIds = new Set(beforePartitions.map((partition) => partition.partitionId));
      for (const partition of beforePartitions) {
        const current = this.store.getMemoryPartition(partition.partitionId, job.scope);
        this.store.putMemoryPartition({
          ...partition,
          version: Math.max(partition.version + 1, (current?.version ?? partition.version) + 1),
          updatedAt: this.isoNow(),
        });
      }
      const createdPartitions = asPartitions([
        ...(after?.partition === undefined ? [] : [after.partition]),
        ...(Array.isArray(after?.children) ? after.children : []),
        ...(Array.isArray(after?.partitions) ? after.partitions : []),
      ]);
      for (const partition of createdPartitions) {
        if (restoredPartitionIds.has(partition.partitionId)) continue;
        const current = this.store.getMemoryPartition(partition.partitionId, job.scope);
        if (current === undefined) continue;
        this.store.putMemoryPartition({
          ...current,
          status: "archived",
          version: current.version + 1,
          updatedAt: this.isoNow(),
        });
      }

      const previousTemperature = before?.temperature;
      if (
        previousTemperature !== null &&
        typeof previousTemperature === "object" &&
        !Array.isArray(previousTemperature) &&
        typeof (previousTemperature as MemoryTemperature).memoryId === "string"
      ) {
        this.store.putMemoryTemperature({
          ...(previousTemperature as MemoryTemperature),
          updatedAt: this.isoNow(),
        });
      }

      const relations = Array.isArray(after?.relations)
        ? after.relations.filter((value): value is MemoryRelation =>
            value !== null && typeof value === "object" && typeof (value as MemoryRelation).relationId === "string")
        : [];
      for (const relation of relations) {
        const current = this.store.getMemoryRelation(relation.relationId, job.scope);
        if (current === undefined) continue;
        this.store.putMemoryRelation({
          ...current,
          status: "revoked",
          version: current.version + 1,
          updatedAt: this.isoNow(),
          provenance: {
            actor: "curator",
            operation: "rollback",
            algorithmVersion: this.algorithmVersion,
            maintenanceActionId: action.actionId,
            createdAt: this.isoNow(),
          },
        });
      }
      this.store.updateMaintenanceAction({
        ...action,
        status: "rolled_back",
        rolledBackAt: this.isoNow(),
      });
      this.store.putMaintenanceAudit({
        auditId: randomUUID(),
        revision: 0,
        scope: job.scope,
        jobId: job.jobId,
        actionId,
        event: "action_rollback",
        details: { idempotencyKey },
        createdAt: this.isoNow(),
      });
    });
    return this.store.getMaintenanceAction(actionId) as MaintenanceAction;
  }

  private scan(context: ProcessContext): void {
    const { scope } = context.job;
    const unassignedEpisodes = this.store.listUnassignedEpisodes(scope, this.config.curatorBatchSize);
    const unassignedClaims = this.store.listUnassignedWorldClaims(scope, false, this.config.curatorBatchSize);
    const unassigned: Array<{ type: MemoryObjectMember["memberType"]; id: string }> = [];
    for (
      let index = 0;
      unassigned.length < this.config.curatorBatchSize &&
        (index < unassignedEpisodes.length || index < unassignedClaims.length);
      index += 1
    ) {
      const episode = unassignedEpisodes[index];
      if (episode !== undefined) unassigned.push({ type: "episode", id: episode.episodeId });
      const claim = unassignedClaims[index];
      if (claim !== undefined && unassigned.length < this.config.curatorBatchSize) {
        unassigned.push({ type: "semantic", id: semanticMemberId(claim) });
      }
    }
    for (const candidate of unassigned) {
      this.ingestMember(context, candidate.type, candidate.id);
    }

    const objects = this.store.listMemoryObjects(scope, {
      statuses: ["active", "router"],
      limit: this.config.curatorBatchSize * 4,
    });
    for (const object of objects.slice(0, this.config.curatorBatchSize)) {
      const latestMetric = this.store.listMemoryQualityMetrics(
        scope,
        { type: "object", id: object.objectId },
        1,
      )[0];
      const health = evaluateObjectHealth(object, latestMetric, this.config);
      if (health.splitRecommended) this.splitObject(context, object.objectId, health.reasons.join(","));
      else if (health.refreshSummary) this.refreshObject(context, object.objectId, "stale_summary");
    }

    this.mergeDuplicateObjects(context);
    this.updateTemperatures(context);
    this.integrityCheck(context);
    this.measureQuality(context);
    this.refreshPartitionCounts(scope);
  }

  private ingestFromPayload(context: ProcessContext): void {
    const type = context.job.payload.memberType;
    const id = context.job.payload.memberId;
    if (
      !["raw", "episode", "semantic", "object"].includes(String(type)) ||
      typeof id !== "string"
    ) {
      throw new Error("ingest job requires memberType and memberId");
    }
    const ingested = this.ingestMember(context, type as MemoryObjectMember["memberType"], id);
    if (ingested === undefined) return;
    const current = this.store.getMemoryObject(ingested.objectId, context.job.scope) ?? ingested;
    const latestMetric = this.store.listMemoryQualityMetrics(
      context.job.scope,
      { type: "object", id: current.objectId },
      1,
    )[0];
    const health = evaluateObjectHealth(current, latestMetric, this.config);
    if (health.splitRecommended) {
      this.splitObject(context, current.objectId, health.reasons.join(","));
    }
    this.reorganize(context);
    this.refreshPartitionCounts(context.job.scope);
  }

  private ingestMember(
    context: ProcessContext,
    memberType: MemoryObjectMember["memberType"],
    memberId: string,
  ): MemoryObject | undefined {
    const { scope } = context.job;
    const existingMembership = this.store.listObjectsForMember(memberType, memberId, scope)
      .find((object) => ["active", "router", "merged"].includes(object.status));
    if (existingMembership !== undefined) {
      return this.refreshObject(context, existingMembership.objectId, "member_updated") ?? existingMembership;
    }
    const member = this.materializeMember(memberType, memberId, scope);
    if (member === undefined) return undefined;
    const routingScope: ScopeRef =
      member.memberType === "semantic" && member.scope.sessionId !== undefined
        ? member.scope
        : {
            userId: member.scope.userId,
            ...(member.scope.workspaceId === undefined ? {} : { workspaceId: member.scope.workspaceId }),
          };
    const partition = this.ensureRootPartition(context, routingScope, member.content);
    const candidates = this.store.listMemoryObjects(routingScope, {
      partitionIds: [partition.partitionId],
      statuses: ["active"],
      temperatures: ["hot", "warm", "cold"],
      limit: this.config.maxCandidateCount,
    });
    const scored = candidates.map((object) => ({
      object,
      score: memorySimilarity(
        member.fingerprint,
        fingerprintMemory(`${object.title}\n${object.summary}`, object.entityKeys),
      ),
    })).sort((left, right) => right.score - left.score || left.object.objectId.localeCompare(right.object.objectId));
    const match = scored.find((candidate) => candidate.score >= this.config.mergeSimilarity);
    if (match !== undefined) return this.attachMember(context, match.object, member, match.score);
    return this.createObject(context, partition, member);
  }

  private ensureRootPartition(context: ProcessContext, scope: ScopeRef, routeQuery: string): MemoryPartition {
    const partitionId = stableEvolutionId(
      "partition",
      scope.userId,
      scope.workspaceId ?? "user",
      scope.sessionId ?? "",
      "default",
    );
    const existing = this.store.getMemoryPartition(partitionId, scope);
    if (existing !== undefined) {
      if (existing.status !== "router") return existing;
      return this.store.routeMemoryPartitions(routeQuery, scope, {
        limit: this.config.maxRoutedObjects,
        maxDepth: this.config.maxExpansionDepth,
      }).find((partition) => partition.partitionId !== existing.partitionId) ?? existing;
    }
    const now = this.isoNow();
    const partition: MemoryPartition = {
      partitionId,
      scope: {
        userId: scope.userId,
        ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
        ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
      },
      namespace: "default",
      partitionKey: scope.workspaceId === undefined ? "user" : `workspace:${scope.workspaceId}`,
      strategy: scope.workspaceId === undefined ? "adaptive" : "workspace",
      status: "active",
      depth: 0,
      childCount: 0,
      objectCount: 0,
      capacity: this.config.maxChildCount,
      routingKeys: ["default", scope.workspaceId === undefined ? "user" : "workspace"],
      version: 1,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    const action = this.planAction(context, {
      type: "reindex",
      targetType: "partition",
      targetId: partitionId,
      reason: "create_root_partition",
      reversible: true,
      after: { createdObjects: [], partition },
    });
    if (!context.job.dryRun && action.status !== "applied") {
      this.store.putMemoryPartition(partition);
      this.applyAction(context, action);
    }
    return partition;
  }

  private createObject(
    context: ProcessContext,
    partition: MemoryPartition,
    member: MaterializedMember,
  ): MemoryObject {
    const now = this.isoNow();
    const objectId = stableEvolutionId(
      "object",
      scopeIdentity(member.scope),
      partition.partitionId,
      member.memberType,
      member.memberId,
      this.algorithmVersion,
    );
    const existing = this.store.getMemoryObject(objectId, member.scope);
    if (existing !== undefined) return existing;
    const summary = summarizeMemoryMembers([member], this.config.summaryMaxCharacters);
    const temperature = member.explicitRemember ? "hot" : "warm";
    const object: MemoryObject = {
      objectId,
      scope: partition.scope,
      partitionId: partition.partitionId,
      objectType: member.fingerprint.explicitEntities.length > 0 ? "entity" : "adaptive",
      title: deriveObjectTitle(member),
      summary,
      routingKeys: uniqueStrings([
        ...member.fingerprint.explicitEntities,
        ...member.fingerprint.entities.slice(0, 8),
        ...member.fingerprint.topics.slice(0, 12),
      ]),
      entityKeys: uniqueStrings(member.fingerprint.explicitEntities),
      status: "active",
      temperature,
      tokenEstimate: estimateMemoryTokens(summary),
      childCount: 0,
      memberCount: 1,
      confidence: member.confidence,
      evidenceRefs: uniqueRefs(member.evidenceRefs),
      version: 1,
      schemaVersion: OBJECT_SCHEMA_VERSION,
      summarizerVersion: SUMMARY_VERSION,
      createdAt: now,
      updatedAt: now,
      provenance: {
        actor: "curator",
        operation: "create",
        algorithm: "adaptive_ingest",
        algorithmVersion: this.algorithmVersion,
        sourceRefs: member.evidenceRefs,
        createdAt: now,
      },
    };
    const memberRecord: MemoryObjectMember = {
      objectId,
      memberType: member.memberType,
      memberId: member.memberId,
      role: member.memberType === "semantic" ? "semantic" : member.memberType === "episode" ? "episode" : "evidence",
      score: 1,
      status: "active",
      addedAt: now,
      updatedAt: now,
    };
    const action = this.planAction(context, {
      type: "create_object",
      targetType: "object",
      targetId: objectId,
      reason: "unassigned_memory",
      reversible: true,
      before: { objects: [], members: [] },
      after: { createdObjects: [object], members: [memberRecord] },
    });
    if (!context.job.dryRun && action.status !== "applied") {
      this.store.transact(() => {
        this.store.putMemoryObject(object);
        this.store.putMemoryObjectMember({ ...memberRecord, originActionId: action.actionId });
        this.store.putMemoryTemperature(this.initialTemperature(object, member.explicitRemember));
        this.recordVersion(object, "create", action.actionId);
        this.applyAction(context, action);
      });
    }
    return object;
  }

  private attachMember(
    context: ProcessContext,
    object: MemoryObject,
    member: MaterializedMember,
    score: number,
  ): MemoryObject {
    const existingMember = this.store.listMemoryObjectMembers(object.objectId, object.scope, true)
      .find((candidate) =>
        candidate.memberType === member.memberType && candidate.memberId === member.memberId);
    if (existingMember?.status === "active") return object;
    const now = this.isoNow();
    const currentMembers = this.materializeObjectMembers(object, true);
    const allMembers = [
      ...currentMembers.filter((candidate) =>
        candidate.memberType !== member.memberType || candidate.memberId !== member.memberId),
      member,
    ];
    const summary = summarizeMemoryMembers(allMembers, this.config.summaryMaxCharacters);
    const updated: MemoryObject = {
      ...object,
      summary,
      routingKeys: uniqueStrings([
        ...object.routingKeys,
        ...member.fingerprint.explicitEntities,
        ...member.fingerprint.entities.slice(0, 8),
        ...member.fingerprint.topics.slice(0, 12),
      ]),
      entityKeys: uniqueStrings([...object.entityKeys, ...member.fingerprint.explicitEntities]),
      tokenEstimate: estimateMemoryTokens(summary),
      memberCount: allMembers.length,
      confidence: Number(((object.confidence * currentMembers.length + member.confidence) / allMembers.length).toFixed(6)),
      evidenceRefs: uniqueRefs([...object.evidenceRefs, ...member.evidenceRefs]),
      version: object.version + 1,
      updatedAt: now,
      provenance: {
        actor: "curator",
        operation: "update",
        algorithm: "adaptive_ingest",
        algorithmVersion: this.algorithmVersion,
        sourceRefs: member.evidenceRefs,
        createdAt: now,
      },
    };
    const memberRecord: MemoryObjectMember = {
      objectId: object.objectId,
      memberType: member.memberType,
      memberId: member.memberId,
      role: member.memberType === "semantic" ? "semantic" : member.memberType === "episode" ? "episode" : "evidence",
      score,
      status: "active",
      addedAt: existingMember?.addedAt ?? now,
      updatedAt: now,
    };
    const action = this.planAction(context, {
      type: "attach",
      targetType: "object",
      targetId: object.objectId,
      reason: `similarity:${score.toFixed(3)}`,
      reversible: true,
      before: {
        objects: [object],
        members: existingMember === undefined ? [] : [existingMember],
      },
      after: { objects: [updated], members: [memberRecord] },
    });
    if (!context.job.dryRun && action.status !== "applied") {
      this.store.transact(() => {
        this.store.putMemoryObjectMember({ ...memberRecord, originActionId: action.actionId });
        this.store.putMemoryObject(updated);
        this.recordVersion(updated, "update", action.actionId, object);
        this.applyAction(context, action);
      });
    }
    return updated;
  }

  private mergeFromPayload(context: ProcessContext): void {
    const ids = context.job.payload.objectIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new Error("merge job requires objectIds");
    }
    this.mergeObjects(context, ids as string[], context.job.payload.force === true);
  }

  private mergeDuplicateObjects(context: ProcessContext): void {
    const objects = this.store.listMemoryObjects(context.job.scope, {
      statuses: ["active"],
      temperatures: ["hot", "warm", "cold"],
      limit: this.config.maxCandidateCount,
    });
    let best: { left: MemoryObject; right: MemoryObject; score: number } | undefined;
    for (let leftIndex = 0; leftIndex < objects.length; leftIndex += 1) {
      const left = objects[leftIndex];
      if (left === undefined) continue;
      const leftFingerprint = fingerprintMemory(`${left.title}\n${left.summary}`, left.entityKeys);
      for (let rightIndex = leftIndex + 1; rightIndex < objects.length; rightIndex += 1) {
        const right = objects[rightIndex];
        if (right === undefined || left.partitionId !== right.partitionId) continue;
        const score = memorySimilarity(
          leftFingerprint,
          fingerprintMemory(`${right.title}\n${right.summary}`, right.entityKeys),
        );
        if (
          score >= this.config.mergeSimilarity &&
          (best === undefined || score > best.score)
        ) best = { left, right, score };
      }
    }
    if (best !== undefined) {
      this.mergeObjects(context, [best.left.objectId, best.right.objectId], false, best.score);
    }
  }

  private mergeObjects(
    context: ProcessContext,
    objectIds: readonly string[],
    force = false,
    knownScore?: number,
  ): MemoryObject | undefined {
    const ids = uniqueStrings(objectIds).sort();
    if (ids.length < 2) throw new Error("merge requires at least two distinct objects");
    const objects = ids.map((id) => this.store.getMemoryObject(id, context.job.scope));
    if (objects.some((object) => object === undefined)) throw new Error("merge object was not found in scope");
    const defined = objects as MemoryObject[];
    const partitionId = defined[0]?.partitionId;
    if (defined.some((object) => object.partitionId !== partitionId)) {
      throw new Error("merge objects must share a partition");
    }
    const pairScores: number[] = [];
    for (let left = 0; left < defined.length; left += 1) {
      for (let right = left + 1; right < defined.length; right += 1) {
        const a = defined[left] as MemoryObject;
        const b = defined[right] as MemoryObject;
        pairScores.push(memorySimilarity(
          fingerprintMemory(`${a.title}\n${a.summary}`, a.entityKeys),
          fingerprintMemory(`${b.title}\n${b.summary}`, b.entityKeys),
        ));
      }
    }
    const score = knownScore ?? Math.min(...pairScores);
    if (!force && score < this.config.mergeSimilarity) {
      throw new Error(`merge similarity ${score.toFixed(3)} is below threshold ${this.config.mergeSimilarity}`);
    }
    const existingMerged = defined.find((object) => object.status === "merged" && object.parentObjectId !== undefined);
    if (existingMerged !== undefined) {
      return this.store.getMemoryObject(existingMerged.parentObjectId as string, context.job.scope);
    }

    const now = this.isoNow();
    const mergedId = stableEvolutionId("object", "merge", ...ids, this.algorithmVersion);
    const allMembers = defined.flatMap((object) => this.materializeObjectMembers(object, true));
    const summary = summarizeMemoryMembers(allMembers, this.config.summaryMaxCharacters);
    const evidenceRefs = uniqueRefs(defined.flatMap((object) => object.evidenceRefs));
    const merged: MemoryObject = {
      objectId: mergedId,
      scope: defined[0]?.scope as ScopeRef,
      partitionId: partitionId as string,
      objectType: defined.every((object) => object.objectType === defined[0]?.objectType)
        ? defined[0]?.objectType as MemoryObject["objectType"]
        : "adaptive",
      title: deriveObjectTitle(allMembers[0] ?? this.materializeObject(defined[0] as MemoryObject)),
      summary,
      routingKeys: uniqueStrings(defined.flatMap((object) => object.routingKeys)),
      entityKeys: uniqueStrings(defined.flatMap((object) => object.entityKeys)),
      status: "active",
      temperature: defined.some((object) => object.temperature === "hot") ? "hot" : "warm",
      tokenEstimate: estimateMemoryTokens(summary),
      childCount: defined.length,
      memberCount: defined.length,
      confidence: Math.min(...defined.map((object) => object.confidence)),
      evidenceRefs,
      version: 1,
      schemaVersion: OBJECT_SCHEMA_VERSION,
      summarizerVersion: SUMMARY_VERSION,
      createdAt: now,
      updatedAt: now,
      provenance: {
        actor: "curator",
        operation: "merge",
        algorithm: "similarity_merge",
        algorithmVersion: this.algorithmVersion,
        sourceRefs: evidenceRefs,
        createdAt: now,
      },
    };
    const updatedOriginals = defined.map((object) => ({
      ...object,
      status: "merged" as const,
      parentObjectId: mergedId,
      version: object.version + 1,
      updatedAt: now,
      provenance: {
        actor: "curator" as const,
        operation: "merge",
        algorithm: "similarity_merge",
        algorithmVersion: this.algorithmVersion,
        sourceRefs: object.evidenceRefs,
        createdAt: now,
      },
    }));
    const childMembers: MemoryObjectMember[] = defined.map((object) => ({
      objectId: mergedId,
      memberType: "object",
      memberId: object.objectId,
      role: "child",
      score,
      status: "active",
      addedAt: now,
      updatedAt: now,
    }));
    const relations: MemoryRelation[] = defined.map((object) => this.partOfRelation(object, merged, now));
    const action = this.planAction(context, {
      type: "merge",
      targetType: "object",
      targetId: mergedId,
      reason: `similarity:${score.toFixed(3)}`,
      reversible: true,
      before: {
        objects: defined,
        members: defined.flatMap((object) => this.store.listMemoryObjectMembers(object.objectId, object.scope, true)),
      },
      after: {
        createdObjects: [merged],
        objects: [merged, ...updatedOriginals],
        members: childMembers,
        relations,
      },
    });
    if (!context.job.dryRun && action.status !== "applied") {
      this.store.transact(() => {
        this.store.putMemoryObject(merged);
        for (const object of updatedOriginals) this.store.putMemoryObject(object);
        for (const member of childMembers) {
          this.store.putMemoryObjectMember({ ...member, originActionId: action.actionId });
        }
        for (const relation of relations) this.store.putMemoryRelation(relation);
        this.recordVersion(merged, "merge", action.actionId);
        for (const object of updatedOriginals) this.recordVersion(object, "merge", action.actionId);
        this.applyAction(context, action);
      });
    }
    return merged;
  }

  private splitFromPayload(context: ProcessContext): void {
    const objectId = context.job.payload.objectId;
    if (typeof objectId !== "string") throw new Error("split job requires objectId");
    this.splitObject(context, objectId, String(context.job.payload.reason ?? "manual"));
  }

  private renameFromPayload(context: ProcessContext): void {
    const objectId = context.job.payload.objectId;
    const title = context.job.payload.title;
    if (typeof objectId !== "string" || typeof title !== "string" || title.trim().length === 0) {
      throw new Error("rename job requires objectId and non-empty title");
    }
    const current = this.store.getMemoryObject(objectId, context.job.scope);
    if (current === undefined) throw new Error(`Memory object ${objectId} was not found`);
    const now = this.isoNow();
    const requestedKeys = Array.isArray(context.job.payload.routingKeys)
      ? context.job.payload.routingKeys.filter((value): value is string => typeof value === "string")
      : [];
    const updated: MemoryObject = {
      ...current,
      title: title.trim().slice(0, 120),
      routingKeys: uniqueStrings([...requestedKeys, ...current.routingKeys]),
      version: current.version + 1,
      updatedAt: now,
      provenance: {
        actor: "curator",
        operation: "rename",
        algorithm: "explicit_rename",
        algorithmVersion: this.algorithmVersion,
        sourceRefs: current.evidenceRefs,
        createdAt: now,
      },
    };
    const action = this.planAction(context, {
      type: "rename",
      targetType: "object",
      targetId: objectId,
      reason: String(context.job.payload.reason ?? "explicit_rename"),
      reversible: true,
      before: { objects: [current] },
      after: { objects: [updated] },
    });
    if (!context.job.dryRun && action.status !== "applied") {
      this.store.putMemoryObject(updated);
      this.recordVersion(updated, "rename", action.actionId, current);
      this.applyAction(context, action);
    }
  }

  private splitObject(
    context: ProcessContext,
    objectId: string,
    reason: string,
  ): MemoryObject[] {
    const parent = this.store.getMemoryObject(objectId, context.job.scope);
    if (parent === undefined) throw new Error(`Memory object ${objectId} was not found`);
    if (parent.status === "router") {
      return this.store.listMemoryObjectMembers(parent.objectId, parent.scope)
        .filter((member) => member.memberType === "object" && member.status === "active")
        .flatMap((member) => {
          const child = this.store.getMemoryObject(member.memberId, parent.scope);
          return child === undefined ? [] : [child];
        });
    }
    const activeMembers = this.store.listMemoryObjectMembers(parent.objectId, parent.scope)
      .filter((member) => member.status === "active" && member.memberType !== "object");
    const materialized = activeMembers.flatMap((member) => {
      const value = this.materializeMember(member.memberType, member.memberId, parent.scope);
      return value === undefined ? [] : [value];
    });
    if (materialized.length < 2) return [];
    const groups = splitMemoryMembers(materialized, this.config.targetObjectMembers);
    if (groups.length < 2) return [];
    const now = this.isoNow();
    const children: MemoryObject[] = [];
    const childMembers: MemoryObjectMember[] = [];
    const relations: MemoryRelation[] = [];
    for (const [index, group] of groups.entries()) {
      const childId = stableEvolutionId(
        "object",
        "split",
        parent.objectId,
        String(index),
        ...group.map((member) => member.memberId).sort(),
        this.algorithmVersion,
      );
      const summary = summarizeMemoryMembers(group, this.config.summaryMaxCharacters);
      const evidenceRefs = uniqueRefs(group.flatMap((member) => member.evidenceRefs));
      const child: MemoryObject = {
        objectId: childId,
        scope: parent.scope,
        partitionId: parent.partitionId,
        objectType: group.some((member) => member.fingerprint.explicitEntities.length > 0)
          ? "entity"
          : "adaptive",
        title: deriveObjectTitle(group[0] as MaterializedMember),
        summary,
        routingKeys: uniqueStrings(group.flatMap((member) => [
          ...member.fingerprint.explicitEntities,
          ...member.fingerprint.entities.slice(0, 8),
          ...member.fingerprint.topics.slice(0, 12),
        ])),
        entityKeys: uniqueStrings(group.flatMap((member) => member.fingerprint.explicitEntities)),
        status: "active",
        temperature: parent.temperature === "archive" ? "cold" : parent.temperature,
        parentObjectId: parent.objectId,
        tokenEstimate: estimateMemoryTokens(summary),
        childCount: 0,
        memberCount: group.length,
        confidence: Math.min(...group.map((member) => member.confidence)),
        evidenceRefs,
        version: 1,
        schemaVersion: OBJECT_SCHEMA_VERSION,
        summarizerVersion: SUMMARY_VERSION,
        createdAt: now,
        updatedAt: now,
        provenance: {
          actor: "curator",
          operation: "split",
          algorithm: "bounded_topic_split",
          algorithmVersion: this.algorithmVersion,
          sourceRefs: evidenceRefs,
          createdAt: now,
        },
      };
      children.push(child);
      for (const member of group) {
        childMembers.push({
          objectId: childId,
          memberType: member.memberType,
          memberId: member.memberId,
          role: member.memberType === "semantic" ? "semantic" : member.memberType === "episode" ? "episode" : "evidence",
          score: 1,
          status: "active",
          addedAt: now,
          updatedAt: now,
        });
      }
      relations.push(this.partOfRelation(child, parent, now));
    }
    const parentRouter: MemoryObject = {
      ...parent,
      status: "router",
      summary: children.map((child) => `${child.title}: ${child.summary.slice(0, 160)}`).join("\n")
        .slice(0, this.config.summaryMaxCharacters),
      childCount: children.length,
      memberCount: children.length,
      tokenEstimate: estimateMemoryTokens(
        children.map((child) => `${child.title}: ${child.summary.slice(0, 160)}`).join("\n"),
      ),
      version: parent.version + 1,
      updatedAt: now,
      provenance: {
        actor: "curator",
        operation: "split",
        algorithm: "bounded_topic_split",
        algorithmVersion: this.algorithmVersion,
        sourceRefs: parent.evidenceRefs,
        createdAt: now,
      },
    };
    const parentMembers = children.map((child): MemoryObjectMember => ({
      objectId: parent.objectId,
      memberType: "object",
      memberId: child.objectId,
      role: "route",
      score: 1,
      status: "active",
      addedAt: now,
      updatedAt: now,
    }));
    const removedMembers = activeMembers.map((member): MemoryObjectMember => ({
      ...member,
      status: "removed",
      updatedAt: now,
    }));
    const action = this.planAction(context, {
      type: "split",
      targetType: "object",
      targetId: parent.objectId,
      reason,
      reversible: true,
      before: {
        objects: [parent],
        members: this.store.listMemoryObjectMembers(parent.objectId, parent.scope, true),
      },
      after: {
        createdObjects: children,
        objects: [parentRouter, ...children],
        members: [...removedMembers, ...parentMembers, ...childMembers],
        relations,
      },
    });
    if (!context.job.dryRun && action.status !== "applied") {
      this.store.transact(() => {
        for (const child of children) this.store.putMemoryObject(child);
        for (const member of [...removedMembers, ...parentMembers, ...childMembers]) {
          this.store.putMemoryObjectMember({ ...member, originActionId: action.actionId });
        }
        this.store.putMemoryObject(parentRouter);
        for (const relation of relations) this.store.putMemoryRelation(relation);
        this.recordVersion(parentRouter, "split", action.actionId, parent);
        for (const child of children) this.recordVersion(child, "split", action.actionId);
        this.applyAction(context, action);
      });
    }
    return children;
  }

  private reorganize(context: ProcessContext): void {
    const partitions = this.store.listMemoryPartitions(context.job.scope, { includeArchived: true });
    for (const partition of partitions) {
      const objects = this.store.listMemoryObjects(context.job.scope, {
        partitionIds: [partition.partitionId],
        statuses: ["active", "router"],
        limit: 5_000,
      });
      if (objects.length <= partition.capacity) continue;
      const now = this.isoNow();
      const groups: MemoryObject[][] = [];
      for (let index = 0; index < objects.length; index += partition.capacity) {
        groups.push(objects.slice(index, index + partition.capacity));
      }
      const children = groups.map((group, index): MemoryPartition => ({
        partitionId: stableEvolutionId(
          "partition",
          partition.partitionId,
          String(index),
          ...group.map((object) => object.objectId).sort(),
        ),
        scope: partition.scope,
        namespace: partition.namespace,
        partitionKey: `adaptive:${index}`,
        strategy: "adaptive",
        status: "active",
        parentPartitionId: partition.partitionId,
        depth: partition.depth + 1,
        childCount: 0,
        objectCount: group.length,
        capacity: partition.capacity,
        routingKeys: uniqueStrings(group.flatMap((object) => object.routingKeys).slice(0, 64)),
        version: 1,
        schemaVersion: partition.schemaVersion,
        createdAt: now,
        updatedAt: now,
      }));
      const moved = groups.flatMap((group, index) => group.map((object): MemoryObject => ({
        ...object,
        partitionId: (children[index] as MemoryPartition).partitionId,
        version: object.version + 1,
        updatedAt: now,
        provenance: {
          actor: "curator",
          operation: "reorganize",
          algorithm: "bounded_partition",
          algorithmVersion: this.algorithmVersion,
          sourceRefs: object.evidenceRefs,
          createdAt: now,
        },
      })));
      const parent: MemoryPartition = {
        ...partition,
        status: "router",
        childCount: children.length,
        objectCount: 0,
        version: partition.version + 1,
        updatedAt: now,
      };
      const action = this.planAction(context, {
        type: "move",
        targetType: "partition",
        targetId: partition.partitionId,
        reason: `partition_capacity:${objects.length}/${partition.capacity}`,
        reversible: true,
        before: { partition, objects },
        after: { partition: parent, children, objects: moved },
      });
      if (!context.job.dryRun && action.status !== "applied") {
        this.store.transact(() => {
          this.store.putMemoryPartition(parent);
          for (const child of children) this.store.putMemoryPartition(child);
          for (const object of moved) this.store.putMemoryObject(object);
          this.applyAction(context, action);
        });
      }
    }
  }

  private refreshFromPayload(context: ProcessContext): void {
    const objectId = context.job.payload.objectId;
    if (typeof objectId !== "string") throw new Error("refresh_summary job requires objectId");
    this.refreshObject(context, objectId, "requested");
  }

  private refreshObject(context: ProcessContext, objectId: string, reason: string): MemoryObject | undefined {
    const object = this.store.getMemoryObject(objectId, context.job.scope);
    if (object === undefined) return undefined;
    const members = this.materializeObjectMembers(object, true);
    if (members.length === 0) return object;
    const summary = summarizeMemoryMembers(members, this.config.summaryMaxCharacters);
    if (summary === object.summary && object.summarizerVersion === SUMMARY_VERSION) return object;
    const updated: MemoryObject = {
      ...object,
      summary,
      tokenEstimate: estimateMemoryTokens(summary),
      evidenceRefs: uniqueRefs(members.flatMap((member) => member.evidenceRefs)),
      version: object.version + 1,
      summarizerVersion: SUMMARY_VERSION,
      updatedAt: this.isoNow(),
      provenance: {
        actor: "curator",
        operation: "update",
        algorithm: "summary_refresh",
        algorithmVersion: this.algorithmVersion,
        sourceRefs: object.evidenceRefs,
        createdAt: this.isoNow(),
      },
    };
    const action = this.planAction(context, {
      type: "summary",
      targetType: "object",
      targetId: object.objectId,
      reason,
      reversible: true,
      before: { objects: [object] },
      after: { objects: [updated] },
    });
    if (!context.job.dryRun && action.status !== "applied") {
      this.store.putMemoryObject(updated);
      this.recordVersion(updated, "update", action.actionId, object);
      this.applyAction(context, action);
    }
    return updated;
  }

  private updateTemperatures(context: ProcessContext): void {
    const now = this.isoNow();
    const objects = this.store.listMemoryObjects(context.job.scope, {
      statuses: ["active", "router", "merged", "archived"],
      limit: this.config.curatorBatchSize * 4,
    });
    for (const object of objects.slice(0, this.config.curatorBatchSize)) {
      const current = this.store.getMemoryTemperature("object", object.objectId, object.scope);
      const temperature = computeMemoryTemperature({
        memoryType: "object",
        memoryId: object.objectId,
        scope: object.scope,
        now,
        createdAt: object.createdAt,
        ...(current?.lastAccessedAt === undefined ? {} : { lastAccessedAt: current.lastAccessedAt }),
        ...(current?.lastMentionedAt === undefined ? {} : { lastMentionedAt: current.lastMentionedAt }),
        accessCount: current?.accessCount ?? 0,
        retrievalCount: current?.retrievalCount ?? 0,
        mentionCount: current?.mentionCount ?? 0,
        explicitRemember: current?.explicitRemember ?? object.temperature === "hot",
        activeProject: current?.activeProject ?? false,
        pinned: current?.pinned ?? false,
      }, this.config);
      if (temperature.tier === object.temperature && current?.score === temperature.score) continue;
      const updated: MemoryObject = {
        ...object,
        temperature: temperature.tier,
        status: temperature.tier === "archive" ? "archived" : object.status === "archived" ? "active" : object.status,
        version: object.version + 1,
        updatedAt: now,
        provenance: {
          actor: "curator",
          operation: temperature.tier === "archive" ? "archive" : "update",
          algorithm: "temperature",
          algorithmVersion: this.algorithmVersion,
          sourceRefs: object.evidenceRefs,
          createdAt: now,
        },
      };
      const action = this.planAction(context, {
        type: temperature.tier === "archive" ? "archive" : "temperature",
        targetType: "object",
        targetId: object.objectId,
        reason: `temperature:${object.temperature}->${temperature.tier}`,
        reversible: true,
        before: { objects: [object], temperature: current },
        after: { objects: [updated], temperature },
      });
      if (!context.job.dryRun && action.status !== "applied") {
        this.store.transact(() => {
          this.store.putMemoryTemperature(temperature);
          this.store.putMemoryObject(updated);
          this.recordVersion(
            updated,
            temperature.tier === "archive" ? "archive" : "update",
            action.actionId,
            object,
          );
          this.applyAction(context, action);
        });
      }
    }
  }

  private integrityCheck(context: ProcessContext): void {
    const objects = this.store.listMemoryObjects(context.job.scope, { limit: 5_000 });
    let members = 0;
    let orphans = 0;
    for (const object of objects) {
      for (const member of this.store.listMemoryObjectMembers(object.objectId, object.scope)) {
        members += 1;
        if (this.materializeMember(member.memberType, member.memberId, object.scope) !== undefined) continue;
        orphans += 1;
        const action = this.planAction(context, {
          type: "detach",
          targetType: "object",
          targetId: object.objectId,
          reason: `orphan:${member.memberType}:${member.memberId}`,
          reversible: true,
          before: { objects: [object], members: [member] },
          after: { members: [{ ...member, status: "removed", updatedAt: this.isoNow() }] },
        });
        if (!context.job.dryRun && action.status !== "applied") {
          this.store.putMemoryObjectMember({
            ...member,
            status: "removed",
            updatedAt: this.isoNow(),
            originActionId: action.actionId,
          });
          this.applyAction(context, action);
        }
      }
    }
    const backlog = this.store.listMaintenanceJobs(context.job.scope)
      .filter((job) => job.status === "pending" || job.status === "running").length;
    const metric: MemoryQualityMetrics = {
      ownerType: "global",
      ownerId: stableEvolutionId("quality", scopeIdentity(context.job.scope)),
      scope: context.job.scope,
      candidateCount: objects.length,
      precisionProxy: objects.length === 0 ? 1 : 1 - Math.min(1, orphans / Math.max(1, members)),
      recallProxy: 1 - Math.min(1, orphans / Math.max(1, members)),
      averageExpansionDepth: objects.length === 0
        ? 0
        : objects.reduce((sum, object) => sum + (object.status === "router" ? 2 : 1), 0) / objects.length,
      evidenceCoverage: objects.length === 0
        ? 1
        : objects.filter((object) => object.evidenceRefs.length > 0).length / objects.length,
      contradictionRate: this.store.listContradictions(context.job.scope).length / Math.max(1, objects.length),
      staleSummaryRate: objects.filter((object) =>
        Date.parse(this.isoNow()) - Date.parse(object.updatedAt) >
          this.config.staleSummaryAfterDays * 86_400_000).length / Math.max(1, objects.length),
      orphanRate: orphans / Math.max(1, members),
      maintenanceBacklog: backlog,
      measuredAt: this.isoNow(),
    };
    context.metrics.push(metric);
    if (!context.job.dryRun) this.store.putMemoryQualityMetrics(metric);
  }

  private measureQuality(context: ProcessContext): void {
    const objects = this.store.listMemoryObjects(context.job.scope, {
      statuses: ["active", "router", "merged", "archived"],
      limit: 5_000,
    });
    const retrievalTraces = this.store.listRetrievalTracesForScope(
      context.job.scope,
      Math.max(100, this.config.curatorBatchSize * 20),
    );
    const backlog = this.store.listMaintenanceJobs(context.job.scope)
      .filter((job) => job.status === "pending" || job.status === "running").length;
    for (const object of objects.slice(0, this.config.curatorBatchSize * 2)) {
      const members = this.store.listMemoryObjectMembers(object.objectId, object.scope)
        .filter((member) => member.status === "active");
      const materialized = members.map((member) =>
        this.materializeMember(member.memberType, member.memberId, object.scope));
      const valid = materialized.filter((member): member is MaterializedMember => member !== undefined);
      const pairScores: number[] = [];
      for (let left = 0; left < valid.length; left += 1) {
        for (let right = left + 1; right < valid.length; right += 1) {
          pairScores.push(memorySimilarity(
            (valid[left] as MaterializedMember).fingerprint,
            (valid[right] as MaterializedMember).fingerprint,
          ));
        }
      }
      const precision = pairScores.length === 0
        ? 1
        : pairScores.reduce((sum, score) => sum + score, 0) / pairScores.length;
      const subtopicSupport = new Map<string, number>();
      for (const member of valid) {
        const entity =
          member.fingerprint.explicitEntities[0] ??
          member.fingerprint.entities[0] ??
          "_";
        const topic = member.fingerprint.topics[0] ?? "_";
        const signature = `${entity}\u001f${topic}`;
        subtopicSupport.set(signature, (subtopicSupport.get(signature) ?? 0) + 1);
      }
      const subtopicClusterCount = [...subtopicSupport.values()]
        .filter((support) => support >= 2).length;
      const evidenceFingerprint = fingerprintMemory(
        valid.map((member) => `${member.title}\n${member.content}`).join("\n").slice(0, 48_000),
        object.entityKeys,
      );
      const summaryFidelity = valid.length === 0
        ? 0
        : memorySimilarity(
            fingerprintMemory(`${object.title}\n${object.summary}`, object.entityKeys),
            evidenceFingerprint,
          );
      const relevantTraces = retrievalTraces.filter((trace) =>
        trace.routedObjectIds.includes(object.objectId));
      const queryHitDispersion = relevantTraces.length === 0
        ? 0
        : relevantTraces.reduce((sum, trace) =>
            sum + Math.min(
              1,
              Math.max(0, trace.routedObjectIds.length - 1) /
                Math.max(1, this.config.maxRoutedObjects - 1),
            ), 0) / relevantTraces.length;
      const localUseRatio = relevantTraces.length === 0
        ? 1
        : relevantTraces.filter((trace) =>
            (trace.returnedObjectIds ?? []).includes(object.objectId)).length /
              relevantTraces.length;
      const contradictions = this.store.listContradictions(object.scope, {
        claimIds: valid
          .filter((member) => member.memberType === "semantic")
          .map((member) => parseSemanticMemberId(member.memberId).claimId),
      });
      const metric: MemoryQualityMetrics = {
        ownerType: "object",
        ownerId: object.objectId,
        scope: object.scope,
        candidateCount: members.length,
        retrievalSamples: relevantTraces.length,
        subtopicClusterCount,
        queryHitDispersion: Number(queryHitDispersion.toFixed(6)),
        summaryFidelity: Number(summaryFidelity.toFixed(6)),
        localUseRatio: Number(localUseRatio.toFixed(6)),
        precisionProxy: Number(precision.toFixed(6)),
        recallProxy: Number((valid.length / Math.max(1, members.length)).toFixed(6)),
        averageExpansionDepth: object.status === "router" ? 2 : 1,
        evidenceCoverage: Number((
          valid.filter((member) => member.evidenceRefs.length > 0).length / Math.max(1, valid.length)
        ).toFixed(6)),
        contradictionRate: Number((contradictions.length / Math.max(1, valid.length)).toFixed(6)),
        staleSummaryRate:
          Date.parse(this.isoNow()) - Date.parse(object.updatedAt) >
            this.config.staleSummaryAfterDays * 86_400_000 ? 1 : 0,
        orphanRate: Number(((members.length - valid.length) / Math.max(1, members.length)).toFixed(6)),
        maintenanceBacklog: backlog,
        measuredAt: this.isoNow(),
      };
      context.metrics.push(metric);
      if (!context.job.dryRun) this.store.putMemoryQualityMetrics(metric);
    }
  }

  private reindex(context: ProcessContext): void {
    const action = this.planAction(context, {
      type: "reindex",
      targetType: "index",
      targetId: "all",
      reason: "index_version_upgrade",
      reversible: false,
      before: { indexRevision: this.store.getIndexRevision(), generation: this.store.getMemoryGeneration() },
    });
    if (context.job.dryRun || action.status === "applied") return;
    const result = this.store.reindex();
    this.applyAction(context, {
      ...action,
      after: { indexRevision: result.indexRevision, indexed: result.indexed },
    });
  }

  private refreshPartitionCounts(scope: ScopeRef): void {
    for (const partition of this.store.listMemoryPartitions(scope, { includeArchived: true })) {
      const childCount = this.store.listMemoryPartitions(scope, {
        includeArchived: true,
        parentPartitionId: partition.partitionId,
        limit: 5_000,
      }).length;
      const objectCount = this.store.listMemoryObjects(scope, {
        partitionIds: [partition.partitionId],
        limit: 5_000,
      }).length;
      if (childCount === partition.childCount && objectCount === partition.objectCount) continue;
      this.store.putMemoryPartition({
        ...partition,
        childCount,
        objectCount,
        version: partition.version + 1,
        updatedAt: this.isoNow(),
      });
    }
  }

  private materializeObjectMembers(object: MemoryObject, includeChildren: boolean): MaterializedMember[] {
    return this.store.listMemoryObjectMembers(object.objectId, object.scope)
      .filter((member) => includeChildren || member.memberType !== "object")
      .flatMap((member) => {
        const materialized = this.materializeMember(member.memberType, member.memberId, object.scope);
        return materialized === undefined ? [] : [materialized];
      });
  }

  private materializeMember(
    memberType: MemoryObjectMember["memberType"],
    memberId: string,
    scope: ScopeRef,
  ): MaterializedMember | undefined {
    if (memberType === "episode") {
      const episode = this.store.getEpisode(memberId, scope);
      if (episode === undefined) return undefined;
      const events = episode.eventRefs.flatMap((ref) => {
        const event = this.store.getSourceEvent(ref.eventId, scope);
        return event === undefined ? [] : [event];
      });
      const content = [
        episode.title,
        episode.summary ?? "",
        ...events.map((event) => event.content),
      ].join("\n").slice(0, 24_000);
      return {
        memberType,
        memberId,
        title: episode.title,
        content,
        evidenceCount: episode.eventRefs.length,
        occurredAt: episode.endedAt,
        fingerprint: fingerprintMemory(content, episodeEntityKeys(episode)),
        scope: episode.scope,
        evidenceRefs: episode.eventRefs,
        confidence: 0.9,
        explicitRemember: events.some((event) => event.metadata.explicitRemember === true),
      };
    }
    if (memberType === "semantic") {
      const parsed = parseSemanticMemberId(memberId);
      const claim = this.store.getWorldClaim(parsed.claimId, parsed.version, scope);
      if (claim === undefined) return undefined;
      const content = `${claim.subject} ${claim.predicate} ${String(claim.value)}`;
      const occurredAt = claim.lastConfirmedAt ?? claim.sources.map((ref) => ref.capturedAt).sort().at(-1);
      return {
        memberType,
        memberId: semanticMemberId(claim),
        title: `${claim.subject} · ${claim.predicate}`,
        content,
        evidenceCount: claim.sources.length,
        ...(occurredAt === undefined ? {} : { occurredAt }),
        fingerprint: fingerprintMemory(content, [claim.subject]),
        scope: claim.scope,
        evidenceRefs: claim.sources,
        confidence: claim.confidence,
        explicitRemember: claim.authority === "user_explicit",
      };
    }
    if (memberType === "object") {
      const object = this.store.getMemoryObject(memberId, scope);
      return object === undefined ? undefined : this.materializeObject(object);
    }
    const event = this.store.getSourceEvent(memberId, scope);
    if (event === undefined) return undefined;
    return {
      memberType,
      memberId,
      title: event.kind,
      content: event.content,
      evidenceCount: 1,
      occurredAt: event.occurredAt,
      fingerprint: fingerprintMemory(event.content),
      scope: event.scope,
      evidenceRefs: [this.store.toSourceRef(event)],
      confidence: event.kind === "user_message" ? 1 : 0.8,
      explicitRemember: event.metadata.explicitRemember === true,
    };
  }

  private materializeObject(object: MemoryObject): MaterializedMember {
    const content = `${object.title}\n${object.summary}`;
    return {
      memberType: "object",
      memberId: object.objectId,
      title: object.title,
      content,
      evidenceCount: object.evidenceRefs.length,
      occurredAt: object.updatedAt,
      fingerprint: fingerprintMemory(content, object.entityKeys),
      scope: object.scope,
      evidenceRefs: object.evidenceRefs,
      confidence: object.confidence,
      explicitRemember: object.temperature === "hot",
    };
  }

  private initialTemperature(object: MemoryObject, explicitRemember: boolean): MemoryTemperature {
    return {
      memoryType: "object",
      memoryId: object.objectId,
      scope: object.scope,
      tier: object.temperature,
      score: explicitRemember ? 0.8 : 0.5,
      accessCount: 0,
      retrievalCount: 0,
      mentionCount: 0,
      explicitRemember,
      activeProject: false,
      pinned: false,
      updatedAt: object.createdAt,
    };
  }

  private partOfRelation(
    child: MemoryObject,
    parent: MemoryObject,
    now: string,
  ): MemoryRelation {
    return {
      relationId: stableEvolutionId("relation", child.objectId, "part_of", parent.objectId),
      scope: child.scope,
      from: { type: "object", id: child.objectId },
      to: { type: "object", id: parent.objectId },
      relation: "part_of",
      confidence: 1,
      status: "active",
      evidenceRefs: uniqueRefs([...child.evidenceRefs, ...parent.evidenceRefs]),
      version: 1,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      provenance: {
        actor: "curator",
        operation: parent.status === "router" ? "split" : "merge",
        algorithmVersion: this.algorithmVersion,
        createdAt: now,
      },
    };
  }

  private recordVersion(
    object: MemoryObject,
    operation: MemoryVersion["operation"],
    actionId: string,
    before?: MemoryObject,
  ): void {
    const version: MemoryVersion = {
      versionId: stableEvolutionId("version", "object", object.objectId, String(object.version)),
      memoryType: "object",
      memoryId: object.objectId,
      version: object.version,
      operation,
      ...(before === undefined ? {} : { before }),
      after: object,
      evidenceRefs: object.evidenceRefs,
      maintenanceActionId: actionId,
      createdAt: this.isoNow(),
      provenance: {
        actor: "curator",
        operation,
        algorithmVersion: this.algorithmVersion,
        maintenanceActionId: actionId,
        createdAt: this.isoNow(),
      },
    };
    this.store.putMemoryVersion(version);
  }

  private planAction(context: ProcessContext, spec: ActionSpec): MaintenanceAction {
    const sequence = context.sequence;
    context.sequence += 1;
    const actionId = stableEvolutionId(
      "action",
      context.job.jobId,
      String(sequence),
      spec.type,
      spec.targetType,
      spec.targetId,
    );
    const existing = this.store.getMaintenanceAction(actionId);
    if (existing !== undefined) {
      context.actions.push(existing);
      return existing;
    }
    const action: MaintenanceAction = {
      actionId,
      jobId: context.job.jobId,
      sequence,
      type: spec.type,
      targetType: spec.targetType,
      targetId: spec.targetId,
      status: "planned",
      reason: spec.reason,
      algorithmVersion: this.algorithmVersion,
      reversible: spec.reversible,
      ...(spec.before === undefined ? {} : { before: spec.before }),
      ...(spec.after === undefined ? {} : { after: spec.after }),
      ...(spec.reversible ? { rollbackToken: stableEvolutionId("rollback", actionId) } : {}),
      createdAt: this.isoNow(),
    };
    const written = this.store.putMaintenanceAction(action);
    context.actions.push(written);
    return written;
  }

  private applyAction(context: ProcessContext, action: MaintenanceAction): MaintenanceAction {
    const applied: MaintenanceAction = {
      ...action,
      status: "applied",
      appliedAt: this.isoNow(),
    };
    const written = this.store.updateMaintenanceAction(applied);
    const index = context.actions.findIndex((candidate) => candidate.actionId === action.actionId);
    if (index >= 0) context.actions[index] = written;
    this.store.putMaintenanceAudit({
      auditId: randomUUID(),
      revision: 0,
      scope: context.job.scope,
      jobId: context.job.jobId,
      actionId: action.actionId,
      event: "action_applied",
      details: { type: action.type, targetType: action.targetType, targetId: action.targetId },
      createdAt: this.isoNow(),
    });
    return written;
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

export function contradictionForClaims(
  oldClaim: WorldClaim,
  newClaim: WorldClaim,
  reason?: string,
  now = new Date().toISOString(),
): Contradiction {
  return {
    contradictionId: stableEvolutionId(
      "contradiction",
      oldClaim.claimId,
      String(oldClaim.version),
      newClaim.claimId,
      String(newClaim.version),
    ),
    scope: newClaim.scope,
    oldClaim: {
      claimId: oldClaim.claimId,
      version: oldClaim.version,
      confidence: oldClaim.confidence,
    },
    newClaim: {
      claimId: newClaim.claimId,
      version: newClaim.version,
      confidence: newClaim.confidence,
    },
    evidenceRefs: uniqueRefs([...oldClaim.sources, ...newClaim.sources]),
    status: "unresolved",
    ...(reason === undefined ? {} : { resolutionReason: reason }),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}
