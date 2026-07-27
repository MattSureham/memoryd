import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ObservationSchema,
  RecallSchema,
  RetrieveMemorySchema,
  SourceRefSchema,
} from "../src/schemas.js";

describe("protocol schemas", () => {
  it("caps recall at the advertised 8,000-token maximum", () => {
    expect(RecallSchema.safeParse({ turnId: "turn", stage: "world", query: "q", budgetTokens: 8_000 }).success)
      .toBe(true);
    expect(RecallSchema.safeParse({ turnId: "turn", stage: "world", query: "q", budgetTokens: 8_001 }).success)
      .toBe(false);
  });

  it("requires RFC 3339 timestamps for full and partial SourceRefs", () => {
    const valid = {
      eventId: "event",
      sessionId: "session",
      contentHash: "hash",
      capturedAt: "2026-07-22T00:00:00.000Z",
    };
    expect(SourceRefSchema.safeParse(valid).success).toBe(true);
    expect(SourceRefSchema.safeParse({ ...valid, capturedAt: "yesterday" }).success).toBe(false);
    expect(ObservationSchema.safeParse({
      kind: "current_file",
      content: "observed",
      source: { capturedAt: "yesterday" },
    }).success).toBe(false);
  });

  it("bounds object-routed retrieval and publishes the v1.2 result schema", () => {
    expect(RetrieveMemorySchema.safeParse({
      turnId: "turn",
      query: "ProjectAtlas",
      budgetTokens: 8_000,
      limit: 80,
    }).success).toBe(true);
    expect(RetrieveMemorySchema.safeParse({
      turnId: "turn",
      query: "ProjectAtlas",
      limit: 81,
    }).success).toBe(false);
    const schema = JSON.parse(readFileSync(
      new URL("../schemas/memory-protocol-v1.schema.json", import.meta.url),
      "utf8",
    )) as {
      title: string;
      $defs: Record<string, unknown>;
    };
    expect(schema.title).toBe("memoryd protocol v1.2");
    expect(schema.$defs).toHaveProperty("RetrieveMemoryRequest");
    expect(schema.$defs).toHaveProperty("MemoryRetrievalResult");
  });
});
