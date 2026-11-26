import { Router } from 'express';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { bpsToPercent, fromScaledQty } from '../lib/units.js';
import { ALL_ROLES, requireRole } from '../middleware/auth.js';
import { recordProductionRun } from '../services/production.js';

function getToleranceBps(db) {
  const settings = db
    .prepare('SELECT variance_tolerance_bps FROM company_settings WHERE id = 1')
    .get();
  return settings?.variance_tolerance_bps ?? 300;
}

function formatProductionRun(db, runRow) {
  const toleranceBps = getToleranceBps(db);
  const bom = db.prepare('SELECT id, code, name, finished_item_id FROM bom WHERE id = ?').get(runRow.bom_id);

  const consumptionRows = db
    .prepare(`
      SELECT prc.*, i.sku, i.name AS item_name, i.unit, i.item_type
      FROM production_run_consumptions prc
      JOIN items i ON i.id = prc.item_id
      WHERE prc.production_run_id = ?
      ORDER BY prc.id
    `)
    .all(runRow.id);

  const consumptions = consumptionRows.map((c) => ({
    itemId: c.item_id,
    sku: c.sku,
    itemName: c.item_name,
    itemType: c.item_type,
    unit: c.unit,
    expectedQty: fromScaledQty(c.expected_qty_scaled),
    actualQty: fromScaledQty(c.actual_qty_scaled),
    damagedQty: fromScaledQty(c.damaged_qty_scaled),
    totalIssuedQty: fromScaledQty(c.total_issued_scaled),
    varianceQty: fromScaledQty(c.variance_scaled),
    varianceBps: c.variance_bps,
    variancePercent: bpsToPercent(c.variance_bps),
    flagged: Math.abs(c.variance_bps) > toleranceBps,
  }));

  const yieldFlagged = Math.abs(runRow.yield_variance_bps) > toleranceBps;
  const flaggedVariances = [];
  if (yieldFlagged) {
    flaggedVariances.push({
      type: 'yield',
      varianceBps: runRow.yield_variance_bps,
      variancePercent: bpsToPercent(runRow.yield_variance_bps),
      toleranceBps,
    });
  }
  for (const c of consumptions) {
    if (c.flagged) {
      flaggedVariances.push({
        type: 'consumption',
        itemId: c.itemId,
        sku: c.sku,
        varianceBps: c.varianceBps,
        variancePercent: c.variancePercent,
        toleranceBps,
      });
    }
  }

  return {
    id: runRow.id,
    runNumber: runRow.run_number,
    bomId: runRow.bom_id,
    bomCode: bom?.code,
    productId: bom?.finished_item_id,
    batchesPlanned: fromScaledQty(runRow.batches_planned_scaled),
    runDate: runRow.run_date,
    status: runRow.status,
    toleranceBps,
    yield: {
      expectedQty: fromScaledQty(runRow.expected_yield_scaled),
      actualGoodQty: fromScaledQty(runRow.actual_good_yield_scaled),
      varianceQty: fromScaledQty(runRow.yield_variance_scaled),
      varianceBps: runRow.yield_variance_bps,
      variancePercent: bpsToPercent(runRow.yield_variance_bps),
      flagged: yieldFlagged,
    },
    consumptions,
    hasVarianceFlags: flaggedVariances.length > 0,
    flaggedVariances,
    notes: runRow.notes,
    createdBy: runRow.created_by,
    createdAt: runRow.created_at,
  };
}

