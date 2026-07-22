import { describe, expect, it } from "vitest";
import type {
  AgentProfile,
  BeginTurnInput,
  ScopeRef,
} from "../src/contracts.js";
import { ProtocolError } from "../src/contracts.js";
import type { EmbeddingProvider } from "../src/core/embedding.js";
import { MemoryRuntime } from "../src/runtime.js";
import { MemoryStore } from "../src/storage/index.js";

const key = Buffer.alloc(32, 19);
const workspaceScope = { userId: "advanced-user", workspaceId: "advanced-workspace" } as const;
const agent: AgentProfile = {
  family: "claude",
  version: "1",
  model: "integration-model",
  toolsetDigest: "integration-tools",
  capabilities: { hooks: true, stageGates: true },
};

function scope(sessionId: string): ScopeRef & { sessionId: string } {
  return { ...workspaceScope, sessionId };
}

function setup(options: ConstructorParameters<typeof MemoryRuntime>[1] = {}) {
  let tick = 0;
  const store = new MemoryStore({
    path: ":memory:",
    encryptionKey: key,
    deviceId: "advanced-device",
    now: () => new Date(Date.parse("2026-07-22T00:00:00.000Z") + tick++ * 1_000),
  });
  return { store, runtime: new MemoryRuntime(store, options) };
}

function beginInput(
  content: string,
  idempotencyKey: string,
  sessionId: string,
  overrides: Partial<BeginTurnInput> = {},
): BeginTurnInput {
  return {
    input: { idempotencyKey, kind: "user_message", content },
    scope: scope(sessionId),
    agentProfile: agent,
    ...overrides,
  };
}

async function complete(
  runtime: MemoryRuntime,
  content: string,
  id: string,
  sessionId: string,
  response: string,
  occurredAt?: string,
) {
  const turn = await runtime.beginTurn({
    ...beginInput(content, `${id}:begin`, sessionId),
    input: {
      idempotencyKey: `${id}:begin`,
      kind: "user_message",
      content,
      ...(occurredAt === undefined ? {} : { occurredAt }),
    },
  });
  const result = runtime.completeTurn({
    turnId: turn.turnId,
    response,
    idempotencyKey: `${id}:complete`,
    evidenceRefs: [],
  });
  expect(result.retryAllowed).toBe(false);
  return turn;
}

class AlwaysSimilarEmbedding implements EmbeddingProvider {
  readonly provider = "test";
  readonly model = "always-similar-v1";
  readonly dimensions = 2;

  embed(): number[] {
    return [1, 0];
  }
}

