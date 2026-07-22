import { createHash } from "node:crypto";
import type {
  EpisodeMemory,
  RiskCode,
  RiskScore,
  SourceEvent,
  SourceRef,
} from "../contracts.js";
import { extractFeatures, type TaskFeatures } from "./features.js";

const DEFAULT_GAP_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_SIMILARITY_THRESHOLD = 0.35;
const DEFAULT_TOPIC_TERM_LIMIT = 24;

const TASK_TYPES: readonly TaskFeatures["taskType"][] = [
  "coding",
  "visual",
  "recall",
  "conversation",
];

const RISK_CODES: readonly RiskCode[] = [
  "entity_or_symbol_merge",
  "stale_source",
  "wrong_workspace",
  "cross_session_merge",
  "unsupported_inference",
  "narrative_completion",
  "destructive_action",
  "secret_exposure",
];

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
  "have", "i", "in", "is", "it", "of", "on", "or", "that", "the", "this",
  "to", "was", "we", "were", "what", "with", "you", "your",
  "一个", "一下", "了", "什么", "我们", "我", "是", "的", "这个", "这", "那个", "那",
]);

const DECISION_CUE = /\b(?:agree(?:d)?|choose|chose|decid(?:e|ed)|decision|prefer|selected?|will use)\b|决定|选择|采用|同意|方案确定/i;
const FAILURE_CUE = /\b(?:bug|broken|crash(?:ed)?|error|fail(?:ed|ure)?|regression|test failed)\b|失败|错误|报错|崩溃|回归|未通过/i;
const MILESTONE_CUE = /\b(?:complete(?:d)?|done|landed|milestone|pass(?:ed)?|release(?:d)?|ship(?:ped)?)\b|完成|里程碑|通过|发布|上线|交付/i;

const EMOTION_CUES: ReadonlyArray<readonly [string, RegExp]> = [
  ["frustration", /\b(?:annoy(?:ed|ing)|frustrat(?:ed|ing)|stuck)\b|烦|挫败|卡住/i],
  ["anger", /\b(?:angry|furious|mad)\b|生气|愤怒|火大/i],
  ["concern", /\b(?:anxious|concerned|nervous|worried)\b|担心|焦虑|紧张/i],
  ["relief", /\b(?:glad|relieved|thankfully)\b|放心|松了口气|终于/i],
  ["excitement", /\b(?:awesome|excited|great|thrilled)\b|兴奋|太好了|激动/i],
  ["sadness", /\b(?:disappointed|sad|upset)\b|难过|失望|沮丧/i],
];

export type NarrativeTaskType = TaskFeatures["taskType"];

export interface CompletedNarrativeTurn {
  turnId: string;
  inputEvent: SourceEvent;
  responseEvent: SourceEvent;
  features: TaskFeatures;
  riskCodes: RiskCode[];
  correction: boolean;
  explicitBoundary: boolean;
  sessionEnded: boolean;
}

export type NarrativeBoundaryReason =
  | "initial"
  | "continuation"
  | "idempotent_replay"
  | "previous_closed"
  | "new_session"
  | "time_gap"
  | "task_type_shift"
  | "correction"
  | "entity_topic_shift"
  | "size_limit"
  | "explicit";

export type NarrativeCloseReason = "session_end" | "explicit" | "boundary" | "rebuild_end";

export interface NarrativeBoundaryDecision {
  action: "start" | "merge" | "close_and_start";
  reason: NarrativeBoundaryReason;
  /** The coarser value stored by the public EpisodeMemory contract. */
  episodeBoundaryReason?: EpisodeMemory["boundaryReason"];
  closeAfterCurrent: boolean;
  similarity: number;
  sharedEntities: string[];
  priorTurnCount: number;
}

/**
 * Derived narrative index. SourceEvent remains authoritative; every field here
 * can be rebuilt from the refs, completed-turn trace and deterministic rules.
 */
export interface NarrativeEpisode extends EpisodeMemory {
  turnIds: string[];
  topicKey: string;
  firstTurnId: string;
  lastTurnId: string;
  firstEventId: string;
  lastEventId: string;
  taskType: NarrativeTaskType;
  topicTerms: string[];
  entityKeys: string[];
  riskCodes: RiskCode[];
  turnCount: number;
  closed: boolean;
  closedReason?: NarrativeCloseReason;
}

