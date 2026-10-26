import { expect } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import ExcelJS from "exceljs";

const fixtures = join(import.meta.dir, "..", "fixtures", "e2e");

/**
 * Compares a value with tests/fixtures/e2e/<name>.json. Run with UPDATE_GOLDEN=1 to rewrite the file
 * after a deliberate behaviour change, and review the diff before committing it.
 */
export async function expectGolden(name: string, actual: unknown) {
  const path = join(fixtures, `${name}.json`);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === "1") {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    return;
  }
  expect(JSON.parse(text)).toEqual(JSON.parse(await readFile(path, "utf8")));
}

/** The comparison workbook as plain data: header row, then each row's values and its red cells (1-based column numbers). */
export async function readComparisonWorkbook(bytes: Uint8Array) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet("DDA contra BMW");
  if (!sheet) throw new Error("The workbook has no 'DDA contra BMW' sheet");
  const header = Array.from(sheet.getRow(3).values as unknown[]).slice(1).map(value => value ?? null);
  const rows: Array<{ values: unknown[]; red: number[] }> = [];
  for (let index = 4; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index);
    const red: number[] = [];
    for (let column = 1; column <= header.length; column++) {
      const fill = row.getCell(column).fill as { fgColor?: { argb?: string } } | undefined;
      if (fill?.fgColor?.argb === "FFFF0000") red.push(column);
    }
    rows.push({ values: header.map((_, column) => (row.getCell(column + 1).value as unknown) ?? null), red });
  }
  return { sheetName: sheet.name, header, rows };
}
