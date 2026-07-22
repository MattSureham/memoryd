import { describe, expect, it, vi } from "vitest";
import type { AgentProfile, InputEvent, PolicyRef } from "../src/contracts.js";
import {
  buildTurnPlan,
  extractFeatures,
  orderPolicies,
  recognizeRisks,
  verifyResponse,
} from "../src/core/index.js";

const agent: AgentProfile = {
  family: "mock",
  version: "1",
  capabilities: { hooks: true, stageGates: true },
};

function event(content: string, metadata: Record<string, unknown> = {}): InputEvent {
  return { idempotencyKey: crypto.randomUUID(), kind: "user_message", content, metadata };
}

describe("risk-first control plane", () => {
  it("blocks narrative memory until an image observation is checkpointed", async () => {
    const features = extractFeatures(
      { ...event("这是哪一幕，发生了什么？"), attachments: [{ uri: "image.png", mediaType: "image/png" }] },
      { userId: "u", workspaceId: "w", sessionId: "s" },
      agent,
    );
    const risks = await recognizeRisks(features, agent);
    const plan = buildTurnPlan({ turnId: "t", snapshotRevision: 1, profile: agent, risks, policies: [] });

    expect(risks.find((risk) => risk.code === "narrative_completion")?.probability).toBeGreaterThanOrEqual(0.7);
    expect(plan.gate).toMatchObject({ required: true, satisfied: false });
    expect(plan.modes.narrativeCompletionGate).toBe("blocked");
    expect(plan.retrievalStages.find((stage) => stage.name === "episode")?.blockedUntilCheckpoint).toBe(true);
  });

  it("does not let caller metadata self-attest a current-evidence checkpoint", async () => {
    const features = extractFeatures(
      event("Use the old code before the refactor", {
        hasCurrentEvidence: true,
        currentFileRead: true,
        testResultAvailable: true,
      }),
      { userId: "u", workspaceId: "w", sessionId: "s" },
      agent,
    );
    const risks = await recognizeRisks(features, agent);
    const plan = buildTurnPlan({ turnId: "metadata-gate", snapshotRevision: 1, profile: agent, risks, policies: [] });
    expect(features.hasCurrentEvidence).toBe(false);
    expect(plan.gate.required).toBe(true);
  });

  it("strongly gates ambiguous entity recall across old sessions", async () => {
    const features = extractFeatures(
      event("Remember whether AlphaService or BetaService owned this before", { contextAge: "long" }),
      { userId: "u", workspaceId: "w", sessionId: "s" },
      agent,
    );
    const risks = await recognizeRisks(features, agent);
    const plan = buildTurnPlan({ turnId: "entity-gate", snapshotRevision: 1, profile: agent, risks, policies: [] });
    expect(risks.find((risk) => risk.code === "entity_or_symbol_merge")?.probability).toBeGreaterThanOrEqual(0.7);
    expect(risks.find((risk) => risk.code === "cross_session_merge")?.probability).toBeGreaterThanOrEqual(0.7);
    expect(plan.gate.required).toBe(true);
  });

  it("uses max aggregation and survives classifier timeout", async () => {
    vi.useFakeTimers();
    const features = extractFeatures(event("rm -rf everything"), { userId: "u", workspaceId: "w" }, agent);
    const resultPromise = recognizeRisks(features, agent, {
      timeoutMs: 10,
      classifier: {
        classify: async () => await new Promise(() => undefined),
      },
    });
    await vi.advanceTimersByTimeAsync(20);
    const result = await resultPromise;
    vi.useRealTimers();
    expect(result.find((risk) => risk.code === "destructive_action")?.probability).toBe(0.98);
  });

  it("sends classifiers only the compressed feature projection", async () => {
    let received: Readonly<Record<string, unknown>> | undefined;
    const rawMarker = "private-user-sentence-never-forward";
    const features = extractFeatures(
      event(`Remember ${rawMarker} from the old code`, { userIntent: rawMarker }),
      { userId: "u", workspaceId: "w" },
      agent,
    );
    const risks = await recognizeRisks(features, agent, {
      classifier: {
        classify: async (projection) => {
          received = projection;
          return { stale_source: 0.91 };
        },
      },
    });
    expect(JSON.stringify(received)).not.toContain(rawMarker);
    expect(received).not.toHaveProperty("content");
    expect(risks.find((risk) => risk.code === "stale_source")?.probability).toBe(0.91);
  });

  it("keeps agent calibration overlays isolated in the profile key", () => {
    const left = buildTurnPlan({ turnId: "a", snapshotRevision: 1, profile: agent, risks: [], policies: [] });
    const right = buildTurnPlan({
      turnId: "b",
      snapshotRevision: 1,
      profile: { ...agent, family: "other", model: "m2" },
      risks: [],
      policies: [],
    });
    expect(left.agentProfileKey).not.toBe(right.agentProfileKey);
  });

  it("produces equivalent control plans for Claude, Codex, and a generic Agent before overlays", async () => {
    const profiles: AgentProfile[] = ["claude", "codex", "generic"].map((family) => ({
      family,
      version: "1",
      capabilities: { hooks: true, stageGates: true },
    }));
    const plans = [];
    for (const [index, profile] of profiles.entries()) {
      const features = extractFeatures(
        event("Remember the old code before the refactor"),
        { userId: "u", workspaceId: "w", sessionId: `s-${index}` },
        profile,
      );
      const risks = await recognizeRisks(features, profile);
      plans.push(buildTurnPlan({
        turnId: `turn-${index}`,
        snapshotRevision: 9,
        profile,
        risks,
        policies: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      }));
    }
    const comparable = plans.map(({ turnId: _turnId, agentProfileKey: _profile, ...plan }) => plan);
    expect(comparable[1]).toEqual(comparable[0]);
    expect(comparable[2]).toEqual(comparable[0]);
  });
});

describe("policy and verification", () => {
  it("orders explicit and more specific policy first without decay", () => {
    const policies: PolicyRef[] = [
      { policyId: "learned", version: 1, scopeLevel: "session", authority: "confirmed_learned", text: "learned" },
      { policyId: "global", version: 1, scopeLevel: "user", authority: "user_explicit", text: "global" },
      { policyId: "workspace", version: 1, scopeLevel: "workspace", authority: "user_explicit", text: "workspace" },
    ];
    expect(orderPolicies(policies).map((policy) => policy.policyId)).toEqual(["workspace", "global", "learned"]);
  });

  it("allows one retry then abstains on unsupported claims", () => {
    const first = verifyResponse({
      response: "I remember this is true.",
      evidenceRefs: [],
      activePolicies: [],
      retryCount: 0,
    });
    const second = verifyResponse({
      response: "I remember this is true.",
      evidenceRefs: [],
      activePolicies: [],
      retryCount: 1,
    });
    expect(first.status).toBe("retry");
    expect(second.status).toBe("abstain");
  });
});
