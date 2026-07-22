import type { AgentProfile, RiskCode } from "../contracts.js";
import type { RiskClassifier } from "../core/risk.js";

const RISK_CODES = new Set<RiskCode>([
  "entity_or_symbol_merge",
  "stale_source",
  "wrong_workspace",
  "cross_session_merge",
  "unsupported_inference",
  "narrative_completion",
  "destructive_action",
  "secret_exposure",
]);

export interface HttpRiskClassifierOptions {
  url: string;
  bearerToken?: string;
}

/**
 * Optional classifier adapter. Its request contains only the compressed feature
 * projection produced by core/features.ts; raw prompts and stored memory never
 * cross this boundary.
 */
export class HttpRiskClassifier implements RiskClassifier {
  constructor(private readonly options: HttpRiskClassifierOptions) {}

  async classify(
    features: Readonly<Record<string, unknown>>,
    profile: Readonly<AgentProfile>,
    signal: AbortSignal,
  ): Promise<Partial<Record<RiskCode, number>>> {
    const response = await fetch(this.options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.bearerToken === undefined
          ? {}
          : { authorization: `Bearer ${this.options.bearerToken}` }),
      },
      body: JSON.stringify({
        schemaVersion: "1",
        features,
        agent: {
          family: profile.family,
          version: profile.version,
          model: profile.model ?? "unknown",
          toolsetDigest: profile.toolsetDigest ?? "unknown",
        },
      }),
      signal,
    });
    if (!response.ok) throw new Error(`Risk classifier returned HTTP ${response.status}`);
    const payload = await response.json() as { risks?: unknown };
    if (payload.risks === null || typeof payload.risks !== "object") {
      throw new Error("Risk classifier response must contain a risks object");
    }

    const risks: Partial<Record<RiskCode, number>> = {};
    for (const [code, value] of Object.entries(payload.risks as Record<string, unknown>)) {
      if (!RISK_CODES.has(code as RiskCode) || typeof value !== "number" || !Number.isFinite(value)) continue;
      risks[code as RiskCode] = Math.max(0, Math.min(1, value));
    }
    return risks;
  }
}

export function riskClassifierFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): HttpRiskClassifier | undefined {
  const url = environment.MEMORYD_RISK_CLASSIFIER_URL;
  if (url === undefined || url.length === 0) return undefined;
  return new HttpRiskClassifier({
    url,
    ...(environment.MEMORYD_RISK_CLASSIFIER_TOKEN === undefined
      ? {}
      : { bearerToken: environment.MEMORYD_RISK_CLASSIFIER_TOKEN }),
  });
}
