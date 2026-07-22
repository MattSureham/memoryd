import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  type AgentProfile,
  type ScopeRef,
  type TurnPlan,
} from "../src/contracts.js";
import {
  MemoryStore,
  SCHEMA_VERSION,
  type CalibrationPatternRecord,
  type TriggerRecord,
} from "../src/storage/index.js";

const key = Buffer.alloc(32, 17);
const agent: AgentProfile = {
  family: "storage-test",
  version: "1",
  capabilities: { hooks: true, stageGates: true },
};
const scope: ScopeRef & { sessionId: string } = {
  userId: "user-a",
  workspaceId: "workspace-a",
  sessionId: "session-a",
};

const stores: MemoryStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function memoryStore(options: { key?: Buffer; deviceId?: string } = {}): MemoryStore {
  const store = new MemoryStore({
    path: ":memory:",
    encryptionKey: options.key ?? key,
    deviceId: options.deviceId ?? "device-a",
  });
  stores.push(store);
  return store;
}

function plan(turnId: string): TurnPlan {
  return {
    protocolVersion: PROTOCOL_VERSION,
    turnId,
    snapshotRevision: 0,
    agentProfileKey: "storage-test:1",
    risks: [],
    modes: {
      evidenceFirst: "low",
      uncertainty: "low",
      retrieveOriginalSource: "low",
      askClarification: "off",
      narrativeCompletionGate: "off",
    },
    retrievalStages: [{ name: "policy", order: 1, blockedUntilCheckpoint: false }],
    gate: { kind: "none", required: false, satisfied: true },
    activePolicies: [],
    enforcementLevel: "enforced",
    retryCount: 0,
    createdAt: "2026-07-22T00:00:00.000Z",
  };
}

