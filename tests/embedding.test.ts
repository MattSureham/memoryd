import { describe, expect, it } from "vitest";
import {
  DefaultEntityTokenExtractor,
  LocalHashEmbeddingProvider,
  extractEntityTokens,
  redactEmbeddingSecrets,
  type EmbeddingProvider,
  type EntityTokenExtractor,
} from "../src/core/embedding.js";

function cosine(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

describe("LocalHashEmbeddingProvider", () => {
  it("is deterministic and returns L2-normalized vectors", () => {
    const provider: EmbeddingProvider = new LocalHashEmbeddingProvider({ dimensions: 128 });
    const first = provider.embed("Fix the OrderService repository error");
    const second = provider.embed("Fix the OrderService repository error");

    expect(first).toEqual(second);
    expect(first).toHaveLength(128);
    expect(Math.sqrt(first.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 12);
  });

  it("recalls explicitly related concepts without lexical overlap", () => {
    const provider = new LocalHashEmbeddingProvider({
      dimensions: 256,
      includeDefaultSynonyms: false,
      synonyms: { vehicle: ["automobile", "car"] },
    });
    const query = provider.embed("automobile");
    const synonym = provider.embed("car");
    const unrelated = provider.embed("banana");

    expect(cosine(query, synonym)).toBeGreaterThan(0.7);
    expect(cosine(query, synonym)).toBeGreaterThan(cosine(query, unrelated));
  });

  it("uses built-in multilingual concepts for related queries", () => {
    const provider = new LocalHashEmbeddingProvider({ dimensions: 256 });
    const left = provider.embed("repair the repository bug");
    const right = provider.embed("修复代码库错误");
    const unrelated = provider.embed("weather forecast tomorrow");

    expect(cosine(left, right)).toBeGreaterThan(cosine(left, unrelated));
  });

  it("does not encode raw secret values into persisted vectors", () => {
    const provider = new LocalHashEmbeddingProvider({ dimensions: 128 });
    const left = provider.embed("Authorization: Bearer top-secret-value-one deploy OrderService");
    const right = provider.embed("Authorization: Bearer entirely-different-value deploy OrderService");

    expect(left).toEqual(right);
    expect(redactEmbeddingSecrets("password=hunter2 OrderService")).not.toContain("hunter2");
  });
});

describe("extractEntityTokens", () => {
  it("normalizes and deduplicates mixed Chinese and English entities", () => {
    const entities = extractEntityTokens(
      "Compare OrderService with orderservice in ‘支付Service’ and 仓库AlphaRepo; OrderService.",
    );

    expect(entities).toContain("orderservice");
    expect(entities).toContain("支付service");
    expect(entities.filter((entity) => entity === "orderservice")).toHaveLength(1);
  });

  it("filters secrets before entity extraction", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const entities = extractEntityTokens(`Use ${secret} with OrderService`);

    expect(JSON.stringify(entities)).not.toContain(secret);
    expect(entities).toContain("orderservice");
  });

  it("supports a pluggable extractor interface and domain extensions", () => {
    const extractor: EntityTokenExtractor = new DefaultEntityTokenExtractor({
      additionalExtractors: [(text) => text.includes("ticket") ? ["INC-42"] : []],
    });

    expect(extractor.extract("Inspect ticket for APIClient")).toEqual(expect.arrayContaining(["apiclient", "inc-42"]));
  });
});
