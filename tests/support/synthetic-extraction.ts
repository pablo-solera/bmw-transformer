import { normalizeLegacySeries } from "../../src/legacy/series.js";

/**
 * A tiny, fully synthetic extraction laid out exactly like the one bmw-reader writes to S3.
 * It contains no customer data and is designed so each legacy rule has a visible effect:
 * two typekeys of different families, a typekey with no completed marker, a SONDERAUSSTATTUNG
 * flatrate, a flatrate that only one typekey has, and LST rows for every comparison case.
 */
export const synthetic = {
  axCode: "1XF",
  edition: "05/0",
  group: "BMW",
  manufacturer: "BMW",
  date: "20261020",
  typekeys: [
    { typekey: "1A01", series: "7'", family: "G70" },
    { typekey: "2B02", series: "5'", family: "G60" },
  ],
  incomplete: { typekey: "3C03", series: "7'", family: "G70" },
} as const;

export type SyntheticObject = { parts: string[]; body: Uint8Array };

const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value, null, 2));

const flat = (overrides: { number: string; awSheetOID: string; text: string; value: string; workType?: string; validityExpression?: string }) => ({
  awSheetOID: overrides.awSheetOID,
  displayType: "",
  hasInklusivPositionen: "false",
  hasUmfasstTexte: "false",
  klammerText: "",
  lackFlaeche: "",
  lackStufe: "",
  lackwertMetallic: "0",
  lackwertUni: "0",
  number: overrides.number,
  ruestwert: "0",
  sonderAw: "",
  tcRelevant: "false",
  text: overrides.text,
  validFrom: "2020-01-01",
  validityExpression: overrides.validityExpression ?? "true",
  value: overrides.value,
  workType: overrides.workType ?? "R",
});

const group = (path: string, rubrikText: string, text: string, flatrates: ReturnType<typeof flat>[]) => ({
  catalogPaths: [path],
  containsValidityExpression: "false",
  klammerText: "",
  lackFlaeche: "",
  lackStufe: "",
  orderNumber: "A1",
  rubrikText,
  solrId: `solr-${path.length}`,
  sonderAw: "",
  text,
  valid: "true",
  flatrates,
});

const catalog = [
  { id: "G1", number: "11", text: "Motor", entries: [{ id: "E_01", number: "01", text: "Culata" }, { id: "E_02", number: "02", text: "Junta" }] },
  { id: "G2", number: "12", text: "Transmision", entries: [{ id: "E_03", number: "03", text: "Caja" }] },
];

/** Times per typekey: `null` means the typekey has no flatrate for that operation. */
const times: Record<string, Record<string, string | null>> = {
  "1A01": { "3310514": "12", "3310515": "3", "3320100": "5", "4112190": "20" },
  "2B02": { "3310514": "14", "3310515": "3", "3320100": "5", "4112190": null },
  "3C03": { "3310514": "99", "3310515": "99", "3320100": "99", "4112190": "99" },
};

function flatrateFiles(typekey: string) {
  const value = times[typekey]!;
  const rates = (number: string, awSheetOID: string, text: string, extra: { workType?: string; validityExpression?: string } = {}) =>
    value[number] === null ? [] : [flat({ number, awSheetOID, text, value: value[number]!, ...extra })];
  return {
    "11": { flatrateGroups: [
      group("Motor/Culata_01", "Culata", "Desmontar culata", [...rates("3310514", "AW001", "Cambiar culata"), ...rates("3310515", "AW002", "Revisar culata")]),
      group("Motor/Junta_02", "Junta", "Cambiar junta", rates("3320100", "AW003", "Cambiar junta", { validityExpression: "SONDERAUSSTATTUNG: S01A", workType: "S" })),
    ] },
    "12": { flatrateGroups: [
      group("Transmision/Caja_03", "Caja", "Revisar caja", rates("4112190", "AW004", "Revisar caja")),
    ] },
  };
}

function typekeyObjects(root: string[], typekey: string, withMarker: boolean): SyntheticObject[] {
  const objects: SyntheticObject[] = [{ parts: [...root, typekey, `${typekey}_catalog.json`], body: encode(catalog) }];
  for (const [hg, body] of Object.entries(flatrateFiles(typekey))) objects.push({ parts: [...root, typekey, hg, `${typekey}_${hg}.json`], body: encode(body) });
  if (withMarker) objects.push({ parts: [...root, typekey, `${typekey}_completed.json`], body: encode({ schemaVersion: 1, typekey, date: synthetic.date }) });
  return objects;
}

/** Every object of the synthetic extraction, with its key split into path parts (the storage prefix is added by the consumer). */
export function syntheticExtraction(): SyntheticObject[] {
  const rootFor = (item: { series: string; family: string }) => [synthetic.group, synthetic.manufacturer, "labour", normalizeLegacySeries(item.series), item.family, synthetic.date];
  return [
    ...synthetic.typekeys.flatMap(item => typekeyObjects(rootFor(item), item.typekey, true)),
    ...typekeyObjects(rootFor(synthetic.incomplete), synthetic.incomplete.typekey, false),
  ];
}

const qLine = (operation: string, time: number) => {
  const line = Array.from({ length: 120 }, () => " ");
  const put = (start: number, value: string) => value.split("").forEach((char, index) => { line[start + index] = char; });
  put(1, "AA");
  put(4, "L");
  put(6, "M");
  put(10, String(time).padStart(5, " "));
  put(16, operation.padEnd(12, " "));
  put(31, "Texto de prueba");
  return line.join("").trimEnd();
};

/** The LST rows and what the comparison is expected to do with each of them. */
export const syntheticListingRows: Array<{ operation: string; time: number; note: string }> = [
  { operation: "33 10 514", time: 12, note: "matches 1A01 (12) and differs from 2B02 (14)" },
  { operation: "33 10 515", time: 4, note: "differs from both typekeys (3)" },
  { operation: "33 20 100ZAX", time: 5, note: "ZAX: red wherever BMW has a value" },
  { operation: "41 12 190)", time: 25, note: "')' : red when DDA >= BMW; 2B02 has no value" },
  { operation: "99 99 999", time: 7, note: "no flatrate with that number" },
  { operation: "KN", time: 0, note: "ignored" },
  { operation: "77 70 700", time: 1, note: "duplicated, so ignored" },
  { operation: "77 70 700", time: 1, note: "duplicated, so ignored" },
];

export function syntheticListing(): Uint8Array {
  const lines = [
    "  OF DEVELOPMENT MASTER BMWDB BMW X5        DATE : 20.10.2026",
    "  P A R T - VERBUND - RECORD       ID = Q      (CPL. LISTING)",
    ...syntheticListingRows.map(row => qLine(row.operation, row.time)),
    "  RECORD-ID = U",
  ];
  return new TextEncoder().encode(lines.join("\r\n"));
}
