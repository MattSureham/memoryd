import type { PolicyRef, ScopeLevel } from "../contracts.js";

const AUTHORITY_WEIGHT: Record<PolicyRef["authority"], number> = {
  user_explicit: 2,
  confirmed_learned: 1,
};

const SCOPE_WEIGHT: Record<ScopeLevel, number> = {
  session: 3,
  workspace: 2,
  user: 1,
};

export function comparePolicies(left: PolicyRef, right: PolicyRef): number {
  const authority = AUTHORITY_WEIGHT[right.authority] - AUTHORITY_WEIGHT[left.authority];
  if (authority !== 0) return authority;
  const scope = SCOPE_WEIGHT[right.scopeLevel] - SCOPE_WEIGHT[left.scopeLevel];
  if (scope !== 0) return scope;
  if (left.policyId === right.policyId) return right.version - left.version;
  return left.policyId.localeCompare(right.policyId);
}

export function orderPolicies(policies: readonly PolicyRef[]): PolicyRef[] {
  const latest = new Map<string, PolicyRef>();
  for (const policy of policies) {
    const current = latest.get(policy.policyId);
    if (current === undefined || policy.version > current.version) latest.set(policy.policyId, policy);
  }
  return [...latest.values()].sort(comparePolicies);
}
