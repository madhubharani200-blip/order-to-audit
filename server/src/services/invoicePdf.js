import PDFDocument from 'pdfkit';
import { paisaToRupees } from '../lib/units.js';
import { paisaToWords } from '../lib/numWords.js';

function getFullInvoice(db, invoiceId) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv) return null;
  const company = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(inv.customer_id);
  const lines = db
    .prepare(`
      SELECT il.*, i.sku, i.name AS item_name, i.hsn_code
      FROM invoice_lines il
      JOIN items i ON i.id = il.item_id
      WHERE il.invoice_id = ?
      ORDER BY il.id
    `)
    .all(inv.id);
  return { inv, company, customer, lines };
}

export function buildInvoicePdf(db, invoiceId) {
  const data = getFullInvoice(db, invoiceId);
  if (!data) return null;
  const { inv, company, customer, lines } = data;

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const buffers = [];
  doc.on('data', (chunk) => buffers.push(chunk));

  const isCredit = inv.status === 'credit_note';
  const docTitle = isCredit ? 'CREDIT NOTE' : 'TAX INVOICE';

  // ── Header ───────────────────────────────────────────────────────────────
  doc.fontSize(14).font('Helvetica-Bold').text(company.company_name, { align: 'center' });
  doc.fontSize(9).font('Helvetica').text(`GSTIN: ${company.gstin}  |  State: ${company.state} (${company.state_code})`, { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(13).font('Helvetica-Bold').text(docTitle, { align: 'center' });
  doc.moveDown(0.5);

  // ── Invoice meta ─────────────────────────────────────────────────────────
  const metaY = doc.y;
  doc.fontSize(9).font('Helvetica-Bold').text('Invoice No:', 40, metaY);
  doc.font('Helvetica').text(inv.invoice_number, 130, metaY);

  doc.font('Helvetica-Bold').text('Date:', 300, metaY);
  doc.font('Helvetica').text(inv.invoice_date, 370, metaY);

  doc.moveDown(0.3);
  const metaY2 = doc.y;
  doc.font('Helvetica-Bold').text('Financial Year:', 40, metaY2);
  doc.font('Helvetica').text(inv.financial_year, 130, metaY2);

  doc.font('Helvetica-Bold').text('Place of Supply:', 300, metaY2);
  doc.font('Helvetica').text(inv.place_of_supply_state, 400, metaY2);

  doc.moveDown(0.5);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.3);

  // ── Buyer block ──────────────────────────────────────────────────────────
  const buyerY = doc.y;
  doc.fontSize(9).font('Helvetica-Bold').text('Bill To:', 40, buyerY);
  doc.font('Helvetica').text(customer.name, 40, buyerY + 12);
  if (customer.gstin) doc.text(`GSTIN: ${customer.gstin}`, 40);
  doc.text(`State: ${customer.state} (${customer.state_code})`, 40);
  if (customer.address) doc.text(customer.address, 40, undefined, { width: 240 });

  doc.moveDown(0.5);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.3);

  // ── Line items table ─────────────────────────────────────────────────────
  const colX = { sno: 40, desc: 60, hsn: 220, qty: 300, rate: 350, taxable: 410, tax: 470, total: 515 };
  const tableY = doc.y;

  doc.fontSize(8).font('Helvetica-Bold');
  doc.text('#', colX.sno, tableY);
  doc.text('Description', colX.desc, tableY);
  doc.text('HSN', colX.hsn, tableY);
  doc.text('Qty', colX.qty, tableY);
  doc.text('Rate', colX.rate, tableY);
  doc.text('Taxable', colX.taxable, tableY);
  doc.text('Tax', colX.tax, tableY);
  doc.text('Total', colX.total, tableY);
  doc.moveDown(0.3);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.2);

  doc.font('Helvetica').fontSize(8);
  lines.forEach((line, idx) => {
    const y = doc.y;
    const taxRate = `${(line.gst_rate_bps / 100).toFixed(0)}%`;
    const taxLabel =
      inv.supply_type === 'intra_state'
        ? `CGST ${taxRate}/2 + SGST ${taxRate}/2`
        : `IGST ${taxRate}`;
    const taxPaisa = line.cgst_paisa + line.sgst_paisa + line.igst_paisa;

    doc.text(String(idx + 1), colX.sno, y);
    doc.text(line.item_name, colX.desc, y, { width: 155 });
    doc.text(line.hsn_code, colX.hsn, y);
    doc.text(`${paisaToRupees(line.qty_scaled / 1_000_000)} ${line.unit}`, colX.qty, y);
    doc.text(`₹${paisaToRupees(line.unit_price_paisa).toFixed(2)}`, colX.rate, y);
    doc.text(`₹${paisaToRupees(line.taxable_value_paisa).toFixed(2)}`, colX.taxable, y);
    doc.text(taxLabel, colX.tax, y, { width: 55 });
    doc.text(`₹${paisaToRupees(line.line_total_paisa).toFixed(2)}`, colX.total, y);
    doc.moveDown(0.8);
  });

  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.3);

  // ── Tax summary ───────────────────────────────────────────────────────────
  const sumX = 350;
  doc.fontSize(9);
  const addRow = (label, amtPaisa) => {
    const y = doc.y;
    doc.font('Helvetica-Bold').text(label + ':', sumX, y, { width: 120 });
    doc.font('Helvetica').text(`₹${paisaToRupees(amtPaisa).toFixed(2)}`, 490, y, { align: 'right', width: 65 });
    doc.moveDown(0.3);
  };

  addRow('Taxable Value', inv.subtotal_paisa);
  if (inv.supply_type === 'intra_state') {
    addRow('CGST', inv.cgst_paisa);
    addRow('SGST', inv.sgst_paisa);
  } else {
    addRow('IGST', inv.igst_paisa);
  }
  doc.font('Helvetica-Bold');
  addRow('Grand Total', inv.grand_total_paisa);

  doc.moveDown(0.3);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.3);

  // ── Amount in words ───────────────────────────────────────────────────────
  doc.fontSize(9).font('Helvetica-Bold').text('Amount in Words: ', 40, doc.y, { continued: true });
  doc.font('Helvetica').text(paisaToWords(inv.grand_total_paisa));

  doc.moveDown(0.5);
  doc.fontSize(8).font('Helvetica').text(
    `This is a computer generated invoice. ${isCredit ? 'This credit note reverses the original tax invoice.' : 'No signature required.'}`,
    { align: 'center', color: '#666' }
  );

  doc.end();

  return new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}

