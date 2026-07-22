import { PROTOCOL_VERSION, type AgentProfile, type PolicyRef, type PolicySchedule, type RetrievalStage, type RetrievalStageName, type RiskCode, type RiskScore, type TurnPlan } from "../contracts.js";
import { orderPolicies } from "./policy.js";
import { buildDynamicRetrievalStrategy } from "./retrieval.js";

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

function stages(gated: boolean, risks: readonly RiskScore[]): RetrievalStage[] {
  const dominant = [...risks]
    .filter((risk) => risk.probability >= 0.4)
    .sort((left, right) => right.probability - left.probability || left.code.localeCompare(right.code))[0]?.code;
  const ordered: RetrievalStageName[] = dominant === "entity_or_symbol_merge"
    ? ["policy", "current_evidence", "world", "source_expansion", "episode", "reexperience"]
    : dominant === "narrative_completion"
      ? ["current_evidence", "policy", "source_expansion", "episode", "reexperience", "world"]
      : dominant === "stale_source"
        ? ["current_evidence", "policy", "source_expansion", "world", "episode", "reexperience"]
        : dominant === "cross_session_merge" || dominant === "unsupported_inference"
          ? ["policy", "current_evidence", "source_expansion", "episode", "reexperience", "world"]
          : ["policy", "current_evidence", "world", "episode", "reexperience", "source_expansion"];
  return ordered.map((name, order) => ({
    name,
    order,
    blockedUntilCheckpoint: gated && !["policy", "current_evidence"].includes(name),
  }));
}

export interface BuildTurnPlanInput {
  turnId: string;
  snapshotRevision: number;
  profile: AgentProfile;
  risks: RiskScore[];
  policies: PolicyRef[];
  policySchedule?: PolicySchedule;
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
    retrievalStages: stages(gateRequired, input.risks),
    gate: {
      kind: "evidence_checkpoint",
      required: gateRequired,
      satisfied: !gateRequired,
      ...(gateRequired ? { reason: "Current primary evidence must be locked before historical domain memory is exposed." } : {}),
    },
    activePolicies: orderPolicies(input.policies),
    ...(input.policySchedule === undefined ? {} : { policySchedule: input.policySchedule }),
    retrievalStrategy: buildDynamicRetrievalStrategy(input.risks),
    enforcementLevel:
      input.profile.capabilities.hooks && input.profile.capabilities.stageGates ? "enforced" : "advisory",
    retryCount: input.retryCount ?? 0,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
