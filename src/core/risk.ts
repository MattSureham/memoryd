import type {
  AgentProfile,
  RiskCode,
  RiskContribution,
  RiskScore,
} from "../contracts.js";
import { compressedClassifierFeatures, type TaskFeatures } from "./features.js";

export interface RiskClassifier {
  classify(
    features: Readonly<Record<string, unknown>>,
    profile: Readonly<AgentProfile>,
    signal: AbortSignal,
  ): Promise<Partial<Record<RiskCode, number>>>;
}

export interface RecognizeRiskOptions {
  classifier?: RiskClassifier;
  timeoutMs?: number;
  calibration?: Partial<Record<RiskCode, number>>;
}

const RISK_CODES: RiskCode[] = [
  "entity_or_symbol_merge",
  "stale_source",
  "wrong_workspace",
  "cross_session_merge",
  "unsupported_inference",
  "narrative_completion",
  "destructive_action",
  "secret_exposure",
];

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function add(
  target: Map<RiskCode, RiskContribution[]>,
  code: RiskCode,
  score: number,
  reason: string,
  source: RiskContribution["source"] = "rule",
): void {
  const contributions = target.get(code) ?? [];
  contributions.push({ source, score: clampScore(score), reason });
  target.set(code, contributions);
}

export function deterministicRiskContributions(
  features: TaskFeatures,
): Map<RiskCode, RiskContribution[]> {
  const found = new Map<RiskCode, RiskContribution[]>();

  if (features.multipleEntities && (features.asksForIdentity || features.asksToRecall)) {
    add(found, "entity_or_symbol_merge", features.contextAge === "long" ? 0.82 : 0.68, "multiple entities combined with identity or recall intent");
  }
  if (features.taskType === "coding" && features.likelyStaleReference && !features.hasCurrentEvidence) {
    add(found, "stale_source", 0.82, "historical code is requested before current source evidence");
  }
  if (features.mentionsOtherWorkspace || !features.workspacePresent) {
    add(found, "wrong_workspace", features.mentionsOtherWorkspace ? 0.9 : 0.42, "workspace identity is missing or another workspace is referenced");
  }
  if (features.asksToRecall && (features.contextAge === "long" || features.multipleEntities)) {
    add(found, "cross_session_merge", features.contextAge === "long" ? 0.78 : 0.62, "recall spans old context with ambiguous entities");
  }
  if (features.asksForVisibleDetail && !features.hasCurrentEvidence) {
    add(found, "unsupported_inference", 0.76, "visible detail is requested without a locked observation");
  }
  if (features.hasImage && features.narrativeCue) {
    add(found, "narrative_completion", 0.88, "visual evidence and narrative cues are present together");
  }
  if (features.destructiveIntent) {
    add(found, "destructive_action", 0.98, "request contains a destructive operation");
  }
  if (features.containsSecretMaterial) {
    add(found, "secret_exposure", 0.99, "input appears to contain credential material");
  }

  return found;
}

async function classifyWithTimeout(
  classifier: RiskClassifier,
  features: TaskFeatures,
  profile: AgentProfile,
  timeoutMs: number,
): Promise<Partial<Record<RiskCode, number>>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("risk classifier timeout")), timeoutMs);
  try {
    return await Promise.race([
      classifier.classify(compressedClassifierFeatures(features), profile, controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function recognizeRisks(
  features: TaskFeatures,
  profile: AgentProfile,
  options: RecognizeRiskOptions = {},
): Promise<RiskScore[]> {
  const contributions = deterministicRiskContributions(features);

  if (options.classifier !== undefined) {
    try {
      const classified = await classifyWithTimeout(
        options.classifier,
        features,
        profile,
        options.timeoutMs ?? 1_500,
      );
      for (const code of RISK_CODES) {
        const score = classified[code];
        if (score !== undefined && clampScore(score) > 0) {
          add(contributions, code, score, "compressed-feature classifier", "classifier");
        }
      }
    } catch {
      // Rules remain authoritative when an optional classifier is absent or times out.
    }
  }

  for (const code of RISK_CODES) {
    const score = options.calibration?.[code];
    if (score !== undefined && clampScore(score) > 0) {
      add(contributions, code, score, "agent-profile calibration overlay", "calibration");
    }
  }

  return RISK_CODES.flatMap((code) => {
    const items = contributions.get(code);
    if (items === undefined || items.length === 0) return [];
    return [{ code, probability: Math.max(...items.map((item) => item.score)), contributions: items }];
  }).sort((left, right) => right.probability - left.probability);
}
