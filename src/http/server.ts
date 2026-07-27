import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as z from "zod/v4";
import { PROTOCOL_VERSION, ProtocolError, type ProtocolErrorShape, type RecordEventInput } from "../contracts.js";
import type { RuntimeConfig } from "../config.js";
import { MemoryRuntime } from "../runtime.js";
import {
  AgentProfileSchema,
  BeginTurnSchema,
  BuildWorksetSchema,
  CheckpointEvidenceSchema,
  CompleteTurnSchema,
  CorrectionSchema,
  EndSessionSchema,
  InputEventSchema,
  RecallSchema,
  RetrieveMemorySchema,
  SourceRefSchema,
  TurnScopeSchema,
} from "../schemas.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const RecordEventSchema = z.object({
  input: InputEventSchema,
  scope: TurnScopeSchema,
  agentProfile: AgentProfileSchema,
  selectedEvidence: z.boolean().optional(),
});

const SourcesSchema = z.object({
  turnId: z.string().min(1),
  sourceRefs: z.array(SourceRefSchema).min(1).max(50),
});

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ProtocolError({ code: "INVALID_REQUEST", message: "Request body exceeds 2 MiB" });
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (body.length === 0) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ProtocolError({ code: "INVALID_REQUEST", message: "Request body must be valid JSON" });
  }
}

function errorShape(error: unknown): { status: number; shape: ProtocolErrorShape } {
  if (error instanceof ProtocolError) {
    const status =
      error.shape.code === "NOT_FOUND" || error.shape.code === "TURN_NOT_FOUND"
        ? 404
        : error.shape.code === "SCOPE_DENIED"
          ? 403
          : error.shape.code === "STAGE_BLOCKED" || error.shape.code === "VERSION_CONFLICT"
            ? 409
            : 400;
    return { status, shape: error.shape };
  }
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      shape: {
        code: "INVALID_REQUEST",
        message: "Request validation failed",
        details: { issues: error.issues },
      },
    };
  }
  return {
    status: 500,
    shape: { code: "MEMORY_UNAVAILABLE", message: error instanceof Error ? error.message : "Unknown memoryd error" },
  };
}

function authorized(request: IncomingMessage, config: RuntimeConfig): boolean {
  if (config.bearerToken === undefined) return true;
  return request.headers.authorization === `Bearer ${config.bearerToken}`;
}

function assertTurnPath(pathTurnId: string, bodyTurnId: string): void {
  if (pathTurnId !== bodyTurnId) {
    throw new ProtocolError({ code: "INVALID_REQUEST", message: "Path turn ID does not match request body" });
  }
}

export function createMemoryHttpServer(runtime: MemoryRuntime, config: RuntimeConfig): Server {
  return createServer(async (request, response) => {
    try {
      if (!authorized(request, config)) {
        json(response, 401, { error: { code: "SCOPE_DENIED", message: "Invalid memoryd bearer token" } });
        return;
      }

      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (method === "GET" && url.pathname === "/v1/health") {
        json(response, 200, runtime.health());
        return;
      }
      if (method === "POST" && url.pathname === "/v1/handshake") {
        json(response, 200, {
          protocolVersion: PROTOCOL_VERSION,
          transports: ["http", "mcp-stdio", "cli"],
          maxRecallTokens: 8_000,
          supports: {
            stageGates: true,
            encryptedExport: true,
            continuousSync: false,
            hybridRetrieval: true,
            reexperienceWorkset: true,
            triggerLearning: true,
            sessionLifecycle: true,
            objectRoutedRetrieval: true,
            dynamicMemoryCurator: true,
          },
        });
        return;
      }
      if (method === "POST" && url.pathname === "/v1/events") {
        const input = RecordEventSchema.parse(await readJson(request)) as unknown as RecordEventInput;
        json(response, 201, runtime.recordEvent(input));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/turns/begin") {
        const input = BeginTurnSchema.parse(await readJson(request));
        json(response, 201, await runtime.beginTurn(input as never));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/sources/get") {
        const input = SourcesSchema.parse(await readJson(request));
        json(response, 200, runtime.getSources(input.turnId, input.sourceRefs as never));
        return;
      }
      if (method === "POST" && url.pathname === "/v1/sessions/end") {
        const input = EndSessionSchema.parse(await readJson(request));
        json(response, 200, runtime.endSession(input as never));
        return;
      }

      const checkpoint = url.pathname.match(/^\/v1\/turns\/([^/]+)\/checkpoint$/);
      if (method === "POST" && checkpoint?.[1] !== undefined) {
        const input = CheckpointEvidenceSchema.parse(await readJson(request));
        assertTurnPath(decodeURIComponent(checkpoint[1]), input.turnId);
        json(response, 200, runtime.checkpointEvidence(input as never));
        return;
      }
      const recall = url.pathname.match(/^\/v1\/turns\/([^/]+)\/recall$/);
      if (method === "POST" && recall?.[1] !== undefined) {
        const input = RecallSchema.parse(await readJson(request));
        assertTurnPath(decodeURIComponent(recall[1]), input.turnId);
        json(response, 200, runtime.recall(input as never));
        return;
      }
      const retrieve = url.pathname.match(/^\/v1\/turns\/([^/]+)\/retrieve$/);
      if (method === "POST" && retrieve?.[1] !== undefined) {
        const input = RetrieveMemorySchema.parse(await readJson(request));
        assertTurnPath(decodeURIComponent(retrieve[1]), input.turnId);
        json(response, 200, runtime.retrieveMemory(input as never));
        return;
      }
      const workset = url.pathname.match(/^\/v1\/turns\/([^/]+)\/workset$/);
      if (method === "POST" && workset?.[1] !== undefined) {
        const input = BuildWorksetSchema.parse(await readJson(request));
        assertTurnPath(decodeURIComponent(workset[1]), input.turnId);
        json(response, 200, runtime.buildWorkset(input as never));
        return;
      }
      const correction = url.pathname.match(/^\/v1\/turns\/([^/]+)\/corrections$/);
      if (method === "POST" && correction?.[1] !== undefined) {
        const input = CorrectionSchema.parse(await readJson(request));
        assertTurnPath(decodeURIComponent(correction[1]), input.turnId);
        json(response, 201, runtime.submitCorrection(input as never));
        return;
      }
      const complete = url.pathname.match(/^\/v1\/turns\/([^/]+)\/complete$/);
      if (method === "POST" && complete?.[1] !== undefined) {
        const input = CompleteTurnSchema.parse(await readJson(request));
        assertTurnPath(decodeURIComponent(complete[1]), input.turnId);
        json(response, 200, runtime.completeTurn(input as never));
        return;
      }

      json(response, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    } catch (error) {
      const mapped = errorShape(error);
      json(response, mapped.status, { error: mapped.shape });
    }
  });
}
