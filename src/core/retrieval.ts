import type { RiskCode, RiskScore, SourceRef } from "../contracts.js";

export type RetrievalSignal = "bm25" | "embedding" | "entity" | "temporal" | "thread";

export type RetrievalStep =
  | "scope_filter"
  | "redaction_filter"
  | "policy"
  | "current_evidence"
  | "checkpoint"
  | "exact_match"
  | "bm25"
  | "embedding"
  | "timeline"
  | "entity_graph"
  | "thread"
  | "complete_episode"
  | "original_source"
  | "conflict_check";

export interface RetrievalStrategy {
  /** Stable identifier suitable for a pagination cursor or trace. */
  strategyId: string;
  riskCodes: RiskCode[];
  orderedSteps: RetrievalStep[];
  weights: Record<RetrievalSignal, number>;
  sourceCoverageWeight: number;
  minimumEvidenceCoverage: number;
  checkpointFirst: boolean;
  originalSourceRequired: boolean;
  sameWorkspaceOnly: boolean;
  allowEmbedding: boolean;
}

interface RiskStrategyTemplate {
  orderedSteps: readonly RetrievalStep[];
  weights: Readonly<Record<RetrievalSignal, number>>;
  sourceCoverageWeight: number;
  minimumEvidenceCoverage: number;
  originalSourceRequired?: boolean;
  sameWorkspaceOnly?: boolean;
  allowEmbedding?: boolean;
}

const BASE_TEMPLATE: RiskStrategyTemplate = {
  orderedSteps: ["scope_filter", "exact_match", "bm25", "embedding", "thread", "timeline", "entity_graph", "original_source"],
  weights: { bm25: 0.34, embedding: 0.24, entity: 0.15, temporal: 0.12, thread: 0.15 },
  sourceCoverageWeight: 0.2,
  minimumEvidenceCoverage: 0.5,
};

const RISK_TEMPLATES: Readonly<Record<RiskCode, RiskStrategyTemplate>> = {
  entity_or_symbol_merge: {
    orderedSteps: ["scope_filter", "exact_match", "timeline", "entity_graph", "thread", "bm25", "original_source", "conflict_check"],
    weights: { bm25: 0.25, embedding: 0.08, entity: 0.34, temporal: 0.18, thread: 0.15 },
    sourceCoverageWeight: 0.32,
    minimumEvidenceCoverage: 0.75,
    originalSourceRequired: true,
  },
  stale_source: {
    orderedSteps: ["scope_filter", "current_evidence", "checkpoint", "timeline", "thread", "exact_match", "bm25", "original_source"],
    weights: { bm25: 0.28, embedding: 0.06, entity: 0.07, temporal: 0.36, thread: 0.23 },
    sourceCoverageWeight: 0.34,
    minimumEvidenceCoverage: 0.8,
    originalSourceRequired: true,
  },
  wrong_workspace: {
    orderedSteps: ["scope_filter", "current_evidence", "exact_match", "thread", "bm25", "original_source", "conflict_check"],
    weights: { bm25: 0.36, embedding: 0.05, entity: 0.14, temporal: 0.08, thread: 0.37 },
    sourceCoverageWeight: 0.38,
    minimumEvidenceCoverage: 0.85,
    originalSourceRequired: true,
    sameWorkspaceOnly: true,
  },
  cross_session_merge: {
    orderedSteps: ["scope_filter", "exact_match", "thread", "timeline", "entity_graph", "complete_episode", "original_source", "conflict_check"],
    weights: { bm25: 0.22, embedding: 0.07, entity: 0.24, temporal: 0.2, thread: 0.27 },
    sourceCoverageWeight: 0.38,
    minimumEvidenceCoverage: 0.85,
    originalSourceRequired: true,
  },
  unsupported_inference: {
    orderedSteps: ["scope_filter", "current_evidence", "checkpoint", "exact_match", "original_source", "conflict_check"],
    weights: { bm25: 0.31, embedding: 0.04, entity: 0.09, temporal: 0.14, thread: 0.42 },
    sourceCoverageWeight: 0.5,
    minimumEvidenceCoverage: 0.9,
    originalSourceRequired: true,
  },
  narrative_completion: {
    orderedSteps: ["scope_filter", "current_evidence", "checkpoint", "complete_episode", "timeline", "thread", "original_source", "conflict_check"],
    weights: { bm25: 0.23, embedding: 0.06, entity: 0.12, temporal: 0.19, thread: 0.4 },
    sourceCoverageWeight: 0.5,
    minimumEvidenceCoverage: 0.9,
    originalSourceRequired: true,
  },
  destructive_action: {
    orderedSteps: ["scope_filter", "policy", "current_evidence", "exact_match", "original_source", "conflict_check"],
    weights: { bm25: 0.32, embedding: 0.04, entity: 0.08, temporal: 0.16, thread: 0.4 },
    sourceCoverageWeight: 0.48,
    minimumEvidenceCoverage: 0.9,
    originalSourceRequired: true,
  },
  secret_exposure: {
    orderedSteps: ["scope_filter", "redaction_filter", "policy", "current_evidence", "exact_match", "original_source"],
    weights: { bm25: 0.5, embedding: 0, entity: 0.08, temporal: 0.1, thread: 0.32 },
    sourceCoverageWeight: 0.45,
    minimumEvidenceCoverage: 1,
    originalSourceRequired: true,
    allowEmbedding: false,
  },
};

