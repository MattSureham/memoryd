import type {
  BeginTurnInput,
  CheckpointEvidenceInput,
  CheckpointEvidenceResult,
  CompleteTurnInput,
  CompleteTurnResult,
  CorrectionInput,
  MemoryBundle,
  RecallInput,
  RecordEventInput,
  SourceEvent,
  SourceRef,
  TurnPlan,
} from "./contracts.js";
import { ProtocolError, type ProtocolErrorShape } from "./contracts.js";

export interface MemoryClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
}

export class MemoryClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: MemoryClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:7337").replace(/\/$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 2_000;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("memoryd request timeout")), this.timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      if (init.body !== undefined) headers.set("content-type", "application/json");
      if (this.token !== undefined) headers.set("authorization", `Bearer ${this.token}`);
      const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
      const payload = (await response.json()) as T | { error: ProtocolErrorShape };
      if (!response.ok) {
        const error = "error" in (payload as object) ? (payload as { error: ProtocolErrorShape }).error : undefined;
        throw new ProtocolError(
          error ?? { code: "MEMORY_UNAVAILABLE", message: `memoryd returned HTTP ${response.status}` },
        );
      }
      return payload as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  health(): Promise<Record<string, unknown>> {
    return this.request("/v1/health");
  }

  beginTurn(input: BeginTurnInput): Promise<TurnPlan> {
    return this.request("/v1/turns/begin", { method: "POST", body: JSON.stringify(input) });
  }

  recordEvent(input: RecordEventInput): Promise<SourceEvent> {
    return this.request("/v1/events", { method: "POST", body: JSON.stringify(input) });
  }

  checkpointEvidence(input: CheckpointEvidenceInput): Promise<CheckpointEvidenceResult> {
    return this.request(`/v1/turns/${encodeURIComponent(input.turnId)}/checkpoint`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  recall(input: RecallInput): Promise<MemoryBundle> {
    return this.request(`/v1/turns/${encodeURIComponent(input.turnId)}/recall`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getSources(turnId: string, sourceRefs: readonly SourceRef[]): Promise<SourceEvent[]> {
    return this.request("/v1/sources/get", { method: "POST", body: JSON.stringify({ turnId, sourceRefs }) });
  }

  submitCorrection(input: CorrectionInput): Promise<Record<string, unknown>> {
    return this.request(`/v1/turns/${encodeURIComponent(input.turnId)}/corrections`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  completeTurn(input: CompleteTurnInput): Promise<CompleteTurnResult> {
    return this.request(`/v1/turns/${encodeURIComponent(input.turnId)}/complete`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
}

export function clientFromEnvironment(environment: NodeJS.ProcessEnv = process.env): MemoryClient {
  return new MemoryClient({
    baseUrl: environment.MEMORYD_URL ?? `http://${environment.MEMORYD_HOST ?? "127.0.0.1"}:${environment.MEMORYD_PORT ?? "7337"}`,
    ...(environment.MEMORYD_TOKEN === undefined ? {} : { token: environment.MEMORYD_TOKEN }),
  });
}
