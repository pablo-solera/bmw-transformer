import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createMemoryStorage } from "../support/memory-storage.js";
import { expectGolden, readComparisonWorkbook } from "../support/golden.js";
import { synthetic, syntheticExtraction, syntheticListing, syntheticListingRows } from "../support/synthetic-extraction.js";
import type { ReportInput, ReportState } from "../../src/types.js";

// Flow tests run without Redis, S3 or SQL Server: the whole load and comparison pipeline
// against an in-memory storage. They run in their own process (see `bun run test`).
process.env.SQL_ENABLED = "false";
process.env.S3_PREFIX = "TEST";

const memory = createMemoryStorage("TEST");
mock.module("../../src/storage.js", () => memory.module);

const { runLoadJob } = await import("../../src/pipeline/run-load.js");
const { runCompareJob, runReportJob } = await import("../../src/pipeline/run-report.js");

const input = (overrides: Partial<ReportInput> = {}): ReportInput => ({
  axCode: synthetic.axCode, edition: synthetic.edition, manufacturer: "BMW", brand: "BMW", model: "7", group: "BMW",
  typekeys: synthetic.typekeys.map(item => ({ ...item })),
  ...overrides,
});

function stateFor(requestId: string, value: ReportInput, extra: Partial<ReportState> = {}): ReportState {
  const now = new Date().toISOString();
  return { requestId, kind: "load", status: "queued", stage: "En cola", progress: 0, input: value, createdAt: now, updatedAt: now, ...extra };
}

async function load(requestId: string, value: ReportInput) {
  let state = stateFor(requestId, value);
  const history: Array<{ status: string; progress: number }> = [];
  const update = async (patch: Partial<ReportState>) => {
    state = { ...state, ...patch };
    if (patch.status) history.push({ status: patch.status, progress: state.progress });
  };
  const result = await runLoadJob(requestId, state, update);
  return { state, history, result };
}

beforeEach(() => {
  memory.objects.clear();
  memory.seed(syntheticExtraction());
});

describe("load: S3 extraction to pivot", () => {
  test("builds the pivot for typekeys of different families and stores it for later comparisons", async () => {
    const { state, history, result } = await load("load-1", input());

    expect(state.status).toBe("completed");
    expect(state.pivotKey).toBe("TEST/BMW/BMW/loads/1XF/05/0/load-1/pivot.json");
    expect(result.summary.selectedTypekeys).toEqual(["1A01", "2B02"]);
    expect(result.summary.sql).toMatchObject({ enabled: false, persisted: false, tableName: "1XF_05/0" });
    expect([...new Set(history.map(item => item.status))]).toEqual(["resolving", "importing", "pivoting", "completed"]);
    expect(history.map(item => item.progress)).toEqual([...history.map(item => item.progress)].sort((a, b) => a - b));

    const pivot = JSON.parse(new TextDecoder().decode(memory.objects.get(state.pivotKey!)!)) as { tableName: string; typekeys: string[]; columns: unknown[]; rows: Array<Record<string, unknown>> };
    expect(pivot.tableName).toBe("1XF_05/0");
    expect(pivot.typekeys).toEqual(["1A01", "2B02"]);
    expect(pivot.columns).toEqual([{ typekey: "1A01", columnName: "type_1A01", order: 1 }, { typekey: "2B02", columnName: "type_2B02", order: 2 }]);
    await expectGolden("pivot", pivot);
  });

  test("skips a typekey without a completed marker instead of loading partial data", async () => {
    const { state, result } = await load("load-2", input({ typekeys: [...synthetic.typekeys, { ...synthetic.incomplete }] }));
    expect(state.status).toBe("completed");
    expect(result.summary.selectedTypekeys).toEqual(["1A01", "2B02"]);
    expect((result.summary.typekeys as Record<string, { completed: boolean }>)["3C03"]?.completed).toBe(false);
  });

  test("fails when none of the typekeys is completed", async () => {
    await expect(load("load-3", input({ typekeys: [{ ...synthetic.incomplete }] }))).rejects.toThrow("Ningún typekey de la carga tiene su marcador completed en S3");
  });

  test("finds the extraction under the request-level series and family when typekeys carry none", async () => {
    const { result } = await load("load-4", input({ series: "7'", family: "G70", typekeys: [{ typekey: "1A01" }] }));
    expect(result.summary.selectedTypekeys).toEqual(["1A01"]);
  });

  test("rejects a table name wider than nomCamposTabla.NomTable", async () => {
    await expect(load("load-5", input({ axCode: "ABCDEFGH", edition: "05/0" }))).rejects.toThrow(/NomTable truncation/);
  });

  test("uses the newest completed date and honours an explicit date", async () => {
    const older = syntheticExtraction().filter(item => item.parts.includes("1A01")).map(item => ({ parts: item.parts.map(part => part === synthetic.date ? "20261001" : part), body: item.body }));
    memory.seed(older);
    const newest = await load("load-6", input({ typekeys: [synthetic.typekeys[0]] }));
    expect((newest.result.summary.typekeys as Record<string, { date: string }>)["1A01"]?.date).toBe("20261020");
    const pinned = await load("load-7", input({ typekeys: [synthetic.typekeys[0]], date: "20261001" }));
    expect((pinned.result.summary.typekeys as Record<string, { date: string }>)["1A01"]?.date).toBe("20261001");
  });
});

