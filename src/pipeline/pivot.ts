import type { DdaRecord, ReportInput, StageCatalog, StageRate } from "../types.js";
import { enforceNchar, sqlEquals, sqlLike, sqlSort as sqlSortLegacy } from "../legacy/sqlserver.js";
import { vbExcelCell, vbInStr, vbMid } from "../legacy/vb.js";

export type PivotRow = {
  typekeyCatalog_id: string;
  typekeyCatalog_number: string;
  typekeyCatalog_text: string;
  typekeyCatalog_entriesId: string;
  typekeyCatalog_entriesNumber: string;
  typekeyCatalog_entriesText: string;
  typekeyIdEntriesId_catalogPaths: string | null;
  typekeyIdEntriesId_rubrikText: string | null;
  typekeyIdEntriesId_text: string | null;
  typekeyIdEntriesId_flatrates_awSheetOID: string | null;
  typekeyIdEntriesId_flatrates_number: string;
  typekeyIdEntriesId_flatrates_text: string | null;
  typekeyIdEntriesId_flatrates_workType: string | null;
  typekeyIdEntriesId_flatrates_klammerText: string | null;
  orderNumber: string | null;
  values: Record<string, string | null>;
  insertionOrder: number;
};

export type PivotResult = { rows: PivotRow[]; typekeys: string[]; ignoredSqlErrors: string[]; tableName: string };

const sqlV = (value: string, width: number, name: string) => enforceNchar(value, width, name).trimEnd();
const catalogTuple = (row: StageCatalog) => [row.id, row.number, row.text, row.entriesId, row.entriesNumber, row.entriesText];
const tupleEquals = (left: string[], right: string[]) => left.every((v, index) => sqlEquals(v, right[index]));

function findCatalogRows(catalog: StageCatalog[], selectedTypekeys: string[]): StageCatalog[] {
  const rows = catalog.filter(row => selectedTypekeys.some(key => sqlEquals(row.typekey, key)));
  const distinct: StageCatalog[] = [];
  for (const row of rows) if (!distinct.some(existing => tupleEquals(catalogTuple(existing), catalogTuple(row)))) distinct.push(row);
  // ORDER BY entriesId, with remaining DISTINCT projected columns resolving ties in the legacy table scan.
  return distinct.sort((a, b) => sqlSortLegacy(a.entriesId, b.entriesId) || sqlSortLegacy(a.id, b.id) || sqlSortLegacy(a.number, b.number) || sqlSortLegacy(a.text, b.text) || sqlSortLegacy(a.entriesNumber, b.entriesNumber) || sqlSortLegacy(a.entriesText, b.entriesText))
    .map(row => ({ ...row, id: row.id.trim(), number: row.number.trim(), text: row.text.trim(), entriesId: row.entriesId.trim(), entriesNumber: row.entriesNumber.trim(), entriesText: row.entriesText.trim() }));
}

function ratesForCatalog(rates: StageRate[], selected: Set<string>, suffixPattern: string): StageRate[] {
  return rates.filter(rate => selected.has(rate.typekeyIdEntriesId.toLocaleLowerCase("en-US")) && sqlLike(rate.catalogPaths, `%${suffixPattern}%`))
    .sort((a, b) => sqlSortLegacy(a.flatrates_number, b.flatrates_number) || sqlSortLegacy(a.flatrates_awSheetOID, b.flatrates_awSheetOID) || sqlSortLegacy(a.typekeyIdEntriesId, b.typekeyIdEntriesId) || a.insertionOrder - b.insertionOrder);
}

