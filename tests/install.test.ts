import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installAdapters } from "../src/install.js";

describe("adapter installer", () => {
  it("installs both project adapters without overwriting existing guidance", () => {
    const root = mkdtempSync(join(tmpdir(), "memoryd-install-"));
    const first = installAdapters({ target: "all", scope: "project", cwd: root });
    const second = installAdapters({ target: "all", scope: "project", cwd: root });

    expect(first.written.length).toBeGreaterThan(0);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("memoryd-adapter");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("memoryd-shared-protocol");
    expect(readFileSync(join(root, ".claude", "rules", "memory.md"), "utf8")).toContain("memoryd-rule");
    expect(readFileSync(join(root, ".claude", "settings.json"), "utf8")).toContain('"autoMemoryEnabled": false');
    const claudeSettings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    const codexHooks = JSON.parse(readFileSync(join(root, ".codex", "hooks.json"), "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    expect(claudeSettings.hooks).toHaveProperty("SessionEnd");
    expect(codexHooks.hooks).not.toHaveProperty("SessionEnd");
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.memoryd]");
    expect(second.skipped.length).toBeGreaterThan(0);
  });

  it("warns for every preserved Codex table even when other tables are appended", () => {
    const root = mkdtempSync(join(tmpdir(), "memoryd-install-partial-"));
    const codexRoot = join(root, ".codex");
    mkdirSync(codexRoot, { recursive: true });
    const configPath = join(codexRoot, "config.toml");
    writeFileSync(
      configPath,
      '[features] # keep local choices\nhooks = false\nmemories = true\n\n[mcp_servers."memoryd"]\ncommand = "custom-memory-mcp"\n',
      "utf8",
    );

    const result = installAdapters({ target: "codex", scope: "project", cwd: root });
    const config = readFileSync(configPath, "utf8");

    expect(config).toContain("hooks = false");
    expect(config).toContain('command = "custom-memory-mcp"');
    expect(config.match(/^\[memories\]$/gm)).toHaveLength(1);
    expect(config.match(/^\[features\]/gm)).toHaveLength(1);
    expect(result.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("Existing [features] table"),
      expect.stringContaining("Existing [mcp_servers.memoryd] table"),
    ]));
    expect(result.notes).not.toEqual(expect.arrayContaining([
      expect.stringContaining("Existing [memories] table"),
    ]));
  });
});
