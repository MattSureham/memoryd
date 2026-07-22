import * as z from "zod/v4";

export const ScopeSchema = z.object({
  userId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
});

export const TurnScopeSchema = ScopeSchema.extend({
  sessionId: z.string().min(1),
});

export const AgentProfileSchema = z.object({
  family: z.string().min(1),
  version: z.string().min(1),
  model: z.string().optional(),
  toolsetDigest: z.string().optional(),
  capabilities: z.object({
    hooks: z.boolean(),
    stageGates: z.boolean(),
    maxContextTokens: z.number().int().positive().optional(),
    modalities: z.array(z.string()).optional(),
  }),
});

export const AttachmentSchema = z.object({
  uri: z.string().min(1),
  mediaType: z.string().optional(),
  contentHash: z.string().optional(),
});

export const InputEventSchema = z.object({
  eventId: z.string().optional(),
  idempotencyKey: z.string().min(1),
  kind: z.enum([
    "user_message",
    "assistant_message",
    "tool_call",
    "tool_result",
    "attachment",
    "checkpoint",
    "compaction",
  ]),
  content: z.string(),
  occurredAt: z.iso.datetime().optional(),
  attachments: z.array(AttachmentSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const BeginTurnSchema = z.object({
  input: InputEventSchema,
  scope: TurnScopeSchema,
  agentProfile: AgentProfileSchema,
});

export const ObservationSchema = z.object({
  observationId: z.string().optional(),
  kind: z.enum(["current_file", "image", "test", "command", "user_statement"]),
  content: z.string().min(1),
  source: z
    .object({
      eventId: z.string().optional(),
      sessionId: z.string().optional(),
      contentHash: z.string().optional(),
      capturedAt: z.string().optional(),
      workspaceId: z.string().optional(),
      startOffset: z.number().int().nonnegative().optional(),
      endOffset: z.number().int().nonnegative().optional(),
      path: z.string().optional(),
      commit: z.string().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const CheckpointEvidenceSchema = z.object({
  turnId: z.string().min(1),
  observations: z.array(ObservationSchema).min(1),
});

export const RetrievalStageSchema = z.enum([
  "policy",
  "current_evidence",
  "world",
  "episode",
  "source_expansion",
]);

export const RecallSchema = z.object({
  turnId: z.string().min(1),
  stage: RetrievalStageSchema,
  query: z.string(),
  budgetTokens: z.number().int().positive().optional(),
  cursor: z.string().optional(),
});

export const SourceRefSchema = z.object({
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  contentHash: z.string().min(1),
  capturedAt: z.string().min(1),
  workspaceId: z.string().optional(),
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
  path: z.string().optional(),
  commit: z.string().optional(),
});

export const CorrectionSchema = z.object({
  turnId: z.string().min(1),
  kind: z.enum(["fact", "behavior", "unknown"]),
  wrongStatement: z.string().optional(),
  correction: z.string().min(1),
  subject: z.string().optional(),
  predicate: z.string().optional(),
  value: z.unknown().optional(),
  scopeLevel: z.enum(["user", "workspace", "session"]).optional(),
  explicit: z.boolean(),
  idempotencyKey: z.string().min(1),
});

export const VerifierResultSchema = z.object({
  status: z.enum(["pass", "retry", "clarify", "abstain"]),
  sourceCoverage: z.number().min(0).max(1),
  policyViolations: z.array(z.string()),
  unsupportedClaims: z.array(z.string()),
  conflicts: z.array(z.string()),
  message: z.string().optional(),
});

export const CompleteTurnSchema = z.object({
  turnId: z.string().min(1),
  response: z.string(),
  idempotencyKey: z.string().min(1),
  evidenceRefs: z.array(SourceRefSchema),
  verifierResult: VerifierResultSchema.optional(),
});