const GATED_RISKS = new Set<RiskCode>([
  "entity_or_symbol_merge",
  "stale_source",
  "wrong_workspace",
  "cross_session_merge",
  "unsupported_inference",
  "narrative_completion",
]);

const SIGNALS: readonly RetrievalSignal[] = ["bm25", "embedding", "entity", "temporal", "thread"];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Number(value.toFixed(12));
}

function riskTemplate(code: RiskCode): RiskStrategyTemplate {
  return RISK_TEMPLATES[code];
}

/** Returns the single-risk policy without mutating the shared template. */
export function retrievalStrategyForRisk(code: RiskCode): RetrievalStrategy {
  return buildDynamicRetrievalStrategy([{ code, probability: 1 }]);
}

/**
 * Blends all material risks (>= 0.4). The highest risk controls presentation
 * order; lower risks contribute missing steps and proportional signal weight.
 */
export function buildDynamicRetrievalStrategy(
  risks: readonly Pick<RiskScore, "code" | "probability">[],
): RetrievalStrategy {
  const active = risks
    .map((risk) => ({ code: risk.code, probability: clamp01(risk.probability) }))
    .filter((risk) => risk.probability >= 0.4)
    .sort((left, right) => right.probability - left.probability || left.code.localeCompare(right.code));
  const templates = active.length > 0
    ? active.map((risk) => ({ ...risk, template: riskTemplate(risk.code) }))
    : [{ code: undefined, probability: 1, template: BASE_TEMPLATE }];
  const denominator = templates.reduce((sum, item) => sum + item.probability, 0) || 1;
  const weights = Object.fromEntries(SIGNALS.map((signal) => [
    signal,
    rounded(templates.reduce((sum, item) => sum + item.template.weights[signal] * item.probability, 0) / denominator),
  ])) as Record<RetrievalSignal, number>;
  const orderedSteps = templates.flatMap((item) => item.template.orderedSteps)
    .filter((step, index, steps) => steps.indexOf(step) === index);
  const riskCodes = active.map((risk) => risk.code);
  const highRisks = templates.filter((risk) => risk.code !== undefined && risk.probability >= 0.7);
  const allowEmbedding = templates.every((item) => item.template.allowEmbedding !== false);

  if (!allowEmbedding) weights.embedding = 0;
  const enabledWeightTotal = SIGNALS.reduce((sum, signal) => sum + weights[signal], 0);
  if (enabledWeightTotal > 0) {
    for (const signal of SIGNALS) weights[signal] = rounded(weights[signal] / enabledWeightTotal);
  }

  return {
    strategyId: `retrieval-v1:${active.length > 0
      ? active.map((risk) => `${risk.code}@${risk.probability.toFixed(3)}`).join("+")
      : "default"}`,
    riskCodes,
    orderedSteps,
    weights,
    sourceCoverageWeight: rounded(Math.max(...templates.map((item) => item.template.sourceCoverageWeight))),
    minimumEvidenceCoverage: rounded(Math.max(...templates.map((item) => item.template.minimumEvidenceCoverage))),
    checkpointFirst: highRisks.some((risk) => risk.code !== undefined && GATED_RISKS.has(risk.code)),
    originalSourceRequired: highRisks.some((risk) => risk.template.originalSourceRequired === true),
    sameWorkspaceOnly: active.some((risk) => risk.code === "wrong_workspace" && risk.probability >= 0.4),
    allowEmbedding,
  };
}

export type RetrievalCandidateKind =
  | "source_event"
  | "world_claim"
  | "episode"
  | "policy"
  | "correction"
  | "memory_object";

