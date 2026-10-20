import { type Clock, getSchemaRegistry, type IdGenerator, type WeddingSite, type WeddingSiteName } from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import { COLLECTIONS } from '../persistence/collections'
import type { RecordStore } from '../persistence/record_store'
import { RateLimiter, type RateLimitRule } from '../accounts/rate_limiter'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import { assertPlainText } from '../text/plain_text'
import { isDate } from '../wedding/calendar_date'
import type { WeddingEventService } from '../wedding_events/wedding_event_service'
import { assertWeddingReach } from '../wedding/wedding_reach'
import type { WeddingRepository } from '../wedding/wedding_repository'

/**
 * @canonical site_service -- a wedding's public website (issue #47, ADR 0055).
 *
 * The planner and the couple edit it (the wedding's boundary, `assertWeddingReach`); guests read it at
 * `/t/<slug>/w/<site_name>` once it is published. What the public sees is built here, from an allow-list: the couple's
 * display name and date, the welcome, the events marked public (name, time, place), travel notes, hotel blocks, the
 * FAQ and registry links. Never a guest, a count, an RSVP, an id of anything but the site itself.
 *
 * A site name is unique in the workspace (the `wedding_site_name` index, keyed by name) and is 3–40 lowercase
 * letters, digits and hyphens — no underscore, so it never looks like an id. An unknown, unpublished or removed
 * site, a malformed name, a cancelled wedding, or a suspended workspace all resolve to nothing: the public route's
 * generic not-found. Links are https only.
 *
 * Public reads are not rate-limited: the edge has no client identity, so any limit would be shared by every guest and
 * an anonymous client could trip it to take the site down; a read is a few point reads, bounded by the event limit.
 * Name CHANGES are limited per wedding ({@link SITE_NAME_CHANGES}): a taken name is an honest 409, also to the couple,
 * so the limit bounds how fast anyone can probe for other weddings' names (ADR 0055).
 *
 * related: wedding_site_schema.json and wedding_site_name_schema.json (the contracts), wedding_event_service.ts.
 */

/** Bounds on one site; lists are capped before any per-item work. */
export const SITE_LIMITS = Object.freeze({ hotels: 10, faq: 30, registry: 10, public_events: 12 })

/** How often one wedding's site name may change (each attempt counts, taken or not). */
export const SITE_NAME_CHANGES: RateLimitRule = Object.freeze({ limit: 10, windowSeconds: 3600 })

/** A site name: 3–40 lowercase letters, digits and hyphens, starting and ending with a letter or digit. */
export const SITE_NAME = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/

export interface HotelInput {
  readonly name: string
  readonly address?: string
  readonly booking_url?: string
  readonly block_code?: string
  readonly book_by?: string
}

export interface SiteInput {
  readonly site_name: string
  readonly welcome?: string
  readonly travel?: string
  readonly public_event_ids?: readonly string[]
  readonly hotels?: readonly HotelInput[]
  readonly faq?: readonly { readonly question: string; readonly answer: string }[]
  readonly registry?: readonly { readonly label: string; readonly url: string }[]
}

/** What the editor sees: the site (when made) and the events it may show. */
export interface SiteEditView {
  readonly site?: WeddingSite
  readonly events: readonly { readonly event_id: string; readonly name: string; readonly starts_at: string }[]
}

/** A hotel block as the public page shows it (copied field by field: a field added to the stored hotel stays private). */
export interface PublicHotel {
  readonly name: string
  readonly address?: string
  readonly booking_url?: string
  readonly block_code?: string
  readonly book_by?: string
}

/** What the public page shows — nothing else about the wedding. */
export interface PublicSiteView {
  readonly couple_display_name: string
  readonly event_date: string
  readonly welcome?: string
  readonly schedule: readonly { readonly name: string; readonly starts_at: string; readonly location?: string }[]
  readonly travel?: string
  readonly hotels: readonly PublicHotel[]
  readonly faq: readonly { readonly question: string; readonly answer: string }[]
  readonly registry: readonly { readonly label: string; readonly url: string }[]
}

