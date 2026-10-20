import type { Household, WeddingGuest } from '@wedding-planner/shared'

import { isEmailAddress } from '../email/email_port'
import { ProductError } from '../product_error'
import type { GuestListView, GuestSide } from './guest_list_service'

/**
 * @canonical guest_csv -- a wedding's guest list as CSV, out and in (issue #28, ADR 0047). Pure functions, no I/O.
 *
 * EXPORT (`toGuestCsv`): one row per guest, households repeated per row, plus-ones naming their host. Every cell a
 * spreadsheet would treat as a formula (starting with `=`, `+`, `-`, `@`, tab or CR) is prefixed with `'` — CSV
 * injection: the file is opened by people in Excel or Sheets. CRLF line endings and a UTF-8 BOM, which is what those
 * programs expect.
 *
 * IMPORT (`planGuestImport`): parse (RFC 4180: quoted cells, doubled quotes, commas and newlines inside quotes),
 * map the header, validate EVERY row, and plan what would change — without writing anything. A row matches an
 * existing guest by (household name, first name, last name), case-insensitively, so re-importing the same file
 * updates instead of duplicating. A plus-one row names its host (`First Last`) in the same household. The caller
 * applies a plan only when it has no problems, inside one transaction: all rows or none.
 *
 * Bounded: {@link GUEST_CSV_LIMITS} on the text and the rows; the list's own bounds apply to the result.
 *
 * related: guest_list_service.ts (applies a plan), wedding_guest_schema.json (the field bounds mirrored here).
 */

/** The columns, in export order. Import needs `household` and `first_name`; the rest are optional. */
export const GUEST_CSV_COLUMNS = [
  'household',
  'address',
  'first_name',
  'last_name',
  'side',
  'tags',
  'plus_one_allowed',
  'plus_one_of',
  'dietary',
  'email',
  'phone',
] as const

type Column = (typeof GUEST_CSV_COLUMNS)[number]

/** Bounds on an import. */
export const GUEST_CSV_LIMITS = Object.freeze({ characters: 500_000, rows: 2000 })

/** A problem found in an import, by 1-based line number of the data row (the header is line 1). */
export interface ImportProblem {
  readonly row: number
  readonly message: string
}

/** One planned row: create or update a guest. */
export interface PlannedGuest {
  readonly row: number
  readonly action: 'create' | 'update'
  readonly household: string
  readonly address?: string
  readonly first_name: string
  readonly last_name: string
  readonly side: GuestSide
  readonly tags: readonly string[]
  readonly plus_one_allowed: boolean
  /** The host's `First Last`, for a plus-one row. */
  readonly plus_one_of?: string
  readonly dietary?: string
  readonly email?: string
  readonly phone?: string
  /** The existing guest this row updates. */
  readonly guest_id?: string
}

export interface ImportPlan {
  readonly rows: readonly PlannedGuest[]
  readonly problems: readonly ImportProblem[]
  readonly creates: number
  readonly updates: number
  readonly households_created: number
}

// ------------------------------------------------------------------ export

/** Prefix a cell a spreadsheet would evaluate as a formula. */
export function neutralize(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell
}

/** Undo {@link neutralize} on import, so an exported file round-trips. */
export function unneutralize(cell: string): string {
  return /^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell
}