export function buildInvoiceShareLinks(db, invoiceId, { baseUrl = '' } = {}) {
  const data = getFullInvoice(db, invoiceId);
  if (!data) return null;
  const { inv, company, customer } = data;
  const grandTotalRs = paisaToRupees(inv.grand_total_paisa).toFixed(2);

  const pdfUrl = `${baseUrl}/invoices/${invoiceId}/pdf`;
  const whatsappText = encodeURIComponent(
    `Dear ${customer.name},\n\nPlease find your invoice ${inv.invoice_number} dated ${inv.invoice_date}` +
    ` for ₹${grandTotalRs} from ${company.company_name} (GSTIN: ${company.gstin}).\n` +
    `Download PDF: ${pdfUrl}`
  );
  const mailtoBody = encodeURIComponent(
    `Dear ${customer.name},\n\nPlease find attached your GST Tax Invoice details:\n\n` +
    `Invoice No : ${inv.invoice_number}\nDate       : ${inv.invoice_date}\nAmount     : ₹${grandTotalRs}\n\n` +
    `Regards,\n${company.company_name}`
  );
  const mailtoSubject = encodeURIComponent(`Invoice ${inv.invoice_number} from ${company.company_name}`);

  return {
    invoiceNumber: inv.invoice_number,
    invoiceDate: inv.invoice_date,
    grandTotalRs,
    pdfUrl,
    whatsappLink: `https://wa.me/?text=${whatsappText}`,
    mailtoLink: `mailto:?subject=${mailtoSubject}&body=${mailtoBody}`,
  };
}
