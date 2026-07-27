import { createHash } from "node:crypto";
import type {
  MemoryObject,
  MemoryQueryAnalysis,
  MemoryQualityMetrics,
  MemoryRiskProfile,
  MemoryTemperature,
  MemoryTemperatureTier,
  RiskScore,
} from "../contracts.js";
import type { MemoryEvolutionConfig } from "../config.js";
import {
  extractEntityTokens,
  LocalHashEmbeddingProvider,
  redactEmbeddingSecrets,
} from "./embedding.js";
import { cosineSimilarity } from "./retrieval.js";

const FACTUAL_RECALL =
  /\b(?:remember|recall|what (?:was|did|is)|when did|which|who|where|previously|last time)\b|记得|回忆|上次|之前|以前|是什么|何时|什么时候|谁|哪个|哪里/iu;
const QUOTE_RECALL =
  /\b(?:exact(?:ly)?|verbatim|word for word|quote|original wording|what did .* say)\b|原话|逐字|一字不差|准确措辞|怎么说的|引用/iu;
const TEMPORAL =
  /\b(?:before|after|during|timeline|first|last|latest|earlier|later|yesterday|today|date|time|version)\b|之前|之后|期间|时间线|最初|最后|最近|昨天|今天|日期|版本/iu;
const CONTRADICTION =
  /\b(?:contradict|conflict|inconsistent|changed|used to|no longer|which is correct)\b|冲突|矛盾|不一致|改过|以前是|不再是|哪个正确/iu;
const NARRATIVE =
  /\b(?:story|plot|scene|episode|what happened|off[- ]screen|fill in)\b|剧情|故事|这一幕|发生了什么|镜头外|补全/iu;
const ANALYSIS =
  /\b(?:analy[sz]e|infer|hypothesi[sz]e|reason|why|可能|estimate|interpret)\b|分析|推断|假设|推理|为什么|可能性|估计|解读/iu;
const ARCHIVE =
  /\b(?:archive|archived|deep history|very old|all history)\b|归档|档案|很久以前|全部历史|深度回溯/iu;
const IDENTITY =
  /\b(?:who|which person|identity|same person|same project|same work)\b|是谁|哪个人|身份|同一个人|同一项目|同一作品/iu;

const TOPIC_STOP = new Set([
  "about", "after", "again", "also", "and", "are", "before", "from", "have", "into", "that", "the",
  "this", "what", "when", "where", "which", "with", "would", "一个", "这个", "那个", "以及", "关于",
  "他们", "我们", "什么", "如何", "是否", "然后", "现在", "之前", "之后", "记得", "回忆",
]);

const fingerprintEmbedding = new LocalHashEmbeddingProvider({
  dimensions: 96,
  characterNgrams: [2, 4],
  wordNgrams: [1, 2],
});

export interface MemoryFingerprint {
  entities: string[];
  explicitEntities: string[];
  topics: string[];
  vector: number[];
}

export interface FingerprintedMember {
  memberType: "raw" | "episode" | "semantic" | "object";
  memberId: string;
  title: string;
  content: string;
  evidenceCount: number;
  occurredAt?: string;
  fingerprint: MemoryFingerprint;
}

export interface ObjectHealthDecision {
  splitRecommended: boolean;
  refreshSummary: boolean;
  reasons: string[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeToken(token: string): string {
  return token.normalize("NFKC").toLocaleLowerCase("und").trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeToken).filter((value) => value.length > 0))];
}

export function stableEvolutionId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32);
  return `${prefix}_${digest}`;
}

export function estimateMemoryTokens(text: string): number {
  const sanitized = redactEmbeddingSecrets(text);
  const han = sanitized.match(/\p{Script=Han}/gu)?.length ?? 0;
  const other = Math.max(0, [...sanitized].length - han);
  return Math.max(1, Math.ceil(han / 1.5 + other / 4));
}

