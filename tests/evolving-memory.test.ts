import { afterEach, describe, expect, it } from "vitest";
import { ProtocolError } from "../src/contracts.js";
import type {
  AgentProfile,
  EpisodeMemory,
  MemoryObject,
  MemoryPartition,
  ScopeRef,
  WorldClaim,
} from "../src/contracts.js";
import { MemoryCurator } from "../src/curator.js";
import { MemoryRuntime } from "../src/runtime.js";
import { MemoryStore } from "../src/storage/index.js";

const key = Buffer.alloc(32, 41);
const agent: AgentProfile = {
  family: "evolution-test",
  version: "1",
  model: "deterministic",
  capabilities: { hooks: true, stageGates: true },
};
const workspaceScope: ScopeRef = { userId: "evolving-user", workspaceId: "evolving-workspace" };

const stores: MemoryStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup(): MemoryStore {
  const store = new MemoryStore({
    path: ":memory:",
    encryptionKey: key,
    deviceId: `evolution-device-${stores.length}`,
  });
  stores.push(store);
  return store;
}

function addEpisode(
  store: MemoryStore,
  input: {
    id: string;
    entity: string;
    topic: string;
    content: string;
    occurredAt?: string;
  },
): EpisodeMemory {
  const scope: ScopeRef = {
    ...workspaceScope,
    sessionId: `session-${input.id}`,
  };
  const event = store.appendSourceEvent({
    input: {
      eventId: `raw-${input.id}`,
      idempotencyKey: `raw-${input.id}`,
      kind: "user_message",
      content: input.content,
      occurredAt: input.occurredAt ?? `2026-06-${String((stores.length + input.id.length) % 20 + 1).padStart(2, "0")}T00:00:00.000Z`,
    },
    scope,
    agent,
    selectedEvidence: true,
  });
  const episode = {
    episodeId: `episode-${input.id}`,
    scope,
    title: `${input.entity} ${input.topic}`,
    summary: `Locator for ${input.entity} ${input.topic}`,
    eventRefs: [store.toSourceRef(event)],
    participants: [input.entity],
    tags: [input.topic],
    startedAt: event.occurredAt,
    endedAt: event.occurredAt,
    entityKeys: [input.entity],
    status: "active" as const,
    schemaVersion: 1,
    summarizerVersion: "test-locator-v1",
    updatedAt: event.capturedAt,
  };
  store.putEpisode(episode, `episode-${input.id}`);
  return episode;
}

function objectByStatus(store: MemoryStore, status: MemoryObject["status"]): MemoryObject[] {
  return store.listMemoryObjects(workspaceScope, { statuses: [status], limit: 500 });
}

async function beginQuery(runtime: MemoryRuntime, content: string, id: string) {
  const plan = await runtime.beginTurn({
    input: { idempotencyKey: id, kind: "user_message", content },
    scope: { ...workspaceScope, sessionId: `query-${id}` },
    agentProfile: agent,
  });
  if (plan.gate.required) {
    runtime.checkpointEvidence({
      turnId: plan.turnId,
      observations: [{ kind: "user_statement", content: "No current primary artifact is available." }],
    });
  }
  return plan;
}

