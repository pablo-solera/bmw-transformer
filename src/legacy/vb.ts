import { config } from "../config.js";

export const vbTrim = (value: string) => value.replace(/^ +| +$/g, "");

export function vbString(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) throw new Error("VB6 runtime error 94: Invalid use of Null while assigning a JSON field to String");
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return vbDecimalString(value);
  return String(value);
}

export function vbDecimalString(value: number): string {
  return new Intl.NumberFormat(config.LEGACY_LOCALE, { useGrouping: false, maximumFractionDigits: 28 }).format(value);
}

/** Emulates CDec's es-ES interpretation of unquoted numeric JSON tokens. */
export function vbCDec(value: string): number {
  const text = vbTrim(value);
  if (!text) throw new Error("VB6 runtime error 13: Type mismatch in CDec");
  const decimalSeparator = config.LEGACY_LOCALE.toLowerCase().startsWith("es") ? "," : ".";
  const groupSeparator = decimalSeparator === "," ? "." : ",";
  let normalized = text.replace(new RegExp(`\\${groupSeparator}`, "g"), "");
  if (decimalSeparator !== ".") normalized = normalized.replace(decimalSeparator, ".");
  const number = Number(normalized);
  if (!Number.isFinite(number)) throw new Error(`VB6 runtime error 13: Type mismatch in CDec(${text})`);
  return number;
}

export function vbMid(value: string, start: number, length?: number): string {
  if (start < 1) throw new Error("VB6 runtime error 5: Invalid procedure call or argument in Mid");
  return value.slice(start - 1, length === undefined ? undefined : start - 1 + length);
}

export function vbInStr(value: string, needle: string): number {
  return value.indexOf(needle) + 1;
}

export function vbLineInputLines(value: string): string[] {
  // VB6 Line Input stops at CR or CRLF; a lone LF stays in the same input line.
  return value.split(/\r\n|\r/);
}

export function vbExcelCell(value: unknown): string | number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const text = String(value).trim();
  if (!text) return null;
  const decimalSeparator = config.LEGACY_LOCALE.toLowerCase().startsWith("es") ? "," : ".";
  const groupSeparator = decimalSeparator === "," ? "." : ",";
  const normalized = text.replace(new RegExp(`\\${groupSeparator}`, "g"), "").replace(decimalSeparator, ".");
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
    const number = Number(normalized);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

export function vbVariantCompare(left: string | number | null, right: string | number | null): number {
  const a = left === null ? 0 : left;
  const b = right === null ? 0 : right;
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "number" || typeof b === "number") return typeof a === "number" ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}
