import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface } from '@wedding-planner/product'

/** Issue #32 through the surface: the JSON route (planner only), the home card's counts, and the page. */

function setup() {
  const s = composeProductSurface({
    clock: new ManualClock('2028-01-10T12:00:00.000Z'),
    ids: new SequentialIdGenerator('dt'),
    operatorToken: 'dt-operator-token-0123456789',
    providerWebhookToken: 'dt-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const api = (method: string, path: string, token?: string, body?: unknown) =>
    s.api.handle({ method, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, rawBody: body === undefined ? undefined : JSON.stringify(body) } as ApiRequest)
  const login = (fields: Record<string, string>): string => {
    const res = s.ui.handle({ method: 'POST', path: '/t/demo/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: new URLSearchParams(fields).toString() })
    return `wp_session=${/wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]}`
  }
  const bearer = (api('POST', '/t/demo/sessions', undefined, { role: 'planner' }).body as { token: string }).token
  const ours = s.demo?.weddingId as string
  api('PUT', `/t/demo/weddings/${ours}`, bearer, { status: 'active' })
  api('POST', `/t/demo/weddings/${ours}/tasks`, bearer, { title: 'Overdue <one>', due_date: '2028-01-02', assignee: 'planner' })
  api('POST', `/t/demo/weddings/${ours}/tasks`, bearer, { title: 'This week', due_date: '2028-01-14', assignee: 'couple' })
  return { ...s, api, login, bearer, ours }
}

const get = (path: string, cookie?: string): ApiRequest => ({ method: 'GET', path, headers: cookie === undefined ? {} : { cookie } })

describe('tasks due across weddings', () => {
  it('GET /t/:slug/due-tasks is the planner\'s; a couple gets 403 for any method', () => {
    const w = setup()
    expect(w.api('GET', '/t/demo/due-tasks', w.bearer).body).toMatchObject({ overdue: 1, due_soon: 1 })
    const couple = (w.api('POST', '/t/demo/sessions', undefined, { role: 'couple', wedding_id: w.ours }).body as { token: string }).token
    expect(w.api('GET', '/t/demo/due-tasks', couple).status).toBe(403)
    expect(w.api('POST', '/t/demo/due-tasks', couple, {}).status).toBe(403)
    expect(w.api('POST', '/t/demo/due-tasks', w.bearer, {}).status).toBe(405)
    expect(w.api('GET', '/t/demo/due-tasks').status).toBe(401)
  })

  it('the home overview shows the two counts to a planner and links to the page; a couple gets neither', () => {
    const w = setup()
    const planner = w.login({ role: 'planner' })
    const home = w.ui.handle(get('/t/demo', planner)).body
    expect(home).toContain('Tasks due →')
    expect(home).toContain('1 overdue')
    expect(home).toContain(' · 1 due this week')
    const page = w.ui.handle(get('/t/demo?view=due', planner))
    expect(page.status).toBe(200)
    expect(page.body).toContain('Overdue &lt;one&gt;')
    expect(page.body).toContain('overdue since 2028-01-02')
    expect(page.body).toContain('This week')
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    expect(w.ui.handle(get('/t/demo', couple)).body).not.toContain('Tasks due')
    expect(w.ui.handle(get('/t/demo?view=due', couple)).status).toBe(403)
  })
})
