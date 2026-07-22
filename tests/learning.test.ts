import { describe, expect, it } from "vitest";
import type { RiskCode, ScopeRef } from "../src/contracts.js";
import {
  deriveCalibrationShadowCandidates,
  deriveTriggerCandidates,
  effectiveTriggerPriority,
  learnTriggerCondition,
  matchTrigger,
  recordTriggerActivation,
  resolvePolicyDependencies,
  schedulePolicies,
  type LearningCorrectionSample,
} from "../src/core/learning.js";
import type { StoredPolicy, TriggerRecord } from "../src/storage/types.js";

const scope: ScopeRef = {
  userId: "user-a",
  workspaceId: "workspace-a",
  sessionId: "session-current",
};

function correction(
  correctionId: string,
  sessionId: string,
  overrides: Partial<LearningCorrectionSample> = {},
): LearningCorrectionSample {
  return {
    correctionId,
    sessionId,
    agentProfileKey: "claude:1:sonnet:tools",
    riskCode: "narrative_completion",
    clusterKey: "visual_narrative_completion",
    occurredAt: `2026-01-0${correctionId.slice(-1)}T00:00:00.000Z`,
    scope: { ...scope, sessionId },
    features: {
      taskType: "visual",
      hasImage: true,
      asksForVisibleDetail: true,
      entitiesCount: 2,
      agentFamily: "claude",
    },
    origin: "user_correction",
    entitySpecific: false,
    policyId: "visual-policy",
    ...overrides,
  };
}

function policy(
  policyId: string,
  overrides: Partial<StoredPolicy> = {},
): StoredPolicy {
  return {
    policyId,
    version: 1,
    scopeLevel: "workspace",
    authority: "confirmed_learned",
    text: policyId,
    scope: { userId: scope.userId, workspaceId: scope.workspaceId },
    reviewStatus: "approved",
    ...overrides,
  };
}

