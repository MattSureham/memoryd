#!/usr/bin/env node
import { loadConfig, loadOrCreateMasterKey } from "./config.js";
import { createMemoryHttpServer } from "./http/server.js";
import { riskClassifierFromEnvironment } from "./providers/http-risk-classifier.js";
import { MemoryRuntime } from "./runtime.js";
import { MemoryStore } from "./storage/index.js";

export function startDaemon(): { close: () => Promise<void> } {
  const config = loadConfig();
  const store = new MemoryStore({
    path: config.databasePath,
    encryptionKey: loadOrCreateMasterKey(config.keyPath),
    deviceId: config.deviceId,
  });
  const classifier = riskClassifierFromEnvironment();
  const runtime = new MemoryRuntime(store, {
    ...(classifier === undefined ? {} : { classifier }),
  });
  const server = createMemoryHttpServer(runtime, config);
  server.listen(config.port, config.host, () => {
    console.error(`memoryd listening on http://${config.host}:${config.port}`);
  });
  const learningTimer = setInterval(() => {
    try {
      runtime.processLearningJobs(25);
    } catch (error) {
      console.error(`memoryd learning worker: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, config.learningIntervalMs);
  learningTimer.unref();

  const close = async (): Promise<void> => {
    clearInterval(learningTimer);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    store.close();
  };
  return { close };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const daemon = startDaemon();
  const shutdown = () => {
    daemon.close().then(() => process.exit(0)).catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
