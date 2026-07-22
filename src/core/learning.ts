import { createHash } from "node:crypto";
import type { RiskCode, ScopeRef } from "../contracts.js";
import type {
  CalibrationPatternRecord,
  StoredPolicy,
  TriggerRecord,
} from "../storage/types.js";

export type TriggerPrimitive = string | number | boolean;
export type TriggerFeatureValue = TriggerPrimitive | readonly TriggerPrimitive[];
export type TriggerFeatures = Readonly<Record<string, TriggerFeatureValue | undefined>>;

export type TriggerOperator =
  | "equals"
  | "one_of"
  | "at_least"
  | "at_most"
  | "contains";

export interface TriggerClause {
  feature: string;
  operator: TriggerOperator;
  value: TriggerFeatureValue;
}

/**
 * `all` is deliberately mandatory and non-empty at match time. A semantic
 * similarity score may strengthen an event match, but can never activate a
 * policy by itself.
 */
export interface LearnedTriggerCondition {
  version: 1;
  all: TriggerClause[];
  any?: TriggerClause[];
}

export interface LearningCorrectionSample {
  correctionId: string;
  sessionId: string;
  agentProfileKey: string;
  riskCode: RiskCode;
  clusterKey: string;
  occurredAt: string;
  scope: ScopeRef;
  features: TriggerFeatures;
  origin: "user_correction" | "self_reflection";
  entitySpecific: boolean;
  policyId?: string;
}

export interface LearningThresholds {
  minCorrections: number;
  minSessions: number;
  minFeatureSupport: number;
}

export interface CalibrationLearningOptions extends Partial<LearningThresholds> {
  /** Features that must never become learned conditions. */
  excludedFeatures?: readonly string[];
}

export interface TriggerLearningOptions extends Partial<LearningThresholds> {
  excludedFeatures?: readonly string[];
}

export interface TriggerCandidate {
  record: TriggerRecord;
  correctionIds: string[];
  sessionIds: string[];
  support: number;
  requiresHumanApproval: true;
}

export interface TriggerMatchContext {
  features: TriggerFeatures;
  /** Optional semantic support keyed by trigger id. Values are clamped to [0, 1]. */
  similarityByTriggerId?: Readonly<Record<string, number | undefined>>;
}

export interface TriggerMatchOptions {
  similarityWeight?: number;
  minimumScore?: number;
}

export interface TriggerMatchResult {
  triggerId: string;
  matched: boolean;
  eventMatched: boolean;
  score: number;
  eventCoverage: number;
  similarity: number;
  matchedClauses: number;
  totalClauses: number;
  reason: string;
}

export interface TriggerDecayOptions {
  halfLifeDays?: number;
  floor?: number;
  saturationActivations?: number;
}

export type PolicyTier = "L1" | "L2" | "L3" | "Archive";

export interface PolicyTierThresholds {
  l1: number;
  l2: number;
  l3: number;
}

export interface DependencyResolution {
  policyId: string;
  satisfied: boolean;
  missing: string[];
  cyclic: string[];
  resolvedPolicyIds: string[];
}

export interface PolicyScheduleInput {
  policies: readonly StoredPolicy[];
  triggers: readonly TriggerRecord[];
  scope: ScopeRef;
  context: TriggerMatchContext;
  asOf: string;
  availableDependencies?: readonly string[];
  thresholds?: Partial<PolicyTierThresholds>;
  decay?: TriggerDecayOptions;
}

export interface ScheduledPolicy {
  policy: StoredPolicy;
  tier: PolicyTier;
  effectivePriority: number;
  shouldLoad: boolean;
  eligible: boolean;
  activatedBy: string[];
  dependency: DependencyResolution;
  reasons: string[];
}

const DEFAULT_THRESHOLDS: LearningThresholds = {
  minCorrections: 3,
  minSessions: 2,
  minFeatureSupport: 1,
};

const DEFAULT_TIER_THRESHOLDS: PolicyTierThresholds = {
  l1: 0.75,
  l2: 0.4,
  l3: 0.1,
};

const DEFAULT_EXCLUDED_FEATURES = new Set([
  "agentFamily",
  "agentVersion",
  "content",
  "correction",
  "entityId",
  "entityName",
  "identity",
  "input",
  "object",
  "personId",
  "personName",
  "prompt",
  "rawInput",
  "subject",
  "symbolId",
  "symbolName",
  "toolsetDigest",
  "userText",
  "workspaceId",
  "sessionId",
  "userId",
]);