export interface RetrievalCandidate<T = unknown> {
  id: string;
  kind: RetrievalCandidateKind;
  revision: number;
  /** FTS/BM25 relevance where larger is better (MemoryStore.SearchHit semantics). */
  bm25Score?: number;
  /** Optional provider-produced cosine similarity in [-1, 1]. */
  embeddingSimilarity?: number;
  /** Optional provider-produced vector; scored only when queryEmbedding is supplied. */
  embedding?: readonly number[];
  /** Zero is an exact entity match; larger graph distance is weaker. */
  entityDistance?: number;
  occurredAt?: string;
  /** Zero is the current thread; larger hop distance is weaker. */
  threadDistance?: number;
  sourceRefs: readonly SourceRef[];
  /** Number of independent source slots this candidate is expected to cover. */
  expectedSourceCount?: number;
  /** Evidence facets covered by this candidate, such as entity/name/time/current-file. */
  evidenceKeys?: readonly string[];
  value?: T;
}

export interface RankRetrievalOptions {
  strategy: RetrievalStrategy;
  queryTime?: string | number | Date;
  temporalHalfLifeMs?: number;
  queryEmbedding?: readonly number[];
  requiredEvidenceKeys?: readonly string[];
  snapshotRevision?: number;
}

export interface RankedRetrievalCandidate<T = unknown> extends RetrievalCandidate<T> {
  signalScores: Record<RetrievalSignal, number>;
  activeWeights: Record<RetrievalSignal, number>;
  retrievalScore: number;
  sourceCoverage: number;
  evidenceCoverage: number;
  coverageScore: number;
  finalScore: number;
  meetsEvidenceRequirement: boolean;
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number | undefined {
  if (left.length === 0 || left.length !== right.length) return undefined;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined || !Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      return undefined;
    }
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return undefined;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function parseTime(value: string | number | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function rawSignals<T>(
  candidate: RetrievalCandidate<T>,
  queryTime: number | undefined,
  halfLifeMs: number,
  queryEmbedding: readonly number[] | undefined,
): Partial<Record<RetrievalSignal, number>> {
  const embedding = finite(candidate.embeddingSimilarity)
    ? clamp01((candidate.embeddingSimilarity + 1) / 2)
    : queryEmbedding !== undefined && candidate.embedding !== undefined
      ? (() => {
          const similarity = cosineSimilarity(queryEmbedding, candidate.embedding);
          return similarity === undefined ? undefined : clamp01((similarity + 1) / 2);
        })()
      : undefined;
  const occurredAt = parseTime(candidate.occurredAt);
  return {
    ...(finite(candidate.bm25Score) ? { bm25: candidate.bm25Score } : {}),
    ...(embedding !== undefined ? { embedding } : {}),
    ...(finite(candidate.entityDistance) && candidate.entityDistance >= 0
      ? { entity: 1 / (1 + candidate.entityDistance) }
      : {}),
    ...(queryTime !== undefined && occurredAt !== undefined
      ? { temporal: Math.exp(-Math.abs(queryTime - occurredAt) / halfLifeMs) }
      : {}),
    ...(finite(candidate.threadDistance) && candidate.threadDistance >= 0
      ? { thread: 1 / (1 + candidate.threadDistance) }
      : {}),
  };
}

function minMax(values: readonly number[], value: number): number {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (minimum === maximum) return 1;
  return clamp01((value - minimum) / (maximum - minimum));
}

function uniqueStrings(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).filter((value) => value.length > 0));
}

function candidateCoverage<T>(
  candidate: RetrievalCandidate<T>,
  requiredEvidenceKeys: ReadonlySet<string>,
): { source: number; evidence: number; combined: number } {
  const distinctSources = new Set(candidate.sourceRefs.map((source) => source.eventId)).size;
  const expectedSources = Math.max(1, Math.floor(candidate.expectedSourceCount ?? 1));
  const source = clamp01(distinctSources / expectedSources);
  const providedEvidence = uniqueStrings(candidate.evidenceKeys);
  const evidence = requiredEvidenceKeys.size === 0
    ? source
    : [...requiredEvidenceKeys].filter((key) => providedEvidence.has(key)).length / requiredEvidenceKeys.size;
  return { source, evidence, combined: rounded((source + evidence) / 2) };
}

function compareRanked<T>(left: RankedRetrievalCandidate<T>, right: RankedRetrievalCandidate<T>): number {
  return right.finalScore - left.finalScore ||
    right.coverageScore - left.coverageScore ||
    right.retrievalScore - left.retrievalScore ||
    right.revision - left.revision ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id);
}

