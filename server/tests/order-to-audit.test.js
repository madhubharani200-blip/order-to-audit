import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSchema, openDb } from '../src/db/connection.js';
import { seedDatabase } from '../src/db/seed.js';
import { paisaToRupees, toPaisa } from '../src/lib/units.js';
import { convertQty, getStockBalance, getStockBalanceBySku } from '../src/services/inventory.js';
import { recordProductionRun } from '../src/services/production.js';
import { recordPurchase } from '../src/services/purchasing.js';
import { dispatchAndInvoice } from '../src/services/sales.js';

describe('Order-to-Audit Step 1: Ledger, BOM Production, Variance & GST Invoice', () => {
  let db;
  let seed;

  beforeEach(() => {
    db = openDb(':memory:');
    initSchema(db);
    seed = seedDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  it('executes purchase, production run with variances, and Tamil Nadu dispatch invoice accurately', () => {
    const { items, customers, users, bom } = seed;

    // 1. Purchase 60 kg flour at Rs 45/kg (4500 paisa)
    const purchase = recordPurchase(db, {
      purchaseNumber: 'PUR-2026-0001',
      supplierName: 'Erode Agro Mills',
      purchaseDate: '2026-11-26',
      lines: [
        {
          itemId: items['RM-FLOUR'].id,
          qty: 60,
          ratePaisa: toPaisa('45.00'),
        },
      ],
      actorUserId: users.admin1.id,
    });
    expect(purchase.totalAmountPaisa).toBe(270000); // 60 * 45 = Rs 2,700
    expect(getStockBalance(db, items['RM-FLOUR'].id).balanceQty).toBe(160);

    // 2. Production run:
    //    issue 40 kg flour, 10.5 L oil, 1.2 kg spice mix,
    //    188 good packets (188 pouches + 6 damaged pouches), 9 cartons
    const run = recordProductionRun(db, {
      runNumber: 'PRD-2026-0001',
      bomId: bom.id,
      batchesPlanned: 1,
      runDate: '2026-11-26',
      goodYieldQty: 188,
      consumptions: [
        { itemId: items['RM-FLOUR'].id, actualQty: 40 },
        { itemId: items['RM-OIL'].id, actualQty: 10.5 },
        { itemId: items['RM-SPICE'].id, actualQty: 1.2 },
        { itemId: items['PKG-POUCH'].id, actualQty: 188, damagedQty: 6 },
        { itemId: items['PKG-CARTON'].id, actualQty: 9 },
      ],
      actorUserId: users.prod1.id,
    });

    // Check balances right after production run
    expect(getStockBalanceBySku(db, 'RM-FLOUR').balanceQty).toBe(120);
    expect(getStockBalanceBySku(db, 'RM-OIL').balanceQty).toBe(19.5);
    expect(getStockBalanceBySku(db, 'RM-SPICE').balanceQty).toBe(3.8);
    expect(getStockBalanceBySku(db, 'PKG-POUCH').balanceQty).toBe(306);
    expect(getStockBalanceBySku(db, 'PKG-CARTON').balanceQty).toBe(21);
    expect(getStockBalanceBySku(db, 'FG-MURUKKU-200G').balanceQty).toBe(238);

    // Check variances: yield variance -6% (-600 bps), oil variance +5% (+500 bps)
    expect(run.yieldVarianceBps).toBe(-600);
    expect(run.yieldVariancePercent).toBe(-6);

    const oilConsumption = run.consumptions.find((c) => c.sku === 'RM-OIL');
    expect(oilConsumption.varianceBps).toBe(500);
    expect(oilConsumption.variancePercent).toBe(5);

    // 3. Dispatch 150 packets to Retailer A (Tamil Nadu -> intra-state CGST + SGST)
    const invoice = dispatchAndInvoice(db, {
      customerId: customers['CUST-RET-A'].id,
      invoiceDate: '2026-11-26',
      lines: [
        {
          itemId: items['FG-MURUKKU-200G'].id,
          qty: 150,
        },
      ],
      actorUserId: users.sales1.id,
    });

    // Check finished goods balance after dispatch
    expect(getStockBalanceBySku(db, 'FG-MURUKKU-200G').balanceQty).toBe(88);

    // Check financial-year invoice numbering and GST totals (all integer paisa)
    expect(invoice.invoiceNumber).toBe('INV/2026-27/0001');
    expect(invoice.financialYear).toBe('2026-27');
    expect(invoice.supplyType).toBe('intra_state');

    expect(invoice.subtotalPaisa).toBe(750000); // Rs 7,500.00
    expect(invoice.cgstPaisa).toBe(18750); // Rs 187.50
    expect(invoice.sgstPaisa).toBe(18750); // Rs 187.50
    expect(invoice.igstPaisa).toBe(0);
    expect(invoice.grandTotalPaisa).toBe(787500); // Rs 7,875.00

    expect(paisaToRupees(invoice.subtotalPaisa)).toBe(7500);
    expect(paisaToRupees(invoice.cgstPaisa)).toBe(187.5);
    expect(paisaToRupees(invoice.sgstPaisa)).toBe(187.5);
    expect(paisaToRupees(invoice.grandTotalPaisa)).toBe(7875);
  });

  it('enforces append-only stock_ledger and audit_log, supports unit conversion, and applies IGST for Karnataka', () => {
    const { items, customers, users } = seed;

    // Append-only triggers prevent updates/deletes on stock_ledger and audit_log
    expect(() => db.prepare('UPDATE stock_ledger SET qty_scaled = 0 WHERE id = 1').run()).toThrow(
      /append-only/
    );
    expect(() => db.prepare('DELETE FROM stock_ledger WHERE id = 1').run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE audit_log SET action = 'HACK' WHERE id = 1").run()).toThrow(
      /append-only/
    );

    // Unit conversion checks
    const inGrams = convertQty(db, {
      itemId: items['FG-MURUKKU-200G'].id,
      qty: 10,
      fromUnit: 'carton',
      toUnit: 'packet',
    });
    expect(inGrams.qty).toBe(200);

    const flourGrams = convertQty(db, {
      itemId: items['RM-FLOUR'].id,
      qty: 1.25,
      fromUnit: 'kg',
      toUnit: 'g',
    });
    expect(flourGrams.qty).toBe(1250);

    // Inter-state dispatch to Distributor B (Karnataka -> 5% IGST)
    const igstInvoice = dispatchAndInvoice(db, {
      customerId: customers['CUST-DIST-B'].id,
      invoiceDate: '2026-11-26',
      lines: [{ itemId: items['FG-MURUKKU-200G'].id, qty: 20 }],
      actorUserId: users.sales1.id,
    });
    expect(igstInvoice.supplyType).toBe('inter_state');
    expect(igstInvoice.subtotalPaisa).toBe(100000); // Rs 1,000
    expect(igstInvoice.cgstPaisa).toBe(0);
    expect(igstInvoice.sgstPaisa).toBe(0);
    expect(igstInvoice.igstPaisa).toBe(5000); // Rs 50
    expect(igstInvoice.grandTotalPaisa).toBe(105000); // Rs 1,050
    expect(getStockBalanceBySku(db, 'FG-MURUKKU-200G').balanceQty).toBe(30);
  });
});
