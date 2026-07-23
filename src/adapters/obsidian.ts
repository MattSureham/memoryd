import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { AgentProfile, EpisodeMemory, ScopeLevel, ScopeRef, SourceRef, WorldClaim } from "../contracts.js";
import type { MemoryStore, StoredPolicy } from "../storage/index.js";

export const OBSIDIAN_MANAGED_DIR = "memoryd";

const OBSIDIAN_AGENT: AgentProfile = {
  family: "obsidian",
  version: "1",
  capabilities: { hooks: false, stageGates: false },
};

export interface ObsidianImportSummary {
  vaultPath: string;
  scanned: number;
  imported: number;
  unchanged: number;
  skippedManaged: number;
  forgotten: number;
  worldClaims: number;
  policies: number;
  episodes: number;
  errors: Array<{ path: string; message: string }>;
}

export interface ObsidianExportSummary {
  vaultPath: string;
  directory: string;
  written: number;
  removed: number;
  worldClaims: number;
  policies: number;
  episodes: number;
}

type FrontmatterValue = string | number | boolean | string[];
type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedNote {
  frontmatter: Frontmatter;
  body: string;
}

function sha256(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function digest(...parts: string[]): string {
  return sha256(parts.join("\u001f"));
}

function parseScalar(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner.split(",").map((item) => String(parseScalar(item)));
  }
  const quoted = value.match(/^"(.*)"$/u) ?? value.match(/^'(.*)'$/u);
  if (quoted) return quoted[1] ?? "";
  if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

function serializeScalar(value: FrontmatterValue): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => serializeScalar(item)).join(", ")}]`;
  if (value === "" || /[:#[\]{}&*!|>'"%@`,]/u.test(value) || value !== value.trim()) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Deliberately minimal flat frontmatter parser. Nested YAML is rejected by
 * staying unparsed rather than being misread; the vault schema only uses
 * scalars and inline string arrays.
 */
export function parseNote(content: string): ParsedNote {
  const normalized = content.replace(/^\uFEFF/u, "");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return { frontmatter: {}, body: normalized };
  const frontmatter: Frontmatter = {};
  for (const line of normalized.slice(4, closing).split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (match === null) continue;
    frontmatter[match[1] as string] = parseScalar(match[2] as string);
  }
  return { frontmatter, body: normalized.slice(closing + 5) };
}

export function serializeNote(frontmatter: Frontmatter, body: string): string {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${serializeScalar(value)}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

export function extractWikilinks(body: string): string[] {
  const links = new Set<string>();
  for (const match of body.matchAll(/\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]/gu)) {
    const name = (match[1] as string).trim();
    if (name.length > 0) links.add(name);
  }
  return [...links];
}

export function slugify(text: string, fallback = "note"): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/u, "");
  return slug.length > 0 ? slug : fallback;
}

function walkMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        if (!lstatSync(path).isSymbolicLink()) files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}

function scopeForLevel(scope: ScopeRef, level: "user" | "workspace"): ScopeRef {
  if (level === "user" || scope.workspaceId === undefined) return { userId: scope.userId };
  return { userId: scope.userId, workspaceId: scope.workspaceId };
}

function noteScope(frontmatter: Frontmatter, scope: ScopeRef): ScopeRef {
  return scopeForLevel(scope, frontmatter.scope === "user" ? "user" : "workspace");
}

function managedId(frontmatter: Frontmatter, prefix: string): string | undefined {
  const value = frontmatter["memoryd-id"];
  return typeof value === "string" && value.startsWith(prefix) ? value : undefined;
}

function isUntouchedManagedExport(frontmatter: Frontmatter, body: string): boolean {
  return frontmatter["memoryd-managed"] === true
    && frontmatter["memoryd-hash"] === sha256(body.trim());
}

interface ExistingObsidianEvent {
  eventId: string;
  fileHash: string;
}

function existingObsidianEvents(store: MemoryStore, scope: ScopeRef, vaultPath: string): Map<string, ExistingObsidianEvent> {
  const events = new Map<string, ExistingObsidianEvent>();
  for (const event of store.listSourceEvents(scope, {
    includeAllSessions: true,
    kinds: ["attachment"],
    limit: 5_000,
  })) {
    if (event.metadata.source !== "obsidian" || event.metadata.vaultPath !== vaultPath) continue;
    const path = event.metadata.path;
    const fileHash = event.metadata.fileHash;
    if (typeof path === "string" && typeof fileHash === "string") {
      events.set(path, { eventId: event.eventId, fileHash });
    }
  }
  return events;
}

