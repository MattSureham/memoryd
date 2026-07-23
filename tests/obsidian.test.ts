import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportObsidianVault,
  extractWikilinks,
  importObsidianVault,
  parseNote,
  serializeNote,
  slugify,
} from "../src/adapters/obsidian.js";
import type { ScopeRef } from "../src/contracts.js";
import { MemoryStore } from "../src/storage/index.js";

const key = Buffer.alloc(32, 7);
const scope: ScopeRef = { userId: "user-a", workspaceId: "workspace-a" };

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "memoryd-obs-"));
  directories.push(directory);
  return directory;
}

function openStore(): MemoryStore {
  return new MemoryStore({
    path: join(tempDir(), "memory.db"),
    encryptionKey: key,
    deviceId: "obsidian-test",
  });
}

function writeNote(vault: string, relativePath: string, content: string): void {
  const target = join(vault, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

const FACT_NOTE = `---
memoryd: fact
subject: Ruby
predicate: species
value: cat
---
Ruby is a cat, not a person.
`;

const POLICY_NOTE = `---
memoryd: policy
scope: workspace
---
Only describe what is visible in the image.
`;

const EPISODE_NOTE = `---
memoryd: episode
title: airport-bus
tags: [travel]
---
We took the airport bus with [[Liuqi]] that night.
`;

const PLAIN_NOTE = `# Random note\n\nairport bookmarks and other text\n`;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("obsidian note parsing", () => {
  it("round-trips flat frontmatter and extracts wikilinks", () => {
    const parsed = parseNote(FACT_NOTE);
    expect(parsed.frontmatter).toMatchObject({
      memoryd: "fact",
      subject: "Ruby",
      predicate: "species",
      value: "cat",
    });
    expect(parsed.body).toContain("Ruby is a cat");

    const serialized = serializeNote(
      { memoryd: "policy", tags: ["a", "b"], "memoryd-managed": true, confidence: 0.5 },
      "body text\n",
    );
    const reparsed = parseNote(serialized);
    expect(reparsed.frontmatter.tags).toEqual(["a", "b"]);
    expect(reparsed.frontmatter["memoryd-managed"]).toBe(true);
    expect(reparsed.frontmatter.confidence).toBe(0.5);
    expect(reparsed.body).toBe("body text\n");

    expect(extractWikilinks("see [[Liuqi]] and [[Ruby|the cat]] twice [[Liuqi]]")).toEqual(["Liuqi", "Ruby"]);
    expect(slugify("Ruby 是猫!")).toBe("ruby-是猫");
    expect(parseNote(PLAIN_NOTE).frontmatter).toEqual({});
  });
});

describe("importObsidianVault", () => {
  it("derives claims, policies and episodes with provenance from notes", () => {
    const store = openStore();
    const vault = tempDir();
    writeNote(vault, "facts/ruby.md", FACT_NOTE);
    writeNote(vault, "policies/vision.md", POLICY_NOTE);
    writeNote(vault, "episodes/airport.md", EPISODE_NOTE);
    writeNote(vault, "misc/plain.md", PLAIN_NOTE);
    try {
      const summary = importObsidianVault(store, { vaultPath: vault, scope });
      expect(summary).toMatchObject({
        scanned: 4,
        imported: 4,
        worldClaims: 1,
        policies: 1,
        episodes: 1,
        errors: [],
      });

      const [claim] = store.listWorldClaims(scope);
      expect(claim).toMatchObject({
        subject: "Ruby",
        predicate: "species",
        value: "cat",
        authority: "user_explicit",
        status: "active",
        version: 1,
      });
      expect(claim?.sources).toHaveLength(1);

      const [policy] = store.listPolicies(scope);
      expect(policy).toMatchObject({
        text: "Only describe what is visible in the image.",
        authority: "user_explicit",
        reviewStatus: "approved",
        scopeLevel: "workspace",
      });

      const [episode] = store.listEpisodes(scope);
      expect(episode).toMatchObject({ title: "airport-bus", participants: ["Liuqi"], tags: ["travel"] });
      expect(episode?.eventRefs).toHaveLength(1);

      const hits = store.search("airport bookmarks", scope, { kinds: ["source_event"] }).hits;
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("is idempotent for unchanged files", () => {
    const store = openStore();
    const vault = tempDir();
    writeNote(vault, "ruby.md", FACT_NOTE);
    try {
      importObsidianVault(store, { vaultPath: vault, scope });
      const second = importObsidianVault(store, { vaultPath: vault, scope });
      expect(second).toMatchObject({ imported: 0, unchanged: 1, worldClaims: 0 });
      expect(store.listWorldClaims(scope)[0]?.version).toBe(1);
    } finally {
      store.close();
    }
  });

  it("versions the claim when a fact value changes", () => {
    const store = openStore();
    const vault = tempDir();
    writeNote(vault, "ruby.md", FACT_NOTE);
    try {
      importObsidianVault(store, { vaultPath: vault, scope });
      writeNote(vault, "ruby.md", FACT_NOTE.replace("value: cat", "value: dog"));
      const summary = importObsidianVault(store, { vaultPath: vault, scope });
      expect(summary.imported).toBe(1);
      const [claim] = store.listWorldClaims(scope);
      expect(claim).toMatchObject({ value: "dog", version: 2, supersedes: claim?.claimId });
    } finally {
      store.close();
    }
  });

  it("forgets derived records when a note is deleted", () => {
    const store = openStore();
    const vault = tempDir();
    writeNote(vault, "ruby.md", FACT_NOTE);
    writeNote(vault, "keep.md", PLAIN_NOTE);
    try {
      importObsidianVault(store, { vaultPath: vault, scope });
      rmSync(join(vault, "ruby.md"));
      const summary = importObsidianVault(store, { vaultPath: vault, scope });
      expect(summary.forgotten).toBe(1);
      expect(store.listWorldClaims(scope)).toHaveLength(0);
      expect(store.listSourceEvents(scope, { includeAllSessions: true })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("records per-file errors without aborting the import", () => {
    const store = openStore();
    const vault = tempDir();
    writeNote(vault, "broken.md", "---\nmemoryd: fact\nsubject: OnlySubject\n---\nbody\n");
    writeNote(vault, "good.md", PLAIN_NOTE);
    try {
      const summary = importObsidianVault(store, { vaultPath: vault, scope });
      expect(summary.imported).toBe(2);
      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]?.path).toBe("broken.md");
    } finally {
      store.close();
    }
  });
});

describe("exportObsidianVault", () => {
  it("projects memory as managed notes that import skips until a human edits them", () => {
    const store = openStore();
    const vault = tempDir();
    writeNote(vault, "ruby.md", FACT_NOTE);
    writeNote(vault, "vision.md", POLICY_NOTE);
    try {
      importObsidianVault(store, { vaultPath: vault, scope });
      const exported = exportObsidianVault(store, { vaultPath: vault, scope });
      expect(exported).toMatchObject({ worldClaims: 1, policies: 1 });
      expect(exported.written).toBeGreaterThanOrEqual(2);

      const worldFile = join(exported.directory, "world", `${slugify("Ruby")}-${store.listWorldClaims(scope)[0]!.claimId.slice(6, 14)}.md`);
      expect(existsSync(worldFile)).toBe(true);
      const managed = parseNote(readFileSync(worldFile, "utf8"));
      expect(managed.frontmatter["memoryd-managed"]).toBe(true);
      expect(managed.frontmatter.subject).toBe("Ruby");

      const reimport = importObsidianVault(store, { vaultPath: vault, scope });
      expect(reimport.imported).toBe(0);
      expect(reimport.skippedManaged).toBe(exported.written);
      expect(store.listWorldClaims(scope)[0]?.version).toBe(1);
      expect(store.listPolicies(scope)[0]?.version).toBe(1);
    } finally {
      store.close();
    }
  });

  it("approves a new policy version when a human edits an exported note", () => {
    const store = openStore();
    const vault = tempDir();
    writeNote(vault, "vision.md", POLICY_NOTE);
    try {
      importObsidianVault(store, { vaultPath: vault, scope });
      const exported = exportObsidianVault(store, { vaultPath: vault, scope });
      const [policy] = store.listPolicies(scope);
      const policyFile = join(exported.directory, "policies", `${slugify(policy!.text.slice(0, 24))}-${policy!.policyId.slice(7, 15)}.md`);
      const edited = readFileSync(policyFile, "utf8").replace(
        "Only describe what is visible in the image.",
        "Only describe visible evidence; never infer off-screen events.",
      );
      writeFileSync(policyFile, edited, "utf8");

      const summary = importObsidianVault(store, { vaultPath: vault, scope });
      expect(summary.policies).toBe(1);
      const [updated] = store.listPolicies(scope);
      expect(updated).toMatchObject({
        text: "Only describe visible evidence; never infer off-screen events.",
        version: 2,
        reviewStatus: "approved",
        authority: "user_explicit",
      });
    } finally {
      store.close();
    }
  });

  it("removes managed exports whose records were forgotten", () => {
    const store = openStore();
    const vault = tempDir();
    writeNote(vault, "ruby.md", FACT_NOTE);
    try {
      importObsidianVault(store, { vaultPath: vault, scope });
      const exported = exportObsidianVault(store, { vaultPath: vault, scope });
      const [claim] = store.listWorldClaims(scope);
      const worldFile = join(exported.directory, "world", `${slugify("Ruby")}-${claim!.claimId.slice(6, 14)}.md`);
      expect(existsSync(worldFile)).toBe(true);

      store.forget({ userId: scope.userId, entityType: "world_claim", entityId: claim!.claimId, reason: "test" });
      const second = exportObsidianVault(store, { vaultPath: vault, scope });
      expect(second.removed).toBe(1);
      expect(existsSync(worldFile)).toBe(false);
    } finally {
      store.close();
    }
  });
});
