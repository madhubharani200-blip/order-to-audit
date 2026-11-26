import {
  calcGstSplit,
  fromScaledQty,
  getFinancialYear,
  mulScaledQtyByPaisa,
  toScaledQty,
} from '../lib/units.js';
import { recordAudit } from './audit.js';
import { appendStockMovement, getStockBalanceScaled } from './inventory.js';

export function createOrder(
  db,
  { orderNumber, customerId, orderDate, lines, notes = null, actorUserId = null }
) {
  if (!lines || lines.length === 0) {
    throw new Error('Order must contain at least one line');
  }

  const runTx = db.transaction(() => {
    const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
    if (!customer) {
      throw new Error(`Customer not found: ${customerId}`);
    }

    let totalAmountPaisa = 0;
    const prepared = lines.map((line) => {
      const item = db
        .prepare('SELECT id, unit, selling_price_paisa FROM items WHERE id = ?')
        .get(line.itemId);
      if (!item) {
        throw new Error(`Item not found: ${line.itemId}`);
      }
      const qtyScaled = toScaledQty(line.qty);
      const unitPricePaisa = line.unitPricePaisa ?? item.selling_price_paisa;
      const lineTotalPaisa = mulScaledQtyByPaisa(qtyScaled, unitPricePaisa);
      totalAmountPaisa += lineTotalPaisa;
      return {
        itemId: item.id,
        qtyScaled,
        unit: item.unit,
        unitPricePaisa,
        lineTotalPaisa,
      };
    });

    const resolvedNumber = orderNumber ?? `ORD-${orderDate.replaceAll('-', '')}-${Date.now()}`;
    const orderInfo = db
      .prepare(`
        INSERT INTO orders (order_number, customer_id, order_date, status, total_amount_paisa, notes, created_by)
        VALUES (?, ?, ?, 'confirmed', ?, ?, ?)
      `)
      .run(resolvedNumber, customerId, orderDate, totalAmountPaisa, notes, actorUserId);
    const orderId = Number(orderInfo.lastInsertRowid);

    const insertLine = db.prepare(`
      INSERT INTO order_lines (order_id, item_id, qty_ordered_scaled, unit, unit_price_paisa, line_total_paisa)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const line of prepared) {
      insertLine.run(orderId, line.itemId, line.qtyScaled, line.unit, line.unitPricePaisa, line.lineTotalPaisa);
    }

    recordAudit(db, {
      actorUserId,
      action: 'ORDER_CREATED',
      entityType: 'order',
      entityId: orderId,
      after: { orderNumber: resolvedNumber, customerId, totalAmountPaisa, lines: prepared },
    });

    return { id: orderId, orderNumber: resolvedNumber, totalAmountPaisa, lines: prepared };
  });

  return runTx();
}

export function dispatchAndInvoice(
  db,
  { customerId, orderId = null, invoiceDate, lines, actorUserId = null }
) {
  if (!lines || lines.length === 0) {
    throw new Error('Invoice must contain at least one line');
  }

  const runTx = db.transaction(() => {
    const company = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
    if (!company) {
      throw new Error('Company settings not configured');
    }

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) {
      throw new Error(`Customer not found: ${customerId}`);
    }

    const supplyType =
      company.state_code === customer.state_code ? 'intra_state' : 'inter_state';

    const financialYear = getFinancialYear(invoiceDate);
    const maxSeqRow = db
      .prepare('SELECT COALESCE(MAX(seq_number), 0) AS max_seq FROM invoices WHERE financial_year = ?')
      .get(financialYear);
    const seqNumber = maxSeqRow.max_seq + 1;
    const invoiceNumber = `${company.invoice_prefix}/${financialYear}/${String(seqNumber).padStart(4, '0')}`;

    let subtotalPaisa = 0;
    let totalCgstPaisa = 0;
    let totalSgstPaisa = 0;
    let totalIgstPaisa = 0;

    const preparedLines = lines.map((line) => {
      const item = db
        .prepare('SELECT id, sku, unit, hsn_code, gst_rate_bps, selling_price_paisa, standard_cost_paisa FROM items WHERE id = ?')
        .get(line.itemId);
      if (!item) {
        throw new Error(`Item not found: ${line.itemId}`);
      }
      if (!item.hsn_code) {
        throw new Error(`Item ${item.sku} is missing hsn_code`);
      }

      const qtyScaled = toScaledQty(line.qty);
      if (qtyScaled <= 0) {
        throw new Error(`Dispatch qty must be positive, got: ${line.qty}`);
      }

      const availableScaled = getStockBalanceScaled(db, item.id);
      if (availableScaled < qtyScaled) {
        throw new Error(
          `Insufficient stock to dispatch ${item.sku}: available ${fromScaledQty(availableScaled)}, requested ${fromScaledQty(qtyScaled)}`
        );
      }

      const unitPricePaisa = line.unitPricePaisa ?? item.selling_price_paisa;
      const taxableValuePaisa = mulScaledQtyByPaisa(qtyScaled, unitPricePaisa);
      const gst = calcGstSplit({
        taxableValuePaisa,
        gstRateBps: item.gst_rate_bps,
        supplyType,
      });
      const lineTotalPaisa = taxableValuePaisa + gst.totalTaxPaisa;

      subtotalPaisa += taxableValuePaisa;
      totalCgstPaisa += gst.cgstPaisa;
      totalSgstPaisa += gst.sgstPaisa;
      totalIgstPaisa += gst.igstPaisa;

      return {
        itemId: item.id,
        sku: item.sku,
        hsnCode: item.hsn_code,
        qtyScaled,
        unit: item.unit,
        unitPricePaisa,
        standardCostPaisa: item.standard_cost_paisa,
        taxableValuePaisa,
        gstRateBps: item.gst_rate_bps,
        cgstPaisa: gst.cgstPaisa,
        sgstPaisa: gst.sgstPaisa,
        igstPaisa: gst.igstPaisa,
        lineTotalPaisa,
      };
    });

    const totalTaxPaisa = totalCgstPaisa + totalSgstPaisa + totalIgstPaisa;
    const grandTotalPaisa = subtotalPaisa + totalTaxPaisa;

    const invoiceInfo = db
      .prepare(`
        INSERT INTO invoices (
          invoice_number, financial_year, seq_number, customer_id, order_id,
          invoice_date, place_of_supply_state, supply_type,
          subtotal_paisa, cgst_paisa, sgst_paisa, igst_paisa,
          total_tax_paisa, grand_total_paisa, status, created_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?)
      `)
      .run(
        invoiceNumber,
        financialYear,
        seqNumber,
        customerId,
        orderId,
        invoiceDate,
        customer.state,
        supplyType,
        subtotalPaisa,
        totalCgstPaisa,
        totalSgstPaisa,
        totalIgstPaisa,
        totalTaxPaisa,
        grandTotalPaisa,
        actorUserId
      );
    const invoiceId = Number(invoiceInfo.lastInsertRowid);

    const insertLine = db.prepare(`
      INSERT INTO invoice_lines (
        invoice_id, item_id, hsn_code, qty_scaled, unit, unit_price_paisa,
        taxable_value_paisa, gst_rate_bps, cgst_paisa, sgst_paisa, igst_paisa, line_total_paisa
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const line of preparedLines) {
      insertLine.run(
        invoiceId,
        line.itemId,
        line.hsnCode,
        line.qtyScaled,
        line.unit,
        line.unitPricePaisa,
        line.taxableValuePaisa,
        line.gstRateBps,
        line.cgstPaisa,
        line.sgstPaisa,
        line.igstPaisa,
        line.lineTotalPaisa
      );

      appendStockMovement(db, {
        itemId: line.itemId,
        qtyScaled: -line.qtyScaled,
        unit: line.unit,
        unitCostPaisa: line.standardCostPaisa,
        sourceType: 'dispatch',
        sourceId: invoiceId,
        notes: `Dispatch on invoice ${invoiceNumber}`,
        createdBy: actorUserId,
      });

      if (orderId !== null) {
        db.prepare(
          'UPDATE order_lines SET qty_dispatched_scaled = qty_dispatched_scaled + ? WHERE order_id = ? AND item_id = ?'
        ).run(line.qtyScaled, orderId, line.itemId);
      }
    }

    if (orderId !== null) {
      const remaining = db
        .prepare(
          'SELECT COUNT(*) AS cnt FROM order_lines WHERE order_id = ? AND qty_dispatched_scaled < qty_ordered_scaled'
        )
        .get(orderId);
      const newOrderStatus = remaining.cnt === 0 ? 'dispatched' : 'partially_dispatched';
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(newOrderStatus, orderId);
    }

    const result = {
      id: invoiceId,
      invoiceNumber,
      financialYear,
      seqNumber,
      supplyType,
      subtotalPaisa,
      cgstPaisa: totalCgstPaisa,
      sgstPaisa: totalSgstPaisa,
      igstPaisa: totalIgstPaisa,
      totalTaxPaisa,
      grandTotalPaisa,
      lines: preparedLines,
    };

    recordAudit(db, {
      actorUserId,
      action: 'INVOICE_ISSUED',
      entityType: 'invoice',
      entityId: invoiceId,
      after: result,
    });

    return result;
  });

  return runTx();
}

export function recordPayment(
  db,
  {
    paymentNumber,
    customerId,
    invoiceId = null,
    paymentDate,
    amountPaisa,
    paymentMode,
    referenceNo = null,
    notes = null,
    actorUserId = null,
  }
) {
  if (!Number.isInteger(amountPaisa) || amountPaisa <= 0) {
    throw new Error(`Payment amountPaisa must be a positive integer, got: ${amountPaisa}`);
  }

  const runTx = db.transaction(() => {
    const resolvedNumber = paymentNumber ?? `PAY-${paymentDate.replaceAll('-', '')}-${Date.now()}`;
    const info = db
      .prepare(`
        INSERT INTO payments (
          payment_number, customer_id, invoice_id, payment_date,
          amount_paisa, payment_mode, reference_no, notes, created_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        resolvedNumber,
        customerId,
        invoiceId,
        paymentDate,
        amountPaisa,
        paymentMode,
        referenceNo,
        notes,
        actorUserId
      );
    const paymentId = Number(info.lastInsertRowid);

    if (invoiceId !== null) {
      const invoice = db.prepare('SELECT grand_total_paisa FROM invoices WHERE id = ?').get(invoiceId);
      if (invoice) {
        const paid = db
          .prepare('SELECT COALESCE(SUM(amount_paisa), 0) AS total_paid FROM payments WHERE invoice_id = ?')
          .get(invoiceId);
        const status = paid.total_paid >= invoice.grand_total_paisa ? 'paid' : 'partially_paid';
        db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, invoiceId);
      }
    }

    recordAudit(db, {
      actorUserId,
      action: 'PAYMENT_RECORDED',
      entityType: 'payment',
      entityId: paymentId,
      after: { paymentNumber: resolvedNumber, customerId, invoiceId, amountPaisa, paymentMode },
    });

    return { id: paymentId, paymentNumber: resolvedNumber, amountPaisa };
  });

  return runTx();
}
