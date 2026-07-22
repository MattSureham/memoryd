import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MemoryRuntime } from "../src/runtime.js";
import { MemoryStore } from "../src/storage/index.js";

const count = Number.parseInt(process.env.MEMORYD_BENCH_EVENTS ?? "100000", 10);
const iterations = Number.parseInt(process.env.MEMORYD_BENCH_ITERATIONS ?? "100", 10);
const path = join(mkdtempSync(join(tmpdir(), "memoryd-bench-")), "bench.db");
const store = new MemoryStore({ path, encryptionKey: Buffer.alloc(32, 3), deviceId: "benchmark" });
const runtime = new MemoryRuntime(store);
const scope = { userId: "bench", workspaceId: "workspace", sessionId: "seed" };
const agent = { family: "mock", version: "1", capabilities: { hooks: true, stageGates: true } };

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

for (let index = 0; index < count; index += 1) {
  runtime.recordEvent({
    input: {
      idempotencyKey: `seed-${index}`,
      kind: "user_message",
      content: `benchmark memory topic-${index % 1000} event-${index}`,
    },
    scope,
    agentProfile: agent,
  });
}

const preflight: number[] = [];
const recall: number[] = [];
for (let index = 0; index < iterations; index += 1) {
  const started = performance.now();
  const plan = await runtime.beginTurn({
    input: { idempotencyKey: `turn-${index}`, kind: "user_message", content: `Find topic-${index % 1000}` },
    scope: { ...scope, sessionId: `turn-${index}` },
    agentProfile: agent,
  });
  preflight.push(performance.now() - started);
  const recallStarted = performance.now();
  runtime.recall({ turnId: plan.turnId, stage: "source_expansion", query: `topic-${index % 1000}` });
  recall.push(performance.now() - recallStarted);
}

const report = {
  events: count,
  iterations,
  preflightP95Ms: Number(percentile(preflight, 0.95).toFixed(2)),
  recallP95Ms: Number(percentile(recall, 0.95).toFixed(2)),
  targets: { preflightP95Ms: 150, recallP95Ms: 500 },
};
console.log(JSON.stringify(report, null, 2));
store.close();
