import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { MemoryClient } from "../src/client.js";
import type { RuntimeConfig } from "../src/config.js";
import { createMemoryHttpServer } from "../src/http/server.js";
import { MemoryRuntime } from "../src/runtime.js";
import { MemoryStore } from "../src/storage/index.js";

describe("localhost API", () => {
  it("serves the canonical turn protocol with bearer authentication", async () => {
    const store = new MemoryStore({ path: ":memory:", encryptionKey: Buffer.alloc(32, 9), deviceId: "http-device" });
    const config: RuntimeConfig = {
      home: "/tmp/unused",
      databasePath: ":memory:",
      keyPath: "/tmp/unused-key",
      spoolPath: "/tmp/unused-spool",
      host: "127.0.0.1",
      port: 0,
      bearerToken: "test-token",
      deviceId: "http-device",
      learningIntervalMs: 5_000,
    };
    const server = createMemoryHttpServer(new MemoryRuntime(store), config);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    const client = new MemoryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "test-token" });
    try {
      expect((await client.health()).protocolVersion).toBe("1.1");
      const handshake = await fetch(`http://127.0.0.1:${address.port}/v1/handshake`, {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
      });
      expect(await handshake.json()).toMatchObject({
        protocolVersion: "1.1",
        supports: {
          hybridRetrieval: true,
          reexperienceWorkset: true,
          triggerLearning: true,
          sessionLifecycle: true,
        },
      });
      const invalid = await fetch(`http://127.0.0.1:${address.port}/v1/turns/begin`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-token" },
        body: JSON.stringify({
          input: { idempotencyKey: "missing-session", kind: "user_message", content: "invalid" },
          scope: { userId: "u", workspaceId: "w" },
          agentProfile: { family: "mock", version: "1", capabilities: { hooks: true, stageGates: true } },
        }),
      });
      expect(invalid.status).toBe(400);
      const plan = await client.beginTurn({
        input: { idempotencyKey: "http-turn", kind: "user_message", content: "Remember the previous code" },
        scope: { userId: "u", workspaceId: "w", sessionId: "s" },
        agentProfile: { family: "mock", version: "1", capabilities: { hooks: true, stageGates: true } },
      });
      expect(plan.turnId).toMatch(/^turn_/);
      const completed = await client.completeTurn({
        turnId: plan.turnId,
        response: "I cannot claim a memory without evidence.",
        idempotencyKey: "http-complete",
        evidenceRefs: [],
      });
      expect(completed.verifier.status).toBe("pass");

      const worksetPlan = await client.beginTurn({
        input: { idempotencyKey: "http-workset", kind: "user_message", content: "Summarize the notes" },
        scope: { userId: "u", workspaceId: "w", sessionId: "workset-session" },
        agentProfile: { family: "mock", version: "1", capabilities: { hooks: true, stageGates: true } },
      });
      const workset = await client.buildWorkset({
        turnId: worksetPlan.turnId,
        query: "previous code",
        recentTurns: 20,
        budgetTokens: 2_000,
      });
      expect(workset).toMatchObject({ stage: "reexperience", reexperiencePack: expect.any(Object) });

      const ended = await client.endSession({
        scope: { userId: "u", workspaceId: "w", sessionId: "workset-session" },
        idempotencyKey: "http-session-end",
      });
      expect(ended.sessionId).toBe("workset-session");
      await expect(client.beginTurn({
        input: { idempotencyKey: "http-after-end", kind: "user_message", content: "Too late" },
        scope: { userId: "u", workspaceId: "w", sessionId: "workset-session" },
        agentProfile: { family: "mock", version: "1", capabilities: { hooks: true, stageGates: true } },
      })).rejects.toMatchObject({ shape: { code: "VERSION_CONFLICT" } });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });
});
