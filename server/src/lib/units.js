export const QTY_SCALE = 1_000_000;
const QTY_SCALE_BIG = 1_000_000n;

/**
 * Convert a decimal number or numeric string into integer micro-units (scale 1e6)
 * without IEEE-754 floating-point multiplication drift.
 */
export function toScaledQty(value) {
  if (typeof value === 'bigint') {
    return Number(value * QTY_SCALE_BIG);
  }
  const str = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(str)) {
    throw new Error(`Invalid quantity: ${value}`);
  }
  const negative = str.startsWith('-');
  const unsigned = str.replace(/^[-+]/, '');
  const [intPartRaw, fracPartRaw = ''] = unsigned.split('.');
  if (fracPartRaw.length > 6) {
    throw new Error(`Quantity precision exceeds 6 decimal places: ${value}`);
  }
  const intPart = BigInt(intPartRaw || '0');
  const fracPart = BigInt(fracPartRaw.padEnd(6, '0'));
  const scaled = intPart * QTY_SCALE_BIG + fracPart;
  const result = negative ? -scaled : scaled;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`Quantity out of safe integer range: ${value}`);
  }
  return Number(result);
}

/**
 * Convert integer micro-units (scale 1e6) back to an exact JS number.
 */
export function fromScaledQty(scaled) {
  if (!Number.isInteger(scaled)) {
    throw new Error(`Scaled quantity must be an integer, got: ${scaled}`);
  }
  const negative = scaled < 0;
  const abs = Math.abs(scaled);
  const intPart = Math.trunc(abs / QTY_SCALE);
  const fracPart = String(abs % QTY_SCALE).padStart(6, '0').replace(/0+$/, '');
  const str = `${negative ? '-' : ''}${intPart}${fracPart ? `.${fracPart}` : ''}`;
  return Number(str);
}

/**
 * Convert rupees (number or decimal string, e.g. 2.50) to exact integer paisa.
 */
export function toPaisa(rupees) {
  const str = typeof rupees === 'number' ? rupees.toFixed(2) : String(rupees ?? '').trim();
  if (!/^[-+]?(\d+(\.\d{1,2})?|\.\d{1,2})$/.test(str)) {
    throw new Error(`Invalid rupee amount: ${rupees}`);
  }
  const negative = str.startsWith('-');
  const unsigned = str.replace(/^[-+]/, '');
  const [intPartRaw, fracPartRaw = ''] = unsigned.split('.');
  const paisa = Number(intPartRaw || '0') * 100 + Number(fracPartRaw.padEnd(2, '0'));
  return negative ? -paisa : paisa;
}

/**
 * Format integer paisa as rupees number (for assertions/display only; never store floats).
 */
export function paisaToRupees(paisa) {
  if (!Number.isInteger(paisa)) {
    throw new Error(`Paisa must be an integer, got: ${paisa}`);
  }
  return Number((paisa / 100).toFixed(2));
}

/**
 * Multiply scaled quantity (1e6) by rate in integer paisa, rounding half-up to integer paisa.
 */
export function mulScaledQtyByPaisa(qtyScaled, ratePaisa) {
  if (!Number.isInteger(qtyScaled) || !Number.isInteger(ratePaisa)) {
    throw new Error('mulScaledQtyByPaisa requires integer arguments');
  }
  const product = BigInt(qtyScaled) * BigInt(ratePaisa);
  const sign = product < 0n ? -1n : 1n;
  const abs = product < 0n ? -product : product;
  const rounded = (abs + 500_000n) / QTY_SCALE_BIG;
  return Number(sign * rounded);
}

/**
 * Multiply two scaled quantities (each 1e6), returning a scaled quantity (1e6).
 */
export function mulScaled(aScaled, bScaled) {
  if (!Number.isInteger(aScaled) || !Number.isInteger(bScaled)) {
    throw new Error('mulScaled requires integer arguments');
  }
  const product = BigInt(aScaled) * BigInt(bScaled);
  const sign = product < 0n ? -1n : 1n;
  const abs = product < 0n ? -product : product;
  const rounded = (abs + 500_000n) / QTY_SCALE_BIG;
  return Number(sign * rounded);
}

/**
 * Calculate integer basis points variance: ((actual - expected) * 10000) / expected.
 * E.g. -6% -> -600 bps, +5% -> +500 bps.
 */
export function calcVarianceBps(actualScaled, expectedScaled) {
  if (!Number.isInteger(actualScaled) || !Number.isInteger(expectedScaled) || expectedScaled === 0) {
    throw new Error('Invalid quantities for variance calculation');
  }
  const diff = BigInt(actualScaled) - BigInt(expectedScaled);
  const absDiff = diff < 0n ? -diff : diff;
  const sign = diff < 0n ? -1n : 1n;
  const exp = BigInt(expectedScaled);
  const bps = (absDiff * 10_000n + exp / 2n) / exp;
  return Number(sign * bps);
}

/**
 * Convert basis points to percentage number (e.g. -600 bps -> -6, 500 bps -> 5).
 */
export function bpsToPercent(bps) {
  if (!Number.isInteger(bps)) {
    throw new Error(`bps must be an integer, got: ${bps}`);
  }
  return bps / 100;
}

/**
 * Calculate GST components in integer paisa using basis points.
 */
export function calcGstSplit({ taxableValuePaisa, gstRateBps, supplyType }) {
  if (!Number.isInteger(taxableValuePaisa) || !Number.isInteger(gstRateBps)) {
    throw new Error('GST inputs must be integers');
  }
  const taxable = BigInt(taxableValuePaisa);
  const rate = BigInt(gstRateBps);

  if (supplyType === 'inter_state') {
    const igst = Number((taxable * rate + 5000n) / 10_000n);
    return {
      cgstPaisa: 0,
      sgstPaisa: 0,
      igstPaisa: igst,
      totalTaxPaisa: igst,
    };
  }

  if (supplyType === 'intra_state') {
    const halfRate = rate / 2n;
    const cgst = Number((taxable * halfRate + 5000n) / 10_000n);
    const sgst = Number((taxable * (rate - halfRate) + 5000n) / 10_000n);
    return {
      cgstPaisa: cgst,
      sgstPaisa: sgst,
      igstPaisa: 0,
      totalTaxPaisa: cgst + sgst,
    };
  }

  throw new Error(`Invalid supplyType: ${supplyType}`);
}

/**
 * Indian Financial Year helper (April 1 to March 31). E.g. 2026-11-26 -> '2026-27'.
 */
export function getFinancialYear(isoDateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDateStr);
  if (!match) {
    throw new Error(`Invalid ISO date string: ${isoDateStr}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const startYear = month >= 4 ? year : year - 1;
  const endYearShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endYearShort}`;
}
