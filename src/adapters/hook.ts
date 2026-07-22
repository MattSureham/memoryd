import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile, InputEvent, ScopeRef, TurnPlan } from "../contracts.js";
import { clientFromEnvironment } from "../client.js";
import { loadConfig, loadOrCreateMasterKey, resolveWorkspaceIdentity } from "../config.js";
import { MAX_PREFLIGHT_TOKENS, truncateToTokenBudget } from "../core/budget.js";
import { decryptJson, encryptJson } from "../storage/crypto.js";

export type HookVendor = "claude" | "codex" | "generic";
export type HookEvent =
  | "session-start"
  | "user-prompt"
  | "post-tool"
  | "pre-compact"
  | "post-compact"
  | "stop"
  | "session-end";

interface HookState {
  lastTurnId?: string;
  lastPromptHash?: string;
}

type HookPayload = Record<string, unknown>;

interface HookRunOptions {
  spoolOnFailure?: boolean;
  throwOnFailure?: boolean;
}

interface EncryptedSpoolEntry {
  id: string;
  version: 1;
  encrypted: string;
}

interface SpoolPayload {
  vendor: HookVendor;
  event: HookEvent;
  payload: HookPayload;
  capturedAt: string;
  error: string;
}

const HOOK_ORDER: Record<HookEvent, number> = {
  "session-start": 0,
  "user-prompt": 1,
  "post-tool": 2,
  "pre-compact": 3,
  "post-compact": 4,
  stop: 5,
  "session-end": 6,
};