export function extractTopicTokens(text: string, limit = 32): string[] {
  const sanitized = redactEmbeddingSecrets(text).normalize("NFKC").toLocaleLowerCase("und");
  const raw = sanitized.match(/[\p{Script=Han}]{2,12}|[\p{L}\p{N}][\p{L}\p{N}_.:/#-]{2,}/gu) ?? [];
  const weighted = new Map<string, number>();
  for (const candidate of raw) {
    const token = normalizeToken(candidate);
    if (TOPIC_STOP.has(token) || token.includes("memorysecretmarker")) continue;
    weighted.set(token, (weighted.get(token) ?? 0) + 1);
    if (/^\p{Script=Han}+$/u.test(token) && [...token].length > 3) {
      const chars = [...token];
      for (let index = 0; index + 2 <= chars.length; index += 1) {
        const bigram = chars.slice(index, index + 2).join("");
        if (!TOPIC_STOP.has(bigram)) weighted.set(bigram, (weighted.get(bigram) ?? 0) + 0.3);
      }
    }
  }
  return [...weighted.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, Math.max(1, limit))
    .map(([token]) => token);
}

export function fingerprintMemory(text: string, explicitEntities: readonly string[] = []): MemoryFingerprint {
  return {
    entities: unique(extractEntityTokens(text)),
    explicitEntities: unique(explicitEntities),
    topics: extractTopicTokens(text),
    vector: fingerprintEmbedding.embed(text),
  };
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / Math.max(1, a.size + b.size - intersection);
}

/**
 * Similarity is deliberately entity guarded. Two records that explicitly name
 * different entities cannot merge merely because their surrounding prose is
 * alike; a relation may still connect them later.
 */
export function memorySimilarity(left: MemoryFingerprint, right: MemoryFingerprint): number {
  const explicitLeft = left.explicitEntities;
  const explicitRight = right.explicitEntities;
  const explicitOverlap = jaccard(explicitLeft, explicitRight);
  const explicitConflict =
    explicitLeft.length > 0 && explicitRight.length > 0 && explicitOverlap === 0;
  const entity = Math.max(explicitOverlap, jaccard(left.entities, right.entities));
  const topics = jaccard(left.topics, right.topics);
  const semantic = clamp01(((cosineSimilarity(left.vector, right.vector) ?? -1) + 1) / 2);
  const score = semantic * 0.52 + topics * 0.28 + entity * 0.2;
  return Number((explicitConflict ? Math.min(score, 0.34) : score).toFixed(6));
}

export function analyzeMemoryQuery(query: string, includeArchive = false): MemoryQueryAnalysis {
  const quoteRecall = QUOTE_RECALL.test(query);
  const factualRecall = quoteRecall || FACTUAL_RECALL.test(query);
  const analysis = ANALYSIS.test(query);
  return {
    entities: extractEntityTokens(query, { maxTokens: 24 }),
    topics: extractTopicTokens(query, 24),
    temporalHints: [...new Set(query.match(
      /\b(?:19|20)\d{2}(?:-\d{1,2}(?:-\d{1,2})?)?\b|\b(?:yesterday|today|last week|last month)\b|昨天|今天|上周|上个月/giu,
    ) ?? [])],
    taskType: quoteRecall ? "quote_recall" : factualRecall ? "factual_recall" : analysis ? "analysis" : "general",
    explicitArchiveLookup: includeArchive || ARCHIVE.test(query),
  };
}

export function recognizeMemoryRisk(
  query: string,
  legacyRisks: readonly Pick<RiskScore, "code" | "probability">[] = [],
  context: { hasDirectEvidence?: boolean; contradictionCount?: number } = {},
): MemoryRiskProfile {
  const analysis = analyzeMemoryQuery(query);
  const risk = (code: RiskScore["code"]): number =>
    legacyRisks.find((item) => item.code === code)?.probability ?? 0;
  const factualRecall = analysis.taskType === "factual_recall" || analysis.taskType === "quote_recall";
  const quoteRecall = analysis.taskType === "quote_recall";
  const entityConfusion =
    IDENTITY.test(query) ||
    analysis.entities.length > 1 ||
    risk("entity_or_symbol_merge") >= 0.4 ||
    risk("cross_session_merge") >= 0.7;
  const temporalConfusion =
    TEMPORAL.test(query) ||
    analysis.temporalHints.length > 0 ||
    risk("stale_source") >= 0.4 ||
    risk("cross_session_merge") >= 0.7;
  const contradictionRisk =
    CONTRADICTION.test(query) ||
    (context.contradictionCount ?? 0) > 0 ||
    risk("entity_or_symbol_merge") >= 0.7;
  const narrativeCompletionRisk =
    NARRATIVE.test(query) ||
    risk("narrative_completion") >= 0.4 ||
    risk("unsupported_inference") >= 0.7;
  const inferenceAllowed = analysis.taskType === "analysis" && !quoteRecall;
  const accurateRecall = factualRecall || quoteRecall || contradictionRisk;
  const lowEvidenceRisk = accurateRecall && context.hasDirectEvidence !== true;
  const retrievalDepth = quoteRecall || factualRecall || contradictionRisk || risk("unsupported_inference") >= 0.7
    ? "raw"
    : temporalConfusion || narrativeCompletionRisk
      ? "episode"
      : "object";
  return {
    factualRecall,
    quoteRecall,
    entityConfusion,
    temporalConfusion,
    contradictionRisk,
    narrativeCompletionRisk,
    lowEvidenceRisk,
    inferenceAllowed,
    retrievalDepth,
    topK: retrievalDepth === "raw" ? 12 : retrievalDepth === "episode" ? 10 : 6,
    confidenceLanguage: accurateRecall || narrativeCompletionRisk
      ? "strict"
      : temporalConfusion || entityConfusion
        ? "qualified"
        : "normal",
  };
}

export function deriveObjectTitle(member: FingerprintedMember): string {
  const explicit = member.fingerprint.explicitEntities[0];
  if (explicit !== undefined) return explicit.slice(0, 120);
  const entity = member.fingerprint.entities[0];
  if (entity !== undefined) return entity.slice(0, 120);
  const topics = member.fingerprint.topics.slice(0, 3);
  if (topics.length > 0) return topics.join(" · ").slice(0, 120);
  return member.title.trim().slice(0, 120) || "Memory object";
}

export function summarizeMemoryMembers(
  members: readonly Pick<FingerprintedMember, "title" | "content" | "occurredAt">[],
  maxCharacters: number,
): string {
  const ordered = [...members].sort((left, right) =>
    (left.occurredAt ?? "").localeCompare(right.occurredAt ?? "") || left.title.localeCompare(right.title));
  const lines: string[] = [];
  for (const member of ordered) {
    const compact = member.content.replace(/\s+/gu, " ").trim();
    if (compact.length === 0) continue;
    const line = `${member.title}: ${compact.slice(0, 280)}`;
    if (lines.join("\n").length + line.length + 1 > maxCharacters) break;
    lines.push(line);
  }
  return lines.join("\n").slice(0, maxCharacters);
}

/**
 * Deterministic, bounded split grouping. Entity/topic signatures are preferred;
 * if a large mixed node has no usable labels, stable balanced buckets avoid an
 * unbounded parent while retaining reproducibility.
 */
export function splitMemoryMembers<T extends FingerprintedMember>(
  members: readonly T[],
  targetMembers: number,
): T[][] {
  if (members.length < 2) return [members.slice()];
  const target = Math.max(1, Math.floor(targetMembers));
  const grouped = new Map<string, T[]>();
  for (const member of members) {
    const signature =
      member.fingerprint.explicitEntities[0] ??
      member.fingerprint.entities[0] ??
      member.fingerprint.topics.slice(0, 2).join(":") ??
      "";
    const key = signature.length > 0 ? signature : stableEvolutionId("member", member.memberId).slice(-8);
    const bucket = grouped.get(key) ?? [];
    bucket.push(member);
    grouped.set(key, bucket);
  }
  let groups = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, values]) => values.sort((left, right) => left.memberId.localeCompare(right.memberId)));

  if (groups.length === 1) {
    const sorted = [...members].sort((left, right) =>
      stableEvolutionId("order", left.memberId).localeCompare(stableEvolutionId("order", right.memberId)));
    const count = Math.max(2, Math.ceil(sorted.length / target));
    groups = Array.from({ length: count }, () => []);
    sorted.forEach((member, index) => groups[index % count]?.push(member));
  }

  const result: T[][] = [];
  for (const group of groups) {
    if (group.length <= target) {
      result.push(group);
      continue;
    }
    for (let index = 0; index < group.length; index += target) result.push(group.slice(index, index + target));
  }
  return result.filter((group) => group.length > 0);
}

