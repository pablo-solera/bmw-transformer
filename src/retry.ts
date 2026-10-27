export const JOB_ATTEMPTS = 3;
export const JOB_BACKOFF_MS = 15_000;

const transientCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ESOCKET", "ETIMEOUT", "ECONNCLOSED"]);
const transientMessage = /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)\b|socket hang up|timed? ?out|Unable to connect to the configured SQL Server/i;

/** Network, DNS and timeout failures that are worth trying again; validation and data errors are not. */
export function isTransientNetworkError(error: unknown, depth = 0): boolean {
  if (!error || depth > 5) return false;
  if (typeof error === "object") {
    const record = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === "string" && transientCodes.has(record.code)) return true;
    if (record.name === "TimeoutError" || record.name === "AbortError") return true;
    if (typeof record.message === "string" && transientMessage.test(record.message)) return true;
    if (isTransientNetworkError(record.cause, depth + 1)) return true;
    if (Array.isArray(record.errors) && record.errors.some(item => isTransientNetworkError(item, depth + 1))) return true;
    return false;
  }
  return typeof error === "string" && transientMessage.test(error);
}

/** `attemptsMade` is BullMQ's count of attempts that already failed, so the running attempt is attemptsMade + 1. */
export function shouldRetry(error: unknown, attemptsMade: number, maxAttempts: number) {
  return isTransientNetworkError(error) && attemptsMade + 1 < maxAttempts;
}
