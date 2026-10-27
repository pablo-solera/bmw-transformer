import { expect, test } from "bun:test";
import { loadFingerprint } from "../src/load-fingerprint.js";
import type { ReportInput } from "../src/types.js";

const base: ReportInput = { axCode: "1XF", edition: "05/0", manufacturer: "BMW", brand: "BMW", model: "7", series: "7'", family: "G70", typekeys: [{ typekey: "11EH" }, { typekey: "21EH" }] };

test("the same load has the same fingerprint regardless of typekey order and inherited series", () => {
  const reordered: ReportInput = { ...base, typekeys: [{ typekey: "21EH", series: "7'", family: "G70" }, { typekey: "11EH", series: "7'", family: "G70" }] };
  expect(loadFingerprint(reordered)).toBe(loadFingerprint(base));
});

test("a different typekey set, family, date or base type changes the fingerprint", () => {
  const original = loadFingerprint(base);
  expect(loadFingerprint({ ...base, typekeys: [{ typekey: "11EH" }] })).not.toBe(original);
  expect(loadFingerprint({ ...base, typekeys: [{ typekey: "11EH", family: "G71" }, { typekey: "21EH" }] })).not.toBe(original);
  expect(loadFingerprint({ ...base, date: "20261022" })).not.toBe(original);
  expect(loadFingerprint({ ...base, typekeys: [{ typekey: "11EH", baseType: "11EG" }, { typekey: "21EH" }] })).not.toBe(original);
});

test("a per-typekey date makes a different load", () => {
  const dated: ReportInput = { ...base, typekeys: [{ typekey: "11EH", date: "20261020" }, { typekey: "21EH" }] };
  expect(loadFingerprint(dated)).not.toBe(loadFingerprint(base));
  expect(loadFingerprint({ ...dated, typekeys: [{ typekey: "21EH" }, { typekey: "11EH", date: "20261020" }] })).toBe(loadFingerprint(dated));
});
