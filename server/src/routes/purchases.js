import { Router } from 'express';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { fromScaledQty } from '../lib/units.js';
import { ALL_ROLES, requireRole } from '../middleware/auth.js';
import { recordPurchase } from '../services/purchasing.js';

function formatPurchase(db, row) {
  const lines = db
    .prepare(`
      SELECT pl.*, i.sku, i.name AS item_name
      FROM purchase_lines pl
      JOIN items i ON i.id = pl.item_id
      WHERE pl.purchase_id = ?
      ORDER BY pl.id
    `)
    .all(row.id);

  return {
    id: row.id,
    purchaseNumber: row.purchase_number,
    supplierName: row.supplier_name,
    purchaseDate: row.purchase_date,
    totalAmountPaisa: row.total_amount_paisa,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lines: lines.map((l) => ({
      id: l.id,
      itemId: l.item_id,
      sku: l.sku,
      itemName: l.item_name,
      qty: fromScaledQty(l.qty_scaled),
      qtyScaled: l.qty_scaled,
      unit: l.unit,
      ratePaisa: l.rate_paisa,
      lineTotalPaisa: l.line_total_paisa,
    })),
  };
}

export function createPurchasesRouter(db) {
  const router = Router();

  router.get('/', requireRole(...ALL_ROLES), (_req, res) => {
    const rows = db.prepare('SELECT * FROM purchases ORDER BY id DESC').all();
    res.json({ purchases: rows.map((r) => formatPurchase(db, r)) });
  });

  router.get('/:id', requireRole(...ALL_ROLES), (req, res, next) => {
    const row = db.prepare('SELECT * FROM purchases WHERE id = ?').get(Number(req.params.id));
    if (!row) return next(new NotFoundError('Purchase not found'));
    return res.json({ purchase: formatPurchase(db, row) });
  });

  router.post('/', requireRole('admin', 'production'), (req, res, next) => {
    try {
      const { purchaseNumber, supplierName, purchaseDate, lines, notes = null } = req.body ?? {};
      if (!supplierName || !purchaseDate || !Array.isArray(lines) || lines.length === 0) {
        throw new ValidationError('supplierName, purchaseDate, and non-empty lines are required');
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
          ratePaisa: line.ratePaisa,
          unit: line.unit,
        };
      });

      const created = recordPurchase(db, {
        purchaseNumber,
        supplierName,
        purchaseDate,
        lines: resolvedLines,
        notes,
        actorUserId: req.user.id,
      });

      const row = db.prepare('SELECT * FROM purchases WHERE id = ?').get(created.id);
      return res.status(201).json({ purchase: formatPurchase(db, row) });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
