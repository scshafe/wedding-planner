import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface, defineModelTask, InMemoryRecordStore, SIMULATED_MODEL_TASKS, TenantContextResolver, TenantStore } from '@wedding-planner/product'

/**
 * Issue #59 through the surface: the workspace's model usage on the billing JSON and page — calls and tokens, never the
 * provider's cost — and the compose seam that adds a test task without replacing the product's own.
 */

function surface(store = new InMemoryRecordStore(), simulatedModelTasks?: Parameters<typeof composeProductSurface>[0]['simulatedModelTasks']) {
  const clock = new ManualClock('2028-01-10T12:00:00.000Z')
  const s = composeProductSurface({
    clock,
    ids: new SequentialIdGenerator('mu'),
    operatorToken: 'mu-operator-token-0123456789',
    providerWebhookToken: 'mu-webhook-token-0123456789',
    demoSlug: 'demo',
    store,
    passwordCost: { N: 16, r: 1, p: 1 },
    ...(simulatedModelTasks === undefined ? {} : { simulatedModelTasks }),
  })
  return { s, clock, store }
}

describe('model usage on the billing page', () => {
  it("shows the month's calls and tokens; nothing is charged, and the provider's cost is not shown", async () => {
    // (The test task borrows an existing contract for its output shape.)
    const { s, clock, store } = surface(undefined, { echo: () => ({ tenant_id: 'x', site_name: 'echo-site', wedding_id: 'w' }) })
    const ctx = new TenantContextResolver(new TenantStore(clock, new SequentialIdGenerator('c'), store)).resolveBySlug('demo')
    await s.model.run(ctx, defineModelTask({ task: 'echo', instructions: 'Echo.', output_contract: 'wedding_site_name' }), {})
    const login = s.api.handle({ method: 'POST', path: '/t/demo/sessions', headers: {}, rawBody: JSON.stringify({ role: 'planner' }) } as ApiRequest)
    const token = (login.body as { token: string }).token
    const billing = s.api.handle({ method: 'GET', path: '/t/demo/billing', headers: { authorization: `Bearer ${token}` } })
    expect((billing.body as { model_usage: unknown }).model_usage).toMatchObject({ month: '2028-01', calls: 1, tasks: [{ task: 'echo', calls: 1 }] })
    expect(JSON.stringify(billing.body)).not.toContain('cost_micro')
    const page = s.ui.handle({ method: 'POST', path: '/t/demo/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: 'role=planner' })
    const cookie = `wp_session=${/wp_session=([^;]+)/.exec(page.headers['set-cookie'] ?? '')?.[1]}`
    const html = s.ui.handle({ method: 'GET', path: '/t/demo?view=billing', headers: { cookie } }).body
    expect(html).toContain('AI assistant usage')
    expect(html).toContain('1 call(s) in 2028-01')
    expect(html).toContain('nothing is charged')
  })

  it("a test task is added to the product's tasks, never replacing one", () => {
    for (const name of Object.keys(SIMULATED_MODEL_TASKS)) {
      expect(() => surface(undefined, { [name]: () => ({}) })).toThrow(/may not replace/)
    }
    expect(() => surface(undefined, { extra: () => ({}) })).not.toThrow()
  })
})
