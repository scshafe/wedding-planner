import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface, type HttpResult } from '@wedding-planner/product'

/** Issue #31 in the browser: the checklist page, its forms, and the offer to move open tasks when the date moves. */

function setup() {
  const s = composeProductSurface({
    clock: new ManualClock('2028-01-10T12:00:00.000Z'),
    ids: new SequentialIdGenerator('clw'),
    operatorToken: 'clw-operator-token-0123456789',
    providerWebhookToken: 'clw-webhook-token-0123456789',
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
  return { method: 'POST', path, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) }, rawBody: new URLSearchParams(fields).toString() }
}

const csrfOf = (page: HttpResult): string => /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string

describe('the checklist page', () => {
  it('adds the template, adds and completes a task, with overdue tasks first', () => {
    const w = setup()
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=checklist`, w.planner))
    expect(page.status).toBe(200)
    expect(page.body).toContain('Add the checklist template')
    const csrf = csrfOf(page)
    expect(w.ui.handle(form('/t/demo/checklist/apply-template', { _csrf: csrf, wedding_id: w.ours }, w.planner)).headers.location).toContain('notice=applied')
    w.ui.handle(form('/t/demo/checklist/task-add', { _csrf: csrf, wedding_id: w.ours, title: 'Late <task>', due_date: '2028-01-01', assignee: 'couple' }, w.planner))
    const body = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=checklist`, w.planner)).body
    expect(body).not.toContain('Add the checklist template')
    expect(body.indexOf('<h3>Overdue</h3>')).toBeGreaterThan(-1)
    expect(body.indexOf('<h3>Overdue</h3>')).toBeLessThan(body.indexOf('Late &lt;task&gt;'))
    expect(body).toContain('Late &lt;task&gt;')
    expect(body).toContain('overdue since 2028-01-01')
    const taskId = /name="task_id" value="([^"]+)">[\s\S]{0,200}?name="status" value="done"/.exec(body.slice(body.indexOf('Late &lt;task&gt;')))?.[1] as string
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    const coupleCsrf = csrfOf(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=checklist`, couple)))
    expect(w.ui.handle(form('/t/demo/checklist/task-status', { _csrf: coupleCsrf, wedding_id: w.ours, task_id: taskId, status: 'done' }, couple)).headers.location).toContain('notice=saved')
    expect(w.ui.handle(form('/t/demo/checklist/task-add', { _csrf: coupleCsrf, wedding_id: w.ours, title: 'X', due_date: '2028-02-01', assignee: 'couple' }, couple)).headers.location).toContain('notice=forbidden')
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=checklist`, w.planner)).body).toContain('was due 2028-01-01')
  })

  it('moving the wedding date offers to move the open tasks, and moving them does', () => {
    const w = setup()
    const detail = w.ui.handle(get(`/t/demo?wedding=${w.ours}`, w.planner))
    expect(detail.body).toContain('Checklist →')
    const csrf = csrfOf(detail)
    w.ui.handle(form('/t/demo/checklist/apply-template', { _csrf: csrf, wedding_id: w.ours }, w.planner))
    const bearer = (w.api.handle({ method: 'POST', path: '/t/demo/sessions', headers: {}, rawBody: JSON.stringify({ role: 'planner' }) }).body as { token: string }).token
    const wedding = (w.api.handle({ method: 'GET', path: `/t/demo/weddings/${w.ours}`, headers: { authorization: `Bearer ${bearer}` } }).body as { wedding: { couple_display_name: string; event_date: string; status: string } }).wedding
    const later = new Date(Date.parse(`${wedding.event_date}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10)
    const fields = { _csrf: csrf, wedding_id: w.ours, couple_display_name: wedding.couple_display_name, event_date: later, status: wedding.status }
    const saved = w.ui.handle(form('/t/demo/weddings/update', fields, w.planner))
    expect(saved.headers.location).toBe(`/t/demo?wedding=${w.ours}`)
    const offer = w.ui.handle(get(saved.headers.location as string, w.planner))
    expect(offer.body).toContain(`The wedding moved from ${wedding.event_date} to ${later} (14 day(s) later).`)
    // The offer comes from server data only: a crafted URL cannot make one.
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}&moved=-3650`, w.planner)).body).not.toContain('3650')
    type Task = { template_key?: string; due_date: string }
    const venueDue = (): string | undefined => {
      const view = w.api.handle({ method: 'GET', path: `/t/demo/weddings/${w.ours}/tasks`, headers: { authorization: `Bearer ${bearer}` } }).body as { overdue: Task[]; upcoming: Task[] }
      return [...view.overdue, ...view.upcoming].find((t) => t.template_key === 'book_venue')?.due_date
    }
    const before = venueDue() as string
    expect(w.ui.handle(form('/t/demo/checklist/shift', { _csrf: csrf, wedding_id: w.ours }, w.planner)).headers.location).toContain('notice=shifted')
    expect(venueDue()).toBe(new Date(Date.parse(`${before}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10))
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}`, w.planner)).body).not.toContain('The date moved')
  })

  it('a couple\'s other wedding is the generic not-found', () => {
    const w = setup()
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    expect(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=checklist`, couple)).status).toBe(200)
    expect(w.ui.handle(get('/t/demo?wedding=wedding_other&tab=checklist', couple)).status).toBe(404)
  })
})
