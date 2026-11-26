import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { initSchema, openDb } from '../src/db/connection.js';
import { seedDatabase } from '../src/db/seed.js';

describe('Order-to-Audit Step 4a: Static Web UI', () => {
  let db;
  let app;

  beforeEach(() => {
    db = openDb(':memory:');
    initSchema(db);
    seedDatabase(db, { bcryptRounds: 4 });
    app = createApp({ db, jwtSecret: 'test-jwt-secret' });
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

    for (const path of ['/style.css', '/app.js', '/orders.html', '/admin.html', '/production.html', '/reports.html']) {
      const res = await request(app).get(path);
      expect(res.status, `Expected 200 for ${path}`).toBe(200);
    }
  });
});
