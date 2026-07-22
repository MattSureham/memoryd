/**
 * A synchronous embedding interface for local retrieval providers.
 *
 * Implementations must treat input text as ephemeral. In particular, callers
 * may persist the returned vector, but must not persist the original text as
 * embedding metadata.
 */
export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): number[];
}

export type SynonymMap = Readonly<Record<string, readonly string[]>>;

export const DEFAULT_SYNONYM_MAP: SynonymMap = {
  code: ["source", "source code", "codebase", "源码", "代码"],
  error: ["bug", "defect", "failure", "fault", "crash", "错误", "故障", "问题", "崩溃"],
  fix: ["repair", "resolve", "correct", "修复", "解决"],
  image: ["picture", "photo", "screenshot", "图像", "图片", "照片", "截图"],
  recall: ["remember", "memory", "recollect", "记得", "记忆", "回忆"],
  remove: ["delete", "erase", "drop", "删除", "移除", "清除"],
  repository: ["repo", "project repository", "仓库", "代码库"],
  test: ["check", "verify", "validation", "测试", "验证", "检查"],
};

export interface LocalHashEmbeddingOptions {
  /** Feature-hash vector width. Defaults to 384. */
  dimensions?: number;
  /** Inclusive character n-gram range. Defaults to 2..5. */
  characterNgrams?: readonly [number, number];
  /** Inclusive token n-gram range. Defaults to 1..3. */
  wordNgrams?: readonly [number, number];
  /** Canonical concept -> aliases. Custom groups are merged with defaults. */
  synonyms?: SynonymMap;
  includeDefaultSynonyms?: boolean;
}

export interface EntityTokenExtractor {
  extract(text: string): readonly string[];
}

export interface EntityExtractionOptions {
  maxTokens?: number;
  maxTokenLength?: number;
  minLatinLength?: number;
  stopWords?: readonly string[];
  /** Additional pure extractors for domain-specific symbols or identifiers. */
  additionalExtractors?: readonly ((sanitizedText: string) => readonly string[])[];
}

