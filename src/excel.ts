export type ExcelInventoryItem = {
  id: string;
  category: string;
  subcategory: string;
  brand: string;
  flavor: string;
  name: string;
  spec: string;
  unit: string;
  pack_size: number;
  current_qty: number;
};

export type InboundExcelRow = {
  rowNumber: number;
  brand: string;
  flavor: string;
  name: string;
  spec: string;
  quantity: number;
  unit: string;
  orderNumber: string;
  category: string;
  subcategory: string;
  packSize: number;
};

export type StocktakeExcelRow = {
  rowNumber: number;
  productId: string;
  exportedQuantity: number;
  countedQuantity: number;
  unit: string;
};

const inboundHeaders = ["品牌", "味道", "產品名稱", "規格", "數量", "單位", "訂單編號", "主分類", "子分類", "每箱／包件數"];
const stocktakeHeaders = ["產品ID", "主分類", "子分類", "品牌", "味道", "產品名稱", "規格", "匯出時庫存", "盤點數量", "單位"];

const safeFilename = (value: string) => value.replace(/[\\/:*?"<>|]/g, "-").trim() || "Stockcheck";
const cellText = (cell: { text: string }) => cell.text.trim();
const cellInteger = (cell: { value: unknown; text: string }, fallback = 0) => {
  const value = typeof cell.value === "number" ? cell.value : Number(cell.text.trim());
  return Number.isInteger(value) ? value : fallback;
};

async function createWorkbook() {
  const ExcelJS = (await import("exceljs")).default;
  return new ExcelJS.Workbook();
}

function styleWorksheet(sheet: import("exceljs").Worksheet, widths: number[]) {
  const header = sheet.getRow(1);
  header.height = 28;
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF123E34" } };
  header.alignment = { vertical: "middle", horizontal: "center" };
  header.eachCell((cell) => { cell.border = { bottom: { style: "thin", color: { argb: "FF3BD2A2" } } }; });
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: widths.length } };
}

