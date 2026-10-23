import { createReportWorker } from "./jobs.js";
import { redis } from "./redis.js";
import { config } from "./config.js";
import { closeSqlPool, getSqlPool } from "./sql/client.js";
import { cleanupStaleTemporaryTables } from "./sql/persist-pivot.js";

if (config.sqlEnabled) {
  await getSqlPool();
  await cleanupStaleTemporaryTables();
}
const worker = createReportWorker();
console.info(JSON.stringify({ event: "worker_ready", name: "bmw-transformer-reports" }));
const shutdown = async (signal: string) => {
  console.info(JSON.stringify({ event: "worker_shutdown_started", signal }));
  await worker.close();
  await closeSqlPool();
  await redis.quit();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
