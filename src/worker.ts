import { createReportWorker } from "./jobs.js";
import { redis } from "./redis.js";

const worker = createReportWorker();
console.info(JSON.stringify({ event: "worker_ready", name: "bmw-transformer-reports" }));
const shutdown = async (signal: string) => {
  console.info(JSON.stringify({ event: "worker_shutdown_started", signal }));
  await worker.close();
  await redis.quit();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