/**
 * Normalizes every available channel across the candidate set, drops globally
 * absent channels (including embedding), then applies coverage-aware reranking.
 */
export function rankRetrievalCandidates<T>(
  candidates: readonly RetrievalCandidate<T>[],
  options: RankRetrievalOptions,
): RankedRetrievalCandidate<T>[] {
  const queryTime = parseTime(options.queryTime);
  const halfLifeMs = finite(options.temporalHalfLifeMs) && options.temporalHalfLifeMs > 0
    ? options.temporalHalfLifeMs
    : 1000 * 60 * 60 * 24 * 30;
  const filtered = candidates.filter((candidate) =>
    Number.isFinite(candidate.revision) &&
    (options.snapshotRevision === undefined || candidate.revision <= options.snapshotRevision));
  const signalRows = filtered.map((candidate) => rawSignals(
    candidate,
    queryTime,
    halfLifeMs,
    options.strategy.allowEmbedding ? options.queryEmbedding : undefined,
  ));
  if (!options.strategy.allowEmbedding) {
    for (const row of signalRows) delete row.embedding;
  }
  const valuesBySignal = Object.fromEntries(SIGNALS.map((signal) => [
    signal,
    signalRows.flatMap((row) => finite(row[signal]) ? [row[signal]] : []),
  ])) as Record<RetrievalSignal, number[]>;
  const globallyAvailable = SIGNALS.filter((signal) =>
    valuesBySignal[signal].length > 0 && options.strategy.weights[signal] > 0);
  const weightTotal = globallyAvailable.reduce((sum, signal) => sum + options.strategy.weights[signal], 0);
  const activeWeights = Object.fromEntries(SIGNALS.map((signal) => [
    signal,
    weightTotal > 0 && globallyAvailable.includes(signal) ? options.strategy.weights[signal] / weightTotal : 0,
  ])) as Record<RetrievalSignal, number>;
  const requiredEvidence = uniqueStrings(options.requiredEvidenceKeys);
  const coverageWeight = clamp01(options.strategy.sourceCoverageWeight);

  return filtered.map((candidate, index) => {
    const raw = signalRows[index] ?? {};
    const signalScores = Object.fromEntries(SIGNALS.map((signal) => {
      const value = raw[signal];
      return [signal, finite(value) ? rounded(minMax(valuesBySignal[signal], value)) : 0];
    })) as Record<RetrievalSignal, number>;
    const retrievalScore = rounded(SIGNALS.reduce(
      (sum, signal) => sum + signalScores[signal] * activeWeights[signal],
      0,
    ));
    const coverage = candidateCoverage(candidate, requiredEvidence);
    const finalScore = rounded(retrievalScore * (1 - coverageWeight) + coverage.combined * coverageWeight);
    return {
      ...candidate,
      signalScores,
      activeWeights,
      retrievalScore,
      sourceCoverage: coverage.source,
      evidenceCoverage: coverage.evidence,
      coverageScore: coverage.combined,
      finalScore,
      meetsEvidenceRequirement:
        coverage.source >= options.strategy.minimumEvidenceCoverage &&
        coverage.evidence >= options.strategy.minimumEvidenceCoverage,
    };
  }).sort(compareRanked);
}

interface CursorPayload {
  version: 1;
  snapshotRevision: number;
  strategyId: string;
  finalScore: number;
  coverageScore: number;
  retrievalScore: number;
  revision: number;
  kind: RetrievalCandidateKind;
  id: string;
}

const RETRIEVAL_CANDIDATE_KINDS = new Set<RetrievalCandidateKind>([
  "source_event",
  "world_claim",
  "episode",
  "policy",
  "correction",
  "memory_object",
]);

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (
      parsed.version !== 1 ||
      !Number.isInteger(parsed.snapshotRevision) ||
      typeof parsed.strategyId !== "string" ||
      !finite(parsed.finalScore) ||
      !finite(parsed.coverageScore) ||
      !finite(parsed.retrievalScore) ||
      !Number.isInteger(parsed.revision) ||
      typeof parsed.kind !== "string" ||
      !RETRIEVAL_CANDIDATE_KINDS.has(parsed.kind as RetrievalCandidateKind) ||
      typeof parsed.id !== "string"
    ) throw new Error("invalid cursor fields");
    return parsed as CursorPayload;
  } catch (error) {
    throw new TypeError("Invalid retrieval cursor", { cause: error });
  }
}

