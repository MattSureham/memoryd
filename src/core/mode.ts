import { PROTOCOL_VERSION, type AgentProfile, type PolicyRef, type RetrievalStage, type RiskCode, type RiskScore, type TurnPlan } from "../contracts.js";
import { orderPolicies } from "./policy.js";

const GATED_RISKS = new Set<RiskCode>([
  "entity_or_symbol_merge",
  "stale_source",
  "wrong_workspace",
  "cross_session_merge",
  "unsupported_inference",
  "narrative_completion",
]);

function highest(risks: readonly RiskScore[], codes?: ReadonlySet<RiskCode>): number {
  return risks.reduce((current, risk) => {
    if (codes !== undefined && !codes.has(risk.code)) return current;
    return Math.max(current, risk.probability);
  }, 0);
}

function stages(gated: boolean): RetrievalStage[] {
  return [
    { name: "policy", order: 0, blockedUntilCheckpoint: false },
    { name: "current_evidence", order: 1, blockedUntilCheckpoint: false },
    { name: "world", order: 2, blockedUntilCheckpoint: gated },
    { name: "episode", order: 3, blockedUntilCheckpoint: gated },
    { name: "source_expansion", order: 4, blockedUntilCheckpoint: gated },
  ];
}

export interface BuildTurnPlanInput {
  turnId: string;
  snapshotRevision: number;
  profile: AgentProfile;
  risks: RiskScore[];
  policies: PolicyRef[];
  retryCount?: number;
  createdAt?: string;
}

export function agentProfileKey(profile: AgentProfile): string {
  return [profile.family, profile.version, profile.model ?? "unknown", profile.toolsetDigest ?? "unknown"].join(":");
}

export function buildTurnPlan(input: BuildTurnPlanInput): TurnPlan {
  const totalHigh = highest(input.risks) >= 0.7;
  const gatedProbability = highest(input.risks, GATED_RISKS);
  const gateRequired = gatedProbability >= 0.7;
  const narrative = input.risks.find((risk) => risk.code === "narrative_completion")?.probability ?? 0;
  const destructive = input.risks.find((risk) => risk.code === "destructive_action")?.probability ?? 0;

  return {
    protocolVersion: PROTOCOL_VERSION,
    turnId: input.turnId,
    snapshotRevision: input.snapshotRevision,
    agentProfileKey: agentProfileKey(input.profile),
    risks: input.risks,
    modes: {
      evidenceFirst: gateRequired ? "high" : totalHigh ? "medium" : "low",
      uncertainty: totalHigh ? "high" : highest(input.risks) >= 0.4 ? "medium" : "low",
      retrieveOriginalSource: totalHigh ? "high" : "medium",
      askClarification: destructive >= 0.7 ? "high" : totalHigh ? "medium" : "low",
      narrativeCompletionGate: narrative >= 0.7 ? "blocked" : narrative >= 0.4 ? "high" : "off",
    },
    retrievalStages: stages(gateRequired),
    gate: {
      kind: "evidence_checkpoint",
      required: gateRequired,
      satisfied: !gateRequired,
      ...(gateRequired ? { reason: "Current primary evidence must be locked before historical domain memory is exposed." } : {}),
    },
    activePolicies: orderPolicies(input.policies),
    enforcementLevel:
      input.profile.capabilities.hooks && input.profile.capabilities.stageGates ? "enforced" : "advisory",
    retryCount: input.retryCount ?? 0,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
