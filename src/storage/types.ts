import type {
  AgentProfile,
  CorrectionInput,
  Contradiction,
  EpisodeMemory,
  MaintenanceAction,
  MaintenanceJob,
  MemoryObject,
  MemoryObjectMember,
  MemoryPartition,
  MemoryQualityMetrics,
  MemoryRelation,
  MemoryTemperature,
  MemoryVersion,
  Observation,
  PolicyRef,
  ScopeRef,
  SourceEvent,
  SourceRef,
  TurnPlan,
  WorldClaim,
} from "../contracts.js";
import type { KeyMaterial } from "./crypto.js";

export interface MemoryStoreOptions {
  path: string;
  encryptionKey?: KeyMaterial;
  deviceId?: string;
  readonly?: boolean;
  now?: () => Date;
}

export interface AppendSourceEventArgs {
  input: {
    eventId?: string;
    idempotencyKey: string;
    kind: SourceEvent["kind"];
    content: string;
    occurredAt?: string;
    attachments?: SourceEvent["attachments"];
    metadata?: Record<string, unknown>;
  };
  scope: ScopeRef;
  agent: AgentProfile;
  selectedEvidence?: boolean;
}

export interface StoredTurn {
  turnId: string;
  revision: number;
  scope: ScopeRef;
  plan: TurnPlan;
  status: "active" | "completed" | "abandoned";
  createdAt: string;
  updatedAt: string;
}

export interface TurnUpdate {
  plan?: TurnPlan;
  gateSatisfied?: boolean;
  retryCount?: number;
  status?: StoredTurn["status"];
}

export interface StoredObservation extends Observation {
  observationId: string;
  turnId: string;
  revision: number;
  contentHash: string;
  createdAt: string;
}

export interface StoredPolicy extends PolicyRef {
  scope: ScopeRef;
  condition?: unknown;
  action?: unknown;
  dependencies?: string[];
  reviewStatus?: "candidate" | "approved" | "revoked";
  sources?: SourceRef[];
}

export interface PolicyApprovalEligibility {
  eligible: boolean;
  reason: string;
  correctionCount: number;
  sessionCount: number;
  clusterId?: string;
}

export interface StoredCorrection extends Omit<CorrectionInput, "turnId"> {
  correctionId: string;
  turnId: string;
  revision: number;
  scope: ScopeRef;
  source?: SourceRef;
  createdAt: string;
}

export interface StoredTrace {
  traceId: string;
  turnId: string;
  revision: number;
  scope: ScopeRef;
  createdAt: string;
  trace: Record<string, unknown>;
}

export interface TriggerRecord {
  triggerId: string;
  scope: ScopeRef;
  policyId?: string;
  riskCode?: string;
  condition: unknown;
  priority: number;
  activationCount: number;
  lastActivatedAt?: string;
  status?: "candidate" | "active" | "retired";
  learnedFromClusterId?: string;
  createdAt?: string;
  updatedAt?: string;
  sourceRefs?: SourceRef[];
}

export interface FailureClusterRecord {
  clusterId: string;
  scope: Pick<ScopeRef, "userId" | "workspaceId">;
  status: "candidate" | "reviewed" | "promoted" | "rejected";
  correctionIds: string[];
  sessionIds: string[];
  signature: unknown;
}

export interface CalibrationPatternRecord {
  patternId: string;
  agentProfileKey: string;
  status: "shadow" | "active" | "retired";
  riskCode: string;
  pattern: unknown;
  metrics?: Record<string, number>;
  sourceRefs?: SourceRef[];
}

export interface StoredEmbedding {
  ownerType: SearchKind;
  ownerId: string;
  provider: string;
  model: string;
  vector: number[];
  revision: number;
  occurredAt?: string;
  sessionId?: string;
}

export interface EntityOwnerHit {
  kind: SearchKind;
  id: string;
  distance: number;
}

