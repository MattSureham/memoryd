import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configWithInterval(value?: string) {
  const home = mkdtempSync(join(tmpdir(), "memoryd-config-"));
  directories.push(home);
  return loadConfig({
    MEMORYD_HOME: home,
    MEMORYD_DEVICE_ID: "config-test-device",
    ...(value === undefined ? {} : { MEMORYD_LEARNING_INTERVAL_MS: value }),
  });
}

describe("runtime configuration", () => {
  it("uses a safe finite integer learning interval", () => {
    expect(configWithInterval().learningIntervalMs).toBe(5_000);
    expect(configWithInterval("invalid").learningIntervalMs).toBe(5_000);
    expect(configWithInterval("1.5").learningIntervalMs).toBe(5_000);
    expect(configWithInterval("Infinity").learningIntervalMs).toBe(5_000);
    expect(configWithInterval("999").learningIntervalMs).toBe(1_000);
    expect(configWithInterval("2500").learningIntervalMs).toBe(2_500);
  });
});
