import { describe, expect, it } from "vitest";
import type { AgentProfile, RiskScore, SourceEvent } from "../src/contracts.js";
import type { TaskFeatures } from "../src/core/features.js";
import {
  decideNarrativeBoundary,
  partitionNarrativeTurn,
  rebuildCompletedNarrativeTurn,
  rebuildNarrativeEpisodes,
  type CompletedNarrativeTurn,
  type NarrativeEpisode,
} from "../src/core/narrative.js";

const agent: AgentProfile = {
  family: "mock",
  version: "1",
  capabilities: { hooks: true, stageGates: true },
};

const BASE_TIME = Date.parse("2026-07-22T00:00:00.000Z");

function at(minutes: number): string {
  return new Date(BASE_TIME + minutes * 60_000).toISOString();
}

function event(
  eventId: string,
  content: string,
  minute: number,
  kind: "user_message" | "assistant_message",
  options: { sessionId?: string; entities?: string[]; boundary?: boolean } = {},
): SourceEvent {
  const capturedAt = at(minute);
  return {
    eventId,
    revision: minute + 1,
    deviceId: "device",
    scope: {
      userId: "user",
      workspaceId: "workspace",
      sessionId: options.sessionId ?? "session-a",
    },
    agent,
    kind,
    content,
    contentHash: `hash-${eventId}`,
    capturedAt,
    occurredAt: capturedAt,
    selectedEvidence: false,
    redactions: [],
    attachments: [],
    metadata: {
      ...(options.entities === undefined ? {} : { entities: options.entities }),
      ...(options.boundary === true ? { narrativeBoundary: true } : {}),
    },
  };
}

function taskFeatures(taskType: TaskFeatures["taskType"]): TaskFeatures {
  return {
    taskType,
    userIntent: "unspecified",
    hasImage: taskType === "visual",
    hasCurrentEvidence: false,
    asksForVisibleDetail: false,
    asksToRecall: taskType === "recall",
    asksForIdentity: false,
    multipleEntities: false,
    destructiveIntent: false,
    containsSecretMaterial: false,
    mentionsOtherWorkspace: false,
    likelyStaleReference: false,
    narrativeCue: false,
    contextAge: "short",
    entitiesCount: 1,
    agentFamily: "mock",
    agentVersion: "1",
    workspacePresent: true,
  };
}

function turn(
  turnId: string,
  minute: number,
  options: {
    input?: string;
    response?: string;
    entity?: string;
    taskType?: TaskFeatures["taskType"];
    sessionId?: string;
    correction?: boolean;
    explicitBoundary?: boolean;
    sessionEnded?: boolean;
  } = {},
): CompletedNarrativeTurn {
  const entity = options.entity ?? "AlphaService";
  const inputEvent = event(
    `${turnId}-input`,
    options.input ?? `Fix ${entity} authentication failure`,
    minute,
    "user_message",
    { sessionId: options.sessionId, entities: [entity] },
  );
  const responseEvent = event(
    `${turnId}-response`,
    options.response ?? `Updated ${entity} authentication tests`,
    minute + 1,
    "assistant_message",
    { sessionId: options.sessionId, entities: [entity] },
  );
  return {
    turnId,
    inputEvent,
    responseEvent,
    features: taskFeatures(options.taskType ?? "coding"),
    riskCodes: [],
    correction: options.correction ?? false,
    explicitBoundary: options.explicitBoundary ?? false,
    sessionEnded: options.sessionEnded ?? false,
  };
}

function initialEpisode(first = turn("turn-1", 0)): NarrativeEpisode {
  return partitionNarrativeTurn(undefined, first).episode;
}