function buildRateMatchCache(rates: StageRate[], selected: Set<string>) {
  const groups = new Map<string, StageRate[]>();
  for (const rate of rates) {
    if (!selected.has(rate.typekeyIdEntriesId.toLocaleLowerCase("en-US"))) continue;
    const key = rate.catalogPaths;
    const bucket = groups.get(key);
    if (bucket) bucket.push(rate);
    else groups.set(key, [rate]);
  }
  const cache = new Map<string, StageRate[]>();
  return (suffixPattern: string) => {
    const prior = cache.get(suffixPattern);
    if (prior) return prior;
    // Preserve T-SQL LIKE wildcard semantics, but run it once per distinct path instead
    // of once per flatrate for every catalog row.
    const matches: StageRate[] = [];
    for (const [path, bucket] of groups) if (sqlLike(path, `%${suffixPattern}%`)) matches.push(...bucket);
    matches.sort((a, b) => sqlSortLegacy(a.flatrates_number, b.flatrates_number) || sqlSortLegacy(a.flatrates_awSheetOID, b.flatrates_awSheetOID) || sqlSortLegacy(a.typekeyIdEntriesId, b.typekeyIdEntriesId) || a.insertionOrder - b.insertionOrder);
    cache.set(suffixPattern, matches);
    return matches;
  };
}

