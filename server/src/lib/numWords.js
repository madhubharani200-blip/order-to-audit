/**
 * Number-to-words for Indian Rupees (up to 99,99,99,999 rupees).
 * Input is integer paisa; output e.g. "Seven Thousand Eight Hundred Seventy-Five Rupees Only".
 */

const ones = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen',
  'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigit(n) {
  if (n < 20) return ones[n];
  const t = tens[Math.floor(n / 10)];
  const o = ones[n % 10];
  return o ? `${t}-${o}` : t;
}

function threeDigit(n) {
  const h = Math.floor(n / 100);
  const rem = n % 100;
  const hStr = h ? `${ones[h]} Hundred` : '';
  const remStr = twoDigit(rem);
  if (hStr && remStr) return `${hStr} ${remStr}`;
  return hStr || remStr;
}

export function paisaToWords(paisa) {
  if (!Number.isInteger(paisa) || paisa < 0) {
    throw new Error(`paisaToWords requires a non-negative integer, got: ${paisa}`);
  }
  const rupees = Math.trunc(paisa / 100);
  const paise = paisa % 100;

  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';

  const crore = Math.trunc(rupees / 10_000_000);
  const lakh = Math.trunc((rupees % 10_000_000) / 100_000);
  const thousand = Math.trunc((rupees % 100_000) / 1_000);
  const rem = rupees % 1_000;

  const parts = [];
  if (crore) parts.push(`${threeDigit(crore)} Crore`);
  if (lakh) parts.push(`${twoDigit(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigit(thousand)} Thousand`);
  if (rem) parts.push(threeDigit(rem));

  let result = `${parts.join(' ')} Rupee${rupees !== 1 ? 's' : ''}`;
  if (paise) result += ` and ${twoDigit(paise)} Paise`;
  return `${result} Only`;
}
