import type { ReportInput, StageCatalog, StageRate, TypekeyInput, CatalogEntry, FlatrateGroup, Flatrate } from "../types.js";
import { getBytes, listKeys } from "../storage.js";
import { objectKey } from "../storage.js";
import { parseLegacyJson } from "../legacy/vbjson.js";
import { assertUnescapedSqlValue, enforceNchar } from "../legacy/sqlserver.js";
import { vbLineInputLines, vbString } from "../legacy/vb.js";

type ImportedData = { catalog: StageCatalog[]; rates: StageRate[]; sources: Record<string, { prefix?: string; typekey: string; baseType: string; date?: string; completed: boolean }>; selectedTypekeys: string[] };

const getValue = (object: Record<string, unknown>, key: string) => Object.hasOwn(object, key) ? object[key] : undefined;
const safeSql = (value: string, field: string) => { assertUnescapedSqlValue(value, field); return value; };
let legacyCatalogPathsState = "";

async function resolvePrefix(input: ReportInput, item: TypekeyInput): Promise<{ prefix?: string; dateRoot?: string; date?: string; completed: boolean }> {
  const root = objectKey(input.group ?? "BMW", input.manufacturer, "labour", input.series, input.family);
  const prefix = `${root}/`;
  const keys = await listKeys(prefix);
  const markerSuffix = `/${item.typekey}/${item.typekey}_completed.json`;
  const dates = [...new Set(keys.flatMap(key => {
    const parts = key.split("/");
    const date = parts.at(-3);
    return key.endsWith(markerSuffix) && date && /^\d{8}$/.test(date) ? [date] : [];
  }))].sort().reverse();
  const selectedDate = input.date ? dates.find(date => date === input.date) : dates[0];
  if (!selectedDate) return { completed: false };
  return { prefix: `${root}/${selectedDate}/${item.typekey}`, dateRoot: `${root}/${selectedDate}`, date: selectedDate, completed: true };
}

function legacyReadText(bytes: Uint8Array): string {
  const decoded = new TextDecoder("windows-1252").decode(bytes);
  const lines = vbLineInputLines(decoded);
  let line = lines[0] ?? "";
  let accumulated = line;
  for (let i = 1; i < lines.length; i++) {
    line = lines[i]!;
    accumulated += line;
  }
  // typekeyCatalogRead passes `Linea` (the last Line Input value), not `aa`.
  // With the BMW fetcher's LF-only pretty JSON the entire file is one Line Input.
  return lines.length > 1 ? line : accumulated;
}

function legacyCatalogReadText(bytes: Uint8Array): string {
  const lines = vbLineInputLines(new TextDecoder("windows-1252").decode(bytes));
  if (lines.length <= 1) return lines[0] ?? "";
  // typekeysRead accumulates Linea into `aa` after reading the first line; the loop
  // appends the current line before fetching the next, duplicating line 1 and omitting the last.
  return `${lines[0]}${lines.slice(0, -1).join("")}`;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`VB6 runtime error 424 while reading ${label}: Object required`);
  return value as Record<string, unknown>;
}
function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`VB6 runtime error 424 while reading ${label}.Count: Object required`);
  return value;
}

const groupFields = ["containsValidityExpression", "klammerText", "lackFlaeche", "lackStufe", "orderNumber", "rubrikText", "solrId", "sonderAw", "text", "valid"] as const;
const flatFields = ["awSheetOID", "displayType", "hasInklusivPositionen", "hasUmfasstTexte", "klammerText", "lackFlaeche", "lackStufe", "lackwertMetallic", "lackwertUni", "number", "ruestwert", "sonderAw", "tcRelevant", "text", "validFrom", "validityExpression", "value", "workType"] as const;

function flatrateFields(flat: Flatrate): string[] {
  return flatFields.map(key => key === "displayType" ? "" : vbString(getValue(flat, key)));
}

async function readCatalog(prefix: string, baseType: string): Promise<CatalogEntry[]> {
  const key = `${prefix}/${baseType}_catalog.json`;
  const raw = legacyCatalogReadText(await getBytes(key));
  const value = parseLegacyJson<unknown>(raw);
  return asArray(value, `catalog ${key}`) as CatalogEntry[];
}

