import ExcelJS from 'exceljs';
import { fromScaledQty, paisaToRupees } from '../lib/units.js';
import { getOutstandingReport } from './receivables.js';

const REPORT_ROLES = ['admin', 'auditor', 'owner'];

// ─── helpers ────────────────────────────────────────────────────────────────

function dateWhere(alias, from, to) {
  const clauses = [];
  const params = [];
  if (from) { clauses.push(`date(${alias}) >= date(?)`); params.push(from); }
  if (to)   { clauses.push(`date(${alias}) <= date(?)`); params.push(to); }
  return { clauses, params };
}

function toCsv(rows, columns) {
  if (!rows.length) return columns.join(',') + '\n';
  const header = columns.join(',');
  const data = rows.map((r) =>
    columns.map((c) => {
      const v = r[c];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    }).join(',')
  );
  return [header, ...data].join('\n') + '\n';
}

async function toXlsx(rows, columns, sheetName = 'Report') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns.map((k) => ({ header: k, key: k, width: Math.min(30, Math.max(10, k.length + 4)) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6E4F0' } };
  for (const row of rows) ws.addRow(row);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function toCsvResponse(res, rows, columns, filename) {
  const csv = toCsv(rows, columns);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send(csv);
}

async function toXlsxResponse(res, rows, columns, filename, sheetName) {
  const buf = await toXlsx(rows, columns, sheetName);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
}

// ─── individual reports ──────────────────────────────────────────────────────

export function salesRegister(db, { from, to, customerId } = {}) {
  const { clauses, params } = dateWhere('i.invoice_date', from, to);
  const extraClauses = [...clauses];
  const extraParams = [...params];
  if (customerId) {
    extraClauses.push('i.customer_id = ?');
    extraParams.push(customerId);
  }
  // Exclude credit notes from forward sales register
  extraClauses.push("i.status != 'credit_note'");

  const where = extraClauses.length ? `WHERE ${extraClauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT
      i.invoice_number AS invoiceNumber,
      i.invoice_date AS invoiceDate,
      i.financial_year AS financialYear,
      c.name AS customerName,
      c.gstin AS customerGstin,
      c.state AS customerState,
      i.supply_type AS supplyType,
      i.subtotal_paisa AS subtotalPaisa,
      i.cgst_paisa AS cgstPaisa,
      i.sgst_paisa AS sgstPaisa,
      i.igst_paisa AS igstPaisa,
      i.total_tax_paisa AS totalTaxPaisa,
      i.grand_total_paisa AS grandTotalPaisa,
      i.status AS status
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    ${where}
    ORDER BY i.invoice_date, i.id
  `).all(...extraParams);

  return rows.map((r) => ({
    ...r,
    subtotalRs: paisaToRupees(r.subtotalPaisa),
    cgstRs: paisaToRupees(r.cgstPaisa),
    sgstRs: paisaToRupees(r.sgstPaisa),
    igstRs: paisaToRupees(r.igstPaisa),
    totalTaxRs: paisaToRupees(r.totalTaxPaisa),
    grandTotalRs: paisaToRupees(r.grandTotalPaisa),
  }));
}

export function customerWiseSales(db, { from, to } = {}) {
  const { clauses, params } = dateWhere('i.invoice_date', from, to);
  clauses.push("i.status != 'credit_note'");
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT
      c.id AS customerId,
      c.code AS customerCode,
      c.name AS customerName,
      c.state AS state,
      COUNT(DISTINCT i.id) AS invoiceCount,
      SUM(i.subtotal_paisa) AS subtotalPaisa,
      SUM(i.cgst_paisa) AS cgstPaisa,
      SUM(i.sgst_paisa) AS sgstPaisa,
      SUM(i.igst_paisa) AS igstPaisa,
      SUM(i.grand_total_paisa) AS grandTotalPaisa
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    ${where}
    GROUP BY c.id
    ORDER BY SUM(i.grand_total_paisa) DESC
  `).all(...params);
}

export function productWiseSales(db, { from, to } = {}) {
  const { clauses, params } = dateWhere('i.invoice_date', from, to);
  clauses.push("i.status != 'credit_note'");
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT
      items.id AS itemId,
      items.sku AS sku,
      items.name AS itemName,
      items.unit AS unit,
      items.hsn_code AS hsnCode,
      SUM(il.qty_scaled) AS totalQtyScaled,
      SUM(il.taxable_value_paisa) AS subtotalPaisa,
      SUM(il.cgst_paisa) AS cgstPaisa,
      SUM(il.sgst_paisa) AS sgstPaisa,
      SUM(il.igst_paisa) AS igstPaisa,
      SUM(il.line_total_paisa) AS grandTotalPaisa
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id
    JOIN items ON items.id = il.item_id
    ${where}
    GROUP BY items.id
    ORDER BY SUM(il.line_total_paisa) DESC
  `).all(...params).map((r) => ({
    ...r,
    totalQty: fromScaledQty(r.totalQtyScaled),
    subtotalRs: paisaToRupees(r.subtotalPaisa),
    grandTotalRs: paisaToRupees(r.grandTotalPaisa),
  }));
}

export function gstSummary(db, { from, to } = {}) {
  const { clauses, params } = dateWhere('i.invoice_date', from, to);
  clauses.push("i.status != 'credit_note'");
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // B2B: customers with GSTIN
  const b2b = db.prepare(`
    SELECT
      c.name AS customerName, c.gstin AS customerGstin, c.state AS customerState,
      i.invoice_number AS invoiceNumber, i.invoice_date AS invoiceDate,
      il.hsn_code AS hsnCode, il.gst_rate_bps AS gstRateBps,
      il.taxable_value_paisa AS taxableValuePaisa,
      il.cgst_paisa AS cgstPaisa, il.sgst_paisa AS sgstPaisa,
      il.igst_paisa AS igstPaisa,
      (il.cgst_paisa + il.sgst_paisa + il.igst_paisa) AS totalTaxPaisa
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id
    JOIN customers c ON c.id = i.customer_id
    ${where.replace('WHERE', 'WHERE c.gstin IS NOT NULL AND c.gstin != \'\' AND')}
    ORDER BY i.invoice_date, i.id, il.id
  `).all(...params);

  // B2C: customers without GSTIN
  const b2c = db.prepare(`
    SELECT
      c.name AS customerName, c.state AS customerState,
      il.hsn_code AS hsnCode, il.gst_rate_bps AS gstRateBps,
      SUM(il.taxable_value_paisa) AS taxableValuePaisa,
      SUM(il.cgst_paisa) AS cgstPaisa,
      SUM(il.sgst_paisa) AS sgstPaisa,
      SUM(il.igst_paisa) AS igstPaisa,
      SUM(il.cgst_paisa + il.sgst_paisa + il.igst_paisa) AS totalTaxPaisa
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id
    JOIN customers c ON c.id = i.customer_id
    ${where.replace('WHERE', 'WHERE (c.gstin IS NULL OR c.gstin = \'\') AND')}
    GROUP BY c.id, il.hsn_code, il.gst_rate_bps
    ORDER BY c.name, il.hsn_code
  `).all(...params);

  const totals = db.prepare(`
    SELECT
      SUM(i.subtotal_paisa) AS totalTaxableValuePaisa,
      SUM(i.cgst_paisa) AS totalCgstPaisa,
      SUM(i.sgst_paisa) AS totalSgstPaisa,
      SUM(i.igst_paisa) AS totalIgstPaisa,
      SUM(i.total_tax_paisa) AS totalTaxPaisa,
      SUM(i.grand_total_paisa) AS grandTotalPaisa
    FROM invoices i
    ${where}
  `).get(...params);

  return { b2b, b2c, totals };
}

export function purchaseRegister(db, { from, to } = {}) {
  const { clauses, params } = dateWhere('p.purchase_date', from, to);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT
      p.purchase_number AS purchaseNumber,
      p.purchase_date AS purchaseDate,
      p.supplier_name AS supplierName,
      i.sku AS sku,
      i.name AS itemName,
      pl.qty_scaled AS qtyScaled,
      pl.unit AS unit,
      pl.rate_paisa AS ratePaisa,
      pl.line_total_paisa AS lineTotalPaisa
    FROM purchase_lines pl
    JOIN purchases p ON p.id = pl.purchase_id
    JOIN items i ON i.id = pl.item_id
    ${where}
    ORDER BY p.purchase_date, p.id, pl.id
  `).all(...params).map((r) => ({
    ...r,
    qty: fromScaledQty(r.qtyScaled),
    rateRs: paisaToRupees(r.ratePaisa),
    lineTotalRs: paisaToRupees(r.lineTotalPaisa),
  }));
}

export function stockSummary(db) {
  return db.prepare('SELECT * FROM v_stock_balance ORDER BY item_id').all().map((r) => ({
    itemId: r.item_id,
    sku: r.sku,
    name: r.name,
    itemType: r.item_type,
    unit: r.unit,
    balanceScaled: r.balance_scaled,
    balanceQty: fromScaledQty(r.balance_scaled),
  }));
}

export function stockLedgerReport(db, { from, to, sku } = {}) {
  const clauses = [];
  const params = [];
  if (sku) { clauses.push('i.sku = ?'); params.push(sku); }
  if (from) { clauses.push("date(sl.created_at) >= date(?)"); params.push(from); }
  if (to)   { clauses.push("date(sl.created_at) <= date(?)"); params.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT
      sl.id, sl.created_at AS date,
      i.sku, i.name AS itemName, i.unit,
      sl.qty_scaled AS qtyScaled,
      sl.unit_cost_paisa AS unitCostPaisa,
      sl.source_type AS sourceType,
      sl.source_id AS sourceId,
      sl.notes
    FROM stock_ledger sl
    JOIN items i ON i.id = sl.item_id
    ${where}
    ORDER BY sl.id ASC
  `).all(...params).map((r) => ({
    ...r,
    qty: fromScaledQty(r.qtyScaled),
    unitCostRs: paisaToRupees(r.unitCostPaisa),
  }));
}

