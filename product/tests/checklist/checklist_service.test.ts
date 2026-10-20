import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  CHECKLIST_TEMPLATE,
  ChecklistService,
  InMemoryRecordStore,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Issue #31 — a wedding's checklist below the HTTP edge: the template applied once, overdue/upcoming at the edges of
 * "today" (the injected clock), the planner/couple capabilities, the wedding's boundary, shifting open tasks.
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

function world(limits?: { tasks: number }) {
  const clock = new ManualClock('2028-01-10T12:00:00.000Z')
  const store = new InMemoryRecordStore()
  const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), store)
  tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const ctx = new TenantContextResolver(tenants).resolveBySlug('alpha')
  const weddings = new WeddingRepository(tenants, clock, new SequentialIdGenerator('w'), store)
  const ours = weddings.create(ctx, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' }).wedding_id
  const theirs = weddings.create(ctx, { couple_display_name: 'Sam & Kit', event_date: '2028-07-10' }).wedding_id
  const sessions = new SessionStore(new SequentialIdGenerator('s'))
  const planner = sessions.login(ctx, { role: 'planner' }).principal
  const couple = sessions.login(ctx, { role: 'couple', wedding_id: ours }).principal
  const checklist = new ChecklistService(tenants, weddings, new WeddingAuthorizer(), clock, new SequentialIdGenerator('k'), store, limits)
  return { clock, ctx, weddings, ours, theirs, planner, couple, checklist }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('ChecklistService', () => {
  it('applies the template once, each task due its offset before the wedding date', () => {
    const w = world()
    expect(w.checklist.applyTemplate(w.ctx, w.planner, w.ours)).toBe(CHECKLIST_TEMPLATE.length)
    expect(w.checklist.applyTemplate(w.ctx, w.planner, w.ours)).toBe(0)
    const tasks = w.checklist.tasksOf(w.ctx, w.ours)
    expect(tasks).toHaveLength(CHECKLIST_TEMPLATE.length)
    expect(tasks.find((t) => t.template_key === 'book_venue')).toMatchObject({ due_date: '2027-06-10', assignee: 'planner', status: 'todo' })
    expect(tasks.find((t) => t.template_key === 'run_of_show')?.due_date).toBe('2028-06-03')
    expect(w.checklist.view(w.ctx, w.planner, w.ours).template_missing).toBe(0)
    // Removing a template task lets the template add it back, alone.
    w.checklist.removeTask(w.ctx, w.planner, w.ours, tasks[0]?.task_id as string)
    expect(w.checklist.applyTemplate(w.ctx, w.planner, w.ours)).toBe(1)
  })

  it('sorts overdue (before today) first, then upcoming (today or later), then done; today is the clock\'s', () => {
    const w = world()
    const add = (title: string, due_date: string) => w.checklist.addTask(w.ctx, w.planner, w.ours, { title, due_date, assignee: 'planner' })
    add('Yesterday', '2028-01-09')
    add('Today', '2028-01-10')
    add('Long ago', '2027-12-01')
    add('In a week', '2028-01-17')
    const done = add('Done one', '2027-11-01')
    w.checklist.setStatus(w.ctx, w.planner, w.ours, done.task_id, 'done')
    const view = w.checklist.view(w.ctx, w.planner, w.ours)
    expect(view.today).toBe('2028-01-10')
    expect(view.overdue.map((t) => t.title)).toEqual(['Long ago', 'Yesterday'])
    expect(view.upcoming.map((t) => t.title)).toEqual(['Today', 'In a week'])
    expect(view.done.map((t) => [t.title, t.completed_at])).toEqual([['Done one', '2028-01-10T12:00:00.000Z']])
    // Marking it done again keeps when it was done.
    w.clock.advance(60_000)
    expect(w.checklist.setStatus(w.ctx, w.planner, w.ours, done.task_id, 'done').completed_at).toBe('2028-01-10T12:00:00.000Z')
    w.clock.advance(-60_000)
    w.clock.advance(86_400_000)
    expect(w.checklist.view(w.ctx, w.planner, w.ours).overdue.map((t) => t.title)).toEqual(['Long ago', 'Yesterday', 'Today'])
  })

  it('the couple sees the tasks and ticks off its own; everything else is the planner\'s (403)', () => {
    const w = world()
    const mine = w.checklist.addTask(w.ctx, w.planner, w.ours, { title: 'Choose the cake', due_date: '2028-03-01', assignee: 'couple' })
    const plannerTask = w.checklist.addTask(w.ctx, w.planner, w.ours, { title: 'Book the band', due_date: '2028-02-01', assignee: 'planner' })
    expect(w.checklist.view(w.ctx, w.couple, w.ours).upcoming.map((t) => t.title)).toEqual(['Book the band', 'Choose the cake'])
    expect(w.checklist.setStatus(w.ctx, w.couple, w.ours, mine.task_id, 'done').status).toBe('done')
    expect(w.checklist.setStatus(w.ctx, w.couple, w.ours, mine.task_id, 'todo').completed_at).toBeUndefined()
    expect(codeOf(() => w.checklist.setStatus(w.ctx, w.couple, w.ours, plannerTask.task_id, 'done'))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.checklist.addTask(w.ctx, w.couple, w.ours, { title: 'X', due_date: '2028-03-01', assignee: 'couple' }))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.checklist.updateTask(w.ctx, w.couple, w.ours, mine.task_id, { title: 'X', due_date: '2028-03-01', assignee: 'couple' }))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.checklist.removeTask(w.ctx, w.couple, w.ours, mine.task_id))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.checklist.applyTemplate(w.ctx, w.couple, w.ours))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.checklist.shiftOpenTasks(w.ctx, w.couple, w.ours))).toBe('PRODUCT.FORBIDDEN')
    expect(codeOf(() => w.checklist.keepTaskDates(w.ctx, w.couple, w.ours))).toBe('PRODUCT.FORBIDDEN')
  })

  it('another wedding is the masked NOT_FOUND for the couple; a sibling wedding\'s task is not found here', () => {
    const w = world()
    const theirs = w.checklist.addTask(w.ctx, w.planner, w.theirs, { title: 'Theirs', due_date: '2028-03-01', assignee: 'couple' })
    expect(codeOf(() => w.checklist.view(w.ctx, w.couple, w.theirs))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.checklist.view(w.ctx, w.couple, 'wedding_missing'))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.checklist.setStatus(w.ctx, w.couple, w.theirs, theirs.task_id, 'done'))).toBe('PRODUCT.NOT_FOUND')
    expect(codeOf(() => w.checklist.setStatus(w.ctx, w.planner, w.ours, theirs.task_id, 'done'))).toBe('PRODUCT.NOT_FOUND')
    expect(w.checklist.removeTask(w.ctx, w.planner, w.ours, theirs.task_id)).toBe(false)
    expect(w.checklist.tasksOf(w.ctx, w.theirs).map((t) => t.status)).toEqual(['todo'])
  })

  it('shifts only the open tasks by the date move the server recorded, then forgets it; validates dates, titles and size', () => {
    const w = world({ tasks: 3 })
    const open = w.checklist.addTask(w.ctx, w.planner, w.ours, { title: 'Open', due_date: '2028-02-01', assignee: 'planner' })
    const done = w.checklist.addTask(w.ctx, w.planner, w.ours, { title: 'Done', due_date: '2028-01-01', assignee: 'planner' })
    w.checklist.setStatus(w.ctx, w.planner, w.ours, done.task_id, 'done')
    expect(codeOf(() => w.checklist.shiftOpenTasks(w.ctx, w.planner, w.ours))).toBe('PRODUCT.BAD_REQUEST') // nothing moved
    w.checklist.noteDateMoved(w.ctx, w.ours, '2028-06-10', '2028-06-17')
    w.checklist.noteDateMoved(w.ctx, w.ours, '2028-06-17', '2028-06-24') // a second move keeps the first date
    expect(w.checklist.view(w.ctx, w.couple, w.ours).date_move).toEqual({ from_date: '2028-06-10', to_date: '2028-06-24', days: 14 })
    expect(w.checklist.shiftOpenTasks(w.ctx, w.planner, w.ours)).toBe(1)
    const byId = new Map(w.checklist.tasksOf(w.ctx, w.ours).map((t) => [t.task_id, t.due_date]))
    expect([byId.get(open.task_id), byId.get(done.task_id)]).toEqual(['2028-02-15', '2028-01-01'])
    expect(w.checklist.view(w.ctx, w.planner, w.ours).date_move).toBeUndefined()
    // Keeping the dates forgets a move; a move back to the original date forgets it on its own.
    w.checklist.noteDateMoved(w.ctx, w.ours, '2028-06-24', '2028-07-01')
    expect(w.checklist.keepTaskDates(w.ctx, w.planner, w.ours)).toBe(true)
    w.checklist.noteDateMoved(w.ctx, w.ours, '2028-07-01', '2028-07-08')
    w.checklist.noteDateMoved(w.ctx, w.ours, '2028-07-08', '2028-07-01')
    expect(w.checklist.view(w.ctx, w.planner, w.ours).date_move).toBeUndefined()
    expect(codeOf(() => w.checklist.addTask(w.ctx, w.planner, w.ours, { title: 'X', due_date: '2028-02-30', assignee: 'planner' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOf(() => w.checklist.addTask(w.ctx, w.planner, w.ours, { title: 'A\nB', due_date: '2028-02-01', assignee: 'planner' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(w.checklist.addTask(w.ctx, w.planner, w.ours, { title: ' T ', notes: 'line one\nline two', due_date: '2028-02-01', assignee: 'planner' })).toMatchObject({ title: 'T', notes: 'line one\nline two' })
    expect(codeOf(() => w.checklist.addTask(w.ctx, w.planner, w.ours, { title: 'Fourth', due_date: '2028-02-01', assignee: 'planner' }))).toBe('PRODUCT.LIMIT_REACHED')
    expect(codeOf(() => w.checklist.applyTemplate(w.ctx, w.planner, w.ours))).toBe('PRODUCT.LIMIT_REACHED')
  })

  it('a wedding date that is not a real date is refused at the source, so the template never meets one', () => {
    const w = world()
    const wedding = w.weddings.get(w.ctx, w.ours)
    expect(wedding).toBeDefined()
    for (const event_date of ['2028-13-01', '2028-00-10', '2028-02-30']) {
      expect(codeOf(() => w.weddings.update(w.ctx, { ...(wedding as NonNullable<typeof wedding>), event_date }))).toBe('PRODUCT.BAD_REQUEST')
      expect(codeOf(() => w.weddings.create(w.ctx, { couple_display_name: 'X', event_date }))).toBe('PRODUCT.BAD_REQUEST')
    }
  })
})
