import { describe, expect, it } from "vitest";
import { ObservationSchema, RecallSchema, SourceRefSchema } from "../src/schemas.js";

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
});
