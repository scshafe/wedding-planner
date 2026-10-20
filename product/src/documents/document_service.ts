import { createHash } from 'node:crypto'

import { type Clock, getSchemaRegistry, type IdGenerator, type WeddingDocument, type WeddingVendor } from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import { COLLECTIONS } from '../persistence/collections'
import { GLOBAL_PARTITION, groupedKey, type RecordStore } from '../persistence/record_store'
import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import { assertPlainText } from '../text/plain_text'
import type { VendorService } from '../vendors/vendor_service'
import { assertWeddingReach } from '../wedding/wedding_reach'
import type { WeddingRepository } from '../wedding/wedding_repository'

/**
 * @canonical document_service -- files attached to a wedding or one of its vendors (issue #48, ADR 0056): contracts,
 * floor plans, quotes.
 *
 * The boundary is the wedding's (`assertWeddingReach`). The planner uploads, edits, shares and removes documents; the
 * couple sees and downloads only the documents the planner shares, through an allow-list (no original file name, no
 * hash, and no vendor name for a vendor the couple is not shared — as on the vendors page, #33). Another wedding's
 * document, and an unshared one asked for by the couple, are the masked not-found.
 *
 * Only PDF, PNG and JPEG are accepted, decided by the file's signature AND its name's extension (both must agree); the
 * stored content type comes from the signature, never from what the client declared. The bytes live in the record
 * store (collection `document_content`, base64, one record per file, read one at a time and never listed), so they are
 * in the same SQLite file as the rest of the state and the stack's existing `state/app` backup covers them.
 *
 * Storage is bounded at every level, checked before anything is written: per file, per wedding (bytes and count), per
 * workspace and for the whole platform. The workspace and platform totals are counters kept in the same transaction
 * as the upload or removal (a request is one transaction), so they are exact and O(1); the platform cap keeps
 * documents well inside the database's own size cap, so a full document store never stops other writes.
 *
 * related: wedding_document_schema.json (the metadata contract), vendor_service.ts (vendors), multipart_form.ts (the
 * upload form), product_web_ui.ts (the download response and its headers).
 */

const MIB = 1024 * 1024

/** Storage bounds. `file_bytes` matches the contract's `size_bytes` maximum. */
export const DOCUMENT_LIMITS = Object.freeze({
  file_bytes: 5 * MIB,
  wedding_files: 40,
  wedding_bytes: 25 * MIB,
  workspace_bytes: 100 * MIB,
  platform_bytes: 256 * MIB,
})

export type DocumentLimits = { readonly [K in keyof typeof DOCUMENT_LIMITS]: number }

export const DOCUMENT_KINDS = ['contract', 'floor_plan', 'quote', 'other'] as const
export type DocumentKind = WeddingDocument['kind']
export type DocumentContentType = WeddingDocument['content_type']

/** The longest base64 text a file within the limit can take: 4 characters per 3 bytes, padded. */
export function maxBase64Length(fileBytes: number): number {
  return Math.ceil(fileBytes / 3) * 4
}

/** A document's bytes, base64 (collection `document_content`). Never listed: read one at a time by key. */
export interface StoredDocumentContent {
  readonly tenant_id: string
  readonly wedding_id: string
  readonly document_id: string
  readonly content_base64: string
}

/** How much document storage is in use (the platform's counter; a workspace's carries its tenant_id). */
export interface DocumentUsage {
  readonly bytes: number
  readonly files: number
}

export interface WorkspaceDocumentUsage extends DocumentUsage {
  readonly tenant_id: string
}

const USAGE_KEY = 'documents'

export interface DocumentUploadInput {
  readonly title: string
  readonly kind: DocumentKind
  readonly vendor_id?: string
  readonly shared_with_couple?: boolean
  /** The uploaded file's name; only its last path segment is kept. */
  readonly filename: string
  readonly content_base64: string
}

export interface DocumentUpdateInput {
  readonly title: string
  readonly kind: DocumentKind
  readonly vendor_id?: string
  readonly shared_with_couple: boolean
}

/** One document as this principal may see it. */
export interface DocumentLine {
  readonly document_id: string
  readonly title: string
  readonly kind: DocumentKind
  readonly content_type: DocumentContentType
  readonly size_bytes: number
  readonly created_at: string
  /** The vendor's name, when it belongs to a vendor this principal may see. */
  readonly vendor_name?: string
  /** The planner's view only. */
  readonly vendor_id?: string
  readonly filename?: string
  readonly shared_with_couple?: boolean
}

