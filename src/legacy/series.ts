export function normalizeLegacySeries(value: string): string {
  const normalized = value.replace(/'/g, "").trim();
  if (!normalized || normalized === "." || normalized === ".." || !/^[A-Za-z0-9 _.-]+$/.test(normalized)) {
    throw new Error("BMW series contains invalid S3 path characters");
  }
  return normalized;
}