export function productionReport(db, { from, to } = {}) {
  const { clauses, params } = dateWhere('pr.run_date', from, to);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const runs = db.prepare(`
    SELECT pr.*, b.code AS bomCode, i.sku AS productSku, i.name AS productName
    FROM production_runs pr
    JOIN bom b ON b.id = pr.bom_id
    JOIN items i ON i.id = b.finished_item_id
    ${where}
    ORDER BY pr.run_date, pr.id
  `).all(...params);

  return runs.map((run) => {
    const consumptions = db.prepare(`
      SELECT prc.*, it.sku, it.name AS itemName, it.unit
      FROM production_run_consumptions prc
      JOIN items it ON it.id = prc.item_id
      WHERE prc.production_run_id = ?
    `).all(run.id);

    return {
      runId: run.id,
      runNumber: run.run_number,
      runDate: run.run_date,
      bomCode: run.bomCode,
      productSku: run.productSku,
      productName: run.productName,
      batchesPlanned: fromScaledQty(run.batches_planned_scaled),
      expectedYieldQty: fromScaledQty(run.expected_yield_scaled),
      actualGoodYieldQty: fromScaledQty(run.actual_good_yield_scaled),
      yieldVarianceBps: run.yield_variance_bps,
      yieldVariancePercent: run.yield_variance_bps / 100,
      status: run.status,
      consumptions: consumptions.map((c) => ({
        sku: c.sku,
        itemName: c.itemName,
        unit: c.unit,
        expectedQty: fromScaledQty(c.expected_qty_scaled),
        actualQty: fromScaledQty(c.actual_qty_scaled),
        damagedQty: fromScaledQty(c.damaged_qty_scaled),
        totalIssuedQty: fromScaledQty(c.total_issued_scaled),
        varianceBps: c.variance_bps,
        flagged: Math.abs(c.variance_bps) > 300,
      })),
    };
  });
}

