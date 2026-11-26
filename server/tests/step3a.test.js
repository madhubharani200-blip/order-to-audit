import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { initSchema, openDb } from '../src/db/connection.js';
import { DEFAULT_SEED_PASSWORD, seedDatabase } from '../src/db/seed.js';

describe('Order-to-Audit Step 3a: Order Stock Check, Receivables Ageing, and Weighted Avg Costing', () => {
  let db;
  let app;
  let seed;
  const tokens = {};

  async function loginAs(username, password = DEFAULT_SEED_PASSWORD) {
    const res = await request(app).post('/auth/login').send({ username, password });
    expect(res.status).toBe(200);
    return res.body.token;
  }

  beforeEach(async () => {
    db = openDb(':memory:');
    initSchema(db);
    seed = seedDatabase(db, { bcryptRounds: 4 });
    app = createApp({ db, jwtSecret: 'test-jwt-secret' });

    tokens.admin = await loginAs('admin1');
    tokens.production = await loginAs('prod1');
    tokens.salesman = await loginAs('sales1');
    tokens.auditor = await loginAs('audit1');
  });

  afterEach(() => {
    db.close();
  });

  it('continues Section 5 scenario: payments & ageing, shortage approval + IGST dispatch, overheads & weighted average cost per packet', async () => {
    const { items, customers } = seed;

    // --- Section 5 setup: Purchase 60 kg flour @ 45, Production run, Dispatch 150 to Retailer A ---
    const purRes = await request(app)
      .post('/purchases')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({
        purchaseNumber: 'PUR-3A-001',
        supplierName: 'Erode Agro Mills',
        purchaseDate: '2026-11-26',
        lines: [{ itemId: items['RM-FLOUR'].id, qty: 60, ratePaisa: 4500 }],
      });
    expect(purRes.status).toBe(201);

    const prodRes = await request(app)
      .post('/production-runs')
      .set('Authorization', `Bearer ${tokens.production}`)
      .send({
        runNumber: 'PRD-3A-001',
        productId: items['FG-MURUKKU-200G'].id,
        batches: 1,
        runDate: '2026-11-26',
        rawIssues: [
          { itemId: items['RM-FLOUR'].id, qty: 40 },
          { itemId: items['RM-OIL'].id, qty: 10.5 },
          { itemId: items['RM-SPICE'].id, qty: 1.2 },
        ],
        goodPackets: 188,
        damagedPouches: 6,
        cartonsUsed: 9,
      });
    expect(prodRes.status).toBe(201);
    const runId = prodRes.body.productionRun.id;

    const retAInvRes = await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({
        customerId: customers['CUST-RET-A'].id,
        invoiceDate: '2026-11-26',
        lines: [{ itemId: items['FG-MURUKKU-200G'].id, qty: 150 }],
      });
    expect(retAInvRes.status).toBe(201);
    const retAInv = retAInvRes.body.invoice;
    expect(retAInv.grandTotalPaisa).toBe(787500); // Rs 7,875.00 (88 packets left in stock)

    // --- 1. Payments & Outstanding: Retailer A pays Rs 4,000, outstanding becomes Rs 3,875 ---
    const payRes = await request(app)
      .post('/payments')
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({
        paymentNumber: 'PAY-3A-001',
        customerId: customers['CUST-RET-A'].id,
        invoiceId: retAInv.id,
        paymentDate: '2026-11-26',
        amountPaisa: 400000, // Rs 4,000.00
        paymentMode: 'upi',
        referenceNo: 'UPI-998877',
      });
    expect(payRes.status).toBe(201);

    const custOutRes = await request(app)
      .get(`/customers/${customers['CUST-RET-A'].id}/outstanding`)
      .query({ asOfDate: '2026-11-26' })
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(custOutRes.status).toBe(200);
    expect(custOutRes.body.totalInvoicedPaisa).toBe(787500);
    expect(custOutRes.body.totalPaidPaisa).toBe(400000);
    expect(custOutRes.body.totalOutstandingPaisa).toBe(387500); // Rs 3,875.00
    expect(custOutRes.body.buckets).toEqual({
      '0-30': 387500,
      '31-60': 0,
      '61-90': 0,
      '90+': 0,
    });

    // Verify ageing buckets shift cleanly at 45, 75, and 100 days out
    const report45Res = await request(app)
      .get('/reports/outstanding')
      .query({ asOfDate: '2027-01-10', onlyWithBalance: 'true' })
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(report45Res.status).toBe(200);
    expect(report45Res.body.summary.totalOutstandingPaisa).toBe(387500);
    expect(report45Res.body.summary.buckets['31-60']).toBe(387500);

    const report100Res = await request(app)
      .get('/reports/outstanding')
      .query({ asOfDate: '2027-03-06', onlyWithBalance: 'true' })
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(report100Res.body.summary.buckets['90+']).toBe(387500);

    // --- 2. Order stock check & approval: Distributor B orders 120 against 88 in stock ---
    const ordRes = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({
        orderNumber: 'ORD-DISTB-001',
        customerId: customers['CUST-DIST-B'].id,
        orderDate: '2026-11-26',
        lines: [{ itemId: items['FG-MURUKKU-200G'].id, qty: 120 }],
      });
    expect(ordRes.status).toBe(201);
    const orderId = ordRes.body.order.id;

    const stockCheckRes = await request(app)
      .get(`/orders/${orderId}/stock-check`)
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(stockCheckRes.status).toBe(200);
    expect(stockCheckRes.body.hasShortage).toBe(true);
    expect(stockCheckRes.body.lines[0]).toMatchObject({
      sku: 'FG-MURUKKU-200G',
      requiredQty: 120,
      availableQty: 88,
      shortageQty: 32,
      hasShortage: true,
    });

    // Approving without allowShortage=true is rejected
    const approveDenied = await request(app)
      .post(`/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({});
    expect(approveDenied.status).toBe(409);
    expect(approveDenied.body.error).toBe('STOCK_SHORTAGE');
    expect(approveDenied.body.details.shortages[0].shortageQty).toBe(32);

    // Non-admin cannot approve
    const approveForbidden = await request(app)
      .post(`/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({ allowShortage: true });
    expect(approveForbidden.status).toBe(403);

    // Admin approves with allowShortage=true and response still lists the shortage
    const approveOk = await request(app)
      .post(`/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ allowShortage: true });
    expect(approveOk.status).toBe(200);
    expect(approveOk.body.order.status).toBe('approved');
    expect(approveOk.body.hasShortage).toBe(true);
    expect(approveOk.body.shortages[0].shortageQty).toBe(32);

    // Dispatching 120 packets (> 88 available) still fails with 409 INSUFFICIENT_STOCK
    const dispatchFullFail = await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({
        customerId: customers['CUST-DIST-B'].id,
        orderId,
        invoiceDate: '2026-11-26',
        lines: [{ itemId: items['FG-MURUKKU-200G'].id, qty: 120 }],
      });
    expect(dispatchFullFail.status).toBe(409);
    expect(dispatchFullFail.body.error).toBe('INSUFFICIENT_STOCK');

    // Dispatching the available 88 packets to Distributor B (Karnataka) applies 5% IGST
    const dispatch88Ok = await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({
        customerId: customers['CUST-DIST-B'].id,
        orderId,
        invoiceDate: '2026-11-26',
        lines: [{ itemId: items['FG-MURUKKU-200G'].id, qty: 88 }],
      });
    expect(dispatch88Ok.status).toBe(201);
    expect(dispatch88Ok.body.invoice.supplyType).toBe('inter_state');
    expect(dispatch88Ok.body.invoice.subtotalPaisa).toBe(440000); // 88 * Rs 50 = Rs 4,400
    expect(dispatch88Ok.body.invoice.cgstPaisa).toBe(0);
    expect(dispatch88Ok.body.invoice.sgstPaisa).toBe(0);
    expect(dispatch88Ok.body.invoice.igstPaisa).toBe(22000); // 5% IGST = Rs 220
    expect(dispatch88Ok.body.invoice.grandTotalPaisa).toBe(462000); // Rs 4,620

    // --- 3. Overheads & Weighted Average Costing ---
    const overheadRes = await request(app)
      .post(`/production-runs/${runId}/overheads`)
      .set('Authorization', `Bearer ${tokens.production}`)
      .send({
        overheads: [
          { category: 'labour', amountPaisa: 120000, description: 'Batch shift labour' },
          { category: 'power', amountPaisa: 60000, description: 'Fryer gas & electricity' },
        ],
      });
    expect(overheadRes.status).toBe(201);

    const costRes = await request(app)
      .get(`/production-runs/${runId}/cost`)
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(costRes.status).toBe(200);

    const cost = costRes.body.cost;
    const flourCost = cost.materials.find((m) => m.sku === 'RM-FLOUR');
    expect(flourCost.poolQtyAtIssue).toBe(160);
    expect(flourCost.poolValuePaisaAtIssue).toBe(690000); // 100*4200 + 60*4500 = 690000 paisa
    expect(flourCost.weightedAvgRateRupees).toBe(43.125);
    expect(flourCost.costPaisa).toBe(172500); // 40 * 43.125 = Rs 1,725.00

    expect(cost.totalMaterialCostPaisa).toBe(405500); // 172500 + 147000 + 24000 + 48500 + 13500
    expect(cost.overheads.totalOverheadsPaisa).toBe(180000); // 120000 + 60000
    expect(cost.totalCostPaisa).toBe(585500); // Rs 5,855.00
    expect(cost.goodPackets).toBe(188);
    expect(cost.costPerPacketPaisa).toBe(3114); // round(585500 / 188) = 3114 paisa (Rs 31.14)
    expect(cost.margin.marginPerPacketPaisa).toBe(1886); // 5000 - 3114 = Rs 18.86
    expect(cost.margin.marginBps).toBe(3771); // (940000 - 585500) / 940000 = 37.71%

    console.log(
      `Computed cost per good packet: ${cost.costPerPacketPaisa} paisa (Rs ${cost.costPerPacketRupees}, rounded Rs ${(cost.costPerPacketPaisa / 100).toFixed(2)})`
    );
  });
});
