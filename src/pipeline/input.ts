import type { ReportInput, TypekeyInput } from "../types.js";

export function typekeySeries(input: ReportInput, item: TypekeyInput): string {
  const series = item.series ?? input.series;
  if (!series) throw new Error(`Typekey ${item.typekey} has no series`);
  return series;
}

export function typekeyFamily(input: ReportInput, item: TypekeyInput): string {
  const family = item.family ?? input.family;
  if (!family) throw new Error(`Typekey ${item.typekey} has no family`);
  return family;
}

/** Series used for the table-level model name (nomCamposTabla.Model). */
export function requestSeries(input: ReportInput): string {
  const series = input.series ?? input.typekeys[0]?.series;
  if (!series) throw new Error("The request has no series");
  return series;
}