function quote(cell: string): string {
  const safe = neutralize(cell)
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** The wedding's guest list as CSV text (BOM, header, CRLF rows). */
export function toGuestCsv(view: GuestListView): string {
  const householdById = new Map(view.households.map((h) => [h.household_id, h]))
  const guestById = new Map(view.guests.map((g) => [g.guest_id, g]))
  const lines = [GUEST_CSV_COLUMNS.join(',')]
  for (const guest of view.guests) {
    const household = householdById.get(guest.household_id)
    const host = guest.plus_one_of === undefined ? undefined : guestById.get(guest.plus_one_of)
    const cells: Record<Column, string> = {
      household: household?.name ?? '',
      address: household?.address ?? '',
      first_name: guest.first_name,
      last_name: guest.last_name,
      side: guest.side,
      tags: guest.tags.join('; '),
      plus_one_allowed: guest.plus_one_allowed ? 'yes' : 'no',
      plus_one_of: host === undefined ? '' : fullName(host),
      dietary: guest.dietary ?? '',
      email: guest.email ?? '',
      phone: guest.phone ?? '',
    }
    lines.push(GUEST_CSV_COLUMNS.map((c) => quote(cells[c])).join(','))
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

// ------------------------------------------------------------------ import

/** Parse CSV text (RFC 4180). Throws PRODUCT.BAD_REQUEST on an unterminated quoted cell. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = text.startsWith('\uFEFF') ? 1 : 0
  for (; i < text.length; i++) {
    const c = text[i] as string
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        cell += c
      }
    } else if (c === '"' && cell.length === 0) {
      quoted = true
    } else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += c
    }
  }
  if (quoted) throw new ProductError('PRODUCT.BAD_REQUEST', 'The CSV has an unterminated quoted cell.', {})
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** Plan an import against the current list. Writes nothing; a plan with problems must not be applied. */
export function planGuestImport(view: GuestListView, text: string, limits = { households: 1000, guests: 2000 }): ImportPlan {
  const problems: ImportProblem[] = []
  const fail = (message: string): ImportPlan => ({ rows: [], problems: [{ row: 1, message }], creates: 0, updates: 0, households_created: 0 })
  if (text.length > GUEST_CSV_LIMITS.characters) return fail(`The CSV is larger than ${GUEST_CSV_LIMITS.characters} characters.`)
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim().length > 0))
  const [header, ...data] = table
  if (header === undefined) return fail('The CSV is empty.')
  if (data.length > GUEST_CSV_LIMITS.rows) return fail(`The CSV has more than ${GUEST_CSV_LIMITS.rows} rows.`)
  const index = new Map<Column, number>()
  header.forEach((name, position) => {
    const key = name.trim().toLowerCase().replace(/\s+/g, '_') as Column
    if ((GUEST_CSV_COLUMNS as readonly string[]).includes(key) && !index.has(key)) index.set(key, position)
  })
  if (!index.has('household') || !index.has('first_name')) return fail('The header needs at least the household and first_name columns.')

  const householdByName = new Map(view.households.map((h) => [h.name.toLowerCase(), h]))
  const guestByKey = new Map<string, WeddingGuest>()
  for (const g of view.guests) {
    const h = view.households.find((x) => x.household_id === g.household_id) as Household
    guestByKey.set(key(h.name, g.first_name, g.last_name), g)
  }

  const planned: PlannedGuest[] = []
  const seen = new Set<string>()
  data.forEach((cells, position) => {
    const row = position + 2
    const get = (column: Column): string => {
      const at = index.get(column)
      return at === undefined ? '' : unneutralize((cells[at] ?? '').trim())
    }
    const rowProblems: string[] = []
    const household = get('household')
    const first_name = get('first_name')
    const last_name = get('last_name')
    if (household.length === 0 || household.length > 120) rowProblems.push('household must be 1 to 120 characters')
    if (first_name.length === 0 || first_name.length > 80) rowProblems.push('first_name must be 1 to 80 characters')
    if (last_name.length > 80) rowProblems.push('last_name must be at most 80 characters')
    const side = parseSide(get('side'))
    if (side === undefined) rowProblems.push('side must be partner_one, partner_two or both')
    const allowed = parseYesNo(get('plus_one_allowed'))
    if (allowed === undefined) rowProblems.push('plus_one_allowed must be yes or no')
    const tags = [...new Set(get('tags').split(/[;,]/).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))]
    if (tags.length > 20 || tags.some((t) => t.length > 32)) rowProblems.push('at most 20 tags of up to 32 characters')
    const address = get('address')
    const dietary = get('dietary')
    const email = get('email')
    const phone = get('phone')
    if (address.length > 300) rowProblems.push('address must be at most 300 characters')
    if (dietary.length > 300) rowProblems.push('dietary must be at most 300 characters')
    if (email.length > 0 && !isEmailAddress(email)) rowProblems.push('email is not a valid address')
    if (phone.length > 0 && (phone.length < 3 || phone.length > 40)) rowProblems.push('phone must be 3 to 40 characters')
    const plus_one_of = get('plus_one_of')
    const k = key(household, first_name, last_name)
    if (seen.has(k)) rowProblems.push('the same person appears twice in this household')
    seen.add(k)
    if (rowProblems.length > 0) {
      problems.push({ row, message: rowProblems.join('; ') })
      return
    }
    const existing = guestByKey.get(k)
    planned.push({
      row,
      action: existing === undefined ? 'create' : 'update',
      household,
      ...(address.length === 0 ? {} : { address }),
      first_name,
      last_name,
      side: side as GuestSide,
      tags,
      plus_one_allowed: plus_one_of.length > 0 ? false : (allowed as boolean),
      ...(plus_one_of.length === 0 ? {} : { plus_one_of }),
      ...(dietary.length === 0 ? {} : { dietary }),
      ...(email.length === 0 ? {} : { email }),
      ...(phone.length === 0 ? {} : { phone }),
      ...(existing === undefined ? {} : { guest_id: existing.guest_id }),
    })
  })

  // One address per household: rows of a household that name an address must agree.
  const addressOf = new Map<string, string>()
  for (const p of planned) {
    if (p.address === undefined) continue
    const seenAddress = addressOf.get(p.household.toLowerCase())
    if (seenAddress !== undefined && seenAddress !== p.address) problems.push({ row: p.row, message: `"${p.household}" has a different address on another row` })
    addressOf.set(p.household.toLowerCase(), p.address)
  }

  // Who is a plus-one, and whose, is set on the list page: an import may create a plus-one, but a row matching an
  // existing guest must keep their plus-one status (and host) as it is.
  const guestById = new Map(view.guests.map((g) => [g.guest_id, g]))
  for (const p of planned) {
    const existing = p.guest_id === undefined ? undefined : guestById.get(p.guest_id)
    if (existing === undefined) continue
    const host = existing.plus_one_of === undefined ? undefined : guestById.get(existing.plus_one_of)
    if ((host === undefined ? '' : fullName(host).toLowerCase()) !== (p.plus_one_of ?? '').toLowerCase()) {
      problems.push({ row: p.row, message: `${fullName(p)} is already on the list; change who is a plus-one on the guest list page` })
    }
  }

  // Plus-ones: the host is named `First Last` in the same household, in the file or already on the list, allows a
  // plus-one, and ends up with at most one.
  const hostsTaken = new Map<string, number>()
  for (const p of planned) {
    if (p.plus_one_of === undefined) continue
    const hostName = p.plus_one_of.toLowerCase()
    const inFile = planned.find((h) => h.plus_one_of === undefined && sameHousehold(h.household, p.household) && fullName(h).toLowerCase() === hostName)
    const onList = view.guests.find(
      (g) =>
        g.plus_one_of === undefined &&
        fullName(g).toLowerCase() === hostName &&
        view.households.some((h) => h.household_id === g.household_id && sameHousehold(h.name, p.household)),
    )
    const allows = inFile !== undefined ? inFile.plus_one_allowed : onList?.plus_one_allowed
    if (allows !== true) {
      problems.push({ row: p.row, message: `the plus-one's host "${p.plus_one_of}" is not in this household or may not bring a plus-one` })
      continue
    }
    const hostKey = `${p.household.toLowerCase()}\u0000${hostName}`
    hostsTaken.set(hostKey, (hostsTaken.get(hostKey) ?? 0) + 1)
    const existingPlusOne = onList === undefined ? undefined : view.guests.find((g) => g.plus_one_of === onList.guest_id)
    const sameAsExisting = existingPlusOne !== undefined && existingPlusOne.guest_id === p.guest_id
    if ((hostsTaken.get(hostKey) ?? 0) > 1 || (existingPlusOne !== undefined && !sameAsExisting)) {
      problems.push({ row: p.row, message: `"${p.plus_one_of}" already has a plus-one` })
    }
  }

  // A row that takes a host's allowance away while their plus-one is on the list.
  for (const p of planned) {
    if (p.guest_id === undefined || p.plus_one_allowed) continue
    if (view.guests.some((g) => g.plus_one_of === p.guest_id)) {
      problems.push({ row: p.row, message: `${fullName(p)} has a plus-one on the list; keep plus_one_allowed yes` })
    }
  }

  const newHouseholds = new Set(planned.map((p) => p.household.toLowerCase()).filter((name) => !householdByName.has(name)))
  const creates = planned.filter((p) => p.action === 'create').length
  if (view.households.length + newHouseholds.size > limits.households) problems.push({ row: 1, message: 'the import would exceed the household limit' })
  if (view.guests.length + creates > limits.guests) problems.push({ row: 1, message: 'the import would exceed the guest limit' })
  return {
    rows: planned,
    problems: problems.sort((a, b) => a.row - b.row),
    creates,
    updates: planned.length - creates,
    households_created: newHouseholds.size,
  }
}

function key(household: string, first: string, last: string): string {
  return `${household.toLowerCase()}\u0000${first.toLowerCase()}\u0000${last.toLowerCase()}`
}

function sameHousehold(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function fullName(g: { readonly first_name: string; readonly last_name: string }): string {
  return `${g.first_name} ${g.last_name}`.trim()
}

function parseSide(value: string): GuestSide | undefined {
  const v = value.toLowerCase().replace(/[\s-]+/g, '_')
  if (v === '' || v === 'both') return 'both'
  if (v === 'partner_one' || v === 'partner_1' || v === 'one') return 'partner_one'
  if (v === 'partner_two' || v === 'partner_2' || v === 'two') return 'partner_two'
  return undefined
}

function parseYesNo(value: string): boolean | undefined {
  const v = value.toLowerCase()
  if (v === '' || v === 'no' || v === 'n' || v === 'false' || v === '0') return false
  if (v === 'yes' || v === 'y' || v === 'true' || v === '1') return true
  return undefined
}
