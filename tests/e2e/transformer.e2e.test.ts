import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { Worker } from "bullmq";
import { expectGolden, readComparisonWorkbook } from "../support/golden.js";
import { synthetic, syntheticExtraction, syntheticListing } from "../support/synthetic-extraction.js";

// End-to-end: real HTTP API, BullMQ worker, Redis, S3 (RustFS) and SQL Server, all disposable.
// Run it with `bun run test:e2e`, which starts the containers and passes the environment.
const enabled = process.env.TRANSFORMER_E2E === "true";

type State = { requestId: string; status: string; stage: string; error?: string; pivotKey?: string; reportKey?: string; summary?: Record<string, unknown> };

if (!enabled) {
  test.skip("transformer end-to-end flow (run `bun run test:e2e`)", () => {});
} else {
  const { createApp } = await import("../../src/app.js");
  const { createReportWorker } = await import("../../src/jobs.js");
  const { redis } = await import("../../src/redis.js");
  const { ensureBucket, getBytes, getJson, objectKey, putBytes } = await import("../../src/storage.js");
  const { closeSqlPool, getSqlPool } = await import("../../src/sql/client.js");
  const { legacyFixedColumns } = await import("../../src/sql/labour-table.js");

  let server: Server;
  let worker: Worker;
  let base = "";

  const json = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, init);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const postLoad = (body: Record<string, unknown>) => json("/loads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const loadBody = (axCode: string, typekeys: Array<Record<string, string>> = synthetic.typekeys.map(item => ({ ...item }))) => ({ axCode, edition: synthetic.edition, manufacturer: "BMW", typekeys });
  const upload = (metadata: unknown, bytes: Uint8Array = syntheticListing()) => {
    const form = new FormData();
    form.set("file", new File([bytes as BlobPart], "listing.lst", { type: "application/octet-stream" }));
    form.set("metadata", JSON.stringify(metadata));
    return json("/reports", { method: "POST", body: form });
  };

  async function finished(path: string, timeoutMs = 60_000): Promise<State> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { body } = await json(path);
      if (body.status === "completed" || body.status === "failed") return body as State;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${path}`);
  }

  async function tableColumns(tableName: string) {
    const pool = await getSqlPool();
    const result = await pool.request().input("n", tableName).query("SELECT COLUMN_NAME c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @n ORDER BY ORDINAL_POSITION");
    return result.recordset.map(row => String(row.c));
  }
  async function tableRows(tableName: string, columns: string[]) {
    const pool = await getSqlPool();
    const select = columns.map(column => `[${column}]`).join(", ");
    const result = await pool.request().query(`SELECT ${select} FROM [dbo].[${tableName}] ORDER BY [typekeyIdEntriesId_flatrates_number], [typekeyCatalog_entriesId]`);
    return result.recordset.map(row => Object.fromEntries(columns.map(column => [column, row[column] == null ? null : String(row[column]).trimEnd()])));
  }
  async function nomCampos(tableName: string) {
    const pool = await getSqlPool();
    const result = await pool.request().input("n", tableName).query("SELECT brand, Model, NomTable, nomCampo, Orden, estado, visible FROM dbo.nomCamposTabla WHERE RTRIM(NomTable) = @n ORDER BY Orden");
    return result.recordset.map(row => ({ brand: String(row.brand).trim(), model: String(row.Model).trim(), table: String(row.NomTable).trim(), field: String(row.nomCampo).trim(), order: Number(row.Orden), estado: row.estado, visible: row.visible }));
  }
  async function tableNames() {
    const pool = await getSqlPool();
    return (await pool.request().query("SELECT name FROM sys.tables")).recordset.map(row => String(row.name));
  }

  beforeAll(async () => {
    await ensureBucket();
    for (const item of syntheticExtraction()) await putBytes(objectKey(...item.parts), item.body, "application/json");
    await getSqlPool();
    worker = createReportWorker();
    server = createApp().listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The test HTTP server did not bind a TCP port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server?.close(() => resolve()));
    await worker?.close();
    await closeSqlPool();
    await redis.quit();
  });

  const fixed = legacyFixedColumns.map(column => column.name);

  describe("load into BMW_Labour", () => {
    test("loads two typekeys of different families into a real table and stores the pivot in S3", async () => {
      const queued = await postLoad(loadBody("1XF"));
      expect(queued.status).toBe(202);
      expect(queued.body).toMatchObject({ status: "queued", reused: false, statusUrl: `/loads/${queued.body.loadId}` });

      const state = await finished(`/loads/${queued.body.loadId}`);
      expect(state.status).toBe("completed");
      expect(state.error).toBeUndefined();
      expect(state.summary).toMatchObject({ selectedTypekeys: ["1A01", "2B02"], sql: { enabled: true, tableName: "1XF_05/0", rows: 4, replaced: false } });

      expect(await tableColumns("1XF_05/0")).toEqual([...fixed, "type_1A01", "type_2B02"]);
      const rows = await tableRows("1XF_05/0", ["typekeyCatalog_entriesId", "typekeyIdEntriesId_flatrates_number", "typekeyIdEntriesId_flatrates_workType", "type_1A01", "type_2B02"]);
      const expected = (await import("../fixtures/e2e/pivot.json")).default.rows.map(row => ({
        typekeyCatalog_entriesId: row.typekeyCatalog_entriesId, typekeyIdEntriesId_flatrates_number: row.typekeyIdEntriesId_flatrates_number,
        typekeyIdEntriesId_flatrates_workType: row.typekeyIdEntriesId_flatrates_workType, type_1A01: row.values["1A01"], type_2B02: row.values["2B02"],
      }));
      expect(rows).toEqual(expected.sort((a, b) => a.typekeyIdEntriesId_flatrates_number.localeCompare(b.typekeyIdEntriesId_flatrates_number) || a.typekeyCatalog_entriesId.localeCompare(b.typekeyCatalog_entriesId)));

      expect(await nomCampos("1XF_05/0")).toEqual([
        { brand: "BMW", model: "7", table: "1XF_05/0", field: "1A01", order: 1, estado: "1", visible: "1" },
        { brand: "BMW", model: "7", table: "1XF_05/0", field: "2B02", order: 2, estado: "1", visible: "1" },
      ]);

      const pivot = await getJson<{ tableName: string; typekeys: string[]; rowCount: number }>(state.pivotKey!);
      expect(pivot).toMatchObject({ tableName: "1XF_05/0", typekeys: ["1A01", "2B02"], rowCount: 4 });
    });

    test("reuses an identical load that is still running instead of queueing a second one", async () => {
      const [first, second] = [await postLoad(loadBody("2XF")), await postLoad(loadBody("2XF"))];
      expect(first.status).toBe(202);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ loadId: first.body.loadId, reused: true });
      expect((await finished(`/loads/${first.body.loadId}`)).status).toBe("completed");
    });

    test("replaces the table when the same AX and edition is loaded again with other typekeys", async () => {
      const again = await postLoad(loadBody("1XF", [{ ...synthetic.typekeys[0] }]));
      expect(again.status).toBe(202);
      const state = await finished(`/loads/${again.body.loadId}`);
      expect(state.status).toBe("completed");
      expect(state.summary).toMatchObject({ sql: { replaced: true, rows: 4 } });
      expect(await tableColumns("1XF_05/0")).toEqual([...fixed, "type_1A01"]);
      expect((await nomCampos("1XF_05/0")).map(row => row.field)).toEqual(["1A01"]);
      // restore the two-typekey load for the comparison tests
      const restored = await postLoad(loadBody("1XF"));
      expect((await finished(`/loads/${restored.body.loadId}`)).status).toBe("completed");
      expect(await tableColumns("1XF_05/0")).toEqual([...fixed, "type_1A01", "type_2B02"]);
    });

    test("fails a load without completed typekeys and leaves no table behind", async () => {
      const queued = await postLoad(loadBody("3XF", [{ ...synthetic.incomplete }]));
      const state = await finished(`/loads/${queued.body.loadId}`);
      expect(state.status).toBe("failed");
      expect(state.error).toContain("Ningún typekey de la carga tiene su marcador completed en S3");
      expect(await tableNames()).not.toContain("3XF_05/0");
      expect(await json(`/loads/${queued.body.loadId}`)).toMatchObject({ status: 200, body: { status: "failed" } });
    });

    test("fails a load when one of the requested typekeys is missing in S3, naming it, and writes no table", async () => {
      const queued = await postLoad(loadBody("5XF", [{ ...synthetic.typekeys[0] }, { ...synthetic.incomplete }]));
      const state = await finished(`/loads/${queued.body.loadId}`);
      expect(state.status).toBe("failed");
      expect(state.error).toContain("Faltan los marcadores completed en S3 de: 3C03");
      expect(await tableNames()).not.toContain("5XF_05/0");
    });

    test("loads the data of the extraction date given for each typekey", async () => {
      const dated = loadBody("6XF", synthetic.typekeys.map(item => ({ ...item, date: synthetic.date })));
      const state = await finished(`/loads/${(await postLoad(dated)).body.loadId}`);
      expect(state.status).toBe("completed");
      expect(state.summary).toMatchObject({ typekeys: { "1A01": { date: synthetic.date, completed: true }, "2B02": { date: synthetic.date, completed: true } } });

      const wrong = await finished(`/loads/${(await postLoad(loadBody("5XF", [{ ...synthetic.typekeys[0], date: "20250101" }]))).body.loadId}`);
      expect(wrong.status).toBe("failed");
      expect((await postLoad(loadBody("5XF", [{ ...synthetic.typekeys[0], date: "2025-01-01" }]))).status).toBe(400);
    });

    test("keeps the state of finished loads without expiry while failed ones expire", async () => {
      const completed = await finished(`/loads/${(await postLoad(loadBody("2XF"))).body.loadId}`);
      expect(completed.status).toBe("completed");
      expect(await redis.ttl(`bmw-transformer:report:${completed.requestId}`)).toBe(-1);
      const failed = await finished(`/loads/${(await postLoad(loadBody("5XF", [{ ...synthetic.incomplete }]))).body.loadId}`);
      expect(failed.status).toBe("failed");
      expect(await redis.ttl(`bmw-transformer:report:${failed.requestId}`)).toBeGreaterThan(0);
    });

    test("two identical requests sent at the same moment share a single load", async () => {
      const responses = await Promise.all([postLoad(loadBody("7XF")), postLoad(loadBody("7XF"))]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 202]);
      expect(responses[0]!.body.loadId).toBe(responses[1]!.body.loadId);
      expect((await finished(`/loads/${responses[0]!.body.loadId}`)).status).toBe("completed");
    });

    test("rejects invalid loads and unknown identifiers", async () => {
      expect((await postLoad({ axCode: "1XF", edition: "05/0", typekeys: [{ typekey: "1A01" }] })).status).toBe(400);
      expect((await postLoad({ ...loadBody("1XF"), typekeys: [{ ...synthetic.typekeys[0] }, { ...synthetic.typekeys[0] }] })).status).toBe(400);
      expect((await json("/loads/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    });
  });

  describe("comparison", () => {
    async function latestLoadId() {
      const queued = await postLoad(loadBody("1XF"));
      const state = await finished(`/loads/${queued.body.loadId}`);
      expect(state.status).toBe("completed");
      return queued.body.loadId as string;
    }

    test("compares an uploaded LST against the stored pivot and serves the Excel through the signed download", async () => {
      const loadId = await latestLoadId();
      const queued = await upload({ loadId });
      expect(queued.status).toBe(202);
      expect(queued.body).toMatchObject({ status: "queued", statusUrl: `/reports/${queued.body.requestId}` });

      const state = await finished(`/reports/${queued.body.requestId}`);
      expect(state.status).toBe("completed");
      expect(state.reportKey).toContain("/reports/1XF/05/0/");

      const redirect = await fetch(`${base}/reports/${queued.body.requestId}/download`, { redirect: "manual" });
      expect(redirect.status).toBe(307);
      const file = await fetch(redirect.headers.get("location")!);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-disposition")).toBe('attachment; filename="1XF_05_0_DDA_contra_BMW.xlsx"');
      await expectGolden("report", await readComparisonWorkbook(new Uint8Array(await file.arrayBuffer())));

      const source = await fetch(`${base}/reports/${queued.body.requestId}/source`, { redirect: "manual" });
      expect(source.status).toBe(307);
      expect(Buffer.compare(Buffer.from(await (await fetch(source.headers.get("location")!)).arrayBuffer()), Buffer.from(syntheticListing()))).toBe(0);
    });

    test("does not compare against loads that are unknown, failed or malformed", async () => {
      const failed = await postLoad(loadBody("3XF", [{ ...synthetic.incomplete }]));
      await finished(`/loads/${failed.body.loadId}`);
      expect((await upload({ loadId: failed.body.loadId })).status).toBe(409);
      expect((await upload({ loadId: "00000000-0000-4000-8000-0000000000ff" })).status).toBe(404);
      expect((await upload({ loadId: "not-a-uuid" })).status).toBe(400);
    });

    test("produces an empty comparison when the file has no Q block", async () => {
      const loadId = await latestLoadId();
      const queued = await upload({ loadId }, new TextEncoder().encode("this is not a listing"));
      const state = await finished(`/reports/${queued.body.requestId}`);
      expect(state.status).toBe("completed");
      expect(await readComparisonWorkbook(await getBytes(state.reportKey!))).toMatchObject({ rows: [] });
    });

    test("still supports the single-job flow that loads and compares in one request", async () => {
      const queued = await upload({ ...loadBody("4XF"), brand: "BMW" });
      expect(queued.status).toBe(202);
      const state = await finished(`/reports/${queued.body.requestId}`);
      expect(state.status).toBe("completed");
      expect(await tableColumns("4XF_05/0")).toEqual([...fixed, "type_1A01", "type_2B02"]);
      await expectGolden("report", await readComparisonWorkbook(await getBytes(state.reportKey!)));
    });
  });

  describe("housekeeping", () => {
    test("leaves no temporary tables and every load in the queue finished", async () => {
      expect((await tableNames()).filter(name => name.startsWith("__bmw_tmp_"))).toEqual([]);
      const pool = await getSqlPool();
      const campos = await pool.request().query("SELECT RTRIM(NomTable) t, COUNT(*) c FROM dbo.nomCamposTabla GROUP BY NomTable ORDER BY NomTable");
      expect(campos.recordset.map(row => [row.t, row.c])).toEqual([["1XF_05/0", 2], ["2XF_05/0", 2], ["4XF_05/0", 2], ["6XF_05/0", 2], ["7XF_05/0", 2]]);
    });
  });
}