function barePartition(id: string): MemoryPartition {
  const now = "2026-07-27T00:00:00.000Z";
  return {
    partitionId: id,
    scope: workspaceScope,
    namespace: "test",
    partitionKey: id,
    strategy: "adaptive",
    status: "active",
    depth: 0,
    childCount: 0,
    objectCount: 1,
    capacity: 8,
    routingKeys: ["test"],
    version: 1,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

describe("adaptive memory objects and provenance", () => {
  it("aggregates similar episodes without losing raw evidence and remains idempotent", () => {
    const store = setup();
    const first = addEpisode(store, {
      id: "atlas-a",
      entity: "ProjectAtlas",
      topic: "deployment",
      content: "ProjectAtlas deployment discussion confirmed codename Aurora and the release pipeline.",
    });
    const second = addEpisode(store, {
      id: "atlas-b",
      entity: "ProjectAtlas",
      topic: "deployment-review",
      content: "ProjectAtlas deployment review reconfirmed codename Aurora for the staging pipeline.",
    });
    const curator = new MemoryCurator(store, {
      config: { mergeSimilarity: 0.5, maxObjectMembers: 20 },
    });

    const firstRun = curator.run(workspaceScope, {
      type: "scan",
      idempotencyKey: "aggregate-first",
    });
    expect(firstRun.job.status).toBe("completed");
    const objects = objectByStatus(store, "active");
    expect(objects).toHaveLength(1);
    const object = objects[0] as MemoryObject;
    expect(object.memberCount).toBe(2);
    expect(store.listMemoryObjectMembers(object.objectId, workspaceScope)
      .filter((member) => member.memberType === "episode")).toHaveLength(2);
    expect(new Set(object.evidenceRefs.map((ref) => ref.eventId))).toEqual(new Set([
      first.eventRefs[0]?.eventId,
      second.eventRefs[0]?.eventId,
    ]));
    expect(store.getSourceEvents(object.evidenceRefs, workspaceScope)
      .map((event) => event.content).join("\n")).toContain("codename Aurora");
    expect(store.listMemoryVersions("object", object.objectId).length).toBeGreaterThanOrEqual(2);
    expect((store.database.prepare("SELECT count(*) AS count FROM memory_objects_fts")
      .get() as { count: number }).count).toBe(0);
    expect(store.search("ProjectAtlas Aurora", workspaceScope, {
      kinds: ["memory_object"],
    }).memoryObjects.map((value) => value.objectId)).toContain(object.objectId);

    curator.run(workspaceScope, {
      type: "scan",
      idempotencyKey: "aggregate-repeat",
    });
    expect(objectByStatus(store, "active").map((value) => value.objectId)).toEqual([object.objectId]);
    expect(store.listMemoryObjectMembers(object.objectId, workspaceScope)
      .filter((member) => member.status === "active")).toHaveLength(2);
  });

  it("does not merge semantically similar records that explicitly name different entities", () => {
    const store = setup();
    addEpisode(store, {
      id: "atlas-entity",
      entity: "ProjectAtlas",
      topic: "release",
      content: "ProjectAtlas deployment discussion confirmed codename Aurora and the release pipeline.",
    });
    addEpisode(store, {
      id: "orion-entity",
      entity: "ProjectOrion",
      topic: "release",
      content: "ProjectOrion deployment discussion confirmed codename Aurora and the release pipeline.",
    });
    const curator = new MemoryCurator(store, { config: { mergeSimilarity: 0.5 } });

    curator.run(workspaceScope, { type: "scan", idempotencyKey: "entity-guard" });

    const active = objectByStatus(store, "active");
    expect(active).toHaveLength(2);
    expect(active.map((object) => object.entityKeys).flat()).toEqual(
      expect.arrayContaining(["projectatlas", "projectorion"]),
    );
  });

  it("backfills old unassigned episodes across bounded scans without starving the tail", () => {
    const store = setup();
    const episodes = Array.from({ length: 7 }, (_, index) => addEpisode(store, {
      id: `backfill-${index}`,
      entity: `BackfillProject${index}`,
      topic: "migration",
      content: `BackfillProject${index} retains independently attributable migration evidence.`,
    }));
    const curator = new MemoryCurator(store, {
      config: { curatorBatchSize: 2, mergeSimilarity: 0.9 },
    });

    for (let index = 0; index < 4; index += 1) {
      curator.run(workspaceScope, {
        type: "scan",
        idempotencyKey: `bounded-backfill-${index}`,
      });
    }

    expect(episodes.every((episode) =>
      store.listObjectsForMember("episode", episode.episodeId, workspaceScope).length === 1))
      .toBe(true);
  });

  it("merges as a reversible graph operation while retaining original nodes", () => {
    const store = setup();
    addEpisode(store, {
      id: "merge-atlas",
      entity: "ProjectAtlas",
      topic: "decision",
      content: "ProjectAtlas selected the blue deployment path.",
    });
    addEpisode(store, {
      id: "merge-orion",
      entity: "ProjectOrion",
      topic: "decision",
      content: "ProjectOrion selected the green deployment path.",
    });
    const curator = new MemoryCurator(store, { config: { mergeSimilarity: 0.8 } });
    curator.run(workspaceScope, { type: "scan", idempotencyKey: "merge-prepare" });
    const originals = objectByStatus(store, "active");
    expect(originals).toHaveLength(2);

    const mergedRun = curator.run(workspaceScope, {
      type: "merge",
      payload: { objectIds: originals.map((object) => object.objectId), force: true },
      idempotencyKey: "forced-merge",
    });
    const mergeAction = mergedRun.actions.find((action) => action.type === "merge");
    expect(mergeAction?.status).toBe("applied");
    const merged = objectByStatus(store, "active")[0] as MemoryObject;
    expect(merged.childCount).toBe(2);
    expect(originals.map((object) => store.getMemoryObject(object.objectId, workspaceScope)?.status))
      .toEqual(["merged", "merged"]);
    expect(store.listMemoryRelations(workspaceScope, {
      nodeType: "object",
      nodeId: merged.objectId,
      relation: "part_of",
    })).toHaveLength(2);
    expect(merged.evidenceRefs).toHaveLength(2);

    const rolledBack = curator.rollback(mergeAction!.actionId, "rollback-forced-merge");
    expect(rolledBack.status).toBe("rolled_back");
    expect(originals.map((object) => store.getMemoryObject(object.objectId, workspaceScope)?.status))
      .toEqual(["active", "active"]);
    expect(store.getMemoryObject(merged.objectId, workspaceScope)?.status).toBe("deprecated");
    expect(store.listMemoryRelations(workspaceScope, {
      nodeId: merged.objectId,
      includeInactive: true,
    }).every((relation) => relation.status === "revoked")).toBe(true);
    expect(store.listMaintenanceAudit(workspaceScope)
      .some((record) => record.event === "action_rollback")).toBe(true);
  });
});

describe("bounded split, routing, and lifecycle", () => {
  it("triggers bounded splitting during incremental ingest without a full scan", () => {
    const store = setup();
    const episodes = Array.from({ length: 4 }, (_, index) => addEpisode(store, {
      id: `incremental-${index}`,
      entity: "ProjectIncremental",
      topic: `topic-${index}`,
      content: `ProjectIncremental topic ${index} retains a distinct local evidence segment.`,
    }));
    const curator = new MemoryCurator(store, {
      config: {
        mergeSimilarity: 0.35,
        maxObjectMembers: 3,
        splitMinMembers: 4,
        targetObjectMembers: 2,
      },
    });

    for (const episode of episodes) {
      curator.run(workspaceScope, {
        type: "ingest",
        payload: { memberType: "episode", memberId: episode.episodeId },
        idempotencyKey: `incremental-ingest:${episode.episodeId}`,
      });
    }

    const router = objectByStatus(store, "router")[0];
    expect(router).toBeDefined();
    expect(store.listMemoryObjectMembers(router!.objectId, workspaceScope)
      .filter((member) => member.memberType === "object")).toHaveLength(2);
  });

  it("suggests an over-limit split in dry-run, applies it, and retrieves the correct child", async () => {
    const store = setup();
    const topics = [
      ["deployment", "ProjectAtlas deployment used the Aurora release pipeline."],
      ["debugging", "ProjectAtlas debugging isolated a cache invalidation failure."],
      ["database", "ProjectAtlas database migration introduced schema version seven."],
      ["security", "ProjectAtlas security review rotated local encryption keys."],
      ["testing", "ProjectAtlas testing added an evidence coverage regression suite."],
      ["observability", "ProjectAtlas observability tracks retrieval depth and latency."],
    ] as const;
    topics.forEach(([topic, content], index) => addEpisode(store, {
      id: `split-${index}`,
      entity: "ProjectAtlas",
      topic,
      content,
    }));
    const ingest = new MemoryCurator(store, {
      config: { mergeSimilarity: 0.4, maxObjectMembers: 50, splitMinMembers: 20 },
    });
    ingest.run(workspaceScope, { type: "scan", idempotencyKey: "split-ingest" });
    const parent = objectByStatus(store, "active")[0] as MemoryObject;
    expect(parent.memberCount).toBe(6);

    const bounded = new MemoryCurator(store, {
      config: {
        mergeSimilarity: 0.4,
        maxObjectMembers: 3,
        splitMinMembers: 4,
        targetObjectMembers: 2,
      },
    });
    const suggestion = bounded.run(workspaceScope, {
      type: "scan",
      dryRun: true,
      idempotencyKey: "split-dry-run",
    });
    expect(suggestion.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "split", status: "planned", targetId: parent.objectId }),
    ]));
    expect(store.getMemoryObject(parent.objectId, workspaceScope)?.status).toBe("active");

    const applied = bounded.run(workspaceScope, {
      type: "split",
      payload: { objectId: parent.objectId, reason: "max_object_members" },
      idempotencyKey: "split-apply",
    });
    expect(applied.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "split", status: "applied" }),
    ]));
    const router = store.getMemoryObject(parent.objectId, workspaceScope) as MemoryObject;
    expect(router.status).toBe("router");
    const childIds = store.listMemoryObjectMembers(router.objectId, workspaceScope)
      .filter((member) => member.memberType === "object")
      .map((member) => member.memberId);
    expect(childIds.length).toBeGreaterThan(1);
    expect(childIds.every((id) => (store.getMemoryObject(id, workspaceScope)?.memberCount ?? 99) <= 2))
      .toBe(true);

    const runtime = new MemoryRuntime(store, {
      evolutionConfig: { maxRoutedObjects: 8, maxCandidateCount: 40 },
    });
    const analysisTurn = await beginQuery(
      runtime,
      "分析 ProjectAtlas debugging cache invalidation",
      "split-analysis",
    );
    const result = runtime.retrieveMemory({
      turnId: analysisTurn.turnId,
      query: "分析 ProjectAtlas debugging cache invalidation",
      limit: 20,
    });
    expect(result.trace.routedObjectIds).toEqual(expect.arrayContaining(childIds));
    expect(result.memories.some((memory) =>
      childIds.includes(memory.memoryId) && memory.content.includes("cache invalidation"))).toBe(true);
    expect(result.memories.some((memory) => memory.memoryType === "raw")).toBe(false);
    expect(result.riskProfile.inferenceAllowed).toBe(true);
  });

  it("regenerates stale summaries from members instead of treating summaries as evidence", () => {
    const store = setup();
    addEpisode(store, {
      id: "summary",
      entity: "ProjectAtlas",
      topic: "summary",
      content: "ProjectAtlas authoritative evidence says the current codename is Aurora.",
    });
    const curator = new MemoryCurator(store, { config: { mergeSimilarity: 0.5 } });
    curator.run(workspaceScope, { type: "scan", idempotencyKey: "summary-ingest" });
    const object = objectByStatus(store, "active")[0] as MemoryObject;
    store.putMemoryObject({
      ...object,
      summary: "obsolete and lossy summary",
      summarizerVersion: "obsolete-v0",
      version: object.version + 1,
      updatedAt: "2020-01-01T00:00:00.000Z",
    });

    const refreshed = curator.run(workspaceScope, {
      type: "refresh_summary",
      payload: { objectId: object.objectId },
      idempotencyKey: "summary-refresh",
    });
    const current = store.getMemoryObject(object.objectId, workspaceScope) as MemoryObject;
    expect(refreshed.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "summary", status: "applied" }),
    ]));
    expect(current.summary).toContain("authoritative evidence");
    expect(current.summary).not.toContain("obsolete and lossy");
    expect(current.summarizerVersion).toBe("deterministic-locator-v1");
    expect(current.evidenceRefs).toEqual(object.evidenceRefs);
  });

  it("renames and re-routes an object through an audited, reversible maintenance action", () => {
    const store = setup();
    addEpisode(store, {
      id: "rename",
      entity: "ProjectAtlas",
      topic: "rename",
      content: "ProjectAtlas is the historical name of the Horizon migration project.",
    });
    const curator = new MemoryCurator(store, { config: { mergeSimilarity: 0.5 } });
    curator.run(workspaceScope, { type: "scan", idempotencyKey: "rename-ingest" });
    const original = objectByStatus(store, "active")[0] as MemoryObject;

    const renamed = curator.run(workspaceScope, {
      type: "rename",
      payload: {
        objectId: original.objectId,
        title: "ProjectHorizon",
        routingKeys: ["horizon-migration"],
      },
      idempotencyKey: "rename-apply",
    });
    const action = renamed.actions.find((candidate) => candidate.type === "rename");
    expect(action?.status).toBe("applied");
    expect(store.getMemoryObject(original.objectId, workspaceScope)).toMatchObject({
      title: "ProjectHorizon",
      routingKeys: expect.arrayContaining(["horizon-migration"]),
    });
    expect(store.routeMemoryObjects("ProjectHorizon", workspaceScope)[0]?.object.objectId)
      .toBe(original.objectId);

    curator.rollback(action!.actionId, "rename-rollback");
    const restored = store.getMemoryObject(original.objectId, workspaceScope) as MemoryObject;
    expect(restored.title).toBe(original.title);
    expect(restored.version).toBeGreaterThan(original.version);
    expect(store.listMemoryVersions("object", original.objectId)
      .map((version) => version.operation)).toEqual(expect.arrayContaining(["rename", "restore"]));
  });

  it("keeps cold memory out of default routing and reactivates it on an exact query", async () => {
    const store = setup();
    addEpisode(store, {
      id: "cold",
      entity: "ProjectGlacier",
      topic: "archive",
      content: "ProjectGlacier documented the frozen compatibility contract.",
    });
    const curator = new MemoryCurator(store, { config: { mergeSimilarity: 0.5 } });
    curator.run(workspaceScope, { type: "scan", idempotencyKey: "cold-ingest" });
    const object = objectByStatus(store, "active")[0] as MemoryObject;
    store.putMemoryObject({
      ...object,
      temperature: "cold",
      version: object.version + 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.putMemoryTemperature({
      memoryType: "object",
      memoryId: object.objectId,
      scope: object.scope,
      tier: "cold",
      score: 0.2,
      accessCount: 0,
      retrievalCount: 0,
      mentionCount: 0,
      explicitRemember: false,
      activeProject: false,
      pinned: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(store.routeMemoryObjects("", workspaceScope)).toEqual([]);
    const runtime = new MemoryRuntime(store);
    const turn = await beginQuery(runtime, "ProjectGlacier", "cold-explicit");
    const result = runtime.retrieveMemory({ turnId: turn.turnId, query: "ProjectGlacier" });
    expect(result.memories.some((memory) => memory.memoryId === object.objectId)).toBe(true);
    expect(store.getMemoryTemperature("object", object.objectId, workspaceScope)?.tier).toBe("warm");
  });

  it("bounds an overflowing partition by reorganizing it into local child partitions", () => {
    const store = setup();
    ["Atlas", "Orion", "Nova"].forEach((name) => addEpisode(store, {
      id: `partition-${name}`,
      entity: `Project${name}`,
      topic: "partition",
      content: `Project${name} owns a distinct bounded partition memory.`,
    }));
    const curator = new MemoryCurator(store, { config: { mergeSimilarity: 0.8 } });
    curator.run(workspaceScope, { type: "scan", idempotencyKey: "partition-ingest" });
    const root = store.listMemoryPartitions(workspaceScope)[0] as MemoryPartition;
    store.putMemoryPartition({
      ...root,
      capacity: 2,
      version: root.version + 1,
      updatedAt: "2026-07-27T00:00:00.000Z",
    });

    const reorganized = curator.run(workspaceScope, {
      type: "reorganize",
      idempotencyKey: "partition-reorganize",
    });
    expect(reorganized.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "move", status: "applied", targetId: root.partitionId }),
    ]));
    expect(store.getMemoryPartition(root.partitionId, workspaceScope)?.status).toBe("router");
    const children = store.listMemoryPartitions(workspaceScope, {
      includeArchived: true,
      parentPartitionId: root.partitionId,
    });
    expect(children.length).toBeGreaterThan(1);
    expect(children.every((partition) => partition.objectCount <= partition.capacity)).toBe(true);

    const nova = store.routeMemoryObjects("ProjectNova bounded partition", workspaceScope)[0];
    expect(nova?.object.entityKeys).toContain("projectnova");
    expect(children.map((partition) => partition.partitionId)).toContain(nova?.object.partitionId);

    const zen = addEpisode(store, {
      id: "partition-Zen",
      entity: "ProjectZen",
      topic: "partition",
      content: "ProjectZen must be routed into a bounded leaf instead of the empty root router.",
    });
    curator.run(workspaceScope, {
      type: "ingest",
      payload: { memberType: "episode", memberId: zen.episodeId },
      idempotencyKey: "partition-ingest-after-reorganize",
    });
    const zenObject = store.listObjectsForMember("episode", zen.episodeId, workspaceScope)[0];
    expect(zenObject?.partitionId).not.toBe(root.partitionId);
    expect(store.routeMemoryObjects("ProjectZen", workspaceScope)[0]?.object.objectId)
      .toBe(zenObject?.objectId);
  });

  it("persists retrieval-quality signals and uses them as configurable split triggers", async () => {
    const store = setup();
    for (const entity of ["ProjectSignalA", "ProjectSignalB"]) {
      for (let index = 0; index < 6; index += 1) {
        addEpisode(store, {
          id: `${entity}-${index}`,
          entity,
          topic: index < 3 ? "shared-deployment" : "shared-observability",
          content: `${entity} shared memory signal ${index} covers ${
            index < 3 ? "deployment routing" : "observability routing"
          }.`,
        });
      }
    }
    const curator = new MemoryCurator(store, {
      config: {
        mergeSimilarity: 0.35,
        maxObjectMembers: 50,
        splitMinMembers: 6,
        minimumSubtopicClusters: 99,
        maximumQueryHitDispersion: 0.1,
        minimumSummaryFidelity: 0,
        minimumLocalUseRatio: 0,
        minimumRetrievalSamples: 5,
      },
    });
    curator.run(workspaceScope, { type: "scan", idempotencyKey: "quality-ingest" });
    expect(objectByStatus(store, "active")).toHaveLength(2);

    const runtime = new MemoryRuntime(store, {
      evolutionConfig: { maxRoutedObjects: 8, maxCandidateCount: 40 },
    });
    for (let index = 0; index < 5; index += 1) {
      const turn = await beginQuery(runtime, "Analyze shared memory routing", `quality-query-${index}`);
      runtime.retrieveMemory({
        turnId: turn.turnId,
        query: "Analyze shared memory routing",
        limit: 8,
      });
    }
    curator.run(workspaceScope, { type: "quality", idempotencyKey: "quality-measure" });
    const activeObjectIds = objectByStatus(store, "active").map((object) => object.objectId);
    const metrics = activeObjectIds.flatMap((objectId) =>
      store.listMemoryQualityMetrics(
        workspaceScope,
        { type: "object", id: objectId },
        1,
      ));
    expect(metrics).toHaveLength(2);
    expect(metrics.every((metric) =>
      metric.retrievalSamples === 5 &&
      (metric.queryHitDispersion ?? 0) > 0 &&
      metric.summaryFidelity !== undefined &&
      metric.localUseRatio !== undefined)).toBe(true);

    const split = curator.run(workspaceScope, {
      type: "scan",
      idempotencyKey: "quality-driven-split",
    });
    expect(split.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "split",
        status: "applied",
        reason: expect.stringContaining("query_hit_dispersion"),
      }),
    ]));
  });
});

