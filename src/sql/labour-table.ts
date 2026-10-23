import sql from "mssql";
import { requestSeries } from "../pipeline/input.js";
import type { PivotResult, PivotRow, PivotTypekeyColumn } from "../pipeline/pivot.js";
import type { ReportInput } from "../types.js";
import { normalizeLegacySeries } from "../legacy/series.js";

export const legacyFixedColumns = [
  { name: "typekeyCatalog_id", ddl: "nvarchar(MAX)", type: sql.NVarChar(sql.MAX) },
  { name: "typekeyCatalog_number", ddl: "nvarchar(10)", type: sql.NVarChar(10) },
  { name: "typekeyCatalog_text", ddl: "nvarchar(250)", type: sql.NVarChar(250) },
  { name: "typekeyCatalog_entriesId", ddl: "nvarchar(250)", type: sql.NVarChar(250) },
  { name: "typekeyCatalog_entriesNumber", ddl: "nvarchar(250)", type: sql.NVarChar(250) },
  { name: "typekeyCatalog_entriesText", ddl: "nvarchar(250)", type: sql.NVarChar(250) },
  { name: "typekeyIdEntriesId_catalogPaths", ddl: "nvarchar(250)", type: sql.NVarChar(250) },
  { name: "typekeyIdEntriesId_rubrikText", ddl: "nvarchar(250)", type: sql.NVarChar(250) },
  { name: "typekeyIdEntriesId_text", ddl: "nvarchar(250)", type: sql.NVarChar(250) },
  { name: "typekeyIdEntriesId_flatrates_awSheetOID", ddl: "nvarchar(250)", type: sql.NVarChar(250) },
  { name: "typekeyIdEntriesId_flatrates_number", ddl: "nvarchar(250)", type: sql.NVarChar(250) },
  { name: "typekeyIdEntriesId_flatrates_text", ddl: "nvarchar(250)", type: sql.NVarChar(250) },
  { name: "typekeyIdEntriesId_flatrates_workType", ddl: "nvarchar(250)", type: sql.NVarChar(250) },
  { name: "typekeyIdEntriesId_flatrates_klammerText", ddl: "nvarchar(250)", type: sql.NVarChar(250) },
  { name: "orderNumber", ddl: "nvarchar(50)", type: sql.NVarChar(50) },
] as const;

export type SqlLabourCell = string | null;
export type LabourTableRow = Record<string, SqlLabourCell>;
export type NomCamposRow = {
  brand: string;
  Model: string;
  NomTable: string;
  nomCampo: string;
  Orden: number;
  estado: "1";
  visible: "1";
  nomCampoVisible: string;
};

export function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0") || value.length > 128) throw new Error("SQL identifier is empty, invalid or exceeds 128 characters");
  return "[" + value.split("]").join("]]") + "]";
}

export function validateLegacyTypekeyColumns(columns: PivotTypekeyColumn[]) {
  if (columns.length === 0) throw new Error("Cannot persist a BMW labour table without completed typekeys");
  const seen = new Set<string>();
  for (const [index, column] of columns.entries()) {
    if (!/^[A-Z0-9]{4}$/.test(column.typekey) || column.columnName !== `type_${column.typekey}` || seen.has(column.typekey) || column.order !== index + 1) {
      throw new Error(`Invalid legacy typekey column definition at index ${index}`);
    }
    seen.add(column.typekey);
  }
}

export function validateLegacyTableIdentity(tableName: string, columns: PivotTypekeyColumn[]) {
  if (tableName.length > 12 || !/^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/.test(tableName)) {
    throw new Error(`Legacy SQL fatal: nomCamposTabla.NomTable must fit nchar(12): ${tableName}`);
  }
  validateLegacyTypekeyColumns(columns);
}

export function buildLegacyTableDdl(tableName: string, columns: PivotTypekeyColumn[]) {
  validateLegacyTypekeyColumns(columns);
  const definitions = [
    ...legacyFixedColumns.map(column => `${quoteIdentifier(column.name)} ${column.ddl}`),
    ...columns.map(column => `${quoteIdentifier(column.columnName)} nchar(10)`),
  ];
  return `CREATE TABLE ${quoteIdentifier("dbo")}.${quoteIdentifier(tableName)} (${definitions.join(", ")});`;
}

function fixedValues(row: PivotRow): SqlLabourCell[] {
  return [
    row.typekeyCatalog_id,
    row.typekeyCatalog_number,
    row.typekeyCatalog_text,
    row.typekeyCatalog_entriesId,
    row.typekeyCatalog_entriesNumber,
    row.typekeyCatalog_entriesText,
    row.typekeyIdEntriesId_catalogPaths,
    row.typekeyIdEntriesId_rubrikText,
    row.typekeyIdEntriesId_text,
    row.typekeyIdEntriesId_flatrates_awSheetOID,
    row.typekeyIdEntriesId_flatrates_number,
    row.typekeyIdEntriesId_flatrates_text,
    row.typekeyIdEntriesId_flatrates_workType,
    row.typekeyIdEntriesId_flatrates_klammerText,
    row.orderNumber,
  ];
}

export function toLegacyTableRows(pivot: PivotResult): LabourTableRow[] {
  validateLegacyTableIdentity(pivot.tableName, pivot.columns);
  return pivot.rows.map(row => {
    const values = fixedValues(row);
    const result = Object.fromEntries(legacyFixedColumns.map((column, index) => [column.name, values[index]!])) as LabourTableRow;
    for (const column of pivot.columns) result[column.columnName] = row.values[column.typekey] ?? null;
    return result;
  });
}

export function toNomCamposRows(input: ReportInput, pivot: PivotResult): NomCamposRow[] {
  validateLegacyTableIdentity(pivot.tableName, pivot.columns);
  const brand = (input.brand ?? input.manufacturer).trim();
  const model = (input.model ?? normalizeLegacySeries(requestSeries(input))).trim();
  if (brand.length > 10) throw new Error("Legacy SQL fatal: nomCamposTabla.brand truncation (nchar(10))");
  if (model.length > 10) throw new Error("Legacy SQL fatal: nomCamposTabla.Model truncation (nchar(10))");
  return pivot.columns.map(column => ({
    brand,
    Model: model,
    NomTable: pivot.tableName,
    nomCampo: column.typekey,
    Orden: column.order,
    estado: "1",
    visible: "1",
    nomCampoVisible: column.typekey,
  }));
}

export function getLegacyBulkColumns(typekeys: PivotTypekeyColumn[]) {
  return [
    ...legacyFixedColumns.map(column => ({ name: column.name, type: column.type })),
    ...typekeys.map(column => ({ name: column.columnName, type: sql.NChar(10) })),
  ];
}
