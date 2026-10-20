import { type Clock, getSchemaRegistry, type IdGenerator, type Wedding, type WeddingTask } from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import { COLLECTIONS } from '../persistence/collections'
import { groupedKey, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import { assertWeddingReach } from '../wedding/wedding_reach'
import type { WeddingRepository } from '../wedding/wedding_repository'
import { CHECKLIST_TEMPLATE, type ChecklistTemplateItem, dateBefore, shiftDate } from './checklist_template'

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

/** Bounds on one wedding's checklist; a shift moves tasks by at most ten years either way. */
export const CHECKLIST_LIMITS = Object.freeze({ tasks: 300, shift_days: 3650 })

export type TaskStatus = WeddingTask['status']
export type TaskAssignee = WeddingTask['assignee']

export interface TaskInput {
  readonly title: string
  readonly notes?: string
  /** YYYY-MM-DD. */
  readonly due_date: string
  readonly assignee: TaskAssignee
}

/** A wedding's checklist as the page shows it: overdue first (oldest first), then upcoming (soonest first), then done. */
export interface ChecklistView {
  /** The injected clock's date (YYYY-MM-DD). */
  readonly today: string
  readonly overdue: readonly WeddingTask[]
  readonly upcoming: readonly WeddingTask[]
  readonly done: readonly WeddingTask[]
  /** How many template items are not on the checklist yet. */
  readonly template_missing: number
}

export class ChecklistService {
  readonly #tasks: TenantScopedRepository<WeddingTask>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
    private readonly limits: { readonly tasks: number; readonly shift_days: number } = CHECKLIST_LIMITS,
    private readonly template: readonly ChecklistTemplateItem[] = CHECKLIST_TEMPLATE,
  ) {
    this.#tasks = new TenantScopedRepository<WeddingTask>(liveness, (t) => groupedKey(t.wedding_id, t.task_id), COLLECTIONS.weddingTask, store)
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
    return {
      today,
      overdue: open.filter((t) => t.due_date < today),
      upcoming: open.filter((t) => t.due_date >= today),
      done: tasks.filter((t) => t.status === 'done'),
      template_missing: this.template.filter((item) => !keys.has(item.key)).length,
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
      ...(status === 'done' ? { completed_at: this.clock.now() } : {}),
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

  /** Move every task that is not done by `days` (the wedding date moved). Returns how many moved. */
  shiftOpenTasks(context: TenantContext, principal: Principal, wedding_id: string, days: number): number {
    this.assertReach(context, principal, wedding_id)
    this.#planner(principal)
    if (!Number.isInteger(days) || Math.abs(days) > this.limits.shift_days) {
      throw new ProductError('PRODUCT.BAD_REQUEST', `A shift is a whole number of days, at most ${this.limits.shift_days} either way.`, {})
    }
    const open = this.tasksOf(context, wedding_id).filter((t) => t.status === 'todo')
    if (days === 0) return 0
    for (const task of open) this.#put(context, { ...task, due_date: shiftDate(task.due_date, days), updated_at: this.clock.now() })
    return open.length
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
  // A title is one line; notes may break lines, but hold no other control character.
  const control = (value: string, allowLines: boolean) =>
    [...value].some((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) && !(allowLines && (c === '\n' || c === '\r' || c === '\t')))
  if (control(input.title, false) || control(input.notes ?? '', true)) {
    throw new ProductError('PRODUCT.BAD_REQUEST', 'A task may not hold control characters.', {})
  }
  const notes = input.notes?.trim()
  return {
    title: input.title.trim(),
    ...(notes === undefined || notes.length === 0 ? {} : { notes }),
    due_date: input.due_date,
    assignee: input.assignee,
  }
}

/** Whether `value` is a real date, YYYY-MM-DD. */
export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
