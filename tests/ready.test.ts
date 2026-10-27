import { expect, test } from "bun:test";
import { createApp } from "../src/app.js";

async function readyWith(readyChecks: Record<string, () => Promise<void>>) {
  const server = createApp({
    enqueueReport: async (_input, requestId) => requestId,
    enqueueLoad: async () => ({ loadId: "00000000-0000-4000-8000-000000000001", reused: false }),
    getReportState: async () => null,
    rollbackQueuedReport: async () => {},
    objectKey: (...parts) => parts.join("/"),
    putBytes: async () => {},
    signedDownload: async () => "https://example.invalid/signed",
    readyChecks,
  }).listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP server did not bind a TCP port");
    const response = await fetch(`http://127.0.0.1:${address.port}/ready`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("/ready answers 200 when every dependency is available", async () => {
  const result = await readyWith({ redis: async () => {}, s3: async () => {}, sqlserver: async () => {} });
  expect(result).toEqual({ status: 200, body: { status: "ready", checks: { redis: "ok", s3: "ok", sqlserver: "ok" } } });
});

test("/ready answers 503 and hides the error details of a failing dependency", async () => {
  const result = await readyWith({ redis: async () => {}, s3: async () => { throw new Error("secret endpoint details"); } });
  expect(result.status).toBe(503);
  expect(result.body).toEqual({ status: "unavailable", checks: { redis: "ok", s3: "error" } });
});

test("/ready treats a dependency that takes too long as failed", async () => {
  const result = await readyWith({ sqlserver: () => new Promise<void>(() => {}) });
  expect(result.status).toBe(503);
  expect(result.body.checks).toEqual({ sqlserver: "error" });
}, 10_000);
