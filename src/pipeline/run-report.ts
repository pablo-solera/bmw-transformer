import { parseMasterListingBytes, toDdaRecords } from "../dda/parse-lst.js";
import { importExtractedData } from "./import-data.js";
import { buildLegacyPivot, legacyExcelRows } from "./pivot.js";
import { buildLegacyWorkbook } from "../report/workbook.js";
import { getBytes, objectKey, putBytes, putJson } from "../storage.js";
import type { ReportInput } from "../types.js";
import type { ReportState } from "../types.js";

export async function runReportJob(requestId: string, state: ReportState, update: (patch: Partial<ReportState>) => Promise<void>) {
  const input = state.input;
  const sourceKey = objectKey(input.group ?? "BMW", input.manufacturer, "reports", input.axCode, input.edition, requestId, "source.lst");
  const reportPrefix = objectKey(input.group ?? "BMW", input.manufacturer, "reports", input.axCode, input.edition, requestId);
  const source = await getBytes(sourceKey);
  const listing = parseMasterListingBytes(source, input.sourceFilename ?? "source.lst");

  await update({ status: "resolving", stage: "Resolviendo typekeys completados en S3", progress: 5 });
  const imported = await importExtractedData(input, async (progress, stage) => update({ status: "importing", stage, progress: 10 + progress }));
  await update({ status: "pivoting", stage: "Generando pivote legacy", progress: 35 });
  const pivot = buildLegacyPivot(input, imported.catalog, imported.rates, imported.selectedTypekeys);
  await update({ status: "parsing-dda", stage: "Leyendo bloque Q del LST", progress: 60 });
  const dda = toDdaRecords(listing);
  const outputRows = legacyExcelRows(dda, pivot);
  await update({ status: "reporting", stage: "Generando Excel DDA contra BMW", progress: 80 });
  const workbook = await buildLegacyWorkbook(outputRows, pivot);
  const filename = `${input.axCode}_${input.edition.replace(/\//g, "_")}_DDA_contra_BMW.xlsx`;
  const reportKey = `${reportPrefix}/${filename}`;
  await putBytes(reportKey, workbook, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await putJson(`${reportPrefix}/pivot.json`, { tableName: pivot.tableName, typekeys: pivot.typekeys, rowCount: pivot.rows.length, rows: pivot.rows });
  const summary = {
    source: { filename: listing.header.sourceFile, header: listing.header, qRows: listing.blocks.Q.length },
    input: input as ReportInput,
    typekeys: imported.sources,
    selectedTypekeys: imported.selectedTypekeys,
    staging: { catalogRows: imported.catalog.length, flatrateRows: imported.rates.length },
    pivot: { tableName: pivot.tableName, rows: pivot.rows.length, columns: pivot.typekeys.length },
    dda: { qRows: dda.length, eligibleOperations: outputRows.length },
    ignoredSqlErrors: pivot.ignoredSqlErrors,
    reportKey,
  };
  await putJson(`${reportPrefix}/summary.json`, summary);
  await update({ status: "completed", stage: "Reporte completado", progress: 100, reportKey, summary });
  return { reportKey, summary };
}
