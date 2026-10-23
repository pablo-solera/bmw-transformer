import sql from "mssql";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { PivotResult } from "../pipeline/pivot.js";
import type { ReportInput } from "../types.js";
import { getSqlPool } from "./client.js";
import { buildLegacyTableDdl, getLegacyBulkColumns, legacyFixedColumns, quoteIdentifier, toLegacyTableRows, toNomCamposRows } from "./labour-table.js";

export type SqlPersistenceProgress = (percent: number, stage: string) => Promise<void>;
export type SqlPersistenceResult = {
  enabled: true;
  tableName: string;
  rows: number;
  columns: number;
  replaced: boolean;
  durationMs: number;
};

const temporaryPrefix = "__bmw_tmp_";

function qualifiedTable(name: string) {
  return `${quoteIdentifier("dbo")}.${quoteIdentifier(name)}`;
}

async function renameTable(request: sql.Request, currentName: string, newName: string) {
  await request
    .input("objectName", sql.NVarChar(260), `dbo.${quoteIdentifier(currentName)}`)
    .input("newName", sql.NVarChar(128), newName)
    .query("EXEC sys.sp_rename @objname = @objectName, @newname = @newName, @objtype = N'OBJECT';");
}

async function insertMetadata(transaction: sql.Transaction, rows: ReturnType<typeof toNomCamposRows>) {
  const batchSize = 200;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const request = transaction.request();
    const values = batch.map((row, rowIndex) => {
      const names = ["brand", "model", "nomTable", "nomCampo", "orden", "estado", "visible", "nomCampoVisible"].map((name, columnIndex) => `m${rowIndex}_${columnIndex}`);
      request.input(names[0]!, sql.NChar(10), row.brand);
      request.input(names[1]!, sql.NChar(10), row.Model);
      request.input(names[2]!, sql.NChar(12), row.NomTable);
      request.input(names[3]!, sql.NChar(10), row.nomCampo);
      request.input(names[4]!, sql.Numeric(18, 0), row.Orden);
      request.input(names[5]!, sql.Char(1), row.estado);
      request.input(names[6]!, sql.Char(1), row.visible);
      request.input(names[7]!, sql.NChar(10), row.nomCampoVisible);
      return `(${names.map(name => `@${name}`).join(", ")})`;
    });
    await request.query(`INSERT INTO ${qualifiedTable("nomCamposTabla")} (brand, Model, NomTable, nomCampo, Orden, estado, visible, nomCampoVisible) VALUES ${values.join(", ")};`);
  }
}

async function dropIfExists(pool: sql.ConnectionPool, tableName: string) {
  await pool.request().query(`IF OBJECT_ID(N'dbo.${quoteIdentifier(tableName)}', N'U') IS NOT NULL DROP TABLE ${qualifiedTable(tableName)};`);
}

export async function cleanupStaleTemporaryTables(maxAgeHours = 24): Promise<number> {
  const pool = await getSqlPool();
  const result = await pool.request()
    .input("prefix", sql.NVarChar(32), temporaryPrefix)
    .input("ageHours", sql.Int, maxAgeHours)
    .query<{ name: string }>("SELECT t.name FROM sys.tables AS t INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id WHERE s.name = N'dbo' AND LEFT(t.name, LEN(@prefix)) = @prefix AND t.create_date < DATEADD(hour, -@ageHours, SYSDATETIME());");
  const staleNames = result.recordset.map(row => row.name).filter(name => /^__bmw_tmp_[0-9a-f]{32}$/i.test(name));
  for (const name of staleNames) await dropIfExists(pool, name);
  return staleNames.length;
}

