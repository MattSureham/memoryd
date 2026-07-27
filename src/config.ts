import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface RuntimeConfig {
  home: string;
  databasePath: string;
  keyPath: string;
  spoolPath: string;
  host: string;
  port: number;
  bearerToken?: string;
  deviceId: string;
  learningIntervalMs: number;
  curatorIntervalMs: number;
  evolution: MemoryEvolutionConfig;
}

export interface MemoryEvolutionConfig {
  maxNodeTokens: number;
  maxChildCount: number;
  maxObjectMembers: number;
  targetObjectMembers: number;
  maxCandidateCount: number;
  maxRoutedObjects: number;
  maxExpansionDepth: number;
  maxEntitiesPerObject: number;
  splitMinMembers: number;
  mergeSimilarity: number;
  minimumPrecisionProxy: number;
  minimumRecallProxy: number;
  minimumEvidenceCoverage: number;
  minimumSubtopicClusters: number;
  maximumQueryHitDispersion: number;
  minimumSummaryFidelity: number;
  minimumLocalUseRatio: number;
  minimumRetrievalSamples: number;
  maximumContradictionRate: number;
  maximumStaleSummaryRate: number;
  maximumOrphanRate: number;
  maximumMaintenanceBacklog: number;
  hotThreshold: number;
  warmThreshold: number;
  coldThreshold: number;
  coldAfterDays: number;
  archiveAfterDays: number;
  staleSummaryAfterDays: number;
  curatorBatchSize: number;
  maintenanceLeaseMs: number;
  maintenanceMaxAttempts: number;
  summaryMaxCharacters: number;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function persistentDeviceId(home: string): string {
  const path = join(home, "device-id");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const value = randomUUID();
  try {
    writeFileSync(path, `${value}\n`, { mode: 0o600, flag: "wx" });
    return value;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return readFileSync(path, "utf8").trim();
    throw error;
  }
}

function integerAtLeast(value: string | undefined, fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, parsed);
}