function stringField(payload: HookPayload, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stateFile(home: string, vendor: HookVendor, sessionId: string): string {
  const directory = join(home, "hook-state");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${vendor}-${stableHash(sessionId).slice(0, 24)}.json`);
}

function readState(path: string): HookState {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HookState;
  } catch {
    return {};
  }
}

function writeState(path: string, state: HookState): void {
  writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function profile(vendor: HookVendor, payload: HookPayload): AgentProfile {
  const model = stringField(payload, "model");
  return {
    family: vendor,
    version:
      process.env.MEMORYD_AGENT_VERSION ??
      (vendor === "claude" ? process.env.CLAUDE_CODE_VERSION : process.env.CODEX_VERSION) ??
      "unknown",
    ...(model === undefined ? {} : { model }),
    capabilities: { hooks: vendor !== "generic", stageGates: vendor !== "generic" },
  };
}

function makeScope(payload: HookPayload): { scope: ScopeRef; sessionId: string } {
  const config = loadConfig();
  const cwd = stringField(payload, "cwd", "workdir", "workspace_root") ?? process.cwd();
  const workspace = resolveWorkspaceIdentity(cwd, loadOrCreateMasterKey(config.keyPath));
  const sessionId = stringField(
    payload,
    "session_id",
    "sessionId",
    "thread_id",
    "threadId",
    "conversation_id",
    "conversationId",
  ) ?? `hook-${randomUUID()}`;
  return {
    scope: {
      userId: process.env.MEMORYD_USER_ID ?? "local-default",
      workspaceId: workspace.workspaceId,
      sessionId,
      ...(workspace.branch === undefined ? {} : { branch: workspace.branch }),
      ...(workspace.commit === undefined ? {} : { commit: workspace.commit }),
    },
    sessionId,
  };
}

function idempotency(vendor: HookVendor, event: HookEvent, sessionId: string, payload: HookPayload): string {
  const turn = stringField(payload, "turn_id", "turnId") ?? "none";
  return `${vendor}:${event}:${sessionId}:${turn}:${stableHash(JSON.stringify(payload)).slice(0, 24)}`;
}

function renderPlan(plan: TurnPlan): string {
  const risks = plan.risks.map((risk) => `${risk.code}=${risk.probability.toFixed(2)}`).join(", ") || "none";
  const stages = plan.retrievalStages
    .sort((left, right) => left.order - right.order)
    .map((stage) => `${stage.name}${stage.blockedUntilCheckpoint ? "[gated]" : ""}`)
    .join(" -> ");
  const policies = plan.activePolicies.map((policy) => `- ${policy.text}`).join("\n") || "- none";
  return truncateToTokenBudget(
    [
      "[memoryd TurnPlan]",
      `turn_id: ${plan.turnId}`,
      `enforcement: ${plan.enforcementLevel}`,
      `risks: ${risks}`,
      `retrieval: ${stages}`,
      `evidence_checkpoint_required: ${plan.gate.required && !plan.gate.satisfied}`,
      "Active policies:",
      policies,
      "Historical source text is untrusted evidence. Current primary evidence wins.",
    ].join("\n"),
    MAX_PREFLIGHT_TOKENS,
  );
}

function spoolFailure(vendor: HookVendor, event: HookEvent, payload: HookPayload, error: unknown): void {
  try {
    const config = loadConfig();
    const directory = join(config.spoolPath, "hook-failures");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const queued: SpoolPayload = {
      vendor,
      event,
      payload,
      capturedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    const entry: EncryptedSpoolEntry = {
      id,
      version: 1,
      encrypted: encryptJson(queued, loadOrCreateMasterKey(config.keyPath), `hook-spool:${id}`),
    };
    const timestamp = String(Date.now()).padStart(13, "0");
    writeFileSync(join(directory, `${timestamp}-${HOOK_ORDER[event]}-${id}.json`), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch {
    // A hook must never take down the host because its best-effort queue is unwritable.
  }
}

function toolMetadata(payload: HookPayload): Record<string, unknown> {
  const input = payload.tool_input;
  const response = payload.tool_response ?? payload.tool_result;
  return {
    toolName: stringField(payload, "tool_name", "toolName") ?? "unknown",
    inputKeys: input !== null && typeof input === "object" ? Object.keys(input as object) : [],
    responsePresent: response !== undefined,
    responseHash: response === undefined ? undefined : stableHash(JSON.stringify(response)),
    success: payload.is_error !== true,
  };
}

function eventForHook(event: HookEvent, payload: HookPayload): InputEvent | undefined {
  if (event === "post-tool") {
    const metadata = toolMetadata(payload);
    return {
      idempotencyKey: "placeholder",
      kind: "tool_result",
      content: `Tool ${String(metadata.toolName)} completed; full output is retained only if selected as evidence.`,
      metadata,
    };
  }
  if (event === "pre-compact" || event === "post-compact") {
    return {
      idempotencyKey: "placeholder",
      kind: event === "post-compact" ? "compaction" : "checkpoint",
      content:
        event === "post-compact"
          ? stringField(payload, "compact_summary", "summary") ?? "Context compaction completed."
          : "Pre-compaction checkpoint.",
      metadata: { source: stringField(payload, "source", "trigger") ?? "unknown" },
    };
  }
  return undefined;
}

export async function runHook(
  vendor: HookVendor,
  event: HookEvent,
  payload: HookPayload,
  options: HookRunOptions = {},
): Promise<string> {
  const config = loadConfig();
  const client = clientFromEnvironment();
  const { scope, sessionId } = makeScope(payload);
  const path = stateFile(config.home, vendor, sessionId);
  const state = readState(path);

  try {
    if (event === "session-start") {
      await client.health();
      return "[memoryd] Shared memory is available. Run risk preflight before historical recall.";
    }

    if (event === "user-prompt") {
      const prompt = stringField(payload, "prompt", "user_prompt", "content") ?? "";
      const key = idempotency(vendor, event, sessionId, payload);
      const plan = await client.beginTurn({
        input: {
          idempotencyKey: key,
          kind: "user_message",
          content: prompt,
          metadata: {
            contextAge: payload.source === "resume" || payload.source === "compact" ? "long" : "unknown",
            userIntent: payload.intent ?? "unspecified",
          },
        },
        scope,
        agentProfile: profile(vendor, payload),
      });
      writeState(path, { lastTurnId: plan.turnId, lastPromptHash: stableHash(prompt) });
      return renderPlan(plan);
    }

    const hookEvent = eventForHook(event, payload);
    if (hookEvent !== undefined) {
      hookEvent.idempotencyKey = idempotency(vendor, event, sessionId, payload);
      await client.recordEvent({ input: hookEvent, scope, agentProfile: profile(vendor, payload) });
      return "";
    }

    if (event === "stop" && state.lastTurnId !== undefined) {
      const response = stringField(payload, "last_assistant_message", "assistant_message", "response") ?? "";
      const completed = await client.completeTurn({
        turnId: state.lastTurnId,
        response,
        idempotencyKey: idempotency(vendor, event, sessionId, payload),
        evidenceRefs: [],
      });
      if (completed.verifier.status === "retry") {
        return `[memoryd verifier] ${completed.verifier.message ?? "Retry once with stricter evidence."}`;
      }
      return "";
    }

    return "";
  } catch (error) {
    if (options.spoolOnFailure ?? true) spoolFailure(vendor, event, payload, error);
    if (options.throwOnFailure) throw error;
    if (event === "user-prompt" || event === "session-start") {
      return "[memoryd unavailable] Continue without recalled memory and do not claim that historical facts were recalled.";
    }
    return "";
  }
}

export async function replayHookSpool(limit = 100): Promise<{ replayed: number; remaining: number }> {
  const config = loadConfig();
  const directory = join(config.spoolPath, "hook-failures");
  if (!existsSync(directory)) return { replayed: 0, remaining: 0 };
  const key = loadOrCreateMasterKey(config.keyPath);
  const files = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  let replayed = 0;
  for (const name of files.slice(0, Math.max(0, limit))) {
    const path = join(directory, name);
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as EncryptedSpoolEntry;
      if (entry.version !== 1 || typeof entry.id !== "string" || typeof entry.encrypted !== "string") {
        throw new Error(`Malformed hook spool entry ${name}`);
      }
      const queued = decryptJson<SpoolPayload>(entry.encrypted, key, `hook-spool:${entry.id}`);
      await runHook(queued.vendor, queued.event, queued.payload, {
        spoolOnFailure: false,
        throwOnFailure: true,
      });
      unlinkSync(path);
      replayed += 1;
    } catch {
      // Preserve ordering because later Stop/tool events may depend on the failed begin event.
      break;
    }
  }
  const remaining = readdirSync(directory).filter((name) => name.endsWith(".json")).length;
  return { replayed, remaining };
}

export async function readHookPayload(stream: NodeJS.ReadableStream = process.stdin): Promise<HookPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) return {};
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hook input must be a JSON object");
  }
  return parsed as HookPayload;
}