export function evaluateObjectHealth(
  object: MemoryObject,
  metrics: MemoryQualityMetrics | undefined,
  config: MemoryEvolutionConfig,
): ObjectHealthDecision {
  const reasons: string[] = [];
  if (object.tokenEstimate > config.maxNodeTokens) reasons.push("max_node_tokens");
  if (object.childCount > config.maxChildCount) reasons.push("max_child_count");
  if (object.memberCount > config.maxObjectMembers) reasons.push("max_object_members");
  if (object.entityKeys.length > config.maxEntitiesPerObject) reasons.push("max_entities");
  if (metrics !== undefined && metrics.precisionProxy < config.minimumPrecisionProxy) reasons.push("precision_proxy");
  if (
    metrics?.subtopicClusterCount !== undefined &&
    metrics.subtopicClusterCount >= config.minimumSubtopicClusters
  ) reasons.push("subtopic_clusters");
  if (
    (metrics?.retrievalSamples ?? 0) >= config.minimumRetrievalSamples &&
    (metrics?.queryHitDispersion ?? 0) > config.maximumQueryHitDispersion
  ) reasons.push("query_hit_dispersion");
  if (
    metrics?.summaryFidelity !== undefined &&
    metrics.summaryFidelity < config.minimumSummaryFidelity
  ) reasons.push("summary_fidelity");
  if (
    (metrics?.retrievalSamples ?? 0) >= config.minimumRetrievalSamples &&
    (metrics?.localUseRatio ?? 1) < config.minimumLocalUseRatio
  ) reasons.push("local_use_ratio");
  if (metrics !== undefined && metrics.averageExpansionDepth > config.maxExpansionDepth) reasons.push("expansion_depth");
  const summaryAge = Date.now() - Date.parse(object.updatedAt);
  const refreshSummary =
    Number.isFinite(summaryAge) &&
    summaryAge > config.staleSummaryAfterDays * 86_400_000;
  return {
    splitRecommended: object.memberCount >= config.splitMinMembers && reasons.length > 0,
    refreshSummary,
    reasons,
  };
}

