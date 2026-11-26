import { NotFoundError, ValidationError } from '../lib/errors.js';
import { fromScaledQty, mulScaledQtyByPaisa, paisaToRupees, QTY_SCALE } from '../lib/units.js';
import { recordAudit } from './audit.js';

const QTY_SCALE_BIG = BigInt(QTY_SCALE);

function roundDivBigInt(numerator, denominator) {
  if (denominator <= 0n) {
    throw new Error('Denominator must be positive');
  }
  const sign = numerator < 0n ? -1n : 1n;
  const abs = numerator < 0n ? -numerator : numerator;
  return Number(sign * ((abs + denominator / 2n) / denominator));
}

/**
 * Compute weighted average pool state (qtyScaled, valuePaisa) for an item
 * from stock_ledger up to the start of a target production run's issues.
 */
function computeWeightedAvgAtIssue(db, itemId, runId) {
  const rows = db
    .prepare('SELECT * FROM stock_ledger WHERE item_id = ? ORDER BY id ASC')
    .all(itemId);

  let runningQtyScaled = 0n;
  let runningValuePaisa = 0n;

  let poolQtyAtIssue = null;
  let poolValueAtIssue = null;
  let runIssuedQtyScaled = 0n;

  for (const row of rows) {
    const isTargetIssue =
      (row.source_type === 'production_issue' || row.source_type === 'production_damage') &&
      row.source_id === runId;

    if (isTargetIssue) {
      if (poolQtyAtIssue === null) {
        poolQtyAtIssue = runningQtyScaled;
        poolValueAtIssue = runningValuePaisa;
      }
      runIssuedQtyScaled += BigInt(Math.abs(row.qty_scaled));
      continue;
    }

    if (poolQtyAtIssue !== null) {
      break;
    }

    if (row.qty_scaled > 0) {
      const inflowQty = BigInt(row.qty_scaled);
      const inflowValue = BigInt(mulScaledQtyByPaisa(row.qty_scaled, row.unit_cost_paisa));
      runningQtyScaled += inflowQty;
      runningValuePaisa += inflowValue;
    } else if (row.qty_scaled < 0 && runningQtyScaled > 0n) {
      const outflowQty = BigInt(-row.qty_scaled);
      const outflowValue = BigInt(
        roundDivBigInt(runningValuePaisa * outflowQty, runningQtyScaled)
      );
      runningQtyScaled = runningQtyScaled - outflowQty;
      runningValuePaisa = runningValuePaisa - outflowValue;
    }
  }

  if (poolQtyAtIssue === null || poolQtyAtIssue <= 0n) {
    return {
      poolQtyScaled: 0,
      poolValuePaisa: 0,
      issuedQtyScaled: Number(runIssuedQtyScaled),
      weightedAvgRatePaisa: 0,
      weightedAvgRateRupees: 0,
      totalCostPaisa: 0,
    };
  }

  const totalCostPaisa = roundDivBigInt(
    poolValueAtIssue * runIssuedQtyScaled,
    poolQtyAtIssue
  );
  // Weighted average unit cost in integer paisa (rounded) and exact decimal rupees (up to 6 decimals)
  const weightedAvgRatePaisa = roundDivBigInt(poolValueAtIssue * QTY_SCALE_BIG, poolQtyAtIssue);
  const rateScaled1e4Paisa = roundDivBigInt(
    poolValueAtIssue * QTY_SCALE_BIG * 10_000n,
    poolQtyAtIssue
  );
  const weightedAvgRateRupees = Number((rateScaled1e4Paisa / 1_000_000).toFixed(6));

  return {
    poolQtyScaled: Number(poolQtyAtIssue),
    poolQty: fromScaledQty(Number(poolQtyAtIssue)),
    poolValuePaisa: Number(poolValueAtIssue),
    issuedQtyScaled: Number(runIssuedQtyScaled),
    issuedQty: fromScaledQty(Number(runIssuedQtyScaled)),
    weightedAvgRatePaisa,
    weightedAvgRateRupees,
    totalCostPaisa,
  };
}

export function addProductionOverheads(db, { productionRunId, overheads, actorUserId = null }) {
  if (!Array.isArray(overheads) || overheads.length === 0) {
    throw new ValidationError('At least one overhead entry is required');
  }

  const runTx = db.transaction(() => {
    const run = db.prepare('SELECT id, run_number FROM production_runs WHERE id = ?').get(productionRunId);
    if (!run) {
      throw new NotFoundError(`Production run not found: ${productionRunId}`);
    }

    const insert = db.prepare(`
      INSERT INTO production_run_overheads (production_run_id, category, description, amount_paisa, created_by)
      VALUES (?, ?, ?, ?, ?)
    `);

    const inserted = [];
    for (const entry of overheads) {
      const category = entry.category;
      if (!['labour', 'power', 'gas', 'other'].includes(category)) {
        throw new ValidationError(`Invalid overhead category: ${category}`);
      }
      if (!Number.isInteger(entry.amountPaisa) || entry.amountPaisa < 0) {
        throw new ValidationError(`amountPaisa must be a non-negative integer for ${category}`);
      }
      const info = insert.run(
        productionRunId,
        category,
        entry.description ?? null,
        entry.amountPaisa,
        actorUserId
      );
      inserted.push({
        id: Number(info.lastInsertRowid),
        category,
        description: entry.description ?? null,
        amountPaisa: entry.amountPaisa,
      });
    }

    recordAudit(db, {
      actorUserId,
      action: 'PRODUCTION_OVERHEADS_RECORDED',
      entityType: 'production_run',
      entityId: productionRunId,
      after: { runNumber: run.run_number, overheads: inserted },
    });

    return inserted;
  });

  return runTx();
}

