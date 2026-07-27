export const PROTOCOL_VERSION = "1.2" as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type ScopeLevel = "user" | "workspace" | "session";

export interface ScopeRef {
  userId: string;
  workspaceId?: string;
  sessionId?: string;
  branch?: string;
  commit?: string;
}

export interface AgentCapabilities {
  hooks: boolean;
  stageGates: boolean;
  maxContextTokens?: number;
  modalities?: string[];
}

export interface AgentProfile {
  family: string;
  version: string;
  model?: string;
  toolsetDigest?: string;
  capabilities: AgentCapabilities;
}

export type SourceEventKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "attachment"
  | "checkpoint"
  | "compaction";

export interface AttachmentRef {
  uri: string;
  mediaType?: string;
  contentHash?: string;
}

export interface InputEvent {
  eventId?: string;
  idempotencyKey: string;
  kind: SourceEventKind;
  content: string;
  occurredAt?: string;
  attachments?: AttachmentRef[];
  metadata?: Record<string, unknown>;
}

export interface SourceRef {
  eventId: string;
  sessionId: string;
  contentHash: string;
  capturedAt: string;
  workspaceId?: string;
  startOffset?: number;
  endOffset?: number;
  path?: string;
  commit?: string;
}

export interface SourceEvent {
  eventId: string;
  revision: number;
  deviceId: string;
  scope: ScopeRef;
  agent: AgentProfile;
  kind: SourceEventKind;
  content: string;
  contentHash: string;
  capturedAt: string;
  occurredAt: string;
  selectedEvidence: boolean;
  redactions: string[];
  attachments: AttachmentRef[];
  metadata: Record<string, unknown>;
}

/** Raw Evidence is the immutable SourceEvent authority, not a copied payload. */
export type RawEvidence = SourceEvent;

/**
 * A provenance edge used by higher-level memories. The SourceRef fields stay
 * wire-compatible with v1.1; the optional fields describe how the ref is used.
 */
export interface EvidenceReference extends SourceRef {
  evidenceRole?: "direct" | "supporting" | "contradicting";
  provenancePath?: string[];
}

export type RiskCode =
  | "entity_or_symbol_merge"
  | "stale_source"
  | "wrong_workspace"
  | "cross_session_merge"
  | "unsupported_inference"
  | "narrative_completion"
  | "destructive_action"
  | "secret_exposure";

export interface RiskContribution {
  source: "rule" | "classifier" | "calibration" | "trigger";
  score: number;
  reason: string;
}

export interface RiskScore {
  code: RiskCode;
  probability: number;
  contributions: RiskContribution[];
}

export type ModeLevel = "off" | "low" | "medium" | "high" | "blocked";

export interface ModeLevels {
  evidenceFirst: ModeLevel;
  uncertainty: ModeLevel;
  retrieveOriginalSource: ModeLevel;
  askClarification: ModeLevel;
  narrativeCompletionGate: ModeLevel;
}

export type RetrievalStageName =
  | "policy"
  | "current_evidence"
  | "world"
  | "reexperience"
  | "episode"
  | "source_expansion";

export interface RetrievalStage {
  name: RetrievalStageName;
  order: number;
  blockedUntilCheckpoint: boolean;
}

export interface StageGate {
  kind: "evidence_checkpoint";
  required: boolean;
  satisfied: boolean;
  reason?: string;
}

export interface PolicyRef {
  policyId: string;
  version: number;
  scopeLevel: ScopeLevel;
  authority: "user_explicit" | "confirmed_learned";
  text: string;
  condition?: unknown;
  action?: unknown;
  dependencies?: string[];
  sources?: SourceRef[];
}

export type PolicyScheduleTier = "L1" | "L2" | "L3" | "Archive";

export interface PolicyScheduleEntry {
  policyId: string;
  version: number;
  tier: PolicyScheduleTier;
  reason: string;
  triggerIds?: string[];
  dependencies?: string[];
}

export interface PolicySchedule {
  l1: PolicyScheduleEntry[];
  l2: PolicyScheduleEntry[];
  l3: PolicyScheduleEntry[];
  archive: PolicyScheduleEntry[];
  dependencyErrors: Array<{
    policyId: string;
    kind: "missing" | "cycle" | "inactive";
    dependencyId?: string;
  }>;
}

export type PlanRetrievalSignal =
  | "bm25"
  | "embedding"
  | "entity"
  | "temporal"
  | "thread";