export class SiteService {
  readonly #sites: TenantScopedRepository<WeddingSite>
  readonly #names: TenantScopedRepository<WeddingSiteName>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly events: Pick<WeddingEventService, 'eventsOf'>,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
    private readonly limits: typeof SITE_LIMITS = SITE_LIMITS,
    private readonly nameChanges: RateLimiter = new RateLimiter(clock),
  ) {
    this.#sites = new TenantScopedRepository<WeddingSite>(liveness, (s) => s.wedding_id, COLLECTIONS.weddingSite, store)
    this.#names = new TenantScopedRepository<WeddingSiteName>(liveness, (n) => n.site_name, COLLECTIONS.weddingSiteName, store)
  }

  /** The wedding's boundary alone (the HTTP edge calls it before parsing a body). */
  assertReach(context: TenantContext, principal: Principal, wedding_id: string): void {
    assertWeddingReach(this.authorizer, this.weddings, context, principal, wedding_id)
  }

  editView(context: TenantContext, principal: Principal, wedding_id: string): SiteEditView {
    this.assertReach(context, principal, wedding_id)
    const site = this.#site(context, wedding_id)
    return {
      ...(site === undefined ? {} : { site }),
      events: this.events.eventsOf(context, wedding_id).map((e) => ({ event_id: e.event_id, name: e.name, starts_at: e.starts_at })),
    }
  }

  /** Make or replace the site's content (the planner or the couple). A new name must be free in the workspace. */
  save(context: TenantContext, principal: Principal, wedding_id: string, input: SiteInput): WeddingSite {
    this.assertReach(context, principal, wedding_id)
    const existing = this.#site(context, wedding_id)
    const fields = this.#fields(context, wedding_id, input)
    // Counted BEFORE the name is looked up, so probing for taken names is as slow as the limit.
    if (existing?.site_name !== fields.site_name && !this.nameChanges.attempt(`site-name:${context.tenant_id}:${wedding_id}`, SITE_NAME_CHANGES)) {
      throw new ProductError('PRODUCT.RATE_LIMITED', 'Too many site name changes; try again later.', {})
    }
    const holder = this.#names.read(context, fields.site_name)
    if (holder !== undefined && holder.wedding_id !== wedding_id) throw new ProductError('PRODUCT.SITE_NAME_TAKEN', 'That site name is taken in this workspace.', {})
    const site: WeddingSite = {
      tenant_id: context.tenant_id,
      wedding_id,
      ...fields,
      published: existing?.published ?? false,
      created_at: existing?.created_at ?? this.clock.now(),
      ...(existing === undefined ? {} : { updated_at: this.clock.now() }),
    }
    getSchemaRegistry().assertValid<WeddingSite>('wedding_site', site)
    if (existing !== undefined && existing.site_name !== site.site_name) this.#names.delete(context, existing.site_name)
    const name: WeddingSiteName = { tenant_id: context.tenant_id, site_name: site.site_name, wedding_id }
    getSchemaRegistry().assertValid<WeddingSiteName>('wedding_site_name', name)
    this.#names.put(context, name)
    return this.#sites.put(context, site)
  }

  /** Turn the public page on or off (the planner or the couple). The site must exist. */
  setPublished(context: TenantContext, principal: Principal, wedding_id: string, published: boolean): WeddingSite {
    this.assertReach(context, principal, wedding_id)
    const existing = this.#site(context, wedding_id)
    if (existing === undefined) throw new ProductError('PRODUCT.BAD_REQUEST', 'Make the site before publishing it.', {})
    const site: WeddingSite = { ...existing, published, updated_at: this.clock.now() }
    getSchemaRegistry().assertValid<WeddingSite>('wedding_site', site)
    return this.#sites.put(context, site)
  }

  /**
   * The public page of a site name in this workspace, or undefined (malformed, unknown, unpublished, or its wedding is
   * gone or cancelled): one indistinguishable "nothing", which the route turns into the generic not-found. No principal: the
   * page is public, and it shows only the allow-listed content.
   */
  publicView(context: TenantContext, site_name: string): PublicSiteView | undefined {
    if (!SITE_NAME.test(site_name)) return undefined
    const holder = this.#names.read(context, site_name)
    if (holder === undefined) return undefined
    const site = this.#site(context, holder.wedding_id)
    if (site === undefined || !site.published || site.site_name !== site_name) return undefined
    const wedding = this.weddings.get(context, site.wedding_id)
    if (wedding === undefined || wedding.status === 'cancelled') return undefined
    const shown = new Set(site.public_event_ids)
    return {
      couple_display_name: wedding.couple_display_name,
      event_date: wedding.event_date,
      ...(site.welcome === undefined ? {} : { welcome: site.welcome }),
      schedule: this.events
        .eventsOf(context, site.wedding_id)
        .filter((e) => shown.has(e.event_id))
        .map((e) => ({ name: e.name, starts_at: e.starts_at, ...(e.location === undefined ? {} : { location: e.location }) })),
      ...(site.travel === undefined ? {} : { travel: site.travel }),
      hotels: site.hotels.map((h) => ({
        name: h.name,
        ...(h.address === undefined ? {} : { address: h.address }),
        ...(h.booking_url === undefined ? {} : { booking_url: h.booking_url }),
        ...(h.block_code === undefined ? {} : { block_code: h.block_code }),
        ...(h.book_by === undefined ? {} : { book_by: h.book_by }),
      })),
      faq: site.faq.map((f) => ({ question: f.question, answer: f.answer })),
      registry: site.registry.map((r) => ({ label: r.label, url: r.url })),
    }
  }

  #fields(context: TenantContext, wedding_id: string, input: SiteInput): Omit<WeddingSite, 'tenant_id' | 'wedding_id' | 'published' | 'created_at' | 'updated_at'> {
    const hotels = input.hotels ?? []
    const faq = input.faq ?? []
    const registry = input.registry ?? []
    const eventIds = input.public_event_ids ?? []
    if (hotels.length > this.limits.hotels || faq.length > this.limits.faq || registry.length > this.limits.registry || eventIds.length > this.limits.public_events) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'The site has too many hotels, questions, registry links or events.', {})
    }
    const site_name = input.site_name.trim().toLowerCase()
    if (!SITE_NAME.test(site_name)) throw new ProductError('PRODUCT.BAD_REQUEST', 'A site name is 3 to 40 lowercase letters, digits and hyphens.', {})
    assertPlainText([...hotels.flatMap((h) => [h.name, h.address, h.block_code]), ...faq.map((f) => f.question), ...registry.map((r) => r.label)])
    assertPlainText([input.welcome, input.travel, ...faq.map((f) => f.answer)], { multiline: true })
    for (const url of [...hotels.flatMap((h) => (h.booking_url === undefined ? [] : [h.booking_url])), ...registry.map((r) => r.url)]) assertHttpsUrl(url)
    for (const h of hotels) {
      if (h.book_by !== undefined && !isDate(h.book_by)) throw new ProductError('PRODUCT.BAD_REQUEST', 'A book-by date is a real date (YYYY-MM-DD).', {})
    }
    const known = new Set(this.events.eventsOf(context, wedding_id).map((e) => e.event_id))
    if (eventIds.some((id) => !known.has(id))) throw new ProductError('PRODUCT.BAD_REQUEST', 'That event is not on this wedding.', {})
    const text = (value: string | undefined) => {
      const trimmed = value?.trim()
      return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
    }
    const welcome = text(input.welcome)
    const travel = text(input.travel)
    return {
      site_name,
      ...(welcome === undefined ? {} : { welcome }),
      ...(travel === undefined ? {} : { travel }),
      public_event_ids: [...new Set(eventIds)],
      hotels: hotels.map((h) => {
        const address = text(h.address)
        const booking_url = text(h.booking_url)
        const block_code = text(h.block_code)
        const book_by = text(h.book_by)
        return {
          hotel_id: this.ids.next('hotel'),
          name: h.name.trim(),
          ...(address === undefined ? {} : { address }),
          ...(booking_url === undefined ? {} : { booking_url }),
          ...(block_code === undefined ? {} : { block_code }),
          ...(book_by === undefined ? {} : { book_by }),
        }
      }),
      faq: faq.map((f) => ({ faq_id: this.ids.next('faq'), question: f.question.trim(), answer: f.answer.trim() })),
      registry: registry.map((r) => ({ registry_id: this.ids.next('registry'), label: r.label.trim(), url: r.url.trim() })),
    }
  }

  #site(context: TenantContext, wedding_id: string): WeddingSite | undefined {
    const site = this.#sites.read(context, wedding_id)
    return site?.wedding_id === wedding_id ? site : undefined
  }
}

/** Refuse anything but a plain https URL (no other scheme, no credentials, no spaces or quotes, no control characters). */
function assertHttpsUrl(value: string): void {
  const url = value.trim()
  assertPlainText([url])
  let parsed: URL | undefined
  try {
    parsed = new URL(url)
  } catch {
    parsed = undefined
  }
  if (parsed === undefined || parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || url.length > 500 || /[\s<>"']/.test(url)) {
    throw new ProductError('PRODUCT.BAD_REQUEST', 'A link is an https:// address.', {})
  }
}
