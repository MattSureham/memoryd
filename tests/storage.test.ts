import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  type AgentProfile,
  type ScopeRef,
  type TurnPlan,
  type WorldClaim,
} from "../src/contracts.js";
import { MemoryStore, SCHEMA_VERSION, type StoredPolicy } from "../src/storage/index.js";

const key = Buffer.alloc(32, 7);
const agent: AgentProfile = {
  family: "test",
  version: "1",
  capabilities: { hooks: true, stageGates: true },
};
const scope: ScopeRef = {
  userId: "user-a",
  workspaceId: "workspace-a",
  sessionId: "session-a",
  branch: "main",
  commit: "abc123",
};

function turnPlan(turnId = "turn-a"): TurnPlan {
  return {
    protocolVersion: PROTOCOL_VERSION,
    turnId,
    snapshotRevision: 0,
    agentProfileKey: "test:1",
    risks: [],
    modes: {
      evidenceFirst: "low",
      uncertainty: "low",
      retrieveOriginalSource: "low",
      askClarification: "off",
      narrativeCompletionGate: "off",
    },
    retrievalStages: [
      { name: "policy", order: 1, blockedUntilCheckpoint: false },
      { name: "episode", order: 2, blockedUntilCheckpoint: true },
    ],
    gate: { kind: "evidence_checkpoint", required: true, satisfied: false },
    activePolicies: [],
    enforcementLevel: "enforced",
    retryCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function memoryStore(): MemoryStore {
  return new MemoryStore({ path: ":memory:", encryptionKey: key, deviceId: "device-a" });
}

const stores: MemoryStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  it("migrates SQLite, enables WAL, and encrypts only redacted source payloads", () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-store-"));
    directories.push(directory);
    const databasePath = join(directory, "memory.sqlite");
    const store = new MemoryStore({ path: databasePath, encryptionKey: key, deviceId: "device-a" });
    stores.push(store);

    const event = store.appendSourceEvent({
      input: {
        idempotencyKey: "event-secret",
        kind: "user_message",
        content: "deploy using api_key=super-secret-value and remember the lunar module",
      },
      scope,
      agent,
    });
    const repeated = store.appendSourceEvent({
      input: {
        idempotencyKey: "event-secret",
        kind: "user_message",
        content: "deploy using api_key=super-secret-value and remember the lunar module",
      },
      scope,
      agent,
    });

    expect(repeated.eventId).toBe(event.eventId);
    expect(event.content).toContain("[REDACTED]");
    expect(event.content).not.toContain("super-secret-value");
    expect(event.redactions).toContain("credential_assignment");
    expect(store.health()).toMatchObject({
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      journalMode: "wal",
      ftsAvailable: true,
      eventCount: 1,
    });

    const raw = store.database.prepare("SELECT encrypted_payload FROM source_events").get() as { encrypted_payload: string };
    const indexed = store.database.prepare("SELECT content FROM source_events_fts").get() as { content: string };
    expect(raw.encrypted_payload).not.toContain("lunar module");
    expect(raw.encrypted_payload).not.toContain("super-secret-value");
    expect(indexed.content).toContain("lunar module");
    expect(indexed.content).not.toContain("super-secret-value");
    expect(readFileSync(databasePath)).not.toContain(Buffer.from("super-secret-value"));
  });

  it("keeps SourceRef strict and applies user/workspace ACL before recall", () => {
    const store = memoryStore();
    stores.push(store);
    const eventA = store.appendSourceEvent({
      input: { idempotencyKey: "a", kind: "user_message", content: "unique nebula preference" },
      scope,
      agent,
    });
    store.appendSourceEvent({
      input: { idempotencyKey: "b", kind: "user_message", content: "unique nebula secret" },
      scope: { ...scope, workspaceId: "workspace-b", sessionId: "session-b" },
      agent,
    });
    const ref = store.toSourceRef(eventA);

    expect(store.getSourceEvents([ref], scope)).toHaveLength(1);
    expect(() => store.getSourceEvents([{ ...ref, contentHash: "bad" }], scope)).toThrow(ProtocolError);
    const search = store.search("unique nebula", scope, { kinds: ["source_event"] });
    expect(search.eventRefs).toEqual([ref]);
    expect(search.hits).toHaveLength(1);
    expect(() => store.getSourceEvent(eventA.eventId, { ...scope, userId: "user-b" })).toThrow(ProtocolError);
  });

  it("stores turns, observations, sourced claims, episodes, and searchable memory", () => {
    const store = memoryStore();
    stores.push(store);
    const event = store.appendSourceEvent({
      input: { idempotencyKey: "source", kind: "user_message", content: "the launch codename is Aurora" },
      scope,
      agent,
    });
    const ref = store.toSourceRef(event);
    store.createTurn(turnPlan(), scope, "turn-key");
    expect(store.getTurn("turn-a")?.scope).toEqual(scope);
    const updated = store.updateTurn("turn-a", { gateSatisfied: true, retryCount: 1 });
    expect(updated.plan.gate.satisfied).toBe(true);
    expect(updated.plan.retryCount).toBe(1);
    expect(store.addObservations("turn-a", [{
      observationId: "observation-a",
      kind: "user_statement",
      content: "confirmed Aurora",
      source: ref,
    }])).toHaveLength(1);

    const claim: WorldClaim = {
      claimId: "claim-a",
      subject: "launch",
      predicate: "codename",
      value: "Aurora",
      scope,
      confidence: 1,
      authority: "user_explicit",
      status: "active",
      sources: [ref],
      version: 1,
    };
    store.putWorldClaim(claim, "claim-key");
    store.putWorldClaim({
      ...claim,
      value: "Aurora II",
      version: 2,
      supersedes: claim.claimId,
      sources: [ref],
    }, "claim-key-2");
    store.putEpisode({
      episodeId: "episode-a",
      scope,
      title: "Aurora launch decision",
      summary: "The launch codename was selected",
      eventRefs: [ref],
      participants: ["user"],
      tags: ["launch"],
      startedAt: event.capturedAt,
      endedAt: event.capturedAt,
    });
    const result = store.search("Aurora launch", scope);

    expect(store.getWorldClaim("claim-a", 1)?.status).toBe("superseded");
    expect(store.getWorldClaim("claim-a", 2)?.status).toBe("active");
    expect(result.worldClaims).toEqual([expect.objectContaining({ version: 2, value: "Aurora II" })]);
    expect(result.episodes).toHaveLength(1);
    expect(result.hits.every((hit) => hit.sourceRefs.length > 0)).toBe(true);
    expect(store.reindex().indexed).toMatchObject({ source_event: 1, world_claim: 2, episode: 1 });
    expect(store.search("Aurora", scope).worldClaims).toHaveLength(1);
  });

  it("only activates the latest policy version", () => {
    const store = memoryStore();
    stores.push(store);
    const event = store.appendSourceEvent({
      input: { idempotencyKey: "policy-source", kind: "user_message", content: "Always verify the deployment target" },
      scope,
      agent,
    });
    const base: StoredPolicy = {
      policyId: "policy-a",
      version: 1,
      scope,
      scopeLevel: "workspace",
      authority: "user_explicit",
      text: "Always verify the deployment target",
      reviewStatus: "approved",
      sources: [store.toSourceRef(event)],
    };
    store.putPolicy(base);
    store.putPolicy({ ...base, version: 2, reviewStatus: "revoked" });

    expect(store.listPolicies(scope, true).map((policy) => policy.version)).toEqual([2]);
    expect(store.getActivePolicies(scope)).toEqual([]);
    expect(store.search("deployment target", scope, { kinds: ["policy"] }).policies).toEqual([]);
  });

  it("lets the administrative inspector enumerate session records without weakening normal ACL reads", () => {
    const store = memoryStore();
    stores.push(store);
    const event = store.appendSourceEvent({
      input: { idempotencyKey: "session-policy-source", kind: "user_message", content: "Review this candidate" },
      scope,
      agent,
    });
    const sessionPolicy: StoredPolicy = {
      policyId: "session-policy",
      version: 1,
      scope,
      scopeLevel: "session",
      authority: "confirmed_learned",
      text: "Review this session-only candidate",
      reviewStatus: "candidate",
      sources: [store.toSourceRef(event)],
    };
    store.putPolicy(sessionPolicy);
    const workspaceOnly = { userId: scope.userId, workspaceId: scope.workspaceId };

    expect(store.listPolicies(workspaceOnly, true)).toEqual([]);
    expect(store.listPolicies(workspaceOnly, true, true)).toEqual([
      expect.objectContaining({ policyId: "session-policy" }),
    ]);
  });

  it("forgets source-linked memories, removes indexes, and keeps only a redacted tombstone audit", () => {
    const store = memoryStore();
    stores.push(store);
    const event = store.appendSourceEvent({
      input: { idempotencyKey: "forget-source", kind: "user_message", content: "forgettable comet record" },
      scope,
      agent,
    });
    const ref = store.toSourceRef(event);
    store.putEpisode({
      episodeId: "forget-episode",
      scope,
      title: "comet record",
      eventRefs: [ref],
      participants: [],
      tags: [],
      startedAt: event.capturedAt,
      endedAt: event.capturedAt,
    });
    store.createTurn(turnPlan("forget-turn"), scope, "forget-turn");
    store.putTrace("forget-turn", { kind: "recall", source: ref, summary: "comet record" }, "forget-trace");

    const result = store.forget({
      ...scope,
      entityType: "source_event",
      entityId: event.eventId,
      reason: "password=do-not-store-this cleanup request",
    });
    expect(result.deleted).toMatchObject({ source_event: 1, episode: 1, trace: 1 });
    expect(store.getSourceEvent(event.eventId)).toBeUndefined();
    expect(store.getEpisode("forget-episode")).toBeUndefined();
    expect(store.search("comet", scope).hits).toEqual([]);
    expect(store.listTraces("forget-turn")).toEqual([]);
    const tombstones = store.database.prepare("SELECT * FROM tombstones ORDER BY entity_type").all() as Array<Record<string, unknown>>;
    expect(tombstones).toHaveLength(3);
    expect(tombstones.map((row) => row.reason).join(" ")).not.toContain("do-not-store-this");
    expect(JSON.stringify(tombstones)).not.toContain("comet record");
  });

  it("forgets every version of a policy identity so an older approved version cannot reactivate", () => {
    const store = memoryStore();
    stores.push(store);
    const event = store.appendSourceEvent({
      input: { idempotencyKey: "forget-policy-source", kind: "user_message", content: "Never reactivate this policy" },
      scope,
      agent,
    });
    const policy: StoredPolicy = {
      policyId: "forget-policy",
      version: 1,
      scope,
      scopeLevel: "workspace",
      authority: "user_explicit",
      text: "Never reactivate this policy",
      reviewStatus: "approved",
      sources: [store.toSourceRef(event)],
    };
    store.putPolicy(policy);
    store.putPolicy({ ...policy, version: 2, reviewStatus: "revoked" });
    const result = store.forget({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      entityType: "policy",
      entityId: "forget-policy",
      reason: "remove the policy identity",
    });

    expect(result.deleted.policy).toBe(2);
    expect(result.deleted.source_event).toBe(1);
    expect(store.getSourceEvent(event.eventId)).toBeUndefined();
    expect(store.getPolicy("forget-policy")).toBeUndefined();
    expect(store.getActivePolicies(scope)).toEqual([]);
    expect(store.search("reactivate", scope, { kinds: ["policy"] }).policies).toEqual([]);
  });

  it("accepts a public claim ID and forgets every claim version plus their authoritative sources", () => {
    const store = memoryStore();
    stores.push(store);
    const firstEvent = store.appendSourceEvent({
      input: { idempotencyKey: "forget-claim-source-1", kind: "user_message", content: "The launch color is blue" },
      scope,
      agent,
    });
    const secondEvent = store.appendSourceEvent({
      input: { idempotencyKey: "forget-claim-source-2", kind: "user_message", content: "The launch color is green" },
      scope,
      agent,
    });
    const first: WorldClaim = {
      claimId: "forget-claim",
      version: 1,
      subject: "launch",
      predicate: "color",
      value: "blue",
      scope,
      confidence: 1,
      authority: "user_explicit",
      status: "active",
      sources: [store.toSourceRef(firstEvent)],
    };
    store.putWorldClaim(first);
    store.putWorldClaim({
      ...first,
      version: 2,
      value: "green",
      status: "active",
      supersedes: first.claimId,
      sources: [store.toSourceRef(secondEvent)],
    });

    const result = store.forget({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      entityType: "world_claim",
      entityId: "forget-claim",
      reason: "remove the claim identity",
    });

    expect(result.deleted.world_claim).toBe(2);
    expect(result.deleted.source_event).toBe(2);
    expect(store.getWorldClaim("forget-claim")).toBeUndefined();
    expect(store.getSourceEvent(firstEvent.eventId)).toBeUndefined();
    expect(store.getSourceEvent(secondEvent.eventId)).toBeUndefined();
    expect(store.search("launch", scope, { kinds: ["world_claim"] }).worldClaims).toEqual([]);
  });

  it("round-trips authoritative records through an encrypted, idempotent export", () => {
    const source = memoryStore();
    const destination = new MemoryStore({ path: ":memory:", encryptionKey: Buffer.alloc(32, 8), deviceId: "device-b" });
    stores.push(source, destination);
    const event = source.appendSourceEvent({
      input: { eventId: "event-export", idempotencyKey: "export-key", kind: "user_message", content: "portable quasar memory" },
      scope,
      agent,
    });
    source.putWorldClaim({
      claimId: "claim-export",
      subject: "portable",
      predicate: "name",
      value: "quasar",
      scope,
      confidence: 0.9,
      authority: "confirmed_learned",
      status: "active",
      sources: [source.toSourceRef(event)],
      version: 1,
    });
    const transferKey = "shared export passphrase";
    const bundle = source.exportData({ encryptionKey: transferKey });
    expect(bundle).not.toContain("portable quasar memory");

    const first = destination.importData(bundle, { encryptionKey: transferKey });
    const revisionAfterFirst = destination.getRevision();
    const second = destination.importData(bundle, { encryptionKey: transferKey });
    expect(first.conflicts).toEqual([]);
    expect(first.imported).toMatchObject({ source_event: 1, world_claim: 1 });
    expect(second.conflicts).toEqual([]);
    expect(second.skipped).toBeGreaterThanOrEqual(2);
    expect(destination.getRevision()).toBe(revisionAfterFirst);
    expect(destination.search("quasar", scope).worldClaims).toHaveLength(1);
  });

  it("applies tombstones before records so out-of-order imports cannot resurrect forgotten content", () => {
    const source = memoryStore();
    const destination = new MemoryStore({ path: ":memory:", encryptionKey: Buffer.alloc(32, 8), deviceId: "device-b" });
    stores.push(source, destination);
    const event = source.appendSourceEvent({
      input: { eventId: "late-event", idempotencyKey: "late-event", kind: "user_message", content: "late forgotten asteroid" },
      scope,
      agent,
    });
    const transferKey = "out-of-order-transfer-key";
    const staleRecords = source.exportData({ encryptionKey: transferKey });
    source.forget({ ...scope, entityType: "source_event", entityId: event.eventId, reason: "forget before sync" });
    const deletion = source.exportData({ encryptionKey: transferKey });

    expect(destination.importData(deletion, { encryptionKey: transferKey }).imported).toMatchObject({ tombstone: 1 });
    const stale = destination.importData(staleRecords, { encryptionKey: transferKey });
    expect(stale.skipped).toBeGreaterThanOrEqual(1);
    expect(destination.getSourceEvent(event.eventId)).toBeUndefined();
    expect(destination.search("asteroid", scope).hits).toEqual([]);
  });
});