function count(store: MemoryStore, table: string): number {
  const row = store.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

describe("advanced MemoryStore persistence", () => {
  it("upgrades stored v1.0 TurnPlans at the read boundary and rejects unknown versions", () => {
    const store = memoryStore();
    store.createTurn({ ...plan("legacy-turn"), protocolVersion: "1.0" } as unknown as TurnPlan, scope, "legacy-turn");
    store.createTurn({ ...plan("future-turn"), protocolVersion: "2.0" } as unknown as TurnPlan, scope, "future-turn");

    expect(store.getTurn("legacy-turn", scope)?.plan.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(() => store.getTurn("future-turn", scope)).toThrowError(expect.objectContaining({
      shape: expect.objectContaining({ code: "VERSION_CONFLICT" }),
    }));
  });

  it("migrates an existing v3 database through v6 without losing authoritative events", () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-store-v3-"));
    directories.push(directory);
    const databasePath = join(directory, "memory.sqlite");

    const initial = new MemoryStore({ path: databasePath, encryptionKey: key, deviceId: "migration-device" });
    const event = initial.appendSourceEvent({
      input: { eventId: "migration-event", idempotencyKey: "migration-event", kind: "user_message", content: "preserve this event" },
      scope,
      agent,
    });
    initial.close();

    // Recreate the exact migration boundary: v3 has all authoritative tables but
    // none of the session/learning (v4), embedding-bucket (v5), or entity-index
    // (v6) additions.
    const legacy = new Database(databasePath);
    legacy.exec(`
      DROP TABLE embedding_buckets;
      DROP TABLE trigger_activations;
      DROP TABLE learning_jobs;
      DROP TABLE session_lifecycle;
      DROP INDEX entity_edges_owner_idx;
      DROP INDEX entity_edges_scope_from_idx;
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const upgraded = new MemoryStore({ path: databasePath, encryptionKey: key, deviceId: "migration-device" });
    stores.push(upgraded);

    expect(upgraded.health()).toMatchObject({ ok: true, schemaVersion: SCHEMA_VERSION, eventCount: 1 });
    expect(upgraded.getSourceEvent(event.eventId, scope)).toMatchObject({ content: "preserve this event" });
    expect(upgraded.ensureSession(scope)).toMatchObject({ status: "active", scope });
    expect(upgraded.enqueueLearningJob("segment_session", scope, { eventId: event.eventId }, "migration-job"))
      .toMatchObject({ status: "pending", type: "segment_session" });
    expect(count(upgraded, "embedding_buckets")).toBe(0);
    const entityIndexes = upgraded.database.prepare("PRAGMA index_list('entity_edges')").all()
      .map((row) => String((row as { name: string }).name));
    expect(entityIndexes).toEqual(expect.arrayContaining([
      "entity_edges_owner_idx",
      "entity_edges_scope_from_idx",
    ]));
  });

  it("runs source-event FTS before authoritative ACL and snapshot filtering", () => {
    const store = memoryStore();
    const first = store.appendSourceEvent({
      input: { eventId: "fts-first", idempotencyKey: "fts-first", kind: "user_message", content: "bounded quasar record" },
      scope,
      agent,
    });
    store.appendSourceEvent({
      input: { eventId: "fts-foreign", idempotencyKey: "fts-foreign", kind: "user_message", content: "bounded quasar record" },
      scope: { ...scope, workspaceId: "workspace-b", sessionId: "session-b" },
      agent,
    });
    const snapshotRevision = store.getRevision();
    store.appendSourceEvent({
      input: { eventId: "fts-later", idempotencyKey: "fts-later", kind: "user_message", content: "bounded quasar record" },
      scope: { ...scope, sessionId: "session-later" },
      agent,
    });

    const result = store.search("bounded quasar", scope, {
      kinds: ["source_event"],
      maxRevision: snapshotRevision,
    });
    expect(result.hits.map((hit) => hit.id)).toEqual([first.eventId]);

    const queryPlan = store.database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT source_events_fts.event_id AS id, bm25(source_events_fts) AS rank
      FROM source_events_fts
      JOIN source_events e ON e.event_id = source_events_fts.event_id
      WHERE source_events_fts MATCH @query
        AND e.user_id = @userId
        AND ((@workspaceId IS NULL AND e.workspace_id IS NULL)
          OR e.workspace_id IS NULL OR e.workspace_id = @workspaceId)
        AND e.revision <= @snapshotRevision
      ORDER BY rank LIMIT @limit
    `).all({
      query: '"bounded" OR "quasar"',
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      snapshotRevision,
      limit: 20,
    }) as Array<{ detail: string }>;
    const details = queryPlan.map((row) => row.detail).join("\n");
    expect(details).toContain("VIRTUAL TABLE INDEX");
    expect(details).toMatch(/SEARCH e USING (?:COVERING )?INDEX/u);
    expect(details).not.toContain("MATERIALIZE");
    expect(details).not.toMatch(/\bSCAN e\b/u);
  });

  it("applies owner ACL and begin-turn snapshot bounds after embedding-bucket candidate lookup", () => {
    const store = memoryStore();
    const vector = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2];
    const first = store.appendSourceEvent({
      input: { eventId: "embedding-first", idempotencyKey: "embedding-first", kind: "user_message", content: "first semantic item" },
      scope,
      agent,
    });
    store.putEmbedding("source_event", first.eventId, scope, "local", "test-model", vector);
    const snapshotRevision = store.getRevision();

    const later = store.appendSourceEvent({
      input: { eventId: "embedding-later", idempotencyKey: "embedding-later", kind: "user_message", content: "later semantic item" },
      scope: { ...scope, sessionId: "session-later" },
      agent,
    });
    store.putEmbedding("source_event", later.eventId, later.scope, "local", "test-model", vector);
    const foreign = store.appendSourceEvent({
      input: { eventId: "embedding-foreign", idempotencyKey: "embedding-foreign", kind: "user_message", content: "foreign semantic item" },
      scope: { ...scope, workspaceId: "workspace-b", sessionId: "session-foreign" },
      agent,
    });
    store.putEmbedding("source_event", foreign.eventId, foreign.scope, "local", "test-model", vector);

    const frozen = store.listEmbeddings(scope, "local", "test-model", {
      kinds: ["source_event"],
      maxRevision: snapshotRevision,
      queryVector: vector,
    });
    expect(frozen.map((entry) => entry.ownerId)).toEqual([first.eventId]);

    const current = store.listEmbeddings(scope, "local", "test-model", {
      kinds: ["source_event"],
      queryVector: vector,
    });
    expect(current.map((entry) => entry.ownerId).sort()).toEqual([first.eventId, later.eventId].sort());
    expect(store.getEmbedding("source_event", foreign.eventId, scope, "local", "test-model")).toBeUndefined();
    expect(count(store, "embedding_buckets")).toBeGreaterThan(0);
  });

  it("requires exact provenance for Trigger and Calibration source links", () => {
    const store = memoryStore();
    const event = store.appendSourceEvent({
      input: { eventId: "provenance-source", idempotencyKey: "provenance-source", kind: "user_message", content: "verify every source" },
      scope,
      agent,
    });
    const tampered = { ...store.toSourceRef(event), contentHash: "tampered" };
    const trigger: TriggerRecord = {
      triggerId: "tampered-trigger",
      scope,
      riskCode: "unsupported_inference",
      condition: { taskType: "analysis" },
      priority: 1,
      activationCount: 0,
      sourceRefs: [tampered],
    };
    const calibration: CalibrationPatternRecord = {
      patternId: "tampered-calibration",
      agentProfileKey: "storage-test:1:model:tools",
      status: "shadow",
      riskCode: "unsupported_inference",
      pattern: { taskType: "analysis" },
      sourceRefs: [tampered],
    };

    expect(() => store.putTrigger(trigger)).toThrow(ProtocolError);
    expect(() => store.putCalibrationPattern(calibration)).toThrow(ProtocolError);
    expect(store.getTrigger(trigger.triggerId)).toBeUndefined();
    expect(store.getCalibrationPattern(calibration.patternId)).toBeUndefined();
  });

  it("filters inspected learning jobs and Calibration provenance by scope", () => {
    const store = memoryStore();
    const foreignScope = { ...scope, workspaceId: "workspace-b", sessionId: "session-b" };
    const localEvent = store.appendSourceEvent({
      input: { eventId: "inspect-local", idempotencyKey: "inspect-local", kind: "user_message", content: "local calibration" },
      scope,
      agent,
    });
    const foreignEvent = store.appendSourceEvent({
      input: { eventId: "inspect-foreign", idempotencyKey: "inspect-foreign", kind: "user_message", content: "foreign calibration" },
      scope: foreignScope,
      agent,
    });
    store.putCalibrationPattern({
      patternId: "calibration-local",
      agentProfileKey: "storage-test:1:model:tools",
      status: "shadow",
      riskCode: "unsupported_inference",
      pattern: { taskType: "analysis" },
      sourceRefs: [store.toSourceRef(localEvent)],
    });
    store.putCalibrationPattern({
      patternId: "calibration-foreign",
      agentProfileKey: "storage-test:1:model:tools",
      status: "shadow",
      riskCode: "unsupported_inference",
      pattern: { taskType: "analysis" },
      sourceRefs: [store.toSourceRef(foreignEvent)],
    });
    store.putCalibrationPattern({
      patternId: "calibration-mixed",
      agentProfileKey: "storage-test:1:model:tools",
      status: "shadow",
      riskCode: "unsupported_inference",
      pattern: { taskType: "analysis" },
      sourceRefs: [store.toSourceRef(localEvent), store.toSourceRef(foreignEvent)],
    });
    store.enqueueLearningJob("segment_session", scope, {}, "inspect-local-job");
    store.enqueueLearningJob("segment_session", foreignScope, {}, "inspect-foreign-job");

    expect(store.listCalibrationPatternsForScope(scope, true).map((pattern) => pattern.patternId))
      .toEqual(["calibration-local"]);
    expect(store.listLearningJobs(undefined, scope).map((job) => job.idempotencyKey))
      .toEqual(["inspect-local-job"]);
    expect(store.listLearningJobs().map((job) => job.idempotencyKey))
      .toEqual(["inspect-local-job", "inspect-foreign-job"]);
  });

  it("forgets source-linked learned artifacts, activations, jobs, and every derived index", () => {
    const store = memoryStore();
    store.ensureSession(scope);
    const event = store.appendSourceEvent({
      input: { eventId: "forget-learned-source", idempotencyKey: "forget-learned-source", kind: "user_message", content: "learned source to forget" },
      scope,
      agent,
    });
    const sourceRef = store.toSourceRef(event);
    store.createTurn(plan("forget-learned-turn"), scope, "forget-learned-turn");
    store.putTrigger({
      triggerId: "forget-trigger",
      scope,
      riskCode: "unsupported_inference",
      condition: { taskType: "analysis" },
      priority: 0.8,
      activationCount: 1,
      sourceRefs: [sourceRef],
    });
    store.putCalibrationPattern({
      patternId: "forget-calibration",
      agentProfileKey: "storage-test:1:model:tools",
      status: "active",
      riskCode: "unsupported_inference",
      pattern: { taskType: "analysis" },
      sourceRefs: [sourceRef],
    });
    store.putTriggerActivation({
      triggerId: "forget-trigger",
      turnId: "forget-learned-turn",
      scope,
      structuralScore: 0.9,
      similarityScore: 0.4,
      effectiveScore: 0.9,
      activatedAt: "2026-07-22T00:00:00.000Z",
    });
    store.enqueueLearningJob("analyze_cluster", scope, { sourceEventId: event.eventId }, "forget-learning-job");
    store.putEmbedding("source_event", event.eventId, scope, "local", "test-model", [1, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05, 0.01]);
    store.replaceEntityIndex("source_event", event.eventId, scope, ["ForgottenEntity"]);

    const result = store.forget({
      ...scope,
      entityType: "source_event",
      entityId: event.eventId,
      reason: "remove learned provenance",
    });

    expect(result.deleted).toMatchObject({ source_event: 1, trigger: 1, calibration_pattern: 1 });
    expect(store.getTrigger("forget-trigger")).toBeUndefined();
    expect(store.getCalibrationPattern("forget-calibration")).toBeUndefined();
    expect(store.listTriggerActivations("forget-trigger")).toEqual([]);
    expect(store.listLearningJobs()).toEqual([]);
    expect(store.getEmbedding("source_event", event.eventId, scope, "local", "test-model")).toBeUndefined();
    expect(count(store, "embedding_buckets")).toBe(0);
    expect(count(store, "entity_edges")).toBe(0);
    expect(count(store, "source_links")).toBe(0);
    const tombstoneTypes = (store.database.prepare("SELECT entity_type FROM tombstones").all() as Array<{ entity_type: string }>)
      .map((row) => row.entity_type);
    expect(tombstoneTypes).toEqual(expect.arrayContaining(["source_event", "trigger", "calibration_pattern"]));
  });

  it("removes a forgotten Correction's cluster-derived lesson, artifacts, completed jobs, and relation graph", () => {
    const store = memoryStore();
    store.ensureSession(scope);
    const event = store.appendSourceEvent({
      input: { eventId: "correction-source", idempotencyKey: "correction-source", kind: "user_message", content: "Always verify the active workspace" },
      scope,
      agent,
    });
    const ref = store.toSourceRef(event);
    store.createTurn(plan("correction-turn"), scope, "correction-turn");
    const correction = store.putCorrection({
      turnId: "correction-turn",
      kind: "behavior",
      wrongStatement: "Assume the workspace from history",
      correction: "Always verify the active workspace",
      explicit: false,
      idempotencyKey: "correction-record",
    }, ref, "correction-record");
    store.putFailureCluster({
      clusterId: "forgotten-cluster",
      scope,
      status: "reviewed",
      correctionIds: [correction.correctionId],
      sessionIds: [scope.sessionId],
      signature: {
        normalizedLesson: "always verify the active workspace",
        selfReflectionIds: [],
      },
    });
    store.putTrigger({
      triggerId: "cluster-trigger",
      scope,
      riskCode: "wrong_workspace",
      condition: { taskType: "code" },
      priority: 0.8,
      activationCount: 1,
      learnedFromClusterId: "forgotten-cluster",
    });
    store.putCalibrationPattern({
      patternId: "cluster-calibration",
      agentProfileKey: "storage-test:1:model:tools",
      status: "shadow",
      riskCode: "wrong_workspace",
      pattern: {
        clusterKey: "forgotten-cluster",
        correctionIds: [correction.correctionId],
      },
    });
    store.putTriggerActivation({
      triggerId: "cluster-trigger",
      turnId: "correction-turn",
      scope,
      structuralScore: 0.9,
      similarityScore: 0.1,
      effectiveScore: 0.9,
      activatedAt: "2026-07-22T00:00:00.000Z",
    });
    const job = store.enqueueLearningJob(
      "analyze_cluster",
      scope,
      { clusterId: "forgotten-cluster" },
      `analyze:forgotten-cluster:${correction.correctionId}`,
    );
    store.claimLearningJobs(1, job.availableAt);
    store.completeLearningJob(job.jobId);
    store.linkEntityRelation(scope, "WorkspaceAlpha", "WorkspaceBeta", "historical_alias");
    expect(count(store, "entity_edges")).toBe(1);

    const result = store.forget({
      ...scope,
      entityType: "correction",
      entityId: correction.correctionId,
      reason: "forget this correction",
    });

    expect(result.deleted).toMatchObject({
      correction: 1,
      source_event: 1,
      failure_cluster: 1,
      trigger: 1,
      calibration_pattern: 1,
      learning_job: 1,
      entity_relation: 1,
    });
    expect(store.listFailureClusters(scope)).toEqual([]);
    expect(store.getTrigger("cluster-trigger")).toBeUndefined();
    expect(store.getCalibrationPattern("cluster-calibration")).toBeUndefined();
    expect(store.listTriggerActivations("cluster-trigger")).toEqual([]);
    expect(store.listLearningJobs()).toEqual([]);
    expect(count(store, "entity_edges")).toBe(0);
    expect(JSON.stringify(store.exportData({ encryptionKey: "forget-audit-key" })))
      .not.toContain("always verify the active workspace");
  });

  it("forgets session lifecycle state and prevents the forgotten session from being reused or exported", () => {
    const store = memoryStore();
    store.ensureSession(scope, "2026-07-22T00:00:00.000Z");
    store.appendSourceEvent({
      input: { eventId: "forgotten-session-event", idempotencyKey: "forgotten-session-event", kind: "user_message", content: "erase the whole session" },
      scope,
      agent,
    });
    store.endSession(scope, "forgotten-session-end", "2026-07-22T00:01:00.000Z");

    const result = store.forget({ ...scope, reason: "erase session" });

    expect(result.deleted).toMatchObject({ source_event: 1, session: 1 });
    expect(store.getSession(scope.sessionId, scope)).toBeUndefined();
    expect(count(store, "session_lifecycle")).toBe(0);
    expect(() => store.ensureSession(scope)).toThrow(/forgotten/u);
    expect(() => store.appendSourceEvent({
      input: { idempotencyKey: "forgotten-session-late", kind: "user_message", content: "must not return" },
      scope,
      agent,
    })).toThrow(/forgotten/u);
    expect((store.database.prepare("SELECT entity_type, entity_id FROM tombstones WHERE entity_type = 'session'")
      .get() as { entity_type: string; entity_id: string })).toEqual({
      entity_type: "session",
      entity_id: scope.sessionId,
    });
  });

  it("rejects cross-user auxiliary-only imports and unattributed Calibration artifacts", () => {
    const destination = memoryStore();
    destination.appendSourceEvent({
      input: { idempotencyKey: "owner-a", kind: "user_message", content: "owner A memory" },
      scope,
      agent,
    });
    const foreign = memoryStore({ key: Buffer.alloc(32, 21), deviceId: "device-foreign" });
    foreign.putTrigger({
      triggerId: "foreign-trigger",
      scope: { userId: "user-b", workspaceId: "workspace-b" },
      riskCode: "destructive_action",
      condition: { taskType: "coding" },
      priority: 1,
      activationCount: 0,
    });
    const transferKey = "cross-user-transfer-key";
    expect(() => destination.importData(foreign.exportData({ encryptionKey: transferKey }), {
      encryptionKey: transferKey,
    })).toThrow(/user scope differs/u);
    expect(destination.getTrigger("foreign-trigger")).toBeUndefined();

    const unattributed = memoryStore({ key: Buffer.alloc(32, 22), deviceId: "device-unattributed" });
    unattributed.putCalibrationPattern({
      patternId: "unattributed-calibration",
      agentProfileKey: "storage-test:1:model:tools",
      status: "active",
      riskCode: "destructive_action",
      pattern: { legacy: true },
      metrics: { probability: 0.95 },
    });
    expect(() => destination.importData(unattributed.exportData({ encryptionKey: transferKey }), {
      encryptionKey: transferKey,
    })).toThrow(/no authoritative SourceRef/u);
    expect(destination.getCalibrationPattern("unattributed-calibration")).toBeUndefined();
  });

  it("round-trips session and Trigger activation state but never transfers operational learning jobs", () => {
    const source = memoryStore();
    const destination = memoryStore({ key: Buffer.alloc(32, 18), deviceId: "device-b" });
    source.ensureSession(scope, "2026-07-22T00:00:00.000Z");
    const event = source.appendSourceEvent({
      input: { eventId: "portable-source", idempotencyKey: "portable-source", kind: "user_message", content: "portable trigger evidence" },
      scope,
      agent,
    });
    source.createTurn(plan("portable-turn"), scope, "portable-turn");
    source.putTrigger({
      triggerId: "portable-trigger",
      scope,
      riskCode: "unsupported_inference",
      condition: { taskType: "analysis" },
      priority: 0.7,
      activationCount: 1,
      sourceRefs: [source.toSourceRef(event)],
    });
    source.putTriggerActivation({
      triggerId: "portable-trigger",
      turnId: "portable-turn",
      scope,
      structuralScore: 0.8,
      similarityScore: 0.5,
      effectiveScore: 0.8,
      activatedAt: "2026-07-22T00:01:00.000Z",
    });
    source.enqueueLearningJob("evaluate_calibration", scope, { patternId: "ephemeral" }, "ephemeral-job");
    source.endSession(scope, "portable-session-end", "2026-07-22T00:02:00.000Z");

    const transferKey = "storage-advanced-transfer-key";
    const imported = destination.importData(source.exportData({ encryptionKey: transferKey }), {
      encryptionKey: transferKey,
    });

    expect(imported.conflicts).toEqual([]);
    expect(imported.imported).toMatchObject({ source_event: 1, turn: 1, trigger: 1, session: 1, trigger_activation: 1 });
    expect(destination.getSession(scope.sessionId, scope)).toMatchObject({
      status: "ended",
      endedAt: "2026-07-22T00:02:00.000Z",
      endIdempotencyKey: "portable-session-end",
    });
    expect(destination.listTriggerActivations("portable-trigger")).toEqual([
      expect.objectContaining({ turnId: "portable-turn", effectiveScore: 0.8, scope }),
    ]);
    expect(destination.listLearningJobs()).toEqual([]);
  });
});