export function createProductionRunsRouter(db) {
  const router = Router();

  router.get('/', requireRole(...ALL_ROLES), (_req, res) => {
    const rows = db.prepare('SELECT * FROM production_runs ORDER BY id DESC').all();
    res.json({ productionRuns: rows.map((r) => formatProductionRun(db, r)) });
  });

  router.get('/:id', requireRole(...ALL_ROLES), (req, res, next) => {
    const row = db.prepare('SELECT * FROM production_runs WHERE id = ?').get(Number(req.params.id));
    if (!row) return next(new NotFoundError('Production run not found'));
    return res.json({ productionRun: formatProductionRun(db, row) });
  });

  router.post('/', requireRole('production', 'admin'), (req, res, next) => {
    try {
      const {
        runNumber,
        bomId,
        productId,
        productSku,
        batches = 1,
        batchesPlanned,
        runDate = new Date().toISOString().slice(0, 10),
        rawIssues,
        consumptions,
        goodPackets,
        goodYieldQty,
        damagedPouches = 0,
        cartonsUsed = 0,
        notes = null,
      } = req.body ?? {};

      // Resolve BOM from bomId, productId, or productSku
      let resolvedBom = null;
      if (bomId) {
        resolvedBom = db.prepare('SELECT * FROM bom WHERE id = ? AND is_active = 1').get(bomId);
      } else {
        let finishedItemId = productId;
        if (!finishedItemId && productSku) {
          const item = db.prepare('SELECT id FROM items WHERE sku = ?').get(productSku);
          if (!item) throw new NotFoundError(`Product SKU not found: ${productSku}`);
          finishedItemId = item.id;
        }
        if (finishedItemId) {
          resolvedBom = db
            .prepare('SELECT * FROM bom WHERE finished_item_id = ? AND is_active = 1 ORDER BY id LIMIT 1')
            .get(finishedItemId);
        }
      }

      if (!resolvedBom) {
        throw new ValidationError('Valid bomId, productId, or productSku with an active BOM is required');
      }

      const resolvedGoodYield = goodPackets ?? goodYieldQty;
      if (resolvedGoodYield === undefined || resolvedGoodYield === null) {
        throw new ValidationError('goodPackets (or goodYieldQty) is required');
      }

      let resolvedConsumptions = consumptions;
      if (!resolvedConsumptions) {
        if (!Array.isArray(rawIssues) || rawIssues.length === 0) {
          throw new ValidationError('rawIssues (or consumptions) must be a non-empty array');
        }

        resolvedConsumptions = rawIssues.map((entry) => {
          let itemId = entry.itemId;
          if (!itemId && entry.sku) {
            const found = db.prepare('SELECT id FROM items WHERE sku = ?').get(entry.sku);
            if (!found) throw new NotFoundError(`Raw item SKU not found: ${entry.sku}`);
            itemId = found.id;
          }
          if (!itemId) {
            throw new ValidationError('Each rawIssue entry requires itemId or sku');
          }
          return {
            itemId,
            actualQty: entry.qty ?? entry.actualQty,
            damagedQty: entry.damagedQty ?? 0,
          };
        });

        const packagingBomLines = db
          .prepare(`
            SELECT bl.*, i.sku, i.unit
            FROM bom_lines bl
            JOIN items i ON i.id = bl.item_id
            WHERE bl.bom_id = ? AND bl.line_type = 'packaging'
          `)
          .all(resolvedBom.id);

        const pouchLine = packagingBomLines.find(
          (l) => l.unit === 'pouch' || l.sku.includes('POUCH')
        );
        if (pouchLine && (Number(resolvedGoodYield) > 0 || Number(damagedPouches) > 0)) {
          resolvedConsumptions.push({
            itemId: pouchLine.item_id,
            actualQty: resolvedGoodYield,
            damagedQty: damagedPouches,
          });
        }

        const cartonLine = packagingBomLines.find(
          (l) => l.unit === 'carton' || l.sku.includes('CARTON')
        );
        if (cartonLine && Number(cartonsUsed) > 0) {
          resolvedConsumptions.push({
            itemId: cartonLine.item_id,
            actualQty: cartonsUsed,
            damagedQty: 0,
          });
        }
      }

      const created = recordProductionRun(db, {
        runNumber,
        bomId: resolvedBom.id,
        batchesPlanned: batchesPlanned ?? batches,
        runDate,
        consumptions: resolvedConsumptions,
        goodYieldQty: resolvedGoodYield,
        notes,
        actorUserId: req.user.id,
      });

      const runRow = db.prepare('SELECT * FROM production_runs WHERE id = ?').get(created.id);
      return res.status(201).json({ productionRun: formatProductionRun(db, runRow) });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
