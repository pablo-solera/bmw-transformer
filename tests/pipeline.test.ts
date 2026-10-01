import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseMasterListingBytes, toDdaRecords } from "../src/dda/parse-lst.js";
import { vbCDec, vbExcelCell, vbLineInputLines, vbMid, vbString, vbTrim } from "../src/legacy/vb.js";
import { parseLegacyJson } from "../src/legacy/vbjson.js";
import { sqlLike, sqlEquals, assertUnescapedSqlValue, enforceNchar } from "../src/legacy/sqlserver.js";
import { extractLstUpload } from "../src/dda/parse-lst.js";
import { buildLegacyPivot, type PivotResult } from "../src/pipeline/pivot.js";
import { buildLegacyWorkbook } from "../src/report/workbook.js";

describe("legacy compatibility primitives", () => {
  test("VB Line Input keeps LF inside a line and splits CRLF", () => {
    expect(vbLineInputLines("{\n}\r\nnext")).toEqual(["{\n}", "next"]);
  });
  test("CDec follows es-ES decimal and grouping separators", () => {
    expect(vbCDec("0.5")).toBe(5);
    expect(vbCDec("1,5")).toBe(1.5);
  });
  test("missing JSON keys become empty while null raises VB error 94 on String assignment", () => {
    expect(vbString(undefined)).toBe("");
    expect(() => vbString(null)).toThrow(/runtime error 94/);
  });
  test("VB Mid with start zero raises error 5", () => expect(() => vbMid("test", 0, 4)).toThrow(/runtime error 5/));
  test("VB Trim strips spaces, not tabs", () => expect(vbTrim(" \tvalue \t ")).toBe("\tvalue \t"));
  test("Excel Spanish coercion converts decimal text and preserves spaced operation ids", () => {
    expect(vbExcelCell("1,5")).toBe(1.5);
    expect(vbExcelCell("00 11 241)")).toBe("00 11 241)");
  });
  test("legacy JSON keeps decimal tokens as VB Decimal values", () => { expect(parseLegacyJson<{value: number}>("{\"value\": 0.5}").value).toBe(5); });
  test("SQL Server LIKE preserves wildcard semantics and CI_AS equality", () => {
    expect(sqlLike("entry_123", "%entry_1%" )).toBe(true);
    expect(sqlEquals("BMW   ", "bmw")).toBe(true);
  });
  test("legacy staging detects unescaped quotes and fixed nchar truncation", () => {
    expect(() => assertUnescapedSqlValue("can't", "flat.text")).toThrow(/unescaped apostrophe/);
    expect(() => enforceNchar("123456789", 8, "nomCampo")).toThrow(/truncation/);
  });
  test("LST upload rejects ZIP with zero or multiple listing files", () => {
    expect(() => extractLstUpload(new Uint8Array([1]), "invalid.zip")).toThrow();
  });
});

const sourcePath = process.env.BMW_DDA_SAMPLE_LST;
const workbookPath = process.env.BMW_DDA_REFERENCE_XLSX;
if (sourcePath && workbookPath) test("BMW Q parser and legacy DDA filter match the real 1IX_04 reference", async () => {
  const xlsx = new (await import("exceljs")).default.Workbook();
  await xlsx.xlsx.readFile(workbookPath!);
  const referenceSheet = xlsx.getWorksheet("DDA contra BMW")!;
  expect(referenceSheet.columnCount).toBe(15);
  expect(referenceSheet.rowCount).toBe(512);
  expect(Array.from(referenceSheet.getRow(3).values as unknown[]).slice(1).map(value => value ?? null)).toEqual(["Nº Operacion", "DDA", null, "11CF", "12CF", "21CF", "22CF", "31CF", "32CF", "41CF", "42CF", "51CF", "52CF", "61CF", "62CF"]);
  const bytes = await readFile(sourcePath);
  const expected = await Bun.file("tests/fixtures/1IX_04.expected.json").json() as {
    qRecords: number; eligibleRows: number; eligibleOperationTimeSha256: string; first: [string, number]; last: [string, number];
  };
  const listing = parseMasterListingBytes(bytes, "WTCO015-LISTE.LST");
  const records = toDdaRecords(listing);
  expect(records).toHaveLength(expected.qRecords);
  const counts = new Map<string, number>();
  for (const row of records) if (row.Operacion !== null && row.Operacion !== "KN") counts.set(row.Operacion, (counts.get(row.Operacion) ?? 0) + 1);
  const eligible = records.filter(row => row.Operacion !== null && row.Operacion !== "KN" && counts.get(row.Operacion) === 1).sort((a, b) => a.Operacion!.localeCompare(b.Operacion!, "en-US"));
  const digest = createHash("sha256").update(eligible.map(row => `${row.Operacion}\t${row.Tiempo}`).join("\n")).digest("hex");
  expect(eligible).toHaveLength(expected.eligibleRows);
  expect(digest).toBe(expected.eligibleOperationTimeSha256);
  expect([eligible[0]?.Operacion, eligible[0]?.Tiempo]).toEqual(expected.first);
  expect([eligible.at(-1)?.Operacion, eligible.at(-1)?.Tiempo]).toEqual(expected.last);
  const expectedRows = Array.from({ length: referenceSheet.rowCount - 3 }, (_, index) => [referenceSheet.getCell(index + 4, 1).value as string | null, referenceSheet.getCell(index + 4, 2).value as number | null]);
  expect(eligible.map(row => [row.Operacion, row.Tiempo])).toEqual(expectedRows);
});
else test.skip("real BMW LST/XLSX reference", () => {});

test("pivot model rejects AxCode_Edition wider than nomCamposTabla.NomTable", () => {
  const input = { axCode: "1234567890", edition: "123", manufacturer: "BMW", series: "G60", family: "G60", typekeys: [] };
  expect(() => buildLegacyPivot(input, [], [], [])).toThrow(/NomTable truncation/);
});

test("legacy pivot records Mid-without-underscore Resume Next and carries the empty suffix", () => {
  const input = { axCode: "1IX", edition: "04/0", manufacturer: "BMW", series: "G60", family: "G60", typekeys: [{ typekey: "11CF" }] };
  const catalog = [{ typekey: "11CF", id: "id", number: "01", text: "CAT", entriesId: "entry-without-underscore", entriesNumber: "1", entriesText: "Description" }];
  const pivot = buildLegacyPivot(input, catalog, [], ["11CF"]);
  expect(pivot.ignoredSqlErrors.join(" ")).toContain("reused catalog LIKE suffix ''");
  expect(pivot.rows).toHaveLength(1);
});

test("Excel output retains blank rows, row-three header and legacy red fills", async () => {
  const pivot: PivotResult = { tableName: "1IX_04/0", typekeys: ["11CF"], ignoredSqlErrors: [], rows: [], };
  const rows = [{ operation: "01 00 001", dda: 4, cells: ["01 00 001", 4, null, 3], red: [true], pivotFound: true }];
  const buffer = await buildLegacyWorkbook(rows, pivot);
  const workbook = new (await import("exceljs")).default.Workbook();
  await workbook.xlsx.load(Buffer.from(buffer) as never);
  const sheet = workbook.getWorksheet("DDA contra BMW")!;
  expect(sheet.getCell("A1").value).toBeNull();
  expect(sheet.getCell("A2").value).toBeNull();
  expect(Array.from(sheet.getRow(3).values as unknown[]).slice(1)).toEqual(["Nº Operacion", "DDA", "", "11CF"]);
  expect(sheet.getCell("D4").fill).toMatchObject({ fgColor: { argb: "FFFF0000" } });
});
