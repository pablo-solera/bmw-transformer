import { Queue, Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { redis } from "./redis.js";
import type { ReportInput, ReportState } from "./types.js";
import { runReportJob } from "./pipeline/run-report.js";
import { deleteObject, objectKey } from "./storage.js";

const queueOptions = { connection: redis };
export const reportQueue = new Queue("bmw-transformer-reports", queueOptions);
const stateKey = (requestId: string) => `bmw-transformer:report:${requestId}`;

export async function getReportState(requestId: string): Promise<ReportState | null> {
  const value = await redis.get(stateKey(requestId));
  return value ? JSON.parse(value) as ReportState : null;
}

async function saveState(state: ReportState) {
  state.updatedAt = new Date().toISOString();
  await redis.set(stateKey(state.requestId), JSON.stringify(state), "EX", config.STATE_TTL_SECONDS);
}

export async function enqueueReport(input: ReportInput, requestId = randomUUID()): Promise<string> {
  const now = new Date().toISOString();
  const state: ReportState = { requestId, status: "queued", stage: "En cola", progress: 0, input, createdAt: now, updatedAt: now };
  await saveState(state);
  await reportQueue.add("transform", { requestId }, { jobId: requestId, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
  return requestId;
}

export async function rollbackQueuedReport(requestId: string, input: ReportInput) {
  await reportQueue.remove(requestId);
  await redis.del(stateKey(requestId));
  await deleteObject(objectKey(input.group ?? "BMW", input.manufacturer, "reports", input.axCode, input.edition, requestId, "source.lst"));
}

export function createReportWorker() {
  const worker = new Worker("bmw-transformer-reports", async (job: Job<{ requestId: string }>) => {
    const state = await getReportState(job.data.requestId);
    if (!state) throw new Error(`Report state not found: ${job.data.requestId}`);
    const update = async (patch: Partial<ReportState>) => {
      const current = await getReportState(state.requestId);
      if (current) await saveState({ ...current, ...patch });
    };
    try {
      await runReportJob(state.requestId, state, update);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await update({ status: "failed", stage: "Fallo en pipeline legacy", error: message });
      console.error(JSON.stringify({ event: "report_failed", requestId: state.requestId, error: message }));
      throw error;
    }
  }, { ...queueOptions, concurrency: 1 });
  worker.on("completed", job => console.info(JSON.stringify({ event: "report_completed", requestId: job.data.requestId })));
  worker.on("failed", (job, error) => console.error(JSON.stringify({ event: "report_job_failed", requestId: job?.data.requestId, error: error.message })));
  return worker;
}
