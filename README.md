# Order-to-Audit System

A working prototype that takes a small South Indian snack manufacturer from a salesman's order to the auditor's monthly report. Every transaction is entered once at its source and flows into stock, production, costing and accounts.

Built for the NIT Tiruchirappalli (Centre for Digital Infrastructure) internship shortlisting task.
Live demo: https://order-to-audit-jxsy.onrender.com
Demo video: <paste unlisted YouTube/Drive link here>

## Run it

Requires Node.js 18 or newer. Run these from the repo root, one at a time (works in PowerShell, cmd and bash):

```
cd server
npm install
npm run seed
npm start
```

Open http://localhost:3000. Run the tests with `npm test`.

To reset to the clean benchmark data, stop the server, delete `server/data/order-to-audit.db`, then run `npm run seed` again.

## Test logins

All passwords are `password123`.

| Role | Username | Use it for |
| --- | --- | --- |
| Salesman | `sales1` | Mobile order entry, own orders and sales |
| Admin | `admin1` | Approve orders, GST invoices, dispatch, payments |
| Production | `prod1` | Purchases, production runs, overheads, costing |
| Auditor | `audit1` | Read-only reports and stock |
| Owner | `owner1` | Dashboard summary and reports |

## Stack and why

- **Node.js + Express** for the API: one language across the project and simple role-based middleware (JWT + bcrypt).
- **SQLite (better-sqlite3)**: stock updates touch several tables at once (raw stock down, finished goods up, ledger, audit log). SQLite gives real transactions with rollback and needs no setup, so the whole system runs with the three commands above.
- **Plain HTML, CSS and JS** served by Express from `server/public`: no build step, mobile-friendly pages for each role.
- **PDFKit and ExcelJS** for invoice PDFs and Excel exports. **Vitest + Supertest** for tests.

## What is built

**Must have (all done)**
- Login with five roles and role-based access (the auditor is strictly read-only)
- Masters: items, customers, raw materials, BOM, price list
- Mobile-friendly order entry and admin approval with a stock check
- GST tax invoice as PDF (GSTIN, HSN, CGST+SGST or IGST by place of supply, numbering by financial year)
- Production runs that update raw-material and finished-goods stock automatically
- Planned vs actual consumption and yield, with variance flagged against a tolerance (default 3%)
- Stock summary and stock ledger, every row linked to its source document
- Sales register and stock report, exportable to CSV and Excel

**Should have (all done)**
- Purchases and supplier records
- Payments, outstanding and ageing (0-30, 31-60, 61-90, 90+ days)
- Cost per packet with labour and power overheads, and margin
- GST summary of outward supplies in a GSTR-1 / GSTR-3B shape
- Variance alerts and an owner dashboard

**Also built**
- Credit notes: a posted invoice is cancelled with a credit note that reverses stock and receivable. Invoices are never deleted.
- Audit log of every write, with user and time
- Invoice share links (WhatsApp and email)

## Design decisions

- **Ledger-based stock.** Balance is always `SUM(stock_ledger)`. Nobody overwrites a number. The ledger and audit log are append-only, enforced by database triggers.
- **Exact arithmetic.** Money is stored as integer paisa, tax rates and variances as integer basis points, quantities as integers scaled by 1,000,000 using BigInt. No floats anywhere in money or stock maths.
- **Unit conversion.** kg, g, L, ml, pouch, packet and carton conversions live in a `unit_conversions` table.
- **Atomic writes.** Each business event runs in one transaction, so a failed production run or dispatch rolls back completely. Raw stock can never go negative (HTTP 409).
- **Costing method.** Raw and packaging materials use perpetual weighted average cost, computed from the ledger at the time of issue. Labour and power for a run are charged fully to that run's good output.

Full schema, invariants and the reports section are in [DESIGN.md](DESIGN.md).

## Benchmark results (Section 5 scenario)

Reproduced by `server/tests` and by hand in the UI.

| Check | Expected | System |
| --- | --- | --- |
| Flour closing balance | 120 kg | 120 kg |
| Oil closing balance | 19.5 L | 19.5 L |
| Pouches closing balance | 306 | 306 |
| Finished goods after run | 238 | 238 |
| Finished goods after Retailer A dispatch | 88 | 88 |
| Yield variance | -6%, flagged | -600 bps, flagged |
| Oil variance | +5%, flagged | +500 bps, flagged |
| Retailer A invoice | Rs 7,500 + 187.50 CGST + 187.50 SGST = Rs 7,875 | Rs 7,875 |
| Retailer A outstanding after Rs 4,000 payment | Rs 3,875 | Rs 3,875 |
| Distributor B (120 packets vs 88 in stock) | Shortage of 32 flagged, IGST if invoiced | Shortage of 32 flagged, IGST applied |
| Cost per packet | Own figure | Rs 31.14 |

How the cost per packet is derived: flour is valued at the weighted average of 100 kg at Rs 42 and 60 kg at Rs 45, which is Rs 43.125/kg. Material cost is flour Rs 1,725 + oil Rs 1,470 + spice mix Rs 240 + 194 pouches Rs 485 + 9 cartons Rs 135 = Rs 4,055. Adding labour Rs 1,200 and power Rs 600 gives Rs 5,855. Divided by 188 good packets this is Rs 31.14, a margin of Rs 18.86 (37.7%) against the Rs 50 selling price.

## Assumptions

- GST is 5% on murukku and the factory is in Tamil Nadu, so intra-state sales use CGST + SGST and Karnataka sales use IGST.
- The 6 damaged pouches are counted as consumed in production, so pouch consumption is 194 (188 good + 6 damaged).
- Opening stock is booked as the first ledger entry for each item, at its opening rate.
- The variance tolerance is 3% and is a company setting.
- Customer-specific pricing is not modelled. One price list entry per item applies to all customers.

## Known gaps

- No offline order capture and sync. The order page only shows an offline message when a request fails.
- No batch numbers or expiry dates, and no first-expiry-first-out dispatch.
- No Tally export, e-Invoice / e-Way Bill format, GPS visit log, or Tamil interface.
- The UI is plain HTML pages rather than a React PWA.
- Not hosted online. Run it locally with the commands above.
