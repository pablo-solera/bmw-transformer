import { createHash } from "node:crypto";
import type { ReportInput } from "./types.js";

/** A load is identified by what it would write: the same typekeys, series, families and date. */
export function loadFingerprint(input: ReportInput) {
  const typekeys = input.typekeys.map(item => [item.typekey, item.baseType ?? "", item.series ?? input.series ?? "", item.family ?? input.family ?? ""].join("|")).sort();
  return createHash("sha256").update(JSON.stringify({ typekeys, date: input.date ?? "", brand: input.brand ?? "", model: input.model ?? "" })).digest("hex");
}
