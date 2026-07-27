import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfile, ScopeRef } from "../src/contracts.js";
import { MemoryCurator } from "../src/curator.js";
import { MemoryStore, SCHEMA_VERSION } from "../src/storage/index.js";

const key = Buffer.alloc(32, 52);
const transferKey = "evolution-storage-transfer-key";
const agent: AgentProfile = {
  family: "storage-evolution",
  version: "1",
  capabilities: { hooks: true, stageGates: true },
};
const scope: ScopeRef = {
  userId: "storage-evolution-user",
  workspaceId: "storage-evolution-workspace",
  sessionId: "storage-evolution-session",
};
const workspaceScope: ScopeRef = {
  userId: scope.userId,
  workspaceId: scope.workspaceId,
};

const stores: MemoryStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(path = ":memory:", encryptionKey = key, deviceId = "evolution-storage"): MemoryStore {
  const store = new MemoryStore({ path, encryptionKey, deviceId });
  stores.push(store);
  return store;
}

function addCuratedEpisode(store: MemoryStore, id = "migration") {
  const event = store.appendSourceEvent({
    input: {
      eventId: `storage-event-${id}`,
      idempotencyKey: `storage-event-${id}`,
      kind: "user_message",
      content: `ProjectHarbor ${id} evidence remains authoritative after migration.`,
      occurredAt: "2026-07-20T00:00:00.000Z",
    },
    scope,
    agent,
    selectedEvidence: true,
  });
  const episode = {
    episodeId: `storage-episode-${id}`,
    scope,
    title: `ProjectHarbor ${id}`,
    summary: "A rebuildable locator summary",
    eventRefs: [store.toSourceRef(event)],
    participants: ["ProjectHarbor"],
    tags: ["migration"],
    startedAt: event.occurredAt,
    endedAt: event.occurredAt,
    entityKeys: ["ProjectHarbor"],
  };
  store.putEpisode(episode, `storage-episode-${id}`);
  const curator = new MemoryCurator(store, { config: { mergeSimilarity: 0.5 } });
  curator.run(workspaceScope, {
    type: "scan",
    idempotencyKey: `storage-curate-${id}`,
  });
  return { event, episode, curator };
}

