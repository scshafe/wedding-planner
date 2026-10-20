import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  InMemoryRecordStore,
  type ModelPort,
  type ModelRequest,
  ModelService,
  SIMULATED_PROVIDER_PRICE,
  SimulatedModelAdapter,
  TenantContextResolver,
  TenantStore,
} from '@wedding-planner/product'

/**
 * Issue #59 — the model port: the simulated adapter is deterministic, the output is validated against its contract
 * before use, every call is metered per workspace and month (an invalid output too), a provider's usage report is
 * untrusted, and only the simulated adapter exists.
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

/** A task whose output satisfies `wedding_site_name` when given a tenant and a wedding; garbage otherwise. */
const TASKS = {
  echo: (input: Readonly<Record<string, unknown>>) => ({ tenant_id: input.tenant_id, site_name: `name-${String(input.n)}`, wedding_id: 'w_1' }),
  garbage: () => ({ nope: true }),
  broken: () => {
    throw new Error('boom')
  },
}

function world(port?: ModelPort) {
  const clock = new ManualClock('2028-01-31T23:00:00.000Z')
  const store = new InMemoryRecordStore()
  const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), store)
  tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  tenants.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(tenants)
  const ctx = resolver.resolveBySlug('alpha')
  const other = resolver.resolveBySlug('beta')
  const model = new ModelService(tenants, port ?? new SimulatedModelAdapter(TASKS), clock, (fn) => store.transaction(fn), store)
  const request = (task: string, n = 1): ModelRequest => ({ task, instructions: 'Name the site.', input: { tenant_id: ctx.tenant_id, n }, output_contract: 'wedding_site_name' })
  return { clock, tenants, ctx, other, model, request }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('ModelService over the simulated adapter', () => {
  it('is deterministic: the same request gives the same output and the same usage', async () => {
    const adapter = new SimulatedModelAdapter(TASKS)
    const w = world()
    const a = await adapter.complete(w.request('echo', 7))
    const b = await adapter.complete(w.request('echo', 7))
    expect(a).toEqual(b)
    expect(a.model).toBe('simulated')
    expect(a.usage.input_tokens).toBeGreaterThan(0)
    expect(await w.model.run(w.ctx, w.request('echo', 7))).toEqual({ tenant_id: w.ctx.tenant_id, site_name: 'name-7', wedding_id: 'w_1' })
  })

  it("validates the output against the request's contract; an invalid output is still metered", async () => {
    const w = world()
    expect(await codeOf(w.model.run(w.ctx, w.request('garbage')))).toBe('MODEL.INVALID_OUTPUT')
    expect(w.model.usageFor(w.ctx).calls).toBe(1)
  })

  it('an adapter failure is MODEL.UNAVAILABLE; an unknown task is a programming error, not metered', async () => {
    const w = world()
    expect(await codeOf(w.model.run(w.ctx, w.request('broken')))).toBe('MODEL.UNAVAILABLE')
    expect(await codeOf(w.model.run(w.ctx, w.request('nope')))).toBe('MODEL.UNKNOWN_TASK')
    const failing = world({ complete: () => Promise.reject(new Error('network')) })
    expect(await codeOf(failing.model.run(failing.ctx, failing.request('echo')))).toBe('MODEL.UNAVAILABLE')
    expect(w.model.usageFor(w.ctx).calls).toBe(0)
  })

  it("a provider's usage report is untrusted: anything but whole, non-negative numbers is refused and not metered", async () => {
    for (const usage of [{ input_tokens: -1, output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 1 }, { input_tokens: 1, output_tokens: Number.NaN }, { input_tokens: '3', output_tokens: 1 }]) {
      const w = world({ complete: (r) => Promise.resolve({ output: TASKS.echo(r.input), usage: usage as never, model: 'm' }) })
      expect(await codeOf(w.model.run(w.ctx, w.request('echo')))).toBe('MODEL.INVALID_USAGE')
      expect(w.model.usageFor(w.ctx).calls).toBe(0)
    }
  })

  it('meters per workspace and per month, with a simulated provider cost', async () => {
    const fixed = world({ complete: (r) => Promise.resolve({ output: TASKS.echo(r.input), usage: { input_tokens: 1_000_000, output_tokens: 200_000 }, model: 'm' }) })
    await fixed.model.run(fixed.ctx, fixed.request('echo'))
    await fixed.model.run(fixed.ctx, fixed.request('echo'))
    expect(fixed.model.usageFor(fixed.ctx)).toEqual({
      month: '2028-01',
      calls: 2,
      input_tokens: 2_000_000,
      output_tokens: 400_000,
      simulated_cost_cents: 2 * SIMULATED_PROVIDER_PRICE.input_cents_per_mtok + (2 * SIMULATED_PROVIDER_PRICE.output_cents_per_mtok) / 5,
    })
    expect(fixed.model.usageFor(fixed.other).calls).toBe(0)
    // The next month starts at zero; the last one is kept.
    fixed.clock.advance(2 * 3600 * 1000)
    await fixed.model.run(fixed.ctx, fixed.request('echo'))
    expect(fixed.model.usageFor(fixed.ctx).calls).toBe(1)
    expect(fixed.model.usageFor(fixed.ctx, '2028-01').calls).toBe(2)
  })

  it('a suspended workspace cannot run the model', async () => {
    const w = world()
    w.tenants.setLifecycleStatus(w.ctx.tenant_id, 'suspended')
    expect(await codeOf(w.model.run(w.ctx, w.request('echo')))).toBe('PRODUCT.TENANT_NOT_USABLE')
  })
})

describe('only the simulated adapter exists (owner decision, ADR 0057)', () => {
  const SRC = join(__dirname, '..', '..', 'src')
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
    })

  it('no other class implements ModelPort, and the model code reads no environment', () => {
    const implementers = files(SRC).filter((path) => /implements\s+ModelPort\b/.test(readFileSync(path, 'utf8')))
    expect(implementers.map((p) => relative(SRC, p))).toEqual([join('model', 'simulated_model_adapter.ts')])
    for (const path of files(join(SRC, 'model'))) expect(readFileSync(path, 'utf8')).not.toMatch(/process\.env|fetch\(|node:https?/)
  })
})
