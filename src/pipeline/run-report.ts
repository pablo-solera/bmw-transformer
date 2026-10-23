import { parseMasterListingBytes, toDdaRecords } from "../dda/parse-lst.js";
import { legacyExcelRows, type PivotResult } from "./pivot.js";
import { buildLegacyWorkbook } from "../report/workbook.js";
import { getBytes, getJson, objectKey, putBytes, putJson } from "../storage.js";
import type { ReportInput, ReportState } from "../types.js";
import { loadPivot, pivotDocument, type StateUpdate } from "./run-load.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function writeReport(input: ReportInput, requestId: string, pivot: PivotResult, source: Uint8Array, update: StateUpdate) {
  const reportPrefix = objectKey(input.group ?? "BMW", input.manufacturer, "reports", input.axCode, input.edition, requestId);
  const listing = parseMasterListingBytes(source, input.sourceFilename ?? "source.lst");
  await update({ status: "parsing-dda", stage: "Leyendo bloque Q del LST", progress: 60 });
  const dda = toDdaRecords(listing);
  const outputRows = legacyExcelRows(dda, pivot);
  await update({ status: "reporting", stage: "Generando Excel DDA contra BMW", progress: 80 });
  const workbook = await buildLegacyWorkbook(outputRows, pivot);
  const filename = `${input.axCode}_${input.edition.replace(/\//g, "_")}_DDA_contra_BMW.xlsx`;
  const reportKey = `${reportPrefix}/${filename}`;
  await putBytes(reportKey, workbook, XLSX);
  return { reportPrefix, reportKey, listing, dda, outputRows };
}

/** Legacy all-in-one job: load into BMW_Labour and compare against the uploaded .LST in one go. */
export async function runReportJob(requestId: string, state: ReportState, update: StateUpdate) {
  const input = state.input;
  const sourceKey = objectKey(input.group ?? "BMW", input.manufacturer, "reports", input.axCode, input.edition, requestId, "source.lst");
  const source = await getBytes(sourceKey);
  parseMasterListingBytes(source, input.sourceFilename ?? "source.lst");

  const { imported, pivot, sqlPersistence } = await loadPivot(input, update);
  const { reportPrefix, reportKey, listing, dda, outputRows } = await writeReport(input, requestId, pivot, source, update);
  await putJson(`${reportPrefix}/pivot.json`, pivotDocument(pivot));
  const summary = {
    source: { filename: listing.header.sourceFile, header: listing.header, qRows: listing.blocks.Q.length },
    input,
    typekeys: imported.sources,
    selectedTypekeys: imported.selectedTypekeys,
    staging: { catalogRows: imported.catalog.length, flatrateRows: imported.rates.length },
    pivot: { tableName: pivot.tableName, rows: pivot.rows.length, columns: pivot.typekeys.length },
    sql: sqlPersistence,
    dda: { qRows: dda.length, eligibleOperations: outputRows.length },
    ignoredSqlErrors: pivot.ignoredSqlErrors,
    reportKey,
  };
  await putJson(`${reportPrefix}/summary.json`, summary);
  await update({ status: "completed", stage: "Reporte completado", progress: 100, reportKey, summary });
  return { reportKey, summary };
}

type PivotDocument = Omit<PivotResult, "ignoredSqlErrors"> & { ignoredSqlErrors?: string[] };

/** Compares an uploaded .LST against the pivot of a finished load; nothing is read from S3 extractions or written to SQL. */
export async function runCompareJob(requestId: string, state: ReportState, load: ReportState, update: StateUpdate) {
  const input = state.input;
  if (!load.pivotKey) throw new Error(`La carga ${load.requestId} no tiene pivote disponible`);
  const sourceKey = objectKey(input.group ?? "BMW", input.manufacturer, "reports", input.axCode, input.edition, requestId, "source.lst");
  const [source, document] = await Promise.all([getBytes(sourceKey), getJson<PivotDocument>(load.pivotKey)]);
  const pivot: PivotResult = { ...document, ignoredSqlErrors: document.ignoredSqlErrors ?? [] };
  const { reportPrefix, reportKey, listing, dda, outputRows } = await writeReport(input, requestId, pivot, source, update);
  const summary = {
    source: { filename: listing.header.sourceFile, header: listing.header, qRows: listing.blocks.Q.length },
    input,
    loadId: load.requestId,
    pivot: { tableName: pivot.tableName, rows: pivot.rows.length, columns: pivot.typekeys.length },
    dda: { qRows: dda.length, eligibleOperations: outputRows.length },
    reportKey,
  };
  await putJson(`${reportPrefix}/summary.json`, summary);
  await update({ status: "completed", stage: "Reporte completado", progress: 100, reportKey, summary });
  return { reportKey, summary };
}