describe("comparison: LST against a finished load", () => {
  async function compare(loadId: string, listing: Uint8Array = syntheticListing(), name = "listing.lst") {
    const loaded = await load(loadId, input());
    const reportInput = { ...loaded.state.input, sourceFilename: name };
    const requestId = `report-${loadId}`;
    await memory.module.putBytes(memory.module.objectKey("BMW", "BMW", "reports", reportInput.axCode, reportInput.edition, requestId, "source.lst"), listing);
    let state = stateFor(requestId, reportInput, { kind: "report", loadId });
    const update = async (patch: Partial<ReportState>) => { state = { ...state, ...patch }; };
    await runCompareJob(requestId, state, loaded.state, update);
    return { state, workbook: await readComparisonWorkbook(memory.objects.get(state.reportKey!)!), loaded };
  }

  test("produces the DDA contra BMW workbook from the stored pivot", async () => {
    const { state, workbook } = await compare("c1");
    expect(state.status).toBe("completed");
    expect(state.reportKey).toBe("TEST/BMW/BMW/reports/1XF/05/0/report-c1/1XF_05_0_DDA_contra_BMW.xlsx");
    expect(workbook.sheetName).toBe("DDA contra BMW");
    expect(workbook.header).toEqual(["Nº Operacion", "DDA", "", "1A01", "2B02"]);
    await expectGolden("report", workbook);
  });

  test("applies the legacy comparison rules to each kind of operation", async () => {
    const { workbook } = await compare("c2");
    const byOperation = Object.fromEntries(workbook.rows.map(row => [String(row.values[0]), row]));

    expect(Object.keys(byOperation)).toEqual(["33 10 514", "33 10 515", "33 20 100ZAX", "41 12 190)", "99 99 999"]);
    expect(byOperation["33 10 514"]).toMatchObject({ values: ["33 10 514", 12, null, 12, 14], red: [5] });
    expect(byOperation["33 10 515"]).toMatchObject({ values: ["33 10 515", 4, null, 3, 3], red: [4, 5] });
    expect(byOperation["33 20 100ZAX"]).toMatchObject({ values: ["33 20 100ZAX", 5, null, 5, 5], red: [4, 5] });
    expect(byOperation["41 12 190)"]).toMatchObject({ values: ["41 12 190)", 25, null, 20, null], red: [4, 5] });
    expect(byOperation["99 99 999"]).toMatchObject({ values: ["99 99 999", 7, null, null, null], red: [] });
    expect(syntheticListingRows.filter(row => row.operation === "KN" || row.operation === "77 70 700")).toHaveLength(3);
  });

  test("compares against the pivot of the load, not the current S3 contents", async () => {
    const { workbook, loaded } = await compare("c3");
    for (const key of [...memory.objects.keys()]) if (key.includes("/labour/")) memory.objects.delete(key);
    const again = await (async () => {
      const requestId = "report-c3-again";
      const reportInput = { ...loaded.state.input, sourceFilename: "listing.lst" };
      await memory.module.putBytes(memory.module.objectKey("BMW", "BMW", "reports", reportInput.axCode, reportInput.edition, requestId, "source.lst"), syntheticListing());
      let state = stateFor(requestId, reportInput, { kind: "report", loadId: "c3" });
      await runCompareJob(requestId, state, loaded.state, async patch => { state = { ...state, ...patch }; });
      return readComparisonWorkbook(memory.objects.get(state.reportKey!)!);
    })();
    expect(again).toEqual(workbook);
  });

  test("fails with a clear error when the load has no pivot", async () => {
    const loaded = await load("c4", input());
    await expect(runCompareJob("r", stateFor("r", loaded.state.input, { kind: "report" }), { ...loaded.state, pivotKey: undefined }, async () => {})).rejects.toThrow("no tiene pivote");
  });

  test("rejects a ZIP-less non-LST upload before producing a report", async () => {
    const { workbook } = await compare("c5", new TextEncoder().encode("not a listing"));
    expect(workbook.rows).toEqual([]);
  });
});

describe("legacy single-job report", () => {
  test("loads and compares in one go and produces the same workbook as the two-step flow", async () => {
    const requestId = "legacy-1";
    const reportInput = { ...input(), sourceFilename: "listing.lst" };
    await memory.module.putBytes(memory.module.objectKey("BMW", "BMW", "reports", reportInput.axCode, reportInput.edition, requestId, "source.lst"), syntheticListing());
    let state = stateFor(requestId, reportInput, { kind: "report" });
    await runReportJob(requestId, state, async patch => { state = { ...state, ...patch }; });

    expect(state.status).toBe("completed");
    expect(memory.objects.has(`TEST/BMW/BMW/reports/1XF/05/0/${requestId}/pivot.json`)).toBe(true);
    await expectGolden("report", await readComparisonWorkbook(memory.objects.get(state.reportKey!)!));
  });
});
