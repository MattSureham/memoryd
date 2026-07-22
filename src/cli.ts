#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientFromEnvironment } from "./client.js";
import { loadConfig, loadOrCreateMasterKey, resolveWorkspaceIdentity } from "./config.js";
import { readHookPayload, replayHookSpool, runHook, type HookEvent, type HookVendor } from "./adapters/hook.js";
import { installAdapters, type InstallScope, type InstallTarget } from "./install.js";
import { MemoryStore, type ForgetSelector, type StoredPolicy } from "./storage/index.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function output(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function usage(): never {
  process.stderr.write(`memoryctl commands:
  start | stop | doctor | replay
  inspect [id] [--all]
  approve <policy-id> | revoke <policy-id>
  forget <entity-type> <entity-id> --reason <text>
  export <file> [--passphrase <text>]
  import <file> [--passphrase <text>]
  reindex
  install <claude|codex|all> [--scope user|project]
  hook <claude|codex|generic> <event>
`);
  process.exit(2);
}

function openStore(): MemoryStore {
  const config = loadConfig();
  return new MemoryStore({
    path: config.databasePath,
    encryptionKey: loadOrCreateMasterKey(config.keyPath),
    deviceId: config.deviceId,
  });
}

function currentScope() {
  const config = loadConfig();
  const workspace = resolveWorkspaceIdentity(process.cwd(), loadOrCreateMasterKey(config.keyPath));
  return {
    userId: process.env.MEMORYD_USER_ID ?? "local-default",
    workspaceId: workspace.workspaceId,
  };
}

async function start(): Promise<void> {
  const config = loadConfig();
  const pidPath = join(config.home, "memoryd.pid");
  if (existsSync(pidPath)) {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    try {
      process.kill(pid, 0);
      output({ status: "already-running", pid });
      return;
    } catch {
      unlinkSync(pidPath);
    }
  }
  const compiled = fileURLToPath(new URL("./daemon.js", import.meta.url));
  const source = fileURLToPath(new URL("./daemon.ts", import.meta.url));
  const log = openSync(join(config.home, "memoryd.log"), "a", 0o600);
  const child = existsSync(compiled)
    ? spawn(process.execPath, [compiled], { detached: true, stdio: ["ignore", log, log], env: process.env })
    : spawn(process.execPath, ["--import", "tsx", source], { detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
  if (child.pid === undefined) throw new Error("Failed to start memoryd");
  writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
  output({ status: "started", pid: child.pid, url: `http://${config.host}:${config.port}` });
}

function stop(): void {
  const config = loadConfig();
  const pidPath = join(config.home, "memoryd.pid");
  if (!existsSync(pidPath)) {
    output({ status: "not-running" });
    return;
  }
  const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  unlinkSync(pidPath);
  output({ status: "stopped", pid });
}

async function doctor(): Promise<void> {
  const store = openStore();
  try {
    const local = store.health();
    let daemon: unknown;
    try {
      daemon = await clientFromEnvironment().health();
    } catch (error) {
      daemon = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    output({ local, daemon });
  } finally {
    store.close();
  }
}

function inspect(id: string | undefined, includeAll: boolean): void {
  const store = openStore();
  try {
    const scope = currentScope();
    const administrative = includeAll || id !== undefined;
    const data = {
      health: store.health(),
      worldClaims: store.listWorldClaims(scope, administrative, undefined, administrative),
      policies: store.listPolicies(scope, administrative, administrative),
      episodes: store.listEpisodes(scope),
      corrections: store.listCorrections(scope, administrative),
      failureClusters: store.listFailureClusters(scope),
      triggers: store.listTriggers(scope, administrative),
    };
    if (id === undefined) output(data);
    else {
      const matches = Object.fromEntries(
        Object.entries(data).map(([key, value]) => [
          key,
          Array.isArray(value)
            ? value.filter((item) => JSON.stringify(item).includes(id))
            : value,
        ]),
      );
      output(matches);
    }
  } finally {
    store.close();
  }
}

function changePolicy(policyId: string, status: "approved" | "revoked"): void {
  const store = openStore();
  try {
    const current = store.getPolicy(policyId);
    if (current === undefined) throw new Error(`Policy ${policyId} was not found`);
    if (status === "approved") {
      const eligibility = store.policyApprovalEligibility(policyId);
      if (!eligibility.eligible) throw new Error(eligibility.reason);
    }
    const next: StoredPolicy = {
      ...current,
      version: current.version + 1,
      reviewStatus: status,
      authority: current.authority,
    };
    output(store.putPolicy(next, `${status}:${policyId}:${next.version}`));
  } finally {
    store.close();
  }
}

function forget(entityType: string, entityId: string, reason: string): void {
  const store = openStore();
  try {
    const selector: ForgetSelector = {
      userId: process.env.MEMORYD_USER_ID ?? "local-default",
      entityType,
      entityId,
      reason,
    };
    output(store.forget(selector));
  } finally {
    store.close();
  }
}

function exportData(path: string, passphrase?: string): void {
  const store = openStore();
  try {
    const encoded = store.exportData(passphrase === undefined ? {} : { encryptionKey: passphrase });
    writeFileSync(path, encoded, { mode: 0o600 });
    output({ exported: path, revision: store.getRevision(), portableKey: passphrase !== undefined });
  } finally {
    store.close();
  }
}

function importData(path: string, passphrase?: string): void {
  const store = openStore();
  try {
    const encoded = readFileSync(path, "utf8");
    output(store.importData(encoded, passphrase === undefined ? {} : { encryptionKey: passphrase }));
  } finally {
    store.close();
  }
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  if (command === "start") return await start();
  if (command === "stop") return stop();
  if (command === "doctor") return await doctor();
  if (command === "replay") return output(await replayHookSpool());
  if (command === "inspect") return inspect(args[1], has(args, "--all"));
  if (command === "approve" && args[1] !== undefined) return changePolicy(args[1], "approved");
  if (command === "revoke" && args[1] !== undefined) return changePolicy(args[1], "revoked");
  if (command === "forget" && args[1] !== undefined && args[2] !== undefined) {
    const reason = option(args, "--reason");
    if (reason === undefined) throw new Error("forget requires --reason");
    return forget(args[1], args[2], reason);
  }
  if (command === "export" && args[1] !== undefined) return exportData(args[1], option(args, "--passphrase"));
  if (command === "import" && args[1] !== undefined) return importData(args[1], option(args, "--passphrase"));
  if (command === "reindex") {
    const store = openStore();
    try {
      return output(store.reindex());
    } finally {
      store.close();
    }
  }
  if (command === "install" && args[1] !== undefined) {
    const target = args[1] as InstallTarget;
    const scope = (option(args, "--scope") ?? "project") as InstallScope;
    if (!["claude", "codex", "all"].includes(target) || !["user", "project"].includes(scope)) usage();
    return output(installAdapters({ target, scope }));
  }
  if (command === "hook" && args[1] !== undefined && args[2] !== undefined) {
    const vendor = args[1] as HookVendor;
    const event = args[2] as HookEvent;
    if (!["claude", "codex", "generic"].includes(vendor)) usage();
    const result = await runHook(vendor, event, await readHookPayload());
    if (event === "session-start" && !result.includes("memoryd unavailable")) {
      await replayHookSpool();
    }
    if (result.length > 0) process.stdout.write(`${result}\n`);
    return;
  }
  usage();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { main as runCli };
