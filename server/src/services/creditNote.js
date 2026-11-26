import { NotFoundError, ValidationError } from '../lib/errors.js';
import { fromScaledQty } from '../lib/units.js';
import { recordAudit } from './audit.js';
import { appendStockMovement } from './inventory.js';

/**
 * POST /invoices/:id/credit-note
 *
 * Creates a credit note that:
 *  1. Marks the original invoice as 'credit_note' (never deleted).
 *  2. Reverses each dispatch stock movement (restores finished goods).
 *  3. Records credit note details in audit_log.
 *
 * Rules enforced:
 *  - Invoice must be in status 'issued' | 'partially_paid' | 'paid'.
 *  - A credit note cannot be raised against a cancelled or already-reversed invoice.
 *  - Payments already received are NOT auto-refunded (physical refund is a separate payment
 *    with negative amount or handled offline).
 */
export function issueCreditNote(db, { invoiceId, reason, actorUserId = null }) {
  if (!reason || !String(reason).trim()) {
    throw new ValidationError('reason is required for a credit note');
  }

  const runTx = db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) {
      throw new NotFoundError(`Invoice not found: ${invoiceId}`);
    }
    if (!['issued', 'partially_paid', 'paid'].includes(invoice.status)) {
      throw new ValidationError(
        `Credit note can only be raised against an issued/partially_paid/paid invoice, not '${invoice.status}'`
      );
    }

    // Check no existing credit note for this invoice
    const existingCn = db
      .prepare("SELECT id FROM invoices WHERE order_id IS NULL AND id != ? AND status = 'credit_note' AND invoice_number LIKE ?")
      .get(invoiceId, `CN/${invoice.invoice_number}%`);
    if (existingCn) {
      throw new ValidationError(`A credit note already exists for invoice ${invoice.invoice_number}`);
    }

    const company = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
    const lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id').all(invoiceId);

    // Build credit note invoice_number
    const cnNumber = `CN/${invoice.invoice_number}`;

    // Allocate a unique negative seq_number for this financial year
    const minSeqRow = db
      .prepare("SELECT COALESCE(MIN(seq_number), 0) AS min_seq FROM invoices WHERE seq_number < 0 AND financial_year = ?")
      .get(invoice.financial_year);
    const cnSeqNumber = (minSeqRow?.min_seq ?? 0) - 1; // e.g. -1, -2, -3 …

    // Reverse stock: restore each dispatched item
    // Note: order_id is NULL on CN rows — the original invoice is encoded in the invoice_number (CN/INV-...)
    const cnInfo = db.prepare(`
      INSERT INTO invoices (
        invoice_number, financial_year, seq_number, customer_id, order_id,
        invoice_date, place_of_supply_state, supply_type,
        subtotal_paisa, cgst_paisa, sgst_paisa, igst_paisa,
        total_tax_paisa, grand_total_paisa, status, created_by
      )
      VALUES (?, ?, ?, ?, NULL, date('now'), ?, ?, ?, ?, ?, ?, ?, ?, 'credit_note', ?)
    `).run(
      cnNumber,
      invoice.financial_year,
      cnSeqNumber, // unique negative seq for this FY
      invoice.customer_id,
      invoice.place_of_supply_state,
      invoice.supply_type,
      invoice.subtotal_paisa,         // stored positive; sign implied by 'credit_note' status
      invoice.cgst_paisa,
      invoice.sgst_paisa,
      invoice.igst_paisa,
      invoice.total_tax_paisa,
      invoice.grand_total_paisa,
      actorUserId
    );
    const cnId = Number(cnInfo.lastInsertRowid);

    // Mirror credit note lines (all quantities positive, values negated handled by context)
    const insertCnLine = db.prepare(`
      INSERT INTO invoice_lines (
        invoice_id, item_id, hsn_code, qty_scaled, unit, unit_price_paisa,
        taxable_value_paisa, gst_rate_bps, cgst_paisa, sgst_paisa, igst_paisa, line_total_paisa
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const line of lines) {
      insertCnLine.run(
        cnId,
        line.item_id,
        line.hsn_code,
        line.qty_scaled,
        line.unit,
        line.unit_price_paisa,
        line.taxable_value_paisa,
        line.gst_rate_bps,
        line.cgst_paisa,
        line.sgst_paisa,
        line.igst_paisa,
        line.line_total_paisa
      );

      // Restore stock: reverse the dispatch
      appendStockMovement(db, {
        itemId: line.item_id,
        qtyScaled: line.qty_scaled, // positive = stock back in
        unit: line.unit,
        unitCostPaisa: 0,
        sourceType: 'return',
        sourceId: cnId,
        notes: `Credit note ${cnNumber} reverses dispatch of invoice ${invoice.invoice_number}`,
        createdBy: actorUserId,
      });
    }

    // Mark original invoice as credit_note
    db.prepare("UPDATE invoices SET status = 'credit_note' WHERE id = ?").run(invoiceId);

    // Reverse any invoice-linked payment statuses (payments stay; just unlink status effect)
    // The original invoice status is now 'credit_note' so outstanding computation excludes it.

    recordAudit(db, {
      actorUserId,
      action: 'CREDIT_NOTE_ISSUED',
      entityType: 'invoice',
      entityId: cnId,
      before: { invoiceId, status: invoice.status },
      after: { creditNoteId: cnId, creditNoteNumber: cnNumber, reason },
      reason,
    });

    return {
      creditNoteId: cnId,
      creditNoteNumber: cnNumber,
      originalInvoiceId: invoiceId,
      originalInvoiceNumber: invoice.invoice_number,
      linesReversed: lines.length,
    };
  });

  return runTx();
}