export function paymentsReport(db, { from, to, customerId } = {}) {
  const clauses = [];
  const params = [];
  if (from) { clauses.push("date(p.payment_date) >= date(?)"); params.push(from); }
  if (to)   { clauses.push("date(p.payment_date) <= date(?)"); params.push(to); }
  if (customerId) { clauses.push('p.customer_id = ?'); params.push(customerId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT
      p.payment_number AS paymentNumber,
      p.payment_date AS paymentDate,
      c.name AS customerName,
      c.code AS customerCode,
      p.payment_mode AS paymentMode,
      p.reference_no AS referenceNo,
      i.invoice_number AS invoiceNumber,
      p.amount_paisa AS amountPaisa
    FROM payments p
    JOIN customers c ON c.id = p.customer_id
    LEFT JOIN invoices i ON i.id = p.invoice_id
    ${where}
    ORDER BY p.payment_date, p.id
  `).all(...params).map((r) => ({ ...r, amountRs: paisaToRupees(r.amountPaisa) }));
}

// ─── format dispatcher ───────────────────────────────────────────────────────

const SALES_REGISTER_COLS = [
  'invoiceNumber','invoiceDate','financialYear','customerName','customerGstin',
  'customerState','supplyType','subtotalRs','cgstRs','sgstRs','igstRs','totalTaxRs','grandTotalRs','status',
];

const STOCK_SUMMARY_COLS = ['itemId','sku','name','itemType','unit','balanceQty'];

export async function sendReport(res, { data, format, filename, columns, sheetName }) {
  if (format === 'csv') {
    return toCsvResponse(res, data, columns, filename);
  }
  if (format === 'xlsx') {
    return toXlsxResponse(res, data, columns, filename, sheetName ?? filename);
  }
  // JSON (default)
  return res.json({ report: filename, data, count: data.length });
}

export { SALES_REGISTER_COLS, STOCK_SUMMARY_COLS };
