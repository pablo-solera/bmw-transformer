import { expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { importExtractedData } from "../src/pipeline/import-data.js";
import { buildLegacyPivot } from "../src/pipeline/pivot.js";

type CsvCell = { value: string; quoted: boolean };
function parseCsv(text: string): CsvCell[][] {
  const rows: CsvCell[][] = [];
  let row: CsvCell[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field.length === 0) { quoted = true; wasQuoted = true; }
    else if (c === ",") { row.push({ value: field, quoted: wasQuoted }); field = ""; wasQuoted = false; }
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push({ value: field, quoted: wasQuoted }); field = ""; wasQuoted = false;
      rows.push(row); row = [];
    } else field += c;
  }
  if (field.length || row.length || wasQuoted) { row.push({ value: field, quoted: wasQuoted }); rows.push(row); }
  return rows;
}

const csvPath = process.env.BMW_LEGACY_PIVOT_CSV;
if (csvPath) setDefaultTimeout(30 * 60 * 1000);
if (csvPath) test("legacy-equivalent pivot rows match the 11I_05/0 CSV multiset", async () => {
  const csv = parseCsv(await readFile(csvPath, "utf8"));
  expect(csv[0]).toHaveLength(23);
  const header = csv[0]!.map(cell => cell.value);
  const rows = csv.slice(1).filter(row => row.length === header.length);
  const legacyValues = rows.map(row => Object.fromEntries(header.map((name, index) => {
    let value: string | null = !row[index]!.quoted && row[index]!.value === "" ? null : row[index]!.value;
    if (name.startsWith("type_") && value?.startsWith("'-1")) value = value.slice(1);
    return [name, value];
  })));

  const input = { axCode: "11I", edition: "05_0", manufacturer: "BMW", series: "4", family: "G26", date: "20260928", group: "BMW", typekeys: ["11HC", "21HC", "23FB", "33FB", "41FR", "53FB", "61FR", "61HC"].map(typekey => ({ typekey })) };
  const imported = await importExtractedData(input);
  const pivotData = buildLegacyPivot(input, imported.catalog, imported.rates, imported.selectedTypekeys);
  expect(rows).toHaveLength(14834);
  expect(pivotData.rows).toHaveLength(14834);
  const legacyColumns = header.filter(name => !name.startsWith("type_"));
  const typekeys = header.filter(name => name.startsWith("type_")).map(name => name.slice(5));
  const normalize = (value: string | null | undefined) => value === null || value === undefined ? null : value.replace(/ +$/g, "").toLocaleLowerCase("en-US");
  const legacyKey = (row: Record<string, string | null>) => JSON.stringify([...legacyColumns.map(name => normalize(row[name])), ...typekeys.map(typekey => normalize(row[`type_${typekey}`]))]);
  const transformerKey = (row: typeof pivotData.rows[number]) => JSON.stringify([
    normalize(row.typekeyCatalog_id), normalize(row.typekeyCatalog_number), normalize(row.typekeyCatalog_text), normalize(row.typekeyCatalog_entriesId), normalize(row.typekeyCatalog_entriesNumber), normalize(row.typekeyCatalog_entriesText),
    normalize(row.typekeyIdEntriesId_catalogPaths), normalize(row.typekeyIdEntriesId_rubrikText), normalize(row.typekeyIdEntriesId_text), normalize(row.typekeyIdEntriesId_flatrates_awSheetOID), normalize(row.typekeyIdEntriesId_flatrates_number), normalize(row.typekeyIdEntriesId_flatrates_text), normalize(row.typekeyIdEntriesId_flatrates_workType), normalize(row.typekeyIdEntriesId_flatrates_klammerText), normalize(row.orderNumber),
    ...typekeys.map(typekey => normalize(row.values[typekey])),
  ]);
  const expectedCounts = new Map<string, number>();
  for (const row of legacyValues) {
    const key = legacyKey(row);
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  }
  const actualCounts = new Map<string, number>();
  for (const row of pivotData.rows) {
    const key = transformerKey(row);
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
  }
  expect(actualCounts).toEqual(expectedCounts);
});
else test.skip("legacy CSV pivot comparison", () => {});

test("CSV parser handles embedded line breaks and escaped quotes", () => {
  expect(parseCsv('a,b\r\n"two\nlines","with ""quote"""\r\n')).toEqual([[{ value: "a", quoted: false }, { value: "b", quoted: false }], [{ value: "two\nlines", quoted: true }, { value: 'with "quote"', quoted: true }]]);
});