function unitInterval(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

export function loadEvolutionConfig(environment: NodeJS.ProcessEnv = process.env): MemoryEvolutionConfig {
  return {
    maxNodeTokens: integerAtLeast(environment.MEMORYD_MAX_NODE_TOKENS, 1_800, 128),
    maxChildCount: integerAtLeast(environment.MEMORYD_MAX_CHILD_COUNT, 32, 2),
    maxObjectMembers: integerAtLeast(environment.MEMORYD_MAX_OBJECT_MEMBERS, 24, 2),
    targetObjectMembers: integerAtLeast(environment.MEMORYD_TARGET_OBJECT_MEMBERS, 12, 1),
    maxCandidateCount: integerAtLeast(environment.MEMORYD_MAX_CANDIDATE_COUNT, 80, 4),
    maxRoutedObjects: integerAtLeast(environment.MEMORYD_MAX_ROUTED_OBJECTS, 8, 1),
    maxExpansionDepth: integerAtLeast(environment.MEMORYD_MAX_EXPANSION_DEPTH, 3, 1),
    maxEntitiesPerObject: integerAtLeast(environment.MEMORYD_MAX_ENTITIES_PER_OBJECT, 12, 2),
    splitMinMembers: integerAtLeast(environment.MEMORYD_SPLIT_MIN_MEMBERS, 6, 2),
    mergeSimilarity: unitInterval(environment.MEMORYD_MERGE_SIMILARITY, 0.78),
    minimumPrecisionProxy: unitInterval(environment.MEMORYD_MIN_PRECISION_PROXY, 0.55),
    minimumRecallProxy: unitInterval(environment.MEMORYD_MIN_RECALL_PROXY, 0.55),
    minimumEvidenceCoverage: unitInterval(environment.MEMORYD_MIN_EVIDENCE_COVERAGE, 0.65),
    minimumSubtopicClusters: integerAtLeast(environment.MEMORYD_MIN_SUBTOPIC_CLUSTERS, 2, 2),
    maximumQueryHitDispersion: unitInterval(environment.MEMORYD_MAX_QUERY_HIT_DISPERSION, 0.7),
    minimumSummaryFidelity: unitInterval(environment.MEMORYD_MIN_SUMMARY_FIDELITY, 0.45),
    minimumLocalUseRatio: unitInterval(environment.MEMORYD_MIN_LOCAL_USE_RATIO, 0.2),
    minimumRetrievalSamples: integerAtLeast(environment.MEMORYD_MIN_RETRIEVAL_SAMPLES, 5, 1),
    maximumContradictionRate: unitInterval(environment.MEMORYD_MAX_CONTRADICTION_RATE, 0.25),
    maximumStaleSummaryRate: unitInterval(environment.MEMORYD_MAX_STALE_SUMMARY_RATE, 0.2),
    maximumOrphanRate: unitInterval(environment.MEMORYD_MAX_ORPHAN_RATE, 0.05),
    maximumMaintenanceBacklog: integerAtLeast(environment.MEMORYD_MAX_MAINTENANCE_BACKLOG, 1_000, 1),
    hotThreshold: unitInterval(environment.MEMORYD_HOT_THRESHOLD, 0.7),
    warmThreshold: unitInterval(environment.MEMORYD_WARM_THRESHOLD, 0.35),
    coldThreshold: unitInterval(environment.MEMORYD_COLD_THRESHOLD, 0.12),
    coldAfterDays: integerAtLeast(environment.MEMORYD_COLD_AFTER_DAYS, 90, 1),
    archiveAfterDays: integerAtLeast(environment.MEMORYD_ARCHIVE_AFTER_DAYS, 365, 1),
    staleSummaryAfterDays: integerAtLeast(environment.MEMORYD_STALE_SUMMARY_AFTER_DAYS, 30, 1),
    curatorBatchSize: integerAtLeast(environment.MEMORYD_CURATOR_BATCH_SIZE, 50, 1),
    maintenanceLeaseMs: integerAtLeast(environment.MEMORYD_MAINTENANCE_LEASE_MS, 60_000, 1_000),
    maintenanceMaxAttempts: integerAtLeast(environment.MEMORYD_MAINTENANCE_MAX_ATTEMPTS, 5, 1),
    summaryMaxCharacters: integerAtLeast(environment.MEMORYD_SUMMARY_MAX_CHARACTERS, 1_200, 128),
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const home = expandHome(environment.MEMORYD_HOME ?? "~/.memoryd");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const spoolPath = join(home, "spool");
  mkdirSync(spoolPath, { recursive: true, mode: 0o700 });
  return {
    home,
    databasePath: expandHome(environment.MEMORYD_DB ?? join(home, "memory.db")),
    keyPath: expandHome(environment.MEMORYD_KEY ?? join(home, "master.key")),
    spoolPath,
    host: environment.MEMORYD_HOST ?? "127.0.0.1",
    port: Number.parseInt(environment.MEMORYD_PORT ?? "7337", 10),
    ...(environment.MEMORYD_TOKEN === undefined ? {} : { bearerToken: environment.MEMORYD_TOKEN }),
    deviceId: environment.MEMORYD_DEVICE_ID ?? persistentDeviceId(home),
    learningIntervalMs: integerAtLeast(environment.MEMORYD_LEARNING_INTERVAL_MS, 5_000, 1_000),
    curatorIntervalMs: integerAtLeast(environment.MEMORYD_CURATOR_INTERVAL_MS, 15_000, 1_000),
    evolution: loadEvolutionConfig(environment),
  };
}

export function loadOrCreateMasterKey(path: string): Buffer {
  if (existsSync(path)) {
    const encoded = readFileSync(path, "utf8").trim();
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32) throw new Error(`Invalid memoryd master key at ${path}`);
    return key;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  try {
    writeFileSync(path, `${key.toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
    return key;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    const encoded = readFileSync(path, "utf8").trim();
    const existing = Buffer.from(encoded, "base64url");
    if (existing.length !== 32) throw new Error(`Invalid memoryd master key at ${path}`);
    return existing;
  }
}

function gitValue(cwd: string, args: string[]): string | undefined {
  try {
    const value = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRemote(remote: string): string {
  return remote
    .replace(/^[^@\s]+@([^:]+):/, "ssh://$1/")
    .replace(/:\/\/[^/@]+@/, "://")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

export interface WorkspaceIdentity {
  workspaceId: string;
  root: string;
  branch?: string;
  commit?: string;
}

export function resolveWorkspaceIdentity(cwd: string, key: Buffer): WorkspaceIdentity {
  const root = gitValue(cwd, ["rev-parse", "--show-toplevel"]) ?? realpathSync(cwd);
  const remote = gitValue(root, ["remote", "get-url", "origin"]);
  const stableInput = remote === undefined ? `path:${realpathSync(root)}` : `remote:${normalizeRemote(remote)}`;
  const workspaceId = createHmac("sha256", key).update(stableInput).digest("hex").slice(0, 32);
  const branch = gitValue(root, ["branch", "--show-current"]);
  const commit = gitValue(root, ["rev-parse", "HEAD"]);
  return {
    workspaceId,
    root,
    ...(branch === undefined ? {} : { branch }),
    ...(commit === undefined ? {} : { commit }),
  };
}

export function toolsetDigest(toolNames: readonly string[]): string {
  return createHash("sha256").update([...toolNames].sort().join("\n")).digest("hex").slice(0, 16);
}
