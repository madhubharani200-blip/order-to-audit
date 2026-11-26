PRAGMA foreign_keys = ON;

-- ============================================================================
-- Order-to-Audit System Schema (SQLite)
-- Conventions:
--   1. All monetary amounts are stored as INTEGER in paisa (1 INR = 100 paisa).
--   2. Tax rates and variances are stored as INTEGER basis points (1% = 100 bps).
--   3. All quantities are stored as INTEGER scaled by 1,000,000 (micro-units)
--      so decimal quantities (e.g., 10.5 L, 1.2 kg) remain exact without floats.
--   4. Stock balance is ALWAYS SUM(stock_ledger.qty_scaled) for an item.
-- ============================================================================

CREATE TABLE IF NOT EXISTS company_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT NOT NULL,
  gstin TEXT NOT NULL,
  state TEXT NOT NULL,
  state_code TEXT NOT NULL,
  invoice_prefix TEXT NOT NULL DEFAULT 'INV',
  variance_tolerance_bps INTEGER NOT NULL DEFAULT 300 CHECK (variance_tolerance_bps >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('salesman', 'admin', 'production', 'auditor', 'owner')),
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('raw', 'packaging', 'finished')),
  unit TEXT NOT NULL,
  base_unit TEXT NOT NULL,
  to_base_scaled INTEGER NOT NULL CHECK (to_base_scaled > 0),
  hsn_code TEXT,
  gst_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (gst_rate_bps >= 0),
  selling_price_paisa INTEGER NOT NULL DEFAULT 0 CHECK (selling_price_paisa >= 0),
  standard_cost_paisa INTEGER NOT NULL DEFAULT 0 CHECK (standard_cost_paisa >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS unit_conversions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  from_unit TEXT NOT NULL,
  to_unit TEXT NOT NULL,
  multiplier_scaled INTEGER NOT NULL CHECK (multiplier_scaled > 0),
  UNIQUE (item_id, from_unit, to_unit)
);

CREATE TABLE IF NOT EXISTS bom (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  finished_item_id INTEGER NOT NULL REFERENCES items(id),
  batch_description TEXT,
  expected_yield_scaled INTEGER NOT NULL CHECK (expected_yield_scaled > 0),
  yield_unit TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bom_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bom_id INTEGER NOT NULL REFERENCES bom(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty_per_batch_scaled INTEGER NOT NULL CHECK (qty_per_batch_scaled > 0),
  unit TEXT NOT NULL,
  line_type TEXT NOT NULL CHECK (line_type IN ('raw', 'packaging')),
  UNIQUE (bom_id, item_id)
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_number TEXT NOT NULL UNIQUE,
  supplier_name TEXT NOT NULL,
  purchase_date TEXT NOT NULL,
  total_amount_paisa INTEGER NOT NULL CHECK (total_amount_paisa >= 0),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty_scaled INTEGER NOT NULL CHECK (qty_scaled > 0),
  unit TEXT NOT NULL,
  rate_paisa INTEGER NOT NULL CHECK (rate_paisa >= 0),
  line_total_paisa INTEGER NOT NULL CHECK (line_total_paisa >= 0)
);

CREATE TABLE IF NOT EXISTS production_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_number TEXT NOT NULL UNIQUE,
  bom_id INTEGER NOT NULL REFERENCES bom(id),
  batches_planned_scaled INTEGER NOT NULL CHECK (batches_planned_scaled > 0),
  expected_yield_scaled INTEGER NOT NULL CHECK (expected_yield_scaled > 0),
  actual_good_yield_scaled INTEGER NOT NULL CHECK (actual_good_yield_scaled >= 0),
  yield_variance_scaled INTEGER NOT NULL,
  yield_variance_bps INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
  run_date TEXT NOT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS production_run_consumptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  production_run_id INTEGER NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  expected_qty_scaled INTEGER NOT NULL CHECK (expected_qty_scaled >= 0),
  actual_qty_scaled INTEGER NOT NULL CHECK (actual_qty_scaled >= 0),
  damaged_qty_scaled INTEGER NOT NULL DEFAULT 0 CHECK (damaged_qty_scaled >= 0),
  total_issued_scaled INTEGER NOT NULL CHECK (total_issued_scaled >= 0),
  variance_scaled INTEGER NOT NULL,
  variance_bps INTEGER NOT NULL,
  UNIQUE (production_run_id, item_id)
);

CREATE TABLE IF NOT EXISTS production_run_overheads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  production_run_id INTEGER NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('labour', 'power', 'gas', 'other')),
  description TEXT,
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa >= 0),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prod_overheads_run_id ON production_run_overheads(production_run_id);

