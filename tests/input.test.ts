import { expect, test } from "bun:test";
import { requestSeries, typekeyFamily, typekeySeries } from "../src/pipeline/input.js";
import type { ReportInput } from "../src/types.js";

const base: ReportInput = { axCode: "1XF", edition: "05/0", manufacturer: "BMW", typekeys: [{ typekey: "11EH", series: "7'", family: "G70" }, { typekey: "6J92", series: "6'", family: "F13" }] };

test("each typekey resolves its own series and family before the request-level fallback", () => {
  expect(typekeySeries(base, base.typekeys[0]!)).toBe("7'");
  expect(typekeyFamily(base, base.typekeys[1]!)).toBe("F13");
  const fallback: ReportInput = { ...base, series: "4", family: "G26", typekeys: [{ typekey: "11HC" }] };
  expect(typekeySeries(fallback, fallback.typekeys[0]!)).toBe("4");
  expect(typekeyFamily(fallback, fallback.typekeys[0]!)).toBe("G26");
});

test("a typekey without series or family anywhere is rejected", () => {
  const input: ReportInput = { axCode: "1XF", edition: "05/0", manufacturer: "BMW", typekeys: [{ typekey: "11HC" }] };
  expect(() => typekeySeries(input, input.typekeys[0]!)).toThrow("Typekey 11HC has no series");
  expect(() => typekeyFamily(input, input.typekeys[0]!)).toThrow("Typekey 11HC has no family");
  expect(() => requestSeries({ ...input, typekeys: [] })).toThrow("no series");
});

test("the table-level model falls back to the first typekey's series", () => {
  expect(requestSeries(base)).toBe("7'");
  expect(requestSeries({ ...base, series: "4" })).toBe("4");
});