export interface NarrativePartitionResult {
  decision: NarrativeBoundaryDecision;
  episode: NarrativeEpisode;
  /** Present when callers should persist/finalize the preceding chunk first. */
  closedPrevious?: NarrativeEpisode;
}

export interface NarrativeOptions {
  gapMs?: number;
  maxTurns?: number;
  similarityThreshold?: number;
  topicTermLimit?: number;
}

export interface RebuildNarrativeTurnInput {
  inputEvent: SourceEvent;
  responseEvent: SourceEvent;
  /** Direct turn id wins over ids found in traces. */
  turnId?: string;
  /** Accepts StoredTrace.trace values or StoredTrace-shaped wrapper objects. */
  traces?: readonly Readonly<Record<string, unknown>>[];
  correction?: boolean;
  explicitBoundary?: boolean;
  sessionEnded?: boolean;
}

export interface RebuildNarrativeEpisodesOptions extends NarrativeOptions {
  /** Marks the final rebuilt chunk closed without changing its source range. */
  closeFinal?: boolean;
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizedOptions(options: NarrativeOptions): Required<NarrativeOptions> {
  return {
    gapMs: boundedPositive(options.gapMs, DEFAULT_GAP_MS),
    maxTurns: Math.max(1, Math.floor(boundedPositive(options.maxTurns, DEFAULT_MAX_TURNS))),
    similarityThreshold: Math.max(
      0,
      Math.min(1, options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD),
    ),
    topicTermLimit: Math.max(
      1,
      Math.floor(boundedPositive(options.topicTermLimit, DEFAULT_TOPIC_TERM_LIMIT)),
    ),
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${sha256(parts.join("\u001f")).slice(0, 32)}`;
}

function milliseconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventTime(event: SourceEvent): number {
  return milliseconds(event.occurredAt) || milliseconds(event.capturedAt);
}

function sourceRefTime(ref: SourceRef): number {
  return milliseconds(ref.capturedAt);
}

export function sourceRefFromNarrativeEvent(event: SourceEvent): SourceRef {
  if (event.scope.sessionId === undefined || event.scope.sessionId.length === 0) {
    throw new Error(`Narrative SourceEvent ${event.eventId} requires a sessionId`);
  }
  const ref: SourceRef = {
    eventId: event.eventId,
    sessionId: event.scope.sessionId,
    contentHash: event.contentHash,
    capturedAt: event.capturedAt,
  };
  if (event.scope.workspaceId !== undefined) ref.workspaceId = event.scope.workspaceId;
  if (event.scope.commit !== undefined) ref.commit = event.scope.commit;
  if (typeof event.metadata.path === "string") ref.path = event.metadata.path;
  return ref;
}

function compareRefs(left: SourceRef, right: SourceRef): number {
  return (
    sourceRefTime(left) - sourceRefTime(right) ||
    left.eventId.localeCompare(right.eventId) ||
    left.contentHash.localeCompare(right.contentHash)
  );
}

export function chronologicalSourceRefs(refs: readonly SourceRef[]): SourceRef[] {
  const byIdentity = new Map<string, SourceRef>();
  for (const ref of refs) byIdentity.set(`${ref.eventId}\u001f${ref.contentHash}`, ref);
  return [...byIdentity.values()].sort(compareRefs);
}

function latinAndCjkTerms(content: string): string[] {
  const normalized = content.normalize("NFKC").toLowerCase();
  const latin = normalized.match(/[\p{L}\p{N}_./-]{2,}/gu) ?? [];
  const terms: string[] = [];
  for (const token of latin) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      const characters = [...token];
      if (characters.length === 1) terms.push(token);
      else {
        for (let index = 0; index < characters.length - 1; index += 1) {
          terms.push(`${characters[index]}${characters[index + 1]}`);
        }
      }
    } else {
      terms.push(token.replace(/^\W+|\W+$/g, ""));
    }
  }
  return uniqueSorted(terms.filter((term) => term.length > 0 && !STOP_WORDS.has(term)));
}

export function narrativeTextSimilarity(left: string, right: string): number {
  const leftTerms = new Set(latinAndCjkTerms(left));
  const rightTerms = new Set(latinAndCjkTerms(right));
  if (leftTerms.size === 0 || rightTerms.size === 0) return 0;
  let shared = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) shared += 1;
  return shared / (leftTerms.size + rightTerms.size - shared);
}

function metadataEntities(event: SourceEvent): string[] {
  const values = event.metadata.entities;
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.normalize("NFKC").trim().toLowerCase())
    .filter((value) => value.length > 0);
}

export function narrativeEntityKeys(...events: readonly SourceEvent[]): string[] {
  const found: string[] = [];
  for (const event of events) {
    found.push(...metadataEntities(event));
    const content = event.content.normalize("NFKC");
    const candidates = [
      ...(content.match(/\b[A-Z][A-Za-z0-9]*(?:[A-Z_][A-Za-z0-9_]*)+\b/g) ?? []),
      ...(content.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/g) ?? []),
      ...(content.match(/["'“”‘’`]([^"'“”‘’`\n]{2,64})["'“”‘’`]/g) ?? []),
      ...(content.match(/(?:^|\s)(?:[./][\w.-]+){2,}/g) ?? []),
    ];
    for (const candidate of candidates) {
      const key = candidate
        .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, "")
        .toLowerCase();
      if (key.length > 1 && !STOP_WORDS.has(key)) found.push(key);
    }
  }
  return uniqueSorted(found);
}