function upsertFact(
  store: MemoryStore,
  scope: ScopeRef,
  frontmatter: Frontmatter,
  source: WorldClaim["sources"][number],
): WorldClaim | undefined {
  const { subject, predicate, value } = frontmatter;
  if (typeof subject !== "string" || typeof predicate !== "string" || value === undefined || Array.isArray(value)) {
    throw new Error("memoryd: fact notes require string subject/predicate and a scalar value");
  }
  const claimScope = noteScope(frontmatter, scope);
  const claimId = `claim_${digest(
    claimScope.userId,
    claimScope.workspaceId ?? "",
    subject,
    predicate,
  ).slice(0, 32)}`;
  const previous = store.getWorldClaim(claimId, undefined, claimScope);
  if (previous !== undefined && previous.status === "active" && JSON.stringify(previous.value) === JSON.stringify(value)) {
    return previous;
  }
  const claim: WorldClaim = {
    claimId,
    subject,
    predicate,
    value,
    scope: claimScope,
    confidence: typeof frontmatter.confidence === "number" ? frontmatter.confidence : 1,
    authority: "user_explicit",
    status: "active",
    ...(previous === undefined ? {} : { supersedes: previous.claimId }),
    sources: [...(previous?.sources ?? []), source]
      .filter((ref, index, refs) => refs.findIndex((candidate) => candidate.eventId === ref.eventId) === index),
    version: (previous?.version ?? 0) + 1,
  };
  const written = store.putWorldClaim(claim, `obsidian:claim:${claimId}:${claim.version}`);
  if (typeof value === "string") store.linkEntityRelation(claimScope, subject, value, predicate);
  return written;
}

function upsertPolicy(
  store: MemoryStore,
  scope: ScopeRef,
  relativePath: string,
  frontmatter: Frontmatter,
  body: string,
  source: SourceRef,
): StoredPolicy {
  const text = body.trim();
  if (text.length === 0) throw new Error("memoryd: policy notes require a non-empty body");
  if (frontmatter.scope === "session") {
    throw new Error("memoryd: policy notes support scope user|workspace; session policies expire with their session");
  }
  const level: ScopeLevel = frontmatter.scope === "user" ? "user" : "workspace";
  const policyScope = scopeForLevel(scope, level === "user" ? "user" : "workspace");
  const policyId = managedId(frontmatter, "policy_")
    ?? `policy_${digest(policyScope.userId, policyScope.workspaceId ?? "", "obsidian", relativePath).slice(0, 32)}`;
  const prior = store.getPolicy(policyId, undefined, policyScope);
  if (prior !== undefined && prior.text === text && (prior.reviewStatus ?? "approved") === "approved") {
    return prior;
  }
  const dependencies = Array.isArray(frontmatter.dependencies)
    ? frontmatter.dependencies.filter((item): item is string => typeof item === "string")
    : undefined;
  const policy: StoredPolicy = {
    policyId,
    version: (prior?.version ?? 0) + 1,
    scopeLevel: level,
    authority: "user_explicit",
    text,
    scope: policyScope,
    reviewStatus: "approved",
    ...(dependencies === undefined ? {} : { dependencies }),
    sources: [...(prior?.sources ?? []), source]
      .filter((ref, index, refs) => refs.findIndex((candidate) => candidate.eventId === ref.eventId) === index),
  };
  return store.putPolicy(policy, `obsidian:policy:${policyId}:${policy.version}`);
}

