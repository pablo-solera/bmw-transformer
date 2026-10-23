import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeSqlPool, getSqlPool } from "../src/sql/client.js";
import { persistLegacyPivot } from "../src/sql/persist-pivot.js";
import { quoteIdentifier } from "../src/sql/labour-table.js";
import type { PivotResult, PivotRow } from "../src/pipeline/pivot.js";
import type { ReportInput } from "../src/types.js";

const enabled = process.env.SQL_INTEGRATION === "true";
let tableName = "";
let triggerName = "";
let pool: Awaited<ReturnType<typeof getSqlPool>> | undefined;

beforeAll(async () => {
  if (!enabled) return;
  pool = await getSqlPool();
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.nomCamposTabla', N'U') IS NULL
    CREATE TABLE BMW_Labour.dbo.nomCamposTabla (
      brand nchar(10) COLLATE Latin1_General_CI_AS NULL,
      Model nchar(10) COLLATE Latin1_General_CI_AS NOT NULL,
      NomTable nchar(12) COLLATE Latin1_General_CI_AS NULL,
      nomCampo nchar(10) COLLATE Latin1_General_CI_AS NULL,
      Orden numeric(18,0) NULL,
      estado char(1) COLLATE Latin1_General_CI_AS DEFAULT '1' NULL,
      visible char(1) COLLATE Latin1_General_CI_AS DEFAULT '1' NULL,
      nomCampoVisible nchar(10) COLLATE Latin1_General_CI_AS NULL
    );
  `);
});

afterAll(async () => {
  if (enabled && pool && tableName) {
    await pool.request().query(`IF OBJECT_ID(N'dbo.${quoteIdentifier(tableName)}', N'U') IS NOT NULL DROP TABLE ${quoteIdentifier("dbo")}.${quoteIdentifier(tableName)};`);
    await pool.request().input("tableName", tableName).query("DELETE FROM dbo.nomCamposTabla WHERE NomTable = @tableName;");
    if (triggerName) await pool.request().query(`IF OBJECT_ID(N'dbo.${quoteIdentifier(triggerName)}', N'TR') IS NOT NULL DROP TRIGGER ${quoteIdentifier("dbo")}.${quoteIdentifier(triggerName)};`);
  }
  await closeSqlPool();
});

function makePivot(value: string): PivotResult {
  const seed: PivotRow = {
    typekeyCatalog_id: "catalog-id", typekeyCatalog_number: "41", typekeyCatalog_text: "Body", typekeyCatalog_entriesId: "entry-id", typekeyCatalog_entriesNumber: "1", typekeyCatalog_entriesText: "Engine carrier",
    typekeyIdEntriesId_catalogPaths: null, typekeyIdEntriesId_rubrikText: null, typekeyIdEntriesId_text: null, typekeyIdEntriesId_flatrates_awSheetOID: null,
    typekeyIdEntriesId_flatrates_number: "0", typekeyIdEntriesId_flatrates_text: null, typekeyIdEntriesId_flatrates_workType: null, typekeyIdEntriesId_flatrates_klammerText: null,
    orderNumber: null, values: { "11HC": null }, insertionOrder: 0,
  };
  const populated: PivotRow = {
    ...seed, typekeyIdEntriesId_catalogPaths: "41_path", typekeyIdEntriesId_rubrikText: "Repair", typekeyIdEntriesId_text: "Same labour",
    typekeyIdEntriesId_flatrates_awSheetOID: "OID-1", typekeyIdEntriesId_flatrates_number: "4100800", typekeyIdEntriesId_flatrates_text: "Rate text",
    typekeyIdEntriesId_flatrates_workType: "HAUPTARBEIT", typekeyIdEntriesId_flatrates_klammerText: "note", orderNumber: "100",
    values: { "11HC": value }, insertionOrder: 1,
  };
  return { tableName, typekeys: ["11HC"], columns: [{ typekey: "11HC", columnName: "type_11HC", order: 1 }], rows: [seed, populated], ignoredSqlErrors: [] };
}

if (!enabled) {
  test.skip("SQL Server atomic replacement integration (run `bun run test:sql`)", () => {});
} else {
  test("creates, replaces and rolls back the legacy labour table and nomCamposTabla metadata", async () => {
    tableName = `T${crypto.randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}_01/0`;
    triggerName = `trg_test_${tableName.replace(/[^A-Za-z0-9_]/g, "_")}`;
    expect(tableName.length).toBeLessThanOrEqual(12);
    const input: ReportInput = { axCode: tableName.split("_")[0]!, edition: "01/0", manufacturer: "BMW", series: "4'", family: "G26", typekeys: [{ typekey: "11HC" }] };

    const initial = await persistLegacyPivot(input, makePivot("32"));
    expect(initial).toMatchObject({ enabled: true, tableName, rows: 2, columns: 16, replaced: false });
    const initialObject = await pool!.request().input("tableName", tableName).query<{ objectId: number }>("SELECT OBJECT_ID(QUOTENAME(N'dbo') + N'.' + QUOTENAME(@tableName), N'U') AS objectId;");
    const first = await pool!.request().query(`SELECT [typekeyIdEntriesId_flatrates_number], [type_11HC] FROM ${quoteIdentifier("dbo")}.${quoteIdentifier(tableName)} ORDER BY [typekeyIdEntriesId_flatrates_number];`);
    expect(first.recordset.map(row => ({ number: String(row.typekeyIdEntriesId_flatrates_number).trimEnd(), value: row.type_11HC == null ? null : String(row.type_11HC).trimEnd() }))).toEqual([
      { number: "0", value: null },
      { number: "4100800", value: "32" },
    ]);
    const columns = await pool!.request().input("tableName", tableName).query("SELECT brand, Model, NomTable, nomCampo, Orden, estado, visible, nomCampoVisible FROM dbo.nomCamposTabla WHERE NomTable = @tableName;");
    expect(columns.recordset).toHaveLength(1);
    const metadata = columns.recordset[0]!;
    expect({
      brand: String(metadata.brand).trimEnd(),
      Model: String(metadata.Model).trimEnd(),
      NomTable: String(metadata.NomTable).trimEnd(),
      nomCampo: String(metadata.nomCampo).trimEnd(),
      Orden: metadata.Orden,
      estado: metadata.estado,
      visible: metadata.visible,
      nomCampoVisible: String(metadata.nomCampoVisible).trimEnd(),
    }).toEqual({ brand: "BMW", Model: "4", NomTable: tableName, nomCampo: "11HC", Orden: 1, estado: "1", visible: "1", nomCampoVisible: "11HC" });

    await pool!.request().query(`CREATE TRIGGER ${quoteIdentifier("dbo")}.${quoteIdentifier(triggerName)} ON dbo.nomCamposTabla AFTER INSERT AS BEGIN IF EXISTS (SELECT 1 FROM inserted WHERE NomTable = N'${tableName}') THROW 51001, 'integration rollback probe', 1; END;`);
    await expect(persistLegacyPivot(input, makePivot("99"))).rejects.toThrow("SQL persistence failed");
    await pool!.request().query(`DROP TRIGGER ${quoteIdentifier("dbo")}.${quoteIdentifier(triggerName)};`);
    triggerName = "";
    const afterRollback = await pool!.request().query(`SELECT [type_11HC] FROM ${quoteIdentifier("dbo")}.${quoteIdentifier(tableName)} WHERE [typekeyIdEntriesId_flatrates_number] = N'4100800';`);
    expect(String(afterRollback.recordset[0]?.type_11HC).trimEnd()).toBe("32");
    const rollbackObject = await pool!.request().input("tableName", tableName).query<{ objectId: number }>("SELECT OBJECT_ID(QUOTENAME(N'dbo') + N'.' + QUOTENAME(@tableName), N'U') AS objectId;");
    expect(rollbackObject.recordset[0]?.objectId).toBe(initialObject.recordset[0]?.objectId);

    const replaced = await persistLegacyPivot(input, makePivot("33"));
    expect(replaced.replaced).toBe(true);
    const replacementObject = await pool!.request().input("tableName", tableName).query<{ objectId: number }>("SELECT OBJECT_ID(QUOTENAME(N'dbo') + N'.' + QUOTENAME(@tableName), N'U') AS objectId;");
    expect(replacementObject.recordset[0]?.objectId).toBe(initialObject.recordset[0]?.objectId);
    const finalRows = await pool!.request().query(`SELECT [type_11HC] FROM ${quoteIdentifier("dbo")}.${quoteIdentifier(tableName)} WHERE [typekeyIdEntriesId_flatrates_number] = N'4100800';`);
    expect(String(finalRows.recordset[0]?.type_11HC).trimEnd()).toBe("33");
    const finalMetadata = await pool!.request().input("tableName", tableName).query("SELECT COUNT(*) AS count FROM dbo.nomCamposTabla WHERE NomTable = @tableName;");
    expect(finalMetadata.recordset[0]?.count).toBe(1);
  }, 120000);
}