export type PlanRetrievalStep =
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

export interface PlanRetrievalStrategy {
  strategyId: string;
  riskCodes: RiskCode[];
  orderedSteps: PlanRetrievalStep[];
  weights: Record<PlanRetrievalSignal, number>;
  sourceCoverageWeight: number;
  minimumEvidenceCoverage: number;
  checkpointFirst: boolean;
  originalSourceRequired: boolean;
  sameWorkspaceOnly: boolean;
  allowEmbedding: boolean;
}

export interface TurnPlan {
  protocolVersion: ProtocolVersion;
  turnId: string;
  snapshotRevision: number;
  /** Generation of rebuildable object/partition indexes visible at begin_turn. */
  memoryGeneration?: number;
  agentProfileKey: string;
  risks: RiskScore[];
  modes: ModeLevels;
  retrievalStages: RetrievalStage[];
  gate: StageGate;
  activePolicies: PolicyRef[];
  /** Additive v1 extension. Older persisted plans may not contain it. */
  policySchedule?: PolicySchedule;
  /** Risk-specific retrieval and reranking plan used by memory_recall. */
  retrievalStrategy?: PlanRetrievalStrategy;
  enforcementLevel: "enforced" | "advisory";
  retryCount: number;
  createdAt: string;
}

export interface Observation {
  observationId?: string;
  kind: "current_file" | "image" | "test" | "command" | "user_statement";
  content: string;
  source?: Partial<SourceRef>;
  metadata?: Record<string, unknown>;
}

export interface WorldClaim {
  claimId: string;
  subject: string;
  predicate: string;
  value: unknown;
  scope: ScopeRef;
  confidence: number;
  authority: "user_explicit" | "confirmed_learned" | "inferred";
  status: "active" | "superseded" | "disputed" | "revoked";
  validFrom?: string;
  validTo?: string;
  supersedes?: string;
  conflictGroup?: string;
  sources: SourceRef[];
  version: number;
  firstSeenAt?: string;
  lastConfirmedAt?: string;
  schemaVersion?: number;
  embeddingVersion?: string;
  provenance?: MemoryProvenance;
}

/** Semantic Memory remains wire-compatible with the existing WorldClaim API. */
export type SemanticMemory = WorldClaim;

export interface EpisodeMemory {
  episodeId: string;
  scope: ScopeRef;
  title: string;
  summary?: string;
  eventRefs: SourceRef[];
  participants: string[];
  tags: string[];
  startedAt: string;
  endedAt: string;
  /** Narrative chunks may span several completed turns. */
  turnIds?: string[];
  topicKey?: string;
  boundaryReason?: "new_session" | "topic_shift" | "correction" | "time_gap" | "size_limit" | "explicit";
  salience?: number;
  emotionTags?: string[];
  status?: "active" | "archived" | "deprecated";
  schemaVersion?: number;
  embeddingVersion?: string;
  summarizerVersion?: string;
  updatedAt?: string;
  provenance?: MemoryProvenance;
}

export type MemoryNodeType = "raw" | "episode" | "semantic" | "object" | "policy";

export type MemoryRelationType =
  | "related_to"
  | "caused_by"
  | "contradicts"
  | "supersedes"
  | "derived_from"
  | "part_of"
  | "discussed_in"
  | "similar_to"
  | "depends_on";

export type MemoryObjectStatus = "active" | "router" | "merged" | "deprecated" | "archived";

export type MemoryTemperatureTier = "hot" | "warm" | "cold" | "archive";

export interface MemoryProvenance {
  actor: "user" | "agent" | "system" | "curator" | "import";
  operation: string;
  algorithm?: string;
  algorithmVersion?: string;
  model?: string;
  sourceRefs?: SourceRef[];
  maintenanceActionId?: string;
  createdAt?: string;
}