describe("narrative episode partitioning", () => {
  it("merges related completed turns while keeping stable first ids and chronological refs", () => {
    const first = turn("turn-1", 0, {
      input: "AlphaService authentication failed",
      response: "I decided to use AlphaService token validation",
    });
    const started = partitionNarrativeTurn(undefined, first);
    const second = turn("turn-2", 10, {
      input: "Add AlphaService authentication coverage",
      response: "AlphaService tests passed and the milestone is complete",
    });
    const merged = partitionNarrativeTurn(started.episode, second);

    expect(started.decision).toMatchObject({ action: "start", reason: "initial" });
    expect(merged.decision).toMatchObject({ action: "merge" });
    expect(merged.episode.episodeId).toBe(started.episode.episodeId);
    expect(merged.episode.topicKey).toBe(started.episode.topicKey);
    expect(merged.episode.firstTurnId).toBe("turn-1");
    expect(merged.episode.lastTurnId).toBe("turn-2");
    expect(merged.episode.turnIds).toEqual(["turn-1", "turn-2"]);
    expect(merged.episode.eventRefs.map((ref) => ref.eventId)).toEqual([
      "turn-1-input",
      "turn-1-response",
      "turn-2-input",
      "turn-2-response",
    ]);
    expect(merged.episode.tags).toEqual(expect.arrayContaining([
      "decision",
      "failure",
      "milestone",
    ]));
    expect(merged.episode.summary).not.toContain("AlphaService");
    expect(merged.episode.summary).not.toContain("token validation");
  });

  it("uses every deterministic pre-turn boundary", () => {
    const previous = initialEpisode();
    const twelveTurns: NarrativeEpisode = {
      ...previous,
      turnIds: Array.from({ length: 12 }, (_, index) => `prior-${index}`),
      turnCount: 12,
    };

    expect(decideNarrativeBoundary(previous, turn("time", 31)).reason).toBe("time_gap");
    expect(decideNarrativeBoundary(previous, turn("visual", 5, {
      taskType: "visual",
    })).reason).toBe("task_type_shift");
    expect(decideNarrativeBoundary(previous, turn("correction", 5, {
      correction: true,
    })).reason).toBe("correction");
    expect(decideNarrativeBoundary(previous, turn("entity", 5, {
      entity: "GammaWidget",
      input: "GammaWidget paints an unrelated purple canvas",
      response: "GammaWidget rendering remains isolated",
    })).reason).toBe("entity_topic_shift");
    expect(decideNarrativeBoundary(twelveTurns, turn("limit", 5)).reason).toBe("size_limit");
    expect(decideNarrativeBoundary(previous, turn("session", 5, {
      sessionId: "session-b",
    })).reason).toBe("new_session");
    expect(decideNarrativeBoundary(previous, turn("explicit", 5, {
      explicitBoundary: true,
    })).reason).toBe("explicit");
  });

  it("returns a finalized previous chunk and closes the current chunk at session end", () => {
    const previous = initialEpisode();
    const boundary = partitionNarrativeTurn(previous, turn("new-topic", 5, {
      correction: true,
    }));
    expect(boundary.decision.action).toBe("close_and_start");
    expect(boundary.closedPrevious).toMatchObject({
      episodeId: previous.episodeId,
      closed: true,
      closedReason: "boundary",
    });
    expect(boundary.episode.boundaryReason).toBe("correction");

    const ended = partitionNarrativeTurn(previous, turn("last", 5, { sessionEnded: true }));
    expect(ended.decision.action).toBe("merge");
    expect(ended.episode).toMatchObject({ closed: true, closedReason: "session_end" });
  });

  it("tags only visible cue classes and never turns them into a factual summary", () => {
    const emotional = turn("emotion", 0, {
      input: "I am frustrated and worried about this bug",
      response: "The test failed",
      entity: "BuildRunner",
    });
    emotional.riskCodes = ["unsupported_inference"];
    const episode = partitionNarrativeTurn(undefined, emotional).episode;

    expect(episode.tags).toEqual(expect.arrayContaining([
      "emotion-cue",
      "failure",
      "risk:unsupported_inference",
    ]));
    expect(episode.emotionTags).toEqual(["concern", "frustration"]);
    expect(episode.summary).toMatch(/^coding narrative index;/);
    expect(episode.summary).not.toContain("worried");
    expect(episode.summary).not.toContain("failed");
  });
});

describe("narrative replay", () => {
  it("rebuilds completed turns from SourceEvents and StoredTrace-shaped records", () => {
    const inputEvent = event("input", "What happened in this image?", 0, "user_message");
    inputEvent.attachments = [{ uri: "frame.png", mediaType: "image/png" }];
    const responseEvent = event("response", "Only visible details were reported", 1, "assistant_message");
    const risk: RiskScore = {
      code: "narrative_completion",
      probability: 0.9,
      contributions: [],
    };
    const rebuilt = rebuildCompletedNarrativeTurn({
      inputEvent,
      responseEvent,
      traces: [
        {
          turnId: "trace-turn",
          trace: {
            kind: "begin_turn",
            features: taskFeatures("visual"),
            risks: [risk],
            explicitBoundary: true,
          },
        },
        { trace: { kind: "correction" } },
        { trace: { kind: "session_end" } },
      ],
    });

    expect(rebuilt).toMatchObject({
      turnId: "trace-turn",
      correction: true,
      explicitBoundary: true,
      sessionEnded: true,
      riskCodes: ["narrative_completion"],
      features: { taskType: "visual" },
    });
  });

  it("deterministically rebuilds multi-turn chunks independent of input order", () => {
    const first = turn("first", 0);
    const second = turn("second", 5, { sessionEnded: true });
    const later = turn("later", 45, { sessionId: "session-b" });

    const ordered = rebuildNarrativeEpisodes([first, second, later], { closeFinal: true });
    const shuffled = rebuildNarrativeEpisodes([later, second, first], { closeFinal: true });

    expect(shuffled).toEqual(ordered);
    expect(ordered).toHaveLength(2);
    expect(ordered[0]).toMatchObject({
      firstTurnId: "first",
      lastTurnId: "second",
      turnCount: 2,
      closed: true,
      closedReason: "session_end",
    });
    expect(ordered[1]).toMatchObject({
      firstTurnId: "later",
      lastTurnId: "later",
      boundaryReason: "explicit",
      closed: true,
      closedReason: "rebuild_end",
    });
  });
});
