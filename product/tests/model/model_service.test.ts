import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  defineModelTask,
  InMemoryRecordStore,
  MODEL_LIMITS,
  type ModelPort,
  type ModelRequest,
  type ModelResult,
  ModelService,
  SIMULATED_PROVIDER_PRICE,
  SimulatedModelAdapter,
  TenantContextResolver,
  TenantStore,
} from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'

/**
 * Issue #59 — the model port: the simulated adapter is deterministic, a suspended workspace never reaches the model,
 * the output is validated against its task's contract before use, every call is metered per workspace, month and task
 * (an invalid output and a refused usage report too), the provider's cost is recorded but not shown to the tenant, and
 * only the simulated adapter is ever composed.
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

// Test tasks BORROW an existing contract for their output shape (a real task defines its own under product/schemas/).
type Named = { site_name: string }
const NAME = defineModelTask<Named>({ task: 'name', instructions: 'Name the site.', output_contract: 'wedding_site_name' })
const GARBAGE = defineModelTask<Named>({ task: 'garbage', instructions: 'Say anything.', output_contract: 'wedding_site_name' })
const BROKEN = defineModelTask<Named>({ task: 'broken', instructions: 'Fail.', output_contract: 'wedding_site_name' })
const UNKNOWN = defineModelTask<Named>({ task: 'nope', instructions: 'Nobody answers this.', output_contract: 'wedding_site_name' })
const named = (input: Readonly<Record<string, unknown>>) => ({ tenant_id: 'x', site_name: `name-${String(input.n)}`, wedding_id: 'w' })
const TASKS = {
  name: named,
  garbage: () => ({ nope: true }),
  broken: () => {
    throw new Error('boom')
  },
}

/** A port that counts its calls and answers with a fixed usage. */
function spy(usage: ModelResult['usage'] = { input_tokens: 1_000_000, output_tokens: 200_000, cost_micro_cents: 600_000_000 }) {
  const calls: ModelRequest[] = []
  const port: ModelPort = {
    complete: (request) => {
      calls.push(request)
      return Promise.resolve({ output: named(request.input), usage, model: 'm' })
    },
  }
  return { port, calls }
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
  const model = new ModelService(tenants, port ?? new SimulatedModelAdapter(TASKS), clock, store)
  return { clock, tenants, ctx, other, model, store }
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
  it('is deterministic: the same request gives the same output, usage and cost', async () => {
    const adapter = new SimulatedModelAdapter(TASKS)
    const request = { task: 'name', instructions: 'Name the site.', input: { n: 7 }, output_contract: 'wedding_site_name' } as const
    const a = await adapter.complete(request)
    expect(await adapter.complete(request)).toEqual(a)
    expect(a.model).toBe('simulated')
    expect(a.usage.cost_micro_cents).toBe(a.usage.input_tokens * SIMULATED_PROVIDER_PRICE.input_cents_per_mtok + a.usage.output_tokens * SIMULATED_PROVIDER_PRICE.output_cents_per_mtok)
    const w = world()
    expect((await w.model.run(w.ctx, NAME, { n: 7 })).site_name).toBe('name-7')
  })

  it('a suspended workspace is refused before the model is called (nothing is paid)', async () => {
    const s = spy()
    const w = world(s.port)
    w.tenants.setLifecycleStatus(w.ctx.tenant_id, 'suspended')
    expect(await codeOf(w.model.run(w.ctx, NAME, { n: 1 }))).toBe('PRODUCT.TENANT_NOT_USABLE')
    expect(s.calls).toEqual([])
  })

  it("validates the output against the task's contract; an invalid output is still metered", async () => {
    const w = world()
    expect(await codeOf(w.model.run(w.ctx, GARBAGE, {}))).toBe('MODEL.INVALID_OUTPUT')
    expect(w.model.usageFor(w.ctx)).toMatchObject({ calls: 1, tasks: [{ task: 'garbage', calls: 1 }] })
  })

  it('an adapter failure is MODEL.UNAVAILABLE; an unknown task is a programming error; neither is metered', async () => {
    const w = world()
    expect(await codeOf(w.model.run(w.ctx, BROKEN, {}))).toBe('MODEL.UNAVAILABLE')
    expect(await codeOf(w.model.run(w.ctx, UNKNOWN, {}))).toBe('MODEL.UNKNOWN_TASK')
    const failing = world({ complete: () => Promise.reject(new Error('network')) })
    expect(await codeOf(failing.model.run(failing.ctx, NAME, {}))).toBe('MODEL.UNAVAILABLE')
    expect(w.model.usageFor(w.ctx).calls).toBe(0)
  })

  it("a provider's usage report is untrusted: a bad one is refused, counted as a rejected call, and adds nothing", async () => {
    const bad = [
      { input_tokens: -1, output_tokens: 1, cost_micro_cents: 1 },
      { input_tokens: 1.5, output_tokens: 1, cost_micro_cents: 1 },
      { input_tokens: 1, output_tokens: Number.NaN, cost_micro_cents: 1 },
      { input_tokens: '3', output_tokens: 1, cost_micro_cents: 1 },
      { input_tokens: MODEL_LIMITS.tokens_per_call + 1, output_tokens: 1, cost_micro_cents: 1 },
      { input_tokens: 1, output_tokens: 1, cost_micro_cents: -5 },
    ]
    for (const usage of bad) {
      const w = world(spy(usage as never).port)
      expect(await codeOf(w.model.run(w.ctx, NAME, {}))).toBe('MODEL.INVALID_USAGE')
      const [record] = w.store.list(COLLECTIONS.modelUsage, w.ctx.tenant_id)
      expect(record).toMatchObject({ calls: 1, rejected_usage_calls: 1, input_tokens: 0, output_tokens: 0, cost_micro_cents: 0 })
    }
  })

  it('meters per workspace, month and task; the tenant sees calls and tokens, the record keeps the cost', async () => {
    const w = world(spy().port)
    const OTHER = defineModelTask<Named>({ task: 'other', instructions: 'Name it again.', output_contract: 'wedding_site_name' })
    await w.model.run(w.ctx, NAME, {})
    await w.model.run(w.ctx, NAME, {})
    await w.model.run(w.ctx, OTHER, {})
    const view = w.model.usageFor(w.ctx)
    expect(view).toEqual({
      month: '2028-01',
      calls: 3,
      input_tokens: 3_000_000,
      output_tokens: 600_000,
      tasks: [
        { task: 'name', calls: 2, input_tokens: 2_000_000, output_tokens: 400_000 },
        { task: 'other', calls: 1, input_tokens: 1_000_000, output_tokens: 200_000 },
      ],
    })
    expect(JSON.stringify(view)).not.toContain('cost')
    expect(w.store.get(COLLECTIONS.modelUsage, w.ctx.tenant_id, '2028-01/name')).toMatchObject({ cost_micro_cents: 1_200_000_000 })
    expect(w.model.usageFor(w.other).calls).toBe(0)
    // The next month starts at zero; the last one is kept.
    w.clock.advance(2 * 3600 * 1000)
    await w.model.run(w.ctx, NAME, {})
    expect(w.model.usageFor(w.ctx).calls).toBe(1)
    expect(w.model.usageFor(w.ctx, '2028-01').calls).toBe(3)
  })
})

