import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { parseInboundWorkbook, parseStocktakeWorkbook } from "../src/excel.ts";

const inbound = new ExcelJS.Workbook();
const inboundSheet = inbound.addWorksheet("入貨資料");
inboundSheet.addRow(["品牌", "味道", "產品名稱", "規格", "數量", "單位", "訂單編號", "主分類", "子分類", "每箱／包件數"]);
inboundSheet.addRow(["M&M'S", "牛奶朱古力", "家庭分享裝", "175.5g", 20, "箱／包", "TEST-ORDER-001", "零食", "朱古力", 12]);
const inboundFile = new File([await inbound.xlsx.writeBuffer()], "inbound.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
const inboundRows = await parseInboundWorkbook(inboundFile);
assert.equal(inboundRows.length, 1);
assert.equal(inboundRows[0].quantity, 20);
assert.equal(inboundRows[0].orderNumber, "TEST-ORDER-001");
assert.equal(inboundRows[0].packSize, 12);

const stocktake = new ExcelJS.Workbook();
const stocktakeSheet = stocktake.addWorksheet("Stock Take");
stocktakeSheet.addRow(["產品ID", "主分類", "子分類", "品牌", "味道", "產品名稱", "規格", "匯出時庫存", "盤點數量", "單位"]);
stocktakeSheet.addRow(["00000000-0000-0000-0000-000000000001", "零食", "朱古力", "M&M'S", "牛奶朱古力", "家庭分享裝", "175.5g", 20, 18, "件"]);
const meta = stocktake.addWorksheet("Stockcheck");
meta.addRows([["類型", "STOCKTAKE"], ["版本", "1"], ["店舖ID", "workspace-test"], ["匯出時間", "2026-08-14T00:00:00.000Z"]]);
const stocktakeFile = new File([await stocktake.xlsx.writeBuffer()], "stocktake.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
const parsedStocktake = await parseStocktakeWorkbook(stocktakeFile);
assert.equal(parsedStocktake.rows.length, 1);
assert.equal(parsedStocktake.rows[0].exportedQuantity, 20);
assert.equal(parsedStocktake.rows[0].countedQuantity, 18);
assert.equal(parsedStocktake.workspaceId, "workspace-test");

console.log("Excel import smoke test passed");