export interface OwnerMetadata {
  kind: SearchKind;
  id: string;
  revision: number;
  occurredAt?: string;
  sessionId?: string;
}

export interface MemoryObjectRouteHit {
  object: MemoryObject;
  score: number;
  exact: boolean;
}

export interface MaintenanceAuditRecord {
  auditId: string;
  revision: number;
  scope: ScopeRef;
  jobId?: string;
  actionId?: string;
  event: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface SourceEventListOptions {
  includeAllSessions?: boolean;
  maxRevision?: number;
  limit?: number;
  kinds?: SourceEvent["kind"][];
}

export interface SessionLifecycleRecord {
  scope: ScopeRef & { sessionId: string };
  status: "active" | "ended";
  startedAt: string;
  endedAt?: string;
  endIdempotencyKey?: string;
  revision: number;
}

export type LearningJobType =
  | "analyze_cluster"
  | "evaluate_calibration"
  | "index_embedding"
  | "rebuild_entity_graph"
  | "segment_session";

export interface LearningJobRecord {
  jobId: string;
  revision: number;
  idempotencyKey: string;
  scope: ScopeRef;
  type: LearningJobType;
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  availableAt: string;
  leasedAt?: string;
  lastError?: string;
  payload: Record<string, unknown>;
}

export interface TriggerActivationRecord {
  activationId: string;
  revision: number;
  triggerId: string;
  turnId: string;
  scope: ScopeRef;
  structuralScore: number;
  similarityScore: number;
  effectiveScore: number;
  activatedAt: string;
}

export type SearchKind = "source_event" | "world_claim" | "policy" | "episode" | "memory_object";

export interface SearchHit {
  kind: SearchKind;
  id: string;
  score: number;
  sourceRefs: SourceRef[];
}

export interface StorageSearchResult {
  snapshotRevision: number;
  indexRevision: number;
  candidateCount: number;
  hits: SearchHit[];
  eventRefs: SourceRef[];
  worldClaims: WorldClaim[];
  policies: StoredPolicy[];
  episodes: EpisodeMemory[];
  memoryObjects: MemoryObject[];
}

export interface SearchOptions {
  limit?: number;
  kinds?: SearchKind[];
  includeInactive?: boolean;
  /** Upper bound fixed by begin_turn so a turn cannot observe later writes. */
  maxRevision?: number;
}

export interface ForgetSelector extends ScopeRef {
  entityType?: string;
  entityId?: string;
  reason?: string;
}

export interface ForgetResult {
  revision: number;
  deleted: Record<string, number>;
  tombstonesCreated: number;
}

export interface ExportOptions {
  encryptionKey?: KeyMaterial;
}

export interface ImportOptions extends ExportOptions {
  allowDifferentUser?: boolean;
}

export interface ImportResult {
  imported: Record<string, number>;
  skipped: number;
  conflicts: Array<{ entityType: string; entityId: string; reason: string }>;
  revision: number;
}

export interface ReindexResult {
  indexRevision: number;
  indexed: Record<string, number>;
}

export interface StoreHealth {
  ok: boolean;
  schemaVersion: number;
  journalMode: string;
  revision: number;
  indexRevision: number;
  ftsAvailable: boolean;
  integrityCheck: string;
  eventCount: number;
  issues: string[];
  pendingLearningJobs?: number;
  failedLearningJobs?: number;
  endedSessions?: number;
  embeddingCount?: number;
  entityEdgeCount?: number;
  memoryObjectCount?: number;
  partitionCount?: number;
  pendingMaintenanceJobs?: number;
  failedMaintenanceJobs?: number;
  maintenanceBacklog?: number;
}

export type {
  Contradiction,
  MaintenanceAction,
  MaintenanceJob,
  MemoryObject,
  MemoryObjectMember,
  MemoryPartition,
  MemoryQualityMetrics,
  MemoryRelation,
  MemoryTemperature,
  MemoryVersion,
};
