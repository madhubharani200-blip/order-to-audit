import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSchema, openDb } from './connection.js';
import { toPaisa, toScaledQty } from '../lib/units.js';
import { appendStockMovement } from '../services/inventory.js';
import { recordAudit } from '../services/audit.js';

export function seedDatabase(db) {
  const existing = db.prepare('SELECT COUNT(*) AS cnt FROM items').get();
  if (existing.cnt > 0) {
    return getSeedLookup(db);
  }

  const runSeed = db.transaction(() => {
    db.prepare(`
      INSERT INTO company_settings (id, company_name, gstin, state, state_code, invoice_prefix)
      VALUES (1, ?, ?, ?, ?, ?)
    `).run('Kaveri Crunch Foods Pvt Ltd', '33AABCK1234F1Z5', 'Tamil Nadu', '33', 'INV');

    const insertUser = db.prepare(`
      INSERT INTO users (username, full_name, role, password_hash)
      VALUES (?, ?, ?, ?)
    `);
    const users = [
      ['owner1', 'Arunachalam S', 'owner', 'prototype-hash-owner'],
      ['admin1', 'Meenakshi R', 'admin', 'prototype-hash-admin'],
      ['prod1', 'Karthik V', 'production', 'prototype-hash-prod'],
      ['sales1', 'Suresh K', 'salesman', 'prototype-hash-sales'],
      ['audit1', 'Priya N', 'auditor', 'prototype-hash-audit'],
    ];
    for (const u of users) {
      insertUser.run(...u);
    }

    const adminUser = db.prepare("SELECT id FROM users WHERE username = 'admin1'").get();

    const insertItem = db.prepare(`
      INSERT INTO items (
        sku, name, item_type, unit, base_unit, to_base_scaled,
        hsn_code, gst_rate_bps, selling_price_paisa, standard_cost_paisa
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const itemDefs = [
      {
        sku: 'RM-FLOUR',
        name: 'Murukku Flour Mix',
        itemType: 'raw',
        unit: 'kg',
        baseUnit: 'g',
        toBase: 1000,
        hsn: '1102',
        gstBps: 0,
        sellingPaisa: 0,
        costPaisa: toPaisa('42.00'),
        openingQty: 100,
      },
      {
        sku: 'RM-OIL',
        name: 'Refined Groundnut Oil',
        itemType: 'raw',
        unit: 'L',
        baseUnit: 'ml',
        toBase: 1000,
        hsn: '1508',
        gstBps: 500,
        sellingPaisa: 0,
        costPaisa: toPaisa('140.00'),
        openingQty: 30,
      },
      {
        sku: 'RM-SPICE',
        name: 'Murukku Spice Mix',
        itemType: 'raw',
        unit: 'kg',
        baseUnit: 'g',
        toBase: 1000,
        hsn: '0910',
        gstBps: 500,
        sellingPaisa: 0,
        costPaisa: toPaisa('200.00'),
        openingQty: 5,
      },
      {
        sku: 'PKG-POUCH',
        name: 'Printed Pouch 200 g',
        itemType: 'packaging',
        unit: 'pouch',
        baseUnit: 'pcs',
        toBase: 1,
        hsn: '3923',
        gstBps: 1800,
        sellingPaisa: 0,
        costPaisa: toPaisa('2.50'),
        openingQty: 500,
      },
      {
        sku: 'PKG-CARTON',
        name: 'Master Carton (20 packets)',
        itemType: 'packaging',
        unit: 'carton',
        baseUnit: 'pcs',
        toBase: 1,
        hsn: '4819',
        gstBps: 1800,
        sellingPaisa: 0,
        costPaisa: toPaisa('15.00'),
        openingQty: 30,
      },
      {
        sku: 'FG-MURUKKU-200G',
        name: 'Murukku 200 g',
        itemType: 'finished',
        unit: 'packet',
        baseUnit: 'g',
        toBase: 200,
        hsn: '21069099',
        gstBps: 500,
        sellingPaisa: toPaisa('50.00'),
        costPaisa: toPaisa('20.00'),
        openingQty: 50,
      },
    ];

    const itemIds = {};
    for (const def of itemDefs) {
      const info = insertItem.run(
        def.sku,
        def.name,
        def.itemType,
        def.unit,
        def.baseUnit,
        toScaledQty(def.toBase),
        def.hsn,
        def.gstBps,
        def.sellingPaisa,
        def.costPaisa
      );
      const itemId = Number(info.lastInsertRowid);
      itemIds[def.sku] = itemId;

      appendStockMovement(db, {
        itemId,
        qtyScaled: toScaledQty(def.openingQty),
        unit: def.unit,
        unitCostPaisa: def.costPaisa,
        sourceType: 'opening',
        sourceId: itemId,
        notes: `Opening balance for ${def.sku}`,
        createdBy: adminUser.id,
      });
    }

    const insertConv = db.prepare(`
      INSERT INTO unit_conversions (item_id, from_unit, to_unit, multiplier_scaled)
      VALUES (?, ?, ?, ?)
    `);
    // Global conversions
    insertConv.run(null, 'kg', 'g', toScaledQty(1000));
    insertConv.run(null, 'g', 'kg', toScaledQty('0.001'));
    insertConv.run(null, 'L', 'ml', toScaledQty(1000));
    insertConv.run(null, 'ml', 'L', toScaledQty('0.001'));
    // Item-specific conversions for Murukku 200 g and Carton
    insertConv.run(itemIds['FG-MURUKKU-200G'], 'carton', 'packet', toScaledQty(20));
    insertConv.run(itemIds['FG-MURUKKU-200G'], 'packet', 'carton', toScaledQty('0.05'));
    insertConv.run(itemIds['FG-MURUKKU-200G'], 'packet', 'g', toScaledQty(200));
    insertConv.run(itemIds['FG-MURUKKU-200G'], 'g', 'packet', toScaledQty('0.005'));
    insertConv.run(itemIds['PKG-CARTON'], 'carton', 'packet', toScaledQty(20));

    // BOM: Murukku 200 g per batch = 40 kg flour, 10 L oil, 1.2 kg spice mix, 200 pouches, 10 cartons, expected 200 packets
    const bomInfo = db
      .prepare(`
        INSERT INTO bom (code, name, finished_item_id, batch_description, expected_yield_scaled, yield_unit)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        'BOM-MURUKKU-200G',
        'Murukku 200 g Standard Batch',
        itemIds['FG-MURUKKU-200G'],
        '1 batch = 200 packets of 200 g (10 cartons of 20 packets each)',
        toScaledQty(200),
        'packet'
      );
    const bomId = Number(bomInfo.lastInsertRowid);

    const insertBomLine = db.prepare(`
      INSERT INTO bom_lines (bom_id, item_id, qty_per_batch_scaled, unit, line_type)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertBomLine.run(bomId, itemIds['RM-FLOUR'], toScaledQty(40), 'kg', 'raw');
    insertBomLine.run(bomId, itemIds['RM-OIL'], toScaledQty(10), 'L', 'raw');
    insertBomLine.run(bomId, itemIds['RM-SPICE'], toScaledQty('1.2'), 'kg', 'raw');
    insertBomLine.run(bomId, itemIds['PKG-POUCH'], toScaledQty(200), 'pouch', 'packaging');
    insertBomLine.run(bomId, itemIds['PKG-CARTON'], toScaledQty(10), 'carton', 'packaging');

    // Customers
    const insertCust = db.prepare(`
      INSERT INTO customers (code, name, gstin, state, state_code, address, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertCust.run(
      'CUST-RET-A',
      'Retailer A',
      '33AADCR1111A1Z2',
      'Tamil Nadu',
      '33',
      '14 Gandhi Bazaar, Madurai, Tamil Nadu',
      '9840011111'
    );
    insertCust.run(
      'CUST-DIST-B',
      'Distributor B',
      '29AABCD2222B1Z9',
      'Karnataka',
      '29',
      '45 Market Road, Bengaluru, Karnataka',
      '9845022222'
    );

    recordAudit(db, {
      actorUserId: adminUser.id,
      action: 'DATABASE_SEEDED',
      entityType: 'system',
      entityId: 1,
      after: { bomCode: 'BOM-MURUKKU-200G', itemCount: itemDefs.length, customerCount: 2 },
    });
  });

  runSeed();
  return getSeedLookup(db);
}

export function getSeedLookup(db) {
  const items = Object.fromEntries(
    db.prepare('SELECT id, sku, name, unit FROM items').all().map((r) => [r.sku, r])
  );
  const customers = Object.fromEntries(
    db.prepare('SELECT id, code, name, state, state_code FROM customers').all().map((r) => [r.code, r])
  );
  const users = Object.fromEntries(
    db.prepare('SELECT id, username, role FROM users').all().map((r) => [r.username, r])
  );
  const bom = db.prepare("SELECT * FROM bom WHERE code = 'BOM-MURUKKU-200G'").get();
  return { items, customers, users, bom };
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'order-to-audit.db');
  const db = openDb(dbPath);
  initSchema(db);
  const lookup = seedDatabase(db);
  console.log(`Seeded database at ${dbPath}`);
  console.log('Items:', Object.keys(lookup.items).join(', '));
  db.close();
}
