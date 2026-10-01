import { expect, test } from "bun:test";
import { openApiDocument } from "../src/openapi.js";
import { app } from "../src/app.js";

test("OpenAPI documents report status, download and source endpoints", () => {
  expect(Object.keys(openApiDocument.paths)).toEqual([
    "/health", "/openapi.json", "/docs", "/reports", "/reports/{requestId}", "/reports/{requestId}/download", "/reports/{requestId}/source",
  ]);
});

test("OpenAPI exposes a multipart file picker and serialized metadata field", () => {
  const operation = openApiDocument.paths["/reports"].post;
  const multipart = operation.requestBody.content["multipart/form-data"];
  expect(operation.requestBody.required).toBe(true);
  expect(multipart.schema.required).toEqual(["file", "metadata"]);
  expect(multipart.schema.properties.file).toMatchObject({ type: "string", format: "binary" });
  expect(multipart.schema.properties.metadata).toMatchObject({ type: "string" });
  const example = JSON.parse(multipart.schema.properties.metadata.example) as { axCode: string; typekeys: Array<{ typekey: string }> };
  expect(example.axCode).toBe("11I");
  expect(example.typekeys[0]?.typekey).toBe("11HC");
  expect(openApiDocument.servers).toEqual([{ url: "/", description: "Mismo origen desde el que se sirve Swagger UI" }]);
});

test("every OpenAPI path parameter is declared and every documented path has a handler path", () => {
  const paths = Object.keys(openApiDocument.paths);
  const parameterized = paths.filter(path => path.includes("{requestId}"));
  expect(parameterized).toEqual([
    "/reports/{requestId}", "/reports/{requestId}/download", "/reports/{requestId}/source",
  ]);
  for (const path of parameterized) {
    const methods = Object.values(openApiDocument.paths[path as keyof typeof openApiDocument.paths]);
    for (const operation of methods) {
      expect((operation.parameters as Array<{in: string; name: string; required: boolean}> | undefined)?.some(parameter => parameter.in === "path" && parameter.name === "requestId" && parameter.required)).toBe(true);
    }
  }
});

test("Express routes and OpenAPI paths stay in sync", () => {
  const expressPaths = (app.router.stack as Array<{ route?: { path?: string } }>)
    .flatMap(layer => layer.route?.path ? [layer.route.path] : [])
    .sort();
  const specPaths = Object.keys(openApiDocument.paths).map(path => path.replace("{requestId}", ":requestId")).sort();
  expect(expressPaths).toEqual(specPaths);
});