describe("schema v7 migration and derived-state portability", () => {
  it("rotates bounded maintenance scope discovery instead of starving old workspaces", () => {
    const store = createStore();
    for (const workspaceId of ["scope-a", "scope-b", "scope-c"]) {
      store.appendSourceEvent({
        input: {
          eventId: `scope-event-${workspaceId}`,
          idempotencyKey: `scope-event-${workspaceId}`,
          kind: "user_message",
          content: `Maintenance evidence for ${workspaceId}.`,
        },
        scope: {
          userId: scope.userId,
          workspaceId,
          sessionId: `session-${workspaceId}`,
        },
        agent,
        selectedEvidence: true,
      });
    }

    const first = store.listMemoryScopes(2);
    for (const selected of first) {
      store.markMemoryScopeScheduled(selected, "2026-07-27T12:00:00.000Z");
    }
    const next = store.listMemoryScopes(1)[0];
    expect(next).toBeDefined();
    expect(first.map((selected) => selected.workspaceId)).not.toContain(next?.workspaceId);
  });

  it("upgrades a v6 database in place without changing authoritative events", () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-v7-migration-"));
    directories.push(directory);
    const path = join(directory, "memory.sqlite");
    const original = createStore(path);
    const event = original.appendSourceEvent({
      input: {
        eventId: "pre-v7-event",
        idempotencyKey: "pre-v7-event",
        kind: "user_message",
        content: "This raw evidence predates the evolving object schema.",
      },
      scope,
      agent,
      selectedEvidence: true,
    });
    original.close();
    stores.splice(stores.indexOf(original), 1);

    const legacy = new Database(path);
    legacy.exec(`
      DROP TABLE IF EXISTS memory_object_members;
      DROP TABLE IF EXISTS memory_relations;
      DROP TABLE IF EXISTS memory_versions;
      DROP TABLE IF EXISTS contradictions;
      DROP TABLE IF EXISTS memory_temperatures;
      DROP TABLE IF EXISTS retrieval_traces;
      DROP TABLE IF EXISTS maintenance_actions;
      DROP TABLE IF EXISTS memory_audit_log;
      DROP TABLE IF EXISTS memory_quality_metrics;
      DROP TABLE IF EXISTS maintenance_jobs;
      DROP TABLE IF EXISTS memory_objects_fts;
      DROP TABLE IF EXISTS memory_objects;
      DROP TABLE IF EXISTS memory_partitions;
      DROP TABLE IF EXISTS memory_scope_registry;
      DELETE FROM metadata WHERE key = 'memory_generation';
      PRAGMA user_version = 6;
    `);
    legacy.close();

    const upgraded = createStore(path);
    expect(upgraded.health()).toMatchObject({
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      memoryObjectCount: 0,
      maintenanceBacklog: 0,
    });
    expect(upgraded.getSourceEvent(event.eventId, scope)).toMatchObject({
      eventId: event.eventId,
      content: event.content,
      contentHash: event.contentHash,
    });
    const tables = (upgraded.database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'view') AND name IN (
        'memory_scope_registry', 'memory_partitions', 'memory_objects', 'memory_relations',
        'memory_versions', 'contradictions', 'maintenance_jobs'
      )
    `).all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toHaveLength(7);
    expect(upgraded.listMemoryScopes()).toEqual([{
      userId: scope.userId,
      workspaceId: scope.workspaceId,
    }]);
    expect(upgraded.database.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  it("exports and imports authoritative state plus evolution metadata, then rebuilds indexes", () => {
    const source = createStore(":memory:", key, "evolution-export-source");
    const { event } = addCuratedEpisode(source, "portable");
    const exported = source.exportData({ encryptionKey: transferKey });

    const destination = createStore(":memory:", Buffer.alloc(32, 53), "evolution-export-destination");
    const imported = destination.importData(exported, { encryptionKey: transferKey });
    expect(Object.values(imported.imported).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    expect(destination.getSourceEvent(event.eventId, scope)?.content).toContain("authoritative");
    expect(destination.listMemoryPartitions(workspaceScope)).toHaveLength(1);
    const objects = destination.listMemoryObjects(workspaceScope);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.evidenceRefs[0]?.eventId).toBe(event.eventId);
    expect(destination.listMemoryObjectMembers(objects[0]!.objectId, workspaceScope))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ memberType: "episode", memberId: "storage-episode-portable" }),
      ]));
    const rebuilt = destination.reindex();
    expect(rebuilt.indexed).toMatchObject({
      source_event: 1,
      episode: 1,
      memory_object: 1,
    });
    expect(destination.routeMemoryObjects("ProjectHarbor", workspaceScope)).not.toHaveLength(0);
  });

  it("cascades a forgotten raw source through objects, versions, graph links, and local indexes", () => {
    const store = createStore();
    const { event } = addCuratedEpisode(store, "forget");
    const object = store.listMemoryObjects(workspaceScope)[0];
    expect(object).toBeDefined();
    expect(store.listMemoryVersions("object", object!.objectId)).not.toHaveLength(0);

    const forgotten = store.forget({
      ...scope,
      entityType: "source_event",
      entityId: event.eventId,
      reason: "privacy deletion",
    });

    expect(forgotten.deleted).toMatchObject({
      source_event: 1,
      episode: 1,
      memory_object: 1,
    });
    expect(store.getSourceEvent(event.eventId, scope)).toBeUndefined();
    expect(store.getMemoryObject(object!.objectId, workspaceScope)).toBeUndefined();
    expect(store.listMemoryVersions("object", object!.objectId)).toEqual([]);
    expect(store.routeMemoryObjects("ProjectHarbor", workspaceScope)).toEqual([]);
    expect((store.database.prepare(`
      SELECT COUNT(*) AS count FROM source_links WHERE event_id = ?
    `).get(event.eventId) as { count: number }).count).toBe(0);
    expect((store.database.prepare(`
      SELECT COUNT(*) AS count FROM memory_object_members WHERE object_id = ?
    `).get(object!.objectId) as { count: number }).count).toBe(0);
    expect(store.listMemoryScopes()).toEqual([]);
  });
});
