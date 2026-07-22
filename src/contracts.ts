export const PROTOCOL_VERSION = "1.0" as const;

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
  source: "rule" | "classifier" | "calibration";
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

export interface TurnPlan {
  protocolVersion: ProtocolVersion;
  turnId: string;
  snapshotRevision: number;
  agentProfileKey: string;
  risks: RiskScore[];
  modes: ModeLevels;
  retrievalStages: RetrievalStage[];
  gate: StageGate;
  activePolicies: PolicyRef[];
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
}

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
}

export interface Counterexample {
  correctionId: string;
  wrongStatement: string;
  correction: string;
  lesson?: string;
  source: SourceRef;
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
  sourceCoverage: number;
  trace: {
    query: string;
    strategies: string[];
    candidateCount: number;
    returnedCount: number;
    nextCursor?: string;
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
  scope: ScopeRef;
  agentProfile: AgentProfile;
}

/** Adapter-only ingestion endpoint; this is intentionally not exposed as an MCP tool. */
export interface RecordEventInput {
  input: InputEvent;
  scope: ScopeRef;
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