async function readGroups(prefix: string, typekey: string, hg: string): Promise<FlatrateGroup[]> {
  const key = `${prefix}/${typekey}/${hg}/${typekey}_${hg}.json`;
  const raw = legacyReadText(await getBytes(key));
  const value = parseLegacyJson<unknown>(raw);
  const object = asObject(value, `flatrate response ${key}`);
  return asArray(getValue(object, "flatrateGroups"), `flatrateGroups ${key}`) as FlatrateGroup[];
}

export async function importExtractedData(input: ReportInput, progress?: (value: number, stage: string) => Promise<void>): Promise<ImportedData> {
  const catalog: StageCatalog[] = [];
  const rates: StageRate[] = [];
  const sources: ImportedData["sources"] = {};
  const selectedTypekeys: string[] = [];
  let insertionOrder = 0;
  const resolved = await Promise.all(input.typekeys.map(async item => ({ item, location: await resolvePrefix(input, item) })));
  const total = resolved.length || 1;
  for (let index = 0; index < resolved.length; index++) {
    const { item, location } = resolved[index]!;
    await progress?.(Math.round(index / total * 20), `Resolviendo typekey ${item.typekey}`);
    sources[item.typekey] = { typekey: item.typekey, baseType: item.baseType ?? item.typekey, date: location.date, prefix: location.prefix, completed: location.completed };
    if (!location.completed || !location.prefix) continue;
    selectedTypekeys.push(item.typekey);
    const baseType = item.baseType ?? item.typekey;
    // typekeysRead reads {date}/{baseType}/{baseType}_catalog.json; later HG lookup
    // uses the same typekey directory (therefore a differing baseType can miss).
    const legacyCatalogPrefix = `${location.dateRoot}/${baseType}`;
    const pathKeys = await listKeys(`${location.dateRoot}/${baseType}/`);
    const catalogKey = `${legacyCatalogPrefix}/${baseType}_catalog.json`;
    if (!pathKeys.includes(catalogKey)) {
      // typekeysRead silently skips a missing catalog; typekeyCatalogRead then queries an empty staging table.
      await progress?.(Math.round((index + 1) / total * 20), `Catálogo ausente para ${item.typekey}`);
      continue;
    }
    const catalogEntries = await readCatalog(legacyCatalogPrefix, baseType);
    for (const top of catalogEntries) {
      const topObj = asObject(top as unknown, "catalog item");
      const entries = asArray(getValue(topObj, "entries"), "catalog.entries");
      for (const entry of entries) {
        const entryObj = asObject(entry, "catalog entry");
        const entryValues = [
          vbString(getValue(topObj, "id")), vbString(getValue(topObj, "number")), vbString(getValue(topObj, "text")),
          vbString(getValue(entryObj, "id")), vbString(getValue(entryObj, "number")), vbString(getValue(entryObj, "text")),
        ];
        // VB escapes only entriesText for this INSERT; other values are concatenated.
        safeSql(entryValues[0]!, "typekeyCatalog.id"); safeSql(entryValues[1]!, "typekeyCatalog.number"); safeSql(entryValues[2]!, "typekeyCatalog.text"); safeSql(entryValues[3]!, "typekeyCatalog.entriesId"); safeSql(entryValues[4]!, "typekeyCatalog.entriesNumber");
        safeSql(baseType, "typekeyCatalog.typekey");
        const row: StageCatalog = { typekey: enforceNchar(baseType, 10, "typekeyCatalog.typekey").trimEnd(), id: enforceNchar(entryValues[0]!, 35, "typekeyCatalog.id"), number: enforceNchar(entryValues[1]!, 10, "typekeyCatalog.number"), text: enforceNchar(entryValues[2]!, 70, "typekeyCatalog.text"), entriesId: enforceNchar(entryValues[3]!, 35, "typekeyCatalog.entriesId"), entriesNumber: enforceNchar(entryValues[4]!, 10, "typekeyCatalog.entriesNumber"), entriesText: entryValues[5]! };
        if (catalog.some(existing => existing.typekey.toLocaleLowerCase("en-US") === row.typekey.toLocaleLowerCase("en-US") && existing.entriesId.toLocaleLowerCase("en-US") === row.entriesId.toLocaleLowerCase("en-US"))) throw new Error(`Legacy SQL fatal: duplicate PK_typekeyCatalogd (${row.typekey}, ${row.entriesId})`);
        catalog.push(row);
      }
    }
    const matchingCatalogRows = catalog.filter(row => row.typekey.toLocaleLowerCase("en-US") === item.typekey.toLocaleLowerCase("en-US"));
    // typekeyCatalogRead only enumerates HGs for rows whose stored catalog.typekey equals the requested key.
    // A baseType mismatch therefore yields no HG lookup at all.
    const hgs = [...new Set(matchingCatalogRows.map(row => row.number.trimEnd()))];
    for (const hg of hgs) {
      const groups = await readGroups(location.dateRoot!, item.typekey, hg);
      for (const groupRaw of groups) {
        const group = asObject(groupRaw, "flatrateGroup");
        const paths = asArray(getValue(group, "catalogPaths"), "flatrateGroup.catalogPaths");
        for (const path of paths) legacyCatalogPathsState = vbString(path);
        const shared = groupFields.map(key => vbString(getValue(group, key)));
        const flatRates = asArray(getValue(group, "flatrates"), "flatrateGroup.flatrates") as Flatrate[];
        for (const flat of flatRates) {
        const fields = flatrateFields(asObject(flat, "flatrate"));
          const row: StageRate = {
            typekeyIdEntriesId: item.typekey, catalogPaths: safeSql(legacyCatalogPathsState, "catalogPaths"),
            containsValidityExpression: safeSql(shared[0]!, "containsValidityExpression"), klammerText: shared[1]!, lackFlaeche: shared[2]!, lackStufe: shared[3]!,
            orderNumber: safeSql(shared[4]!, "orderNumber"), rubrikText: shared[5]!, solrId: safeSql(shared[6]!, "solrId"), sonderAw: safeSql(shared[7]!, "sonderAw"), text: shared[8]!, valid: safeSql(shared[9]!, "valid"),
            flatrates_awSheetOID: safeSql(fields[0]!, "flatrates_awSheetOID"), flatrates_displayType: fields[1]!, flatrates_hasInklusivPositionen: safeSql(fields[2]!, "flatrates_hasInklusivPositionen"), flatrates_hasUmfasstTexte: safeSql(fields[3]!, "flatrates_hasUmfasstTexte"), flatrates_klammerText: fields[4]!, flatrates_lackFlaeche: safeSql(fields[5]!, "flatrates_lackFlaeche"), flatrates_lackStufe: safeSql(fields[6]!, "flatrates_lackStufe"), flatrates_lackwertMetallic: safeSql(fields[7]!, "flatrates_lackwertMetallic"), flatrates_lackwertUni: safeSql(fields[8]!, "flatrates_lackwertUni"), flatrates_number: safeSql(fields[9]!, "flatrates_number"), flatrates_ruestwert: safeSql(fields[10]!, "flatrates_ruestwert"), flatrates_sonderAw: safeSql(fields[11]!, "flatrates_sonderAw"), flatrates_tcRelevant: safeSql(fields[12]!, "flatrates_tcRelevant"), flatrates_text: fields[13]!, flatrates_validFrom: safeSql(fields[14]!, "flatrates_validFrom"), flatrates_validityExpression: safeSql(fields[15]!, "flatrates_validityExpression"), flatrates_value: safeSql(fields[16]!, "flatrates_value"), flatrates_workType: safeSql(fields[17]!, "flatrates_workType"), insertionOrder: insertionOrder++, sourceHg: hg,
          };
          rates.push(row);
        }
      }
    }
  }
  await progress?.(20, "Importación de catálogo y flatrates completada");
  return { catalog, rates, sources, selectedTypekeys };
}