export interface DocumentsView {
  readonly documents: readonly DocumentLine[]
  readonly can_manage: boolean
  /** What a document may belong to (the planner's view only). */
  readonly vendors: readonly { readonly vendor_id: string; readonly business_name: string }[]
  /** The wedding's storage in use and its limits (the planner's view only). */
  readonly usage?: { readonly bytes: number; readonly files: number; readonly limit_bytes: number; readonly limit_files: number }
}

/** A file to download: its bytes and the name and type to send it under. */
export interface DocumentDownload {
  readonly document_id: string
  /** `<title>.<ext>`: the download's name. */
  readonly download_name: string
  readonly content_type: DocumentContentType
  readonly content_base64: string
}

export class DocumentService {
  readonly #documents: TenantScopedRepository<WeddingDocument>
  readonly #contents: TenantScopedRepository<StoredDocumentContent>
  readonly #workspaceUsage: TenantScopedRepository<WorkspaceDocumentUsage>
  readonly #store: RecordStore

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly vendors: Pick<VendorService, 'vendorsOf'>,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store: RecordStore = new InMemoryRecordStore(),
    private readonly limits: DocumentLimits = DOCUMENT_LIMITS,
  ) {
    this.#store = store
    this.#documents = new TenantScopedRepository<WeddingDocument>(liveness, (d) => groupedKey(d.wedding_id, d.document_id), COLLECTIONS.weddingDocument, store)
    this.#contents = new TenantScopedRepository<StoredDocumentContent>(liveness, (c) => groupedKey(c.wedding_id, c.document_id), COLLECTIONS.documentContent, store)
    this.#workspaceUsage = new TenantScopedRepository<WorkspaceDocumentUsage>(liveness, () => USAGE_KEY, COLLECTIONS.documentWorkspaceUsage, store)
  }

  /** The wedding's boundary alone (the HTTP edge calls it before parsing a body). */
  assertReach(context: TenantContext, principal: Principal, wedding_id: string): void {
    assertWeddingReach(this.authorizer, this.weddings, context, principal, wedding_id)
  }

  view(context: TenantContext, principal: Principal, wedding_id: string): DocumentsView {
    this.assertReach(context, principal, wedding_id)
    const planner = principal.role === 'planner'
    const vendors = new Map(this.vendors.vendorsOf(context, wedding_id).map((v) => [v.vendor_id, v]))
    const all = this.#documentsOf(context, wedding_id)
    const documents = all.filter((d) => planner || d.shared_with_couple).map((d) => line(d, vendors.get(d.vendor_id ?? ''), planner))
    if (!planner) return { documents, can_manage: false, vendors: [] }
    return {
      documents,
      can_manage: true,
      vendors: [...vendors.values()].map((v) => ({ vendor_id: v.vendor_id, business_name: v.business_name })),
      usage: { bytes: sumBytes(all), files: all.length, limit_bytes: this.limits.wedding_bytes, limit_files: this.limits.wedding_files },
    }
  }

  /** Attach a file (the planner). Every bound is checked before anything is written. */
  upload(context: TenantContext, principal: Principal, wedding_id: string, input: DocumentUploadInput): WeddingDocument {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    // The cheap checks first: no decoding or hashing for a request that fails on its fields.
    const fields = this.#fields(context, wedding_id, input)
    const filename = baseName(input.filename)
    assertPlainText([filename])
    if (filename.length === 0 || filename.length > 120) throw new ProductError('PRODUCT.BAD_REQUEST', 'The file needs a name of at most 120 characters.', {})
    const bytes = decodeBase64(input.content_base64, this.limits.file_bytes)
    const type = sniffDocumentType(bytes)
    if (type === undefined || !extensionMatches(filename, type)) {
      throw new ProductError('PRODUCT.UNSUPPORTED_FILE', 'Only PDF, PNG and JPEG files are accepted, named for what they are.', {})
    }
    const existing = this.#documentsOf(context, wedding_id)
    if (existing.length >= this.limits.wedding_files) throw new ProductError('PRODUCT.LIMIT_REACHED', 'This wedding has reached its number of documents.', {})
    if (sumBytes(existing) + bytes.length > this.limits.wedding_bytes) throw new ProductError('PRODUCT.LIMIT_REACHED', "This wedding's document storage is full.", {})
    const workspace = this.#workspaceUsage.read(context, USAGE_KEY) ?? { tenant_id: context.tenant_id, bytes: 0, files: 0 }
    if (workspace.bytes + bytes.length > this.limits.workspace_bytes) throw new ProductError('PRODUCT.LIMIT_REACHED', "The workspace's document storage is full.", {})
    const platform = this.#platformUsage()
    if (platform.bytes + bytes.length > this.limits.platform_bytes) throw new ProductError('PRODUCT.LIMIT_REACHED', 'Document storage is full.', {})

    const document: WeddingDocument = {
      document_id: this.ids.next('doc'),
      tenant_id: context.tenant_id,
      wedding_id,
      ...fields,
      filename,
      content_type: type,
      size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      shared_with_couple: input.shared_with_couple ?? false,
      created_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<WeddingDocument>('wedding_document', document)
    this.#documents.put(context, document)
    this.#contents.put(context, { tenant_id: context.tenant_id, wedding_id, document_id: document.document_id, content_base64: input.content_base64 })
    this.#workspaceUsage.put(context, { tenant_id: context.tenant_id, bytes: workspace.bytes + bytes.length, files: workspace.files + 1 })
    this.#store.put(COLLECTIONS.documentPlatformUsage, GLOBAL_PARTITION, USAGE_KEY, { bytes: platform.bytes + bytes.length, files: platform.files + 1 })
    return document
  }

  /** Change a document's title, kind, vendor or sharing (the planner). */
  update(context: TenantContext, principal: Principal, wedding_id: string, document_id: string, input: DocumentUpdateInput): WeddingDocument {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    const existing = this.#document(context, wedding_id, document_id)
    const fields = this.#fields(context, wedding_id, input)
    const document: WeddingDocument = { ...existing, ...fields, shared_with_couple: input.shared_with_couple, updated_at: this.clock.now() }
    // No vendor in the update unlinks it.
    if (fields.vendor_id === undefined) delete document.vendor_id
    getSchemaRegistry().assertValid<WeddingDocument>('wedding_document', document)
    return this.#documents.put(context, document)
  }

  /** Remove a document and its bytes (the planner). Returns whether it existed. */
  remove(context: TenantContext, principal: Principal, wedding_id: string, document_id: string): boolean {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    const existing = document_id.length === 0 ? undefined : this.#documents.read(context, groupedKey(wedding_id, document_id))
    if (existing === undefined || existing.wedding_id !== wedding_id) return false
    this.#documents.delete(context, groupedKey(wedding_id, document_id))
    this.#contents.delete(context, groupedKey(wedding_id, document_id))
    const workspace = this.#workspaceUsage.read(context, USAGE_KEY)
    if (workspace !== undefined) {
      this.#workspaceUsage.put(context, { tenant_id: context.tenant_id, bytes: Math.max(0, workspace.bytes - existing.size_bytes), files: Math.max(0, workspace.files - 1) })
    }
    const platform = this.#platformUsage()
    this.#store.put(COLLECTIONS.documentPlatformUsage, GLOBAL_PARTITION, USAGE_KEY, {
      bytes: Math.max(0, platform.bytes - existing.size_bytes),
      files: Math.max(0, platform.files - 1),
    })
    return true
  }

  /**
   * A document's bytes to download. The couple gets only a shared document; anything else is the masked not-found.
   * The bytes are checked against the stored hash, so a damaged record is never sent as the file.
   */
  download(context: TenantContext, principal: Principal, wedding_id: string, document_id: string): DocumentDownload {
    this.assertReach(context, principal, wedding_id)
    const document = this.#document(context, wedding_id, document_id)
    if (principal.role !== 'planner' && !document.shared_with_couple) throw notFound()
    const content = this.#contents.read(context, groupedKey(wedding_id, document_id))
    if (content === undefined || content.wedding_id !== wedding_id) throw notFound()
    const digest = createHash('sha256').update(Buffer.from(content.content_base64, 'base64')).digest('hex')
    if (digest !== document.sha256) {
      throw new ProductError('PRODUCT.DOCUMENT_DAMAGED', 'A stored document does not match its hash.', { context: { document_id } })
    }
    return {
      document_id,
      download_name: `${document.title}.${EXTENSIONS[document.content_type][0]}`,
      content_type: document.content_type,
      content_base64: content.content_base64,
    }
  }

  #fields(context: TenantContext, wedding_id: string, input: DocumentUpdateInput | DocumentUploadInput): Pick<WeddingDocument, 'title' | 'kind' | 'vendor_id'> {
    assertPlainText([input.title])
    const title = input.title.trim()
    if (title.length === 0 || title.length > 120) throw new ProductError('PRODUCT.BAD_REQUEST', 'A document needs a title of at most 120 characters.', {})
    if (!(DOCUMENT_KINDS as readonly string[]).includes(input.kind)) throw new ProductError('PRODUCT.BAD_REQUEST', 'kind must be contract, floor_plan, quote or other.', {})
    const vendor = input.vendor_id
    if (vendor !== undefined && !this.vendors.vendorsOf(context, wedding_id).some((v) => v.vendor_id === vendor)) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'That vendor is not on this wedding.', {})
    }
    return { title, kind: input.kind, ...(vendor === undefined ? {} : { vendor_id: vendor }) }
  }

  #documentsOf(context: TenantContext, wedding_id: string): WeddingDocument[] {
    return this.#documents.listGroup(context, wedding_id).filter((d) => d.wedding_id === wedding_id)
  }

  #document(context: TenantContext, wedding_id: string, document_id: string): WeddingDocument {
    const document = document_id.length === 0 ? undefined : this.#documents.read(context, groupedKey(wedding_id, document_id))
    if (document === undefined || document.wedding_id !== wedding_id) throw notFound()
    return document
  }

  #platformUsage(): DocumentUsage {
    return this.#store.get(COLLECTIONS.documentPlatformUsage, GLOBAL_PARTITION, USAGE_KEY) ?? { bytes: 0, files: 0 }
  }

  #planner(principal: Principal): void {
    if (principal.role !== 'planner') throw new ProductError('PRODUCT.FORBIDDEN', 'Only the planner manages documents.', {})
  }
}