describe("risk-driven evidence retrieval and maintenance safety", () => {
  it("keeps session-scoped semantic objects out of other sessions", async () => {
    const store = setup();
    const runtime = new MemoryRuntime(store);
    const privateScope: ScopeRef = {
      ...workspaceScope,
      sessionId: "private-semantic-session",
    };
    const turn = await runtime.beginTurn({
      input: {
        idempotencyKey: "private-semantic-turn",
        kind: "user_message",
        content: "SessionProject launch phrase is Silver Finch.",
      },
      scope: privateScope,
      agentProfile: agent,
    });
    if (turn.gate.required) {
      runtime.checkpointEvidence({
        turnId: turn.turnId,
        observations: [{ kind: "user_statement", content: "This is a session-local statement." }],
      });
    }
    const result = runtime.submitCorrection({
      turnId: turn.turnId,
      kind: "fact",
      correction: "SessionProject launch phrase is Silver Finch.",
      subject: "SessionProject",
      predicate: "launch_phrase",
      value: "Silver Finch",
      scopeLevel: "session",
      explicit: true,
      idempotencyKey: "private-semantic-correction",
    }) as { claim: WorldClaim };
    runtime.processMaintenanceJobs();

    const ownerId = `${result.claim.claimId}\u001f${result.claim.version}`;
    const privateObject = store.listObjectsForMember("semantic", ownerId, privateScope)[0];
    expect(privateObject?.scope.sessionId).toBe(privateScope.sessionId);
    expect(store.routeMemoryObjects("SessionProject Silver Finch", privateScope)
      .map((hit) => hit.object.objectId)).toContain(privateObject?.objectId);
    expect(store.routeMemoryObjects("SessionProject Silver Finch", {
      ...workspaceScope,
      sessionId: "different-session",
    })).toEqual([]);
  });

  it("expands factual and quote recall to raw evidence but keeps analysis coarse", async () => {
    const store = setup();
    addEpisode(store, {
      id: "risk",
      entity: "ProjectAtlas",
      topic: "codename",
      content: "The exact ProjectAtlas decision was: codename Aurora.",
    });
    const curator = new MemoryCurator(store, { config: { mergeSimilarity: 0.5 } });
    curator.run(workspaceScope, { type: "scan", idempotencyKey: "risk-ingest" });
    const runtime = new MemoryRuntime(store);

    const factualTurn = await beginQuery(
      runtime,
      "What exactly did we say about the ProjectAtlas codename?",
      "factual-retrieve",
    );
    const factual = runtime.retrieveMemory({
      turnId: factualTurn.turnId,
      query: "What exactly did we say about the ProjectAtlas codename?",
    });
    expect(factual.riskProfile.quoteRecall).toBe(true);
    expect(factual.riskProfile.retrievalDepth).toBe("raw");
    expect(factual.memories).toEqual(expect.arrayContaining([
      expect.objectContaining({ memoryType: "raw", sourceType: "direct" }),
    ]));
    expect(factual.evidenceCoverage).toBe(1);
    expect(factual.shouldAbstain).toBe(false);

    const analysisTurn = await beginQuery(
      runtime,
      "Analyze why ProjectAtlas chose that codename",
      "analysis-retrieve",
    );
    const analysis = runtime.retrieveMemory({
      turnId: analysisTurn.turnId,
      query: "Analyze why ProjectAtlas chose that codename",
    });
    expect(analysis.riskProfile.inferenceAllowed).toBe(true);
    expect(analysis.riskProfile.retrievalDepth).toBe("object");
    expect(analysis.memories.some((memory) => memory.memoryType === "raw")).toBe(false);
  });

  it("authorizes source expansion for refs authorized by same-turn object retrieval", async () => {
    const store = setup();
    addEpisode(store, {
      id: "acl",
      entity: "ProjectAtlas",
      topic: "codename",
      content: "The exact ProjectAtlas decision was: codename Aurora.",
    });
    const curator = new MemoryCurator(store, { config: { mergeSimilarity: 0.5 } });
    curator.run(workspaceScope, { type: "scan", idempotencyKey: "acl-ingest" });
    const runtime = new MemoryRuntime(store);

    const turn = await beginQuery(
      runtime,
      "What exactly did we say about the ProjectAtlas codename?",
      "acl-retrieve",
    );
    const result = runtime.retrieveMemory({
      turnId: turn.turnId,
      query: "What exactly did we say about the ProjectAtlas codename?",
    });
    const evidenceRefs = result.memories.flatMap((memory) => memory.evidenceRefs);
    expect(evidenceRefs.length).toBeGreaterThan(0);

    const sources = runtime.getSources(turn.turnId, evidenceRefs);
    expect(sources.some((event) => event.content.includes("codename Aurora"))).toBe(true);
  });

  it("still denies source expansion for refs not authorized by the requesting turn", async () => {
    const store = setup();
    addEpisode(store, {
      id: "acl-deny",
      entity: "ProjectAtlas",
      topic: "codename",
      content: "The exact ProjectAtlas decision was: codename Aurora.",
    });
    const curator = new MemoryCurator(store, { config: { mergeSimilarity: 0.5 } });
    curator.run(workspaceScope, { type: "scan", idempotencyKey: "acl-deny-ingest" });
    const runtime = new MemoryRuntime(store);

    const firstTurn = await beginQuery(
      runtime,
      "What exactly did we say about the ProjectAtlas codename?",
      "acl-deny-retrieve",
    );
    const result = runtime.retrieveMemory({
      turnId: firstTurn.turnId,
      query: "What exactly did we say about the ProjectAtlas codename?",
    });
    const evidenceRefs = result.memories.flatMap((memory) => memory.evidenceRefs);
    expect(evidenceRefs.length).toBeGreaterThan(0);

    const otherTurn = await beginQuery(
      runtime,
      "Analyze why ProjectAtlas chose that codename",
      "acl-deny-other",
    );
    expect(() => runtime.getSources(otherTurn.turnId, evidenceRefs))
      .toThrowError(ProtocolError);
  });

  it("abstains from factual reconstruction when no evidence can be resolved", async () => {
    const store = setup();
    const runtime = new MemoryRuntime(store);
    const turn = await beginQuery(runtime, "What exactly was the missing launch code?", "missing");
    const result = runtime.retrieveMemory({
      turnId: turn.turnId,
      query: "What exactly was the missing launch code?",
    });

    expect(result.riskProfile.retrievalDepth).toBe("raw");
    expect(result.evidenceCoverage).toBe(0);
    expect(result.shouldAbstain).toBe(true);
    expect(result.unresolvedQuestions).not.toHaveLength(0);
  });

  it("preserves concurrent conflicting claims and records an unresolved contradiction", async () => {
    const store = setup();
    const runtime = new MemoryRuntime(store);
    const first = await beginQuery(runtime, "ProjectAtlas codename is Aurora", "conflict-a");
    const second = await beginQuery(runtime, "ProjectAtlas codename is Borealis", "conflict-b");

    runtime.submitCorrection({
      turnId: first.turnId,
      kind: "fact",
      correction: "ProjectAtlas codename is Aurora",
      subject: "ProjectAtlas",
      predicate: "codename",
      value: "Aurora",
      scopeLevel: "workspace",
      explicit: true,
      idempotencyKey: "claim-aurora",
    });
    const conflicting = runtime.submitCorrection({
      turnId: second.turnId,
      kind: "fact",
      correction: "ProjectAtlas codename is Borealis",
      subject: "ProjectAtlas",
      predicate: "codename",
      value: "Borealis",
      scopeLevel: "workspace",
      explicit: true,
      idempotencyKey: "claim-borealis",
    });

    expect(conflicting.result).toBe("world_claim_disputed");
    const claims = store.listWorldClaims(workspaceScope, true, undefined, true);
    expect(claims.map((claim) => claim.value)).toEqual(expect.arrayContaining(["Aurora", "Borealis"]));
    expect(claims.every((claim) => claim.status === "disputed")).toBe(true);
    const contradiction = store.listContradictions(workspaceScope, {
      includeResolved: true,
    })[0];
    expect(contradiction?.status).toBe("unresolved");
    expect(contradiction?.currentPreferredClaim).toBeUndefined();
    expect(contradiction?.evidenceRefs).toHaveLength(2);
  });

  it("retries a failed maintenance job without duplicating partial actions", () => {
    const store = setup();
    const curator = new MemoryCurator(store, {
      config: { maintenanceLeaseMs: 1_000, maintenanceMaxAttempts: 3 },
    });
    const queued = curator.enqueue(
      workspaceScope,
      "split",
      { objectId: "future-object" },
      "retry-split",
    );
    expect(curator.processJobs()).toEqual([]);
    const failedOnce = store.getMaintenanceJob(queued.jobId, workspaceScope);
    expect(failedOnce).toMatchObject({ status: "pending", attempts: 1 });
    expect(store.listMaintenanceActions(queued.jobId)).toEqual([]);

    const evidence = addEpisode(store, {
      id: "retry-evidence",
      entity: "RetryProject",
      topic: "retry",
      content: "RetryProject provides authoritative evidence for a retried object.",
    });
    const partition = barePartition("future-partition");
    store.putMemoryPartition(partition);
    store.putMemoryObject({
      objectId: "future-object",
      scope: workspaceScope,
      partitionId: partition.partitionId,
      objectType: "project",
      title: "RetryProject",
      summary: "RetryProject retry object",
      routingKeys: ["retryproject"],
      entityKeys: ["retryproject"],
      status: "active",
      temperature: "warm",
      tokenEstimate: 8,
      childCount: 0,
      memberCount: 1,
      confidence: 1,
      evidenceRefs: evidence.eventRefs,
      version: 1,
      schemaVersion: 1,
      summarizerVersion: "test-v1",
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
      provenance: {
        actor: "system",
        operation: "retry-fixture",
        sourceRefs: evidence.eventRefs,
      },
    });
    store.putMemoryObjectMember({
      objectId: "future-object",
      memberType: "episode",
      memberId: evidence.episodeId,
      role: "episode",
      score: 1,
      status: "active",
      addedAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    });

    const claimed = store.claimMaintenanceJobs(1, {
      now: new Date(Date.now() + 10_000).toISOString(),
      leaseMs: 1_000,
      maxAttempts: 3,
    })[0];
    expect(claimed?.jobId).toBe(queued.jobId);
    const completed = curator.executeJob(claimed!);
    expect(completed.job).toMatchObject({ status: "completed", attempts: 2 });
    expect(store.listMaintenanceActions(queued.jobId)).toEqual([]);
  });
});
