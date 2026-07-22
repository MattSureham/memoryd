import type { PolicyRef, SourceRef, VerifierResult } from "../contracts.js";

export interface VerificationInput {
  response: string;
  evidenceRefs: SourceRef[];
  activePolicies: PolicyRef[];
  retryCount: number;
  unsupportedClaims?: string[];
  conflicts?: string[];
  policyViolations?: string[];
  expectedEvidenceClaims?: number;
}

function unique(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])];
}

export function verifyResponse(input: VerificationInput): VerifierResult {
  const unsupportedClaims = unique(input.unsupportedClaims);
  const conflicts = unique(input.conflicts);
  const policyViolations = unique(input.policyViolations);
  const expected = Math.max(0, input.expectedEvidenceClaims ?? (unsupportedClaims.length > 0 ? unsupportedClaims.length : 0));
  const sourceCoverage = expected === 0 ? (input.evidenceRefs.length > 0 ? 1 : 0) : Math.min(1, input.evidenceRefs.length / expected);
  const claimsMemoryWithoutEvidence =
    /\b(according to (?:my )?memory|I remember|from our previous)\b|根据(?:我的)?记忆|我记得|之前我们/i.test(input.response) &&
    input.evidenceRefs.length === 0;
  if (claimsMemoryWithoutEvidence) unsupportedClaims.push("response claims recalled knowledge without a source reference");

  const hasFailure = unsupportedClaims.length > 0 || conflicts.length > 0 || policyViolations.length > 0;
  if (!hasFailure) {
    return { status: "pass", sourceCoverage, policyViolations, unsupportedClaims, conflicts };
  }

  if (input.retryCount < 1) {
    return {
      status: "retry",
      sourceCoverage,
      policyViolations,
      unsupportedClaims,
      conflicts,
      message: "Retry once with a stricter evidence plan and only supported claims.",
    };
  }

  const status = conflicts.length > 0 ? "clarify" : "abstain";
  return {
    status,
    sourceCoverage,
    policyViolations,
    unsupportedClaims,
    conflicts,
    message:
      status === "clarify"
        ? "Conflicting evidence remains; ask the user to resolve it."
        : "Evidence remains insufficient; decline the unsupported inference and state uncertainty.",
  };
}
