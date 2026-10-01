import { expect, test } from "bun:test";
import { openApiDocument } from "../src/openapi.js";

test("OpenAPI documents report status, download and source endpoints", () => {
  expect(Object.keys(openApiDocument.paths)).toEqual([
    "/health", "/reports", "/reports/{requestId}", "/reports/{requestId}/download", "/reports/{requestId}/source",
  ]);
});
