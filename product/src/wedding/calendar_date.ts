import { ProductError } from '../product_error'

/**
 * @canonical calendar_date -- a local calendar date, `YYYY-MM-DD` (a wedding's date, a task's due date). Only real
 * dates pass: the JSON Schema patterns check the shape, this checks the calendar (no 2028-13-01, no 2028-02-30).
 * Pure UTC arithmetic on the string, so no time zone ever moves a date.
 */
export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** Refuse anything but a real `YYYY-MM-DD` date (PRODUCT.BAD_REQUEST), naming the field. */
export function assertDate(value: string, field: string): void {
  if (!isDate(value)) throw new ProductError('PRODUCT.BAD_REQUEST', `${field} must be a real date (YYYY-MM-DD).`, {})
}
