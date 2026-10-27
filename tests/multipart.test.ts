import { expect, mock, test } from "bun:test";
import type { ReportInput, ReportState } from "../src/types.js";

const calls: { input?: unknown; bytes?: Uint8Array; key?: string; loadId?: string; loadInput?: ReportInput } = {};

mock.module("../src/jobs.js", () => ({
  enqueueReport: async (input: unknown, requestId: string) => { calls.input = input; return requestId; },
  enqueueLoad: async () => ({ loadId: "00000000-0000-4000-8000-000000000001", reused: false }),
  getReportState: async () => null,
  rollbackQueuedReport: async () => {},
}));
mock.module("../src/storage.js", () => ({
  objectKey: (...parts: string[]) => parts.join("/"),
  putBytes: async (key: string, bytes: Uint8Array) => { calls.key = key; calls.bytes = bytes; },
  signedDownload: async () => "https://example.invalid/signed",
}));

const { createApp } = await import("../src/app.js");

const loadId = "00000000-0000-4000-8000-000000000001";
const completedLoad: ReportState = {
  requestId: loadId, kind: "load", status: "completed", stage: "Carga completada", progress: 100, pivotKey: "BMW/BMW/loads/11I/05_0/pivot.json",
  input: { axCode: "11I", edition: "05_0", manufacturer: "BMW", brand: "BMW", model: "4", series: "4", family: "G26", typekeys: [{ typekey: "11HC" }] },
  createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z",
};

async function withServer(states: Record<string, ReportState>, run: (base: string) => Promise<void>, enqueueLoad?: (input: ReportInput) => Promise<{ loadId: string; reused: boolean }>) {
  const server = createApp({
    enqueueReport: async (input, requestId, linkedLoad) => { calls.input = input; calls.loadId = linkedLoad; return requestId; },
    enqueueLoad: enqueueLoad ?? (async input => { calls.loadInput = input; return { loadId, reused: false }; }),
    getReportState: async id => states[id] ?? null,
    rollbackQueuedReport: async () => {},
    objectKey: (...parts) => parts.join("/"),
    putBytes: async (key, bytes) => { calls.key = key; calls.bytes = bytes; },
    signedDownload: async () => "https://example.invalid/signed",
  }).listen(0, "127.0.0.1");
  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP server did not bind a TCP port");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const upload = (metadata: unknown) => {
  const form = new FormData();
  form.set("file", new File(["LST source fixture"], "listing.LST", { type: "application/octet-stream" }));
  form.set("metadata", JSON.stringify(metadata));
  return { method: "POST", body: form };
};

test("POST /reports accepts Swagger multipart file + metadata fields", async () => {
  await withServer({}, async base => {
    const response = await fetch(`${base}/reports`, upload({
      axCode: "11I", edition: "05_0", manufacturer: "BMW", series: "4", family: "G26", date: "20260928",
      typekeys: [{ typekey: "11HC" }],
    }));
    expect(response.status).toBe(202);
    const result = await response.json() as { requestId: string; status: string; statusUrl: string };
    expect(result).toMatchObject({ status: "queued", statusUrl: `/reports/${result.requestId}` });
    expect(calls.input).toMatchObject({ axCode: "11I", edition: "05_0", brand: "BMW", model: "4", typekeys: [{ typekey: "11HC" }], sourceFilename: "listing.LST" });
    expect(new TextDecoder().decode(calls.bytes)).toBe("LST source fixture");
    expect(calls.key).toContain("reports/11I/05_0/");
    expect(calls.loadId).toBeUndefined();
  });
});

test("POST /loads queues a load without an LST and accepts series and family per typekey", async () => {
  await withServer({}, async base => {
    const response = await fetch(`${base}/loads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      axCode: "1XF", edition: "05/0", manufacturer: "BMW",
      typekeys: [{ typekey: "11EH", series: "7'", family: "G70" }, { typekey: "6J92", series: "6'", family: "F13" }],
    }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ loadId, requestId: loadId, status: "queued", reused: false, statusUrl: `/loads/${loadId}` });
    expect(calls.loadInput).toMatchObject({ axCode: "1XF", brand: "BMW", model: "7", typekeys: [{ typekey: "11EH", family: "G70" }, { typekey: "6J92", family: "F13" }] });
  });
});

test("POST /loads rejects typekeys without series or family and duplicated typekeys", async () => {
  await withServer({}, async base => {
    const post = (body: unknown) => fetch(`${base}/loads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const missing = await post({ axCode: "1XF", edition: "05/0", typekeys: [{ typekey: "11EH", family: "G70" }] });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain("11EH no tiene serie");
    const duplicated = await post({ axCode: "1XF", edition: "05/0", series: "7", family: "G70", typekeys: [{ typekey: "11EH" }, { typekey: "11EH" }] });
    expect(duplicated.status).toBe(400);
    expect(((await duplicated.json()) as { error: string }).error).toContain("duplicados");
  });
});

test("POST /loads answers 200 when an identical load is already running", async () => {
  await withServer({}, async base => {
    const response = await fetch(`${base}/loads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ axCode: "1XF", edition: "05/0", series: "7", family: "G70", typekeys: [{ typekey: "11EH" }] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ loadId, reused: true });
  }, async () => ({ loadId, reused: true }));
});

test("GET /loads/:id only returns loads", async () => {
  await withServer({ [loadId]: completedLoad, other: { ...completedLoad, requestId: "other", kind: "report" } }, async base => {
    const found = await fetch(`${base}/loads/${loadId}`);
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ requestId: loadId, kind: "load", pivotKey: completedLoad.pivotKey });
    expect((await fetch(`${base}/loads/other`)).status).toBe(404);
    expect((await fetch(`${base}/loads/missing`)).status).toBe(404);
  });
});

test("POST /reports with a loadId compares against that load and reuses its input", async () => {
  await withServer({ [loadId]: completedLoad }, async base => {
    const response = await fetch(`${base}/reports`, upload({ loadId }));
    expect(response.status).toBe(202);
    expect(calls.loadId).toBe(loadId);
    expect(calls.input).toMatchObject({ axCode: "11I", edition: "05_0", sourceFilename: "listing.LST" });
    expect(calls.key).toContain("reports/11I/05_0/");
  });
});

test("POST /reports with a loadId rejects unknown, unfinished and malformed loads", async () => {
  await withServer({ [loadId]: { ...completedLoad, status: "importing", pivotKey: undefined } }, async base => {
    expect((await fetch(`${base}/reports`, upload({ loadId: "00000000-0000-4000-8000-0000000000ff" }))).status).toBe(404);
    expect((await fetch(`${base}/reports`, upload({ loadId }))).status).toBe(409);
    expect((await fetch(`${base}/reports`, upload({ loadId: "not-a-uuid" }))).status).toBe(400);
  });
});

test("POST /loads accepts a date per typekey and rejects a malformed one", async () => {
  await withServer({}, async base => {
    const post = (typekeys: unknown) => fetch(`${base}/loads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ axCode: "1XF", edition: "05/0", series: "7", family: "G70", typekeys }) });
    expect((await post([{ typekey: "11EH", date: "20261020" }])).status).toBe(202);
    expect(calls.loadInput).toMatchObject({ typekeys: [{ typekey: "11EH", date: "20261020" }] });
    const invalid = await post([{ typekey: "11EH", date: "2026-10-20" }]);
    expect(invalid.status).toBe(400);
  });
});