const ENTITY_IDENTITY_FEATURE = /(?:^|_)(?:entity|person|people|subject|object|symbol)(?:_?(?:id|key|name|value|identity))(?:_|$)/i;
const MILLISECONDS_PER_DAY = 86_400_000;

function clamp(value: number, lower = 0, upper = 1): number {
  if (!Number.isFinite(value)) return lower;
  return Math.max(lower, Math.min(upper, value));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

function normalizedThresholds(options: Partial<LearningThresholds>): LearningThresholds {
  return {
    minCorrections: positiveInteger(options.minCorrections, DEFAULT_THRESHOLDS.minCorrections),
    minSessions: positiveInteger(options.minSessions, DEFAULT_THRESHOLDS.minSessions),
    minFeatureSupport: clamp(options.minFeatureSupport ?? DEFAULT_THRESHOLDS.minFeatureSupport),
  };
}

function compareUnknown(left: unknown, right: unknown): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 32)}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function newestTimestamp(samples: readonly LearningCorrectionSample[]): string {
  return [...samples]
    .map((sample) => sample.occurredAt)
    .sort((left, right) => left.localeCompare(right))
    .at(-1) ?? "1970-01-01T00:00:00.000Z";
}

function featureExcluded(feature: string, excluded: ReadonlySet<string>): boolean {
  const normalized = feature.replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase();
  return [...excluded].some((item) => item.toLowerCase() === feature.toLowerCase())
    || ENTITY_IDENTITY_FEATURE.test(normalized);
}

function excludedFeatureSet(extra: readonly string[] | undefined): Set<string> {
  return new Set([...DEFAULT_EXCLUDED_FEATURES, ...(extra ?? [])]);
}

function primitiveKey(value: TriggerFeatureValue): string {
  return canonicalJson(value);
}

