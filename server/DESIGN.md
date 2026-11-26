# Order-to-Audit System — Design Notes

## Schema overview

SQLite database with the following core tables:

| Table | Purpose |
|---|---|
| `users` | Roles: salesman, admin, production, auditor, owner |
| `items` | Raw materials, packaging, finished goods; each has SKU, unit, HSN, selling price |
| `unit_conversions` | Conversion factors between units for the same item |
| `bom` / `bom_lines` | Bill of Materials: expected yield per batch and per-raw-material quantities |
| `stock_ledger` | **Append-only** — every stock movement (opening, purchase, production_issue, production_damage, production_output, dispatch, return, adjustment) |
| `customers` | GSTIN, state code, address |
| `orders` / `order_lines` | Customer orders with approval flow |
| `purchases` / `purchase_lines` | Supplier purchases — each line creates a stock_ledger row |
| `production_runs` / `production_run_consumptions` / `production_run_overheads` | Batch production: planned vs actual per raw material, good packets, damaged pouches, yield variance in bps |
| `invoices` / `invoice_lines` | Financial-year numbered (INV/YYYY-YY/NNNN); CGST+SGST for intra-state, IGST for inter-state; credit notes stored as CN/INV/... rows with `status = 'credit_note'` |
| `payments` | Cash / UPI / bank_transfer / cheque; linked to invoice and customer |
| `price_list` | Per-item or per-customer-per-item selling price with activation flag |
| `audit_log` | JSON before/after for every write, with actor and timestamp |
| `company_settings` | GSTIN, state, default yield-variance tolerance (bps) |

### Views

`v_stock_balance` — `SUM(qty_scaled)` per item from `stock_ledger`; stock balance is **never** an overwritten number, always derived.

---

## Money and quantity rules

- All money stored as **integer paisa** (1 rupee = 100 paisa). No floats for money.
- Quantities stored as `qty_scaled = qty × 1,000,000` (integer). `fromScaledQty` / `toScaledQty` helpers in `src/lib/units.js`.
- Variance stored as **basis points** (bps). 100 bps = 1 %.
- GST rates stored as bps (500 bps = 5 %).

---

## Auth and roles

JWT (HS256). Passwords hashed with bcrypt. Roles and their permissions:

| Role | Key permissions |
|---|---|
| salesman | Create orders and invoices; view own orders/invoices; stock summary |
| admin | Full CRUD on master data; approve orders; purchases; production runs; credit notes |
| production | Create and update production runs; add overheads; view production report |
| auditor | Read-only on all endpoints and reports |
| owner | Same as auditor + all reports |

---

## Costing method

Raw and packaging materials are valued by **weighted average cost** computed at the time of issue from the `stock_ledger`:

```
WAC at issue = SUM(qty_scaled × unit_cost_paisa) / SUM(qty_scaled)
              across all positive movements up to and including the issue timestamp
```

Overheads (labour, power/gas) are recorded per production run via `POST /production-runs/:id/overheads` and charged **fully** to that run's good output:

```
cost per good packet = (total material cost + total overheads) / good_packets
```

Margin is computed against the item's `selling_price_paisa`.

---

## Reports

All reports support `?from=YYYY-MM-DD&to=YYYY-MM-DD` date filters and `?format=json|csv|xlsx`. PDF is available on the invoice endpoint (`GET /invoices/:id/pdf`) only. The `xlsx` format is generated with ExcelJS (bolded, shaded header row).

| Report | Endpoint | Access |
|---|---|---|
| Sales Register | `GET /reports/sales-register` | admin, auditor, owner, salesman (own sales only) |
| Customer-wise Sales | `GET /reports/customer-sales` | admin, auditor, owner |
| Product-wise Sales | `GET /reports/product-sales` | admin, auditor, owner |
| GST Summary (GSTR-1/3B) | `GET /reports/gst-summary` | admin, auditor, owner |
| Purchase Register | `GET /reports/purchase-register` | admin, auditor, owner |
| Stock Summary | `GET /reports/stock-summary` | all roles |
| Stock Ledger | `GET /reports/stock-ledger` | all roles |
| Production Report | `GET /reports/production` | admin, auditor, owner, production |
| Payments & Collections | `GET /reports/payments` | admin, auditor, owner |
| Outstanding with Ageing | `GET /reports/outstanding` | all roles |

### GST Summary shape (GSTR-1 / GSTR-3B)

- **B2B** rows: one line per invoice-line for customers with a GSTIN. Fields: customer name, GSTIN, invoice number, date, HSN, GST rate (bps), taxable value, CGST, SGST, IGST (all in integer paisa).
- **B2C** rows: aggregated per HSN/rate for customers without a GSTIN.
- **Totals**: grand sums of taxable value, CGST, SGST, IGST, total tax, grand total.
- Credit notes (`status = 'credit_note'`) are **excluded** from all forward-sales reports.

### PDF Tax Invoice (`GET /invoices/:id/pdf`)

Built with PDFKit. Includes: seller GSTIN and state, buyer GSTIN and state, invoice number (financial-year series), HSN, taxable value, CGST+SGST (intra-state) or IGST (inter-state), grand total in rupees, and **amount in words** using the Indian numbering system (lakhs/crores).

### Share links (`GET /invoices/:id/share`)

Returns a WhatsApp deep-link (`https://wa.me/?text=…`) and a `mailto:` link with the invoice summary pre-filled in the message body.

### Credit Notes (`POST /invoices/:id/credit-note`)

- Admin only. Requires a `reason` string.
- Marks the original invoice `status = 'credit_note'` (never deleted).
- Reverses each dispatched item back to stock via a `source_type = 'return'` ledger entry.
- Creates a CN row (`CN/INV/YYYY-YY/NNNN`) with a negative `seq_number` (−1, −2 …) to satisfy the `UNIQUE (financial_year, seq_number)` constraint while keeping positive paisa values (sign is implicit from status).
- Logs the event to `audit_log`.
- A second credit note against an already-reversed invoice is rejected with `VALIDATION_ERROR`.
