import { expect, mock, test } from "bun:test";

const calls: { input?: unknown; bytes?: Uint8Array; key?: string } = {};

mock.module("../src/jobs.js", () => ({
  enqueueReport: async (input: unknown, requestId: string) => { calls.input = input; return requestId; },
  getReportState: async () => null,
  rollbackQueuedReport: async () => {},
}));
mock.module("../src/storage.js", () => ({
  objectKey: (...parts: string[]) => parts.join("/"),
  putBytes: async (key: string, bytes: Uint8Array) => { calls.key = key; calls.bytes = bytes; },
  signedDownload: async () => "https://example.invalid/signed",
}));

const { createApp } = await import("../src/app.js");

test("POST /reports accepts Swagger multipart file + metadata fields", async () => {
  const server = createApp({
    enqueueReport: async (input, requestId) => { calls.input = input; return requestId; },
    getReportState: async () => null,
    rollbackQueuedReport: async () => {},
    objectKey: (...parts) => parts.join("/"),
    putBytes: async (key, bytes) => { calls.key = key; calls.bytes = bytes; },
    signedDownload: async () => "https://example.invalid/signed",
  }).listen(0, "127.0.0.1");

  try {
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP server did not bind a TCP port");
    const form = new FormData();
    form.set("file", new File(["LST source fixture"], "listing.LST", { type: "application/octet-stream" }));
    form.set("metadata", JSON.stringify({
      axCode: "11I", edition: "05_0", manufacturer: "BMW", series: "4", family: "G26", date: "20260928",
      typekeys: [{ typekey: "11HC" }],
    }));
    const response = await fetch(`http://127.0.0.1:${address.port}/reports`, { method: "POST", body: form });
    expect(response.status).toBe(202);
    const result = await response.json() as { requestId: string; status: string; statusUrl: string };
    expect(result).toMatchObject({ status: "queued", statusUrl: `/reports/${result.requestId}` });
    expect(calls.input).toMatchObject({ axCode: "11I", edition: "05_0", typekeys: [{ typekey: "11HC" }], sourceFilename: "listing.LST" });
    expect(new TextDecoder().decode(calls.bytes)).toBe("LST source fixture");
    expect(calls.key).toContain("reports/11I/05_0/");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
