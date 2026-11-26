import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { initSchema, openDb } from '../src/db/connection.js';
import { DEFAULT_SEED_PASSWORD, seedDatabase } from '../src/db/seed.js';

// Helper: parse a simple CSV string into an array of objects
function parseCsv(csvText) {
  const lines = csvText.trim().split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 1) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const vals = line.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
  });
}

describe('Order-to-Audit Step 3b: PDF Invoices, Credit Notes, and Reports', () => {
  let db;
  let app;
  let seed;
  const tokens = {};

  // IDs set during scenario setup
  let retAInvoiceId;
  let runId;
  let distBInvoiceId;

  async function loginAs(username, password = DEFAULT_SEED_PASSWORD) {
    const res = await request(app).post('/auth/login').send({ username, password });
    expect(res.status).toBe(200);
    return res.body.token;
  }

  // ── Shared scenario: Purchase → Production → Dispatch (Section 5 steps 1-3) ──
  async function runSection5Scenario() {
    const { items, customers } = seed;

    // Step 1: Purchase 60 kg flour @ Rs 45
    const purRes = await request(app)
      .post('/purchases')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({
        purchaseNumber: 'PUR-3B-001',
        supplierName: 'Erode Agro Mills',
        purchaseDate: '2026-11-26',
        lines: [{ itemId: items['RM-FLOUR'].id, qty: 60, ratePaisa: 4500 }],
      });
    expect(purRes.status).toBe(201);

    // Step 2: Production run → 188 good packets
    const prodRes = await request(app)
      .post('/production-runs')
      .set('Authorization', `Bearer ${tokens.production}`)
      .send({
        runNumber: 'PRD-3B-001',
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
    runId = prodRes.body.productionRun.id;

    // Step 3: Dispatch 150 packets to Retailer A (Tamil Nadu — intra-state → CGST+SGST)
    const invRes = await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({
        customerId: customers['CUST-RET-A'].id,
        invoiceDate: '2026-11-26',
        lines: [{ itemId: items['FG-MURUKKU-200G'].id, qty: 150 }],
      });
    expect(invRes.status).toBe(201);
    retAInvoiceId = invRes.body.invoice.id;

    // grandTotal = 150 × 5000 paisa = 750000 taxable + 5% GST = 787500
    expect(invRes.body.invoice.grandTotalPaisa).toBe(787500);
    expect(invRes.body.invoice.cgstPaisa).toBe(18750);
    expect(invRes.body.invoice.sgstPaisa).toBe(18750);
    expect(invRes.body.invoice.igstPaisa).toBe(0);

    return { items, customers };
  }

  beforeEach(async () => {
    db = openDb(':memory:');
    initSchema(db);
    seed = seedDatabase(db, { bcryptRounds: 4 });
    app = createApp({ db, jwtSecret: 'test-jwt-secret' });

    tokens.admin     = await loginAs('admin1');
    tokens.production = await loginAs('prod1');
    tokens.salesman  = await loginAs('sales1');
    tokens.auditor   = await loginAs('audit1');
  });

  afterEach(() => {
    db.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  it('1. Sales register total equals Rs 7,875 (787500 paisa) for Retailer A dispatch', async () => {
    await runSection5Scenario();

    const res = await request(app)
      .get('/reports/sales-register')
      .query({ format: 'json' })
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(res.status).toBe(200);

    const { data } = res.body;
    expect(data.length).toBe(1);
    expect(data[0].grandTotalPaisa).toBe(787500);
    expect(data[0].cgstPaisa).toBe(18750);
    expect(data[0].sgstPaisa).toBe(18750);
    expect(data[0].igstPaisa).toBe(0);
    expect(data[0].supplyType).toBe('intra_state');
  });

  // ─────────────────────────────────────────────────────────────────────────
  it('2. GST summary: CGST 18750 and SGST 18750 paisa for intra-state Retailer A invoice', async () => {
    const { customers } = await runSection5Scenario();

    const res = await request(app)
      .get('/reports/gst-summary')
      .set('Authorization', `Bearer ${tokens.admin}`);
    expect(res.status).toBe(200);

    const { b2b, totals } = res.body;

    // Retailer A has GSTIN → appears in B2B section
    expect(b2b.length).toBeGreaterThan(0);
    const retALine = b2b.find((r) => r.customerName === customers['CUST-RET-A'].name || r.cgstPaisa > 0);
    expect(retALine).toBeDefined();
    expect(retALine.cgstPaisa).toBe(18750);
    expect(retALine.sgstPaisa).toBe(18750);
    expect(retALine.igstPaisa).toBe(0);

    // Totals agree
    expect(totals.totalCgstPaisa).toBe(18750);
    expect(totals.totalSgstPaisa).toBe(18750);
    expect(totals.totalIgstPaisa).toBe(0);
    expect(totals.grandTotalPaisa).toBe(787500);
  });

  // ─────────────────────────────────────────────────────────────────────────
  it('3. GST summary includes IGST for inter-state Distributor B invoice', async () => {
    const { items, customers } = await runSection5Scenario();

    // Dispatch 88 packets to Distributor B (Karnataka → inter-state → IGST)
    const distBRes = await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({
        customerId: customers['CUST-DIST-B'].id,
        invoiceDate: '2026-11-26',
        lines: [{ itemId: items['FG-MURUKKU-200G'].id, qty: 88 }],
      });
    expect(distBRes.status).toBe(201);
    distBInvoiceId = distBRes.body.invoice.id;
    expect(distBRes.body.invoice.igstPaisa).toBe(22000);   // 88 × 5000 × 5% = 22000
    expect(distBRes.body.invoice.cgstPaisa).toBe(0);

    const res = await request(app)
      .get('/reports/gst-summary')
      .set('Authorization', `Bearer ${tokens.admin}`);
    expect(res.status).toBe(200);

    const { b2b, totals } = res.body;

    const distBLine = b2b.find((r) => r.igstPaisa > 0);
    expect(distBLine).toBeDefined();
    expect(distBLine.igstPaisa).toBe(22000);
    expect(distBLine.cgstPaisa).toBe(0);

    // Combined totals: 18750 + 22000
    expect(totals.totalIgstPaisa).toBe(22000);
    expect(totals.totalCgstPaisa).toBe(18750);
    expect(totals.grandTotalPaisa).toBe(787500 + 462000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  it('4. CSV stock summary matches JSON for finished-goods balance of 88 after dispatch', async () => {
    await runSection5Scenario();
    // After seeding (50 FG) + production (+188) − dispatch (−150) = 88

    const jsonRes = await request(app)
      .get('/reports/stock-summary')
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(jsonRes.status).toBe(200);

    const csvRes = await request(app)
      .get('/reports/stock-summary')
      .query({ format: 'csv' })
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(csvRes.status).toBe(200);

    // Parse CSV
    const csvRows = parseCsv(csvRes.text);
    const fgJson = jsonRes.body.data.find((r) => r.sku === 'FG-MURUKKU-200G');
    const fgCsv  = csvRows.find((r) => r.sku === 'FG-MURUKKU-200G');

    expect(fgJson).toBeDefined();
    expect(fgCsv).toBeDefined();

    expect(fgJson.balanceQty).toBe(88);
    expect(Number(fgCsv.balanceQty)).toBe(88);
  });

  // ─────────────────────────────────────────────────────────────────────────
  it('5. PDF invoice response starts with %PDF', async () => {
    await runSection5Scenario();

    const res = await request(app)
      .get(`/invoices/${retAInvoiceId}/pdf`)
      .set('Authorization', `Bearer ${tokens.auditor}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
    // First 4 bytes of a valid PDF are always %PDF
    const header = res.body.slice(0, 4).toString('ascii');
    expect(header).toBe('%PDF');
  });

  // ─────────────────────────────────────────────────────────────────────────
  it('6. Share links return whatsappLink and mailtoLink', async () => {
    await runSection5Scenario();

    const res = await request(app)
      .get(`/invoices/${retAInvoiceId}/share`)
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(res.status).toBe(200);

    expect(res.body.whatsappLink).toMatch(/^https:\/\/wa\.me\//);
    expect(res.body.mailtoLink).toMatch(/^mailto:/);
    expect(res.body.invoiceNumber).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────────
  it('7. Credit note reverses finished-goods stock and marks original invoice as credit_note', async () => {
    const { items } = await runSection5Scenario();

    // Before credit note: FG balance = 88
    const stockBefore = db
      .prepare("SELECT SUM(qty_scaled) AS total FROM stock_ledger WHERE item_id = ?")
      .get(items['FG-MURUKKU-200G'].id);
    expect(stockBefore.total / 1_000_000).toBe(88);

    // Issue credit note (admin only)
    const cnRes = await request(app)
      .post(`/invoices/${retAInvoiceId}/credit-note`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ reason: 'Customer returned damaged goods' });
    expect(cnRes.status).toBe(201);
    expect(cnRes.body.creditNoteNumber).toMatch(/^CN\//);
    expect(cnRes.body.linesReversed).toBe(1);

    // After credit note: FG balance should be restored to 238 (50 opening + 188 produced)
    const stockAfter = db
      .prepare("SELECT SUM(qty_scaled) AS total FROM stock_ledger WHERE item_id = ?")
      .get(items['FG-MURUKKU-200G'].id);
    expect(stockAfter.total / 1_000_000).toBe(238);

    // Original invoice status must be 'credit_note', not deleted
    const originalInv = db.prepare('SELECT status FROM invoices WHERE id = ?').get(retAInvoiceId);
    expect(originalInv.status).toBe('credit_note');

    // Credit note excluded from forward sales register
    const salesRes = await request(app)
      .get('/reports/sales-register')
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(salesRes.status).toBe(200);
    const statuses = salesRes.body.data.map((r) => r.status);
    expect(statuses).not.toContain('credit_note');

    // CN row appears in invoices list (never deleted)
    const allInvRes = await request(app)
      .get('/invoices')
      .set('Authorization', `Bearer ${tokens.auditor}`);
    expect(allInvRes.status).toBe(200);
    const cnRow = allInvRes.body.invoices.find((i) => i.invoiceNumber.startsWith('CN/'));
    expect(cnRow).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────────
  it('8. Role restrictions: salesman blocked from admin-only reports; auditor sees all', async () => {
    await runSection5Scenario();

    // Salesman cannot access customer-sales report
    const forbidRes = await request(app)
      .get('/reports/customer-sales')
      .set('Authorization', `Bearer ${tokens.salesman}`);
    expect(forbidRes.status).toBe(403);

    // Salesman CAN access sales-register (their own sales)
    const salesRes = await request(app)
      .get('/reports/sales-register')
      .set('Authorization', `Bearer ${tokens.salesman}`);
    expect(salesRes.status).toBe(200);

    // Auditor can access all report endpoints
    for (const path of [
      '/reports/sales-register',
      '/reports/customer-sales',
      '/reports/product-sales',
      '/reports/gst-summary',
      '/reports/purchase-register',
      '/reports/stock-summary',
      '/reports/stock-ledger',
      '/reports/production',
      '/reports/payments',
      '/reports/outstanding',
    ]) {
      const r = await request(app).get(path).set('Authorization', `Bearer ${tokens.auditor}`);
      expect(r.status, `Auditor should get 200 on ${path}`).toBe(200);
    }

    // Admin cannot issue credit note — only admin can; salesman is rejected
    const cnForbid = await request(app)
      .post(`/invoices/${retAInvoiceId}/credit-note`)
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({ reason: 'test' });
    expect(cnForbid.status).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────────
  it('9. Duplicate credit note on same invoice is rejected', async () => {
    await runSection5Scenario();

    // First CN succeeds
    const cn1 = await request(app)
      .post(`/invoices/${retAInvoiceId}/credit-note`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ reason: 'First return' });
    expect(cn1.status).toBe(201);

    // Second CN on same invoice (now 'credit_note' status) is rejected
    const cn2 = await request(app)
      .post(`/invoices/${retAInvoiceId}/credit-note`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ reason: 'Double reversal attempt' });
    expect(cn2.status).toBe(400); // ValidationError → 400
  });

  // ─────────────────────────────────────────────────────────────────────────
  it('10. xlsx export returns valid Office Open XML binary', async () => {
    await runSection5Scenario();

    const res = await request(app)
      .get('/reports/stock-summary')
      .query({ format: 'xlsx' })
      .set('Authorization', `Bearer ${tokens.auditor}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    // xlsx files start with PK (zip file magic number 0x50 0x4B)
    expect(res.body[0]).toBe(0x50); // 'P'
    expect(res.body[1]).toBe(0x4B); // 'K'
  });
});