describe('only the simulated adapter is composed (owner decision, ADR 0057) — a tripwire on the composition root', () => {
  const ROOT = join(__dirname, '..', '..', '..')
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (name === 'node_modules' || name === 'tests') return []
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
    })
  const sources = [...files(join(ROOT, 'product', 'src')), ...files(join(ROOT, 'app'))]

  it('the model service is built once, in compose.ts, over the simulated adapter; the config takes no port', () => {
    const builders = sources.filter((path) => readFileSync(path, 'utf8').includes('new ModelService('))
    expect(builders.map((p) => relative(ROOT, p))).toEqual([join('product', 'src', 'runtime', 'compose.ts')])
    const compose = readFileSync(join(ROOT, 'product', 'src', 'runtime', 'compose.ts'), 'utf8')
    expect(compose).toMatch(/new ModelService\(tenants, new SimulatedModelAdapter\(/)
    expect(compose).not.toMatch(/ModelPort/)
    expect(readFileSync(join(ROOT, 'app', 'server.ts'), 'utf8')).not.toContain('simulatedModelTasks')
  })

  it('no source makes an outbound network call, and the model code reads no environment', () => {
    const outbound = /\bfetch\(|node:https|node:http2|node:net|node:tls|\bundici\b|https?\.request\(|https?\.get\(|\bimport\(/
    expect(sources.filter((path) => outbound.test(readFileSync(path, 'utf8'))).map((p) => relative(ROOT, p))).toEqual([])
    const model = sources.filter((path) => path.includes(join('src', 'model')))
    expect(model.length).toBeGreaterThan(0)
    expect(model.filter((path) => /process\.env|process\[/.test(readFileSync(path, 'utf8')))).toEqual([])
  })
})
