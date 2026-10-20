import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface, type HttpResult } from '@wedding-planner/product'

/** Issue #27 in the browser: the guest list page, its CSRF-checked forms, escaping, and the couple boundary. */

function setup() {
  const s = composeProductSurface({
    clock: new ManualClock('2027-06-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('glw'),
    operatorToken: 'glw-operator-token-0123456789',
    providerWebhookToken: 'glw-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const login = (fields: Record<string, string>): string => {
    const res = s.ui.handle(form('/t/demo/login', fields))
    return `wp_session=${/wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]}`
  }
  return { ...s, ours: s.demo?.weddingId as string, planner: login({ role: 'planner' }), login }
}

function get(path: string, cookie?: string): ApiRequest {
  return { method: 'GET', path, headers: cookie === undefined ? {} : { cookie } }
}

function form(path: string, fields: Record<string, string>, cookie?: string): ApiRequest {
  return {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) },
    rawBody: new URLSearchParams(fields).toString(),
  }
}

const csrfOf = (page: HttpResult): string => /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string

describe('the guest list page', () => {
  it('a planner adds a household and guests through the forms, and sees them (escaped)', () => {
    const w = setup()
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, w.planner))
    expect(page.status).toBe(200)
    expect(page.body).toContain('Add a household')
    const csrf = csrfOf(page)
    const added = w.ui.handle(form('/t/demo/guest-list/household-add', { _csrf: csrf, wedding_id: w.ours, name: '<b>Rivera</b>' }, w.planner))
    expect(added.headers.location).toBe(`/t/demo?wedding=${w.ours}&tab=guests&notice=saved`)
    const withHousehold = w.ui.handle(get(added.headers.location ?? '', w.planner))
    expect(withHousehold.body).toContain('&lt;b&gt;Rivera&lt;/b&gt;')
    const householdId = /name="household_id" value="(household_[^"]+)"/.exec(withHousehold.body)?.[1] as string
    w.ui.handle(
      form('/t/demo/guest-list/guest-add', { _csrf: csrf, wedding_id: w.ours, household_id: householdId, first_name: 'Ana', last_name: 'Rivera', side: 'partner_one', tags: 'family, college', plus_one_allowed: 'true' }, w.planner),
    )
    const list = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, w.planner)).body
    expect(list).toContain('Ana Rivera')
    expect(list).toContain('family, college')
    expect(list).toContain('Add their plus-one')
    expect(list).toContain('1 guest(s)')
  })

  it('a forged form changes nothing; a bad field comes back with a notice', () => {
    const w = setup()
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, w.planner))
    expect(w.ui.handle(form('/t/demo/guest-list/household-add', { _csrf: 'forged', wedding_id: w.ours, name: 'X' }, w.planner)).status).toBe(403)
    const bad = w.ui.handle(form('/t/demo/guest-list/household-add', { _csrf: csrfOf(page), wedding_id: w.ours, name: '' }, w.planner))
    expect(bad.headers.location).toBe(`/t/demo?wedding=${w.ours}&tab=guests&notice=invalid`)
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, w.planner)).body).toContain('0 household(s)')
  })

  it('edits a guest on the edit page', () => {
    const w = setup()
    const csrf = csrfOf(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, w.planner)))
    w.ui.handle(form('/t/demo/guest-list/household-add', { _csrf: csrf, wedding_id: w.ours, name: 'One' }, w.planner))
    const householdId = /name="household_id" value="(household_[^"]+)"/.exec(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, w.planner)).body)?.[1] as string
    w.ui.handle(form('/t/demo/guest-list/guest-add', { _csrf: csrf, wedding_id: w.ours, household_id: householdId, first_name: 'Ana', side: 'both' }, w.planner))
    const listBody = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, w.planner)).body
    const guestId = /guest=(wguest_[^"&]+)/.exec(listBody)?.[1] as string
    const edit = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests&guest=${guestId}`, w.planner))
    expect(edit.body).toContain('Edit guest')
    const saved = w.ui.handle(
      form('/t/demo/guest-list/guest-update', { _csrf: csrf, wedding_id: w.ours, guest_id: guestId, household_id: householdId, first_name: 'Anabel', side: 'partner_two', dietary: 'vegetarian' }, w.planner),
    )
    expect(saved.headers.location).toBe(`/t/demo?wedding=${w.ours}&tab=guests&notice=saved`)
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, w.planner)).body).toContain('dietary: vegetarian')
    const invalid = w.ui.handle(form('/t/demo/guest-list/guest-update', { _csrf: csrf, wedding_id: w.ours, guest_id: guestId, household_id: householdId, first_name: '', side: 'both' }, w.planner))
    expect(invalid.status).toBe(400)
    expect(invalid.body).toContain('Edit guest')
  })

  it('a couple sees its own wedding\'s list; another wedding is the generic not-found', () => {
    const w = setup()
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, couple)).status).toBe(200)
    expect(w.ui.handle(get('/t/demo?wedding=wedding_other&tab=guests', couple)).status).toBe(404)
    // The wedding page links to its guest list.
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}`, couple)).body).toContain('tab=guests')
  })
})
