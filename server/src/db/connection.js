import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export function openDb(dbPath = ':memory:') {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export function initSchema(db) {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql);
  return db;
}