function trigger(
  triggerId: string,
  policyId: string,
  overrides: Partial<TriggerRecord> = {},
): TriggerRecord {
  return {
    triggerId,
    policyId,
    riskCode: "narrative_completion" satisfies RiskCode,
    scope: { userId: scope.userId, workspaceId: scope.workspaceId },
    condition: {
      version: 1,
      all: [
        { feature: "taskType", operator: "equals", value: "visual" },
        { feature: "hasImage", operator: "equals", value: true },
      ],
    },
    priority: 1,
    activationCount: 1,
    lastActivatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("slow-learning calibration", () => {
  it("requires three user corrections across two sessions and emits shadow only", () => {
    expect(deriveCalibrationShadowCandidates([
      correction("c1", "s1"),
      correction("c2", "s1"),
    ])).toEqual([]);

    const candidates = deriveCalibrationShadowCandidates([
      correction("c3", "s2"),
      correction("c1", "s1"),
      correction("c2", "s1"),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      agentProfileKey: "claude:1:sonnet:tools",
      status: "shadow",
      riskCode: "narrative_completion",
      metrics: { correctionCount: 3, sessionCount: 2, probability: 0.4 },
      pattern: {
        requiresHistoricalReplay: true,
        promotionRule: "replay_and_online_shadow",
        correctionIds: ["c1", "c2", "c3"],
        sessionIds: ["s1", "s2"],
      },
    });
  });

  it("isolates profiles and rejects entity-specific or self-reflection-only support", () => {
    const candidates = deriveCalibrationShadowCandidates([
      correction("c1", "s1"),
      correction("c2", "s2", { entitySpecific: true }),
      correction("c3", "s2", { origin: "self_reflection" }),
      correction("c4", "s2", { agentProfileKey: "codex:1:o3:tools" }),
    ], { minCorrections: 2, minSessions: 2 });
    expect(candidates).toEqual([]);
  });

  it("is deterministic across input ordering and separates different profiles", () => {
    const claude = [correction("c1", "s1"), correction("c2", "s1"), correction("c3", "s2")];
    const codex = claude.map((item, index) => ({
      ...item,
      correctionId: `d${index + 1}`,
      agentProfileKey: "codex:1:o3:tools",
    }));
    const forward = deriveCalibrationShadowCandidates([...claude, ...codex]);
    const reverse = deriveCalibrationShadowCandidates([...claude, ...codex].reverse());
    expect(reverse).toEqual(forward);
    expect(forward).toHaveLength(2);
    expect(new Set(forward.map((item) => item.patternId)).size).toBe(2);
  });
});

describe("Trigger learning and matching", () => {
  it("learns repeated structured signals and excludes identity/profile fields", () => {
    const condition = learnTriggerCondition([
      correction("c1", "s1", { features: {
        taskType: "visual", hasImage: true, entitiesCount: 2, entityName: "Ruby", agentFamily: "claude", prompt: "private",
      } }),
      correction("c2", "s2", { features: {
        taskType: "visual", hasImage: true, entitiesCount: 4, entityName: "Ruby", agentFamily: "claude", prompt: "private",
      } }),
    ]);
    expect(condition?.all).toEqual([
      { feature: "entitiesCount", operator: "at_least", value: 2 },
      { feature: "hasImage", operator: "equals", value: true },
      { feature: "taskType", operator: "equals", value: "visual" },
    ]);
  });

  it("creates review-only Trigger candidates with deterministic evidence", () => {
    const candidates = deriveTriggerCandidates([
      correction("c3", "s2"),
      correction("c1", "s1"),
      correction("c2", "s1"),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      correctionIds: ["c1", "c2", "c3"],
      sessionIds: ["s1", "s2"],
      requiresHumanApproval: true,
      record: {
        policyId: "visual-policy",
        riskCode: "narrative_completion",
        activationCount: 0,
        priority: 0.4,
      },
    });
  });

  it("shares Trigger learning across Agent profiles while calibration remains isolated", () => {
    const candidates = deriveTriggerCandidates([
      correction("c1", "s1"),
      correction("c2", "s1", { agentProfileKey: "codex:1:o3:tools" }),
      correction("c3", "s2", { agentProfileKey: "generic:1:model:tools" }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.correctionIds).toEqual(["c1", "c2", "c3"]);
  });

  it("requires an event match and uses similarity only as auxiliary evidence", () => {
    const visual = trigger("visual-trigger", "visual-policy");
    const matched = matchTrigger(visual, {
      features: { taskType: "visual", hasImage: true },
      similarityByTriggerId: { "visual-trigger": 0.5 },
    });
    const semanticOnly = matchTrigger(visual, {
      features: { taskType: "coding", hasImage: false },
      similarityByTriggerId: { "visual-trigger": 1 },
    });
    expect(matched).toMatchObject({ matched: true, eventMatched: true, score: 0.9 });
    expect(semanticOnly).toMatchObject({ matched: false, eventMatched: false });
    expect(semanticOnly.score).toBe(0.2);
  });

  it("rejects empty conditions so embedding similarity cannot become a Trigger", () => {
    expect(matchTrigger(
      { triggerId: "empty", condition: {} },
      { features: {}, similarityByTriggerId: { empty: 1 } },
    )).toMatchObject({ matched: false, score: 0, reason: "invalid or empty event condition" });
  });

  it("treats any-clauses as alternatives rather than penalizing unused branches", () => {
    const result = matchTrigger({
      triggerId: "alternatives",
      condition: {
        version: 1,
        all: [{ feature: "hasImage", operator: "equals", value: true }],
        any: [
          { feature: "taskType", operator: "equals", value: "visual" },
          { feature: "taskType", operator: "equals", value: "conversation" },
          { feature: "taskType", operator: "equals", value: "recall" },
        ],
      },
    }, { features: { hasImage: true, taskType: "visual" } });
    expect(result).toMatchObject({ matched: true, eventMatched: true, eventCoverage: 1, score: 0.8 });
  });
});

describe("Trigger priority lifecycle", () => {
  it("decays activation frequency by half-life without mutating the record", () => {
    const original = trigger("t", "p", {
      priority: 1,
      activationCount: 5,
      lastActivatedAt: "2026-01-01T00:00:00.000Z",
    });
    const snapshot = structuredClone(original);
    const effective = effectiveTriggerPriority(original, "2026-01-31T00:00:00.000Z", {
      halfLifeDays: 30,
      floor: 0,
    });
    expect(effective).toBeCloseTo(0.5, 8);
    expect(original).toEqual(snapshot);
  });

  it("reactivates a Trigger to full priority while leaving associated Policy data outside the operation", () => {
    const original = trigger("t", "p", { priority: 0.12, activationCount: 3 });
    const activated = recordTriggerActivation(original, "2026-06-01T00:00:00.000Z");
    expect(activated).toMatchObject({ priority: 1, activationCount: 4, lastActivatedAt: "2026-06-01T00:00:00.000Z" });
    expect(original).toMatchObject({ priority: 0.12, activationCount: 3 });
  });
});

describe("Policy dependency graph and scheduling", () => {
  it("resolves external and transitive Policy dependencies, and fails closed on missing/cycles", () => {
    const base = policy("base", { dependencies: ["capability:image"] });
    const child = policy("child", { dependencies: ["base"] });
    const missing = policy("missing", { dependencies: ["does-not-exist"] });
    const cycleA = policy("cycle-a", { dependencies: ["cycle-b"] });
    const cycleB = policy("cycle-b", { dependencies: ["cycle-a"] });
    const result = resolvePolicyDependencies(
      [base, child, missing, cycleA, cycleB],
      ["capability:image"],
    );
    expect(result.get("base")).toMatchObject({ satisfied: true });
    expect(result.get("child")).toMatchObject({ satisfied: true, resolvedPolicyIds: ["base"] });
    expect(result.get("missing")).toMatchObject({ satisfied: false, missing: ["does-not-exist"] });
    expect(result.get("cycle-a")?.satisfied).toBe(false);
    expect(result.get("cycle-a")?.cyclic).toEqual(["cycle-a", "cycle-b"]);
  });

  it("assigns L1/L2/L3/Archive via Trigger signals without decaying Policy bodies", () => {
    const explicit = policy("explicit", { authority: "user_explicit" });
    const learned = policy("learned");
    const active = policy("active", { condition: { hasImage: true } });
    const background = policy("background", { condition: { taskType: "coding" } });
    const archived = policy("archived", { condition: { taskType: "coding" } });
    const policies = [explicit, learned, active, background, archived];
    const before = structuredClone(policies);
    const result = schedulePolicies({
      policies,
      triggers: [
        trigger("active-trigger", "active", { lastActivatedAt: "2020-01-01T00:00:00.000Z" }),
        trigger("background-trigger", "background", {
          priority: 0.6,
          activationCount: 0,
          lastActivatedAt: undefined,
        }),
        trigger("archive-trigger", "archived", {
          priority: 1,
          activationCount: 0,
          lastActivatedAt: "2020-01-01T00:00:00.000Z",
        }),
      ],
      scope,
      context: { features: { taskType: "visual", hasImage: true } },
      asOf: "2026-01-01T00:00:00.000Z",
      decay: { floor: 0 },
    });
    const byId = new Map(result.map((item) => [item.policy.policyId, item]));
    expect(byId.get("active")).toMatchObject({ tier: "L1", shouldLoad: true });
    expect(byId.get("explicit")).toMatchObject({ tier: "L2", shouldLoad: true });
    expect(byId.get("learned")).toMatchObject({ tier: "L3", shouldLoad: true });
    expect(byId.get("background")).toMatchObject({ tier: "L2", shouldLoad: false });
    expect(byId.get("archived")).toMatchObject({ tier: "Archive", shouldLoad: false });
    expect(policies).toEqual(before);
  });

  it("reactivates an archived Trigger immediately and expires session Policy by scope", () => {
    const visual = policy("visual", { condition: { hasImage: true } });
    const sessionOnly = policy("session", {
      scopeLevel: "session",
      scope: { ...scope, sessionId: "old-session" },
    });
    const result = schedulePolicies({
      policies: [visual, sessionOnly],
      triggers: [trigger("old-visual", "visual", {
        lastActivatedAt: "2020-01-01T00:00:00.000Z",
      })],
      scope,
      context: { features: { taskType: "visual", hasImage: true } },
      asOf: "2026-01-01T00:00:00.000Z",
      decay: { floor: 0 },
    });
    const byId = new Map(result.map((item) => [item.policy.policyId, item]));
    expect(byId.get("visual")).toMatchObject({ tier: "L1", shouldLoad: true, activatedBy: ["old-visual"] });
    expect(byId.get("session")).toMatchObject({ eligible: false, shouldLoad: false });
  });

  it("blocks unmet dependencies and pulls satisfied Policy dependencies into the working set", () => {
    const prerequisite = policy("prerequisite", { condition: { taskType: "coding" } });
    const dependent = policy("dependent", {
      condition: { hasImage: true },
      dependencies: ["prerequisite", "capability:image"],
    });
    const blocked = policy("blocked", {
      condition: { hasImage: true },
      dependencies: ["capability:medical"],
    });
    const result = schedulePolicies({
      policies: [prerequisite, dependent, blocked],
      triggers: [],
      scope,
      context: { features: { taskType: "visual", hasImage: true } },
      asOf: "2026-01-01T00:00:00.000Z",
      availableDependencies: ["capability:image"],
    });
    const byId = new Map(result.map((item) => [item.policy.policyId, item]));
    expect(byId.get("dependent")?.shouldLoad).toBe(true);
    expect(byId.get("prerequisite")).toMatchObject({ shouldLoad: true, tier: "L2" });
    expect(byId.get("blocked")).toMatchObject({ eligible: false, shouldLoad: false });
    expect(byId.get("blocked")?.dependency.missing).toEqual(["capability:medical"]);
  });

  it("uses only the latest approved version and never activates candidates", () => {
    const old = policy("versioned", { version: 1, authority: "user_explicit" });
    const candidate = policy("versioned", { version: 2, reviewStatus: "candidate" });
    const result = schedulePolicies({
      policies: [old, candidate],
      triggers: [],
      scope,
      context: { features: {} },
      asOf: "2026-01-01T00:00:00.000Z",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ policy: { version: 2 }, eligible: false, shouldLoad: false });
  });
});
