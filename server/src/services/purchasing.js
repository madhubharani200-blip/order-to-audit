import { mulScaledQtyByPaisa, toScaledQty } from '../lib/units.js';
import { recordAudit } from './audit.js';
import { appendStockMovement } from './inventory.js';

export function recordPurchase(
  db,
  { purchaseNumber, supplierName, purchaseDate, lines, notes = null, actorUserId = null }
) {
  if (!lines || lines.length === 0) {
    throw new Error('Purchase must contain at least one line');
  }

  const runTx = db.transaction(() => {
    let totalAmountPaisa = 0;
    const preparedLines = lines.map((line) => {
      const item = db.prepare('SELECT id, unit FROM items WHERE id = ?').get(line.itemId);
      if (!item) {
        throw new Error(`Item not found: ${line.itemId}`);
      }
      const qtyScaled = toScaledQty(line.qty);
      if (qtyScaled <= 0) {
        throw new Error(`Purchase qty must be positive, got: ${line.qty}`);
      }
      if (!Number.isInteger(line.ratePaisa) || line.ratePaisa < 0) {
        throw new Error(`ratePaisa must be a non-negative integer, got: ${line.ratePaisa}`);
      }
      const unit = line.unit ?? item.unit;
      if (unit !== item.unit) {
        throw new Error(`Purchase unit ${unit} does not match item stock unit ${item.unit}`);
      }
      const lineTotalPaisa = mulScaledQtyByPaisa(qtyScaled, line.ratePaisa);
      totalAmountPaisa += lineTotalPaisa;
      return {
        itemId: item.id,
        qtyScaled,
        unit,
        ratePaisa: line.ratePaisa,
        lineTotalPaisa,
      };
    });

    const resolvedNumber =
      purchaseNumber ?? `PUR-${purchaseDate.replaceAll('-', '')}-${Date.now()}`;

    const purchaseInfo = db
      .prepare(`
        INSERT INTO purchases (purchase_number, supplier_name, purchase_date, total_amount_paisa, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(resolvedNumber, supplierName, purchaseDate, totalAmountPaisa, notes, actorUserId);
    const purchaseId = Number(purchaseInfo.lastInsertRowid);

    const insertLine = db.prepare(`
      INSERT INTO purchase_lines (purchase_id, item_id, qty_scaled, unit, rate_paisa, line_total_paisa)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const line of preparedLines) {
      insertLine.run(
        purchaseId,
        line.itemId,
        line.qtyScaled,
        line.unit,
        line.ratePaisa,
        line.lineTotalPaisa
      );
      appendStockMovement(db, {
        itemId: line.itemId,
        qtyScaled: line.qtyScaled,
        unit: line.unit,
        unitCostPaisa: line.ratePaisa,
        sourceType: 'purchase',
        sourceId: purchaseId,
        notes: `Purchase ${resolvedNumber} from ${supplierName}`,
        createdBy: actorUserId,
      });
    }

    recordAudit(db, {
      actorUserId,
      action: 'PURCHASE_RECORDED',
      entityType: 'purchase',
      entityId: purchaseId,
      after: { purchaseNumber: resolvedNumber, supplierName, totalAmountPaisa, lines: preparedLines },
    });

    return {
      id: purchaseId,
      purchaseNumber: resolvedNumber,
      totalAmountPaisa,
      lines: preparedLines,
    };
  });

  return runTx();
}
