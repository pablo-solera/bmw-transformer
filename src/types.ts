export type TypekeyInput = { typekey: string; baseType?: string };

export type ReportInput = {
  axCode: string;
  edition: string;
  manufacturer: string;
  series: string;
  family: string;
  date?: string;
  group?: string;
  sourceFilename?: string;
  typekeys: TypekeyInput[];
};

export type ReportStatus = "queued" | "resolving" | "importing" | "pivoting" | "parsing-dda" | "reporting" | "completed" | "failed";

export type ReportState = {
  requestId: string;
  status: ReportStatus;
  stage: string;
  progress: number;
  input: ReportInput;
  reportKey?: string;
  summary?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type CatalogEntry = { id?: unknown; number?: unknown; text?: unknown; entries?: CatalogEntry[] };
export type Flatrate = Record<string, unknown>;
export type FlatrateGroup = Record<string, unknown> & { catalogPaths?: unknown[]; flatrates?: Flatrate[] };
export type StageCatalog = {
  typekey: string;
  id: string;
  number: string;
  text: string;
  entriesId: string;
  entriesNumber: string;
  entriesText: string;
};
export type StageRate = {
  typekeyIdEntriesId: string;
  catalogPaths: string;
  containsValidityExpression: string;
  klammerText: string;
  lackFlaeche: string;
  lackStufe: string;
  orderNumber: string;
  rubrikText: string;
  solrId: string;
  sonderAw: string;
  text: string;
  valid: string;
  flatrates_awSheetOID: string;
  flatrates_displayType: string;
  flatrates_hasInklusivPositionen: string;
  flatrates_hasUmfasstTexte: string;
  flatrates_klammerText: string;
  flatrates_lackFlaeche: string;
  flatrates_lackStufe: string;
  flatrates_lackwertMetallic: string;
  flatrates_lackwertUni: string;
  flatrates_number: string;
  flatrates_ruestwert: string;
  flatrates_sonderAw: string;
  flatrates_tcRelevant: string;
  flatrates_text: string;
  flatrates_validFrom: string;
  flatrates_validityExpression: string;
  flatrates_value: string;
  flatrates_workType: string;
  insertionOrder: number;
  sourceHg?: string;
};

export type DdaRecord = { Operacion: string | null; Tiempo: number | null; id: number };
export type MasterHeader = { baseDatos: string | null; manufacturer: string | null; model: string | null; date: string | null; sourceFile: string };
export type MasterListing = { header: MasterHeader; blocks: { Q: Array<Record<string, string | number | null>> } };