function cueTags(input: SourceEvent, response: SourceEvent): {
  tags: string[];
  emotions: string[];
} {
  const text = `${input.content}\n${response.content}`;
  const tags: string[] = [];
  if (DECISION_CUE.test(text)) tags.push("decision");
  if (FAILURE_CUE.test(text)) tags.push("failure");
  if (MILESTONE_CUE.test(text)) tags.push("milestone");
  const emotions = EMOTION_CUES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  if (emotions.length > 0) tags.push("emotion-cue");
  return { tags, emotions };
}

function normalizedRiskCodes(
  risks: readonly (RiskCode | Pick<RiskScore, "code">)[] | undefined,
): RiskCode[] {
  if (risks === undefined) return [];
  return uniqueSorted(
    risks
      .map((risk) => (typeof risk === "string" ? risk : risk.code))
      .filter((risk): risk is RiskCode => RISK_CODES.includes(risk as RiskCode)),
  ) as RiskCode[];
}

function assertCompletedTurn(turn: CompletedNarrativeTurn): void {
  const input = turn.inputEvent;
  const response = turn.responseEvent;
  if (input.scope.userId !== response.scope.userId) {
    throw new Error(`Turn ${turn.turnId} crosses users`);
  }
  if (input.scope.workspaceId !== response.scope.workspaceId) {
    throw new Error(`Turn ${turn.turnId} crosses workspaces`);
  }
  if (input.scope.sessionId !== response.scope.sessionId) {
    throw new Error(`Turn ${turn.turnId} crosses sessions`);
  }
}

function turnText(turn: CompletedNarrativeTurn): string {
  return `${turn.inputEvent.content}\n${turn.responseEvent.content}`;
}

function previousTopicText(previous: NarrativeEpisode): string {
  return previous.topicTerms.join(" ");
}

function previousSessionId(previous: NarrativeEpisode): string | undefined {
  return previous.eventRefs.at(-1)?.sessionId ?? previous.scope.sessionId;
}

function episodeTurnCount(previous: NarrativeEpisode): number {
  return Math.max(previous.turnCount, previous.turnIds.length, 1);
}

function mappedBoundaryReason(
  reason: NarrativeBoundaryReason,
): EpisodeMemory["boundaryReason"] | undefined {
  switch (reason) {
    case "new_session":
      return "new_session";
    case "time_gap":
      return "time_gap";
    case "task_type_shift":
    case "entity_topic_shift":
      return "topic_shift";
    case "correction":
      return "correction";
    case "size_limit":
      return "size_limit";
    case "explicit":
    case "previous_closed":
      return "explicit";
    default:
      return undefined;
  }
}

