import { Router } from 'express';
import { fromScaledQty } from '../lib/units.js';
import { ALL_ROLES, requireRole } from '../middleware/auth.js';

function buildSourceDocumentLink(row) {
  switch (row.source_type) {
    case 'opening':
      return {
        type: 'opening',
        id: row.source_id,
        ref: row.sku,
        url: `/items/${row.item_id}`,
      };
    case 'purchase':
      return {
        type: 'purchase',
        id: row.source_id,
        ref: row.purchase_number ?? `PUR#${row.source_id}`,
        url: `/purchases/${row.source_id}`,
      };
    case 'production_issue':
    case 'production_damage':
    case 'production_output':
      return {
        type: 'production_run',
        id: row.source_id,
        ref: row.run_number ?? `PRD#${row.source_id}`,
        url: `/production-runs/${row.source_id}`,
      };
    case 'dispatch':
      return {
        type: 'invoice',
        id: row.source_id,
        ref: row.invoice_number ?? `INV#${row.source_id}`,
        url: `/invoices/${row.source_id}`,
      };
    default:
      return {
        type: row.source_type,
        id: row.source_id,
        ref: String(row.source_id),
        url: null,
      };
  }
}

export function createStockRouter(db) {
  const router = Router();

  router.get('/summary', requireRole(...ALL_ROLES), (req, res) => {
    const { itemType, itemId } = req.query;
    const clauses = [];
    const params = [];

    if (itemType) {
      clauses.push('item_type = ?');
      params.push(itemType);
    }
    if (itemId) {
      clauses.push('item_id = ?');
      params.push(Number(itemId));
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM v_stock_balance ${where} ORDER BY item_id`).all(...params);

    res.json({
      items: rows.map((r) => ({
        itemId: r.item_id,
        sku: r.sku,
        name: r.name,
        itemType: r.item_type,
        unit: r.unit,
        balanceScaled: r.balance_scaled,
        balanceQty: fromScaledQty(r.balance_scaled),
      })),
    });
  });

  router.get('/ledger', requireRole(...ALL_ROLES), (req, res) => {
    const { itemId, sku, sourceType } = req.query;
    const fromDate = req.query.from ?? req.query.fromDate;
    const toDate = req.query.to ?? req.query.toDate;

    const clauses = [];
    const params = [];

    if (itemId) {
      clauses.push('sl.item_id = ?');
      params.push(Number(itemId));
    }
    if (sku) {
      clauses.push('i.sku = ?');
      params.push(sku);
    }
    if (sourceType) {
      clauses.push('sl.source_type = ?');
      params.push(sourceType);
    }
    if (fromDate) {
      clauses.push(
        "date(COALESCE(p.purchase_date, pr.run_date, inv.invoice_date, sl.created_at)) >= date(?)"
      );
      params.push(fromDate);
    }
    if (toDate) {
      clauses.push(
        "date(COALESCE(p.purchase_date, pr.run_date, inv.invoice_date, sl.created_at)) <= date(?)"
      );
      params.push(toDate);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(`
        SELECT
          sl.*,
          i.sku,
          i.name AS item_name,
          i.item_type,
          u.username AS created_by_username,
          p.purchase_number,
          p.purchase_date,
          pr.run_number,
          pr.run_date,
          inv.invoice_number,
          inv.invoice_date,
          COALESCE(p.purchase_date, pr.run_date, inv.invoice_date, date(sl.created_at)) AS document_date
        FROM stock_ledger sl
        JOIN items i ON i.id = sl.item_id
        LEFT JOIN users u ON u.id = sl.created_by
        LEFT JOIN purchases p ON sl.source_type = 'purchase' AND p.id = sl.source_id
        LEFT JOIN production_runs pr
          ON sl.source_type IN ('production_issue', 'production_damage', 'production_output')
          AND pr.id = sl.source_id
        LEFT JOIN invoices inv ON sl.source_type = 'dispatch' AND inv.id = sl.source_id
        ${where}
        ORDER BY sl.id ASC
      `)
      .all(...params);

    res.json({
      entries: rows.map((r) => ({
        id: r.id,
        itemId: r.item_id,
        sku: r.sku,
        itemName: r.item_name,
        itemType: r.item_type,
        qty: fromScaledQty(r.qty_scaled),
        qtyScaled: r.qty_scaled,
        unit: r.unit,
        unitCostPaisa: r.unit_cost_paisa,
        sourceType: r.source_type,
        sourceId: r.source_id,
        source: buildSourceDocumentLink(r),
        documentDate: r.document_date,
        notes: r.notes,
        createdBy: r.created_by,
        createdByUsername: r.created_by_username,
        createdAt: r.created_at,
      })),
    });
  });

  return router;
}