function upsertEpisode(
  store: MemoryStore,
  scope: ScopeRef,
  relativePath: string,
  frontmatter: Frontmatter,
  body: string,
  mtime: string,
  source: EpisodeMemory["eventRefs"][number],
): EpisodeMemory {
  const episodeId = managedId(frontmatter, "episode_")
    ?? `episode_${digest(scope.userId, scope.workspaceId ?? "", "obsidian", relativePath).slice(0, 32)}`;
  const title = typeof frontmatter.title === "string" && frontmatter.title.trim().length > 0
    ? frontmatter.title.trim()
    : basename(relativePath, extname(relativePath));
  const summary = body.trim().slice(0, 1_000);
  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((item): item is string => typeof item === "string")
    : [];
  const startedAt = typeof frontmatter.date === "string" ? frontmatter.date : mtime;
  const episode: EpisodeMemory = {
    episodeId,
    scope: { userId: scope.userId, ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }) },
    title,
    ...(summary.length === 0 ? {} : { summary }),
    eventRefs: [source],
    participants: extractWikilinks(body),
    tags,
    startedAt,
    endedAt: mtime,
    boundaryReason: "explicit",
  };
  const existing = store.getEpisode(episodeId, episode.scope);
  return existing === undefined
    ? store.putEpisode(episode, `obsidian:episode:${episodeId}`)
    : store.updateEpisode(episode);
}

/**
 * Imports a vault as user-authored input: every note becomes a redacted,
 * encrypted SourceEvent, and `memoryd:` frontmatter derives WorldClaim /
 * Policy / Episode records whose provenance points back at that event.
 * Files deleted since the previous import cascade through forget().
 */