export function decideNarrativeBoundary(
  previous: NarrativeEpisode | undefined,
  current: CompletedNarrativeTurn,
  options: NarrativeOptions = {},
): NarrativeBoundaryDecision {
  assertCompletedTurn(current);
  const settings = normalizedOptions(options);
  const currentEntities = narrativeEntityKeys(current.inputEvent, current.responseEvent);
  const currentText = turnText(current);
  const similarity = previous === undefined
    ? 0
    : narrativeTextSimilarity(previousTopicText(previous), currentText);
  const previousEntities = previous?.entityKeys ?? [];
  const sharedEntities = uniqueSorted(
    currentEntities.filter((entity) => previousEntities.includes(entity)),
  );
  const priorTurnCount = previous === undefined ? 0 : episodeTurnCount(previous);
  const closeAfterCurrent = current.sessionEnded;

  const result = (
    action: NarrativeBoundaryDecision["action"],
    reason: NarrativeBoundaryReason,
  ): NarrativeBoundaryDecision => {
    const episodeBoundaryReason = mappedBoundaryReason(reason);
    return {
      action,
      reason,
      ...(episodeBoundaryReason === undefined ? {} : { episodeBoundaryReason }),
      closeAfterCurrent,
      similarity,
      sharedEntities,
      priorTurnCount,
    };
  };

  if (previous === undefined) return result("start", "initial");
  if (previous.turnIds.includes(current.turnId)) return result("merge", "idempotent_replay");
  if (previous.closed) return result("start", "previous_closed");
  if (current.explicitBoundary) return result("close_and_start", "explicit");
  if (current.correction) return result("close_and_start", "correction");
  if (previousSessionId(previous) !== current.inputEvent.scope.sessionId) {
    return result("close_and_start", "new_session");
  }
  const gap = Math.max(0, eventTime(current.inputEvent) - milliseconds(previous.endedAt));
  if (gap >= settings.gapMs) return result("close_and_start", "time_gap");
  if (previous.taskType !== current.features.taskType) {
    return result("close_and_start", "task_type_shift");
  }
  if (priorTurnCount >= settings.maxTurns) {
    return result("close_and_start", "size_limit");
  }
  if (
    previousEntities.length > 0 &&
    currentEntities.length > 0 &&
    sharedEntities.length === 0 &&
    similarity < settings.similarityThreshold
  ) {
    return result("close_and_start", "entity_topic_shift");
  }
  return result("merge", "continuation");
}

function topicTermsForTurn(turn: CompletedNarrativeTurn, limit: number): string[] {
  return latinAndCjkTerms(turnText(turn)).slice(0, limit);
}

function topicKeyForTurn(turn: CompletedNarrativeTurn, terms: readonly string[]): string {
  const entities = narrativeEntityKeys(turn.inputEvent, turn.responseEvent);
  const material = entities.length > 0 ? entities : terms.slice(0, 8);
  return stableId("topic", turn.features.taskType, ...material, turn.turnId);
}

function locatorSummary(episode: {
  taskType: NarrativeTaskType;
  turnCount: number;
  eventRefs: readonly SourceRef[];
  startedAt: string;
  endedAt: string;
}): string {
  const first = episode.eventRefs[0]?.eventId ?? "unknown";
  const last = episode.eventRefs.at(-1)?.eventId ?? first;
  return `${episode.taskType} narrative index; ${episode.turnCount} completed turn(s); source range ${first}..${last}; ${episode.startedAt}..${episode.endedAt}`;
}

