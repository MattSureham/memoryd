import type {
  AgentProfile,
  CorrectionInput,
  EpisodeMemory,
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
}

export type SearchKind = "source_event" | "world_claim" | "policy" | "episode";

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
}
