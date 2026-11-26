import { Router } from 'express';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { fromScaledQty, toScaledQty } from '../lib/units.js';
import { ALL_ROLES, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { getCustomerOutstanding } from '../services/receivables.js';

function formatItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    itemType: row.item_type,
    unit: row.unit,
    baseUnit: row.base_unit,
    toBaseFactor: fromScaledQty(row.to_base_scaled),
    hsnCode: row.hsn_code,
    gstRateBps: row.gst_rate_bps,
    sellingPricePaisa: row.selling_price_paisa,
    standardCostPaisa: row.standard_cost_paisa,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  };
}

function formatBom(db, bomRow) {
  if (!bomRow) return null;
  const lines = db
    .prepare(`
      SELECT bl.*, i.sku, i.name AS item_name
      FROM bom_lines bl
      JOIN items i ON i.id = bl.item_id
      WHERE bl.bom_id = ?
      ORDER BY bl.id
    `)
    .all(bomRow.id);

  return {
    id: bomRow.id,
    code: bomRow.code,
    name: bomRow.name,
    finishedItemId: bomRow.finished_item_id,
    batchDescription: bomRow.batch_description,
    expectedYieldQty: fromScaledQty(bomRow.expected_yield_scaled),
    expectedYieldScaled: bomRow.expected_yield_scaled,
    yieldUnit: bomRow.yield_unit,
    isActive: Boolean(bomRow.is_active),
    lines: lines.map((l) => ({
      id: l.id,
      itemId: l.item_id,
      sku: l.sku,
      itemName: l.item_name,
      qtyPerBatch: fromScaledQty(l.qty_per_batch_scaled),
      qtyPerBatchScaled: l.qty_per_batch_scaled,
      unit: l.unit,
      lineType: l.line_type,
    })),
  };
}

