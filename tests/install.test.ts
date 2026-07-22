import { mkdtempSync, readFileSync } from "node:fs";
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
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.memoryd]");
    expect(second.skipped.length).toBeGreaterThan(0);
  });
});
