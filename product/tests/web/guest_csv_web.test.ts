import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface, type HttpResult } from '@wedding-planner/product'

/** Issue #28 in the browser: the CSV download, the import page's preview-then-import, CSRF, and the couple boundary. */

function setup() {
  const s = composeProductSurface({
    clock: new ManualClock('2027-06-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('gcw'),
    operatorToken: 'gcw-operator-token-0123456789',
    providerWebhookToken: 'gcw-webhook-token-0123456789',
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
const FILE = 'household,first_name,last_name,plus_one_allowed,plus_one_of,dietary\r\nRivera,Ana,Rivera,yes,,=cmd\r\nRivera,Sam,,,Ana Rivera,\r\n'

describe('guest list CSV pages', () => {
  it('previews an import, imports it, and downloads the list as a neutralized CSV', () => {
    const w = setup()
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests&import=1`, w.planner))
    expect(page.status).toBe(200)
    expect(page.body).toContain('Import guests from CSV')
    const csrf = csrfOf(page)
    const preview = w.ui.handle(form('/t/demo/guest-list/import', { _csrf: csrf, wedding_id: w.ours, csv: FILE }, w.planner))
    expect(preview.status).toBe(200)
    expect(preview.body).toContain('Ready to import')
    expect(preview.body).toContain('2 new guest(s), 0 updated, 1 new household(s).')
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests`, w.planner)).body).not.toContain('Ana')
    const done = w.ui.handle(form('/t/demo/guest-list/import', { _csrf: csrf, wedding_id: w.ours, csv: FILE, commit: '1' }, w.planner))
    expect(done.status).toBe(303)
    expect(done.headers.location).toBe(`/t/demo?wedding=${w.ours}&tab=guests&notice=imported`)
    const list = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests&notice=imported`, w.planner)).body
    expect(list).toContain('The CSV was imported.')
    expect(list).toContain('plus-one of Ana')
    expect(list).toContain(`href="/t/demo/guest-list/export?wedding=${w.ours}"`)
    expect(list).toContain(`href="/t/demo?wedding=${w.ours}&amp;tab=guests&amp;import=1"`)

    const download = w.ui.handle(get(`/t/demo/guest-list/export?wedding=${w.ours}`, w.planner))
    expect(download.status).toBe(200)
    expect(download.headers).toMatchObject({
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="guest-list-${w.ours}.csv"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    expect(download.body).toContain("Rivera,,Ana,Rivera,both,,yes,,'=cmd,,")
    expect(download.body).toContain('Rivera,,Sam,,both,,no,Ana Rivera,,,')
  })

  it('a preview with problems lists them by row, escaped, and keeps the text for fixing', () => {
    const w = setup()
    const csrf = csrfOf(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests&import=1`, w.planner)))
    const bad = 'household,first_name,side\r\n<b>H</b>,Ana,left\r\n'
    const res = w.ui.handle(form('/t/demo/guest-list/import', { _csrf: csrf, wedding_id: w.ours, csv: bad, commit: '1' }, w.planner))
    expect(res.status).toBe(400)
    expect(res.body).toContain('Nothing was imported')
    expect(res.body).toContain('Row 2: side must be partner_one, partner_two or both')
    expect(res.body).toContain('&lt;b&gt;H&lt;/b&gt;,Ana,left')
    expect(res.body).not.toContain('<b>H</b>')
    expect(res.body).not.toContain('Ready to import')
  })

  it('a forged import changes nothing; a couple cannot import into or export another wedding', () => {
    const w = setup()
    expect(w.ui.handle(form('/t/demo/guest-list/import', { _csrf: 'forged', wedding_id: w.ours, csv: FILE, commit: '1' }, w.planner)).status).toBe(403)
    expect(w.ui.handle(get(`/t/demo/guest-list/export?wedding=${w.ours}`, w.planner)).body).not.toContain('Ana')
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    const csrf = csrfOf(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=guests&import=1`, couple)))
    const foreign = w.ui.handle(form('/t/demo/guest-list/import', { _csrf: csrf, wedding_id: 'wedding_other', csv: FILE, commit: '1' }, couple))
    const missing = w.ui.handle(get('/t/demo/guest-list/export?wedding=wedding_other', couple))
    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(foreign.body).toBe(missing.body)
    expect(w.ui.handle(get(`/t/demo/guest-list/export?wedding=${w.ours}`, couple)).status).toBe(200)
    // Signed out: the sign-in page (the console's convention for a 401), never the file.
    expect(w.ui.handle(get(`/t/demo/guest-list/export?wedding=${w.ours}`)).headers['content-type']).not.toContain('text/csv')
  })
})
