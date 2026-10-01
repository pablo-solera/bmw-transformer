import ExcelJS from "exceljs";
import type { PivotResult } from "../pipeline/pivot.js";
import { vbExcelCell } from "../legacy/vb.js";

export type ReportRow = { operation: string; dda: number | null; cells: Array<string | number | null>; red: boolean[]; pivotFound: boolean };

export async function buildLegacyWorkbook(rows: ReportRow[], pivot: PivotResult): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("DDA contra BMW");
  sheet.addRow([]);
  sheet.addRow([]);
  const typekeys = [...new Set(pivot.typekeys)];
  sheet.addRow(["Nº Operacion", "DDA", "", ...typekeys.map(typekey => vbExcelCell(typekey))]);
  sheet.getCell(3, 1).font = { size: 12 };
  sheet.getCell(3, 2).font = { size: 12 };
  for (let index = 4; index <= typekeys.length + 3; index++) sheet.getCell(3, index).font = { size: 12 };
  for (const item of rows) {
    const row = sheet.addRow(item.cells);
    item.red.forEach((red, index) => {
      if (red) row.getCell(index + 4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF0000" } };
    });
  }
  const columnCount = typekeys.length + 3;
  // VB6 left Excel's default column widths unchanged.
  for (let rowIndex = 3; rowIndex <= sheet.rowCount; rowIndex++) {
    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex++) sheet.getCell(rowIndex, columnIndex).font = { name: "Aptos Narrow", size: 11 };
  }
  sheet.getCell(3, 1).font = { name: "Aptos Narrow", size: 12 };
  sheet.getCell(3, 2).font = { name: "Aptos Narrow", size: 12 };
  for (let columnIndex = 4; columnIndex <= columnCount; columnIndex++) sheet.getCell(3, columnIndex).font = { name: "Aptos Narrow", size: 12 };
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}