function cursorCandidate(payload: CursorPayload): RankedRetrievalCandidate {
  return {
    id: payload.id,
    kind: payload.kind,
    revision: payload.revision,
    sourceRefs: [],
    signalScores: { bm25: 0, embedding: 0, entity: 0, temporal: 0, thread: 0 },
    activeWeights: { bm25: 0, embedding: 0, entity: 0, temporal: 0, thread: 0 },
    retrievalScore: payload.retrievalScore,
    sourceCoverage: 0,
    evidenceCoverage: 0,
    coverageScore: payload.coverageScore,
    finalScore: payload.finalScore,
    meetsEvidenceRequirement: false,
  };
}

export interface RetrievalPage<T = unknown> {
  items: RankedRetrievalCandidate<T>[];
  nextCursor?: string;
}

/** Keyset pagination over the stable rank tuple; callers must retain the turn snapshot. */
export function paginateRankedCandidates<T>(
  candidates: readonly RankedRetrievalCandidate<T>[],
  options: { limit: number; snapshotRevision: number; strategyId: string; cursor?: string },
): RetrievalPage<T> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
  const ordered = [...candidates].sort(compareRanked);
  let start = 0;
  if (options.cursor !== undefined) {
    const cursor = decodeCursor(options.cursor);
    if (cursor.snapshotRevision !== options.snapshotRevision || cursor.strategyId !== options.strategyId) {
      throw new TypeError("Retrieval cursor does not match this snapshot or strategy");
    }
    const boundary = cursorCandidate(cursor);
    start = ordered.findIndex((candidate) => compareRanked(candidate, boundary) > 0);
    if (start < 0) start = ordered.length;
  }
  const items = ordered.slice(start, start + limit);
  const last = items.at(-1);
  const hasMore = start + items.length < ordered.length;
  return {
    items,
    ...(hasMore && last !== undefined
      ? {
          nextCursor: encodeCursor({
            version: 1,
            snapshotRevision: options.snapshotRevision,
            strategyId: options.strategyId,
            finalScore: last.finalScore,
            coverageScore: last.coverageScore,
            retrievalScore: last.retrievalScore,
            revision: last.revision,
            kind: last.kind,
            id: last.id,
          }),
        }
      : {}),
  };
}

export type ReexperienceKind = "recent_source" | "episode" | "key_event" | "correction" | "fact_constraint";

export interface ReexperienceCandidate<T = unknown> {
  id: string;
  kind: ReexperienceKind;
  tokenCost: number;
  occurredAt?: string;
  relevance?: number;
  importance?: number;
  threadDistance?: number;
  /** Episode candidates must explicitly represent the complete indexed episode. */
  complete?: boolean;
  sourceRefs: readonly SourceRef[];
  value?: T;
}

export interface ReexperiencePack<T = unknown> {
  budgetTokens: number;
  usedTokens: number;
  items: ReexperienceCandidate<T>[];
  recentRaw: ReexperienceCandidate<T>[];
  episodes: ReexperienceCandidate<T>[];
  keyEvents: ReexperienceCandidate<T>[];
  corrections: ReexperienceCandidate<T>[];
  factConstraints: ReexperienceCandidate<T>[];
  sourceRefs: SourceRef[];
  omittedIds: string[];
  truncated: boolean;
}

const REEXPERIENCE_ANCHOR_ORDER: readonly ReexperienceKind[] = [
  "fact_constraint",
  "correction",
  "recent_source",
  "episode",
  "key_event",
];

const REEXPERIENCE_BASE_PRIORITY: Readonly<Record<ReexperienceKind, number>> = {
  fact_constraint: 1,
  correction: 0.95,
  recent_source: 0.82,
  episode: 0.78,
  key_event: 0.72,
};

function reexperienceUtility<T>(candidate: ReexperienceCandidate<T>, now: number): number {
  const occurredAt = parseTime(candidate.occurredAt);
  const recency = occurredAt === undefined ? 0 : Math.exp(-Math.max(0, now - occurredAt) / (1000 * 60 * 60 * 24 * 30));
  const thread = finite(candidate.threadDistance) && candidate.threadDistance >= 0
    ? 1 / (1 + candidate.threadDistance)
    : 0;
  return rounded(
    REEXPERIENCE_BASE_PRIORITY[candidate.kind] +
    clamp01(candidate.relevance ?? 0) * 0.45 +
    clamp01(candidate.importance ?? 0) * 0.3 +
    recency * 0.15 +
    thread * 0.1,
  );
}