export function importObsidianVault(
  store: MemoryStore,
  options: { vaultPath: string; scope: ScopeRef },
): ObsidianImportSummary {
  const vaultPath = resolve(options.vaultPath);
  if (!existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
    throw new Error(`Obsidian vault ${vaultPath} was not found or is not a directory`);
  }
  const summary: ObsidianImportSummary = {
    vaultPath,
    scanned: 0,
    imported: 0,
    unchanged: 0,
    skippedManaged: 0,
    forgotten: 0,
    worldClaims: 0,
    policies: 0,
    episodes: 0,
    errors: [],
  };
  const existing = existingObsidianEvents(store, options.scope, vaultPath);
  const seen = new Set<string>();
  // SourceRefs require a session. Vault events live in a deterministic
  // per-vault session so originals stay addressable and redacted; derived
  // records remain user/workspace scoped and outlive any session.
  const eventScope: ScopeRef = {
    ...options.scope,
    sessionId: `obsidian-${sha256(vaultPath).slice(0, 16)}`,
  };

  for (const filePath of walkMarkdownFiles(vaultPath)) {
    const relativePath = relative(vaultPath, filePath).split(sep).join("/");
    seen.add(relativePath);
    summary.scanned += 1;
    try {
      const raw = readFileSync(filePath, "utf8");
      const fileHash = sha256(raw);
      const prior = existing.get(relativePath);
      if (prior?.fileHash === fileHash) {
        summary.unchanged += 1;
        continue;
      }
      const note = parseNote(raw);
      if (isUntouchedManagedExport(note.frontmatter, note.body)) {
        summary.skippedManaged += 1;
        continue;
      }
      const mtime = statSync(filePath).mtime.toISOString();
      const event = store.appendSourceEvent({
        input: {
          idempotencyKey: `obsidian:${fileHash}`,
          kind: "attachment",
          content: raw,
          occurredAt: mtime,
          metadata: {
            source: "obsidian",
            vaultPath,
            path: relativePath,
            fileHash,
            managed: note.frontmatter["memoryd-managed"] === true,
            memorydType: typeof note.frontmatter.memoryd === "string" ? note.frontmatter.memoryd : undefined,
          },
        },
        scope: eventScope,
        agent: OBSIDIAN_AGENT,
        selectedEvidence: true,
      });
      summary.imported += 1;
      const source = store.toSourceRef(event);
      const type = note.frontmatter.memoryd;
      if (type === "fact") {
        upsertFact(store, options.scope, note.frontmatter, source);
        summary.worldClaims += 1;
      } else if (type === "policy") {
        upsertPolicy(store, options.scope, relativePath, note.frontmatter, note.body, source);
        summary.policies += 1;
      } else if (type === "episode") {
        upsertEpisode(store, options.scope, relativePath, note.frontmatter, note.body, mtime, source);
        summary.episodes += 1;
      }
    } catch (error) {
      summary.errors.push({
        path: relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const [relativePath, record] of existing) {
    if (seen.has(relativePath)) continue;
    store.forget({
      userId: options.scope.userId,
      entityType: "source_event",
      entityId: record.eventId,
      reason: `Obsidian note deleted: ${relativePath}`,
    });
    summary.forgotten += 1;
  }
  return summary;
}

interface ExportFile {
  relativePath: string;
  frontmatter: Frontmatter;
  body: string;
  managedId: string;
}

function claimExportFile(claim: WorldClaim): ExportFile {
  const display = typeof claim.value === "string" ? claim.value : JSON.stringify(claim.value);
  const body = `# [[${claim.subject}]]\n\n**${claim.predicate}**: ${display}\n`;
  const value: FrontmatterValue = typeof claim.value === "string" || typeof claim.value === "number" || typeof claim.value === "boolean"
    ? claim.value
    : JSON.stringify(claim.value);
  return {
    relativePath: join("world", `${slugify(claim.subject)}-${claim.claimId.slice(6, 14)}.md`),
    frontmatter: {
      memoryd: "fact",
      "memoryd-managed": true,
      "memoryd-id": claim.claimId,
      "memoryd-version": claim.version,
      "memoryd-hash": sha256(body.trim()),
      status: claim.status,
      subject: claim.subject,
      predicate: claim.predicate,
      value,
    },
    body,
    managedId: claim.claimId,
  };
}

function policyExportFile(policy: StoredPolicy): ExportFile {
  const body = `${policy.text}\n`;
  return {
    relativePath: join("policies", `${slugify(policy.text.slice(0, 24))}-${policy.policyId.slice(7, 15)}.md`),
    frontmatter: {
      memoryd: "policy",
      "memoryd-managed": true,
      "memoryd-id": policy.policyId,
      "memoryd-version": policy.version,
      "memoryd-hash": sha256(body.trim()),
      scope: policy.scopeLevel,
    },
    body,
    managedId: policy.policyId,
  };
}

function episodeExportFile(episode: EpisodeMemory): ExportFile {
  const body = `${episode.summary ?? episode.title}\n`;
  return {
    relativePath: join("episodes", `${slugify(episode.title)}-${episode.episodeId.slice(8, 16)}.md`),
    frontmatter: {
      memoryd: "episode",
      "memoryd-managed": true,
      "memoryd-id": episode.episodeId,
      "memoryd-hash": sha256(body.trim()),
      title: episode.title,
      tags: episode.tags,
      started: episode.startedAt,
      ended: episode.endedAt,
    },
    body,
    managedId: episode.episodeId,
  };
}

/**
 * Projects active memory into `<vault>/memoryd/` as human-readable notes.
 * Managed notes carry a body hash so importObsidianVault skips them unless a
 * human actually edits the file, which keeps the export→import loop closed.
 */
export function exportObsidianVault(
  store: MemoryStore,
  options: { vaultPath: string; scope: ScopeRef },
): ObsidianExportSummary {
  const vaultPath = resolve(options.vaultPath);
  if (!existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
    throw new Error(`Obsidian vault ${vaultPath} was not found or is not a directory`);
  }
  const managedRoot = join(vaultPath, OBSIDIAN_MANAGED_DIR);
  const claims = store.listWorldClaims(options.scope);
  const policies = store.listPolicies(options.scope)
    .filter((policy) => (policy.reviewStatus ?? "approved") === "approved");
  const episodes = store.listEpisodes(options.scope);
  const files = [
    ...claims.map(claimExportFile),
    ...policies.map(policyExportFile),
    ...episodes.map(episodeExportFile),
  ];
  const activeIds = new Set(files.map((file) => file.managedId));

  let written = 0;
  for (const file of files) {
    const target = join(managedRoot, file.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    const serialized = serializeNote(file.frontmatter, file.body);
    if (existsSync(target) && readFileSync(target, "utf8") === serialized) continue;
    writeFileSync(target, serialized, "utf8");
    written += 1;
  }

  let removed = 0;
  if (existsSync(managedRoot)) {
    for (const filePath of walkMarkdownFiles(managedRoot)) {
      const note = parseNote(readFileSync(filePath, "utf8"));
      if (note.frontmatter["memoryd-managed"] !== true) continue;
      const id = note.frontmatter["memoryd-id"];
      if (typeof id === "string" && activeIds.has(id)) continue;
      unlinkSync(filePath);
      removed += 1;
    }
  }

  return {
    vaultPath,
    directory: managedRoot,
    written,
    removed,
    worldClaims: claims.length,
    policies: policies.length,
    episodes: episodes.length,
  };
}