export function buildLegacyPivot(input: ReportInput, catalog: StageCatalog[], rates: StageRate[], completedTypekeys: string[]): PivotResult {
  // GenerarTabla inserts nomCamposTabla in the development-code grid order;
  // comparativaBMW_DDA selects DISTINCT without ORDER BY, so preserve this heap order.
  const typekeys = [...completedTypekeys];
  const tableName = `${input.axCode}_${input.edition}`;
  if (tableName.length > 12) throw new Error(`Legacy SQL fatal: nomCamposTabla.NomTable truncation (nchar(12)): ${tableName}`);
  const model = input.series.replace(/'/g, "");
  if (model.length > 10) throw new Error(`Legacy SQL fatal: nomCamposTabla.Model truncation (nchar(10)): ${model}`);
  const nomCampos = typekeys.map((typekey, index) => ({ nomCampo: enforceNchar(typekey, 10, "nomCamposTabla.nomCampo").trimEnd(), orden: index + 1 }));
  const selectedSet = new Set(typekeys.map(typekey => typekey.toLocaleLowerCase("en-US")));
  const matchingRates = buildRateMatchCache(rates, selectedSet);
  const catalogRows = findCatalogRows(catalog, typekeys);
  const rows: PivotRow[] = [];
  const ignoredSqlErrors: string[] = [];
  let previous = { rubrikText: "", text: "", awSheetOID: "", number: "", flatText: "" };
  let laCondicionAdvance: string | null = null;
  let advanceTargets: PivotRow[] = [];
  let insertionOrder = 0;
  let condicionCatalogState = "";
  for (const catalogRow of catalogRows) {
    const newSeed = (): PivotRow => ({
      typekeyCatalog_id: catalogRow.id, typekeyCatalog_number: catalogRow.number, typekeyCatalog_text: catalogRow.text,
      typekeyCatalog_entriesId: catalogRow.entriesId, typekeyCatalog_entriesNumber: catalogRow.entriesNumber, typekeyCatalog_entriesText: catalogRow.entriesText,
      typekeyIdEntriesId_catalogPaths: null, typekeyIdEntriesId_rubrikText: null, typekeyIdEntriesId_text: null,
      typekeyIdEntriesId_flatrates_awSheetOID: null, typekeyIdEntriesId_flatrates_number: "0", typekeyIdEntriesId_flatrates_text: null,
      typekeyIdEntriesId_flatrates_workType: null, typekeyIdEntriesId_flatrates_klammerText: null, orderNumber: null,
      values: Object.fromEntries(typekeys.map(typekey => [typekey, null])), insertionOrder: insertionOrder++,
    });
    const catalogRowsForEntry: PivotRow[] = [newSeed()];
    rows.push(catalogRowsForEntry[0]!);
    let firstLine = 1;
    const underscore = vbInStr(catalogRow.entriesId, "_");
    if (underscore > 0) condicionCatalogState = vbMid(catalogRow.entriesId, underscore);
    else ignoredSqlErrors.push(`compararModelo: Mid(entriesId, InStr("_")) error 5; reused catalog LIKE suffix '${condicionCatalogState}'`);
    const catalogRates = matchingRates(condicionCatalogState);

    for (const rate of catalogRates) {
      const next = { rubrikText: rate.rubrikText, text: rate.text, awSheetOID: rate.flatrates_awSheetOID, number: rate.flatrates_number, flatText: rate.flatrates_text };
      next.rubrikText = next.rubrikText.trim();
      next.text = next.text.trim();
      next.awSheetOID = next.awSheetOID.trim();
      next.number = next.number.trim();
      next.flatText = next.flatText.trim();
      let nuevaLine = 0;
      // These five conditions execute as VB String comparisons (Option Compare Binary), not SQL collation.
      if (previous.rubrikText !== next.rubrikText || previous.text !== next.text || previous.awSheetOID !== next.awSheetOID || previous.number !== next.number || previous.flatText !== next.flatText) nuevaLine = 1;

      if (nuevaLine === 1) {
        if (firstLine === 0) {
          const nextSeed = newSeed();
          rows.push(nextSeed);
          catalogRowsForEntry.push(nextSeed);
        }
        firstLine = 0;
        const matchingSeeds = catalogRowsForEntry.filter(row => sqlEquals(row.typekeyIdEntriesId_flatrates_number, "0"));
        try {
          const expanded = rate.catalogPaths;
          if (expanded.length > 250) throw new Error("pivot.catalogPaths nvarchar(250) truncation");
          for (const row of matchingSeeds) {
            row.typekeyIdEntriesId_catalogPaths = expanded;
            row.typekeyIdEntriesId_rubrikText = sqlV(rate.rubrikText, 250, "pivot.rubrikText");
            row.typekeyIdEntriesId_text = sqlV(rate.text, 250, "pivot.text");
            row.typekeyIdEntriesId_flatrates_awSheetOID = sqlV(rate.flatrates_awSheetOID, 250, "pivot.awSheetOID");
            row.typekeyIdEntriesId_flatrates_number = sqlV(rate.flatrates_number, 250, "pivot.number");
            row.typekeyIdEntriesId_flatrates_text = sqlV(rate.flatrates_text, 250, "pivot.flatrates_text");
            row.typekeyIdEntriesId_flatrates_workType = sqlV(rate.flatrates_workType, 250, "pivot.workType");
            row.orderNumber = sqlV(rate.orderNumber, 50, "pivot.orderNumber");
            row.typekeyIdEntriesId_flatrates_klammerText = sqlV(rate.flatrates_klammerText, 250, "pivot.klammerText");
          }
          advanceTargets = matchingSeeds;
          laCondicionAdvance = `${catalogRow.id}|${catalogRow.number}|${catalogRow.text}|${catalogRow.entriesId}|${catalogRow.entriesNumber}|${catalogRow.entriesText}|${rate.catalogPaths}|${rate.rubrikText}|${rate.text}|${rate.flatrates_awSheetOID}|${rate.flatrates_number}|${rate.flatrates_text}`;
        } catch (error) {
          ignoredSqlErrors.push(`compararModelo seed UPDATE ignored: ${error instanceof Error ? error.message : String(error)}`);
        }
        nuevaLine = 0;
      }

      previous = next;
      if (laCondicionAdvance) {
        // These are exactly the rows selected by the last successfully built LaCondicionAdvance.
        const targets = advanceTargets;
        if (targets.length) {
          const column = nomCampos.find(field => sqlEquals(field.nomCampo, rate.typekeyIdEntriesId));
          if (column) {
            try {
              const value = enforceNchar(rate.flatrates_value, 10, `pivot.type_${column.nomCampo}`).trimEnd();
              for (const target of targets) target.values[column.nomCampo] = value;
            } catch (error) { ignoredSqlErrors.push(`compararModelo type UPDATE ignored: ${error instanceof Error ? error.message : String(error)}`); }
          }
        }
      }
    }
  }

  // codigoEstrujen updates workType from a fixed-offset Sonderausstattung token.
  for (const rate of rates) {
    if (rate.flatrates_validityExpression === "true") continue;
    const at = vbInStr(rate.flatrates_validityExpression, "SONDERAUSSTATTUNG");
    const equipment = vbMid(rate.flatrates_validityExpression, at + 19, 4);
    const workType = `${rate.flatrates_workType} ${equipment}`;
    for (const row of rows) {
      if (sqlEquals(row.typekeyIdEntriesId_flatrates_number ?? "", rate.flatrates_number) && sqlEquals(row.typekeyIdEntriesId_flatrates_awSheetOID ?? "", rate.flatrates_awSheetOID)) row.typekeyIdEntriesId_flatrates_workType = workType;
    }
  }

  return { rows, typekeys, ignoredSqlErrors, tableName };
}

function normalizeOperation(operation: string) {
  return operation.replace(/ /g, "").replace(/\)/g, "").replace(/ZAX/g, "").trimEnd();
}

