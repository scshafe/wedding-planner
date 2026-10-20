import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, type ApiResponse, composeProductSurface } from '@wedding-planner/product'

/** Issue #31 over HTTP: the checklist routes, the wedding boundary before any body, and the capability 403s. */

const NOT_FOUND: ApiResponse = { status: 404, body: { error: 'not_found' } }

function setup() {
  const s = composeProductSurface({
    clock: new ManualClock('2028-01-10T12:00:00.000Z'),
    ids: new SequentialIdGenerator('cl'),
    operatorToken: 'cl-operator-token-0123456789',
    providerWebhookToken: 'cl-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const call = (method: string, path: string, token?: string, body?: unknown): ApiResponse =>
    s.api.handle({ method, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, rawBody: body === undefined ? undefined : JSON.stringify(body) } as ApiRequest)
  const planner = (call('POST', '/t/demo/sessions', undefined, { role: 'planner' }).body as { token: string }).token
  const ours = s.demo?.weddingId as string
  const theirs = (call('POST', '/t/demo/weddings', planner, { couple_display_name: 'Sam & Kit', event_date: '2028-07-10' }).body as { wedding: { wedding_id: string } }).wedding.wedding_id
  const couple = (call('POST', '/t/demo/sessions', undefined, { role: 'couple', wedding_id: ours }).body as { token: string }).token
  return { call, planner, couple, ours, theirs }
}

describe('/t/:slug/weddings/:id/tasks', () => {
  it('the planner applies the template and manages tasks; the couple reads and ticks off its own', () => {
    const w = setup()
    const applied = w.call('POST', `/t/demo/weddings/${w.ours}/tasks/apply-template`, w.planner)
    expect(applied.status).toBe(200)
    expect((applied.body as { created: number }).created).toBeGreaterThan(10)
    const created = w.call('POST', `/t/demo/weddings/${w.ours}/tasks`, w.planner, { title: 'Cake tasting', due_date: '2028-02-01', assignee: 'couple' })
    expect(created.status).toBe(201)
    const task = (created.body as { task: { task_id: string } }).task.task_id
    expect(w.call('PUT', `/t/demo/weddings/${w.ours}/tasks/${task}/status`, w.couple, { status: 'done' }).status).toBe(200)
    const view = w.call('GET', `/t/demo/weddings/${w.ours}/tasks`, w.couple).body as { done: { task_id: string }[]; today: string }
    expect(view.today).toBe('2028-01-10')
    expect(view.done.map((t) => t.task_id)).toEqual([task])
    expect(w.call('PUT', `/t/demo/weddings/${w.ours}/tasks/${task}`, w.planner, { title: 'Cake', due_date: '2028-02-02', assignee: 'couple' }).status).toBe(200)
    // Moving the wedding date records the move; the planner then moves the open tasks by it.
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/tasks/shift`, w.planner).status).toBe(400)
    const date = (w.call('GET', `/t/demo/weddings/${w.ours}`, w.planner).body as { wedding: { event_date: string } }).wedding.event_date
    const later = new Date(Date.parse(`${date}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10)
    expect(w.call('PUT', `/t/demo/weddings/${w.ours}`, w.couple, { event_date: later }).status).toBe(200)
    expect((w.call('GET', `/t/demo/weddings/${w.ours}/tasks`, w.couple).body as { date_move?: { days: number } }).date_move?.days).toBe(7)
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/tasks/shift`, w.couple).status).toBe(403)
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/tasks/shift`, w.planner).status).toBe(200)
    expect(w.call('DELETE', `/t/demo/weddings/${w.ours}/tasks/${task}`, w.planner).body).toEqual({ removed: true })
  })

  it('a couple\'s planner-only call is 403 on its own wedding; another wedding is the masked 404 before any body', () => {
    const w = setup()
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/tasks`, w.couple, { title: 'X', due_date: '2028-02-01', assignee: 'couple' }).status).toBe(403)
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/tasks/apply-template`, w.couple).status).toBe(403)
    for (const wedding of [w.theirs, 'wedding_missing']) {
      expect(w.call('GET', `/t/demo/weddings/${wedding}/tasks`, w.couple)).toEqual(NOT_FOUND)
      expect(w.call('POST', `/t/demo/weddings/${wedding}/tasks`, w.couple, { junk: true })).toEqual(NOT_FOUND)
      expect(w.call('PUT', `/t/demo/weddings/${wedding}/tasks/task_x/status`, w.couple, { status: 'maybe' })).toEqual(NOT_FOUND)
    }
  })

  it('validates bodies (400) and methods (405)', () => {
    const w = setup()
    const add = (body: object) => w.call('POST', `/t/demo/weddings/${w.ours}/tasks`, w.planner, body).status
    expect(add({ title: 'X', due_date: 'soon', assignee: 'planner' })).toBe(400)
    expect(add({ title: 'X', due_date: '2028-02-01', assignee: 'guest' })).toBe(400)
    expect(add({ due_date: '2028-02-01', assignee: 'planner' })).toBe(400)
    expect(w.call('PUT', `/t/demo/weddings/${w.ours}`, w.planner, { event_date: '2028-13-01' }).status).toBe(400)
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/tasks/apply-template`, w.planner).status).toBe(200)
    expect(w.call('POST', `/t/demo/weddings/${w.ours}/tasks`, w.couple, { junk: true }).status).toBe(403) // capability before body
    expect(w.call('PUT', `/t/demo/weddings/${w.ours}/tasks/task_x/status`, w.planner, { status: 'maybe' }).status).toBe(400)
    expect(w.call('GET', `/t/demo/weddings/${w.ours}/tasks/apply-template`, w.planner).status).toBe(405)
    expect(w.call('PATCH', `/t/demo/weddings/${w.ours}/tasks`, w.planner).status).toBe(405)
    expect(w.call('PUT', `/t/demo/weddings/${w.ours}/tasks/task_x`, w.planner, { title: 'X', due_date: '2028-02-01', assignee: 'planner' })).toEqual(NOT_FOUND)
  })
})
