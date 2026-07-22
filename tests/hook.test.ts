import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replayHookSpool, runHook } from "../src/adapters/hook.js";
import type { RuntimeConfig } from "../src/config.js";
import { createMemoryHttpServer } from "../src/http/server.js";
import { MemoryRuntime } from "../src/runtime.js";
import { MemoryStore } from "../src/storage/index.js";

const originalEnvironment = { ...process.env };
const directories: string[] = [];

afterEach(() => {
  process.env = { ...originalEnvironment };
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("hook degradation queue", () => {
  it("encrypts failed hook payloads and replays them idempotently when memoryd returns", async () => {
    const home = mkdtempSync(join(tmpdir(), "memoryd-hook-"));
    directories.push(home);
    process.env.MEMORYD_HOME = home;
    process.env.MEMORYD_URL = "http://127.0.0.1:1";
    process.env.MEMORYD_USER_ID = "hook-user";
    const marker = "queued-private-prompt-marker";
    const payload = { sessionId: "queued-session", cwd: home, prompt: marker };

    const degraded = await runHook("generic", "user-prompt", payload);
    expect(degraded).toContain("memoryd unavailable");
    const spool = join(home, "spool", "hook-failures");
    const queuedFiles = readdirSync(spool);
    expect(queuedFiles).toHaveLength(1);
    expect(readFileSync(join(spool, queuedFiles[0]!), "utf8")).not.toContain(marker);

    const store = new MemoryStore({ path: ":memory:", encryptionKey: Buffer.alloc(32, 8), deviceId: "hook" });
    const config: RuntimeConfig = {
      home,
      databasePath: ":memory:",
      keyPath: join(home, "master.key"),
      spoolPath: join(home, "spool"),
      host: "127.0.0.1",
      port: 0,
      deviceId: "hook",
    };
    const server = createMemoryHttpServer(new MemoryRuntime(store), config);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    process.env.MEMORYD_URL = `http://127.0.0.1:${address.port}`;

    try {
      expect(await replayHookSpool()).toEqual({ replayed: 1, remaining: 0 });
      expect(store.health().eventCount).toBe(1);
      expect(await replayHookSpool()).toEqual({ replayed: 0, remaining: 0 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });
});
