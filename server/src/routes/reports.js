import { Router } from 'express';
import { ALL_ROLES, requireRole } from '../middleware/auth.js';
import { getOutstandingReport } from '../services/receivables.js';
import {
  SALES_REGISTER_COLS,
  STOCK_SUMMARY_COLS,
  customerWiseSales,
  gstSummary,
  paymentsReport,
  productWiseSales,
  productionReport,
  purchaseRegister,
  salesRegister,
  sendReport,
  stockLedgerReport,
  stockSummary,
} from '../services/reports.js';

const REPORT_ROLES = ['admin', 'auditor', 'owner'];

export function createReportsRouter(db) {
  const router = Router();

  function parseDateRange(query) {
    return { from: query.from, to: query.to };
  }

  // Sales register
  router.get('/sales-register', requireRole(...REPORT_ROLES, 'salesman'), async (req, res, next) => {
    try {
      const { from, to } = parseDateRange(req.query);
      const customerId = req.user.role === 'salesman' ? undefined : req.query.customerId;
      const data = salesRegister(db, { from, to, customerId });
      return sendReport(res, {
        data,
        format: req.query.format,
        filename: 'sales-register',
        columns: SALES_REGISTER_COLS,
      });
    } catch (err) { return next(err); }
  });

  // Customer-wise sales
  router.get('/customer-sales', requireRole(...REPORT_ROLES), async (req, res, next) => {
    try {
      const { from, to } = parseDateRange(req.query);
      const data = customerWiseSales(db, { from, to });
      return sendReport(res, {
        data,
        format: req.query.format,
        filename: 'customer-sales',
        columns: ['customerId','customerCode','customerName','state','invoiceCount','subtotalPaisa','grandTotalPaisa'],
      });
    } catch (err) { return next(err); }
  });

  // Product-wise sales
  router.get('/product-sales', requireRole(...REPORT_ROLES), async (req, res, next) => {
    try {
      const { from, to } = parseDateRange(req.query);
      const data = productWiseSales(db, { from, to });
      return sendReport(res, {
        data,
        format: req.query.format,
        filename: 'product-sales',
        columns: ['itemId','sku','itemName','hsnCode','totalQty','unit','subtotalPaisa','grandTotalPaisa'],
      });
    } catch (err) { return next(err); }
  });

  // GST summary (GSTR-1 / GSTR-3B shape)
  router.get('/gst-summary', requireRole(...REPORT_ROLES), async (req, res, next) => {
    try {
      const { from, to } = parseDateRange(req.query);
      const summary = gstSummary(db, { from, to });
      const fmt = req.query.format;
      if (fmt === 'json' || !fmt) return res.json({ report: 'gst-summary', ...summary });

      const b2bColumns = ['customerName','customerGstin','invoiceNumber','invoiceDate','hsnCode','gstRateBps','taxableValuePaisa','cgstPaisa','sgstPaisa','igstPaisa'];
      if (fmt === 'csv') {
        const csv =
          '-- B2B --\n' +
          b2bColumns.join(',') + '\n' +
          summary.b2b.map((r) => b2bColumns.map((c) => r[c] ?? '').join(',')).join('\n') +
          '\n-- B2C --\n' +
          ['customerName','customerState','hsnCode','gstRateBps','taxableValuePaisa','cgstPaisa','sgstPaisa','igstPaisa'].join(',') + '\n' +
          summary.b2c.map((r) => ['customerName','customerState','hsnCode','gstRateBps','taxableValuePaisa','cgstPaisa','sgstPaisa','igstPaisa'].map((c) => r[c] ?? '').join(',')).join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="gst-summary.csv"');
        return res.send(csv);
      }
      return res.json({ report: 'gst-summary', ...summary });
    } catch (err) { return next(err); }
  });

  // Purchase register
  router.get('/purchase-register', requireRole(...REPORT_ROLES), async (req, res, next) => {
    try {
      const { from, to } = parseDateRange(req.query);
      const data = purchaseRegister(db, { from, to });
      return sendReport(res, {
        data,
        format: req.query.format,
        filename: 'purchase-register',
        columns: ['purchaseNumber','purchaseDate','supplierName','sku','itemName','qty','unit','rateRs','lineTotalRs'],
      });
    } catch (err) { return next(err); }
  });

  // Stock summary
  router.get('/stock-summary', requireRole(...ALL_ROLES), async (req, res, next) => {
    try {
      const data = stockSummary(db);
      return sendReport(res, {
        data,
        format: req.query.format,
        filename: 'stock-summary',
        columns: STOCK_SUMMARY_COLS,
        sheetName: 'Stock Summary',
      });
    } catch (err) { return next(err); }
  });

  // Stock ledger
  router.get('/stock-ledger', requireRole(...ALL_ROLES), async (req, res, next) => {
    try {
      const { from, to } = parseDateRange(req.query);
      const data = stockLedgerReport(db, { from, to, sku: req.query.sku });
      return sendReport(res, {
        data,
        format: req.query.format,
        filename: 'stock-ledger',
        columns: ['id','date','sku','itemName','unit','qty','unitCostRs','sourceType','sourceId','notes'],
      });
    } catch (err) { return next(err); }
  });

  // Production report
  router.get('/production', requireRole(...REPORT_ROLES, 'production'), async (req, res, next) => {
    try {
      const { from, to } = parseDateRange(req.query);
      const data = productionReport(db, { from, to });
      const fmt = req.query.format;
      if (fmt === 'csv' || fmt === 'xlsx') {
        const flat = data.flatMap((run) =>
          run.consumptions.length
            ? run.consumptions.map((c) => ({
                runNumber: run.runNumber,
                runDate: run.runDate,
                bomCode: run.bomCode,
                productSku: run.productSku,
                expectedYieldQty: run.expectedYieldQty,
                actualGoodYieldQty: run.actualGoodYieldQty,
                yieldVarianceBps: run.yieldVarianceBps,
                ...c,
              }))
            : [{ runNumber: run.runNumber, runDate: run.runDate, bomCode: run.bomCode, productSku: run.productSku,
                 expectedYieldQty: run.expectedYieldQty, actualGoodYieldQty: run.actualGoodYieldQty, yieldVarianceBps: run.yieldVarianceBps }]
        );
        return sendReport(res, {
          data: flat,
          format: fmt,
          filename: 'production-report',
          columns: ['runNumber','runDate','bomCode','productSku','expectedYieldQty','actualGoodYieldQty','yieldVarianceBps','sku','itemName','expectedQty','actualQty','damagedQty','varianceBps','flagged'],
        });
      }
      return res.json({ report: 'production', data, count: data.length });
    } catch (err) { return next(err); }
  });

  // Payments / collections
  router.get('/payments', requireRole(...REPORT_ROLES), async (req, res, next) => {
    try {
      const { from, to } = parseDateRange(req.query);
      const data = paymentsReport(db, { from, to, customerId: req.query.customerId });
      return sendReport(res, {
        data,
        format: req.query.format,
        filename: 'payments',
        columns: ['paymentNumber','paymentDate','customerName','paymentMode','referenceNo','invoiceNumber','amountRs'],
      });
    } catch (err) { return next(err); }
  });

  // Outstanding with ageing
  router.get('/outstanding', requireRole(...ALL_ROLES), (req, res, next) => {
    try {
      const asOfDate = req.query.asOfDate || new Date().toISOString().slice(0, 10);
      const onlyWithBalance = req.query.onlyWithBalance === 'true';
      const report = getOutstandingReport(db, { asOfDate, onlyWithBalance });
      return res.json(report);
    } catch (err) { return next(err); }
  });

  return router;
}
