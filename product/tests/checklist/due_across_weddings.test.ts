import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { ChecklistService, InMemoryRecordStore, SessionStore, TenantContextResolver, TenantStore, WeddingAuthorizer, WeddingRepository } from '@wedding-planner/product'

/**
 * Issue #32 — the planner's morning view across weddings, at its edges: due today and due in exactly 7 days are "due
 * this week", 8 days is not, yesterday is overdue; done tasks and finished weddings are left out; a couple is refused.
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

function world() {
  const clock = new ManualClock('2028-01-10T23:59:59.000Z')
  const store = new InMemoryRecordStore()
  const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), store)
  tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const ctx = new TenantContextResolver(tenants).resolveBySlug('alpha')
  const weddings = new WeddingRepository(tenants, clock, new SequentialIdGenerator('w'), store)
  const sessions = new SessionStore(new SequentialIdGenerator('s'))
  const planner = sessions.login(ctx, { role: 'planner' }).principal
  const checklist = new ChecklistService(tenants, weddings, new WeddingAuthorizer(), clock, new SequentialIdGenerator('k'), store)
  const wedding = (name: string, status: 'planning' | 'active' | 'completed' | 'cancelled' = 'active') => {
    const w = weddings.create(ctx, { couple_display_name: name, event_date: '2028-06-10' })
    weddings.update(ctx, { ...w, status })
    return w.wedding_id
  }
  const task = (wedding_id: string, title: string, due_date: string) => checklist.addTask(ctx, planner, wedding_id, { title, due_date, assignee: 'planner' })
  return { clock, ctx, weddings, sessions, planner, checklist, wedding, task }
}

describe('ChecklistService.dueAcrossWeddings', () => {
  it('counts due today and in exactly 7 days as this week, 8 days not, and yesterday as overdue', () => {
    const w = world()
    const a = w.wedding('Ana & Bo')
    w.task(a, 'yesterday', '2028-01-09')
    w.task(a, 'today', '2028-01-10')
    w.task(a, 'in 7 days', '2028-01-17')
    w.task(a, 'in 8 days', '2028-01-18')
    const due = w.checklist.dueAcrossWeddings(w.ctx, w.planner)
    expect(due).toMatchObject({ today: '2028-01-10', horizon: '2028-01-17', overdue: 1, due_soon: 2 })
    expect(due.weddings[0]?.overdue.map((t) => t.title)).toEqual(['yesterday'])
    expect(due.weddings[0]?.due_soon.map((t) => t.title)).toEqual(['today', 'in 7 days'])
    // A second later it is the next day: "today" moves with the clock.
    w.clock.advance(1000)
    expect(w.checklist.dueAcrossWeddings(w.ctx, w.planner)).toMatchObject({ today: '2028-01-11', overdue: 2, due_soon: 2 })
  })

  it('groups by wedding, most urgent first, leaving out done tasks, finished weddings and weddings with nothing due', () => {
    const w = world()
    const calm = w.wedding('Calm & Co')
    const urgent = w.wedding('Urgent & Co', 'planning')
    const done = w.wedding('Done & Co', 'completed')
    const off = w.wedding('Off & Co', 'cancelled')
    const quiet = w.wedding('Quiet & Co')
    w.task(calm, 'calm', '2028-01-15')
    w.task(urgent, 'urgent', '2027-12-01')
    w.task(done, 'finished wedding', '2027-12-01')
    w.task(off, 'cancelled wedding', '2027-12-01')
    w.task(quiet, 'far away', '2028-05-01')
    const ticked = w.task(calm, 'ticked off', '2028-01-01')
    w.checklist.setStatus(w.ctx, w.planner, calm, ticked.task_id, 'done')
    const due = w.checklist.dueAcrossWeddings(w.ctx, w.planner)
    expect(due.weddings.map((g) => [g.couple_display_name, [...g.overdue, ...g.due_soon].map((t) => t.title)])).toEqual([
      ['Urgent & Co', ['urgent']],
      ['Calm & Co', ['calm']],
    ])
  })

  it('is the planner\'s: a couple is refused (and never sees another wedding\'s tasks)', () => {
    const w = world()
    const a = w.wedding('Ana & Bo')
    w.task(a, 'secret', '2028-01-10')
    const couple = w.sessions.login(w.ctx, { role: 'couple', wedding_id: a }).principal
    expect(() => w.checklist.dueAcrossWeddings(w.ctx, couple)).toThrow(expect.objectContaining({ code: 'PRODUCT.FORBIDDEN' }))
  })
})
