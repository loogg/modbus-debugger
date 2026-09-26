export const DEFAULT_DECIMAL_PLACES = 3;
export const MAX_DECIMAL_PLACES = 12;

export function resolveDecimalPlaces(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 && value <= MAX_DECIMAL_PLACES
    ? value
    : DEFAULT_DECIMAL_PLACES;
}

/** Display only: preserve the original numeric value for cache, recording and export. */
export function formatEngineeringNumber(value: number, decimalPlaces?: number): string {
  if (!Number.isFinite(value)) return '非有限数值';
  const fixed = value.toFixed(resolveDecimalPlaces(decimalPlaces));
  if (Number(fixed) === 0) return '0';
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}
