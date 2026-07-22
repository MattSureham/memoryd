import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MemoryRuntime } from "../src/runtime.js";
import { MemoryStore } from "../src/storage/index.js";

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const count = positiveInteger(process.env.MEMORYD_BENCH_EVENTS, 100_000, "MEMORYD_BENCH_EVENTS");
const iterations = positiveInteger(process.env.MEMORYD_BENCH_ITERATIONS, 100, "MEMORYD_BENCH_ITERATIONS");
const batchSize = Math.min(
  count,
  positiveInteger(process.env.MEMORYD_BENCH_BATCH_SIZE, 5_000, "MEMORYD_BENCH_BATCH_SIZE"),
);
const directory = mkdtempSync(join(tmpdir(), "memoryd-bench-"));
const path = join(directory, "bench.db");
const store = new MemoryStore({ path, encryptionKey: Buffer.alloc(32, 3), deviceId: "benchmark" });
const runtime = new MemoryRuntime(store, { embeddingProvider: false });
const scope = { userId: "bench", workspaceId: "workspace", sessionId: "seed" };
const agent = { family: "mock", version: "1", capabilities: { hooks: true, stageGates: true } };
const collectGarbage = (globalThis as { gc?: () => void }).gc;

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

try {
  const seedStarted = performance.now();
  for (let batchStart = 0; batchStart < count; batchStart += batchSize) {
    store.transact(() => {
      for (let index = batchStart; index < Math.min(count, batchStart + batchSize); index += 1) {
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
    });
    // Give native SQLite statements and temporary embedding buffers a chance
    // to be finalized between import batches. This affects setup time only;
    // the online latency samples below do not force garbage collection.
    store.database.pragma("shrink_memory");
    await new Promise<void>((resolve) => setImmediate(resolve));
    collectGarbage?.();
  }
  const seedDurationMs = performance.now() - seedStarted;

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

  const preflightP95Ms = Number(percentile(preflight, 0.95).toFixed(2));
  const recallP95Ms = Number(percentile(recall, 0.95).toFixed(2));
  const targets = { preflightP95Ms: 150, recallP95Ms: 500 };
  const report = {
    mode: "rule-only",
    events: count,
    iterations,
    seedBatchSize: batchSize,
    seedDurationMs: Number(seedDurationMs.toFixed(2)),
    seedEventsPerSecond: Number((count / (seedDurationMs / 1_000)).toFixed(2)),
    preflight: {
      p50Ms: Number(percentile(preflight, 0.5).toFixed(2)),
      p95Ms: preflightP95Ms,
    },
    recall: {
      p50Ms: Number(percentile(recall, 0.5).toFixed(2)),
      p95Ms: recallP95Ms,
    },
    targets,
    targetsMet: {
      preflight: preflightP95Ms < targets.preflightP95Ms,
      recall: recallP95Ms < targets.recallP95Ms,
      all: preflightP95Ms < targets.preflightP95Ms && recallP95Ms < targets.recallP95Ms,
    },
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
