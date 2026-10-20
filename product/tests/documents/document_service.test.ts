import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  DOCUMENT_LIMITS,
  type DocumentLimits,
  DocumentService,
  InMemoryRecordStore,
  SessionStore,
  sniffDocumentType,
  TenantContextResolver,
  TenantStore,
  VendorService,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'

/**
 * Issue #48 — a wedding's documents below the HTTP edge: the boundary (planner manages, couple sees what is shared),
 * the file-type check by content and name, every storage bound, the counters, and the download's integrity check.
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 2)])
const HTML = Buffer.from('<html><script>alert(1)</script></html>')
const b64 = (bytes: Buffer): string => bytes.toString('base64')

function world(limits: DocumentLimits = DOCUMENT_LIMITS) {
  const clock = new ManualClock('2028-01-10T12:00:00.000Z')
  const store = new InMemoryRecordStore()
  const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), store)
  tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  tenants.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(tenants)
  const ctx = resolver.resolveBySlug('alpha')
  const other = resolver.resolveBySlug('beta')
  const weddings = new WeddingRepository(tenants, clock, new SequentialIdGenerator('w'), store)
  const ours = weddings.create(ctx, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' }).wedding_id
  const theirs = weddings.create(ctx, { couple_display_name: 'Sam & Kit', event_date: '2028-07-10' }).wedding_id
  const elsewhere = weddings.create(other, { couple_display_name: 'Ana & Bo', event_date: '2028-08-10' }).wedding_id
  const sessions = new SessionStore(new SequentialIdGenerator('s'))
  const planner = sessions.login(ctx, { role: 'planner' }).principal
  const couple = sessions.login(ctx, { role: 'couple', wedding_id: ours }).principal
  const otherPlanner = sessions.login(other, { role: 'planner' }).principal
  const authorizer = new WeddingAuthorizer()
  const ids = new SequentialIdGenerator('x')
  const vendors = new VendorService(tenants, weddings, authorizer, clock, ids, store)
  const documents = new DocumentService(tenants, weddings, authorizer, vendors, clock, ids, store, limits)
  const upload = (input: Partial<Parameters<DocumentService['upload']>[3]> = {}, wedding = ours) =>
    documents.upload(ctx, planner, wedding, { title: 'Venue contract', kind: 'contract', filename: 'contract.pdf', content_base64: b64(PDF), ...input })
  return { ctx, other, ours, theirs, elsewhere, planner, couple, otherPlanner, vendors, documents, upload, store }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('DocumentService', () => {
  it('the planner uploads; the type comes from the bytes; the couple sees only what is shared, through an allow-list', () => {
    const w = world()
    const hidden = w.vendors.addVendor(w.ctx, w.planner, w.ours, { category: 'venue', business_name: 'Secret Hall', contract_status: 'signed', installments: [] })
    const shown = w.vendors.addVendor(w.ctx, w.planner, w.ours, { category: 'photography', business_name: 'Petals', contract_status: 'sent', installments: [], shared_with_couple: true })
    const contract = w.upload({ vendor_id: hidden.vendor_id, shared_with_couple: true, filename: 'C:\\Users\\me\\Hall-final-v3.PDF' })
    expect(contract).toMatchObject({ content_type: 'application/pdf', size_bytes: PDF.length, filename: 'Hall-final-v3.PDF', shared_with_couple: true })
    expect(contract.sha256).toMatch(/^[0-9a-f]{64}$/)
    const plan = w.upload({ title: 'Floor plan', kind: 'floor_plan', filename: 'plan.png', content_base64: b64(PNG), vendor_id: shown.vendor_id, shared_with_couple: true })
    expect(plan.content_type).toBe('image/png')
    w.upload({ title: 'Internal quote', kind: 'quote', filename: 'quote.jpeg', content_base64: b64(JPEG) })

    const planner = w.documents.view(w.ctx, w.planner, w.ours)
    expect(planner.documents.map((d) => d.title)).toEqual(['Venue contract', 'Floor plan', 'Internal quote'])
    expect(planner.usage).toMatchObject({ bytes: PDF.length + PNG.length + JPEG.length, files: 3 })

    const couple = w.documents.view(w.ctx, w.couple, w.ours)
    expect(couple.can_manage).toBe(false)
    expect(couple.usage).toBeUndefined()
    expect(couple.documents).toEqual([
      { document_id: contract.document_id, title: 'Venue contract', kind: 'contract', content_type: 'application/pdf', size_bytes: PDF.length, created_at: contract.created_at },
      { document_id: plan.document_id, title: 'Floor plan', kind: 'floor_plan', content_type: 'image/png', size_bytes: PNG.length, created_at: plan.created_at, vendor_name: 'Petals' },
    ])
    const text = JSON.stringify(couple)
    for (const secret of ['Secret Hall', 'Hall-final', 'Internal quote', contract.sha256, hidden.vendor_id]) expect(text).not.toContain(secret)
  })

  it('downloads: the bytes back, named from the title; the couple only what is shared; damaged bytes are never sent', () => {
    const w = world()
    const shared = w.upload({ title: 'Our contract', shared_with_couple: true })
    const unshared = w.upload({ title: 'Quote', kind: 'quote', filename: 'q.jpg', content_base64: b64(JPEG) })
    const file = w.documents.download(w.ctx, w.couple, w.ours, shared.document_id)
    expect(file).toEqual({ document_id: shared.document_id, download_name: 'Our contract.pdf', content_type: 'application/pdf', content_base64: b64(PDF) })
    expect(w.documents.download(w.ctx, w.planner, w.ours, unshared.document_id).download_name).toBe('Quote.jpg')
    expect(codeOf(() => w.documents.download(w.ctx, w.couple, w.ours, unshared.document_id))).toBe('PRODUCT.NOT_FOUND')
    // Another wedding's id through this wedding, an unknown id, and an empty one: the same not-found.
    const theirs = w.upload({}, w.theirs)
    for (const id of [theirs.document_id, 'doc_nope', '']) expect(codeOf(() => w.documents.download(w.ctx, w.planner, w.ours, id))).toBe('PRODUCT.NOT_FOUND')
    // A stored record whose bytes no longer match the hash is an error, not a file.
    w.store.put(COLLECTIONS.documentContent, w.ctx.tenant_id, `${w.ours}/${shared.document_id}`, {
      tenant_id: w.ctx.tenant_id,
      wedding_id: w.ours,
      document_id: shared.document_id,
      content_base64: b64(HTML),
    })
    expect(codeOf(() => w.documents.download(w.ctx, w.planner, w.ours, shared.document_id))).toBe('PRODUCT.DOCUMENT_DAMAGED')
  })

  it('only PDF, PNG and JPEG, by signature AND name; the declared name cannot make HTML a PDF', () => {
    const w = world()
    expect(codeOf(() => w.upload({ filename: 'page.pdf', content_base64: b64(HTML) }))).toBe('PRODUCT.UNSUPPORTED_FILE')
    expect(codeOf(() => w.upload({ filename: 'contract.html' }))).toBe('PRODUCT.UNSUPPORTED_FILE')
    expect(codeOf(() => w.upload({ filename: 'plan.pdf', content_base64: b64(PNG) }))).toBe('PRODUCT.UNSUPPORTED_FILE')
    expect(codeOf(() => w.upload({ filename: 'pdf' }))).toBe('PRODUCT.UNSUPPORTED_FILE')
    expect(codeOf(() => w.upload({ filename: '.pdf' }))).toBe('PRODUCT.UNSUPPORTED_FILE')
    expect(sniffDocumentType(Buffer.from('%PDF'))).toBeUndefined()
    expect(sniffDocumentType(Buffer.alloc(0))).toBeUndefined()
    // Malformed base64, an empty file, bad fields: refused.
    for (const content_base64 of ['not base64!', 'QUJD=', '====', '']) expect(codeOf(() => w.upload({ content_base64 }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.upload({ title: ' ' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.upload({ title: 'A\u202Eb' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.upload({ title: 'Lone \uD800 surrogate' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.upload({ filename: 'a\nb.pdf' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.upload({ kind: 'invoice' as never }))).toBe('PRODUCT.BAD_REQUEST')
    const theirVendor = w.vendors.addVendor(w.ctx, w.planner, w.theirs, { category: 'venue', business_name: 'Theirs', contract_status: 'none', installments: [] })
    expect(codeOf(() => w.upload({ vendor_id: theirVendor.vendor_id }))).toBe('PRODUCT.BAD_REQUEST')
    expect(w.documents.view(w.ctx, w.planner, w.ours).documents).toEqual([])
    // A surrogate pair (an emoji) is well-formed text.
    expect(w.upload({ title: 'Pair \uD83D\uDE00 ok' }).title).toBe('Pair \uD83D\uDE00 ok')
  })

  it('a file is at most 5 MB, checked on the base64 length before any decoding', () => {
    const w = world()
    const atLimit = Buffer.concat([PDF, Buffer.alloc(DOCUMENT_LIMITS.file_bytes - PDF.length)])
    expect(w.upload({ content_base64: b64(atLimit) }).size_bytes).toBe(DOCUMENT_LIMITS.file_bytes)
    expect(codeOf(() => w.upload({ content_base64: b64(Buffer.concat([atLimit, Buffer.alloc(1)])) }))).toBe('PRODUCT.FILE_TOO_LARGE')
    // Far over the limit and not even base64: the length alone refuses it.
    expect(codeOf(() => w.upload({ content_base64: '!'.repeat(8 * 1024 * 1024) }))).toBe('PRODUCT.FILE_TOO_LARGE')
  })

  it('bounds per wedding (count and bytes), per workspace and for the platform; removing frees the space', () => {
    const limits = { file_bytes: 100, wedding_files: 3, wedding_bytes: 120, workspace_bytes: 150, platform_bytes: 200 }
    const w = world(limits)
    const file = (n: number) => b64(Buffer.concat([PDF.subarray(0, 5), Buffer.alloc(n - 5)]))
    const a = w.upload({ content_base64: file(50) })
    w.upload({ content_base64: file(50) })
    // The wedding: 100 of 120 bytes used.
    expect(codeOf(() => w.upload({ content_base64: file(30) }))).toBe('PRODUCT.LIMIT_REACHED')
    w.upload({ content_base64: file(10) })
    // The wedding: 3 of 3 files.
    expect(codeOf(() => w.upload({ content_base64: file(6) }))).toBe('PRODUCT.LIMIT_REACHED')
    // The workspace: 110 of 150 bytes, so another wedding gets 40 more.
    w.upload({ content_base64: file(40) }, w.theirs)
    expect(codeOf(() => w.upload({ content_base64: file(6) }, w.theirs))).toBe('PRODUCT.LIMIT_REACHED')
    // The platform: 150 of 200, so the other workspace gets 50.
    const upOther = (n: number) => () => w.documents.upload(w.other, w.otherPlanner, w.elsewhere, { title: 'T', kind: 'other', filename: 'f.pdf', content_base64: file(n) })
    expect(codeOf(upOther(60))).toBe('PRODUCT.LIMIT_REACHED')
    expect(codeOf(upOther(50))).toBe('NO_THROW')
    expect(codeOf(upOther(6))).toBe('PRODUCT.LIMIT_REACHED')
    // A full store refuses before decoding: content that is not even base64 gets the cap, not a parse error.
    expect(codeOf(upOther(6))).toBe('PRODUCT.LIMIT_REACHED')
    expect(codeOf(() => w.documents.upload(w.other, w.otherPlanner, w.elsewhere, { title: 'T', kind: 'other', filename: 'f.pdf', content_base64: '!!!!' }))).toBe('PRODUCT.LIMIT_REACHED')
    // Removing frees the wedding, the workspace and the platform.
    expect(w.documents.remove(w.ctx, w.planner, w.ours, a.document_id)).toBe(true)
    expect(w.documents.remove(w.ctx, w.planner, w.ours, a.document_id)).toBe(false)
    expect(codeOf(upOther(50))).toBe('NO_THROW')
    expect(codeOf(() => w.documents.download(w.ctx, w.planner, w.ours, a.document_id))).toBe('PRODUCT.NOT_FOUND')
  })

  it('the couple manages nothing; another wedding is not found; editing changes only the metadata', () => {
    const w = world()
    const doc = w.upload()
    expect(codeOf(() => w.documents.upload(w.ctx, w.couple, w.ours, { title: 'X', kind: 'other', filename: 'x.pdf', content_base64: b64(PDF) }))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.documents.update(w.ctx, w.couple, w.ours, doc.document_id, { title: 'X', kind: 'other', shared_with_couple: true }))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.documents.remove(w.ctx, w.couple, w.ours, doc.document_id))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.documents.view(w.ctx, w.couple, w.theirs))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.documents.view(w.other, w.otherPlanner, w.ours))).toBe('PRODUCT.NOT_FOUND')
    const vendor = w.vendors.addVendor(w.ctx, w.planner, w.ours, { category: 'venue', business_name: 'Hall', contract_status: 'signed', installments: [] })
    const linked = w.documents.update(w.ctx, w.planner, w.ours, doc.document_id, { title: 'Hall contract', kind: 'contract', vendor_id: vendor.vendor_id, shared_with_couple: true })
    expect(linked).toMatchObject({ title: 'Hall contract', vendor_id: vendor.vendor_id, shared_with_couple: true, sha256: doc.sha256, size_bytes: doc.size_bytes })
    const unlinked = w.documents.update(w.ctx, w.planner, w.ours, doc.document_id, { title: 'Hall contract', kind: 'contract', shared_with_couple: false })
    expect(unlinked.vendor_id).toBeUndefined()
    expect(codeOf(() => w.documents.update(w.ctx, w.planner, w.theirs, doc.document_id, { title: 'X', kind: 'other', shared_with_couple: false }))).toBe('PRODUCT.NOT_FOUND')
  })
})
