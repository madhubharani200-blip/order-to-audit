import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { initSchema, openDb } from '../src/db/connection.js';
import { DEFAULT_SEED_PASSWORD, seedDatabase } from '../src/db/seed.js';

describe('Order-to-Audit Step 4a: Static Web UI', () => {
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
  });

  afterEach(() => {
    db.close();
  });

  it('redirects / to /login.html and serves /login.html and UI assets', async () => {
    const rootRes = await request(app).get('/');
    expect(rootRes.status).toBe(302);
    expect(rootRes.headers.location).toBe('/login.html');

    const loginRes = await request(app).get('/login.html');
    expect(loginRes.status).toBe(200);
    expect(loginRes.headers['content-type']).toMatch(/text\/html/);
    expect(loginRes.text).toContain('/auth/login');

    for (const path of ['/style.css', '/app.js', '/orders.html', '/admin.html', '/production.html', '/reports.html', '/stock.html']) {
      const res = await request(app).get(path);
      expect(res.status, `Expected 200 for ${path}`).toBe(200);
    }
  });

  it('POST /invoices with the body shape admin.html sends (orderId + lines from order) returns 201 with total 787500', async () => {
    const { items, customers } = seed;

    // Build up stock: purchase flour + production run → 238 FG packets
    await request(app)
      .post('/purchases')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({
        purchaseNumber: 'PUR-UI-001',
        supplierName: 'Erode Agro Mills',
        purchaseDate: '2026-11-26',
        lines: [{ itemId: items['RM-FLOUR'].id, qty: 60, ratePaisa: 4500 }],
      });

    await request(app)
      .post('/production-runs')
      .set('Authorization', `Bearer ${tokens.production}`)
      .send({
        runNumber: 'PRD-UI-001',
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

    // Salesman creates order for 150 packets
    const orderRes = await request(app)
      .post('/orders')
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({
        customerId: customers['CUST-RET-A'].id,
        orderDate: '2026-11-26',
        lines: [{ itemId: items['FG-MURUKKU-200G'].id, qty: 150 }],
      });
    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.order.id;

    // Admin approves the order
    const approveRes = await request(app)
      .post(`/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${tokens.admin}`);
    expect(approveRes.status).toBe(200);

    // Fetch order detail (same as admin.html does)
    const detailRes = await request(app)
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${tokens.admin}`);
    expect(detailRes.status).toBe(200);
    const order = detailRes.body.order;
    const oLines = detailRes.body.lines;

    // Build invoice body exactly the way admin.html does after the fix:
    //   lines = oLines.map(l => ({ itemId: l.item_id, qty: l.qty_ordered_scaled / 1_000_000 }))
    const lines = oLines.map(l => ({ itemId: l.item_id, qty: l.qty_ordered_scaled / 1_000_000 }));

    const invRes = await request(app)
      .post('/invoices')
      .set('Authorization', `Bearer ${tokens.salesman}`)
      .send({
        customerId: order.customer_id,
        orderId,
        invoiceDate: new Date().toISOString().slice(0, 10),
        lines,
      });

    expect(invRes.status).toBe(201);
    expect(invRes.body.invoice.grandTotalPaisa).toBe(787500);
  });
});
