import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { initSchema, openDb } from '../src/db/connection.js';
import { DEFAULT_SEED_PASSWORD, seedDatabase } from '../src/db/seed.js';

describe('Order-to-Audit Step 2: Express API, JWT RBAC, Variance Flags & Ledger Endpoints', () => {
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
    tokens.owner = await loginAs('owner1');
  });

  afterEach(() => {
    db.close();
  });

  it('rejects invalid login and unauthenticated requests', async () => {
    const badLogin = await request(app)
      .post('/auth/login')
      .send({ username: 'admin1', password: 'wrong-password' });
    expect(badLogin.status).toBe(401);

    const noAuth = await request(app).get('/stock/summary');
    expect(noAuth.status).toBe(401);
  });

  it('enforces role middleware: salesman gets 403 on /production-runs, auditor is read-only, admin-only CRUD', async () => {
    const { items } = seed;

    // Salesman cannot trigger production runs or purchases or admin CRUD
    const salesmanProd = await request(app)
      .post('/production-runs')
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({
        productId: items['FG-MURUKKU-200G'].id,
        batches: 1,
        rawIssues: [{ itemId: items['RM-FLOUR'].id, qty: 40 }],
        goodPackets: 200,
      });
    expect(salesmanProd.status).toBe(403);

    const salesmanPurchase = await request(app)
      .post('/purchases')
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({
        supplierName: 'Test',
        purchaseDate: '2026-11-26',
        lines: [{ itemId: items['RM-FLOUR'].id, qty: 10, ratePaisa: 4500 }],
      });
    expect(salesmanPurchase.status).toBe(403);

    // Auditor can read but gets 403 on any write
    const auditorRead = await request(app)
      .get('/stock/summary')
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(auditorRead.status).toBe(200);

    const auditorWrite = await request(app)
      .post('/items')
      .set('Authorization', `Bearer ${tokens.auditor}`)
      .send({
        sku: 'RM-SALT',
        name: 'Salt',
        itemType: 'raw',
        unit: 'kg',
        baseUnit: 'g',
      });
    expect(auditorWrite.status).toBe(403);

    // Production gets 403 on admin-only CRUD
    const prodCreateCust = await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${tokens.production}`)
      .send({ code: 'C-X', name: 'X', state: 'Tamil Nadu', stateCode: '33' });
    expect(prodCreateCust.status).toBe(403);

    // Admin CRUD works across items, customers, BOMs, and price list
    const itemRes = await request(app)
      .post('/items')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({
        sku: 'RM-SALT',
        name: 'Crystal Salt',
        itemType: 'raw',
        unit: 'kg',
        baseUnit: 'g',
        toBaseFactor: 1000,
        hsnCode: '2501',
        gstRateBps: 0,
        standardCostPaisa: 2000,
      });
    expect(itemRes.status).toBe(201);
    expect(itemRes.body.item.sku).toBe('RM-SALT');

    const updateItemRes = await request(app)
      .put(`/items/${itemRes.body.item.id}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ name: 'Refined Salt' });
    expect(updateItemRes.status).toBe(200);
    expect(updateItemRes.body.item.name).toBe('Refined Salt');

    const priceRes = await request(app)
      .post('/price-list')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({
        itemId: items['FG-MURUKKU-200G'].id,
        customerId: seed.customers['CUST-DIST-B'].id,
        pricePaisa: 4800,
      });
    expect(priceRes.status).toBe(201);
    expect(priceRes.body.priceEntry.price_paisa).toBe(4800);
  });

  it('replays Section 5 steps 1-3 via HTTP API, flags variances > 300 bps, links ledger sources, and audits writes', async () => {
    const { items, customers } = seed;

    // Step 1: Purchase 60 kg flour at Rs 45 (4500 paisa) as admin
    const purRes = await request(app)
      .post('/purchases')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({
        purchaseNumber: 'PUR-API-001',
        supplierName: 'Erode Agro Mills',
        purchaseDate: '2026-11-26',
        lines: [{ itemId: items['RM-FLOUR'].id, qty: 60, ratePaisa: 4500 }],
      });
    expect(purRes.status).toBe(201);
    expect(purRes.body.purchase.totalAmountPaisa).toBe(270000);

    // Step 2: Production run as production user
    const prodRes = await request(app)
      .post('/production-runs')
      .set('Authorization', `Bearer ${tokens.production}`)
      .send({
        runNumber: 'PRD-API-001',
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

    const run = prodRes.body.productionRun;
    expect(run.toleranceBps).toBe(300);
    expect(run.yield.expectedQty).toBe(200);
    expect(run.yield.actualGoodQty).toBe(188);
    expect(run.yield.varianceBps).toBe(-600);
    expect(run.yield.flagged).toBe(true);

    const oilLine = run.consumptions.find((c) => c.sku === 'RM-OIL');
    expect(oilLine.expectedQty).toBe(10);
    expect(oilLine.actualQty).toBe(10.5);
    expect(oilLine.varianceBps).toBe(500);
    expect(oilLine.flagged).toBe(true);

    const flourLine = run.consumptions.find((c) => c.sku === 'RM-FLOUR');
    expect(flourLine.varianceBps).toBe(0);
    expect(flourLine.flagged).toBe(false);

    expect(run.hasVarianceFlags).toBe(true);

    // Check finished goods right after production run (50 + 188 = 238)
    const midSummary = await request(app)
      .get('/stock/summary')
      .set('Authorization', `Bearer ${tokens.owner}`);
    expect(midSummary.status).toBe(200);
    const fgMid = midSummary.body.items.find((i) => i.sku === 'FG-MURUKKU-200G');
    expect(fgMid.balanceQty).toBe(238);

    // Step 3: Dispatch 150 packets to Retailer A with invoice as salesman
    const invRes = await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({
        customerId: customers['CUST-RET-A'].id,
        invoiceDate: '2026-11-26',
        lines: [{ itemId: items['FG-MURUKKU-200G'].id, qty: 150 }],
      });
    expect(invRes.status).toBe(201);

    const inv = invRes.body.invoice;
    expect(inv.invoiceNumber).toBe('INV/2026-27/0001');
    expect(inv.supplyType).toBe('intra_state');
    expect(inv.subtotalPaisa).toBe(750000);
    expect(inv.cgstPaisa).toBe(18750);
    expect(inv.sgstPaisa).toBe(18750);
    expect(inv.igstPaisa).toBe(0);
    expect(inv.grandTotalPaisa).toBe(787500);

    // Final stock summary verification
    const summaryRes = await request(app)
      .get('/stock/summary')
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(summaryRes.status).toBe(200);
    const bySku = Object.fromEntries(summaryRes.body.items.map((i) => [i.sku, i.balanceQty]));
    expect(bySku['RM-FLOUR']).toBe(120);
    expect(bySku['RM-OIL']).toBe(19.5);
    expect(bySku['RM-SPICE']).toBe(3.8);
    expect(bySku['PKG-POUCH']).toBe(306);
    expect(bySku['PKG-CARTON']).toBe(21);
    expect(bySku['FG-MURUKKU-200G']).toBe(88);

    // Ledger with item and date filters + source document links
    const ledgerRes = await request(app)
      .get('/stock/ledger')
      .query({ sku: 'RM-FLOUR', from: '2026-11-26', to: '2026-11-26' })
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(ledgerRes.status).toBe(200);
    expect(ledgerRes.body.entries.length).toBeGreaterThanOrEqual(2);

    const purchaseLedgerRow = ledgerRes.body.entries.find((e) => e.sourceType === 'purchase');
    expect(purchaseLedgerRow.qty).toBe(60);
    expect(purchaseLedgerRow.source).toEqual({
      type: 'purchase',
      id: purRes.body.purchase.id,
      ref: 'PUR-API-001',
      url: `/purchases/${purRes.body.purchase.id}`,
    });

    // Follow source document link
    const linkedPurchase = await request(app)
      .get(purchaseLedgerRow.source.url)
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(linkedPurchase.status).toBe(200);
    expect(linkedPurchase.body.purchase.purchaseNumber).toBe('PUR-API-001');

    // Audit log captured all actors and actions
    const auditRes = await request(app)
      .get('/audit-log')
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(auditRes.status).toBe(200);
    const actions = auditRes.body.auditLog.map((a) => a.action);
    expect(actions).toContain('PURCHASE_RECORDED');
    expect(actions).toContain('PRODUCTION_RUN_RECORDED');
    expect(actions).toContain('INVOICE_ISSUED');
  });

  it('rejects any issue that would make raw stock negative and rolls back atomically', async () => {
    const { items } = seed;

    const beforeAuditCount = db.prepare('SELECT COUNT(*) AS cnt FROM audit_log').get().cnt;

    const badRun = await request(app)
      .post('/production-runs')
      .set('Authorization', `Bearer ${tokens.production}`)
      .send({
        productId: items['FG-MURUKKU-200G'].id,
        batches: 1,
        runDate: '2026-11-26',
        rawIssues: [
          { itemId: items['RM-FLOUR'].id, qty: 40 },
          { itemId: items['RM-OIL'].id, qty: 999 }, // only 30 L in stock
          { itemId: items['RM-SPICE'].id, qty: 1.2 },
        ],
        goodPackets: 180,
        damagedPouches: 0,
        cartonsUsed: 9,
      });

    expect(badRun.status).toBe(409);
    expect(badRun.body.error).toBe('INSUFFICIENT_STOCK');

    // Confirm atomic rollback: flour was NOT deducted and no audit entry was added
    const summary = await request(app)
      .get('/stock/summary')
      .set('Authorization', `Bearer ${tokens.auditor}`);
    const flour = summary.body.items.find((i) => i.sku === 'RM-FLOUR');
    expect(flour.balanceQty).toBe(100);

    const afterAuditCount = db.prepare('SELECT COUNT(*) AS cnt FROM audit_log').get().cnt;
    expect(afterAuditCount).toBe(beforeAuditCount);
  });
});
