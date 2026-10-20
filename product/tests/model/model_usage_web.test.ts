import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface, InMemoryRecordStore, TenantContextResolver, TenantStore } from '@wedding-planner/product'

/** Issue #59 through the surface: the workspace's model usage on the billing JSON and page (the planner's own only). */

describe('model usage on the billing page', () => {
  it('shows the month’s calls and the simulated cost; nothing is charged', async () => {
    const clock = new ManualClock('2028-01-10T12:00:00.000Z')
    const store = new InMemoryRecordStore()
    const s = composeProductSurface({
      clock,
      ids: new SequentialIdGenerator('mu'),
      operatorToken: 'mu-operator-token-0123456789',
      providerWebhookToken: 'mu-webhook-token-0123456789',
      demoSlug: 'demo',
      store,
      passwordCost: { N: 16, r: 1, p: 1 },
      simulatedModelTasks: { echo: (input) => ({ tenant_id: input.tenant_id, site_name: 'echo-site', wedding_id: 'w' }) },
    })
    const ctx = new TenantContextResolver(new TenantStore(clock, new SequentialIdGenerator('c'), store)).resolveBySlug('demo')
    await s.model.run(ctx, { task: 'echo', instructions: 'Echo.', input: { tenant_id: ctx.tenant_id }, output_contract: 'wedding_site_name' })
    const login = s.api.handle({ method: 'POST', path: '/t/demo/sessions', headers: {}, rawBody: JSON.stringify({ role: 'planner' }) } as ApiRequest)
    const token = (login.body as { token: string }).token
    const billing = s.api.handle({ method: 'GET', path: '/t/demo/billing', headers: { authorization: `Bearer ${token}` } })
    const body = billing.body as { model_usage: { calls: number; month: string }; billing: { balance_cents: number } }
    expect(body.model_usage).toMatchObject({ month: '2028-01', calls: 1 })
    const page = s.ui.handle({ method: 'POST', path: '/t/demo/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: 'role=planner' })
    const cookie = `wp_session=${/wp_session=([^;]+)/.exec(page.headers['set-cookie'] ?? '')?.[1]}`
    const html = s.ui.handle({ method: 'GET', path: '/t/demo?view=billing', headers: { cookie } }).body
    expect(html).toContain('AI assistant usage')
    expect(html).toContain('1 call(s) in 2028-01')
    expect(html).toContain('nothing is charged')
  })
})
