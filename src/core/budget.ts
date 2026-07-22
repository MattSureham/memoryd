export const DEFAULT_RECALL_TOKENS = 8_000;
export const MAX_RECALL_TOKENS = 8_000;
export const MIN_RECALL_TOKENS = 512;
export const MAX_PREFLIGHT_TOKENS = 1_500;

export function normalizeRecallBudget(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_RECALL_TOKENS;
  return Math.max(MIN_RECALL_TOKENS, Math.min(MAX_RECALL_TOKENS, Math.floor(requested)));
}

export function estimateTokens(text: string): number {
  // Conservative cross-language estimate: CJK is often near one token per character.
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const other = Math.max(0, text.length - cjk);
  return cjk + Math.ceil(other / 4);
}

export function truncateToTokenBudget(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low)}\n[truncated to context budget]`;
}