function isPrimitive(value: unknown): value is TriggerPrimitive {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isFeatureValue(value: unknown): value is TriggerFeatureValue {
  return isPrimitive(value) || (Array.isArray(value) && value.every(isPrimitive));
}

function isPrimitiveArray(value: TriggerFeatureValue): value is readonly TriggerPrimitive[] {
  return Array.isArray(value);
}

function clauseSort(left: TriggerClause, right: TriggerClause): number {
  return left.feature.localeCompare(right.feature)
    || left.operator.localeCompare(right.operator)
    || compareUnknown(left.value, right.value);
}

/** Learn only repeated, structured event signals; correction prose and entities are never conditions. */
export function learnTriggerCondition(
  samples: readonly Pick<LearningCorrectionSample, "features">[],
  options: Pick<TriggerLearningOptions, "minFeatureSupport" | "excludedFeatures"> = {},
): LearnedTriggerCondition | undefined {
  if (samples.length === 0) return undefined;
  const minimumSupport = clamp(options.minFeatureSupport ?? DEFAULT_THRESHOLDS.minFeatureSupport);
  const excluded = excludedFeatureSet(options.excludedFeatures);
  const keys = uniqueSorted(samples.flatMap((sample) => Object.keys(sample.features)));
  const clauses: TriggerClause[] = [];

  for (const feature of keys) {
    if (featureExcluded(feature, excluded)) continue;
    const values = samples
      .map((sample) => sample.features[feature])
      .filter((value): value is TriggerFeatureValue => value !== undefined && isFeatureValue(value));
    if (values.length / samples.length < minimumSupport || values.length === 0) continue;

    const first = values[0];
    if (first === undefined) continue;
    if (values.every((value) => primitiveKey(value) === primitiveKey(first))) {
      if (Array.isArray(first)) {
        for (const item of [...first].sort(compareUnknown)) {
          clauses.push({ feature, operator: "contains", value: item });
        }
      } else {
        clauses.push({ feature, operator: "equals", value: first });
      }
      continue;
    }

    if (values.every((value): value is number => typeof value === "number" && Number.isFinite(value))) {
      const minimum = Math.min(...values);
      // Zero-valued lower bounds carry no useful event signal.
      if (minimum > 0) clauses.push({ feature, operator: "at_least", value: minimum });
      continue;
    }

    const counts = new Map<string, { value: TriggerFeatureValue; count: number }>();
    for (const value of values) {
      const key = primitiveKey(value);
      const prior = counts.get(key);
      counts.set(key, { value, count: (prior?.count ?? 0) + 1 });
    }
    const repeated = [...counts.values()]
      .filter((item) => item.count / samples.length >= minimumSupport)
      .sort((left, right) => right.count - left.count || compareUnknown(left.value, right.value))[0];
    if (repeated !== undefined && !Array.isArray(repeated.value)) {
      clauses.push({ feature, operator: "equals", value: repeated.value });
    }
  }

  if (clauses.length === 0) return undefined;
  return { version: 1, all: clauses.sort(clauseSort) };
}

interface CorrectionGroup {
  key: string;
  samples: LearningCorrectionSample[];
}

function learningGroups(
  samples: readonly LearningCorrectionSample[],
  isolateAgentProfile: boolean,
): CorrectionGroup[] {
  const grouped = new Map<string, LearningCorrectionSample[]>();
  for (const sample of samples) {
    // Self-reflection can suggest a cluster, but cannot satisfy promotion support.
    if (sample.origin !== "user_correction" || sample.entitySpecific) continue;
    const key = canonicalJson({
      agentProfileKey: isolateAgentProfile ? sample.agentProfileKey : null,
      clusterKey: sample.clusterKey,
      policyId: sample.policyId ?? null,
      riskCode: sample.riskCode,
      userId: sample.scope.userId,
      workspaceId: sample.scope.workspaceId ?? null,
    });
    const found = grouped.get(key) ?? [];
    found.push(sample);
    grouped.set(key, found);
  }
  return [...grouped.entries()]
    .map(([key, groupedSamples]) => ({
      key,
      samples: [...groupedSamples].sort((left, right) =>
        left.correctionId.localeCompare(right.correctionId)),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function eligibleGroup(
  samples: readonly LearningCorrectionSample[],
  thresholds: LearningThresholds,
): { correctionIds: string[]; sessionIds: string[] } | undefined {
  const correctionIds = uniqueSorted(samples.map((sample) => sample.correctionId));
  const sessionIds = uniqueSorted(samples.map((sample) => sample.sessionId));
  if (correctionIds.length < thresholds.minCorrections || sessionIds.length < thresholds.minSessions) {
    return undefined;
  }
  return { correctionIds, sessionIds };
}

function supportProbability(corrections: number, sessions: number, thresholds: LearningThresholds): number {
  // This is a conservative prior for shadow replay, not a production probability.
  return clamp(
    0.4
      + Math.max(0, corrections - thresholds.minCorrections) * 0.08
      + Math.max(0, sessions - thresholds.minSessions) * 0.05,
    0.4,
    0.85,
  );
}

/**
 * Convert repeated cross-session corrections into calibration records that are
 * always `shadow`. Activation remains a separate replay/review decision.
 */
export function deriveCalibrationShadowCandidates(
  samples: readonly LearningCorrectionSample[],
  options: CalibrationLearningOptions = {},
): CalibrationPatternRecord[] {
  const thresholds = normalizedThresholds(options);
  const candidates: CalibrationPatternRecord[] = [];

  for (const group of learningGroups(samples, true)) {
    const eligible = eligibleGroup(group.samples, thresholds);
    if (eligible === undefined) continue;
    const condition = learnTriggerCondition(group.samples, options);
    if (condition === undefined) continue;
    const first = group.samples[0];
    if (first === undefined) continue;
    const probability = supportProbability(eligible.correctionIds.length, eligible.sessionIds.length, thresholds);
    const patternIdentity = {
      agentProfileKey: first.agentProfileKey,
      clusterKey: first.clusterKey,
      condition,
      riskCode: first.riskCode,
    };
    candidates.push({
      patternId: stableId("calibration_shadow", patternIdentity),
      agentProfileKey: first.agentProfileKey,
      status: "shadow",
      riskCode: first.riskCode,
      pattern: {
        version: 1,
        clusterKey: first.clusterKey,
        condition,
        correctionIds: eligible.correctionIds,
        sessionIds: eligible.sessionIds,
        newestCorrectionAt: newestTimestamp(group.samples),
        requiresHistoricalReplay: true,
        promotionRule: "replay_and_online_shadow",
      },
      metrics: {
        correctionCount: eligible.correctionIds.length,
        sessionCount: eligible.sessionIds.length,
        support: clamp(Math.min(
          eligible.correctionIds.length / thresholds.minCorrections,
          eligible.sessionIds.length / thresholds.minSessions,
        )),
        probability,
      },
    });
  }

  return candidates.sort((left, right) => left.patternId.localeCompare(right.patternId));
}

/** Create persisted Trigger candidates from the same reviewed correction evidence. */
export function deriveTriggerCandidates(
  samples: readonly LearningCorrectionSample[],
  options: TriggerLearningOptions = {},
): TriggerCandidate[] {
  const thresholds = normalizedThresholds(options);
  const candidates: TriggerCandidate[] = [];

  for (const group of learningGroups(samples, false)) {
    const eligible = eligibleGroup(group.samples, thresholds);
    if (eligible === undefined) continue;
    const condition = learnTriggerCondition(group.samples, options);
    if (condition === undefined) continue;
    const first = group.samples[0];
    if (first === undefined) continue;
    const scope: ScopeRef = {
      userId: first.scope.userId,
      ...(first.scope.workspaceId === undefined ? {} : { workspaceId: first.scope.workspaceId }),
    };
    const support = supportProbability(eligible.correctionIds.length, eligible.sessionIds.length, thresholds);
    const identity = {
      clusterKey: first.clusterKey,
      condition,
      policyId: first.policyId ?? null,
      riskCode: first.riskCode,
      scope,
    };
    candidates.push({
      record: {
        triggerId: stableId("trigger", identity),
        scope,
        ...(first.policyId === undefined ? {} : { policyId: first.policyId }),
        riskCode: first.riskCode,
        condition,
        priority: support,
        activationCount: 0,
      },
      correctionIds: eligible.correctionIds,
      sessionIds: eligible.sessionIds,
      support,
      requiresHumanApproval: true,
    });
  }

  return candidates.sort((left, right) => left.record.triggerId.localeCompare(right.record.triggerId));
}

function conditionFromUnknown(value: unknown): LearnedTriggerCondition | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.all)) {
    const all = record.all.filter(isTriggerClause);
    const any = Array.isArray(record.any) ? record.any.filter(isTriggerClause) : [];
    if (all.length !== record.all.length || all.length === 0) return undefined;
    return {
      version: 1,
      all,
      ...(any.length === 0 ? {} : { any }),
    };
  }

  // Backward-compatible shorthand: { hasImage: true, taskType: "visual" }.
  const clauses = Object.entries(record)
    .filter((entry): entry is [string, TriggerFeatureValue] => isFeatureValue(entry[1]))
    .map(([feature, item]) => ({ feature, operator: "equals" as const, value: item }))
    .sort(clauseSort);
  return clauses.length === 0 ? undefined : { version: 1, all: clauses };
}

function isTriggerClause(value: unknown): value is TriggerClause {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.feature === "string"
    && ["equals", "one_of", "at_least", "at_most", "contains"].includes(String(record.operator))
    && isFeatureValue(record.value);
}

function equals(left: TriggerPrimitive, right: TriggerPrimitive): boolean {
  return typeof left === typeof right && left === right;
}

function clauseMatches(clause: TriggerClause, features: TriggerFeatures): boolean {
  const actual = features[clause.feature];
  if (actual === undefined) return false;
  if (clause.operator === "equals") {
    if (isPrimitiveArray(actual) || isPrimitiveArray(clause.value)) return primitiveKey(actual) === primitiveKey(clause.value);
    return equals(actual, clause.value);
  }
  if (clause.operator === "one_of") {
    if (!isPrimitiveArray(clause.value) || isPrimitiveArray(actual)) return false;
    return clause.value.some((candidate) => equals(actual, candidate));
  }
  if (clause.operator === "contains") {
    const expected = clause.value;
    if (!isPrimitiveArray(actual) || isPrimitiveArray(expected)) return false;
    return actual.some((candidate) => equals(candidate, expected));
  }
  if (isPrimitiveArray(actual) || isPrimitiveArray(clause.value)) return false;
  if (typeof actual !== "number" || typeof clause.value !== "number") return false;
  return clause.operator === "at_least" ? actual >= clause.value : actual <= clause.value;
}

export function matchTrigger(
  trigger: Pick<TriggerRecord, "triggerId" | "condition">,
  context: TriggerMatchContext,
  options: TriggerMatchOptions = {},
): TriggerMatchResult {
  const condition = conditionFromUnknown(trigger.condition);
  if (condition === undefined) {
    return {
      triggerId: trigger.triggerId,
      matched: false,
      eventMatched: false,
      score: 0,
      eventCoverage: 0,
      similarity: 0,
      matchedClauses: 0,
      totalClauses: 0,
      reason: "invalid or empty event condition",
    };
  }
  const allMatches = condition.all.map((clause) => clauseMatches(clause, context.features));
  const anyMatches = (condition.any ?? []).map((clause) => clauseMatches(clause, context.features));
  const matchedAll = allMatches.filter(Boolean).length;
  const matchedAny = anyMatches.filter(Boolean).length;
  const matchedClauses = matchedAll + matchedAny;
  const totalClauses = allMatches.length + anyMatches.length;
  const eventMatched = allMatches.every(Boolean) && (anyMatches.length === 0 || anyMatches.some(Boolean));
  // `any` is one logical requirement; alternatives not selected by the event
  // must not dilute a successful event match.
  const logicalClauseCount = allMatches.length + (anyMatches.length === 0 ? 0 : 1);
  const logicalMatches = matchedAll + (matchedAny === 0 ? 0 : 1);
  const eventCoverage = logicalClauseCount === 0 ? 0 : logicalMatches / logicalClauseCount;
  const similarity = clamp(context.similarityByTriggerId?.[trigger.triggerId] ?? 0);
  const similarityWeight = clamp(options.similarityWeight ?? 0.2);
  const score = clamp(eventCoverage * (1 - similarityWeight) + similarity * similarityWeight);
  const minimumScore = clamp(options.minimumScore ?? 0.75);
  const matched = eventMatched && score >= minimumScore;
  return {
    triggerId: trigger.triggerId,
    matched,
    eventMatched,
    score,
    eventCoverage,
    similarity,
    matchedClauses,
    totalClauses,
    reason: !eventMatched
      ? "event condition did not match"
      : matched
        ? "event condition matched; similarity was used only as auxiliary evidence"
        : "event condition matched but confidence was below the activation threshold",
  };
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${label} must be an ISO-8601 timestamp`);
  return parsed;
}

/** Calculate the decayed scheduling signal without changing the Trigger record. */
export function effectiveTriggerPriority(
  trigger: Pick<TriggerRecord, "priority" | "activationCount" | "lastActivatedAt">,
  asOf: string,
  options: TriggerDecayOptions = {},
): number {
  const halfLifeDays = options.halfLifeDays ?? 30;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new RangeError("halfLifeDays must be greater than zero");
  }
  const floor = clamp(options.floor ?? 0.05);
  const saturationActivations = options.saturationActivations ?? 5;
  if (!Number.isFinite(saturationActivations) || saturationActivations <= 0) {
    throw new RangeError("saturationActivations must be greater than zero");
  }
  const learnedPriority = clamp(trigger.priority);
  const frequencySignal = 1 - Math.exp(-Math.max(0, trigger.activationCount) / saturationActivations);
  const peak = Math.max(learnedPriority, frequencySignal);
  if (trigger.lastActivatedAt === undefined) return peak;
  const effectiveFloor = Math.min(floor, peak);
  const elapsedDays = Math.max(
    0,
    (timestamp(asOf, "asOf") - timestamp(trigger.lastActivatedAt, "lastActivatedAt")) / MILLISECONDS_PER_DAY,
  );
  const decay = 2 ** (-elapsedDays / halfLifeDays);
  return clamp(effectiveFloor + (peak - effectiveFloor) * decay);
}

/** A current event match restores the Trigger signal; the associated Policy is untouched. */
export function recordTriggerActivation<T extends TriggerRecord>(trigger: T, activatedAt: string): T {
  timestamp(activatedAt, "activatedAt");
  return {
    ...trigger,
    priority: 1,
    activationCount: Math.max(0, trigger.activationCount) + 1,
    lastActivatedAt: activatedAt,
  };
}

function latestPolicies(policies: readonly StoredPolicy[]): StoredPolicy[] {
  const latest = new Map<string, StoredPolicy>();
  for (const policy of policies) {
    const current = latest.get(policy.policyId);
    if (current === undefined || policy.version > current.version) latest.set(policy.policyId, policy);
  }
  return [...latest.values()].sort((left, right) => left.policyId.localeCompare(right.policyId));
}

function scopeAllows(policy: StoredPolicy, current: ScopeRef): boolean {
  if (policy.scope.userId !== current.userId) return false;
  if (policy.scopeLevel === "user") return true;
  if (policy.scope.workspaceId === undefined || policy.scope.workspaceId !== current.workspaceId) return false;
  if (policy.scopeLevel === "workspace") return true;
  return policy.scope.sessionId !== undefined && policy.scope.sessionId === current.sessionId;
}

/**
 * Resolve external capability/fact dependencies and references to other Policy
 * ids. Missing references and cycles fail closed.
 */
export function resolvePolicyDependencies(
  policies: readonly StoredPolicy[],
  availableDependencies: readonly string[] = [],
): Map<string, DependencyResolution> {
  const latest = latestPolicies(policies)
    .filter((policy) => policy.reviewStatus === undefined || policy.reviewStatus === "approved");
  const byId = new Map(latest.map((policy) => [policy.policyId, policy]));
  const available = new Set(availableDependencies);
  const resolved = new Map<string, DependencyResolution>();

  const visit = (policyId: string, path: readonly string[]): DependencyResolution => {
    const cached = resolved.get(policyId);
    if (cached !== undefined) return cached;
    const policy = byId.get(policyId);
    if (policy === undefined) {
      return {
        policyId,
        satisfied: false,
        missing: [policyId],
        cyclic: [],
        resolvedPolicyIds: [],
      };
    }
    const cycleIndex = path.indexOf(policyId);
    if (cycleIndex >= 0) {
      const cyclic = uniqueSorted([...path.slice(cycleIndex), policyId]);
      return { policyId, satisfied: false, missing: [], cyclic, resolvedPolicyIds: [] };
    }
    const nextPath = [...path, policyId];
    const missing: string[] = [];
    const cyclic: string[] = [];
    const dependencyPolicies: string[] = [];
    for (const dependency of uniqueSorted(policy.dependencies ?? [])) {
      if (available.has(dependency)) continue;
      if (!byId.has(dependency)) {
        missing.push(dependency);
        continue;
      }
      const nested = visit(dependency, nextPath);
      if (!nested.satisfied) {
        missing.push(...nested.missing);
        cyclic.push(...nested.cyclic);
      } else {
        dependencyPolicies.push(dependency, ...nested.resolvedPolicyIds);
      }
    }
    const result: DependencyResolution = {
      policyId,
      satisfied: missing.length === 0 && cyclic.length === 0,
      missing: uniqueSorted(missing),
      cyclic: uniqueSorted(cyclic),
      resolvedPolicyIds: uniqueSorted(dependencyPolicies),
    };
    // Do not cache an intermediate cycle result onto the wrong root. Each root
    // gets a complete, deterministic resolution below.
    if (path.length === 0 || result.satisfied) resolved.set(policyId, result);
    return result;
  };

  for (const policy of latest) resolved.set(policy.policyId, visit(policy.policyId, []));
  return resolved;
}

function tierFor(priority: number, thresholds: PolicyTierThresholds): PolicyTier {
  if (priority >= thresholds.l1) return "L1";
  if (priority >= thresholds.l2) return "L2";
  if (priority >= thresholds.l3) return "L3";
  return "Archive";
}

function normalizedTierThresholds(value: Partial<PolicyTierThresholds> | undefined): PolicyTierThresholds {
  const thresholds = {
    l1: clamp(value?.l1 ?? DEFAULT_TIER_THRESHOLDS.l1),
    l2: clamp(value?.l2 ?? DEFAULT_TIER_THRESHOLDS.l2),
    l3: clamp(value?.l3 ?? DEFAULT_TIER_THRESHOLDS.l3),
  };
  if (!(thresholds.l1 > thresholds.l2 && thresholds.l2 > thresholds.l3)) {
    throw new RangeError("Policy tier thresholds must satisfy l1 > l2 > l3");
  }
  return thresholds;
}

function reviewAllows(policy: StoredPolicy): boolean {
  return policy.reviewStatus === undefined || policy.reviewStatus === "approved";
}

function tierRank(tier: PolicyTier): number {
  return { L1: 0, L2: 1, L3: 2, Archive: 3 }[tier];
}

/**
 * Schedule Policy records without changing them. Trigger signals determine
 * cache tier; a matching event immediately promotes a relevant Policy to L1.
 */
export function schedulePolicies(input: PolicyScheduleInput): ScheduledPolicy[] {
  const policies = latestPolicies(input.policies);
  const thresholds = normalizedTierThresholds(input.thresholds);
  const dependencyMap = resolvePolicyDependencies(policies, input.availableDependencies);
  const triggersByPolicy = new Map<string, TriggerRecord[]>();
  for (const trigger of input.triggers) {
    if (trigger.policyId === undefined) continue;
    const found = triggersByPolicy.get(trigger.policyId) ?? [];
    found.push(trigger);
    triggersByPolicy.set(trigger.policyId, found);
  }

  const scheduled = policies.map((policy): ScheduledPolicy => {
    const dependency = dependencyMap.get(policy.policyId) ?? {
      policyId: policy.policyId,
      satisfied: true,
      missing: [],
      cyclic: [],
      resolvedPolicyIds: [],
    };
    const inScope = scopeAllows(policy, input.scope);
    const approved = reviewAllows(policy);
    const eligible = inScope && approved && dependency.satisfied;
    const policyTriggers = (triggersByPolicy.get(policy.policyId) ?? [])
      .filter((trigger) => scopeAllows({ ...policy, scope: trigger.scope }, input.scope));
    const matches = policyTriggers.map((trigger) => ({
      trigger,
      match: matchTrigger(trigger, input.context),
      priority: effectiveTriggerPriority(trigger, input.asOf, input.decay),
    }));
    const activatedBy = matches.filter((item) => item.match.matched).map((item) => item.trigger.triggerId).sort();
    const policyCondition = policy.condition === undefined
      ? undefined
      : matchTrigger({ triggerId: `policy:${policy.policyId}`, condition: policy.condition }, input.context);
    const conditionMatched = policyCondition?.matched ?? false;
    const hasRoutingCondition = policyTriggers.length > 0 || policyCondition !== undefined;
    const basePriority = policy.authority === "user_explicit" ? thresholds.l2 : (thresholds.l2 + thresholds.l3) / 2;
    const decayedPriority = policyTriggers.length === 0
      ? basePriority
      : Math.max(...matches.map((item) => item.priority));
    // Policy.condition expresses applicability; Trigger expresses when to
    // activate. When both exist they must both agree.
    const currentMatch = hasRoutingCondition
      && (policyCondition === undefined || conditionMatched)
      && (policyTriggers.length === 0 || activatedBy.length > 0);
    const effectivePriority = currentMatch ? 1 : decayedPriority;
    const reasons: string[] = [];
    if (!inScope) reasons.push("policy scope does not match the current turn");
    if (!approved) reasons.push(`policy review status is ${policy.reviewStatus ?? "unknown"}`);
    if (!dependency.satisfied) {
      if (dependency.missing.length > 0) reasons.push(`missing dependencies: ${dependency.missing.join(", ")}`);
      if (dependency.cyclic.length > 0) reasons.push(`cyclic dependencies: ${dependency.cyclic.join(", ")}`);
    }
    if (hasRoutingCondition && !currentMatch) reasons.push("no current Trigger or Policy condition matched");
    if (currentMatch) reasons.push("current event match promoted the Policy to L1");
    if (!hasRoutingCondition) reasons.push("unconditional Policy uses its stable authority tier");
    return {
      policy,
      tier: tierFor(effectivePriority, thresholds),
      effectivePriority,
      shouldLoad: eligible && (!hasRoutingCondition || currentMatch),
      eligible,
      activatedBy,
      dependency,
      reasons,
    };
  });

  // A loaded Policy pulls its Policy-id dependencies into the working set.
  const forced = new Set<string>();
  for (const item of scheduled) {
    if (item.shouldLoad) item.dependency.resolvedPolicyIds.forEach((id) => forced.add(id));
  }
  const withDependencies = scheduled.map((item): ScheduledPolicy => {
    if (!forced.has(item.policy.policyId) || !item.eligible || item.shouldLoad) return item;
    return {
      ...item,
      tier: tierFor(Math.max(item.effectivePriority, thresholds.l2), thresholds),
      effectivePriority: Math.max(item.effectivePriority, thresholds.l2),
      shouldLoad: true,
      reasons: [...item.reasons, "loaded as a dependency of an active Policy"],
    };
  });

  return withDependencies.sort((left, right) =>
    Number(right.shouldLoad) - Number(left.shouldLoad)
      || tierRank(left.tier) - tierRank(right.tier)
      || (left.policy.authority === right.policy.authority
        ? 0
        : left.policy.authority === "user_explicit" ? -1 : 1)
      || left.policy.policyId.localeCompare(right.policy.policyId));
}