export interface MemoryPartition {
  partitionId: string;
  scope: ScopeRef;
  namespace: string;
  partitionKey: string;
  strategy: "workspace" | "entity" | "project" | "time" | "adaptive";
  status: "active" | "router" | "archived";
  parentPartitionId?: string;
  depth: number;
  childCount: number;
  objectCount: number;
  capacity: number;
  routingKeys: string[];
  version: number;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryObject {
  objectId: string;
  scope: ScopeRef;
  partitionId: string;
  objectType: "entity" | "topic" | "project" | "person" | "work" | "decision" | "problem" | "adaptive";
  title: string;
  summary: string;
  routingKeys: string[];
  entityKeys: string[];
  status: MemoryObjectStatus;
  temperature: MemoryTemperatureTier;
  parentObjectId?: string;
  tokenEstimate: number;
  childCount: number;
  memberCount: number;
  confidence: number;
  evidenceRefs: SourceRef[];
  validFrom?: string;
  validTo?: string;
  version: number;
  schemaVersion: number;
  embeddingVersion?: string;
  summarizerVersion: string;
  createdAt: string;
  updatedAt: string;
  provenance: MemoryProvenance;
}

export interface MemoryObjectMember {
  objectId: string;
  memberType: Exclude<MemoryNodeType, "policy">;
  memberId: string;
  role: "evidence" | "semantic" | "episode" | "child" | "route";
  score: number;
  status: "active" | "removed";
  addedAt: string;
  updatedAt: string;
  originActionId?: string;
}

export interface MemoryRelation {
  relationId: string;
  scope: ScopeRef;
  from: { type: MemoryNodeType; id: string };
  to: { type: MemoryNodeType; id: string };
  relation: MemoryRelationType;
  confidence: number;
  status: "active" | "disputed" | "superseded" | "revoked";
  evidenceRefs: SourceRef[];
  validFrom?: string;
  validTo?: string;
  version: number;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  provenance: MemoryProvenance;
}

export interface MemoryVersion {
  versionId: string;
  memoryType: Exclude<MemoryNodeType, "raw"> | "partition" | "contradiction";
  memoryId: string;
  version: number;
  operation: "create" | "update" | "rename" | "merge" | "split" | "reorganize" | "archive" | "restore";
  before?: unknown;
  after?: unknown;
  evidenceRefs: SourceRef[];
  maintenanceActionId?: string;
  createdAt: string;
  provenance: MemoryProvenance;
}

export interface Contradiction {
  contradictionId: string;
  scope: ScopeRef;
  oldClaim: { claimId: string; version: number; confidence: number };
  newClaim: { claimId: string; version: number; confidence: number };
  evidenceRefs: SourceRef[];
  currentPreferredClaim?: { claimId: string; version: number };
  status: "unresolved" | "resolved" | "temporal" | "coexisting";
  resolutionReason?: string;
  validFrom?: string;
  validTo?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryTemperature {
  memoryType: "episode" | "semantic" | "object";
  memoryId: string;
  scope: ScopeRef;
  tier: MemoryTemperatureTier;
  score: number;
  accessCount: number;
  retrievalCount: number;
  mentionCount: number;
  lastAccessedAt?: string;
  lastMentionedAt?: string;
  explicitRemember: boolean;
  activeProject: boolean;
  pinned: boolean;
  updatedAt: string;
}

export interface MemoryQualityMetrics {
  ownerType: "global" | "partition" | "object";
  ownerId: string;
  scope: ScopeRef;
  candidateCount: number;
  /** Number of retrieval traces that routed through this owner. */
  retrievalSamples?: number;
  /** Supported (non-singleton) semantic/entity clusters inside an object. */
  subtopicClusterCount?: number;
  /** Average fraction of peer routes selected alongside this object. */
  queryHitDispersion?: number;
  /** Similarity between the locator summary and current member evidence. */
  summaryFidelity?: number;
  /** Fraction of routed traces that returned content from this object. */
  localUseRatio?: number;
  precisionProxy: number;
  recallProxy: number;
  averageExpansionDepth: number;
  evidenceCoverage: number;
  contradictionRate: number;
  staleSummaryRate: number;
  orphanRate: number;
  maintenanceBacklog: number;
  measuredAt: string;
}

export interface MemoryRiskProfile {
  factualRecall: boolean;
  quoteRecall: boolean;
  entityConfusion: boolean;
  temporalConfusion: boolean;
  contradictionRisk: boolean;
  narrativeCompletionRisk: boolean;
  lowEvidenceRisk: boolean;
  inferenceAllowed: boolean;
  retrievalDepth: "object" | "episode" | "raw";
  topK: number;
  confidenceLanguage: "normal" | "qualified" | "strict";
}

export interface MemoryQueryAnalysis {
  entities: string[];
  topics: string[];
  temporalHints: string[];
  taskType: "factual_recall" | "quote_recall" | "analysis" | "general";
  explicitArchiveLookup: boolean;
}

export interface MemoryRetrievalItem {
  memoryId: string;
  memoryType: "raw" | "episode" | "semantic" | "object";
  content: string;
  score: number;
  confidence: number;
  evidenceRefs: SourceRef[];
  sourceType: "direct" | "derived" | "inferred" | "unresolved_contradiction";
  timestamp?: string;
  contradictions?: string[];
  objectId?: string;
  partitionId?: string;
}

export interface RetrievalTrace {
  retrievalId: string;
  turnId: string;
  scope: ScopeRef;
  query: string;
  strategy: string;
  riskProfile: MemoryRiskProfile;
  analysis: MemoryQueryAnalysis;
  routedPartitionIds: string[];
  routedObjectIds: string[];
  returnedMemoryIds: string[];
  returnedObjectIds: string[];
  stages: Array<{
    name: "query_analysis" | "risk" | "route" | "local_recall" | "episode_expand" | "raw_expand" | "verify";
    candidateCount: number;
    returnedCount: number;
    durationMs: number;
  }>;
  candidateCount: number;
  returnedCount: number;
  expansionDepth: number;
  evidenceCoverage: number;
  shouldAbstain: boolean;
  createdAt: string;
}

export interface MemoryRetrievalResult {
  protocolVersion: ProtocolVersion;
  retrievalId: string;
  turnId: string;
  query: string;
  strategy: string;
  riskProfile: MemoryRiskProfile;
  analysis: MemoryQueryAnalysis;
  memories: MemoryRetrievalItem[];
  unresolvedQuestions: string[];
  unresolvedContradictions: Contradiction[];
  evidenceCoverage: number;
  shouldAbstain: boolean;
  trace: RetrievalTrace;
  untrustedEvidenceNotice: string;
}

export type MaintenanceJobType =
  | "scan"
  | "ingest"
  | "merge"
  | "split"
  | "rename"
  | "reorganize"
  | "refresh_summary"
  | "temperature"
  | "archive"
  | "reindex"
  | "integrity_check"
  | "quality";

export type MaintenanceJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface MaintenanceJob {
  jobId: string;
  scope: ScopeRef;
  type: MaintenanceJobType;
  status: MaintenanceJobStatus;
  dryRun: boolean;
  idempotencyKey: string;
  attempts: number;
  cursor?: string;
  payload: Record<string, unknown>;
  availableAt: string;
  leasedAt?: string;
  completedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceAction {
  actionId: string;
  jobId: string;
  sequence: number;
  type: "create_object" | "attach" | "detach" | "merge" | "split" | "move" | "rename" | "temperature" | "archive" | "summary" | "relation" | "reindex";
  targetType: "partition" | "object" | "relation" | "episode" | "semantic" | "index";
  targetId: string;
  status: "planned" | "applied" | "rolled_back" | "failed";
  reason: string;
  algorithmVersion: string;
  reversible: boolean;
  before?: unknown;
  after?: unknown;
  rollbackToken?: string;
  createdAt: string;
  appliedAt?: string;
  rolledBackAt?: string;
}

export interface MaintenanceRunResult {
  job: MaintenanceJob;
  actions: MaintenanceAction[];
  metrics: MemoryQualityMetrics[];
}

export interface Counterexample {
  correctionId: string;
  wrongStatement: string;
  correction: string;
  lesson?: string;
  source: SourceRef;
}

export interface MemoryReexperiencePack {
  /** Recent visible events, normally covering the latest 20-50 turns. */
  recentSourceRefs: SourceRef[];
  recentEvents: SourceEvent[];
  /** Complete narrative chunks selected from older history. */
  historicalEpisodes: EpisodeMemory[];
  historicalEvents: SourceEvent[];
  keyEventRefs: SourceRef[];
  keyEvents: SourceEvent[];
  emotionalEventRefs: SourceRef[];
  emotionalEvents: SourceEvent[];
  /** Reviewed correction evidence selected by the same workset budget. */
  correctionSourceRefs: SourceRef[];
  corrections: Counterexample[];
  factConstraints: WorldClaim[];
  window: {
    requestedTurns: number;
    includedTurns: number;
    startedAt?: string;
    endedAt?: string;
  };
}

export interface MemoryBundle {
  protocolVersion: ProtocolVersion;
  turnId: string;
  snapshotRevision: number;
  indexRevision: number;
  stage: RetrievalStageName;
  worldClaims: WorldClaim[];
  episodes: EpisodeMemory[];
  /** Direct FTS source hits for source_expansion; expand content with memory_get_sources. */
  sourceRefs: SourceRef[];
  policies: PolicyRef[];
  counterexamples: Counterexample[];
  conflicts: WorldClaim[];
  reexperiencePack?: MemoryReexperiencePack;
  sourceCoverage: number;
  trace: {
    query: string;
    strategies: string[];
    candidateCount: number;
    returnedCount: number;
    nextCursor?: string;
    strategyId?: string;
    rankingSignals?: PlanRetrievalSignal[];
    coverageReranked?: boolean;
  };
  untrustedEvidenceNotice: string;
}

export interface VerifierResult {
  status: "pass" | "retry" | "clarify" | "abstain";
  sourceCoverage: number;
  policyViolations: string[];
  unsupportedClaims: string[];
  conflicts: string[];
  message?: string;
}

export interface BeginTurnInput {
  input: InputEvent;
  scope: ScopeRef & { sessionId: string };
  agentProfile: AgentProfile;
}

/** Adapter-only ingestion endpoint; this is intentionally not exposed as an MCP tool. */
export interface RecordEventInput {
  input: InputEvent;
  scope: ScopeRef & { sessionId: string };
  agentProfile: AgentProfile;
  selectedEvidence?: boolean;
}

export interface CheckpointEvidenceInput {
  turnId: string;
  observations: Observation[];
}

export interface CheckpointEvidenceResult {
  plan: TurnPlan;
  observations: Array<{
    observationId: string;
    kind: Observation["kind"];
    source: SourceRef;
  }>;
  evidenceRefs: SourceRef[];
}

export interface RecallInput {
  turnId: string;
  stage: RetrievalStageName;
  query: string;
  budgetTokens?: number;
  cursor?: string;
  /** Used by the reexperience stage; clamped to 20-50. */
  recentTurns?: number;
}

/** Coarse-to-fine object routed retrieval. Existing memory_recall remains available. */
export interface RetrieveMemoryInput {
  turnId: string;
  query: string;
  budgetTokens?: number;
  limit?: number;
  /** Archive is opt-in and never joined into the default candidate set. */
  includeArchive?: boolean;
}

export interface RunMaintenanceInput {
  scope: ScopeRef;
  type?: MaintenanceJobType;
  dryRun?: boolean;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
}

export interface RollbackMaintenanceInput {
  actionId: string;
  idempotencyKey: string;
}

export interface BuildWorksetInput {
  turnId: string;
  query: string;
  budgetTokens?: number;
  recentTurns?: number;
  cursor?: string;
}

export type CorrectionKind = "fact" | "behavior" | "unknown";

export interface CorrectionInput {
  turnId: string;
  kind: CorrectionKind;
  wrongStatement?: string;
  correction: string;
  subject?: string;
  predicate?: string;
  value?: unknown;
  scopeLevel?: ScopeLevel;
  explicit: boolean;
  idempotencyKey: string;
  /** Self-reflection may create a candidate but never satisfies automatic learning thresholds. */
  origin?: "user_correction" | "self_reflection";
}

export interface EndSessionInput {
  scope: ScopeRef & { sessionId: string };
  endedAt?: string;
  idempotencyKey: string;
}

export interface EndSessionResult {
  sessionId: string;
  endedAt: string;
  expiredPolicyCount: number;
  closedEpisodeIds: string[];
}

export interface CompleteTurnInput {
  turnId: string;
  response: string;
  idempotencyKey: string;
  evidenceRefs: SourceRef[];
  verifierResult?: VerifierResult;
}

export interface CompleteTurnResult {
  turnId: string;
  eventId: string;
  verifier: VerifierResult;
  retryAllowed: boolean;
}

export interface ProtocolErrorShape {
  code:
    | "INVALID_REQUEST"
    | "TURN_NOT_FOUND"
    | "STAGE_BLOCKED"
    | "SCOPE_DENIED"
    | "VERSION_CONFLICT"
    | "NOT_FOUND"
    | "MEMORY_UNAVAILABLE";
  message: string;
  details?: Record<string, unknown>;
}

export class ProtocolError extends Error {
  constructor(
    public readonly shape: ProtocolErrorShape,
    options?: ErrorOptions,
  ) {
    super(shape.message, options);
    this.name = "ProtocolError";
  }
}
