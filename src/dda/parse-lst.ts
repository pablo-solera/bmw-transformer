import { unzipSync } from "fflate";
import type { DdaRecord, MasterListing, MasterHeader } from "../types.js";

const minLineLength = 113;
const field = (line: string, start: number, length: number): string | null => {
  if (start >= line.length) return null;
  const value = line.slice(start, Math.min(start + length, line.length)).trim();
  return value || null;
};
const marker = (line: string) => /ID\s*=\s*\S/.test(line);

function parseHeader(lines: string[], sourceFile: string): MasterHeader {
  const banner = lines.find(line => /OF DEVELOPMENT MASTER/i.test(line));
  if (!banner) return { baseDatos: null, manufacturer: null, model: null, date: null, sourceFile };
  const index = banner.toUpperCase().indexOf("OF DEVELOPMENT MASTER");
  const tokens = banner.slice(index + "OF DEVELOPMENT MASTER".length).split(/\s+/).filter(Boolean);
  const date = banner.match(/DATE\s*:\s*(\d{2}\.\d{2}\.\d{4})/i)?.[1] ?? null;
  return { baseDatos: tokens[0] ?? null, manufacturer: tokens[1] ?? null, model: tokens[2] ?? null, date, sourceFile };
}

/** Port of feat/acciona-refactor-dotnet:infrastructure/Verbund/LstVerbundListingParser.cs */
export function parseMasterListingBytes(bytes: Uint8Array, sourceFile: string): MasterListing {
  const lines = Array.from({ length: bytes.length }, (_, index) => String.fromCharCode(bytes[index]!)).join("").split(/\r\n|\r|\n/);
  const header = parseHeader(lines, sourceFile);
  const records: Array<Record<string, string | number | null>> = [];
  const start = lines.findIndex(line => line.includes("ID = Q") && line.includes("P A R T"));
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const raw = lines[i]!;
      if (marker(raw)) break;
      const trimmed = raw.trimStart();
      if (!raw.trim() || trimmed.startsWith("L I S T I N G") || trimmed.startsWith("CLIENT:") || trimmed.startsWith("VB S A") || trimmed.startsWith("CO I C") || raw.includes("P A R T")) continue;
      const line = raw.length < minLineLength ? raw.padEnd(minLineLength) : raw;
      const wu = field(line, 10, 5);
      const parsedWu = wu !== null && /^[-+]?\d+$/.test(wu) ? Number(wu) : null;
      records.push({
        verbund: field(line, 1, 2), side: field(line, 4, 1), aggregat: field(line, 6, 1), tiempo: parsedWu,
        operacion: field(line, 16, 10), kl: field(line, 29, 1), texto: field(line, 31, 41), baugrupen: field(line, 72, 5),
        auto_1: field(line, 77, 3), auto_2: field(line, 80, 3), text_long: field(line, 83, 5),
        containing_verbund: field(line, 88, 16), special_time: field(line, 104, 3), ut: field(line, 108, 2), av: field(line, 110, 3),
      });
    }
  }
  return { header, blocks: { Q: records } };
}

export function extractLstUpload(bytes: Uint8Array, filename: string): { bytes: Uint8Array; filename: string } {
  if (/\.lst$/i.test(filename)) return { bytes, filename };
  if (!/\.zip$/i.test(filename)) throw new Error("El fichero debe ser .LST o .ZIP con un único .LST");
  const entries = unzipSync(bytes);
  const listingEntries = Object.entries(entries).filter(([name, content]) => /\.lst$/i.test(name) && content.length > 0);
  if (listingEntries.length !== 1) throw new Error("El ZIP debe contener exactamente un fichero .LST no vacío");
  return { bytes: listingEntries[0]![1], filename: listingEntries[0]![0].split(/[\\/]/).pop() ?? "listing.lst" };
}

export function toDdaRecords(listing: MasterListing): DdaRecord[] {
  return listing.blocks.Q.map((record, index) => ({
    Operacion: record.operacion == null ? null : String(record.operacion),
    Tiempo: typeof record.tiempo === "number" ? record.tiempo : null,
    id: index + 1,
  }));
}
