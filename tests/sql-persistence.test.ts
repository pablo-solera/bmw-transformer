import { describe, expect, test } from "bun:test";
import { normalizeLegacySeries } from "../src/legacy/series.js";
import { buildLegacyTableDdl, quoteIdentifier, toLegacyTableRows, toNomCamposRows } from "../src/sql/labour-table.js";
import type { PivotResult, PivotRow } from "../src/pipeline/pivot.js";
import type { ReportInput } from "../src/types.js";

const input: ReportInput = {
  axCode: "11I",
  edition: "05/0",
  manufacturer: "BMW",
  series: "4'",
  family: "G26",
  typekeys: [{ typekey: "11HC" }],
};

const column = { typekey: "11HC", columnName: "type_11HC", order: 1 } as const;

function row(overrides: Partial<PivotRow> = {}): PivotRow {
  return {
    typekeyCatalog_id: "catalog-id",
    typekeyCatalog_number: "41",
    typekeyCatalog_text: "Body",
    typekeyCatalog_entriesId: "entry-id",
    typekeyCatalog_entriesNumber: "1",
    typekeyCatalog_entriesText: "Engine carrier",
    typekeyIdEntriesId_catalogPaths: null,
    typekeyIdEntriesId_rubrikText: null,
    typekeyIdEntriesId_text: null,
    typekeyIdEntriesId_flatrates_awSheetOID: null,
    typekeyIdEntriesId_flatrates_number: "0",
    typekeyIdEntriesId_flatrates_text: null,
    typekeyIdEntriesId_flatrates_workType: null,
    typekeyIdEntriesId_flatrates_klammerText: null,
    orderNumber: null,
    values: { "11HC": null },
    insertionOrder: 0,
    ...overrides,
  };
}

function pivot(rows: PivotRow[] = [row()]): PivotResult {
  return { tableName: "11I_05/0", typekeys: ["11HC"], columns: [column], rows, ignoredSqlErrors: [] };
}

describe("legacy SQL labour table mapping", () => {
  test("quotes identifiers and reproduces the legacy DDL, including edition slash and typekey column", () => {
    expect(quoteIdentifier("BMW]Labour")).toBe("[BMW]]Labour]");
    const ddl = buildLegacyTableDdl("11I_05/0", [column]);
    expect(ddl).toContain("CREATE TABLE [dbo].[11I_05/0]");
    expect(ddl).toContain("[typekeyCatalog_id] nvarchar(MAX)");
    expect(ddl).toContain("[orderNumber] nvarchar(50)");
    expect(ddl).toContain("[type_11HC] nchar(10)");
    expect(ddl).not.toContain("PRIMARY KEY");
  });

  test("maps populated operation rows and retained legacy seed rows without dropping NULLs", () => {
    const populated = row({
      typekeyIdEntriesId_catalogPaths: "41_path",
      typekeyIdEntriesId_rubrikText: "Repair",
      typekeyIdEntriesId_text: "Same labour",
      typekeyIdEntriesId_flatrates_awSheetOID: "OID-1",
      typekeyIdEntriesId_flatrates_number: "4100800",
      typekeyIdEntriesId_flatrates_text: "Rate text",
      typekeyIdEntriesId_flatrates_workType: "HAUPTARBEIT",
      typekeyIdEntriesId_flatrates_klammerText: "note",
      orderNumber: "100",
      values: { "11HC": "32" },
      insertionOrder: 1,
    });
    const rows = toLegacyTableRows(pivot([row(), populated]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ typekeyIdEntriesId_flatrates_number: "0", type_11HC: null });
    expect(rows[1]).toMatchObject({
      typekeyIdEntriesId_flatrates_awSheetOID: "OID-1",
      typekeyIdEntriesId_flatrates_number: "4100800",
      typekeyIdEntriesId_flatrates_workType: "HAUPTARBEIT",
      orderNumber: "100",
      type_11HC: "32",
    });
  });

  test("prepares nomCamposTabla values with legacy defaults and request order", () => {
    const twoTypes = pivot();
    twoTypes.typekeys.push("21HC");
    twoTypes.columns.push({ typekey: "21HC", columnName: "type_21HC", order: 2 });
    const metadata = toNomCamposRows(input, twoTypes);
    expect(metadata).toEqual([
      { brand: "BMW", Model: "4", NomTable: "11I_05/0", nomCampo: "11HC", Orden: 1, estado: "1", visible: "1", nomCampoVisible: "11HC" },
      { brand: "BMW", Model: "4", NomTable: "11I_05/0", nomCampo: "21HC", Orden: 2, estado: "1", visible: "1", nomCampoVisible: "21HC" },
    ]);
  });

  test("matches the reader's apostrophe normalization and rejects unsafe S3 series", () => {
    expect(normalizeLegacySeries("7'")).toBe("7");
    expect(normalizeLegacySeries(" 4 ")).toBe("4");
    expect(() => normalizeLegacySeries("../secrets")).toThrow("invalid S3 path characters");
  });

  test("rejects empty, unsafe, duplicate or malformed dynamic table definitions", () => {
    expect(() => buildLegacyTableDdl("11I_05/0", [])).toThrow("without completed typekeys");
    expect(() => buildLegacyTableDdl("11I_05/0", [{ ...column, columnName: "type_11HC; DROP TABLE X" }])).toThrow("Invalid legacy typekey");
    expect(() => buildLegacyTableDdl("11I_05/0", [column, column])).toThrow("Invalid legacy typekey");
  });
});