function newNarrativeEpisode(
  turn: CompletedNarrativeTurn,
  decision: NarrativeBoundaryDecision,
  options: NarrativeOptions,
): NarrativeEpisode {
  const settings = normalizedOptions(options);
  const refs = chronologicalSourceRefs([
    sourceRefFromNarrativeEvent(turn.inputEvent),
    sourceRefFromNarrativeEvent(turn.responseEvent),
  ]);
  const firstRef = refs[0];
  const lastRef = refs.at(-1);
  if (firstRef === undefined || lastRef === undefined) throw new Error("Completed turn has no sources");
  const terms = topicTermsForTurn(turn, settings.topicTermLimit);
  const topicKey = topicKeyForTurn(turn, terms);
  const cues = cueTags(turn.inputEvent, turn.responseEvent);
  const riskCodes = normalizedRiskCodes(turn.riskCodes);
  const tags = uniqueSorted([
    `task:${turn.features.taskType}`,
    ...cues.tags,
    ...riskCodes.map((risk) => `risk:${risk}`),
  ]);
  const episodeId = stableId(
    "episode",
    turn.inputEvent.scope.userId,
    turn.inputEvent.scope.workspaceId ?? "",
    turn.turnId,
    firstRef.eventId,
  );
  const startedAt = firstRef.capturedAt;
  const endedAt = lastRef.capturedAt;
  const closed = decision.closeAfterCurrent;
  const base = {
    episodeId,
    scope: turn.inputEvent.scope,
    title: `${turn.features.taskType} thread ${topicKey.slice(-8)}`,
    eventRefs: refs,
    participants: ["user", "assistant"],
    tags,
    startedAt,
    endedAt,
    turnIds: [turn.turnId],
    topicKey,
    firstTurnId: turn.turnId,
    lastTurnId: turn.turnId,
    firstEventId: firstRef.eventId,
    lastEventId: lastRef.eventId,
    taskType: turn.features.taskType,
    topicTerms: terms,
    entityKeys: narrativeEntityKeys(turn.inputEvent, turn.responseEvent),
    riskCodes,
    turnCount: 1,
    closed,
    ...(decision.episodeBoundaryReason === undefined
      ? {}
      : { boundaryReason: decision.episodeBoundaryReason }),
    ...(closed ? { closedReason: "session_end" as const } : {}),
    ...(cues.emotions.length === 0 ? {} : { emotionTags: uniqueSorted(cues.emotions) }),
  } satisfies Omit<NarrativeEpisode, "summary">;
  return { ...base, summary: locatorSummary(base) };
}

function mergeNarrativeEpisode(
  previous: NarrativeEpisode,
  turn: CompletedNarrativeTurn,
  decision: NarrativeBoundaryDecision,
  options: NarrativeOptions,
): NarrativeEpisode {
  const settings = normalizedOptions(options);
  const refs = chronologicalSourceRefs([
    ...previous.eventRefs,
    sourceRefFromNarrativeEvent(turn.inputEvent),
    sourceRefFromNarrativeEvent(turn.responseEvent),
  ]);
  const firstRef = refs[0];
  const lastRef = refs.at(-1);
  if (firstRef === undefined || lastRef === undefined) throw new Error("Narrative episode has no sources");
  const turnIds = previous.turnIds.includes(turn.turnId)
    ? [...previous.turnIds]
    : [...previous.turnIds, turn.turnId];
  const cues = cueTags(turn.inputEvent, turn.responseEvent);
  const riskCodes = normalizedRiskCodes([...previous.riskCodes, ...turn.riskCodes]);
  const closed = previous.closed || decision.closeAfterCurrent;
  const merged = {
    ...previous,
    eventRefs: refs,
    tags: uniqueSorted([
      ...previous.tags,
      ...cues.tags,
      ...riskCodes.map((risk) => `risk:${risk}`),
    ]),
    startedAt: refs[0]?.capturedAt ?? previous.startedAt,
    endedAt: lastRef.capturedAt,
    turnIds,
    lastTurnId: turnIds.at(-1) ?? previous.lastTurnId,
    firstEventId: firstRef.eventId,
    lastEventId: lastRef.eventId,
    topicTerms: uniqueSorted([
      ...previous.topicTerms,
      ...topicTermsForTurn(turn, settings.topicTermLimit),
    ]).slice(0, settings.topicTermLimit),
    entityKeys: uniqueSorted([
      ...previous.entityKeys,
      ...narrativeEntityKeys(turn.inputEvent, turn.responseEvent),
    ]),
    riskCodes,
    turnCount: turnIds.length,
    closed,
    ...(closed ? { closedReason: "session_end" as const } : {}),
    ...(uniqueSorted([...(previous.emotionTags ?? []), ...cues.emotions]).length === 0
      ? {}
      : { emotionTags: uniqueSorted([...(previous.emotionTags ?? []), ...cues.emotions]) }),
  } satisfies NarrativeEpisode;
  return { ...merged, summary: locatorSummary(merged) };
}