CREATE TABLE IF NOT EXISTS stock_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty_scaled INTEGER NOT NULL CHECK (qty_scaled != 0),
  unit TEXT NOT NULL,
  unit_cost_paisa INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_paisa >= 0),
  source_type TEXT NOT NULL CHECK (
    source_type IN (
      'opening',
      'purchase',
      'production_issue',
      'production_damage',
      'production_output',
      'dispatch',
      'adjustment',
      'return'
    )
  ),
  source_id INTEGER NOT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stock_ledger_item_id ON stock_ledger(item_id);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_source ON stock_ledger(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_created_at ON stock_ledger(created_at);

CREATE TRIGGER IF NOT EXISTS trg_stock_ledger_no_update
BEFORE UPDATE ON stock_ledger
BEGIN
  SELECT RAISE(ABORT, 'stock_ledger is append-only and cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS trg_stock_ledger_no_delete
BEFORE DELETE ON stock_ledger
BEGIN
  SELECT RAISE(ABORT, 'stock_ledger is append-only and cannot be deleted');
END;

CREATE VIEW IF NOT EXISTS v_stock_balance AS
SELECT
  i.id AS item_id,
  i.sku,
  i.name,
  i.item_type,
  i.unit,
  COALESCE(SUM(sl.qty_scaled), 0) AS balance_scaled,
  ROUND(COALESCE(SUM(sl.qty_scaled), 0) / 1000000.0, 6) AS balance_qty
FROM items i
LEFT JOIN stock_ledger sl ON sl.item_id = i.id
GROUP BY i.id, i.sku, i.name, i.item_type, i.unit;

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  gstin TEXT,
  state TEXT NOT NULL,
  state_code TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  order_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (
    status IN ('draft', 'pending', 'approved', 'confirmed', 'partially_dispatched', 'dispatched', 'cancelled')
  ),
  shortage_approved INTEGER NOT NULL DEFAULT 0 CHECK (shortage_approved IN (0, 1)),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  total_amount_paisa INTEGER NOT NULL DEFAULT 0 CHECK (total_amount_paisa >= 0),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty_ordered_scaled INTEGER NOT NULL CHECK (qty_ordered_scaled > 0),
  qty_dispatched_scaled INTEGER NOT NULL DEFAULT 0 CHECK (qty_dispatched_scaled >= 0),
  unit TEXT NOT NULL,
  unit_price_paisa INTEGER NOT NULL CHECK (unit_price_paisa >= 0),
  line_total_paisa INTEGER NOT NULL CHECK (line_total_paisa >= 0)
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL UNIQUE,
  financial_year TEXT NOT NULL,
  seq_number INTEGER NOT NULL CHECK (seq_number != 0),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  order_id INTEGER REFERENCES orders(id),
  invoice_date TEXT NOT NULL,
  place_of_supply_state TEXT NOT NULL,
  supply_type TEXT NOT NULL CHECK (supply_type IN ('intra_state', 'inter_state')),
  subtotal_paisa INTEGER NOT NULL CHECK (subtotal_paisa >= 0),
  cgst_paisa INTEGER NOT NULL DEFAULT 0 CHECK (cgst_paisa >= 0),
  sgst_paisa INTEGER NOT NULL DEFAULT 0 CHECK (sgst_paisa >= 0),
  igst_paisa INTEGER NOT NULL DEFAULT 0 CHECK (igst_paisa >= 0),
  total_tax_paisa INTEGER NOT NULL CHECK (total_tax_paisa >= 0),
  grand_total_paisa INTEGER NOT NULL CHECK (grand_total_paisa >= 0),
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('draft', 'issued', 'partially_paid', 'paid', 'cancelled', 'credit_note')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (financial_year, seq_number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_fy ON invoices(financial_year, seq_number);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  hsn_code TEXT NOT NULL,
  qty_scaled INTEGER NOT NULL CHECK (qty_scaled > 0),
  unit TEXT NOT NULL,
  unit_price_paisa INTEGER NOT NULL CHECK (unit_price_paisa >= 0),
  taxable_value_paisa INTEGER NOT NULL CHECK (taxable_value_paisa >= 0),
  gst_rate_bps INTEGER NOT NULL CHECK (gst_rate_bps >= 0),
  cgst_paisa INTEGER NOT NULL DEFAULT 0 CHECK (cgst_paisa >= 0),
  sgst_paisa INTEGER NOT NULL DEFAULT 0 CHECK (sgst_paisa >= 0),
  igst_paisa INTEGER NOT NULL DEFAULT 0 CHECK (igst_paisa >= 0),
  line_total_paisa INTEGER NOT NULL CHECK (line_total_paisa >= 0)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  invoice_id INTEGER REFERENCES invoices(id),
  payment_date TEXT NOT NULL,
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa > 0),
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('cash', 'upi', 'bank_transfer', 'cheque')),
  reference_no TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS price_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  customer_id INTEGER REFERENCES customers(id),
  price_paisa INTEGER NOT NULL CHECK (price_paisa >= 0),
  effective_from TEXT NOT NULL DEFAULT (date('now')),
  effective_to TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_price_list_lookup ON price_list(item_id, customer_id, is_active);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);

CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only and cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only and cannot be deleted');
END;
