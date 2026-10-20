import type { Household, WeddingGuest } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { GUEST_CSV_LIMITS, type GuestListView, neutralize, parseCsv, planGuestImport, toGuestCsv, unneutralize } from '@wedding-planner/product'

/**
 * Issue #28 — the guest list as CSV, as pure functions: RFC 4180 parsing, formula neutralization (CSV injection),
 * the export's shape, and the import plan's validation (every problem by row, nothing applied with one).
 */

const HEADER = 'household,address,first_name,last_name,side,tags,plus_one_allowed,plus_one_of,dietary,email,phone'

function household(id: string, name: string, address?: string): Household {
  return { household_id: id, tenant_id: 't', wedding_id: 'w', name, ...(address === undefined ? {} : { address }), created_at: '2027-01-01T00:00:00.000Z' }
}

function guest(id: string, household_id: string, first: string, last: string, extra: Partial<WeddingGuest> = {}): WeddingGuest {
  return {
    guest_id: id,
    tenant_id: 't',
    wedding_id: 'w',
    household_id,
    first_name: first,
    last_name: last,
    side: 'both',
    tags: [],
    plus_one_allowed: false,
    created_at: '2027-01-01T00:00:00.000Z',
    ...extra,
  }
}

function view(households: Household[], guests: WeddingGuest[]): GuestListView {
  return { households, guests, counts: { guests: guests.length, households: households.length, plus_ones: 0, by_side: { partner_one: 0, partner_two: 0, both: 0 } } }
}

const EMPTY = view([], [])
const csv = (...rows: string[]): string => [HEADER, ...rows].join('\n')

describe('parseCsv', () => {
  it('reads quoted cells, doubled quotes, commas and newlines inside quotes, CRLF and a BOM', () => {
    expect(parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\n"two\nlines",\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\nlines', ''],
    ])
    expect(parseCsv('a,b')).toEqual([['a', 'b']])
    expect(parseCsv('')).toEqual([])
  })

  it('refuses an unterminated quoted cell (PRODUCT.BAD_REQUEST)', () => {
    expect(() => parseCsv('a,"b\n')).toThrow(expect.objectContaining({ code: 'PRODUCT.BAD_REQUEST' }))
  })
})

describe('formula neutralization', () => {
  it('prefixes every cell a spreadsheet would evaluate, and the import undoes it', () => {
    for (const cell of ['=1+1', '+15550100', '-2', '@SUM(A1)', '\tx', '\rx']) {
      expect(neutralize(cell)).toBe(`'${cell}`)
      expect(unneutralize(neutralize(cell))).toBe(cell)
    }
    expect(neutralize('Ana')).toBe('Ana')
    expect(unneutralize("'plain")).toBe("'plain") // only a neutralized formula is unwrapped
  })
})

describe('toGuestCsv', () => {
  it('writes a BOM, the header and one CRLF row per guest, with plus-ones naming their host', () => {
    const h = household('h1', 'The Rivera family', '1 Main St, Springfield')
    const host = guest('g1', 'h1', 'Ana', 'Rivera', { plus_one_allowed: true, tags: ['family', 'vip'], side: 'partner_one', phone: '+1 555 0100' })
    const plusOne = guest('g2', 'h1', 'Sam', '', { plus_one_of: 'g1' })
    const out = toGuestCsv(view([h], [host, plusOne]))
    expect(out.startsWith(`\uFEFF${HEADER}\r\n`)).toBe(true)
    expect(out.split('\r\n')).toEqual([
      `\uFEFF${HEADER}`,
      `The Rivera family,"1 Main St, Springfield",Ana,Rivera,partner_one,family; vip,yes,,,,'+1 555 0100`,
      'The Rivera family,"1 Main St, Springfield",Sam,,both,,no,Ana Rivera,,,',
      '',
    ])
  })

  it('neutralizes a formula in any cell, inside quotes too', () => {
    const out = toGuestCsv(view([household('h1', '=HYPERLINK("http://x")')], [guest('g1', 'h1', '@cmd', '-x', { dietary: '=1, 2' })]))
    expect(out).toContain(`"'=HYPERLINK(""http://x"")"`)
    expect(out).toContain(`'@cmd,'-x`)
    expect(out).toContain(`"'=1, 2"`)
  })
})