/** Builds a complete replacement off to the side, then swaps it and its Visor metadata in one transaction. */
export async function persistLegacyPivot(input: ReportInput, pivot: PivotResult, progress?: SqlPersistenceProgress): Promise<SqlPersistenceResult> {
  if (!config.sqlEnabled) throw new Error("SQL persistence is disabled; set SQL_ENABLED=true to create BMW labour tables");
  if (pivot.tableName !== `${input.axCode}_${input.edition}`) throw new Error("SQL persistence table name does not match the report metadata");

  const startedAt = Date.now();
  const tableName = pivot.tableName;
  const temporaryName = `${temporaryPrefix}${randomUUID().replace(/-/g, "")}`;
  const rows = toLegacyTableRows(pivot);
  const metadataRows = toNomCamposRows(input, pivot);
  const pool = await getSqlPool();
  let transaction: sql.Transaction | undefined;
  let committed = false;

  try {
    await progress?.(5, `Creando tabla temporal para ${tableName}`);
    await pool.request().query(buildLegacyTableDdl(temporaryName, pivot.columns));

    if (rows.length) {
      const bulkTable = new sql.Table(`dbo.${temporaryName}`);
      bulkTable.create = false;
      for (const column of getLegacyBulkColumns(pivot.columns)) bulkTable.columns.add(column.name, column.type, { nullable: true });
      for (const row of rows) bulkTable.rows.add(...Object.values(row));
      const bulkResult = await pool.request().bulk(bulkTable, { keepNulls: true, tableLock: true });
      if (bulkResult.rowsAffected !== rows.length) throw new Error(`SQL bulk row count mismatch: expected ${rows.length}, wrote ${bulkResult.rowsAffected}`);
    }
    await progress?.(80, `Preparando reemplazo de ${tableName}`);

    transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    const lockRequest = transaction.request()
      .input("resource", sql.NVarChar(255), `bmw-transformer:${tableName}`)
      .input("lockTimeout", sql.Int, config.SQL_REQUEST_TIMEOUT_MS);
    await lockRequest.query(`
      DECLARE @lockResult int;
      EXEC @lockResult = sys.sp_getapplock
        @Resource = @resource,
        @LockMode = N'Exclusive',
        @LockOwner = N'Transaction',
        @LockTimeout = @lockTimeout;
      IF @lockResult < 0 THROW 51000, 'Could not acquire the BMW labour table replacement lock', 1;
    `);

    const existsResult = await transaction.request()
      .input("tableName", sql.NVarChar(128), tableName)
      .query<{ objectId: number | null }>("SELECT OBJECT_ID(QUOTENAME(N'dbo') + N'.' + QUOTENAME(@tableName), N'U') AS objectId;");
    const replaced = existsResult.recordset[0]?.objectId != null;

    if (replaced) {
      const columnsResult = await transaction.request()
        .input("tableName", sql.NVarChar(128), tableName)
        .query<{ name: string }>("SELECT c.name FROM sys.columns AS c INNER JOIN sys.tables AS t ON t.object_id = c.object_id INNER JOIN sys.schemas AS s ON s.schema_id = t.schema_id WHERE s.name = N'dbo' AND t.name = @tableName;");
      const existingColumns = columnsResult.recordset.map(column => column.name);
      const fixedNames = new Set<string>(legacyFixedColumns.map(column => column.name));
      const missingFixed = [...fixedNames].filter(name => !existingColumns.includes(name));
      const unexpected = existingColumns.filter(name => !fixedNames.has(name) && !/^type_[A-Z0-9]{4}$/.test(name));
      if (missingFixed.length || unexpected.length) throw new Error("Existing BMW labour table has an incompatible schema");

      const oldTypeColumns = existingColumns.filter(name => /^type_[A-Z0-9]{4}$/.test(name));
      const target = qualifiedTable(tableName);
      const request = transaction.request();
      await request.query(`DELETE FROM ${target};`);
      if (oldTypeColumns.length) await request.query(`ALTER TABLE ${target} DROP COLUMN ${oldTypeColumns.map(quoteIdentifier).join(", ")};`);
      await request.query(`ALTER TABLE ${target} ADD ${pivot.columns.map(column => `${quoteIdentifier(column.columnName)} nchar(10) NULL`).join(", ")};`);

      const insertColumns = [...legacyFixedColumns.map(column => column.name), ...pivot.columns.map(column => column.columnName)];
      const quotedColumns = insertColumns.map(quoteIdentifier).join(", ");
      await request.query(`INSERT INTO ${target} (${quotedColumns}) SELECT ${quotedColumns} FROM ${qualifiedTable(temporaryName)};`);
      await request.query(`DROP TABLE ${qualifiedTable(temporaryName)};`);
    } else {
      await renameTable(transaction.request(), temporaryName, tableName);
    }

    await transaction.request()
      .input("tableName", sql.NChar(12), tableName)
      .query(`DELETE FROM ${qualifiedTable("nomCamposTabla")} WHERE NomTable = @tableName;`);
    await insertMetadata(transaction, metadataRows);

    await transaction.commit();
    committed = true;
    await progress?.(100, `Tabla ${tableName} persistida`);

    return {
      enabled: true,
      tableName,
      rows: rows.length,
      columns: 15 + pivot.columns.length,
      replaced,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (transaction && !committed) await transaction.rollback().catch(() => undefined);
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
    throw new Error(`BMW labour SQL persistence failed${code ? ` (${code})` : ""}`, { cause: error });
  } finally {
    if (!committed) await dropIfExists(pool, temporaryName).catch(() => undefined);
    if (transaction) transaction = undefined;
  }
}