const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/giu;
const KNOWN_SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/gu;
const AUTHORIZATION_SECRET = /(\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/giu;
const ASSIGNED_SECRET = /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|client[_-]?secret)\b\s*(?::|=)\s*["']?)[^\s,"';]+/giu;
const LONG_SECRETISH = /\b(?:[A-Fa-f0-9]{40,}|[A-Za-z0-9+/]{48,}={0,2})\b/gu;
const SECRET_MARKER = " memorysecretmarker ";

/**
 * Removes values that must never become vector or entity features. This is a
 * pure transformation; it intentionally exposes no list of matched secrets.
 */
export function redactEmbeddingSecrets(text: string): string {
  return text
    .replace(PRIVATE_KEY, SECRET_MARKER)
    .replace(KNOWN_SECRET, SECRET_MARKER)
    .replace(AUTHORIZATION_SECRET, `$1${SECRET_MARKER}`)
    .replace(ASSIGNED_SECRET, `$1${SECRET_MARKER}`)
    .replace(LONG_SECRETISH, SECRET_MARKER);
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function normalizeLexeme(value: string): string {
  return normalizeText(value)
    .replace(/^[\s"'`“”‘’()[\]{}<>]+|[\s"'`“”‘’()[\]{}<>]+$/gu, "")
    .replace(/\s+/gu, " ");
}

function checkedRange(
  range: readonly [number, number] | undefined,
  fallback: readonly [number, number],
): readonly [number, number] {
  const minimum = Math.floor(range?.[0] ?? fallback[0]);
  const maximum = Math.floor(range?.[1] ?? fallback[1]);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 1 || maximum < minimum || maximum > 8) {
    throw new RangeError("n-gram range must satisfy 1 <= minimum <= maximum <= 8");
  }
  return [minimum, maximum];
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function addHashedFeature(vector: number[], feature: string, weight: number): void {
  const index = fnv1a(`index:${feature}`) % vector.length;
  const sign = (fnv1a(`sign:${feature}`) & 1) === 0 ? 1 : -1;
  vector[index] = (vector[index] ?? 0) + sign * weight;
}

function lexicalTokens(text: string): string[] {
  const raw = text.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+(?:[_./:@#-][\p{L}\p{N}]+)*/gu) ?? [];
  const tokens: string[] = [];
  for (const token of raw) {
    if (token === "memorysecretmarker") continue;
    if (/^\p{Script=Han}+$/u.test(token)) {
      // A whole Han run preserves names; overlapping 2/3-grams give Chinese
      // phrases useful lexical overlap without an external segmenter.
      tokens.push(token);
      const characters = [...token];
      for (const size of [2, 3]) {
        for (let index = 0; index + size <= characters.length; index += 1) {
          tokens.push(characters.slice(index, index + size).join(""));
        }
      }
    } else {
      tokens.push(token);
    }
  }
  return tokens;
}

function normalizedSynonyms(
  custom: SynonymMap | undefined,
  includeDefaults: boolean,
): Map<string, string> {
  const aliases = new Map<string, string>();
  const dictionaries = [includeDefaults ? DEFAULT_SYNONYM_MAP : undefined, custom];
  for (const dictionary of dictionaries) {
    if (dictionary === undefined) continue;
    for (const [rawCanonical, rawAliases] of Object.entries(dictionary)) {
      const canonical = normalizeLexeme(rawCanonical);
      if (canonical.length === 0 || canonical === "memorysecretmarker") continue;
      aliases.set(canonical, canonical);
      for (const rawAlias of rawAliases) {
        const alias = normalizeLexeme(rawAlias);
        if (alias.length > 0 && alias !== "memorysecretmarker") aliases.set(alias, canonical);
      }
    }
  }
  return aliases;
}

function unitNormalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

/**
 * Deterministic, dependency-free embedding provider for local-first recall.
 * It stores no source text or cache: only the caller owns the returned vector.
 */
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "local";
  readonly model: string;
  readonly dimensions: number;

  readonly #characterNgrams: readonly [number, number];
  readonly #wordNgrams: readonly [number, number];
  readonly #synonyms: ReadonlyMap<string, string>;

  constructor(options: LocalHashEmbeddingOptions = {}) {
    const dimensions = Math.floor(options.dimensions ?? 384);
    if (!Number.isFinite(dimensions) || dimensions < 32 || dimensions > 16_384) {
      throw new RangeError("embedding dimensions must be between 32 and 16384");
    }
    this.dimensions = dimensions;
    this.#characterNgrams = checkedRange(options.characterNgrams, [2, 5]);
    this.#wordNgrams = checkedRange(options.wordNgrams, [1, 3]);
    this.#synonyms = normalizedSynonyms(options.synonyms, options.includeDefaultSynonyms !== false);
    this.model = `hash-ngram-v1-${dimensions}`;
  }

  embed(text: string): number[] {
    const sanitized = normalizeText(redactEmbeddingSecrets(text));
    const vector = Array.from<number>({ length: this.dimensions }).fill(0);
    if (sanitized.length === 0) return vector;

    const tokens = lexicalTokens(sanitized);
    const [minimumWords, maximumWords] = this.#wordNgrams;
    for (let size = minimumWords; size <= maximumWords; size += 1) {
      for (let index = 0; index + size <= tokens.length; index += 1) {
        const phrase = tokens.slice(index, index + size).join(" ");
        addHashedFeature(vector, `word:${phrase}`, size === 1 ? 1.25 : 0.8 / size);
        const canonical = this.#synonyms.get(phrase);
        if (canonical !== undefined) addHashedFeature(vector, `concept:${canonical}`, 4);
      }
    }

    const [minimumCharacters, maximumCharacters] = this.#characterNgrams;
    for (const token of tokens) {
      const characters = [...token];
      for (let size = minimumCharacters; size <= maximumCharacters; size += 1) {
        for (let index = 0; index + size <= characters.length; index += 1) {
          addHashedFeature(vector, `char:${characters.slice(index, index + size).join("")}`, 0.2 / size);
        }
      }
    }

    return unitNormalize(vector);
  }
}

const DEFAULT_ENTITY_STOP_WORDS = new Set([
  "and", "are", "for", "from", "have", "into", "that", "the", "this", "with",
  "一个", "这个", "那个", "以及", "他们", "我们", "什么", "如何", "是否", "然后", "现在",
  "memorysecretmarker",
]);

function normalizedEntity(value: string, maximumLength: number): string | undefined {
  const normalized = normalizeLexeme(value)
    .replace(/\s+/gu, "-")
    .replace(/^[,.;:!?，。；：！？、]+|[,.;:!?，。；：！？、]+$/gu, "");
  if (normalized.length === 0 || normalized.length > maximumLength) return undefined;
  return normalized;
}

function defaultEntityCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/["'`“‘]([^"'`”’\n]{2,96})["'`”’]/gu)) {
    const value = match[1];
    if (value !== undefined) candidates.push(value);
  }
  candidates.push(...(text.match(/(?:@?[\p{L}\p{N}]+(?:[_.:/#-][\p{L}\p{N}]+)+|\b[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b|\b[A-Z]{2,}[0-9]*\b)/gu) ?? []));
  candidates.push(...(text.match(/[\p{Script=Han}]{2,16}/gu) ?? []));
  // Mixed-script product and symbol names, e.g. 支付Service or Claude代码库.
  candidates.push(...(text.match(/(?:[\p{Script=Han}]+[A-Za-z][A-Za-z0-9_-]*|[A-Za-z][A-Za-z0-9_-]*[\p{Script=Han}]+)/gu) ?? []));
  return candidates;
}

/** Extracts stable, normalized entity keys after removing secret material. */
export function extractEntityTokens(text: string, options: EntityExtractionOptions = {}): string[] {
  const sanitized = redactEmbeddingSecrets(text).normalize("NFKC");
  const maximumTokens = Math.max(1, Math.floor(options.maxTokens ?? 64));
  const maximumLength = Math.max(8, Math.floor(options.maxTokenLength ?? 96));
  const minimumLatinLength = Math.max(1, Math.floor(options.minLatinLength ?? 3));
  const stopWords = new Set([
    ...DEFAULT_ENTITY_STOP_WORDS,
    ...(options.stopWords ?? []).map((word) => normalizeLexeme(word)),
  ]);
  const candidates = defaultEntityCandidates(sanitized);
  for (const extractor of options.additionalExtractors ?? []) candidates.push(...extractor(sanitized));

  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizedEntity(candidate, maximumLength);
    if (normalized === undefined || stopWords.has(normalized) || seen.has(normalized)) continue;
    if (/^[a-z]+$/u.test(normalized) && normalized.length < minimumLatinLength) continue;
    if (normalized.includes("memorysecretmarker")) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maximumTokens) break;
  }
  return result;
}

export class DefaultEntityTokenExtractor implements EntityTokenExtractor {
  readonly #options: EntityExtractionOptions;

  constructor(options: EntityExtractionOptions = {}) {
    this.#options = options;
  }

  extract(text: string): readonly string[] {
    return extractEntityTokens(text, this.#options);
  }
}