describe('planGuestImport', () => {
  it('plans creates for a clean file, with new households counted once', () => {
    const plan = planGuestImport(EMPTY, csv('Rivera,,Ana,Rivera,partner_one,Family; VIP,yes,,,,', 'Rivera,,Luis,Rivera,,,,,,,', 'Chen,,Mei,Chen,two,,,,vegan,mei@example.test,'))
    expect(plan.problems).toEqual([])
    expect(plan).toMatchObject({ creates: 3, updates: 0, households_created: 2 })
    expect(plan.rows[0]).toMatchObject({ household: 'Rivera', first_name: 'Ana', side: 'partner_one', tags: ['family', 'vip'], plus_one_allowed: true })
    expect(plan.rows[1]).toMatchObject({ side: 'both', plus_one_allowed: false })
    expect(plan.rows[2]).toMatchObject({ side: 'partner_two', dietary: 'vegan', email: 'mei@example.test' })
  })

  it('accepts the columns in any order and in any case, and only household and first_name are required', () => {
    const plan = planGuestImport(EMPTY, 'First Name,HOUSEHOLD\nAna,Rivera\n')
    expect(plan.problems).toEqual([])
    expect(plan.rows[0]).toMatchObject({ household: 'Rivera', first_name: 'Ana', last_name: '' })
    expect(planGuestImport(EMPTY, 'first_name,last_name\nAna,Rivera\n').problems).toEqual([
      { row: 1, message: 'The header needs at least the household and first_name columns.' },
    ])
    expect(planGuestImport(EMPTY, '').problems).toEqual([{ row: 1, message: 'The CSV is empty.' }])
  })

  it('reports every bad row by its line number (the header is line 1), and plans nothing to apply', () => {
    const plan = planGuestImport(
      EMPTY,
      csv(
        'Rivera,,Ana,Rivera,,,,,,,',
        ',,Bo,,,,,,,,',
        'Rivera,,,,,,,,,,',
        'Rivera,,Cy,,left,,maybe,,,not-an-email,1',
        'Rivera,,Ana,Rivera,,,,,,,',
      ),
    )
    expect(plan.problems).toEqual([
      { row: 3, message: 'household must be 1 to 120 characters' },
      { row: 4, message: 'first_name must be 1 to 80 characters' },
      { row: 5, message: 'side must be partner_one, partner_two or both; plus_one_allowed must be yes or no; email is not a valid address; phone must be 3 to 40 characters' },
      { row: 6, message: 'the same person appears twice in this household' },
    ])
  })

  it('bounds the text, the rows and the resulting list', () => {
    expect(planGuestImport(EMPTY, 'x'.repeat(GUEST_CSV_LIMITS.characters + 1)).problems[0]?.message).toMatch(/larger than/)
    const rows = Array.from({ length: GUEST_CSV_LIMITS.rows + 1 }, (_, i) => `H,,G${i},,,,,,,,`)
    expect(planGuestImport(EMPTY, csv(...rows)).problems[0]?.message).toMatch(/more than 2000 rows/)
    const small = planGuestImport(EMPTY, csv('A,,One,,,,,,,,', 'B,,Two,,,,,,,,'), { households: 1, guests: 1 })
    expect(small.problems.map((p) => p.message)).toEqual(['the import would exceed the household limit', 'the import would exceed the guest limit'])
  })

  it('a plus-one names a host in the same household who may bring one, in the file or on the list, at most once', () => {
    const ok = planGuestImport(EMPTY, csv('R,,Ana,Rivera,,,yes,,,,', 'R,,Sam,,,,,ana rivera,,,'))
    expect(ok.problems).toEqual([])
    expect(ok.rows[1]).toMatchObject({ plus_one_of: 'ana rivera', plus_one_allowed: false })

    const noAllowance = planGuestImport(EMPTY, csv('R,,Ana,Rivera,,,no,,,,', 'R,,Sam,,,,,Ana Rivera,,,'))
    expect(noAllowance.problems).toEqual([{ row: 3, message: 'the plus-one\'s host "Ana Rivera" is not in this household or may not bring a plus-one' }])

    const otherHousehold = planGuestImport(EMPTY, csv('R,,Ana,Rivera,,,yes,,,,', 'C,,Sam,,,,,Ana Rivera,,,'))
    expect(otherHousehold.problems).toHaveLength(1)

    const two = planGuestImport(EMPTY, csv('R,,Ana,Rivera,,,yes,,,,', 'R,,Sam,,,,,Ana Rivera,,,', 'R,,Kit,,,,,Ana Rivera,,,'))
    expect(two.problems).toEqual([{ row: 4, message: '"Ana Rivera" already has a plus-one' }])

    const onList = view([household('h1', 'R')], [guest('g1', 'h1', 'Ana', 'Rivera', { plus_one_allowed: true }), guest('g2', 'h1', 'Sam', '', { plus_one_of: 'g1' })])
    expect(planGuestImport(onList, csv('R,,Kit,,,,,Ana Rivera,,,')).problems).toEqual([{ row: 2, message: '"Ana Rivera" already has a plus-one' }])
  })

  it('a row matching an existing guest updates them, keeping who is a plus-one as it is', () => {
    const list = view(
      [household('h1', 'Rivera')],
      [guest('g1', 'h1', 'Ana', 'Rivera', { plus_one_allowed: true }), guest('g2', 'h1', 'Sam', '', { plus_one_of: 'g1' }), guest('g3', 'h1', 'Bo', 'Rivera')],
    )
    const same = planGuestImport(list, csv('rivera,,ana,RIVERA,,,yes,,,,', 'Rivera,,Sam,,,,,Ana Rivera,,,'))
    expect(same.problems).toEqual([])
    expect(same).toMatchObject({ creates: 0, updates: 2, households_created: 0 })
    expect(same.rows.map((r) => r.guest_id)).toEqual(['g1', 'g2'])

    // Bo cannot become a plus-one, and Sam cannot stop being one, through an import.
    const change = planGuestImport(list, csv('Rivera,,Bo,Rivera,,,,Ana Rivera,,,', 'Rivera,,Sam,,,,,,,,'))
    expect([...new Set(change.problems.map((p) => p.row))]).toEqual([2, 3])
    expect(change.problems[0]?.message).toMatch(/change who is a plus-one on the guest list page/)

    // Ana's allowance cannot be taken away while Sam is listed.
    expect(planGuestImport(list, csv('Rivera,,Ana,Rivera,,,no,,,,')).problems).toEqual([
      { row: 2, message: 'Ana Rivera has a plus-one on the list; keep plus_one_allowed yes' },
    ])
  })

  it('rows of one household must agree on its address', () => {
    const plan = planGuestImport(EMPTY, csv('R,1 Main St,Ana,,,,,,,,', 'R,,Bo,,,,,,,,', 'R,2 Elm St,Cy,,,,,,,,'))
    expect(plan.problems).toEqual([{ row: 4, message: '"R" has a different address on another row' }])
  })

  it('an exported list imports back as updates only', () => {
    const list = view(
      [household('h1', '=Rivera', '1 Main St, Springfield'), household('h2', 'Chen')],
      [
        guest('g1', 'h1', 'Ana', 'Rivera', { plus_one_allowed: true, tags: ['family'], phone: '+1 555 0100', dietary: 'none, really' }),
        guest('g2', 'h1', 'Sam', '', { plus_one_of: 'g1' }),
        guest('g3', 'h2', 'Mei', 'Chen', { side: 'partner_two', email: 'mei@example.test' }),
      ],
    )
    const plan = planGuestImport(list, toGuestCsv(list))
    expect(plan.problems).toEqual([])
    expect(plan).toMatchObject({ creates: 0, updates: 3, households_created: 0 })
    expect(plan.rows[0]).toMatchObject({ household: '=Rivera', address: '1 Main St, Springfield', phone: '+1 555 0100', dietary: 'none, really', tags: ['family'] })
  })
})
