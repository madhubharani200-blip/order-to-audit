import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { initSchema, openDb } from './db/connection.js';
import { seedDatabase } from './db/seed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.resolve(__dirname, '../data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.DB_PATH || path.join(dataDir, 'order-to-audit.db');

const db = openDb(dbPath);
initSchema(db);
seedDatabase(db);

const jwtSecret = process.env.JWT_SECRET || 'order-to-audit-dev-secret';
const app = createApp({ db, jwtSecret });
const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
  console.log(`Order-to-Audit API listening on http://localhost:${port}`);
});
