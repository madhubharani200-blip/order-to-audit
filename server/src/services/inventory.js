import { fromScaledQty, mulScaled, toScaledQty } from '../lib/units.js';

export function getStockBalanceScaled(db, itemId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(qty_scaled), 0) AS balance_scaled FROM stock_ledger WHERE item_id = ?')
    .get(itemId);
  return row.balance_scaled;
}

export function getStockBalance(db, itemId) {
  const item = db.prepare('SELECT id, sku, name, item_type, unit FROM items WHERE id = ?').get(itemId);
  if (!item) {
    throw new Error(`Item not found: ${itemId}`);
  }
  const balanceScaled = getStockBalanceScaled(db, itemId);
  return {
    itemId: item.id,
    sku: item.sku,
    name: item.name,
    itemType: item.item_type,
    unit: item.unit,
    balanceScaled,
    balanceQty: fromScaledQty(balanceScaled),
  };
}

export function getStockBalanceBySku(db, sku) {
  const item = db.prepare('SELECT id FROM items WHERE sku = ?').get(sku);
  if (!item) {
    throw new Error(`Item SKU not found: ${sku}`);
  }
  return getStockBalance(db, item.id);
}

export function getAllStockBalances(db) {
  return db.prepare('SELECT * FROM v_stock_balance ORDER BY item_id').all();
}

export function appendStockMovement(
  db,
  { itemId, qtyScaled, unit, unitCostPaisa = 0, sourceType, sourceId, notes = null, createdBy = null }
) {
  if (!Number.isInteger(qtyScaled) || qtyScaled === 0) {
    throw new Error(`qtyScaled must be a non-zero integer, got: ${qtyScaled}`);
  }
  if (!Number.isInteger(unitCostPaisa) || unitCostPaisa < 0) {
    throw new Error(`unitCostPaisa must be a non-negative integer, got: ${unitCostPaisa}`);
  }
  const info = db
    .prepare(`
      INSERT INTO stock_ledger (item_id, qty_scaled, unit, unit_cost_paisa, source_type, source_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(itemId, qtyScaled, unit, unitCostPaisa, sourceType, sourceId, notes, createdBy);
  return Number(info.lastInsertRowid);
}

export function convertQty(db, { itemId = null, qty, fromUnit, toUnit }) {
  const qtyScaled = toScaledQty(qty);
  if (fromUnit === toUnit) {
    return { qtyScaled, qty: fromScaledQty(qtyScaled), unit: toUnit };
  }

  let conv = null;
  if (itemId !== null) {
    conv = db
      .prepare(
        'SELECT multiplier_scaled FROM unit_conversions WHERE item_id = ? AND from_unit = ? AND to_unit = ?'
      )
      .get(itemId, fromUnit, toUnit);
  }
  if (!conv) {
    conv = db
      .prepare(
        'SELECT multiplier_scaled FROM unit_conversions WHERE item_id IS NULL AND from_unit = ? AND to_unit = ?'
      )
      .get(fromUnit, toUnit);
  }
  if (!conv) {
    throw new Error(`No unit conversion found from ${fromUnit} to ${toUnit} (itemId=${itemId})`);
  }

  const convertedScaled = mulScaled(qtyScaled, conv.multiplier_scaled);
  return {
    qtyScaled: convertedScaled,
    qty: fromScaledQty(convertedScaled),
    unit: toUnit,
  };
}
