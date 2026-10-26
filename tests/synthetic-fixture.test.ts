import { expect, test } from "bun:test";
import { parseMasterListingBytes, toDdaRecords } from "../src/dda/parse-lst.js";
import { synthetic, syntheticExtraction, syntheticListing, syntheticListingRows } from "./support/synthetic-extraction.js";

test("the synthetic LST parses into the operations and times it was built from", () => {
  const listing = parseMasterListingBytes(syntheticListing(), "synthetic.lst");
  expect(listing.header).toMatchObject({ baseDatos: "BMWDB", manufacturer: "BMW", model: "X5", date: "20.10.2026" });
  expect(toDdaRecords(listing).map(row => [row.Operacion, row.Tiempo])).toEqual(syntheticListingRows.map(row => [row.operation, row.time]));
});

test("the synthetic extraction uses the reader's S3 layout and marks only the completed typekeys", () => {
  const keys = syntheticExtraction().map(item => item.parts.join("/"));
  const root = (series: string, family: string) => `BMW/BMW/labour/${series}/${family}/${synthetic.date}`;

  for (const [series, family, typekey] of [["7", "G70", "1A01"], ["5", "G60", "2B02"]] as const) {
    expect(keys).toContain(`${root(series, family)}/${typekey}/${typekey}_completed.json`);
    expect(keys).toContain(`${root(series, family)}/${typekey}/${typekey}_catalog.json`);
    expect(keys).toContain(`${root(series, family)}/${typekey}/11/${typekey}_11.json`);
    expect(keys).toContain(`${root(series, family)}/${typekey}/12/${typekey}_12.json`);
  }
  expect(keys.some(key => key.includes("3C03/3C03_completed.json"))).toBe(false);
  expect(keys.some(key => key.includes("3C03/3C03_catalog.json"))).toBe(true);
});