export function partitionNarrativeTurn(
  previous: NarrativeEpisode | undefined,
  current: CompletedNarrativeTurn,
  options: NarrativeOptions = {},
): NarrativePartitionResult {
  const decision = decideNarrativeBoundary(previous, current, options);
  if (previous !== undefined && decision.action === "merge") {
    return { decision, episode: mergeNarrativeEpisode(previous, current, decision, options) };
  }
  const episode = newNarrativeEpisode(current, decision, options);
  if (previous === undefined || decision.action === "start") return { decision, episode };
  return {
    decision,
    episode,
    closedPrevious: {
      ...previous,
      closed: true,
      closedReason: decision.reason === "explicit" ? "explicit" : "boundary",
    },
  };
}

function unwrapTrace(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const nested = value.trace;
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return {
      ...(nested as Readonly<Record<string, unknown>>),
      ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
    };
  }
  return value;
}

function traceKind(trace: Readonly<Record<string, unknown>>): string {
  return typeof trace.kind === "string" ? trace.kind : "";
}

function traceBoolean(
  traces: readonly Readonly<Record<string, unknown>>[],
  names: readonly string[],
): boolean {
  return traces.some((trace) => names.some((name) => trace[name] === true));
}

function isTaskType(value: unknown): value is NarrativeTaskType {
  return typeof value === "string" && TASK_TYPES.includes(value as NarrativeTaskType);
}

function taskFeaturesFromTrace(
  fallback: TaskFeatures,
  traces: readonly Readonly<Record<string, unknown>>[],
): TaskFeatures {
  const value = traces.find((trace) => trace.features !== undefined)?.features;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fallback;
  const features = value as Readonly<Record<string, unknown>>;
  if (!isTaskType(features.taskType)) return fallback;
  return {
    ...fallback,
    taskType: features.taskType,
    ...(typeof features.userIntent === "string" ? { userIntent: features.userIntent } : {}),
    ...(typeof features.hasImage === "boolean" ? { hasImage: features.hasImage } : {}),
    ...(typeof features.hasCurrentEvidence === "boolean"
      ? { hasCurrentEvidence: features.hasCurrentEvidence }
      : {}),
    ...(typeof features.asksForVisibleDetail === "boolean"
      ? { asksForVisibleDetail: features.asksForVisibleDetail }
      : {}),
    ...(typeof features.asksToRecall === "boolean" ? { asksToRecall: features.asksToRecall } : {}),
    ...(typeof features.asksForIdentity === "boolean"
      ? { asksForIdentity: features.asksForIdentity }
      : {}),
    ...(typeof features.multipleEntities === "boolean"
      ? { multipleEntities: features.multipleEntities }
      : {}),
    ...(typeof features.destructiveIntent === "boolean"
      ? { destructiveIntent: features.destructiveIntent }
      : {}),
    ...(typeof features.containsSecretMaterial === "boolean"
      ? { containsSecretMaterial: features.containsSecretMaterial }
      : {}),
    ...(typeof features.mentionsOtherWorkspace === "boolean"
      ? { mentionsOtherWorkspace: features.mentionsOtherWorkspace }
      : {}),
    ...(typeof features.likelyStaleReference === "boolean"
      ? { likelyStaleReference: features.likelyStaleReference }
      : {}),
    ...(typeof features.narrativeCue === "boolean"
      ? { narrativeCue: features.narrativeCue }
      : {}),
    ...(features.contextAge === "short" || features.contextAge === "long" || features.contextAge === "unknown"
      ? { contextAge: features.contextAge }
      : {}),
    ...(typeof features.entitiesCount === "number" && Number.isFinite(features.entitiesCount)
      ? { entitiesCount: Math.max(0, Math.floor(features.entitiesCount)) }
      : {}),
    ...(typeof features.agentFamily === "string" ? { agentFamily: features.agentFamily } : {}),
    ...(typeof features.agentVersion === "string" ? { agentVersion: features.agentVersion } : {}),
    ...(typeof features.toolsetDigest === "string" ? { toolsetDigest: features.toolsetDigest } : {}),
    ...(typeof features.workspacePresent === "boolean"
      ? { workspacePresent: features.workspacePresent }
      : {}),
  };
}