export interface TemperatureInput {
  memoryType: MemoryTemperature["memoryType"];
  memoryId: string;
  scope: MemoryTemperature["scope"];
  now: string;
  createdAt?: string;
  lastAccessedAt?: string;
  lastMentionedAt?: string;
  accessCount?: number;
  retrievalCount?: number;
  mentionCount?: number;
  explicitRemember?: boolean;
  activeProject?: boolean;
  pinned?: boolean;
}

function recency(timestamp: string | undefined, now: number, halfLifeDays: number): number {
  if (timestamp === undefined) return 0;
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return 0;
  return Math.exp(-Math.max(0, now - value) / (halfLifeDays * 86_400_000));
}

export function computeMemoryTemperature(
  input: TemperatureInput,
  config: MemoryEvolutionConfig,
): MemoryTemperature {
  const now = Date.parse(input.now);
  const accessCount = Math.max(0, input.accessCount ?? 0);
  const retrievalCount = Math.max(0, input.retrievalCount ?? 0);
  const mentionCount = Math.max(0, input.mentionCount ?? 0);
  const lastActivity = input.lastAccessedAt ?? input.lastMentionedAt ?? input.createdAt;
  const score = clamp01(
    recency(lastActivity, now, 30) * 0.35 +
    Math.min(1, Math.log1p(accessCount + retrievalCount) / Math.log(16)) * 0.2 +
    Math.min(1, Math.log1p(mentionCount) / Math.log(8)) * 0.1 +
    (input.explicitRemember ? 0.15 : 0) +
    (input.activeProject ? 0.1 : 0) +
    (input.pinned ? 0.25 : 0),
  );
  const ageDays = lastActivity === undefined || !Number.isFinite(Date.parse(lastActivity))
    ? Number.POSITIVE_INFINITY
    : Math.max(0, now - Date.parse(lastActivity)) / 86_400_000;
  let tier: MemoryTemperatureTier;
  if (input.pinned || score >= config.hotThreshold) tier = "hot";
  else if (score >= config.warmThreshold) tier = "warm";
  else if (score >= config.coldThreshold || ageDays < config.archiveAfterDays) tier = "cold";
  else tier = "archive";
  if (ageDays >= config.coldAfterDays && tier === "warm") tier = "cold";
  return {
    memoryType: input.memoryType,
    memoryId: input.memoryId,
    scope: input.scope,
    tier,
    score: Number(score.toFixed(6)),
    accessCount,
    retrievalCount,
    mentionCount,
    ...(input.lastAccessedAt === undefined ? {} : { lastAccessedAt: input.lastAccessedAt }),
    ...(input.lastMentionedAt === undefined ? {} : { lastMentionedAt: input.lastMentionedAt }),
    explicitRemember: input.explicitRemember ?? false,
    activeProject: input.activeProject ?? false,
    pinned: input.pinned ?? false,
    updatedAt: input.now,
  };
}

export function exactObjectRouteMatch(object: MemoryObject, analysis: MemoryQueryAnalysis): boolean {
  const queryKeys = new Set([...analysis.entities, ...analysis.topics].map(normalizeToken));
  if (queryKeys.size === 0) return false;
  const objectKeys = new Set([
    object.title,
    ...object.routingKeys,
    ...object.entityKeys,
  ].map(normalizeToken));
  return [...queryKeys].some((key) => objectKeys.has(key));
}