export function getProductionRunCost(db, productionRunId) {
  const run = db.prepare('SELECT * FROM production_runs WHERE id = ?').get(productionRunId);
  if (!run) {
    throw new NotFoundError(`Production run not found: ${productionRunId}`);
  }

  const bom = db.prepare('SELECT * FROM bom WHERE id = ?').get(run.bom_id);
  const finishedItem = db
    .prepare('SELECT id, sku, name, unit, selling_price_paisa FROM items WHERE id = ?')
    .get(bom.finished_item_id);

  const consumptions = db
    .prepare(`
      SELECT prc.*, i.sku, i.name AS item_name, i.unit, i.item_type
      FROM production_run_consumptions prc
      JOIN items i ON i.id = prc.item_id
      WHERE prc.production_run_id = ?
      ORDER BY prc.id
    `)
    .all(productionRunId);

  let totalMaterialCostPaisa = 0;
  const materialCosts = consumptions.map((c) => {
    const valuation = computeWeightedAvgAtIssue(db, c.item_id, productionRunId);
    totalMaterialCostPaisa += valuation.totalCostPaisa;
    return {
      itemId: c.item_id,
      sku: c.sku,
      itemName: c.item_name,
      itemType: c.item_type,
      unit: c.unit,
      poolQtyAtIssue: valuation.poolQty,
      poolValuePaisaAtIssue: valuation.poolValuePaisa,
      issuedQty: fromScaledQty(c.total_issued_scaled),
      actualQty: fromScaledQty(c.actual_qty_scaled),
      damagedQty: fromScaledQty(c.damaged_qty_scaled),
      weightedAvgRatePaisa: valuation.weightedAvgRatePaisa,
      weightedAvgRateRupees: valuation.weightedAvgRateRupees,
      costPaisa: valuation.totalCostPaisa,
      costRupees: paisaToRupees(valuation.totalCostPaisa),
    };
  });

  const overheadRows = db
    .prepare('SELECT * FROM production_run_overheads WHERE production_run_id = ? ORDER BY id')
    .all(productionRunId);

  const overheadsByCategory = { labour: 0, power: 0, gas: 0, other: 0 };
  let totalOverheadsPaisa = 0;
  for (const row of overheadRows) {
    overheadsByCategory[row.category] += row.amount_paisa;
    totalOverheadsPaisa += row.amount_paisa;
  }

  const totalCostPaisa = totalMaterialCostPaisa + totalOverheadsPaisa;
  const goodPacketsScaled = run.actual_good_yield_scaled;
  const goodPackets = fromScaledQty(goodPacketsScaled);

  let costPerPacketPaisa = 0;
  let costPerPacketRupees = 0;
  if (goodPacketsScaled > 0) {
    costPerPacketPaisa = roundDivBigInt(
      BigInt(totalCostPaisa) * QTY_SCALE_BIG,
      BigInt(goodPacketsScaled)
    );
    const exactPaiseScaled = roundDivBigInt(
      BigInt(totalCostPaisa) * QTY_SCALE_BIG * 100n,
      BigInt(goodPacketsScaled)
    );
    costPerPacketRupees = Number((exactPaiseScaled / 10_000).toFixed(4));
  }

  const sellingPricePaisa = finishedItem.selling_price_paisa;
  const totalSalesValuePaisa = mulScaledQtyByPaisa(goodPacketsScaled, sellingPricePaisa);
  const totalMarginPaisa = totalSalesValuePaisa - totalCostPaisa;
  const marginPerPacketPaisa = sellingPricePaisa - costPerPacketPaisa;
  const marginBps =
    totalSalesValuePaisa > 0
      ? roundDivBigInt(BigInt(totalMarginPaisa) * 10_000n, BigInt(totalSalesValuePaisa))
      : 0;

  return {
    productionRunId: run.id,
    runNumber: run.run_number,
    product: {
      itemId: finishedItem.id,
      sku: finishedItem.sku,
      name: finishedItem.name,
      unit: finishedItem.unit,
      sellingPricePaisa,
      sellingPriceRupees: paisaToRupees(sellingPricePaisa),
    },
    goodPackets,
    materials: materialCosts,
    totalMaterialCostPaisa,
    totalMaterialCostRupees: paisaToRupees(totalMaterialCostPaisa),
    overheads: {
      entries: overheadRows.map((o) => ({
        id: o.id,
        category: o.category,
        description: o.description,
        amountPaisa: o.amount_paisa,
      })),
      byCategoryPaisa: overheadsByCategory,
      totalOverheadsPaisa,
      totalOverheadsRupees: paisaToRupees(totalOverheadsPaisa),
    },
    totalCostPaisa,
    totalCostRupees: paisaToRupees(totalCostPaisa),
    costPerPacketPaisa,
    costPerPacketRupees,
    margin: {
      totalSalesValuePaisa,
      totalMarginPaisa,
      marginPerPacketPaisa,
      marginPerPacketRupees: paisaToRupees(marginPerPacketPaisa),
      marginBps,
      marginPercent: marginBps / 100,
    },
  };
}