function risksFromTraces(traces: readonly Readonly<Record<string, unknown>>[]): RiskCode[] {
  const value = traces.find((trace) => Array.isArray(trace.risks))?.risks;
  if (!Array.isArray(value)) return [];
  return normalizedRiskCodes(
    value.filter((item): item is RiskCode | Pick<RiskScore, "code"> => {
      if (typeof item === "string") return RISK_CODES.includes(item as RiskCode);
      return item !== null && typeof item === "object" && typeof (item as { code?: unknown }).code === "string";
    }),
  );
}

function turnIdFromTraces(traces: readonly Readonly<Record<string, unknown>>[]): string | undefined {
  for (const trace of traces) {
    if (typeof trace.turnId === "string") return trace.turnId;
    const result = trace.result;
    if (result !== null && typeof result === "object" && !Array.isArray(result)) {
      const resultTurnId = (result as { turnId?: unknown }).turnId;
      if (typeof resultTurnId === "string") return resultTurnId;
    }
  }
  return undefined;
}

/** Recreates the deterministic turn input used by the narrative chunker. */
export function rebuildCompletedNarrativeTurn(
  input: RebuildNarrativeTurnInput,
): CompletedNarrativeTurn {
  const traces = (input.traces ?? []).map(unwrapTrace);
  const fallbackFeatures = extractFeatures(
    {
      eventId: input.inputEvent.eventId,
      idempotencyKey: `rebuild:${input.inputEvent.eventId}`,
      kind: input.inputEvent.kind,
      content: input.inputEvent.content,
      occurredAt: input.inputEvent.occurredAt,
      attachments: input.inputEvent.attachments,
      metadata: input.inputEvent.metadata,
    },
    input.inputEvent.scope,
    input.inputEvent.agent,
  );
  const correctionTrace = traces.some((trace) => traceKind(trace) === "correction");
  const explicitFromMetadata =
    input.inputEvent.metadata.narrativeBoundary === true ||
    input.responseEvent.metadata.narrativeBoundary === true;
  const sessionEndTrace = traces.some((trace) =>
    ["session_end", "session-end", "session_ended"].includes(traceKind(trace)),
  );
  const turnId = input.turnId ?? turnIdFromTraces(traces) ??
    stableId("turn", input.inputEvent.eventId, input.responseEvent.eventId);
  return {
    turnId,
    inputEvent: input.inputEvent,
    responseEvent: input.responseEvent,
    features: taskFeaturesFromTrace(fallbackFeatures, traces),
    riskCodes: risksFromTraces(traces),
    correction: input.correction ?? correctionTrace,
    explicitBoundary: input.explicitBoundary ??
      (explicitFromMetadata || traceBoolean(traces, ["explicitBoundary", "narrativeBoundary"])),
    sessionEnded: input.sessionEnded ??
      (sessionEndTrace || traceBoolean(traces, ["sessionEnded"])),
  };
}

function completedTurnOrder(left: CompletedNarrativeTurn, right: CompletedNarrativeTurn): number {
  return (
    eventTime(left.inputEvent) - eventTime(right.inputEvent) ||
    left.turnId.localeCompare(right.turnId)
  );
}

/** Rebuilds all narrative chunks solely from authoritative events and turn traces. */
export function rebuildNarrativeEpisodes(
  turns: readonly CompletedNarrativeTurn[],
  options: RebuildNarrativeEpisodesOptions = {},
): NarrativeEpisode[] {
  const episodes: NarrativeEpisode[] = [];
  for (const turn of [...turns].sort(completedTurnOrder)) {
    const previous = episodes.at(-1);
    const result = partitionNarrativeTurn(previous, turn, options);
    if (previous !== undefined && result.decision.action === "merge") {
      episodes[episodes.length - 1] = result.episode;
    } else {
      episodes.push(result.episode);
    }
  }
  if (options.closeFinal === true && episodes.length > 0) {
    const final = episodes.at(-1);
    if (final !== undefined && !final.closed) {
      episodes[episodes.length - 1] = { ...final, closed: true, closedReason: "rebuild_end" };
    }
  }
  return episodes;
}
