import { importExtractedData } from "./import-data.js";
import { buildLegacyPivot, type PivotResult } from "./pivot.js";
import { objectKey, putJson } from "../storage.js";
import { config } from "../config.js";
import { persistLegacyPivot } from "../sql/persist-pivot.js";
import type { ReportInput, ReportState } from "../types.js";

export type StateUpdate = (patch: Partial<ReportState>) => Promise<void>;

/** Reads the extracted data from S3, builds the legacy pivot and persists it into BMW_Labour when SQL is enabled. */
export async function loadPivot(input: ReportInput, update: StateUpdate) {
  await update({ status: "resolving", stage: "Resolviendo typekeys completados en S3", progress: 5 });
  const imported = await importExtractedData(input, async (progress, stage) => update({ status: "importing", stage, progress: 10 + progress }));
  await update({ status: "pivoting", stage: "Generando pivote legacy", progress: 35 });
  const pivot = buildLegacyPivot(input, imported.catalog, imported.rates, imported.selectedTypekeys);
  let sqlPersistence: Record<string, unknown>;
  if (config.sqlEnabled) {
    await update({ status: "persisting", stage: `Persistiendo ${pivot.tableName} en BMW_Labour`, progress: 45 });
    sqlPersistence = await persistLegacyPivot(input, pivot, async (percent, stage) => {
      await update({ status: "persisting", stage, progress: 45 + Math.floor(percent * 0.15) });
    });
  } else {
    sqlPersistence = { enabled: false, persisted: false, tableName: pivot.tableName, rows: 0, columns: pivot.columns.length };
  }
  return { imported, pivot, sqlPersistence };
}

export const pivotDocument = (pivot: PivotResult) => ({ tableName: pivot.tableName, typekeys: pivot.typekeys, columns: pivot.columns, rowCount: pivot.rows.length, ignoredSqlErrors: pivot.ignoredSqlErrors, rows: pivot.rows });

export function loadPrefix(input: ReportInput, loadId: string) {
  return objectKey(input.group ?? "BMW", input.manufacturer, "loads", input.axCode, input.edition, loadId);
}

/** Loads a request into BMW_Labour without any .LST; the pivot is kept in S3 so later comparisons do not need to re-read the extraction. */
export async function runLoadJob(loadId: string, state: ReportState, update: StateUpdate) {
  const input = state.input;
  const { imported, pivot, sqlPersistence } = await loadPivot(input, update);
  if (imported.selectedTypekeys.length === 0) throw new Error("Ningún typekey de la carga tiene su marcador completed en S3");
  const prefix = loadPrefix(input, loadId);
  const pivotKey = `${prefix}/pivot.json`;
  await putJson(pivotKey, pivotDocument(pivot));
  const summary = {
    input,
    typekeys: imported.sources,
    selectedTypekeys: imported.selectedTypekeys,
    staging: { catalogRows: imported.catalog.length, flatrateRows: imported.rates.length },
    pivot: { tableName: pivot.tableName, rows: pivot.rows.length, columns: pivot.typekeys.length },
    sql: sqlPersistence,
    ignoredSqlErrors: pivot.ignoredSqlErrors,
    pivotKey,
  };
  await putJson(`${prefix}/summary.json`, summary);
  await update({ status: "completed", stage: "Carga completada", progress: 100, pivotKey, summary });
  return { pivotKey, summary };
}
