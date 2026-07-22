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
