import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, type ApiResponse, composeProductSurface, type HttpResult } from '@wedding-planner/product'

/** Issue #61 through the browser: ask for a draft, see it once made, keep some (CSRF first); the couple cannot. */

function setup() {
  const s = composeProductSurface({
    clock: new ManualClock('2028-01-10T12:00:00.000Z'),
    ids: new SequentialIdGenerator('cw'),
    operatorToken: 'cw-operator-token-0123456789',
    providerWebhookToken: 'cw-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const api = (method: string, path: string, token?: string, body?: unknown): ApiResponse =>
    s.api.handle({ method, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, rawBody: body === undefined ? undefined : JSON.stringify(body) } as ApiRequest)
  const login = (fields: Record<string, string>): string => {
    const res = s.ui.handle(post('/t/demo/login', new URLSearchParams(fields)))
    return `wp_session=${/wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]}`
  }
  const bearer = (api('POST', '/t/demo/sessions', undefined, { role: 'planner' }).body as { token: string }).token
  const wedding = (api('POST', '/t/demo/weddings', bearer, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' }).body as { wedding: { wedding_id: string } }).wedding.wedding_id
  api('POST', `/t/demo/weddings/${wedding}/events`, bearer, { name: 'Ceremony', starts_at: '2028-06-10T16:00' })
  return { ...s, login, wedding }
}

const get = (path: string, cookie: string): ApiRequest => ({ method: 'GET', path, headers: { cookie } })
function post(path: string, form: URLSearchParams, cookie?: string): ApiRequest {
  return { method: 'POST', path, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) }, rawBody: form.toString() }
}
const csrfOf = (page: HttpResult): string => /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string

describe('the assistant page', () => {
  it('the planner asks, waits, and keeps the picked tasks; they are then on the checklist', async () => {
    const w = setup()
    const planner = w.login({ role: 'planner' })
    const page = w.ui.handle(get(`/t/demo?wedding=${w.wedding}&tab=copilot`, planner))
    expect(page.status).toBe(200)
    expect(page.body).toContain('Draft a checklist and run of show')
    const csrf = csrfOf(page)
    expect(w.ui.handle(post('/t/demo/copilot/draft-request', new URLSearchParams({ _csrf: 'forged', wedding_id: w.wedding }), planner)).status).toBe(403)
    const asked = w.ui.handle(post('/t/demo/copilot/draft-request', new URLSearchParams({ _csrf: csrf, wedding_id: w.wedding }), planner))
    expect(asked.headers.location).toBe(`/t/demo?wedding=${w.wedding}&tab=copilot&notice=requested`)
    expect(w.ui.handle(get(asked.headers.location as string, planner)).body).toContain('The assistant is drafting')
    await w.drainJobs()
    const ready = w.ui.handle(get(`/t/demo?wedding=${w.wedding}&tab=copilot`, planner)).body
    expect(ready).toContain('Confirm the timing of Ceremony')
    expect(ready).toContain('Final walkthrough: Ceremony')
    const firstTask = /name="task" value="(t\d+)"/.exec(ready)?.[1] as string
    const draft = /name="draft" value="([^"]+)"/.exec(ready)?.[1] as string
    const form = new URLSearchParams({ _csrf: csrf, wedding_id: w.wedding, draft })
    form.append('task', firstTask)
    const kept = w.ui.handle(post('/t/demo/copilot/draft-accept', form, planner))
    expect(kept.headers.location).toContain('notice=kept')
    const checklist = w.ui.handle(get(`/t/demo?wedding=${w.wedding}&tab=checklist`, planner)).body
    expect(checklist).toContain('Confirm the timing of Ceremony')
  })

  it('the couple gets the forbidden page and cannot ask', () => {
    const w = setup()
    const couple = w.login({ role: 'couple', wedding_id: w.wedding })
    expect(w.ui.handle(get(`/t/demo?wedding=${w.wedding}&tab=copilot`, couple)).status).toBe(403)
    const csrf = csrfOf(w.ui.handle(get(`/t/demo?wedding=${w.wedding}&tab=site`, couple)))
    // A couple's (valid) form post is refused by the JSON route and comes back as a notice.
    expect(w.ui.handle(post('/t/demo/copilot/draft-request', new URLSearchParams({ _csrf: csrf, wedding_id: w.wedding }), couple)).headers.location).toContain('notice=forbidden')
  })
})