/** The extensions a name may end with for each accepted type; the first is the one downloads use. */
const EXTENSIONS: Readonly<Record<DocumentContentType, readonly string[]>> = Object.freeze({
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
})

/** The accepted type a file's first bytes declare (its signature), or `undefined`. */
export function sniffDocumentType(bytes: Uint8Array): DocumentContentType | undefined {
  const starts = (signature: readonly number[]): boolean => bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b)
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf' // %PDF-
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  return undefined
}

function extensionMatches(filename: string, type: DocumentContentType): boolean {
  const dot = filename.lastIndexOf('.')
  return dot > 0 && EXTENSIONS[type].includes(filename.slice(dot + 1).toLowerCase())
}

/** The last segment of a client-supplied path (`C:\x\y.pdf` and `a/b.pdf` keep only the file's name). */
function baseName(filename: string): string {
  return filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1).trim()
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** Decode strict, padded base64 — its length is checked BEFORE any work, so an oversized body costs nothing. */
function decodeBase64(text: string, maxBytes: number): Buffer {
  if (typeof text !== 'string' || text.length === 0) throw new ProductError('PRODUCT.BAD_REQUEST', 'The file is empty.', {})
  if (text.length > maxBase64Length(maxBytes)) throw new ProductError('PRODUCT.FILE_TOO_LARGE', 'A file is at most 5 MB.', {})
  if (text.length % 4 !== 0 || !BASE64.test(text)) throw new ProductError('PRODUCT.BAD_REQUEST', 'content_base64 must be padded base64.', {})
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length === 0) throw new ProductError('PRODUCT.BAD_REQUEST', 'The file is empty.', {})
  if (bytes.length > maxBytes) throw new ProductError('PRODUCT.FILE_TOO_LARGE', 'A file is at most 5 MB.', {})
  return bytes
}

function sumBytes(documents: readonly WeddingDocument[]): number {
  return documents.reduce((total, d) => total + d.size_bytes, 0)
}

/** A document as this principal may see it: the couple's view is an allow-list. */
function line(document: WeddingDocument, vendor: WeddingVendor | undefined, planner: boolean): DocumentLine {
  const shown = vendor !== undefined && (planner || vendor.shared_with_couple)
  const base = {
    document_id: document.document_id,
    title: document.title,
    kind: document.kind,
    content_type: document.content_type,
    size_bytes: document.size_bytes,
    created_at: document.created_at,
    ...(shown ? { vendor_name: vendor.business_name } : {}),
  }
  if (!planner) return base
  return {
    ...base,
    ...(document.vendor_id === undefined ? {} : { vendor_id: document.vendor_id }),
    filename: document.filename,
    shared_with_couple: document.shared_with_couple,
  }
}

function notFound(): ProductError {
  return new ProductError('PRODUCT.NOT_FOUND', 'No such document on this wedding.', {})
}
