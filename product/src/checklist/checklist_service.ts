import { type ChecklistDateMove, type Clock, getSchemaRegistry, type IdGenerator, type Wedding, type WeddingTask } from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import { COLLECTIONS } from '../persistence/collections'
import { groupedKey, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import { assertPlainText } from '../text/plain_text'
import { isDate } from '../wedding/calendar_date'
import { assertWeddingReach } from '../wedding/wedding_reach'
import type { WeddingRepository } from '../wedding/wedding_repository'
import { CHECKLIST_TEMPLATE, type ChecklistTemplateItem, dateBefore, daysBetween, shiftDate } from './checklist_template'

/**
 * @canonical checklist_service -- a wedding's checklist (issue #31, ADR 0050): tasks with a due date and an assignee,
 * from the built-in template or by hand.
 *
 * The boundary is the wedding's (`assertWeddingReach`): the planner and the wedding's couple see its tasks; anything
 * else is the masked PRODUCT.NOT_FOUND. The planner manages them (add, edit, remove, apply the template, shift the
 * open ones when the date moves); the couple marks done (or not) the tasks assigned to the couple. Anything else a
 * couple asks is PRODUCT.FORBIDDEN — an honest 403 on its own wedding, never an existence signal.
 *
 * "Today" is the injected clock's UTC date, so overdue and due-soon are deterministic and testable at the edges.
 *
 * related: checklist_template.ts (the template and the date arithmetic), wedding_task_schema.json (the contract).
 */

/** Bounds on one wedding's checklist. */
export const CHECKLIST_LIMITS = Object.freeze({ tasks: 300 })

export type TaskStatus = WeddingTask['status']
export type TaskAssignee = WeddingTask['assignee']

export interface TaskInput {
  readonly title: string
  readonly notes?: string
  /** YYYY-MM-DD. */
  readonly due_date: string
  readonly assignee: TaskAssignee
}

/** A task as the morning view lists it: what, when, whose — nothing else (no notes). */
export type DueTask = Pick<WeddingTask, 'task_id' | 'title' | 'due_date' | 'assignee'>

/** One wedding's part of the planner's morning view (issue #32). */
export interface DueWedding {
  readonly wedding_id: string
  readonly couple_display_name: string
  readonly event_date: string
  /** Not done and due before today, oldest first (at most {@link DUE_LISTED_PER_WEDDING}). */
  readonly overdue: readonly DueTask[]
  /** Not done and due from today to today + 7 days (inclusive), soonest first (at most the same). */
  readonly due_soon: readonly DueTask[]
  /** How many more are due than listed here (they are all on the wedding's checklist). */
  readonly more: number
}

/** The planner's morning view across weddings (issue #32): what is overdue and what is due within a week. */
export interface DueAcrossWeddings {
  readonly today: string
  /** The last day counted as "this week": today + 7 days. */
  readonly horizon: string
  readonly overdue: number
  readonly due_soon: number
  /** Only weddings with something due; the most urgent wedding first. */
  readonly weddings: readonly DueWedding[]
}

/** How far ahead "due this week" looks, in days (inclusive). */
export const DUE_SOON_DAYS = 7

/** How many tasks the morning view lists per wedding (the counts include every one). */
export const DUE_LISTED_PER_WEDDING = 10

/** A wedding's checklist as the page shows it: overdue first (oldest first), then upcoming (soonest first), then done. */
export interface ChecklistView {
  /** The injected clock's date (YYYY-MM-DD). */
  readonly today: string
  readonly overdue: readonly WeddingTask[]
  readonly upcoming: readonly WeddingTask[]
  readonly done: readonly WeddingTask[]
  /** How many template items are not on the checklist yet. */
  readonly template_missing: number
  /** The wedding date moved since the open tasks were scheduled (server data): the planner may move them by `days`. */
  readonly date_move?: { readonly from_date: string; readonly to_date: string; readonly days: number }
}

export class ChecklistService {
  readonly #tasks: TenantScopedRepository<WeddingTask>
  readonly #moves: TenantScopedRepository<ChecklistDateMove>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
    private readonly limits: { readonly tasks: number } = CHECKLIST_LIMITS,
    private readonly template: readonly ChecklistTemplateItem[] = CHECKLIST_TEMPLATE,
  ) {
    this.#tasks = new TenantScopedRepository<WeddingTask>(liveness, (t) => groupedKey(t.wedding_id, t.task_id), COLLECTIONS.weddingTask, store)
    this.#moves = new TenantScopedRepository<ChecklistDateMove>(liveness, (m) => m.wedding_id, COLLECTIONS.checklistDateMove, store)
  }

  /** The wedding's boundary alone (the HTTP edge calls it before parsing a body). */
  assertReach(context: TenantContext, principal: Principal, wedding_id: string): Wedding {
    return assertWeddingReach(this.authorizer, this.weddings, context, principal, wedding_id)
  }

  /** Today, by the injected clock (YYYY-MM-DD, UTC). */
  today(): string {
    return this.clock.now().slice(0, 10)
  }

  view(context: TenantContext, principal: Principal, wedding_id: string): ChecklistView {
    this.assertReach(context, principal, wedding_id)
    const today = this.today()
    const tasks = this.tasksOf(context, wedding_id)
    const open = tasks.filter((t) => t.status === 'todo')
    const keys = new Set(tasks.flatMap((t) => (t.template_key === undefined ? [] : [t.template_key])))
    const move = this.#move(context, wedding_id)
    return {
      today,
      overdue: open.filter((t) => t.due_date < today),
      upcoming: open.filter((t) => t.due_date >= today),
      done: tasks.filter((t) => t.status === 'done'),
      template_missing: this.template.filter((item) => !keys.has(item.key)).length,
      ...(move === undefined || open.length === 0 ? {} : { date_move: { from_date: move.from_date, to_date: move.to_date, days: daysBetween(move.from_date, move.to_date) } }),
    }
  }

  /**
   * The planner's morning question (issue #32): across the workspace's planning and active weddings, every task not
   * done that is overdue or due within {@link DUE_SOON_DAYS} days, grouped by wedding, the most urgent first. Planner
   * only — a couple gets PRODUCT.FORBIDDEN and never another wedding's tasks. Each wedding is read on its own
   * (`tasksOf`), never a tenant-wide list of tasks.
   */
  dueAcrossWeddings(context: TenantContext, principal: Principal): DueAcrossWeddings {
    // The canonical "sees every wedding" rule, which also refuses a principal the session store did not mint.
    if (this.authorizer.listScope(principal).kind !== 'all') this.#planner(principal)
    const today = this.today()
    const horizon = shiftDate(today, DUE_SOON_DAYS)
    const weddings = this.weddings
      .list(context)
      .filter((w) => w.status === 'planning' || w.status === 'active')
      .flatMap((wedding): (DueWedding & { readonly counts: { readonly overdue: number; readonly due_soon: number } })[] => {
        const due = this.tasksOf(context, wedding.wedding_id).filter((t) => t.status === 'todo' && t.due_date <= horizon)
        if (due.length === 0) return []
        const listed = due.slice(0, DUE_LISTED_PER_WEDDING).map((t) => ({ task_id: t.task_id, title: t.title, due_date: t.due_date, assignee: t.assignee }))
        const overdue = due.filter((t) => t.due_date < today).length
        return [
          {
            wedding_id: wedding.wedding_id,
            couple_display_name: wedding.couple_display_name,
            event_date: wedding.event_date,
            overdue: listed.filter((t) => t.due_date < today),
            due_soon: listed.filter((t) => t.due_date >= today),
            more: due.length - listed.length,
            counts: { overdue, due_soon: due.length - overdue },
          },
        ]
      })
      .sort((a, b) => {
        const first = (w: DueWedding) => (w.overdue[0] ?? w.due_soon[0])?.due_date ?? ''
        return first(a) === first(b) ? a.couple_display_name.localeCompare(b.couple_display_name) : first(a) < first(b) ? -1 : 1
      })
    return {
      today,
      horizon,
      overdue: weddings.reduce((n, w) => n + w.counts.overdue, 0),
      due_soon: weddings.reduce((n, w) => n + w.counts.due_soon, 0),
      weddings: weddings.map(({ counts: _counts, ...wedding }) => wedding),
    }
  }

  /** Every task of the wedding, by due date then title. No boundary check: callers have established reach. */
  tasksOf(context: TenantContext, wedding_id: string): WeddingTask[] {
    return this.#tasks
      .listGroup(context, wedding_id)
      .filter((t) => t.wedding_id === wedding_id)
      .sort((a, b) => (a.due_date === b.due_date ? a.title.localeCompare(b.title) : a.due_date < b.due_date ? -1 : 1))
  }

  /** Add the template's items that are not on the checklist yet, due before the wedding date. Returns how many. */
  applyTemplate(context: TenantContext, principal: Principal, wedding_id: string): number {
    const wedding = this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    const tasks = this.tasksOf(context, wedding_id)
    const keys = new Set(tasks.flatMap((t) => (t.template_key === undefined ? [] : [t.template_key])))
    const missing = this.template.filter((item) => !keys.has(item.key))
    if (tasks.length + missing.length > this.limits.tasks) this.#limit()
    for (const item of missing) {
      this.#put(context, {
        task_id: this.ids.next('task'),
        tenant_id: context.tenant_id,
        wedding_id,
        title: item.title,
        due_date: dateBefore(wedding.event_date, item.before),
        assignee: item.assignee,
        status: 'todo',
        template_key: item.key,
        created_at: this.clock.now(),
      })
    }
    return missing.length
  }

  addTask(context: TenantContext, principal: Principal, wedding_id: string, input: TaskInput): WeddingTask {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    if (this.tasksOf(context, wedding_id).length >= this.limits.tasks) this.#limit()
    return this.#put(context, {
      task_id: this.ids.next('task'),
      tenant_id: context.tenant_id,
      wedding_id,
      ...fields(input),
      status: 'todo',
      created_at: this.clock.now(),
    })
  }

  updateTask(context: TenantContext, principal: Principal, wedding_id: string, task_id: string, input: TaskInput): WeddingTask {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    const existing = this.#task(context, wedding_id, task_id)
    return this.#put(context, {
      task_id: existing.task_id,
      tenant_id: existing.tenant_id,
      wedding_id: existing.wedding_id,
      ...fields(input),
      status: existing.status,
      ...(existing.template_key === undefined ? {} : { template_key: existing.template_key }),
      ...(existing.completed_at === undefined ? {} : { completed_at: existing.completed_at }),
      created_at: existing.created_at,
      updated_at: this.clock.now(),
    })
  }

  /** Mark a task done or not done: the planner any task, the couple only the tasks assigned to the couple. */
  setStatus(context: TenantContext, principal: Principal, wedding_id: string, task_id: string, status: TaskStatus): WeddingTask {
    this.assertReach(context, principal, wedding_id)
    const existing = this.#task(context, wedding_id, task_id)
    if (principal.role !== 'planner' && existing.assignee !== 'couple') {
      throw new ProductError('PRODUCT.FORBIDDEN', 'The couple completes only the tasks assigned to them.', {})
    }
    return this.#put(context, {
      task_id: existing.task_id,
      tenant_id: existing.tenant_id,
      wedding_id: existing.wedding_id,
      title: existing.title,
      ...(existing.notes === undefined ? {} : { notes: existing.notes }),
      due_date: existing.due_date,
      assignee: existing.assignee,
      status,
      ...(existing.template_key === undefined ? {} : { template_key: existing.template_key }),
      ...(status === 'done' ? { completed_at: existing.completed_at ?? this.clock.now() } : {}),
      created_at: existing.created_at,
      updated_at: this.clock.now(),
    })
  }

  /** Remove a task. Returns whether it existed. */
  removeTask(context: TenantContext, principal: Principal, wedding_id: string, task_id: string): boolean {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    if (task_id.length === 0 || this.#tasks.read(context, groupedKey(wedding_id, task_id))?.wedding_id !== wedding_id) return false
    return this.#tasks.delete(context, groupedKey(wedding_id, task_id))
  }

  /**
   * The wedding's date changed (the API calls this after its own reach-checked update): remember where the open tasks
   * were scheduled from, so the planner is offered to move them. A second move keeps the first date; a move back
   * forgets it.
   */
  noteDateMoved(context: TenantContext, wedding_id: string, from_date: string, to_date: string): void {
    if (from_date === to_date) return
    const earlier = this.#move(context, wedding_id)
    const from = earlier?.from_date ?? from_date
    if (from === to_date) {
      this.#moves.delete(context, wedding_id)
      return
    }
    const move: ChecklistDateMove = { tenant_id: context.tenant_id, wedding_id, from_date: from, to_date, noted_at: this.clock.now() }
    getSchemaRegistry().assertValid<ChecklistDateMove>('checklist_date_move', move)
    this.#moves.put(context, move)
  }

  /** Move every task that is not done by the recorded date move, and forget the move. Returns how many moved. */
  shiftOpenTasks(context: TenantContext, principal: Principal, wedding_id: string): number {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    const move = this.#move(context, wedding_id)
    if (move === undefined) throw new ProductError('PRODUCT.BAD_REQUEST', 'The wedding date has not moved since the tasks were scheduled.', {})
    const days = daysBetween(move.from_date, move.to_date)
    const open = this.tasksOf(context, wedding_id).filter((t) => t.status === 'todo')
    for (const task of open) this.#put(context, { ...task, due_date: shiftDate(task.due_date, days), updated_at: this.clock.now() })
    this.#moves.delete(context, wedding_id)
    return open.length
  }

  /** Keep the open tasks' dates after the wedding date moved (forget the move). Returns whether one was pending. */
  keepTaskDates(context: TenantContext, principal: Principal, wedding_id: string): boolean {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    return this.#moves.delete(context, wedding_id)
  }

  #move(context: TenantContext, wedding_id: string): ChecklistDateMove | undefined {
    const move = this.#moves.read(context, wedding_id)
    return move?.wedding_id === wedding_id && isDate(move.from_date) && isDate(move.to_date) ? move : undefined
  }

  #put(context: TenantContext, task: WeddingTask): WeddingTask {
    getSchemaRegistry().assertValid<WeddingTask>('wedding_task', task)
    return this.#tasks.put(context, task)
  }

  #task(context: TenantContext, wedding_id: string, task_id: string): WeddingTask {
    const task = task_id.length === 0 ? undefined : this.#tasks.read(context, groupedKey(wedding_id, task_id))
    if (task === undefined || task.wedding_id !== wedding_id) throw new ProductError('PRODUCT.NOT_FOUND', 'No such task on this wedding.', {})
    return task
  }

  #planner(principal: Principal): void {
    if (principal.role !== 'planner') throw new ProductError('PRODUCT.FORBIDDEN', 'Only the planner manages the checklist.', {})
  }

  #limit(): never {
    throw new ProductError('PRODUCT.LIMIT_REACHED', 'This wedding has reached the checklist limit.', {})
  }
}

/** The editable fields, normalized; the due date must be a real date. */
function fields(input: TaskInput): Pick<WeddingTask, 'title' | 'due_date' | 'assignee'> & { notes?: string } {
  if (!isDate(input.due_date)) throw new ProductError('PRODUCT.BAD_REQUEST', 'due_date must be a date (YYYY-MM-DD).', {})
  // A title is one line; notes may break lines.
  assertPlainText([input.title])
  assertPlainText([input.notes], { multiline: true })
  const notes = input.notes?.trim()
  return {
    title: input.title.trim(),
    ...(notes === undefined || notes.length === 0 ? {} : { notes }),
    due_date: input.due_date,
    assignee: input.assignee,
  }
}
