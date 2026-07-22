import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { MemoryClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp/server.js";
import { MemoryRuntime } from "../src/runtime.js";
import { MemoryStore } from "../src/storage/index.js";

describe("MCP adapter", () => {
  it("publishes the canonical tools and preserves server-side stage gates", async () => {
    const store = new MemoryStore({ path: ":memory:", encryptionKey: Buffer.alloc(32, 6), deviceId: "mcp" });
    const runtime = new MemoryRuntime(store);
    const adapter = {
      beginTurn: runtime.beginTurn.bind(runtime),
      checkpointEvidence: async (input: Parameters<typeof runtime.checkpointEvidence>[0]) => runtime.checkpointEvidence(input),
      recall: async (input: Parameters<typeof runtime.recall>[0]) => runtime.recall(input),
      getSources: async (turnId: string, sourceRefs: Parameters<typeof runtime.getSources>[1]) =>
        runtime.getSources(turnId, sourceRefs),
      submitCorrection: async (input: Parameters<typeof runtime.submitCorrection>[0]) => runtime.submitCorrection(input),
      completeTurn: async (input: Parameters<typeof runtime.completeTurn>[0]) => runtime.completeTurn(input),
    } as unknown as MemoryClient;
    const server = createMcpServer(adapter);
    const client = new Client({ name: "memoryd-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "memory_begin_turn",
        "memory_build_workset",
        "memory_checkpoint_evidence",
        "memory_complete_turn",
        "memory_get_sources",
        "memory_recall",
        "memory_submit_correction",
      ]);

      const begun = await client.callTool({
        name: "memory_begin_turn",
        arguments: {
          content: "这是哪一幕，发生了什么？",
          idempotencyKey: "mcp-gated-turn",
          attachments: [{ uri: "frame.png", mediaType: "image/png" }],
          scope: { userId: "u", workspaceId: "w", sessionId: "s" },
          agentProfile: { family: "mock", version: "1", capabilities: { hooks: true, stageGates: true } },
        },
      });
      const plan = (begun.structuredContent as { result: { turnId: string; gate: { required: boolean } } }).result;
      expect(plan.gate.required).toBe(true);

      const blocked = await client.callTool({
        name: "memory_recall",
        arguments: { turnId: plan.turnId, stage: "episode", query: "scene" },
      });
      expect(blocked.isError).toBe(true);
      expect(blocked.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("STAGE_BLOCKED") }),
      ]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});
