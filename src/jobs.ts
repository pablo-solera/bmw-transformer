import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { redis } from "./redis.js";
import type { ReportInput, ReportState } from "./types.js";
import { runCompareJob, runReportJob } from "./pipeline/run-report.js";
import { runLoadJob } from "./pipeline/run-load.js";
import { loadFingerprint } from "./load-fingerprint.js";
import { deleteObject, objectKey } from "./storage.js";
import { JOB_ATTEMPTS, JOB_BACKOFF_MS, isTransientNetworkError, shouldRetry } from "./retry.js";

const queueOptions = { connection: redis };
export const reportQueue = new Queue("bmw-transformer-reports", queueOptions);
const jobOptions = { attempts: JOB_ATTEMPTS, backoff: { type: "exponential", delay: JOB_BACKOFF_MS }, removeOnComplete: 100, removeOnFail: 100 };
const stateKey = (requestId: string) => `bmw-transformer:report:${requestId}`;

export async function getReportState(requestId: string): Promise<ReportState | null> {
  const value = await redis.get(stateKey(requestId));
  return value ? JSON.parse(value) as ReportState : null;
}

async function saveState(state: ReportState) {
  state.updatedAt = new Date().toISOString();
  // Finished work keeps its state: loads and reports are still needed long after the retention window of running jobs.
  if (state.status === "completed") await redis.set(stateKey(state.requestId), JSON.stringify(state));
  else await redis.set(stateKey(state.requestId), JSON.stringify(state), "EX", config.STATE_TTL_SECONDS);
}

export async function enqueueReport(input: ReportInput, requestId = randomUUID(), loadId?: string): Promise<string> {
  const now = new Date().toISOString();
  const state: ReportState = { requestId, kind: "report", ...(loadId ? { loadId } : {}), status: "queued", stage: "En cola", progress: 0, input, createdAt: now, updatedAt: now };
  await saveState(state);
  await reportQueue.add(loadId ? "compare" : "transform", { requestId }, { jobId: requestId, ...jobOptions });
  return requestId;
}

const activeLoadKey = (input: ReportInput) => `bmw-transformer:load-active:${input.group ?? "BMW"}:${input.manufacturer}:${input.axCode}:${input.edition}`;
const isActive = (state: ReportState | null) => Boolean(state) && state!.status !== "completed" && state!.status !== "failed";

/** Queues a load into BMW_Labour. An identical load that is still queued or running is reused instead of duplicated. */
export async function enqueueLoad(input: ReportInput, loadId = randomUUID()): Promise<{ loadId: string; reused: boolean }> {
  const fingerprint = loadFingerprint(input);
  const key = activeLoadKey(input);
  const now = new Date().toISOString();
  const state: ReportState = { requestId: loadId, kind: "load", status: "queued", stage: "En cola", progress: 0, input, createdAt: now, updatedAt: now };
  await saveState(state);
  const claim = JSON.stringify({ loadId, fingerprint });
  // SET NX decides atomically which of several identical simultaneous requests owns the active slot.
  if (!await redis.set(key, claim, "EX", config.STATE_TTL_SECONDS, "NX")) {
    const holder = await redis.get(key);
    const current = holder ? JSON.parse(holder) as { loadId: string; fingerprint: string } : null;
    if (current && current.loadId !== loadId && current.fingerprint === fingerprint && isActive(await getReportState(current.loadId))) {
      await redis.del(stateKey(loadId));
      return { loadId: current.loadId, reused: true };
    }
    await redis.set(key, claim, "EX", config.STATE_TTL_SECONDS);
  }
  try { await reportQueue.add("load", { requestId: loadId }, { jobId: loadId, ...jobOptions }); }
  catch (error) { await redis.del(stateKey(loadId), key); throw error; }
  return { loadId, reused: false };
}

async function releaseActiveLoad(state: ReportState) {
  const key = activeLoadKey(state.input);
  const current = await redis.get(key);
  if (current && (JSON.parse(current) as { loadId: string }).loadId === state.requestId) await redis.del(key);
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
    const maxAttempts = job.opts.attempts ?? 1;
    let retrying = false;
    try {
      if (state.kind === "load") await runLoadJob(state.requestId, state, update);
      else if (state.loadId) {
        const load = await getReportState(state.loadId);
        if (!load || load.kind !== "load" || load.status !== "completed") throw new Error(`La carga ${state.loadId} no está completada`);
        await runCompareJob(state.requestId, state, load, update);
      } else await runReportJob(state.requestId, state, update);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const label = state.kind === "load" ? "load" : "report";
      if (shouldRetry(error, job.attemptsMade, maxAttempts)) {
        retrying = true;
        await update({ status: "queued", stage: `Reintentando tras un error de red (${job.attemptsMade + 2}/${maxAttempts})`, progress: 0 });
        console.warn(JSON.stringify({ event: `${label}_retrying`, requestId: state.requestId, attempt: job.attemptsMade + 1, error: message }));
        throw error;
      }
      await update({ status: "failed", stage: state.kind === "load" ? "Fallo en la carga" : "Fallo en pipeline legacy", error: message });
      console.error(JSON.stringify({ event: `${label}_failed`, requestId: state.requestId, error: message }));
      throw isTransientNetworkError(error) ? error : new UnrecoverableError(message);
    } finally {
      if (state.kind === "load" && !retrying) await releaseActiveLoad(state).catch(() => undefined);
    }
  }, { ...queueOptions, concurrency: 1 });
  worker.on("completed", job => console.info(JSON.stringify({ event: "report_completed", requestId: job.data.requestId })));
  worker.on("failed", (job, error) => console.error(JSON.stringify({ event: "report_job_failed", requestId: job?.data.requestId, error: error.message })));
  return worker;
}
