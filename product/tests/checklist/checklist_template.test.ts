import { describe, expect, it } from 'vitest'

import { CHECKLIST_TEMPLATE, dateBefore, daysBetween, shiftDate } from '@wedding-planner/product'

/** Issue #31 — the built-in checklist and its date arithmetic (pure, UTC, no time zone can move a date). */

describe('checklist template', () => {
  it('schedules every item by months or days before the date, with unique, stable snake_case keys', () => {
    const keys = CHECKLIST_TEMPLATE.map((item) => item.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(key).toMatch(/^[a-z0-9_]{1,64}$/)
    const offsets = new Set(CHECKLIST_TEMPLATE.map((item) => JSON.stringify(item.before)))
    for (const expected of [{ months: 12 }, { months: 9 }, { months: 6 }, { months: 3 }, { months: 1 }, { days: 14 }, { days: 7 }]) {
      expect(offsets.has(JSON.stringify(expected))).toBe(true)
    }
  })

  it('moves a date back by months (clamped to a shorter month) or by days', () => {
    expect(dateBefore('2028-06-10', { months: 12 })).toBe('2027-06-10')
    expect(dateBefore('2028-03-31', { months: 1 })).toBe('2028-02-29') // leap year
    expect(dateBefore('2027-03-31', { months: 1 })).toBe('2027-02-28')
    expect(dateBefore('2028-01-15', { months: 3 })).toBe('2027-10-15') // across a year
    expect(dateBefore('2028-03-01', { days: 7 })).toBe('2028-02-23')
    expect(dateBefore('2028-01-05', { days: 14 })).toBe('2027-12-22')
  })

  it('shifts a date by days either way, and counts the days between two dates', () => {
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29')
    expect(shiftDate('2028-01-01', -1)).toBe('2027-12-31')
    expect(daysBetween('2028-06-10', '2028-06-24')).toBe(14)
    expect(daysBetween('2028-06-10', '2028-03-12')).toBe(-90)
    expect(daysBetween('2028-03-25', '2028-03-27')).toBe(2) // across a daylight-saving change elsewhere: still 2
  })
})
