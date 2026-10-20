import type { WeddingGuest } from '@wedding-planner/shared'

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
export const GUEST_CSV_LIMITS = Object.freeze({ characters: 300_000, rows: 2000 })

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
  /** The host's `First Last`, for a new plus-one. */
  readonly plus_one_of?: string
  /** The host the plan resolved for a new plus-one: a guest on the list ... */
  readonly host_guest_id?: string
  /** ... or the row of the file that creates them (the apply step uses exactly this, never a name lookup). */
  readonly host_row?: number
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

/**
 * Prefix a cell a spreadsheet would evaluate as a formula. Excel in a `;`-separated locale (most of Europe) splits a
 * cell at `;`, so the start of every `;` piece (after spaces and quotes) is guarded the same way.
 */
export function neutralize(cell: string): string {
  const start = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell
  // One character class (not `\s*"*\s*`): linear on a long run of spaces, never a regex blow-up.
  return start.replace(/;([\s"]*)(?=[=+\-@\t\r])/g, ";$1'")
}

/** Undo {@link neutralize} on import, so an exported file round-trips. */
export function unneutralize(cell: string): string {
  const start = /^'[=+\-@\t\r]/.test(cell) ? cell.slice(1) : cell
  return start.replace(/;([\s"]*)'(?=[=+\-@\t\r])/g, ';$1')
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
      tags: guest.tags.join(', '),
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
  let parsed: string[][]
  try {
    parsed = parseCsv(text)
  } catch {
    return fail('The CSV has a quoted cell that is never closed.')
  }
  const table = parsed.filter((r) => r.some((c) => c.trim().length > 0))
  const [header, ...data] = table
  if (header === undefined) return fail('The CSV is empty.')
  if (data.length > GUEST_CSV_LIMITS.rows) return fail(`The CSV has more than ${GUEST_CSV_LIMITS.rows} rows.`)
  const index = new Map<Column, number>()
  header.forEach((name, position) => {
    const column = name.trim().toLowerCase().replace(/\s+/g, '_') as Column
    if ((GUEST_CSV_COLUMNS as readonly string[]).includes(column) && !index.has(column)) index.set(column, position)
  })
  if (!index.has('household') || !index.has('first_name')) return fail('The header needs at least the household and first_name columns.')

  // The current list, indexed once: every lookup below is O(1), whatever the file holds (no scan per row).
  const householdById = new Map(view.households.map((h) => [h.household_id, h]))
  const householdsByName = new Map<string, number>()
  for (const h of view.households) householdsByName.set(h.name.toLowerCase(), (householdsByName.get(h.name.toLowerCase()) ?? 0) + 1)
  const guestByKey = new Map<string, WeddingGuest>()
  const ambiguousKeys = new Set<string>()
  const hostsOnList = new Map<string, WeddingGuest[]>()
  const plusOneOfHost = new Map<string, WeddingGuest>()
  const guestById = new Map(view.guests.map((g) => [g.guest_id, g]))
  for (const g of view.guests) {
    const h = householdById.get(g.household_id)
    if (h === undefined) continue
    const k = key(h.name, g.first_name, g.last_name)
    if (guestByKey.has(k)) ambiguousKeys.add(k)
    else guestByKey.set(k, g)
    if (g.plus_one_of === undefined) push(hostsOnList, hostKey(h.name, fullName(g)), g)
    else plusOneOfHost.set(g.plus_one_of, g)
  }

  const planned: PlannedGuest[] = []
  const seen = new Set<string>()
  data.forEach((cells, position) => {
    const row = position + 2
    // A column missing from the header is `undefined` (an update leaves that field as it is); a present cell is
    // trimmed, un-neutralized, and trimmed again (so the plan sees exactly what the service will store).
    const get = (column: Column): string | undefined => {
      const at = index.get(column)
      if (at === undefined) return undefined
      const cell = cells[at] ?? ''
      // No stored field is longer than 300 characters: a longer cell is a problem, never transformed.
      return cell.length > MAX_CELL ? TOO_LONG : unneutralize(cell.trim()).trim()
    }
    const rowProblems: string[] = []
    const values = GUEST_CSV_COLUMNS.map((c) => get(c) ?? '')
    if (values.includes(TOO_LONG)) {
      problems.push({ row, message: `a cell is longer than ${MAX_CELL} characters` })
      return
    }
    if (values.some(hasControlCharacter)) rowProblems.push('a cell holds a line break or another control character')
    const household = get('household') ?? ''
    const first_name = get('first_name') ?? ''
    const last_name = get('last_name') ?? ''
    if (household.length === 0 || household.length > 120) rowProblems.push('household must be 1 to 120 characters')
    if ((householdsByName.get(household.toLowerCase()) ?? 0) > 1) rowProblems.push(`more than one household on the list is named "${household}"; rename one on the guest list page`)
    if (first_name.length === 0 || first_name.length > 80) rowProblems.push('first_name must be 1 to 80 characters')
    if (last_name.length > 80) rowProblems.push('last_name must be at most 80 characters')
    const k = key(household, first_name, last_name)
    if (ambiguousKeys.has(k)) rowProblems.push('more than one guest on the list matches this row')
    if (seen.has(k)) rowProblems.push('the same person appears twice in this household')
    seen.add(k)
    const existing = guestByKey.get(k)

    // Enumerations: a blank or missing cell is the default on a new guest and unchanged on an update.
    const sideCell = get('side') ?? ''
    const side = sideCell.length === 0 ? (existing?.side ?? 'both') : parseSide(sideCell)
    if (side === undefined) rowProblems.push('side must be partner_one, partner_two or both')
    const allowedCell = get('plus_one_allowed') ?? ''
    const allowed = allowedCell.length === 0 ? (existing?.plus_one_allowed ?? false) : parseYesNo(allowedCell)
    if (allowed === undefined) rowProblems.push('plus_one_allowed must be yes or no')
    // Free text: a missing column keeps the current value; a present blank cell clears it.
    const tagsCell = get('tags')
    const tags =
      tagsCell === undefined
        ? [...(existing?.tags ?? [])]
        : [...new Set(tagsCell.split(/[;,]/).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))]
    if (tags.length > 20 || tags.some((t) => t.length > 32)) rowProblems.push('at most 20 tags of up to 32 characters')
    const address = get('address') ?? ''
    const dietary = get('dietary') ?? existing?.dietary ?? ''
    const email = get('email') ?? existing?.email ?? ''
    const phone = get('phone') ?? existing?.phone ?? ''
    if (address.length > 300) rowProblems.push('address must be at most 300 characters')
    if (dietary.length > 300) rowProblems.push('dietary must be at most 300 characters')
    if (email.length > 0 && !isEmailAddress(email)) rowProblems.push('email is not a valid address')
    if (phone.length > 0 && (phone.length < 3 || phone.length > 40)) rowProblems.push('phone must be 3 to 40 characters')
    const plusOfCell = get('plus_one_of')
    if ((plusOfCell ?? '').length > 161) rowProblems.push('plus_one_of must be at most 161 characters')

    // Who is a plus-one, and whose, is set on the list page: a row matching an existing guest keeps it as it is.
    if (existing !== undefined && plusOfCell !== undefined) {
      const host = existing.plus_one_of === undefined ? undefined : guestById.get(existing.plus_one_of)
      if ((host === undefined ? '' : fullName(host).toLowerCase()) !== plusOfCell.toLowerCase()) {
        rowProblems.push(`${fullName({ first_name, last_name })} is already on the list; change who is a plus-one on the guest list page`)
      }
    }
    const isNewPlusOne = existing === undefined && (plusOfCell ?? '').length > 0
    if (rowProblems.length > 0) {
      problems.push({ row, message: rowProblems.join('; ') })
      return
    }
    planned.push({
      row,
      action: existing === undefined ? 'create' : 'update',
      household,
      ...(address.length === 0 ? {} : { address }),
      first_name,
      last_name,
      side: side as GuestSide,
      tags,
      plus_one_allowed: isNewPlusOne || existing?.plus_one_of !== undefined ? false : (allowed as boolean),
      ...(isNewPlusOne ? { plus_one_of: plusOfCell as string } : {}),
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

  // A new plus-one names exactly one host (`First Last`) in the same household — a row of the file or a guest on
  // the list — who may bring one and has none yet. Hosts in the file are indexed once, like the list.
  const hostsInFile = new Map<string, PlannedGuest[]>()
  for (const p of planned) {
    const isPlusOne = p.plus_one_of !== undefined || (p.guest_id !== undefined && guestById.get(p.guest_id)?.plus_one_of !== undefined)
    if (!isPlusOne) push(hostsInFile, hostKey(p.household, fullName(p)), p)
  }
  const plusOnesPerHost = new Map<string, number>()
  const resolvedHost = new Map<number, { readonly host_guest_id: string } | { readonly host_row: number }>()
  for (const p of planned) {
    if (p.plus_one_of === undefined) continue
    const k = hostKey(p.household, p.plus_one_of)
    const fromFile = hostsInFile.get(k) ?? []
    const covered = new Set(fromFile.flatMap((h) => (h.guest_id === undefined ? [] : [h.guest_id])))
    const fromList = (hostsOnList.get(k) ?? []).filter((g) => !covered.has(g.guest_id))
    const candidates = fromFile.length + fromList.length
    if (candidates > 1) {
      problems.push({ row: p.row, message: `more than one guest in "${p.household}" is named "${p.plus_one_of}"` })
      continue
    }
    const inFile = fromFile[0]
    const onList = fromList[0]
    const hostId = inFile?.guest_id ?? onList?.guest_id
    const allows = inFile !== undefined ? inFile.plus_one_allowed : onList?.plus_one_allowed
    if (allows !== true) {
      problems.push({ row: p.row, message: `the plus-one's host "${p.plus_one_of}" is not in this household or may not bring a plus-one` })
      continue
    }
    resolvedHost.set(p.row, hostId !== undefined ? { host_guest_id: hostId } : { host_row: (inFile as PlannedGuest).row })
    plusOnesPerHost.set(k, (plusOnesPerHost.get(k) ?? 0) + 1)
    if ((plusOnesPerHost.get(k) ?? 0) > 1 || (hostId !== undefined && plusOneOfHost.has(hostId))) {
      problems.push({ row: p.row, message: `"${p.plus_one_of}" already has a plus-one` })
    }
  }

  // A row that takes a host's allowance away while their plus-one is on the list.
  for (const p of planned) {
    if (p.guest_id !== undefined && !p.plus_one_allowed && plusOneOfHost.has(p.guest_id) && guestById.get(p.guest_id)?.plus_one_of === undefined) {
      problems.push({ row: p.row, message: `${fullName(p)} has a plus-one on the list; keep plus_one_allowed yes` })
    }
  }

  const newHouseholds = new Set(planned.map((p) => p.household.toLowerCase()).filter((name) => !householdsByName.has(name)))
  const creates = planned.filter((p) => p.action === 'create').length
  if (view.households.length + newHouseholds.size > limits.households) problems.push({ row: 1, message: 'the import would exceed the household limit' })
  if (view.guests.length + creates > limits.guests) problems.push({ row: 1, message: 'the import would exceed the guest limit' })
  return {
    rows: planned.map((p) => ({ ...p, ...resolvedHost.get(p.row) })),
    problems: problems.sort((a, b) => a.row - b.row),
    creates,
    updates: planned.length - creates,
    households_created: newHouseholds.size,
  }
}

/** The longest cell an import reads (the longest stored field is 300 characters). */
const MAX_CELL = 300
/** The marker `get` returns for a cell over {@link MAX_CELL} (a control character, so it can never be real data). */
const TOO_LONG = '\u0000too long'

/** C0 controls and DEL: never in a stored name, note or number (and `\u0000` is the match keys' delimiter). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function push<K, V>(map: Map<K, V[]>, k: K, value: V): void {
  const list = map.get(k)
  if (list === undefined) map.set(k, [value])
  else list.push(value)
}

function hostKey(household: string, name: string): string {
  return `${household.toLowerCase()}\u0000${name.toLowerCase()}`
}

function key(household: string, first: string, last: string): string {
  return `${household.toLowerCase()}\u0000${first.toLowerCase()}\u0000${last.toLowerCase()}`
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
