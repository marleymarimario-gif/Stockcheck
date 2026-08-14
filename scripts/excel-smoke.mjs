import assert from "node:assert/strict";
import { buildInboundWorkbook, buildStocktakeWorkbook, parseInboundWorkbook, parseStocktakeWorkbook } from "../src/excel.ts";

const inbound = await buildInboundWorkbook();
const inboundSheet = inbound.getWorksheet("入貨資料");
assert.ok(inboundSheet);
inboundSheet.addRow(["M&M'S", "牛奶朱古力", "家庭分享裝", "175.5g", 20, "箱／包", "TEST-ORDER-001", "零食", "朱古力", 12]);
const inboundFile = new File([await inbound.xlsx.writeBuffer()], "inbound.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
const inboundRows = await parseInboundWorkbook(inboundFile);
assert.equal(inboundRows.length, 1);
assert.equal(inboundRows[0].quantity, 20);
assert.equal(inboundRows[0].orderNumber, "TEST-ORDER-001");
assert.equal(inboundRows[0].packSize, 12);

const stocktake = await buildStocktakeWorkbook([{ id: "00000000-0000-0000-0000-000000000001", category: "零食", subcategory: "朱古力", brand: "M&M'S", flavor: "牛奶朱古力", name: "家庭分享裝", spec: "175.5g", unit: "件", pack_size: 12, current_qty: 20 }], "workspace-test");
const stocktakeSheet = stocktake.getWorksheet("Stock Take");
assert.ok(stocktakeSheet);
stocktakeSheet.getCell("I2").value = 18;
const stocktakeFile = new File([await stocktake.xlsx.writeBuffer()], "stocktake.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
const parsedStocktake = await parseStocktakeWorkbook(stocktakeFile);
assert.equal(parsedStocktake.rows.length, 1);
assert.equal(parsedStocktake.rows[0].exportedQuantity, 20);
assert.equal(parsedStocktake.rows[0].countedQuantity, 18);
assert.equal(parsedStocktake.workspaceId, "workspace-test");

console.log("Excel import smoke test passed");