export function legacyExcelRows(dda: DdaRecord[], pivot: PivotResult) {
  const grouped: Array<{ operation: string; count: number }> = [];
  for (const record of dda) {
    if (record.Operacion === null || sqlEquals(record.Operacion, "KN")) continue;
    const current = grouped.find(item => sqlEquals(item.operation, record.Operacion));
    if (current) current.count++;
    else grouped.push({ operation: record.Operacion, count: 1 });
  }
  const rows = dda.filter(record => record.Operacion !== null && !sqlEquals(record.Operacion, "KN") && grouped.find(item => sqlEquals(item.operation, record.Operacion))?.count === 1)
    .sort((a, b) => sqlSortLegacy(a.Operacion!, b.Operacion!));
  const excelTypekeys = pivot.typekeys.map(typekey => vbExcelCell(typekey));
  for (let index = 0; index < pivot.typekeys.length; index++) {
    const header = excelTypekeys[index];
    const lookup = `type_${header === null ? "" : String(header)}`;
    if (lookup !== `type_${pivot.typekeys[index]}`) throw new Error(`Legacy Excel fatal: typekey header '${pivot.typekeys[index]}' coerces to '${String(header)}'; pivot field '${lookup}' does not exist`);
  }
  return rows.map(record => {
    const operation = record.Operacion!.trim();
    const number = normalizeOperation(operation);
    const pivotRow = pivot.rows.find(row => sqlEquals(row.typekeyIdEntriesId_flatrates_number, number));
    const cells: Array<string | number | null> = [operation, record.Tiempo, null];
    for (const typekey of pivot.typekeys) {
      const original = pivotRow?.values[typekey] ?? null;
      cells.push(vbExcelCell(original));
    }
    const tipoCom = operation.includes("ZAX") ? 2 : operation.includes(")") ? 1 : 0;
    const red = pivot.typekeys.map((typekey, index) => {
      if (!pivotRow) return false;
      const bmw = pivotRow?.values[typekey] == null ? null : vbExcelCell(pivotRow.values[typekey]!);
      const ddaValue = record.Tiempo;
      if (tipoCom === 2) return bmw !== null && bmw !== "";
      const comparison = compareCell(ddaValue, bmw);
      return tipoCom === 1 ? comparison >= 0 : comparison !== 0;
    });
    return { operation, dda: record.Tiempo, cells, red, pivotFound: Boolean(pivotRow) };
  });
}

function compareCell(ddaValue: number | null, bmw: string | number | null) {
  if (typeof bmw === "string" && bmw !== "") {
    const converted = Number(bmw.replace(",", "."));
    bmw = Number.isFinite(converted) ? converted : bmw;
  }
  if (typeof bmw === "number") {
    const left = ddaValue ?? 0;
    return left === bmw ? 0 : left < bmw ? -1 : 1;
  }
  if (bmw === null) {
    const left = ddaValue ?? 0;
    return left === 0 ? 0 : left < 0 ? -1 : 1;
  }
  return -1;
}
