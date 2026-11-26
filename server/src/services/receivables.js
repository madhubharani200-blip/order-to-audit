import { NotFoundError } from '../lib/errors.js';
import { paisaToRupees } from '../lib/units.js';

function diffDays(laterIsoDate, earlierIsoDate) {
  const t1 = Date.parse(laterIsoDate.slice(0, 10));
  const t2 = Date.parse(earlierIsoDate.slice(0, 10));
  if (Number.isNaN(t1) || Number.isNaN(t2)) return 0;
  return Math.max(0, Math.floor((t1 - t2) / 86_400_000));
}

function getAgeBucket(days) {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

export function getCustomerOutstanding(
  db,
  customerId,
  asOfDate = new Date().toISOString().slice(0, 10)
) {
  const customer = db
    .prepare('SELECT id, code, name, gstin, state, state_code FROM customers WHERE id = ?')
    .get(customerId);
  if (!customer) {
    throw new NotFoundError(`Customer not found: ${customerId}`);
  }

  const invoices = db
    .prepare(`
      SELECT
        i.*,
        COALESCE(SUM(p.amount_paisa), 0) AS paid_paisa
      FROM invoices i
      LEFT JOIN payments p ON p.invoice_id = i.id
      WHERE i.customer_id = ? AND i.status NOT IN ('cancelled', 'draft')
      GROUP BY i.id
      ORDER BY i.invoice_date ASC, i.id ASC
    `)
    .all(customerId);

  const unallocatedRow = db
    .prepare(
      'SELECT COALESCE(SUM(amount_paisa), 0) AS unallocated_paisa FROM payments WHERE customer_id = ? AND invoice_id IS NULL'
    )
    .get(customerId);

  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  let totalInvoicedPaisa = 0;
  let totalPaidOnInvoicesPaisa = 0;
  let totalOutstandingPaisa = 0;

  const invoiceDetails = invoices.map((inv) => {
    const outstandingPaisa = Math.max(0, inv.grand_total_paisa - inv.paid_paisa);
    const ageDays = diffDays(asOfDate, inv.invoice_date);
    const ageBucket = getAgeBucket(ageDays);

    totalInvoicedPaisa += inv.grand_total_paisa;
    totalPaidOnInvoicesPaisa += inv.paid_paisa;
    totalOutstandingPaisa += outstandingPaisa;
    if (outstandingPaisa > 0) {
      buckets[ageBucket] += outstandingPaisa;
    }

    return {
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number,
      invoiceDate: inv.invoice_date,
      grandTotalPaisa: inv.grand_total_paisa,
      paidPaisa: inv.paid_paisa,
      outstandingPaisa,
      outstandingRupees: paisaToRupees(outstandingPaisa),
      ageDays,
      ageBucket,
      status: inv.status,
    };
  });

  const unallocatedPaymentsPaisa = unallocatedRow.unallocated_paisa;
  const totalPaidPaisa = totalPaidOnInvoicesPaisa + unallocatedPaymentsPaisa;
  const netOutstandingPaisa = Math.max(0, totalOutstandingPaisa - unallocatedPaymentsPaisa);

  return {
    customer,
    asOfDate,
    totalInvoicedPaisa,
    totalPaidPaisa,
    unallocatedPaymentsPaisa,
    totalOutstandingPaisa: netOutstandingPaisa,
    totalOutstandingRupees: paisaToRupees(netOutstandingPaisa),
    buckets,
    invoices: invoiceDetails,
  };
}

export function getOutstandingReport(
  db,
  { asOfDate = new Date().toISOString().slice(0, 10), onlyWithBalance = false } = {}
) {
  const customers = db.prepare('SELECT id FROM customers ORDER BY id').all();
  const perCustomer = customers
    .map((c) => getCustomerOutstanding(db, c.id, asOfDate))
    .filter((entry) => (!onlyWithBalance ? true : entry.totalOutstandingPaisa > 0))
    .sort((a, b) => b.totalOutstandingPaisa - a.totalOutstandingPaisa);

  const summaryBuckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  let totalInvoicedPaisa = 0;
  let totalPaidPaisa = 0;
  let totalOutstandingPaisa = 0;

  for (const c of perCustomer) {
    totalInvoicedPaisa += c.totalInvoicedPaisa;
    totalPaidPaisa += c.totalPaidPaisa;
    totalOutstandingPaisa += c.totalOutstandingPaisa;
    summaryBuckets['0-30'] += c.buckets['0-30'];
    summaryBuckets['31-60'] += c.buckets['31-60'];
    summaryBuckets['61-90'] += c.buckets['61-90'];
    summaryBuckets['90+'] += c.buckets['90+'];
  }

  return {
    asOfDate,
    summary: {
      totalInvoicedPaisa,
      totalPaidPaisa,
      totalOutstandingPaisa,
      totalOutstandingRupees: paisaToRupees(totalOutstandingPaisa),
      buckets: summaryBuckets,
    },
    customers: perCustomer,
  };
}
