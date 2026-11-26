import {
  bpsToPercent,
  calcVarianceBps,
  fromScaledQty,
  mulScaled,
  toScaledQty,
} from '../lib/units.js';
import { recordAudit } from './audit.js';
import { appendStockMovement, getStockBalanceScaled } from './inventory.js';

export function recordProductionRun(
  db,
  {
    runNumber,
    bomId,
    batchesPlanned = 1,
    runDate,
    consumptions,
    goodYieldQty,
    notes = null,
    actorUserId = null,
  }
) {
  const runTx = db.transaction(() => {
    const bom = db.prepare('SELECT * FROM bom WHERE id = ?').get(bomId);
    if (!bom) {
      throw new Error(`BOM not found: ${bomId}`);
    }
    const bomLines = db.prepare('SELECT * FROM bom_lines WHERE bom_id = ?').all(bomId);
    const bomLineByItem = new Map(bomLines.map((l) => [l.item_id, l]));

    const batchesPlannedScaled = toScaledQty(batchesPlanned);
    if (batchesPlannedScaled <= 0) {
      throw new Error(`batchesPlanned must be positive, got: ${batchesPlanned}`);
    }

    const expectedYieldScaled = mulScaled(bom.expected_yield_scaled, batchesPlannedScaled);
    const actualGoodYieldScaled = toScaledQty(goodYieldQty);
    const yieldVarianceScaled = actualGoodYieldScaled - expectedYieldScaled;
    const yieldVarianceBps = calcVarianceBps(actualGoodYieldScaled, expectedYieldScaled);

    const resolvedRunNumber =
      runNumber ?? `PRD-${runDate.replaceAll('-', '')}-${Date.now()}`;

    const runInfo = db
      .prepare(`
        INSERT INTO production_runs (
          run_number, bom_id, batches_planned_scaled, expected_yield_scaled,
          actual_good_yield_scaled, yield_variance_scaled, yield_variance_bps,
          status, run_date, notes, created_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
      `)
      .run(
        resolvedRunNumber,
        bomId,
        batchesPlannedScaled,
        expectedYieldScaled,
        actualGoodYieldScaled,
        yieldVarianceScaled,
        yieldVarianceBps,
        runDate,
        notes,
        actorUserId
      );
    const runId = Number(runInfo.lastInsertRowid);

    const insertConsumption = db.prepare(`
      INSERT INTO production_run_consumptions (
        production_run_id, item_id, expected_qty_scaled, actual_qty_scaled,
        damaged_qty_scaled, total_issued_scaled, variance_scaled, variance_bps
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const consumptionResults = [];

    for (const entry of consumptions) {
      const item = db
        .prepare('SELECT id, sku, unit, standard_cost_paisa FROM items WHERE id = ?')
        .get(entry.itemId);
      if (!item) {
        throw new Error(`Item not found: ${entry.itemId}`);
      }

      const actualQtyScaled = toScaledQty(entry.actualQty ?? 0);
      const damagedQtyScaled = toScaledQty(entry.damagedQty ?? 0);
      const totalIssuedScaled = actualQtyScaled + damagedQtyScaled;
      if (totalIssuedScaled <= 0) {
        throw new Error(`Issued quantity must be positive for item ${item.sku}`);
      }

      const availableScaled = getStockBalanceScaled(db, item.id);
      if (availableScaled < totalIssuedScaled) {
        throw new Error(
          `Insufficient stock for ${item.sku}: available ${fromScaledQty(availableScaled)} ${item.unit}, needed ${fromScaledQty(totalIssuedScaled)} ${item.unit}`
        );
      }

      const bomLine = bomLineByItem.get(item.id);
      const expectedQtyScaled = bomLine
        ? mulScaled(bomLine.qty_per_batch_scaled, batchesPlannedScaled)
        : 0;
      const varianceScaled = totalIssuedScaled - expectedQtyScaled;
      const varianceBps =
        expectedQtyScaled > 0 ? calcVarianceBps(totalIssuedScaled, expectedQtyScaled) : 0;

      insertConsumption.run(
        runId,
        item.id,
        expectedQtyScaled,
        actualQtyScaled,
        damagedQtyScaled,
        totalIssuedScaled,
        varianceScaled,
        varianceBps
      );

      if (actualQtyScaled > 0) {
        appendStockMovement(db, {
          itemId: item.id,
          qtyScaled: -actualQtyScaled,
          unit: item.unit,
          unitCostPaisa: item.standard_cost_paisa,
          sourceType: 'production_issue',
          sourceId: runId,
          notes: `Production ${resolvedRunNumber} issue`,
          createdBy: actorUserId,
        });
      }

      if (damagedQtyScaled > 0) {
        appendStockMovement(db, {
          itemId: item.id,
          qtyScaled: -damagedQtyScaled,
          unit: item.unit,
          unitCostPaisa: item.standard_cost_paisa,
          sourceType: 'production_damage',
          sourceId: runId,
          notes: `Production ${resolvedRunNumber} damaged/waste`,
          createdBy: actorUserId,
        });
      }

      consumptionResults.push({
        itemId: item.id,
        sku: item.sku,
        expectedQty: fromScaledQty(expectedQtyScaled),
        actualQty: fromScaledQty(actualQtyScaled),
        damagedQty: fromScaledQty(damagedQtyScaled),
        totalIssuedQty: fromScaledQty(totalIssuedScaled),
        varianceBps,
        variancePercent: bpsToPercent(varianceBps),
      });
    }

    const finishedItem = db
      .prepare('SELECT id, unit, standard_cost_paisa FROM items WHERE id = ?')
      .get(bom.finished_item_id);

    if (actualGoodYieldScaled > 0) {
      appendStockMovement(db, {
        itemId: finishedItem.id,
        qtyScaled: actualGoodYieldScaled,
        unit: finishedItem.unit,
        unitCostPaisa: finishedItem.standard_cost_paisa,
        sourceType: 'production_output',
        sourceId: runId,
        notes: `Production ${resolvedRunNumber} good output`,
        createdBy: actorUserId,
      });
    }

    const result = {
      id: runId,
      runNumber: resolvedRunNumber,
      expectedYieldQty: fromScaledQty(expectedYieldScaled),
      actualGoodYieldQty: fromScaledQty(actualGoodYieldScaled),
      yieldVarianceBps,
      yieldVariancePercent: bpsToPercent(yieldVarianceBps),
      consumptions: consumptionResults,
    };

    recordAudit(db, {
      actorUserId,
      action: 'PRODUCTION_RUN_RECORDED',
      entityType: 'production_run',
      entityId: runId,
      after: result,
    });

    return result;
  });

  return runTx();
}