function compareReexperience<T>(left: ReexperienceCandidate<T>, right: ReexperienceCandidate<T>, now: number): number {
  return reexperienceUtility(right, now) - reexperienceUtility(left, now) ||
    (parseTime(right.occurredAt) ?? 0) - (parseTime(left.occurredAt) ?? 0) ||
    left.id.localeCompare(right.id);
}

function uniqueSourceRefs<T>(items: readonly ReexperienceCandidate<T>[]): SourceRef[] {
  const seen = new Set<string>();
  return items.flatMap((item) => item.sourceRefs).filter((source) => {
    const key = `${source.eventId}\u001f${source.contentHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Selects an atomic, source-addressable working set. It first reserves one
 * anchor per available memory class, then spends the remainder by utility per
 * token. Complete episodes are never partially selected.
 */
export function buildReexperiencePack<T>(
  candidates: readonly ReexperienceCandidate<T>[],
  options: { budgetTokens: number; now?: string | number | Date; recentRawLimit?: number },
): ReexperiencePack<T> {
  const budgetTokens = Math.max(0, Math.floor(options.budgetTokens));
  const candidateTimes = candidates.flatMap((candidate) => {
    const timestamp = parseTime(candidate.occurredAt);
    return timestamp === undefined ? [] : [timestamp];
  });
  const now = parseTime(options.now) ?? Math.max(0, ...candidateTimes);
  const recentRawLimit = Math.max(0, Math.min(50, Math.floor(options.recentRawLimit ?? 50)));
  const allCandidates = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
  const deduplicated = allCandidates.filter((candidate) =>
      Number.isFinite(candidate.tokenCost) &&
      candidate.tokenCost > 0 &&
      (candidate.kind !== "episode" || candidate.complete === true));
  const recentAllowed = new Set(
    deduplicated
      .filter((candidate) => candidate.kind === "recent_source")
      .sort((left, right) => (parseTime(right.occurredAt) ?? 0) - (parseTime(left.occurredAt) ?? 0) || left.id.localeCompare(right.id))
      .slice(0, recentRawLimit)
      .map((candidate) => candidate.id),
  );
  const eligible = deduplicated.filter((candidate) =>
    candidate.kind !== "recent_source" || recentAllowed.has(candidate.id));
  const selected: ReexperienceCandidate<T>[] = [];
  const selectedIds = new Set<string>();
  let usedTokens = 0;

  const take = (candidate: ReexperienceCandidate<T>): boolean => {
    const cost = Math.max(1, Math.ceil(candidate.tokenCost));
    if (selectedIds.has(candidate.id) || usedTokens + cost > budgetTokens) return false;
    selected.push(candidate);
    selectedIds.add(candidate.id);
    usedTokens += cost;
    return true;
  };

  for (const kind of REEXPERIENCE_ANCHOR_ORDER) {
    const anchor = eligible
      .filter((candidate) => candidate.kind === kind && candidate.tokenCost <= budgetTokens - usedTokens)
      .sort((left, right) => compareReexperience(left, right, now))[0];
    if (anchor !== undefined) take(anchor);
  }

  const remainder = eligible
    .filter((candidate) => !selectedIds.has(candidate.id))
    .sort((left, right) => {
      const leftRate = reexperienceUtility(left, now) / Math.max(1, left.tokenCost);
      const rightRate = reexperienceUtility(right, now) / Math.max(1, right.tokenCost);
      return rightRate - leftRate || compareReexperience(left, right, now);
    });
  for (const candidate of remainder) take(candidate);

  const ordered = [...selected].sort((left, right) =>
    REEXPERIENCE_ANCHOR_ORDER.indexOf(left.kind) - REEXPERIENCE_ANCHOR_ORDER.indexOf(right.kind) ||
    compareReexperience(left, right, now));
  const omittedIds = allCandidates.filter((candidate) => !selectedIds.has(candidate.id)).map((candidate) => candidate.id).sort();

  return {
    budgetTokens,
    usedTokens,
    items: ordered,
    recentRaw: ordered.filter((candidate) => candidate.kind === "recent_source"),
    episodes: ordered.filter((candidate) => candidate.kind === "episode"),
    keyEvents: ordered.filter((candidate) => candidate.kind === "key_event"),
    corrections: ordered.filter((candidate) => candidate.kind === "correction"),
    factConstraints: ordered.filter((candidate) => candidate.kind === "fact_constraint"),
    sourceRefs: uniqueSourceRefs(ordered),
    omittedIds,
    truncated: omittedIds.length > 0,
  };
}
