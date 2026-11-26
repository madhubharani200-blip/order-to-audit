import { Router } from 'express';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { fromScaledQty } from '../lib/units.js';
import { ALL_ROLES, requireRole } from '../middleware/auth.js';
import {
  approveOrder,
  createOrder,
  dispatchAndInvoice,
  getOrderStockCheck,
  recordPayment,
} from '../services/sales.js';

function resolveEffectivePricePaisa(db, itemId, customerId, explicitPrice) {
  if (explicitPrice !== undefined) return explicitPrice;
  const priceRow = db
    .prepare(`
      SELECT price_paisa
      FROM price_list
      WHERE item_id = ?
        AND (customer_id = ? OR customer_id IS NULL)
        AND is_active = 1
      ORDER BY CASE WHEN customer_id IS NOT NULL THEN 0 ELSE 1 END, id DESC
      LIMIT 1
    `)
    .get(itemId, customerId);
  return priceRow?.price_paisa;
}

function formatInvoice(db, inv) {
  const customer = db.prepare('SELECT id, code, name, gstin, state, state_code FROM customers WHERE id = ?').get(inv.customer_id);
  const lines = db
    .prepare(`
      SELECT il.*, i.sku, i.name AS item_name
      FROM invoice_lines il
      JOIN items i ON i.id = il.item_id
      WHERE il.invoice_id = ?
      ORDER BY il.id
    `)
    .all(inv.id);

  return {
    id: inv.id,
    invoiceNumber: inv.invoice_number,
    financialYear: inv.financial_year,
    seqNumber: inv.seq_number,
    customerId: inv.customer_id,
    customer,
    orderId: inv.order_id,
    invoiceDate: inv.invoice_date,
    placeOfSupplyState: inv.place_of_supply_state,
    supplyType: inv.supply_type,
    subtotalPaisa: inv.subtotal_paisa,
    cgstPaisa: inv.cgst_paisa,
    sgstPaisa: inv.sgst_paisa,
    igstPaisa: inv.igst_paisa,
    totalTaxPaisa: inv.total_tax_paisa,
    grandTotalPaisa: inv.grand_total_paisa,
    status: inv.status,
    createdBy: inv.created_by,
    createdAt: inv.created_at,
    lines: lines.map((l) => ({
      id: l.id,
      itemId: l.item_id,
      sku: l.sku,
      itemName: l.item_name,
      hsnCode: l.hsn_code,
      qty: fromScaledQty(l.qty_scaled),
      qtyScaled: l.qty_scaled,
      unit: l.unit,
      unitPricePaisa: l.unit_price_paisa,
      taxableValuePaisa: l.taxable_value_paisa,
      gstRateBps: l.gst_rate_bps,
      cgstPaisa: l.cgst_paisa,
      sgstPaisa: l.sgst_paisa,
      igstPaisa: l.igst_paisa,
      lineTotalPaisa: l.line_total_paisa,
    })),
  };
}

export function createOrdersRouter(db) {
  const router = Router();

  router.get('/', requireRole(...ALL_ROLES), (_req, res) => {
    const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
    res.json({ orders });
  });

  router.get('/:id', requireRole(...ALL_ROLES), (req, res, next) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
    if (!order) return next(new NotFoundError('Order not found'));
    const lines = db.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(order.id);
    return res.json({ order, lines });
  });

  router.get('/:id/stock-check', requireRole(...ALL_ROLES), (req, res, next) => {
    try {
      const check = getOrderStockCheck(db, Number(req.params.id));
      return res.json(check);
    } catch (err) {
      return next(err);
    }
  });

  router.post('/:id/approve', requireRole('admin'), (req, res, next) => {
    try {
      const allowShortage = req.body?.allowShortage === true;
      const result = approveOrder(db, {
        orderId: Number(req.params.id),
        allowShortage,
        actorUserId: req.user.id,
      });
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  router.post('/', requireRole('salesman', 'admin'), (req, res, next) => {
    try {
      const { orderNumber, customerId, orderDate, lines, notes = null } = req.body ?? {};
      if (!customerId || !orderDate || !Array.isArray(lines) || lines.length === 0) {
        throw new ValidationError('customerId, orderDate, and non-empty lines are required');
      }
      const resolvedLines = lines.map((l) => ({
        itemId: l.itemId,
        qty: l.qty,
        unitPricePaisa: resolveEffectivePricePaisa(db, l.itemId, customerId, l.unitPricePaisa),
      }));
      const created = createOrder(db, {
        orderNumber,
        customerId,
        orderDate,
        lines: resolvedLines,
        notes,
        actorUserId: req.user.id,
      });
      return res.status(201).json({ order: created });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

export function createInvoicesRouter(db) {
  const router = Router();

  router.get('/', requireRole(...ALL_ROLES), (_req, res) => {
    const rows = db.prepare('SELECT * FROM invoices ORDER BY id DESC').all();
    res.json({ invoices: rows.map((r) => formatInvoice(db, r)) });
  });

  router.get('/:id', requireRole(...ALL_ROLES), (req, res, next) => {
    const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(req.params.id));
    if (!row) return next(new NotFoundError('Invoice not found'));
    return res.json({ invoice: formatInvoice(db, row) });
  });

  router.post('/', requireRole('salesman', 'admin'), (req, res, next) => {
    try {
      const {
        customerId,
        orderId = null,
        invoiceDate = new Date().toISOString().slice(0, 10),
        lines,
      } = req.body ?? {};
      if (!customerId || !Array.isArray(lines) || lines.length === 0) {
        throw new ValidationError('customerId and non-empty lines are required');
      }

      const resolvedLines = lines.map((line) => {
        let itemId = line.itemId;
        if (!itemId && line.sku) {
          const found = db.prepare('SELECT id FROM items WHERE sku = ?').get(line.sku);
          if (!found) throw new NotFoundError(`Item SKU not found: ${line.sku}`);
          itemId = found.id;
        }
        return {
          itemId,
          qty: line.qty,
          unitPricePaisa: resolveEffectivePricePaisa(db, itemId, customerId, line.unitPricePaisa),
        };
      });

      const created = dispatchAndInvoice(db, {
        customerId,
        orderId,
        invoiceDate,
        lines: resolvedLines,
        actorUserId: req.user.id,
      });

      const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(created.id);
      return res.status(201).json({ invoice: formatInvoice(db, row) });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

export function createPaymentsRouter(db) {
  const router = Router();

  router.get('/', requireRole(...ALL_ROLES), (_req, res) => {
    const payments = db.prepare('SELECT * FROM payments ORDER BY id DESC').all();
    res.json({ payments });
  });

  router.post('/', requireRole('salesman', 'admin'), (req, res, next) => {
    try {
      const {
        paymentNumber,
        customerId,
        invoiceId = null,
        paymentDate = new Date().toISOString().slice(0, 10),
        amountPaisa,
        paymentMode,
        referenceNo = null,
        notes = null,
      } = req.body ?? {};
      if (!customerId || !amountPaisa || !paymentMode) {
        throw new ValidationError('customerId, amountPaisa, and paymentMode are required');
      }
      const created = recordPayment(db, {
        paymentNumber,
        customerId,
        invoiceId,
        paymentDate,
        amountPaisa,
        paymentMode,
        referenceNo,
        notes,
        actorUserId: req.user.id,
      });
      return res.status(201).json({ payment: created });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