export function createItemsRouter(db) {
  const router = Router();

  router.get('/', requireRole(...ALL_ROLES), (req, res) => {
    const { type, active } = req.query;
    const clauses = [];
    const params = [];
    if (type) {
      clauses.push('item_type = ?');
      params.push(type);
    }
    if (active !== undefined) {
      clauses.push('is_active = ?');
      params.push(active === 'false' || active === '0' ? 0 : 1);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM items ${where} ORDER BY id`).all(...params);
    res.json({ items: rows.map(formatItem) });
  });

  router.get('/:id', requireRole(...ALL_ROLES), (req, res, next) => {
    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(req.params.id));
    if (!row) return next(new NotFoundError('Item not found'));
    const conversions = db
      .prepare('SELECT * FROM unit_conversions WHERE item_id = ? OR item_id IS NULL ORDER BY id')
      .all(row.id);
    return res.json({
      item: formatItem(row),
      unitConversions: conversions.map((c) => ({
        id: c.id,
        itemId: c.item_id,
        fromUnit: c.from_unit,
        toUnit: c.to_unit,
        multiplier: fromScaledQty(c.multiplier_scaled),
      })),
    });
  });

  router.post('/', requireRole('admin'), (req, res, next) => {
    try {
      const {
        sku,
        name,
        itemType,
        unit,
        baseUnit,
        toBaseFactor = 1,
        hsnCode = null,
        gstRateBps = 0,
        sellingPricePaisa = 0,
        standardCostPaisa = 0,
      } = req.body ?? {};
      if (!sku || !name || !itemType || !unit || !baseUnit) {
        throw new ValidationError('sku, name, itemType, unit, and baseUnit are required');
      }

      const created = db.transaction(() => {
        const info = db
          .prepare(`
            INSERT INTO items (
              sku, name, item_type, unit, base_unit, to_base_scaled,
              hsn_code, gst_rate_bps, selling_price_paisa, standard_cost_paisa
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            sku,
            name,
            itemType,
            unit,
            baseUnit,
            toScaledQty(toBaseFactor),
            hsnCode,
            gstRateBps,
            sellingPricePaisa,
            standardCostPaisa
          );
        const itemId = Number(info.lastInsertRowid);
        const row = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
        recordAudit(db, {
          actorUserId: req.user.id,
          action: 'ITEM_CREATED',
          entityType: 'item',
          entityId: itemId,
          after: formatItem(row),
        });
        return formatItem(row);
      })();

      return res.status(201).json({ item: created });
    } catch (err) {
      return next(err);
    }
  });

  router.put('/:id', requireRole('admin'), (req, res, next) => {
    try {
      const itemId = Number(req.params.id);
      const updated = db.transaction(() => {
        const before = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
        if (!before) throw new NotFoundError('Item not found');

        const nextName = req.body.name ?? before.name;
        const nextUnit = req.body.unit ?? before.unit;
        const nextBaseUnit = req.body.baseUnit ?? before.base_unit;
        const nextToBase =
          req.body.toBaseFactor !== undefined
            ? toScaledQty(req.body.toBaseFactor)
            : before.to_base_scaled;
        const nextHsn = req.body.hsnCode !== undefined ? req.body.hsnCode : before.hsn_code;
        const nextGst = req.body.gstRateBps ?? before.gst_rate_bps;
        const nextSelling = req.body.sellingPricePaisa ?? before.selling_price_paisa;
        const nextCost = req.body.standardCostPaisa ?? before.standard_cost_paisa;
        const nextActive =
          req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : before.is_active;

        db.prepare(`
          UPDATE items
          SET name = ?, unit = ?, base_unit = ?, to_base_scaled = ?, hsn_code = ?,
              gst_rate_bps = ?, selling_price_paisa = ?, standard_cost_paisa = ?, is_active = ?
          WHERE id = ?
        `).run(
          nextName,
          nextUnit,
          nextBaseUnit,
          nextToBase,
          nextHsn,
          nextGst,
          nextSelling,
          nextCost,
          nextActive,
          itemId
        );

        const after = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
        recordAudit(db, {
          actorUserId: req.user.id,
          action: 'ITEM_UPDATED',
          entityType: 'item',
          entityId: itemId,
          before: formatItem(before),
          after: formatItem(after),
        });
        return formatItem(after);
      })();

      return res.json({ item: updated });
    } catch (err) {
      return next(err);
    }
  });

  router.delete('/:id', requireRole('admin'), (req, res, next) => {
    try {
      const itemId = Number(req.params.id);
      const deactivated = db.transaction(() => {
        const before = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
        if (!before) throw new NotFoundError('Item not found');
        db.prepare('UPDATE items SET is_active = 0 WHERE id = ?').run(itemId);
        const after = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
        recordAudit(db, {
          actorUserId: req.user.id,
          action: 'ITEM_DEACTIVATED',
          entityType: 'item',
          entityId: itemId,
          before: formatItem(before),
          after: formatItem(after),
        });
        return formatItem(after);
      })();
      return res.json({ item: deactivated });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

export function createCustomersRouter(db) {
  const router = Router();

  router.get('/', requireRole(...ALL_ROLES), (_req, res) => {
    const customers = db.prepare('SELECT * FROM customers ORDER BY id').all();
    res.json({ customers });
  });

  router.get('/:id', requireRole(...ALL_ROLES), (req, res, next) => {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id));
    if (!customer) return next(new NotFoundError('Customer not found'));
    return res.json({ customer });
  });

  router.get('/:id/outstanding', requireRole(...ALL_ROLES), (req, res, next) => {
    try {
      const asOfDate = req.query.asOfDate || new Date().toISOString().slice(0, 10);
      const report = getCustomerOutstanding(db, Number(req.params.id), asOfDate);
      return res.json(report);
    } catch (err) {
      return next(err);
    }
  });

  router.post('/', requireRole('admin'), (req, res, next) => {
    try {
      const { code, name, gstin = null, state, stateCode, address = null, phone = null } =
        req.body ?? {};
      if (!code || !name || !state || !stateCode) {
        throw new ValidationError('code, name, state, and stateCode are required');
      }
      const customer = db.transaction(() => {
        const info = db
          .prepare(`
            INSERT INTO customers (code, name, gstin, state, state_code, address, phone)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .run(code, name, gstin, state, stateCode, address, phone);
        const id = Number(info.lastInsertRowid);
        const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
        recordAudit(db, {
          actorUserId: req.user.id,
          action: 'CUSTOMER_CREATED',
          entityType: 'customer',
          entityId: id,
          after: row,
        });
        return row;
      })();
      return res.status(201).json({ customer });
    } catch (err) {
      return next(err);
    }
  });

  router.put('/:id', requireRole('admin'), (req, res, next) => {
    try {
      const customerId = Number(req.params.id);
      const updated = db.transaction(() => {
        const before = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
        if (!before) throw new NotFoundError('Customer not found');
        db.prepare(`
          UPDATE customers
          SET name = ?, gstin = ?, state = ?, state_code = ?, address = ?, phone = ?, is_active = ?
          WHERE id = ?
        `).run(
          req.body.name ?? before.name,
          req.body.gstin !== undefined ? req.body.gstin : before.gstin,
          req.body.state ?? before.state,
          req.body.stateCode ?? before.state_code,
          req.body.address !== undefined ? req.body.address : before.address,
          req.body.phone !== undefined ? req.body.phone : before.phone,
          req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : before.is_active,
          customerId
        );
        const after = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
        recordAudit(db, {
          actorUserId: req.user.id,
          action: 'CUSTOMER_UPDATED',
          entityType: 'customer',
          entityId: customerId,
          before,
          after,
        });
        return after;
      })();
      return res.json({ customer: updated });
    } catch (err) {
      return next(err);
    }
  });

  router.delete('/:id', requireRole('admin'), (req, res, next) => {
    try {
      const customerId = Number(req.params.id);
      const deactivated = db.transaction(() => {
        const before = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
        if (!before) throw new NotFoundError('Customer not found');
        db.prepare('UPDATE customers SET is_active = 0 WHERE id = ?').run(customerId);
        const after = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
        recordAudit(db, {
          actorUserId: req.user.id,
          action: 'CUSTOMER_DEACTIVATED',
          entityType: 'customer',
          entityId: customerId,
          before,
          after,
        });
        return after;
      })();
      return res.json({ customer: deactivated });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

export function createBomRouter(db) {
  const router = Router();

  router.get('/', requireRole(...ALL_ROLES), (_req, res) => {
    const rows = db.prepare('SELECT * FROM bom ORDER BY id').all();
    res.json({ boms: rows.map((r) => formatBom(db, r)) });
  });

  router.get('/:id', requireRole(...ALL_ROLES), (req, res, next) => {
    const row = db.prepare('SELECT * FROM bom WHERE id = ?').get(Number(req.params.id));
    if (!row) return next(new NotFoundError('BOM not found'));
    return res.json({ bom: formatBom(db, row) });
  });

  router.post('/', requireRole('admin'), (req, res, next) => {
    try {
      const {
        code,
        name,
        finishedItemId,
        batchDescription = null,
        expectedYieldQty,
        yieldUnit,
        lines,
      } = req.body ?? {};
      if (!code || !name || !finishedItemId || !expectedYieldQty || !yieldUnit || !lines?.length) {
        throw new ValidationError(
          'code, name, finishedItemId, expectedYieldQty, yieldUnit, and lines are required'
        );
      }
      const created = db.transaction(() => {
        const info = db
          .prepare(`
            INSERT INTO bom (code, name, finished_item_id, batch_description, expected_yield_scaled, yield_unit)
            VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(
            code,
            name,
            finishedItemId,
            batchDescription,
            toScaledQty(expectedYieldQty),
            yieldUnit
          );
        const bomId = Number(info.lastInsertRowid);
        const insertLine = db.prepare(`
          INSERT INTO bom_lines (bom_id, item_id, qty_per_batch_scaled, unit, line_type)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const l of lines) {
          const item = db.prepare('SELECT id, unit, item_type FROM items WHERE id = ?').get(l.itemId);
          if (!item) throw new NotFoundError(`BOM line item not found: ${l.itemId}`);
          insertLine.run(
            bomId,
            item.id,
            toScaledQty(l.qtyPerBatch),
            l.unit ?? item.unit,
            l.lineType ?? (item.item_type === 'packaging' ? 'packaging' : 'raw')
          );
        }
        const formatted = formatBom(db, db.prepare('SELECT * FROM bom WHERE id = ?').get(bomId));
        recordAudit(db, {
          actorUserId: req.user.id,
          action: 'BOM_CREATED',
          entityType: 'bom',
          entityId: bomId,
          after: formatted,
        });
        return formatted;
      })();
      return res.status(201).json({ bom: created });
    } catch (err) {
      return next(err);
    }
  });

  router.put('/:id', requireRole('admin'), (req, res, next) => {
    try {
      const bomId = Number(req.params.id);
      const updated = db.transaction(() => {
        const existing = db.prepare('SELECT * FROM bom WHERE id = ?').get(bomId);
        if (!existing) throw new NotFoundError('BOM not found');
        const before = formatBom(db, existing);

        db.prepare(`
          UPDATE bom
          SET name = ?, batch_description = ?, expected_yield_scaled = ?, yield_unit = ?, is_active = ?
          WHERE id = ?
        `).run(
          req.body.name ?? existing.name,
          req.body.batchDescription !== undefined
            ? req.body.batchDescription
            : existing.batch_description,
          req.body.expectedYieldQty !== undefined
            ? toScaledQty(req.body.expectedYieldQty)
            : existing.expected_yield_scaled,
          req.body.yieldUnit ?? existing.yield_unit,
          req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : existing.is_active,
          bomId
        );

        if (Array.isArray(req.body.lines)) {
          db.prepare('DELETE FROM bom_lines WHERE bom_id = ?').run(bomId);
          const insertLine = db.prepare(`
            INSERT INTO bom_lines (bom_id, item_id, qty_per_batch_scaled, unit, line_type)
            VALUES (?, ?, ?, ?, ?)
          `);
          for (const l of req.body.lines) {
            const item = db
              .prepare('SELECT id, unit, item_type FROM items WHERE id = ?')
              .get(l.itemId);
            if (!item) throw new NotFoundError(`BOM line item not found: ${l.itemId}`);
            insertLine.run(
              bomId,
              item.id,
              toScaledQty(l.qtyPerBatch),
              l.unit ?? item.unit,
              l.lineType ?? (item.item_type === 'packaging' ? 'packaging' : 'raw')
            );
          }
        }

        const after = formatBom(db, db.prepare('SELECT * FROM bom WHERE id = ?').get(bomId));
        recordAudit(db, {
          actorUserId: req.user.id,
          action: 'BOM_UPDATED',
          entityType: 'bom',
          entityId: bomId,
          before,
          after,
        });
        return after;
      })();
      return res.json({ bom: updated });
    } catch (err) {
      return next(err);
    }
  });

  router.delete('/:id', requireRole('admin'), (req, res, next) => {
    try {
      const bomId = Number(req.params.id);
      const deactivated = db.transaction(() => {
        const existing = db.prepare('SELECT * FROM bom WHERE id = ?').get(bomId);
        if (!existing) throw new NotFoundError('BOM not found');
        const before = formatBom(db, existing);
        db.prepare('UPDATE bom SET is_active = 0 WHERE id = ?').run(bomId);
        const after = formatBom(db, db.prepare('SELECT * FROM bom WHERE id = ?').get(bomId));
        recordAudit(db, {
          actorUserId: req.user.id,
          action: 'BOM_DEACTIVATED',
          entityType: 'bom',
          entityId: bomId,
          before,
          after,
        });
        return after;
      })();
      return res.json({ bom: deactivated });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

export function createPriceListRouter(db) {
  const router = Router();

  router.get('/', requireRole(...ALL_ROLES), (_req, res) => {
    const entries = db
      .prepare(`
        SELECT pl.*, i.sku, i.name AS item_name, c.name AS customer_name
        FROM price_list pl
        JOIN items i ON i.id = pl.item_id
        LEFT JOIN customers c ON c.id = pl.customer_id
        ORDER BY pl.id
      `)
      .all();
    res.json({ priceList: entries });
  });

  router.get('/:id', requireRole(...ALL_ROLES), (req, res, next) => {
    const entry = db.prepare('SELECT * FROM price_list WHERE id = ?').get(Number(req.params.id));
    if (!entry) return next(new NotFoundError('Price list entry not found'));
    return res.json({ priceEntry: entry });
  });

  router.post('/', requireRole('admin'), (req, res, next) => {
    try {
      const {
        itemId,
        customerId = null,
        pricePaisa,
        effectiveFrom = new Date().toISOString().slice(0, 10),
        effectiveTo = null,
        isActive = true,
      } = req.body ?? {};
      if (!itemId || !Number.isInteger(pricePaisa) || pricePaisa < 0) {
        throw new ValidationError('itemId and non-negative integer pricePaisa are required');
      }

      const created = db.transaction(() => {
        const item = db.prepare('SELECT id FROM items WHERE id = ?').get(itemId);
        if (!item) throw new NotFoundError(`Item not found: ${itemId}`);
        if (customerId !== null) {
          const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
          if (!customer) throw new NotFoundError(`Customer not found: ${customerId}`);
        }

        const activeFlag = isActive ? 1 : 0;
        const info = db
          .prepare(`
            INSERT INTO price_list (item_id, customer_id, price_paisa, effective_from, effective_to, is_active)
            VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(itemId, customerId, pricePaisa, effectiveFrom, effectiveTo, activeFlag);
        const id = Number(info.lastInsertRowid);

        if (customerId === null && activeFlag === 1) {
          db.prepare('UPDATE items SET selling_price_paisa = ? WHERE id = ?').run(pricePaisa, itemId);
        }

        const row = db.prepare('SELECT * FROM price_list WHERE id = ?').get(id);
        recordAudit(db, {
          actorUserId: req.user.id,
          action: 'PRICE_LIST_CREATED',
          entityType: 'price_list',
          entityId: id,
          after: row,
        });
        return row;
      })();

      return res.status(201).json({ priceEntry: created });
    } catch (err) {
      return next(err);
    }
  });

  router.put('/:id', requireRole('admin'), (req, res, next) => {
    try {
      const entryId = Number(req.params.id);
      const updated = db.transaction(() => {
        const before = db.prepare('SELECT * FROM price_list WHERE id = ?').get(entryId);
        if (!before) throw new NotFoundError('Price list entry not found');

        const nextPrice = req.body.pricePaisa ?? before.price_paisa;
        if (!Number.isInteger(nextPrice) || nextPrice < 0) {
          throw new ValidationError('pricePaisa must be a non-negative integer');
        }
        const nextActive =
          req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : before.is_active;

        db.prepare(`
          UPDATE price_list
          SET price_paisa = ?, effective_from = ?, effective_to = ?, is_active = ?
          WHERE id = ?
        `).run(
          nextPrice,
          req.body.effectiveFrom ?? before.effective_from,
          req.body.effectiveTo !== undefined ? req.body.effectiveTo : before.effective_to,
          nextActive,
          entryId
        );

        if (before.customer_id === null && nextActive === 1) {
          db.prepare('UPDATE items SET selling_price_paisa = ? WHERE id = ?').run(
            nextPrice,
            before.item_id
          );
        }

        const after = db.prepare('SELECT * FROM price_list WHERE id = ?').get(entryId);
        recordAudit(db, {
          actorUserId: req.user.id,
          action: 'PRICE_LIST_UPDATED',
          entityType: 'price_list',
          entityId: entryId,
          before,
          after,
        });
        return after;
      })();

      return res.json({ priceEntry: updated });
    } catch (err) {
      return next(err);
    }
  });

  router.delete('/:id', requireRole('admin'), (req, res, next) => {
    try {
      const entryId = Number(req.params.id);
      const deactivated = db.transaction(() => {
        const before = db.prepare('SELECT * FROM price_list WHERE id = ?').get(entryId);
        if (!before) throw new NotFoundError('Price list entry not found');
        db.prepare('UPDATE price_list SET is_active = 0 WHERE id = ?').run(entryId);
        const after = db.prepare('SELECT * FROM price_list WHERE id = ?').get(entryId);
        recordAudit(db, {
          actorUserId: req.user.id,
          action: 'PRICE_LIST_DEACTIVATED',
          entityType: 'price_list',
          entityId: entryId,
          before,
          after,
        });
        return after;
      })();
      return res.json({ priceEntry: deactivated });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
