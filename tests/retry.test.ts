import { expect, test } from "bun:test";
import { isTransientNetworkError, shouldRetry } from "../src/retry.js";

test("recognizes transient network failures, including wrapped ones", () => {
  expect(isTransientNetworkError(new Error("getaddrinfo ENOTFOUND s3-eu.solera.farm"))).toBe(true);
  expect(isTransientNetworkError(Object.assign(new Error("read failed"), { code: "ECONNRESET" }))).toBe(true);
  expect(isTransientNetworkError(new Error("outer", { cause: Object.assign(new Error("inner"), { code: "ETIMEDOUT" }) }))).toBe(true);
  expect(isTransientNetworkError(new Error("Unable to connect to the configured SQL Server (ETIMEOUT)"))).toBe(true);
  expect(isTransientNetworkError(Object.assign(new Error("aborted"), { name: "TimeoutError" }))).toBe(true);
});

test("does not retry data or validation errors", () => {
  expect(isTransientNetworkError(new Error("Ningún typekey de la carga tiene su marcador completed en S3"))).toBe(false);
  expect(isTransientNetworkError(new Error("Existing BMW labour table has an incompatible schema"))).toBe(false);
  expect(isTransientNetworkError(undefined)).toBe(false);
});

test("retries only while attempts remain", () => {
  const network = new Error("getaddrinfo ENOTFOUND host");
  expect(shouldRetry(network, 0, 3)).toBe(true);
  expect(shouldRetry(network, 1, 3)).toBe(true);
  expect(shouldRetry(network, 2, 3)).toBe(false);
  expect(shouldRetry(new Error("invalid data"), 0, 3)).toBe(false);
  expect(shouldRetry(network, 0, 1)).toBe(false);
});
