import { describe, expect, it } from "vitest";
import { redactSensitiveValue } from "../src/storage/redaction.js";

describe("structured-value redaction", () => {
  it("preserves typed safety signals while redacting credential values", () => {
    const result = redactSensitiveValue({
      containsSecretMaterial: false,
      secretCount: 0,
      apiKey: "do-not-persist-this-value",
      nested: { privateKey: { material: "do-not-persist-this-object" } },
    });

    expect(result.value).toEqual({
      containsSecretMaterial: false,
      secretCount: "[REDACTED]:sensitive_field",
      apiKey: "[REDACTED]:sensitive_field",
      nested: { privateKey: "[REDACTED]:sensitive_field" },
    });
    expect(result.redactions).toEqual([
      "metadata:apiKey",
      "metadata:privateKey",
      "metadata:secretCount",
    ]);
  });
});