async function downloadWorkbook(workbook: import("exceljs").Workbook, filename: string) {
  const data = await workbook.xlsx.writeBuffer();
  const blob = new Blob([data as ArrayBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function buildInboundWorkbook() {
  const workbook = await createWorkbook();
  workbook.creator = "Stockcheck";
  const sheet = workbook.addWorksheet("入貨資料");
  sheet.addRow(inboundHeaders);
  for (let row = 2; row <= 31; row++) {
    sheet.getCell(row, 5).numFmt = "0";
    sheet.getCell(row, 10).numFmt = "0";
    sheet.getCell(row, 6).dataValidation = { type: "list", allowBlank: true, formulae: ['"箱／包,件"'] };
  }
  styleWorksheet(sheet, [16, 18, 28, 16, 10, 12, 20, 16, 16, 16]);
  const guide = workbook.addWorksheet("填寫說明");
  guide.addRows([
    ["Stockcheck AI 入貨 Excel"],
    ["每張訂單使用一個新檔案。AI 只需填寫「入貨資料」，產品 ID 由 Stockcheck Import 時配對。"],
    ["必填", "產品名稱、數量、單位、訂單編號"],
    ["單位", "整箱／整包訂貨請填「箱／包」；逐件數量請填「件」。"],
    ["新產品", "如屬陌生產品，請盡量填品牌、味道、主分類、子分類及每箱／包件數。"],
    ["注意", "數量只可使用大過 0 的整數；同一訂單不可重複匯入同一產品。"],
  ]);
  guide.getColumn(1).width = 16; guide.getColumn(2).width = 80; guide.getRow(1).font = { bold: true, size: 16, color: { argb: "FF123E34" } };
  return workbook;
}

export async function downloadInboundTemplate(workspaceName: string) {
  await downloadWorkbook(await buildInboundWorkbook(), `${safeFilename(workspaceName)}_AI入貨範本.xlsx`);
}

export async function buildStocktakeWorkbook(items: ExcelInventoryItem[], workspaceId: string) {
  const workbook = await createWorkbook();
  workbook.creator = "Stockcheck";
  const sheet = workbook.addWorksheet("Stock Take");
  sheet.addRow(stocktakeHeaders);
  items.forEach((item) => sheet.addRow([item.id, item.category, item.subcategory, item.brand, item.flavor, item.name, item.spec, item.current_qty, "", item.unit]));
  styleWorksheet(sheet, [38, 16, 16, 18, 20, 30, 18, 14, 14, 12]);
  sheet.getColumn(1).hidden = true;
  sheet.getColumn(8).numFmt = "0"; sheet.getColumn(9).numFmt = "0";
  sheet.getColumn(9).eachCell((cell, row) => { if (row > 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } }; });
  const meta = workbook.addWorksheet("Stockcheck");
  meta.addRows([["類型", "STOCKTAKE"], ["版本", "1"], ["店舖ID", workspaceId], ["匯出時間", new Date().toISOString()]]);
  meta.state = "veryHidden";
  return workbook;
}

export async function downloadStocktakeWorkbook(items: ExcelInventoryItem[], workspaceName: string, workspaceId: string, date: string) {
  await downloadWorkbook(await buildStocktakeWorkbook(items, workspaceId), `${safeFilename(workspaceName)}_StockTake_${date}.xlsx`);
}

function headerMap(sheet: import("exceljs").Worksheet) {
  const result = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => result.set(cellText(cell), column));
  return result;
}

const requireHeaders = (headers: Map<string, number>, required: string[]) => {
  const missing = required.filter((header) => !headers.has(header));
  if (missing.length) throw new Error(`Excel 缺少欄位：${missing.join("、")}`);
};

export async function parseInboundWorkbook(file: File) {
  const workbook = await createWorkbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.getWorksheet("入貨資料") ?? workbook.worksheets[0];
  if (!sheet) throw new Error("Excel 入面未有工作表");
  const headers = headerMap(sheet);
  requireHeaders(headers, ["產品名稱", "數量", "單位", "訂單編號"]);
  const at = (row: import("exceljs").Row, name: string) => row.getCell(headers.get(name) ?? 9999);
  const rows: InboundExcelRow[] = [];
  for (let index = 2; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index); const name = cellText(at(row, "產品名稱"));
    if (!name && !cellText(at(row, "品牌")) && !cellText(at(row, "味道"))) continue;
    const quantity = cellInteger(at(row, "數量"), -1);
    rows.push({ rowNumber: index, brand: cellText(at(row, "品牌")), flavor: cellText(at(row, "味道")), name, spec: cellText(at(row, "規格")), quantity, unit: cellText(at(row, "單位")), orderNumber: cellText(at(row, "訂單編號")), category: cellText(at(row, "主分類")), subcategory: cellText(at(row, "子分類")), packSize: cellInteger(at(row, "每箱／包件數"), 1) });
  }
  if (!rows.length) throw new Error("Excel 未有可匯入嘅產品資料");
  return rows;
}

export async function parseStocktakeWorkbook(file: File) {
  const workbook = await createWorkbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.getWorksheet("Stock Take") ?? workbook.worksheets[0];
  if (!sheet) throw new Error("Excel 入面未有工作表");
  const headers = headerMap(sheet);
  requireHeaders(headers, ["產品ID", "匯出時庫存", "盤點數量", "單位"]);
  const at = (row: import("exceljs").Row, name: string) => row.getCell(headers.get(name) ?? 9999);
  const rows: StocktakeExcelRow[] = [];
  for (let index = 2; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index); const countedText = cellText(at(row, "盤點數量"));
    if (countedText === "") continue;
    rows.push({ rowNumber: index, productId: cellText(at(row, "產品ID")), exportedQuantity: cellInteger(at(row, "匯出時庫存"), -1), countedQuantity: cellInteger(at(row, "盤點數量"), -1), unit: cellText(at(row, "單位")) });
  }
  if (!rows.length) throw new Error("未填寫任何盤點數量");
  const meta = workbook.getWorksheet("Stockcheck");
  return { rows, workspaceId: meta?.getCell("B3").text.trim() ?? "", exportedAt: meta?.getCell("B4").text.trim() ?? "" };
}
