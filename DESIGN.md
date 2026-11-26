# Order-to-Audit System — Schema Design (Step 1)

## Core Invariants

1. **Append-only Stock Ledger (`stock_ledger`)**
   - Stock balances are **never** stored as mutable columns on `items` or overwritten in place.
   - Every stock change (opening balance, purchase receipt, production issue, production damage/waste, production output, sales dispatch, adjustment, return) appends a signed row to `stock_ledger` referencing `(source_type, source_id)`.
   - Current stock balance for any item is always `COALESCE(SUM(qty_scaled), 0)` from `stock_ledger`, exposed via the `v_stock_balance` view.
   - SQLite `BEFORE UPDATE` and `BEFORE DELETE` triggers enforce immutability on both `stock_ledger` and `audit_log`.

2. **Exact Integer Money (`*_paisa`) and Basis Points (`*_bps`)**
   - All monetary values (rates, costs, selling prices, taxable values, CGST/SGST/IGST, grand totals, payments) are stored as `INTEGER` in **paisa** (1 INR = 100 paisa). No floating-point columns or float arithmetic are used for money.
   - Tax rates and production variances are stored as `INTEGER` **basis points** (1% = 100 bps; e.g., 5% GST = `500` bps, `-6%` yield variance = `-600` bps).

3. **Safe Decimal Quantities (`*_scaled`)**
   - All quantities (e.g., `10.5 L` oil, `1.2 kg` spice mix, `188 packets`) are stored as `INTEGER` micro-units scaled by `1,000,000` (`1e6`), avoiding IEEE-754 floating-point drift in SQLite `SUM(...)` aggregations and JS arithmetic.
   - Calculations combining scaled quantities and paisa use `BigInt` with half-up rounding in [`server/src/lib/units.js`](server/src/lib/units.js).

## Entity Overview

| Domain | Tables | Purpose |
| --- | --- | --- |
| **System & RBAC** | `company_settings`, `users` | Factory GSTIN & Tamil Nadu state code (`33`), plus role-based users (`salesman`, `admin`, `production`, `auditor`, `owner`). |
| **Master Catalog & Units** | `items`, `unit_conversions` | Categorizes `raw`, `packaging`, and `finished` items with stock unit, base physical unit (`g`, `ml`, `pcs`), HSN code, GST rate (bps), and item/global unit conversion factors (e.g. `1 carton = 20 packets`, `1 kg = 1000 g`). |
| **Bill of Materials** | `bom`, `bom_lines` | Defines expected raw/packaging inputs per batch and expected finished yield (e.g. 200 packets of Murukku 200 g). |
| **Purchasing** | `purchases`, `purchase_lines` | Records supplier receipts and posts positive `purchase` movements into `stock_ledger` with unit cost in paisa. |
| **Production & Variance** | `production_runs`, `production_run_consumptions` | Records planned vs. actual yield and per-material expected vs. actual + damaged quantities, computing exact variance in bps and posting `production_issue`, `production_damage`, and `production_output` ledger rows. |
| **Inventory Ledger** | `stock_ledger`, `v_stock_balance` | Immutable movement log and live balance view derived strictly by `SUM(qty_scaled)`. |
| **Sales & GST Invoicing** | `customers`, `orders`, `order_lines`, `invoices`, `invoice_lines`, `payments` | Customer GSTIN & state tracking, order fulfillment, financial-year sequential invoice numbering (`INV/YYYY-YY/NNNN`), intra-state (`CGST` + `SGST`) vs. inter-state (`IGST`) tax split by HSN, and payment tracking. |
| **Audit Trail** | `audit_log` | Immutable JSON before/after log of operational actions with actor and reason. |

## Costing Method

- **Weighted Average Material Costing**: Raw and packaging materials issued to a production run are valued at perpetual weighted average cost computed directly from `stock_ledger` chronologically (`ORDER BY id ASC`) up to the run's issue entries. Each inflow (`opening`, `purchase`) adds `qty_scaled` and exact `qty * unit_cost_paisa` to the running pool; earlier outflows deduct proportionally at the then-current pool average so the unit rate only shifts when stock is received at a new rate (e.g. `100 kg @ Rs 42` + `60 kg @ Rs 45` yields `160 kg` valued at `Rs 6,900` = `Rs 43.125/kg`, so issuing `40 kg` costs exactly `Rs 1,725.00` without intermediate unit-rate rounding error).
- **Direct Overhead Allocation**: Run overheads (`labour`, `power`, `gas`, `other` recorded in integer paisa in `production_run_overheads`) are charged 100% to that run's good output (`actual_good_yield_scaled`). Cost per good packet is `round((material_cost_paisa + overheads_paisa) / good_packets)` in integer paisa, and margin is computed against the finished item's selling price.
