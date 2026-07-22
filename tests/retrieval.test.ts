import { describe, expect, it } from "vitest";
import type { SourceRef } from "../src/contracts.js";
import {
  buildDynamicRetrievalStrategy,
  buildReexperiencePack,
  cosineSimilarity,
  paginateRankedCandidates,
  rankRetrievalCandidates,
  retrievalStrategyForRisk,
  type ReexperienceCandidate,
  type RetrievalCandidate,
} from "../src/core/retrieval.js";

function source(eventId: string): SourceRef {
  return {
    eventId,
    sessionId: "session-a",
    contentHash: `hash-${eventId}`,
    capturedAt: "2026-01-01T00:00:00.000Z",
    workspaceId: "workspace-a",
  };
}

describe("dynamic retrieval strategy", () => {
  it("changes retrieval order and controls for the dominant risk", () => {
    const entity = retrievalStrategyForRisk("entity_or_symbol_merge");
    expect(entity.orderedSteps.indexOf("exact_match")).toBeLessThan(entity.orderedSteps.indexOf("timeline"));
    expect(entity.orderedSteps.indexOf("timeline")).toBeLessThan(entity.orderedSteps.indexOf("entity_graph"));
    expect(entity.weights.entity).toBeGreaterThan(entity.weights.embedding);
    expect(entity.checkpointFirst).toBe(true);

    const narrative = retrievalStrategyForRisk("narrative_completion");
    expect(narrative.orderedSteps.indexOf("current_evidence")).toBeLessThan(
      narrative.orderedSteps.indexOf("complete_episode"),
    );
    expect(narrative.orderedSteps.indexOf("checkpoint")).toBeLessThan(
      narrative.orderedSteps.indexOf("complete_episode"),
    );
    expect(narrative.originalSourceRequired).toBe(true);
    expect(narrative.minimumEvidenceCoverage).toBe(0.9);
  });

  it("blends multiple material risks in stable probability order", () => {
    const strategy = buildDynamicRetrievalStrategy([
      { code: "cross_session_merge", probability: 0.72 },
      { code: "wrong_workspace", probability: 0.84 },
      { code: "stale_source", probability: 0.39 },
    ]);
    expect(strategy.riskCodes).toEqual(["wrong_workspace", "cross_session_merge"]);
    expect(strategy.orderedSteps[0]).toBe("scope_filter");
    expect(strategy.sameWorkspaceOnly).toBe(true);
    expect(strategy.checkpointFirst).toBe(true);
    expect(Object.values(strategy.weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  it("disables semantic retrieval for secret-exposure mode", () => {
    const strategy = retrievalStrategyForRisk("secret_exposure");
    expect(strategy.allowEmbedding).toBe(false);
    expect(strategy.weights.embedding).toBe(0);
    expect(strategy.orderedSteps).toContain("redaction_filter");
  });
});

describe("hybrid ranking", () => {
  it("normalizes channels and reranks for source and evidence coverage", () => {
    const strategy = retrievalStrategyForRisk("unsupported_inference");
    const candidates: RetrievalCandidate[] = [
      { id: "lexical-only", kind: "world_claim", revision: 2, bm25Score: 10, sourceRefs: [] },
      {
        id: "covered",
        kind: "episode",
        revision: 1,
        bm25Score: 9,
        sourceRefs: [source("covered-source")],
        evidenceKeys: ["current-file", "entity-name"],
      },
      {
        id: "weak-covered",
        kind: "source_event",
        revision: 1,
        bm25Score: 0,
        sourceRefs: [source("weak-source")],
        evidenceKeys: ["current-file"],
      },
    ];
    const ranked = rankRetrievalCandidates(candidates, {
      strategy,
      requiredEvidenceKeys: ["current-file", "entity-name"],
      snapshotRevision: 2,
    });

    expect(ranked.map((candidate) => candidate.id)).toEqual(["covered", "lexical-only", "weak-covered"]);
    expect(ranked[0]?.sourceCoverage).toBe(1);
    expect(ranked[0]?.evidenceCoverage).toBe(1);
    expect(ranked[0]?.meetsEvidenceRequirement).toBe(true);
    expect(ranked[1]?.meetsEvidenceRequirement).toBe(false);
  });

  it("fuses entity, time, thread, and optional vector signals", () => {
    const strategy = retrievalStrategyForRisk("entity_or_symbol_merge");
    const candidates: RetrievalCandidate[] = [
      {
        id: "right-entity",
        kind: "episode",
        revision: 1,
        bm25Score: 4,
        embedding: [1, 0],
        entityDistance: 0,
        occurredAt: "2026-01-09T00:00:00.000Z",
        threadDistance: 0,
        sourceRefs: [source("right")],
      },
      {
        id: "semantic-decoy",
        kind: "episode",
        revision: 1,
        bm25Score: 5,
        embedding: [0, 1],
        entityDistance: 4,
        occurredAt: "2024-01-01T00:00:00.000Z",
        threadDistance: 5,
        sourceRefs: [source("decoy")],
      },
    ];
    const ranked = rankRetrievalCandidates(candidates, {
      strategy,
      queryEmbedding: [1, 0],
      queryTime: "2026-01-10T00:00:00.000Z",
      temporalHalfLifeMs: 1000 * 60 * 60 * 24 * 30,
    });
    expect(ranked[0]?.id).toBe("right-entity");
    expect(ranked[0]?.signalScores).toMatchObject({ embedding: 1, entity: 1, temporal: 1, thread: 1 });
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("deterministically drops and reweights embedding when no provider output exists", () => {
    const strategy = buildDynamicRetrievalStrategy([]);
    const candidates: RetrievalCandidate[] = [
      { id: "b", kind: "source_event", revision: 1, bm25Score: 1, threadDistance: 1, sourceRefs: [source("b")] },
      { id: "a", kind: "source_event", revision: 1, bm25Score: 1, threadDistance: 1, sourceRefs: [source("a")] },
    ];
    const first = rankRetrievalCandidates(candidates, { strategy });
    const second = rankRetrievalCandidates(candidates, { strategy });
    expect(first).toEqual(second);
    expect(first.map((candidate) => candidate.id)).toEqual(["a", "b"]);
    expect(first[0]?.activeWeights.embedding).toBe(0);
    expect(Object.values(first[0]?.activeWeights ?? {}).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  it("filters writes newer than the fixed turn snapshot", () => {
    const strategy = buildDynamicRetrievalStrategy([]);
    const ranked = rankRetrievalCandidates([
      { id: "visible", kind: "source_event", revision: 4, bm25Score: 1, sourceRefs: [source("visible")] },
      { id: "future", kind: "source_event", revision: 5, bm25Score: 2, sourceRefs: [source("future")] },
    ], { strategy, snapshotRevision: 4 });
    expect(ranked.map((candidate) => candidate.id)).toEqual(["visible"]);
  });
});

describe("stable keyset pagination", () => {
  it("returns every tie exactly once and rejects cursors from another snapshot", () => {
    const strategy = buildDynamicRetrievalStrategy([]);
    const candidates: RetrievalCandidate[] = ["d", "b", "a", "c"].map((id) => ({
      id,
      kind: "source_event",
      revision: 3,
      bm25Score: 1,
      sourceRefs: [source(id)],
    }));
    const ranked = rankRetrievalCandidates(candidates, { strategy, snapshotRevision: 3 });
    const first = paginateRankedCandidates(ranked, {
      limit: 2,
      snapshotRevision: 3,
      strategyId: strategy.strategyId,
    });
    const second = paginateRankedCandidates(ranked, {
      limit: 2,
      snapshotRevision: 3,
      strategyId: strategy.strategyId,
      cursor: first.nextCursor,
    });
    expect([...first.items, ...second.items].map((candidate) => candidate.id)).toEqual(["a", "b", "c", "d"]);
    expect(second.nextCursor).toBeUndefined();
    expect(() => paginateRankedCandidates(ranked, {
      limit: 2,
      snapshotRevision: 4,
      strategyId: strategy.strategyId,
      cursor: first.nextCursor,
    })).toThrow(/snapshot or strategy/u);
  });
});

describe("re-experience pack", () => {
  it("selects recent raw turns, complete episodes, key events, corrections, and fact constraints", () => {
    const candidates: ReexperienceCandidate[] = [
      { id: "fact", kind: "fact_constraint", tokenCost: 100, importance: 1, sourceRefs: [source("fact")] },
      { id: "correction", kind: "correction", tokenCost: 100, importance: 1, sourceRefs: [source("correction")] },
      {
        id: "recent-new",
        kind: "recent_source",
        tokenCost: 100,
        occurredAt: "2026-01-10T00:00:00.000Z",
        sourceRefs: [source("recent-new")],
      },
      {
        id: "recent-old",
        kind: "recent_source",
        tokenCost: 100,
        occurredAt: "2026-01-09T00:00:00.000Z",
        sourceRefs: [source("recent-old")],
      },
      {
        id: "recent-too-old",
        kind: "recent_source",
        tokenCost: 20,
        occurredAt: "2025-01-01T00:00:00.000Z",
        sourceRefs: [source("recent-too-old")],
      },
      { id: "episode", kind: "episode", tokenCost: 300, complete: true, relevance: 1, sourceRefs: [source("episode")] },
      { id: "partial", kind: "episode", tokenCost: 20, complete: false, relevance: 1, sourceRefs: [source("partial")] },
      { id: "event", kind: "key_event", tokenCost: 100, importance: 1, sourceRefs: [source("event"), source("fact")] },
    ];
    const pack = buildReexperiencePack(candidates, {
      budgetTokens: 800,
      now: "2026-01-11T00:00:00.000Z",
      recentRawLimit: 2,
    });
    expect(pack.factConstraints.map((item) => item.id)).toEqual(["fact"]);
    expect(pack.corrections.map((item) => item.id)).toEqual(["correction"]);
    expect(pack.recentRaw.map((item) => item.id)).toEqual(["recent-new", "recent-old"]);
    expect(pack.episodes.map((item) => item.id)).toEqual(["episode"]);
    expect(pack.keyEvents.map((item) => item.id)).toEqual(["event"]);
    expect(pack.items.map((item) => item.id)).not.toContain("partial");
    expect(pack.omittedIds).toEqual(["partial", "recent-too-old"]);
    expect(pack.sourceRefs.filter((item) => item.eventId === "fact")).toHaveLength(1);
    expect(pack.usedTokens).toBe(800);
  });

  it("trims atomically to budget without splitting an episode", () => {
    const pack = buildReexperiencePack([
      { id: "fact", kind: "fact_constraint", tokenCost: 80, sourceRefs: [source("fact")] },
      { id: "correction", kind: "correction", tokenCost: 80, sourceRefs: [source("correction")] },
      { id: "recent", kind: "recent_source", tokenCost: 80, sourceRefs: [source("recent")] },
      { id: "large-episode", kind: "episode", tokenCost: 200, complete: true, sourceRefs: [source("episode")] },
      { id: "event", kind: "key_event", tokenCost: 80, sourceRefs: [source("event")] },
    ], { budgetTokens: 320, now: "2026-01-11T00:00:00.000Z" });
    expect(pack.usedTokens).toBeLessThanOrEqual(320);
    expect(pack.items.map((item) => item.id)).not.toContain("large-episode");
    expect(pack.omittedIds).toContain("large-episode");
    expect(pack.truncated).toBe(true);
  });
});
