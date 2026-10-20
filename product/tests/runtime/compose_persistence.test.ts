import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type ApiRequest,
  composeProductSurface,
  type ComposedSurface,
  InMemoryRecordStore,
  type RecordStore,
} from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'
import { GLOBAL_PARTITION } from '../../src/persistence/record_store'
import { SqliteRecordStore } from '../../src/persistence/sqlite_record_store'

/**
 * Issue #8 — data survives a restart. The keystone for durability: boot a surface over a SQLite file, write
 * through EVERY persisted store via the real HTTP pipeline, drop that surface, compose a brand-new surface (new
 * id generator, new store handle) over the SAME file — a simulated restart — and read everything back.
 *
 * The census at the end checks that every collection in `COLLECTIONS` holds rows in the file, so a store the
 * composition root forgot to build over the shared store (it would silently stay in memory) fails here.
 */

const OP = 'persist-operator-token-0123456789'
const WEBHOOK = 'persist-webhook-token-0123456789'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-compose-'))
  dirs.push(dir)
  return join(dir, 'wedding-planner.sqlite')
}

function boot(path: string, seed: string): { surface: ComposedSurface; store: SqliteRecordStore } {
  const clock = new ManualClock('2027-05-01T00:00:00.000Z')
  const store = SqliteRecordStore.open({ path, clock })
  const surface = composeProductSurface({
    clock,
    ids: new SequentialIdGenerator(seed),
    operatorToken: OP,
    providerWebhookToken: WEBHOOK,
    demoSlug: 'demo',
    store,
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  return { surface, store }
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): ApiRequest {
  const headers: Record<string, string | undefined> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return { method, path, headers, rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body) }
}

function inbound(ref: string, pmr: string, text: string): ApiRequest {
  return req('POST', '/t/demo/messaging/inbound', {
    token: WEBHOOK,
    body: { channel: 'sms', from_ref: ref, text, provider_message_ref: pmr },
  })
}

describe('durable storage — data written before a restart is read back after it (issue #8)', () => {
  it('every store survives a recomposition over the same database file', () => {
    const path = tempDb()

    // ---- Boot 1: seed the demo, then write through every store.
    const first = boot(path, 'boot1')
    const demo = first.surface.demo
    expect(demo).toBeDefined()
    const api1 = first.surface.api
    const login = api1.handle(req('POST', '/t/demo/sessions', { body: { role: 'planner' } }))
    expect(login.status).toBe(201)
    const token = (login.body as { token: string }).token

    const created = api1.handle(
      req('POST', '/t/demo/weddings', { token, body: { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' } }),
    )
    expect(created.status).toBe(201)
    const newWeddingId = (created.body as { wedding: { wedding_id: string } }).wedding.wedding_id
    expect(
      api1.handle(
        req('POST', '/t/demo/guests', {
          token,
          body: { recipient_ref: 'sms:+15550111', wedding_id: newWeddingId, guest_id: 'guest_jo_1' },
        }),
      ).status,
    ).toBe(201)

    const ref = demo?.guestRecipientRef as string
    // Answered (receipt + metered send + usage_charge) and escalated (an escalation) inbound messages.
    expect(api1.handle(inbound(ref, 'pmr_answered', 'When is the wedding?')).status).toBe(202)
    expect(api1.handle(inbound(ref, 'pmr_escalated', 'where do I park?')).status).toBe(202)
    const escalations = api1.handle(req('GET', '/t/demo/escalations', { token }))
    const escalationId = (escalations.body as { escalations: { escalation_id: string }[] }).escalations[0]
      ?.escalation_id as string
    expect(
      api1.handle(
        req('POST', '/t/demo/escalations', { token, body: { escalation_id: escalationId, reply_text: 'Lot B.', seq: 0 } }),
      ).body,
    ).toEqual({ replied: true })
    expect(
      api1.handle(req('POST', '/t/demo/escalations', { token, body: { escalation_id: escalationId, status: 'resolved' } }))
        .body,
    ).toEqual({ resolved: true })
    // A guest list (issue #27): a household and a guest on the new wedding.
    const household = api1.handle(req('POST', `/t/demo/weddings/${newWeddingId}/households`, { token, body: { name: 'The Rivera family' } }))
    const householdId = (household.body as { household: { household_id: string } }).household.household_id
    const guestRes = api1.handle(req('POST', `/t/demo/weddings/${newWeddingId}/guests`, { token, body: { household_id: householdId, first_name: 'Ana', side: 'both' } }))
    expect(guestRes.status).toBe(201)
    const guestId = (guestRes.body as { guest: { guest_id: string } }).guest.guest_id
    // Events and an RSVP (issue #29).
    const eventRes = api1.handle(req('POST', `/t/demo/weddings/${newWeddingId}/events`, { token, body: { name: 'Reception', starts_at: '2028-06-10T18:00', meal_options: ['Fish'] } }))
    expect(eventRes.status).toBe(201)
    const eventId = (eventRes.body as { event: { event_id: string } }).event.event_id
    expect(api1.handle(req('PUT', `/t/demo/weddings/${newWeddingId}/events/${eventId}/rsvps/${guestId}`, { token, body: { status: 'attending' } })).status).toBe(200)
    // A household's RSVP link and the wedding's RSVP settings (issue #30).
    expect(api1.handle(req('POST', `/t/demo/weddings/${newWeddingId}/households/${householdId}/rsvp-link`, { token })).status).toBe(201)
    expect(api1.handle(req('PUT', `/t/demo/weddings/${newWeddingId}/rsvp-settings`, { token, body: { closed: false } })).status).toBe(200)
    // The checklist (issue #31).
    expect(api1.handle(req('POST', `/t/demo/weddings/${newWeddingId}/tasks/apply-template`, { token })).status).toBe(200)
    expect(api1.handle(req('PUT', `/t/demo/weddings/${newWeddingId}`, { token, body: { event_date: '2028-09-02' } })).status).toBe(200)
    // A vendor with a payment schedule (issue #33).
    expect(
      api1.handle(req('POST', `/t/demo/weddings/${newWeddingId}/vendors`, { token, body: { category: 'venue', business_name: 'The Hall', contract_status: 'signed', installments: [{ label: 'Deposit', amount_cents: 50000, due_date: '2028-01-15', deposit: true }] } })).status,
    ).toBe(201)
    const provisioned = api1.handle(
      req('POST', '/admin/tenants', {
        token: OP,
        body: {
          slug: 'acme',
          display_name: 'Acme Weddings',
          plan_tier: 'solo',
          theme: { brand_name: 'Acme', primary_color_hex: '#123456', accent_color_hex: '#654321', logo_ref: 'acme_logo' },
        },
      }),
    )
    expect(provisioned.status).toBe(201)
    // The operator console session and the email outbox (issue #9).
    const opSession = api1.handle(req('POST', '/admin/sessions', { token: OP }))
    expect(opSession.status).toBe(201)
    const opToken = (opSession.body as { token: string }).token
    expect(api1.handle(req('POST', '/admin/outbox', { token: opToken, body: { to: 'owner@example.test' } })).status).toBe(201)
    // A real account (issue #10): the operator sets up the demo workspace's owner; the setup link is emailed.
    expect(
      api1.handle(req('POST', `/admin/tenants/${demo?.tenantId}/owner`, { token: OP, body: { email: 'Owner@Demo.test' } })).status,
    ).toBe(201)
    const usageBefore = first.surface.messaging.usageView(demo?.tenantId as string)
    expect(usageBefore.message_count).toBe(2)
    const billingBefore = api1.handle(req('GET', '/t/demo/billing', { token })).body
    first.store.close()

    // ---- Boot 2: a fresh composition root over the same file (a simulated restart).
    const second = boot(path, 'boot2')
    const api2 = second.surface.api
    // The store held data, so the demo seed did NOT run again.
    expect(second.surface.demo).toBeUndefined()

    // The planner's session survived; their data is all there.
    const weddings = api2.handle(req('GET', '/t/demo/weddings', { token }))
    expect(weddings.status).toBe(200)
    expect((weddings.body as { weddings: { wedding_id: string }[] }).weddings.map((w) => w.wedding_id)).toEqual([
      demo?.weddingId,
      newWeddingId,
    ])
    const guests = api2.handle(req('GET', '/t/demo/guests', { token }))
    expect((guests.body as { guests: { recipient_ref: string }[] }).guests.map((g) => g.recipient_ref)).toEqual([
      ref,
      'sms:+15550111',
    ])
    const inbox = api2.handle(req('GET', '/t/demo/escalations', { token })).body as {
      escalations: { escalation_id: string; text: string }[]
      resolutions: { status: string }[]
      replies: { body: string }[]
    }
    expect(inbox.escalations.map((e) => e.text)).toEqual(['where do I park?'])
    expect(inbox.resolutions.map((r) => r.status)).toEqual(['resolved'])
    expect(inbox.replies.map((r) => r.body)).toEqual(['Lot B.'])
    expect(api2.handle(req('GET', '/t/demo/billing', { token })).body).toEqual(billingBefore)
    expect(second.surface.messaging.usageView(demo?.tenantId as string)).toEqual(usageBefore)

    // The dedup records survived: a re-delivered message is NOT answered (or billed) a second time.
    expect(api2.handle(inbound(ref, 'pmr_answered', 'When is the wedding?')).status).toBe(202)
    expect(second.surface.messaging.usageView(demo?.tenantId as string).message_count).toBe(2)

    // The provisioned tenant (and its slug index) survived: the slug is still taken.
    const again = api2.handle(
      req('POST', '/admin/tenants', {
        token: OP,
        body: {
          slug: 'ACME',
          display_name: 'Acme again',
          plan_tier: 'solo',
          theme: { brand_name: 'Acme', primary_color_hex: '#123456', accent_color_hex: '#654321', logo_ref: 'acme_logo' },
        },
      }),
    )
    expect(again.status).toBe(409)

    // A server fault is recorded for the operator (issue #13): a stored wedding whose JSON is corrupt reads as a 500,
    // and the error lands in the durable error log (outside the failed request's transaction).
    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE records SET body = '{' WHERE collection = 'wedding' AND key = ?").run(newWeddingId)
    raw.close()
    expect(api2.handle(req('GET', `/t/demo/weddings/${newWeddingId}`, { token })).status).toBe(500)
    const errors = (api2.handle(req('GET', '/admin/errors', { token: OP })).body as { errors: { code: string }[] }).errors
    expect(errors.map((e) => e.code)).toEqual(['UNHANDLED.SyntaxError'])

    // The operator console session survived (same credential), and so did the outbox.
    const outbox = api2.handle(req('GET', '/admin/outbox', { token: opToken }))
    expect(outbox.status).toBe(200)
    const messages = (outbox.body as { messages: { to: string; text_body: string }[] }).messages
    expect(messages.map((m) => m.to)).toEqual(['owner@demo.test', 'owner@example.test'])
    // The setup link minted before the restart still works after it, and the owner then signs in.
    const link = /token=([A-Za-z0-9_-]+)/.exec(messages[0]?.text_body ?? '')?.[1] as string
    expect(
      api2.handle(req('POST', '/t/demo/password-reset/complete', { body: { token: link, password: 'a long enough password' } })).status,
    ).toBe(200)
    const ownerSignIn = api2.handle(
      req('POST', '/t/demo/sessions', { body: { email: 'owner@demo.test', password: 'a long enough password' } }),
    )
    expect(ownerSignIn.status).toBe(201)
    // The owner invites a planner (issue #11): a pending invitation stays in the store for the census below.
    const ownerToken = (ownerSignIn.body as { token: string }).token
    // ...and sends feedback (issue #12).
    expect(api2.handle(req('POST', '/t/demo/feedback', { token: ownerToken, body: { trying: 'invite', happened: 'it worked' } })).status).toBe(201)
    expect(
      api2.handle(req('POST', '/t/demo/invitations', { token: ownerToken, body: { email: 'planner@demo.test', role: 'planner' } })).status,
    ).toBe(201)
    // ...and an outstanding reset link (processed after the response) plus a still-queued request are left in the
    // store for the census below.
    expect(api2.handle(req('POST', '/t/demo/password-reset', { body: { email: 'owner@demo.test' } })).status).toBe(202)
    api2.runDeferredWork()
    expect(api2.handle(req('POST', '/t/demo/password-reset', { body: { email: 'someone@demo.test' } })).status).toBe(202)
    second.store.close()

    // ---- The census: every persisted collection has rows in the file (none was left on an in-memory default).
    const db = new DatabaseSync(path)
    const rows = db.prepare('SELECT DISTINCT collection, partition FROM records').all() as {
      collection: string
      partition: string
    }[]
    db.close()
    const names = [...new Set(rows.map((row) => row.collection))].sort()
    expect(names).toEqual(Object.values(COLLECTIONS).map((c) => c.name).sort())
    // ... and every row honors its collection's scope: global collections only in the global partition, tenant
    // collections never in it (a tenant-owned record in the shared partition would bypass the isolation layer).
    const scopeOf = new Map(Object.values(COLLECTIONS).map((c) => [c.name, c.scope]))
    for (const row of rows) {
      expect({ ...row, global: row.partition === GLOBAL_PARTITION }).toEqual({
        ...row,
        global: scopeOf.get(row.collection) === 'global',
      })
    }
  })

  it('the raw session token never reaches the database file', () => {
    const path = tempDb()
    const { surface, store } = boot(path, 'boot1')
    const login = surface.api.handle(req('POST', '/t/demo/sessions', { body: { role: 'planner' } }))
    const token = (login.body as { token: string }).token
    store.close()
    expect(readFileSync(path).toString('latin1')).not.toContain(token)
  })

  it('a request that fails part-way leaves none of its writes behind (one transaction per request)', () => {
    // Provisioning writes the tenant, its slug index, then a billing event. Make the billing write fail (a storage
    // failure mid-request): the request answers 500 and the tenant + slug writes before it are rolled back.
    const inner = new InMemoryRecordStore()
    let failBilling = true
    const store: RecordStore = {
      get: (c, p, k) => inner.get(c, p, k),
      list: (c, p) => inner.list(c, p),
      listByKeyPrefix: (c, p, x) => inner.listByKeyPrefix(c, p, x),
      delete: (c, p, k) => inner.delete(c, p, k),
      isEmpty: (c) => inner.isEmpty(c),
      transaction: (fn) => inner.transaction(fn),
      put: (c, p, k, r) => {
        if (failBilling && c.name === COLLECTIONS.billingEvent.name) throw new Error('disk full')
        inner.put(c, p, k, r)
      },
    }
    const surface = composeProductSurface({
      clock: new ManualClock('2027-05-01T00:00:00.000Z'),
      ids: new SequentialIdGenerator('tx'),
      operatorToken: OP,
      providerWebhookToken: WEBHOOK,
      seedDemo: false,
      store,
    })
    const provision = (): number =>
      surface.api.handle(
        req('POST', '/admin/tenants', {
          token: OP,
          body: {
            slug: 'acme',
            display_name: 'Acme',
            plan_tier: 'solo',
            theme: { brand_name: 'Acme', primary_color_hex: '#123456', accent_color_hex: '#654321', logo_ref: 'acme_logo' },
          },
        }),
      ).status
    expect(provision()).toBe(500)
    expect(inner.isEmpty(COLLECTIONS.tenant)).toBe(true)
    expect(inner.isEmpty(COLLECTIONS.tenantSlug)).toBe(true)
    // With storage healthy again the same slug provisions cleanly: no orphaned slug index was left behind.
    failBilling = false
    expect(provision()).toBe(201)
  })

  it('rotating the operator credential ends every console session across a restart', () => {
    const path = tempDb()
    const clock = new ManualClock('2027-05-01T00:00:00.000Z')
    const first = SqliteRecordStore.open({ path, clock })
    const before = composeProductSurface({ clock, ids: new SequentialIdGenerator('r1'), operatorToken: OP, providerWebhookToken: WEBHOOK, store: first })
    const session = (before.api.handle(req('POST', '/admin/sessions', { token: OP })).body as { token: string }).token
    first.close()
    const rotatedToken = 'rotated-operator-token-0123456789'
    const second = SqliteRecordStore.open({ path, clock })
    const after = composeProductSurface({ clock, ids: new SequentialIdGenerator('r2'), operatorToken: rotatedToken, providerWebhookToken: WEBHOOK, store: second })
    expect(after.api.handle(req('GET', '/admin/outbox', { token: session })).status).toBe(401)
    expect(after.api.handle(req('GET', '/admin/outbox', { token: rotatedToken })).status).toBe(200)
    second.close()
  })
})