describe("advanced runtime integration", () => {
  it("records matched risk-only Trigger activations and refreshes their decay signal", async () => {
    const { store, runtime } = setup({ embeddingProvider: false });
    try {
      store.upsertTrigger({
        triggerId: "risk-only-trigger",
        scope: workspaceScope,
        riskCode: "unsupported_inference",
        condition: {
          version: 1,
          all: [{ feature: "taskType", operator: "equals", value: "coding" }],
        },
        priority: 0.8,
        activationCount: 0,
        status: "active",
      });

      const turn = await runtime.beginTurn(beginInput("Review this code", "risk-only", "risk-only-session"));
      expect(turn.risks).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "unsupported_inference", probability: 0.8 }),
      ]));
      expect(store.getTrigger("risk-only-trigger")).toMatchObject({
        priority: 1,
        activationCount: 1,
        lastActivatedAt: expect.any(String),
      });
      expect(store.listTriggerActivations("risk-only-trigger")).toEqual([
        expect.objectContaining({ turnId: turn.turnId, effectiveScore: 0.8 }),
      ]);
    } finally {
      store.close();
    }
  });

  it("counts concurrent idempotent begin_turn calls as one Calibration shadow sample", async () => {
    const { store, runtime } = setup({
      embeddingProvider: false,
      classifier: {
        classify: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {};
        },
      },
    });
    try {
      store.upsertCalibrationPattern({
        patternId: "idempotent-shadow",
        agentProfileKey: "claude:1:integration-model:integration-tools",
        status: "shadow",
        riskCode: "unsupported_inference",
        pattern: {
          condition: {
            version: 1,
            all: [{ feature: "hasImage", operator: "equals", value: false }],
          },
        },
        metrics: { replayCoverage: 0.8, replayActivationRate: 0.1 },
      });
      const input = beginInput("Review this code", "concurrent-shadow", "concurrent-shadow");

      const [first, second] = await Promise.all([runtime.beginTurn(input), runtime.beginTurn(input)]);

      expect(second).toEqual(first);
      expect(store.listTurns(scope("concurrent-shadow"))).toHaveLength(1);
      expect(store.getCalibrationPattern("idempotent-shadow")?.metrics).toMatchObject({
        shadowSamples: 1,
        shadowActivations: 1,
      });
    } finally {
      store.close();
    }
  });

  it("serializes turn creation with session end while preserving retries of an existing begin", async () => {
    let classifierCalls = 0;
    let releaseClassifier!: () => void;
    let classifierEntered!: () => void;
    const classifierGate = new Promise<void>((resolve) => { releaseClassifier = resolve; });
    const entered = new Promise<void>((resolve) => { classifierEntered = resolve; });
    const { store, runtime } = setup({
      embeddingProvider: false,
      classifier: {
        classify: async () => {
          classifierCalls += 1;
          if (classifierCalls === 1) return {};
          classifierEntered();
          await classifierGate;
          return {};
        },
      },
    });
    try {
      const retryInput = beginInput("Existing turn", "session-race:existing", "session-race-existing");
      const existing = await runtime.beginTurn(retryInput);
      runtime.endSession({ scope: retryInput.scope, idempotencyKey: "session-race:existing:end" });

      await expect(runtime.beginTurn(retryInput)).resolves.toEqual(existing);
      expect(classifierCalls).toBe(1);

      const racingInput = beginInput("Racing turn", "session-race:new", "session-race-new");
      const pending = runtime.beginTurn(racingInput);
      await entered;
      runtime.endSession({ scope: racingInput.scope, idempotencyKey: "session-race:new:end" });
      releaseClassifier();

      await expect(pending).rejects.toThrowError(expect.objectContaining({
        shape: expect.objectContaining({ code: "VERSION_CONFLICT" }),
      }));
      expect(store.getSession("session-race-new", racingInput.scope)).toMatchObject({ status: "ended" });
      expect(store.listTurns(racingInput.scope)).toEqual([]);
    } finally {
      releaseClassifier();
      store.close();
    }
  });

  it("does not cluster unrelated behavioral corrections that share the same turn features", async () => {
    const { store, runtime } = setup();
    try {
      const lessons = [
        "Always cite the original source.",
        "Ask before deleting generated files.",
        "Keep credentials out of diagnostic output.",
      ];
      const policyIds: string[] = [];
      for (const [index, lesson] of lessons.entries()) {
        const sessionId = `separate-${index}`;
        const turn = await runtime.beginTurn(beginInput("Review this code", `separate:${index}`, sessionId));
        const result = runtime.submitCorrection({
          turnId: turn.turnId,
          kind: "behavior",
          correction: lesson,
          scopeLevel: "workspace",
          explicit: false,
          idempotencyKey: `separate:correction:${index}`,
        }) as { policy: { policyId: string } };
        policyIds.push(result.policy.policyId);
      }

      expect(new Set(policyIds).size).toBe(lessons.length);
      expect(store.listFailureClusters(scope("separate-0"))).toHaveLength(lessons.length);
      expect(store.listFailureClusters(scope("separate-0")).every((cluster) =>
        cluster.status === "candidate" && cluster.correctionIds.length === 1)).toBe(true);
      runtime.runLearning(workspaceScope);
      expect(store.listTriggers(scope("separate-0"), true)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("learns candidate Trigger and shadow calibration after repeated corrections, but loads only an approved and activated Policy", async () => {
    const { store, runtime } = setup();
    try {
      const lesson = "Verify ambiguous identifiers before merging them.";
      let policyId = "";
      for (const [index, sessionId] of ["learn-a", "learn-a", "learn-b"].entries()) {
        const turn = await runtime.beginTurn(beginInput("Review ambiguous identifiers before merge", `learn:${index}`, sessionId));
        const result = runtime.submitCorrection({
          turnId: turn.turnId,
          kind: "behavior",
          correction: lesson,
          scopeLevel: "workspace",
          explicit: false,
          idempotencyKey: `learn:correction:${index}`,
        }) as { policy: { policyId: string } };
        policyId = result.policy.policyId;
      }

      const learning = runtime.runLearning(workspaceScope) as {
        claimed: number;
        completed: string[];
        failed: unknown[];
      };
      expect(learning.claimed).toBeGreaterThan(0);
      expect(learning.completed.length).toBeGreaterThan(0);
      expect(learning.failed).toEqual([]);

      const trigger = store.listTriggers(scope("learn-b"), true).find((item) => item.policyId === policyId);
      expect(trigger).toMatchObject({ status: "candidate", activationCount: 0 });
      expect(store.listCalibrationPatterns("claude:1:integration-model:integration-tools", true)).toEqual([
        expect.objectContaining({ status: "shadow", riskCode: expect.any(String) }),
      ]);

      const beforeApproval = await runtime.beginTurn(
        beginInput("Review ambiguous identifiers before merge", "learn:before-approval", "learn-before"),
      );
      expect(beforeApproval.activePolicies.map((policy) => policy.policyId)).not.toContain(policyId);

      const candidate = store.getPolicy(policyId);
      expect(candidate).toBeDefined();
      store.putPolicy({
        ...candidate!,
        version: candidate!.version + 1,
        reviewStatus: "approved",
      }, `approve:${policyId}`);
      store.upsertTrigger({ ...trigger!, status: "active" });

      const afterApproval = await runtime.beginTurn(
        beginInput("Review ambiguous identifiers before merge", "learn:after-approval", "learn-after"),
      );
      expect(afterApproval.activePolicies).toEqual([
        expect.objectContaining({ policyId, text: lesson }),
      ]);
      expect(afterApproval.policySchedule?.l1).toEqual([
        expect.objectContaining({ policyId, triggerIds: [trigger!.triggerId] }),
      ]);
      expect(store.listTriggerActivations(trigger!.triggerId)).toEqual([
        expect.objectContaining({ turnId: afterApproval.turnId }),
      ]);
    } finally {
      store.close();
    }
  });

  it("never lets semantic similarity bypass a mismatched structured Trigger condition", async () => {
    const { store, runtime } = setup({ embeddingProvider: new AlwaysSimilarEmbedding() });
    try {
      const sourceEvent = runtime.recordEvent({
        input: {
          idempotencyKey: "visual-policy-source",
          kind: "user_message",
          content: "Inspect visual evidence before answering.",
        },
        scope: scope("semantic-policy-source"),
        agentProfile: agent,
      });
      store.putPolicy({
        policyId: "visual-only-policy",
        version: 1,
        scopeLevel: "workspace",
        authority: "confirmed_learned",
        text: "Inspect visual evidence before answering.",
        scope: workspaceScope,
        reviewStatus: "approved",
        sources: [store.toSourceRef(sourceEvent)],
      });
      store.upsertTrigger({
        triggerId: "visual-only-trigger",
        policyId: "visual-only-policy",
        scope: workspaceScope,
        condition: {
          version: 1,
          all: [{ feature: "hasImage", operator: "equals", value: true }],
        },
        priority: 1,
        activationCount: 0,
        status: "active",
      });

      const plan = await runtime.beginTurn(
        beginInput("Inspect visual evidence before answering", "semantic-only", "semantic-only"),
      );
      expect(plan.activePolicies.map((policy) => policy.policyId)).not.toContain("visual-only-policy");
      expect(store.listTriggerActivations("visual-only-trigger")).toEqual([]);

      const beginTrace = store.listTraces(plan.turnId).find((trace) => trace.trace.kind === "begin_turn");
      const matches = beginTrace?.trace.triggerMatches as Array<{
        triggerId: string;
        matched: boolean;
        eventMatched: boolean;
        similarity: number;
      }>;
      expect(matches).toEqual([
        expect.objectContaining({
          triggerId: "visual-only-trigger",
          matched: false,
          eventMatched: false,
          similarity: 1,
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it("ends a session idempotently, expires session Policy, closes its narrative, and rejects new turns", async () => {
    const { store, runtime } = setup();
    try {
      const sessionId = "ending-session";
      const turn = await runtime.beginTurn(beginInput("Keep this rule for this session", "session:begin", sessionId));
      const correction = runtime.submitCorrection({
        turnId: turn.turnId,
        kind: "behavior",
        correction: "Use concise answers in this session.",
        scopeLevel: "session",
        explicit: true,
        idempotencyKey: "session:policy",
      }) as { policy: { policyId: string } };
      runtime.completeTurn({
        turnId: turn.turnId,
        response: "The session-scoped rule is recorded.",
        idempotencyKey: "session:complete",
        evidenceRefs: [],
      });
      const pendingInput = beginInput(
        "This turn will still be active when the session ends",
        "session:pending",
        sessionId,
      );
      const pending = await runtime.beginTurn(pendingInput);
      const preEndEventInput = {
        input: { idempotencyKey: "session:pre-end-event", kind: "tool_result" as const, content: "saved result" },
        scope: scope(sessionId),
        agentProfile: agent,
        selectedEvidence: true,
      };
      const preEndEvent = runtime.recordEvent(preEndEventInput);
      expect(store.getActivePolicies(scope(sessionId)).map((policy) => policy.policyId)).toContain(correction.policy.policyId);

      const first = runtime.endSession({ scope: scope(sessionId), idempotencyKey: "session:end" });
      const revisionAfterFirst = store.getRevision();
      const second = runtime.endSession({ scope: scope(sessionId), idempotencyKey: "session:end" });

      expect(second).toEqual(first);
      expect(store.getRevision()).toBe(revisionAfterFirst);
      expect(first).toMatchObject({ expiredPolicyCount: 1 });
      expect(first.closedEpisodeIds).toHaveLength(1);
      expect(store.getActivePolicies(scope(sessionId)).map((policy) => policy.policyId)).not.toContain(correction.policy.policyId);
      expect(store.getEpisode(first.closedEpisodeIds[0]!, scope(sessionId))).toMatchObject({
        closed: true,
        closedReason: "session_end",
      });
      expect(() => runtime.recordEvent({
        input: { idempotencyKey: "session:late-event", kind: "tool_result", content: "late data" },
        scope: scope(sessionId),
        agentProfile: agent,
      })).toThrow(/has ended/u);
      expect(runtime.recordEvent(preEndEventInput)).toEqual(preEndEvent);
      expect(() => runtime.recordEvent({
        ...preEndEventInput,
        input: { ...preEndEventInput.input, content: "different result" },
      })).toThrow(/idempotency key/iu);
      expect(() => runtime.completeTurn({
        turnId: pending.turnId,
        response: "late completion",
        idempotencyKey: "session:late-complete",
        evidenceRefs: [],
      })).toThrow(/has ended/u);
      expect(await runtime.beginTurn(pendingInput)).toEqual(pending);
      await expect(runtime.beginTurn(beginInput(
        "This reuses the same key with different content",
        "session:pending",
        sessionId,
      ))).rejects.toThrow(/idempotency key/iu);
      await expect(runtime.beginTurn(beginInput("This must fail", "session:late", sessionId)))
        .rejects.toThrow(/has ended/u);

      const next = await runtime.beginTurn(beginInput("A fresh session", "session:fresh", "fresh-session"));
      expect(next.activePolicies.map((policy) => policy.policyId)).not.toContain(correction.policy.policyId);
    } finally {
      store.close();
    }
  });

  it("recalls synonym-only memory through embeddings and records entity, thread, and coverage reranking signals", async () => {
    const { store, runtime } = setup();
    try {
      const old = runtime.recordEvent({
        input: {
          eventId: "semantic-old-event",
          idempotencyKey: "semantic:old",
          kind: "user_message",
          content: "The repository failure originated in AlphaService.",
          occurredAt: "2026-07-20T00:00:00.000Z",
        },
        scope: scope("semantic-old"),
        agentProfile: agent,
      });
      const currentThread = runtime.recordEvent({
        input: {
          eventId: "semantic-current-event",
          idempotencyKey: "semantic:current",
          kind: "user_message",
          content: "AlphaService deployment context is available.",
          occurredAt: "2026-07-22T00:00:00.000Z",
        },
        scope: scope("semantic-reader"),
        agentProfile: agent,
      });
      expect(store.search("repo bug", scope("semantic-reader"), { kinds: ["source_event"] }).hits)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: old.eventId })]));

      const turn = await runtime.beginTurn(
        beginInput("Retrieve related engineering context", "semantic:reader", "semantic-reader"),
      );
      const semantic = runtime.recall({
        turnId: turn.turnId,
        stage: "source_expansion",
        query: "repo bug",
        budgetTokens: 2_000,
      });
      expect(semantic.sourceRefs.map((ref) => ref.eventId)).toContain(old.eventId);
      expect(semantic.trace.rankingSignals).toContain("embedding");

      const entity = runtime.recall({
        turnId: turn.turnId,
        stage: "source_expansion",
        query: "AlphaService",
        budgetTokens: 2_000,
      });
      expect(entity.sourceRefs.map((ref) => ref.eventId)).toEqual(
        expect.arrayContaining([old.eventId, currentThread.eventId]),
      );
      expect(entity.trace).toMatchObject({
        coverageReranked: true,
        rankingSignals: expect.arrayContaining(["entity", "temporal", "thread"]),
      });
      const recallTrace = store.listTraces(turn.turnId)
        .filter((trace) => trace.trace.kind === "recall")
        .find((trace) => (trace.trace.input as { query?: string } | undefined)?.query === "AlphaService");
      const ranking = recallTrace?.trace.ranking as Array<{
        id: string;
        sourceCoverage: number;
        evidenceCoverage: number;
        signalScores: Record<string, number>;
      }>;
      expect(ranking).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: currentThread.eventId,
          sourceCoverage: 1,
          signalScores: expect.objectContaining({ entity: 1, thread: 1 }),
        }),
      ]));
    } finally {
      store.close();
    }
  });

  it("merges related turns into one narrative and starts new chunks on topic and correction boundaries", async () => {
    const { store, runtime } = setup();
    try {
      const first = await complete(
        runtime,
        "Fix AlphaService authentication failure",
        "narrative:first",
        "narrative-session",
        "Updated AlphaService authentication tests.",
        "2026-07-22T00:00:00.000Z",
      );
      const second = await complete(
        runtime,
        "Add AlphaService authentication coverage",
        "narrative:second",
        "narrative-session",
        "AlphaService authentication coverage now passes.",
        "2026-07-22T00:05:00.000Z",
      );
      const topicShift = await complete(
        runtime,
        "Paint GammaWidget on an unrelated purple canvas",
        "narrative:topic",
        "narrative-session",
        "GammaWidget rendering remains isolated.",
        "2026-07-22T00:10:00.000Z",
      );

      const corrected = await runtime.beginTurn({
        ...beginInput("Continue GammaWidget rendering", "narrative:correction", "narrative-session"),
        input: {
          idempotencyKey: "narrative:correction",
          kind: "user_message",
          content: "Continue GammaWidget rendering",
          occurredAt: "2026-07-22T00:15:00.000Z",
        },
      });
      runtime.submitCorrection({
        turnId: corrected.turnId,
        kind: "unknown",
        wrongStatement: "The render is already complete.",
        correction: "The render still needs validation.",
        explicit: true,
        idempotencyKey: "narrative:correction:event",
      });
      runtime.completeTurn({
        turnId: corrected.turnId,
        response: "GammaWidget rendering validation remains pending.",
        idempotencyKey: "narrative:correction:complete",
        evidenceRefs: [],
      });

      const episodes = store.listEpisodes(scope("narrative-session"), undefined, 20);
      expect(episodes).toHaveLength(3);
      expect(episodes.find((episode) => episode.turnIds?.includes(first.turnId))).toMatchObject({
        turnIds: [first.turnId, second.turnId],
      });
      expect(episodes.find((episode) => episode.turnIds?.includes(topicShift.turnId))).toMatchObject({
        turnIds: [topicShift.turnId],
        boundaryReason: "topic_shift",
      });
      expect(episodes.find((episode) => episode.turnIds?.includes(corrected.turnId))).toMatchObject({
        turnIds: [corrected.turnId],
        boundaryReason: "correction",
      });
      for (const episode of episodes) {
        expect(episode.eventRefs.length).toBe((episode.turnIds?.length ?? 0) * 2);
      }
    } finally {
      store.close();
    }
  });

  it("builds a gated, budgeted re-experience workset from raw turns, episodes, key/emotion events, and fact constraints", async () => {
    const { store, runtime } = setup();
    try {
      const factTurn = await complete(
        runtime,
        "Record the launch configuration",
        "workset:fact-turn",
        "workset-history",
        "The launch configuration entry is ready.",
      );
      runtime.submitCorrection({
        turnId: factTurn.turnId,
        kind: "fact",
        correction: "Launch channel is canary.",
        subject: "launch",
        predicate: "channel",
        value: "canary",
        scopeLevel: "workspace",
        explicit: true,
        idempotencyKey: "workset:fact",
      });
      const correctionTurn = await complete(
        runtime,
        "Review the evidence handling behavior",
        "workset:correction-turn",
        "workset-history",
        "The evidence handling behavior was reviewed.",
      );
      const correction = runtime.submitCorrection({
        turnId: correctionTurn.turnId,
        kind: "behavior",
        wrongStatement: "Use a remembered answer without checking it.",
        correction: "Verify the current evidence before relying on memory.",
        explicit: false,
        idempotencyKey: "workset:correction",
      }) as { correctionId: string };
      await complete(
        runtime,
        "I am worried about the BuildRunner validation failure",
        "workset:emotion-turn",
        "workset-history",
        "BuildRunner validation is still being investigated.",
      );
      const keyEvent = runtime.recordEvent({
        input: {
          eventId: "workset-key-event",
          idempotencyKey: "workset:key",
          kind: "tool_result",
          content: "BuildRunner tests passed with current source evidence.",
        },
        scope: scope("workset-history"),
        agentProfile: agent,
        selectedEvidence: true,
      });
      const emotionalEvent = runtime.recordEvent({
        input: {
          eventId: "workset-emotion-event",
          idempotencyKey: "workset:emotion",
          kind: "user_message",
          content: "I am frustrated and worried about the deployment.",
        },
        scope: scope("workset-history"),
        agentProfile: agent,
      });

      const gated = await runtime.beginTurn({
        ...beginInput("这张截图发生了什么？", "workset:gated", "workset-reader"),
        input: {
          idempotencyKey: "workset:gated",
          kind: "user_message",
          content: "这张截图发生了什么？",
          attachments: [{ uri: "frame.png", mediaType: "image/png" }],
        },
      });
      expect(gated.gate.required).toBe(true);
      expect(() => runtime.buildWorkset({
        turnId: gated.turnId,
        query: "BuildRunner launch",
        budgetTokens: 8_000,
        recentTurns: 20,
      })).toThrowError(ProtocolError);

      runtime.checkpointEvidence({
        turnId: gated.turnId,
        observations: [{ kind: "image", content: "The screenshot visibly contains a BuildRunner result." }],
      });
      const bundle = runtime.buildWorkset({
        turnId: gated.turnId,
        query: "BuildRunner launch",
        budgetTokens: 8_000,
        recentTurns: 20,
      });
      const pack = bundle.reexperiencePack;
      expect(pack).toBeDefined();
      expect(pack?.recentEvents.map((event) => event.content)).toEqual(expect.arrayContaining([
        "Record the launch configuration",
        "The launch configuration entry is ready.",
        "I am worried about the BuildRunner validation failure",
      ]));
      expect(pack?.historicalEpisodes.length).toBeGreaterThan(0);
      expect(pack?.keyEvents.map((event) => event.eventId)).toContain(keyEvent.eventId);
      expect(pack?.emotionalEvents.map((event) => event.eventId)).toContain(emotionalEvent.eventId);
      expect(pack?.corrections).toEqual([
        expect.objectContaining({
          correctionId: correction.correctionId,
          correction: "Verify the current evidence before relying on memory.",
        }),
      ]);
      expect(pack?.correctionSourceRefs).toEqual(pack?.corrections.map((item) => item.source));
      expect(pack?.factConstraints).toEqual([
        expect.objectContaining({ subject: "launch", predicate: "channel", value: "canary" }),
      ]);
      expect(pack?.window).toMatchObject({ requestedTurns: 20, includedTurns: 3 });

      const allPackEvents = [
        ...(pack?.recentEvents ?? []),
        ...(pack?.historicalEvents ?? []),
        ...(pack?.keyEvents ?? []),
        ...(pack?.emotionalEvents ?? []),
      ];
      const estimatedTokens = allPackEvents.reduce((sum, event) => sum + Math.max(1, Math.ceil(event.content.length / 4)), 0);
      expect(estimatedTokens).toBeLessThanOrEqual(8_000);
      for (const ref of bundle.sourceRefs) {
        expect(ref).toEqual(expect.objectContaining({
          eventId: expect.any(String),
          sessionId: expect.any(String),
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          capturedAt: expect.any(String),
        }));
      }
      expect(runtime.getSources(gated.turnId, [store.toSourceRef(keyEvent)])[0]?.content).toContain("tests passed");
    } finally {
      store.close();
    }
  });

  it("applies an active calibration pattern only to its matching feature condition and Agent profile", async () => {
    const { store, runtime } = setup();
    try {
      store.putCalibrationPattern({
        patternId: "claude-image-calibration",
        agentProfileKey: "claude:1:integration-model:integration-tools",
        status: "active",
        riskCode: "unsupported_inference",
        pattern: {
          condition: {
            version: 1,
            all: [{ feature: "hasImage", operator: "equals", value: true }],
          },
        },
        metrics: { probability: 0.94 },
      });

      const matched = await runtime.beginTurn({
        ...beginInput("Process the attached artifact", "calibration:matched", "calibration-matched"),
        input: {
          idempotencyKey: "calibration:matched",
          kind: "user_message",
          content: "Process the attached artifact",
          attachments: [{ uri: "artifact.png", mediaType: "image/png" }],
        },
      });
      const conditionMiss = await runtime.beginTurn(
        beginInput("Process the attached artifact", "calibration:miss", "calibration-miss"),
      );
      const profileMiss = await runtime.beginTurn({
        ...beginInput("Process the attached artifact", "calibration:profile", "calibration-profile"),
        input: {
          idempotencyKey: "calibration:profile",
          kind: "user_message",
          content: "Process the attached artifact",
          attachments: [{ uri: "artifact.png", mediaType: "image/png" }],
        },
        agentProfile: { ...agent, family: "codex" },
      });

      const matchedRisk = matched.risks.find((risk) => risk.code === "unsupported_inference");
      expect(matchedRisk?.probability).toBe(0.94);
      expect(matchedRisk?.contributions).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "calibration", score: 0.94 }),
      ]));
      expect(conditionMiss.risks.find((risk) => risk.code === "unsupported_inference")?.contributions ?? [])
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ source: "calibration" })]));
      expect(profileMiss.risks.find((risk) => risk.code === "unsupported_inference")?.contributions ?? [])
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ source: "calibration" })]));
    } finally {
      store.close();
    }
  });
});
