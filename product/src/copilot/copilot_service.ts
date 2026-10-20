import { type Clock, type CopilotDraft, type CopilotDraftOutput, getSchemaRegistry, type Job } from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import type { ChecklistService } from '../checklist/checklist_service'
import type { JobKind, JobQueue } from '../jobs/job_queue'
import { defineModelTask } from '../model/model_port'
import type { ModelService } from '../model/model_service'
import { COLLECTIONS } from '../persistence/collections'
import type { RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { RunOfShowService } from '../run_of_show/run_of_show_service'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import { assertPlainText } from '../text/plain_text'
import type { VendorService } from '../vendors/vendor_service'
import { isDate } from '../wedding/calendar_date'
import { isLocalDateTime, type WeddingEventService } from '../wedding_events/wedding_event_service'
import { assertWeddingReach } from '../wedding/wedding_reach'
import type { WeddingRepository } from '../wedding/wedding_repository'
import type { CopilotDraftInput } from './copilot_simulation'

/**
 * @canonical copilot_service -- the planner copilot (issue #61, ADR 0058): a first checklist and a draft run of show,
 * proposed from what a wedding already knows, kept or not by the planner.
 *
 * The planner asks for a draft; the request enqueues a model job (job_queue.ts) and the page says "drafting". The
 * job reads the wedding fresh — its date, events, vendors (by category, no names) and what is already on the
 * checklist and run of show — asks the model ({@link COPILOT_DRAFT}), and checks the answer against the wedding before
 * anyone sees it:
 *   - a task is due on a real date, from today up to the wedding date;
 *   - an item starts at a real local time within a day of the wedding's events, and names a vendor or event only by a
 *     position in the list the job sent (mapped back to ids here — the model never supplies an id);
 *   - text is plain, titles are new, and each list is bounded ({@link COPILOT_LIMITS}).
 * Anything else is dropped. Nothing is on the checklist or the run of show until the planner accepts it, through
 * those services, so their limits, validation and boundaries apply. The planner only; the couple sees only what is
 * accepted.
 *
 * related: copilot_simulation.ts (the simulated model's answer), model_service.ts, checklist_service.ts,
 * run_of_show_service.ts.
 */

export const COPILOT_LIMITS = Object.freeze({ tasks: 40, items: 40 })

/** The copilot's task: defined once, here. */
export const COPILOT_DRAFT = defineModelTask<CopilotDraftOutput>({
  task: 'copilot_draft',
  instructions:
    'You help a wedding planner. From the wedding in the input, propose checklist tasks (title, due date on or before the wedding, ' +
    'planner or couple) and run-of-show items (title, local start time, owner) for its events and vendors. Name a vendor or an event ' +
    'only by its index in the input. Leave out anything whose title is already listed as existing.',
  output_contract: 'copilot_draft_output',
})

/** The job kind's name. */
export const COPILOT_JOB = 'copilot_draft'

/** What the copilot page shows: the draft, and the names its vendor and event ids stand for (the planner's view). */
export interface CopilotView {
  readonly draft?: CopilotDraft
  readonly vendors: readonly { readonly vendor_id: string; readonly business_name: string }[]
  readonly events: readonly { readonly event_id: string; readonly name: string }[]
}

export interface CopilotAcceptance {
  /** The draft the planner looked at (its `requested_at`): keeping from a draft that has changed since is refused. */
  readonly draft: string
  readonly task_ids: readonly string[]
  readonly item_ids: readonly string[]
}

export interface CopilotAcceptResult {
  readonly added_tasks: number
  readonly added_items: number
  /** Items left out because their vendor or event is no longer on the wedding. */
  readonly skipped: number
}

/** The checked draft a job produces (ids mapped back from positions). */
interface CheckedDraft {
  readonly tasks: readonly { readonly title: string; readonly due_date: string; readonly assignee: 'planner' | 'couple' }[]
  readonly run_of_show: readonly { readonly title: string; readonly starts_at: string; readonly owner: 'planner' | 'couple' | 'vendor'; readonly vendor_id?: string; readonly event_id?: string }[]
}

export class CopilotService {
  readonly #drafts: TenantScopedRepository<CopilotDraft>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly events: Pick<WeddingEventService, 'eventsOf'>,
    private readonly vendors: Pick<VendorService, 'vendorsOf'>,
    private readonly checklist: Pick<ChecklistService, 'tasksOf' | 'addTask'>,
    private readonly runOfShow: Pick<RunOfShowService, 'itemsOf' | 'addItem'>,
    private readonly model: Pick<ModelService, 'run'>,
    private readonly jobs: Pick<JobQueue, 'enqueue'>,
    private readonly clock: Clock,
    store?: RecordStore,
  ) {
    this.#drafts = new TenantScopedRepository<CopilotDraft>(liveness, (d) => d.wedding_id, COLLECTIONS.copilotDraft, store)
  }

  /** The wedding's boundary, then the planner's capability (the HTTP edge calls it before parsing a body). */
  assertPlanner(context: TenantContext, principal: Principal, wedding_id: string): void {
    assertWeddingReach(this.authorizer, this.weddings, context, principal, wedding_id)
    if (principal.role !== 'planner') throw new ProductError('PRODUCT.FORBIDDEN', 'Only the planner uses the copilot.', {})
  }

  /** The wedding's draft, if any, with the names its ids stand for. */
  view(context: TenantContext, principal: Principal, wedding_id: string): CopilotView {
    this.assertPlanner(context, principal, wedding_id)
    const draft = this.#draft(context, wedding_id)
    return {
      ...(draft === undefined ? {} : { draft }),
      vendors: this.vendors.vendorsOf(context, wedding_id).map((v) => ({ vendor_id: v.vendor_id, business_name: v.business_name })),
      events: this.events.eventsOf(context, wedding_id).map((e) => ({ event_id: e.event_id, name: e.name })),
    }
  }

  /** Ask for a draft: a job, and the draft marked drafting. While one is drafting, asking again changes nothing. */
  request(context: TenantContext, principal: Principal, wedding_id: string): CopilotDraft {
    this.assertPlanner(context, principal, wedding_id)
    // The queue keeps one live job per wedding, so this is the running job when one is drafting already.
    this.jobs.enqueue(context, COPILOT_JOB, wedding_id, principal.principal_id)
    const existing = this.#draft(context, wedding_id)
    if (existing?.status === 'drafting') return existing
    return this.#put(context, {
      tenant_id: context.tenant_id,
      wedding_id,
      status: 'drafting',
      requested_at: this.clock.now(),
      requested_by: principal.principal_id,
      tasks: [],
      run_of_show: [],
    })
  }

  /** Keep some of the draft: each through its service. Kept items leave the draft; the rest stay. */
  accept(context: TenantContext, principal: Principal, wedding_id: string, acceptance: CopilotAcceptance): CopilotAcceptResult {
    this.assertPlanner(context, principal, wedding_id)
    if (acceptance.task_ids.length > COPILOT_LIMITS.tasks || acceptance.item_ids.length > COPILOT_LIMITS.items) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'That keeps more than a draft holds.', {})
    }
    const draft = this.#draft(context, wedding_id)
    if (draft === undefined || draft.status !== 'ready') throw new ProductError('PRODUCT.BAD_REQUEST', 'There is no draft ready to keep.', {})
    // Draft ids restart with each draft: a form from an earlier one (another tab, a teammate's "Draft again") would keep
    // items the planner never saw.
    if (acceptance.draft !== draft.requested_at) throw new ProductError('PRODUCT.DRAFT_CHANGED', 'The draft has changed since; look again.', {})
    const taskIds = new Set(acceptance.task_ids)
    const itemIds = new Set(acceptance.item_ids)
    const vendorIds = new Set(this.vendors.vendorsOf(context, wedding_id).map((v) => v.vendor_id))
    const eventIds = new Set(this.events.eventsOf(context, wedding_id).map((e) => e.event_id))
    let added_tasks = 0
    let added_items = 0
    let skipped = 0
    for (const task of draft.tasks.filter((t) => taskIds.has(t.draft_id))) {
      this.checklist.addTask(context, principal, wedding_id, { title: task.title, due_date: task.due_date, assignee: task.assignee })
      added_tasks += 1
    }
    for (const item of draft.run_of_show.filter((i) => itemIds.has(i.draft_id))) {
      if ((item.vendor_id !== undefined && !vendorIds.has(item.vendor_id)) || (item.event_id !== undefined && !eventIds.has(item.event_id))) {
        skipped += 1
        continue
      }
      this.runOfShow.addItem(context, principal, wedding_id, {
        title: item.title,
        starts_at: item.starts_at,
        owner: item.owner,
        ...(item.vendor_id === undefined ? {} : { owner_vendor_id: item.vendor_id }),
        ...(item.event_id === undefined ? {} : { event_id: item.event_id }),
      })
      added_items += 1
    }
    this.#put(context, {
      ...draft,
      tasks: draft.tasks.filter((t) => !taskIds.has(t.draft_id)),
      run_of_show: draft.run_of_show.filter((i) => !itemIds.has(i.draft_id)),
      updated_at: this.clock.now(),
    })
    return { added_tasks, added_items, skipped }
  }

  /** Throw the draft away (a drafting job then writes nothing). Returns whether there was one. */
  discard(context: TenantContext, principal: Principal, wedding_id: string): boolean {
    this.assertPlanner(context, principal, wedding_id)
    return this.#drafts.delete(context, wedding_id)
  }

  /** The job kind the queue runs for a draft. */
  jobKind(): JobKind<CheckedDraft> {
    return {
      kind: COPILOT_JOB,
      // A draft discarded (or no longer drafting) before the job ran: the model is not called.
      wanted: (context, job) => this.#draft(context, job.subject_id)?.status === 'drafting',
      execute: (context, job) => this.#execute(context, job),
      complete: (context, job, result) => {
        const draft = this.#draft(context, job.subject_id)
        // Discarded, or replaced since it was asked for: nothing to write.
        if (draft === undefined || draft.status !== 'drafting') return
        this.#put(context, {
          ...draft,
          status: 'ready',
          tasks: result.tasks.map((t, n) => ({ draft_id: `t${n}`, ...t })),
          run_of_show: result.run_of_show.map((i, n) => ({ draft_id: `r${n}`, ...i })),
          updated_at: this.clock.now(),
        })
      },
      failed: (context, job) => {
        const draft = this.#draft(context, job.subject_id)
        if (draft?.status === 'drafting') this.#put(context, { ...draft, status: 'failed', updated_at: this.clock.now() })
      },
    }
  }

  /** Read the wedding fresh, ask the model, and check the answer against what was sent. */
  async #execute(context: TenantContext, job: Job): Promise<CheckedDraft> {
    const wedding_id = job.subject_id
    const wedding = this.weddings.get(context, wedding_id)
    if (wedding === undefined) throw new ProductError('PRODUCT.NOT_FOUND', 'The wedding is gone.', {})
    const events = this.events.eventsOf(context, wedding_id)
    const vendors = this.vendors.vendorsOf(context, wedding_id)
    const input: CopilotDraftInput = {
      event_date: wedding.event_date,
      today: this.clock.now().slice(0, 10),
      events: events.map((e) => ({ name: e.name, starts_at: e.starts_at })),
      vendors: vendors.map((v) => ({ category: v.category })),
      existing_task_titles: this.checklist.tasksOf(context, wedding_id).map((t) => t.title),
      existing_item_titles: this.runOfShow.itemsOf(context, wedding_id).map((i) => i.title),
    }
    const output = await this.model.run(context, COPILOT_DRAFT, input as unknown as Readonly<Record<string, unknown>>)
    return checkDraft(output, input, events.map((e) => e.event_id), vendors.map((v) => v.vendor_id))
  }

  #draft(context: TenantContext, wedding_id: string): CopilotDraft | undefined {
    const draft = this.#drafts.read(context, wedding_id)
    return draft?.wedding_id === wedding_id ? draft : undefined
  }

  #put(context: TenantContext, draft: CopilotDraft): CopilotDraft {
    getSchemaRegistry().assertValid<CopilotDraft>('copilot_draft', draft)
    return this.#drafts.put(context, draft)
  }
}

/**
 * The model's answer checked against the input it was given (the second check, after the contract): what fails is
 * dropped; positions become the ids of the lists the job sent.
 */
export function checkDraft(output: CopilotDraftOutput, input: CopilotDraftInput, eventIds: readonly string[], vendorIds: readonly string[]): CheckedDraft {
  const seen = new Set([...input.existing_task_titles, ...input.existing_item_titles].map((t) => t.trim().toLowerCase()))
  const fresh = (title: string): boolean => {
    try {
      assertPlainText([title])
    } catch {
      return false
    }
    const key = title.trim().toLowerCase()
    if (key.length === 0 || seen.has(key)) return false
    seen.add(key)
    return true
  }
  // Bounded before any per-item work: a model's answer could be longer than asked.
  const tasks = output.tasks
    .slice(0, 4 * COPILOT_LIMITS.tasks)
    .filter((t) => isDate(t.due_date) && t.due_date >= input.today && t.due_date <= input.event_date && fresh(t.title))
    .slice(0, COPILOT_LIMITS.tasks)
    .map((t) => ({ title: t.title.trim(), due_date: t.due_date, assignee: t.assignee }))
  const days = [input.event_date, ...input.events.map((e) => e.starts_at.slice(0, 10))]
  const earliest = shift(days.reduce((a, b) => (a < b ? a : b)), -1)
  const latest = shift(days.reduce((a, b) => (a > b ? a : b)), 1)
  const run_of_show = output.run_of_show
    .slice(0, 4 * COPILOT_LIMITS.items)
    .filter((i) => {
      if (!isLocalDateTime(i.starts_at) || i.starts_at.slice(0, 10) < earliest || i.starts_at.slice(0, 10) > latest) return false
      if (i.event_index !== undefined && i.event_index >= eventIds.length) return false
      if (i.vendor_index !== undefined && i.vendor_index >= vendorIds.length) return false
      if (i.owner === 'vendor' && i.vendor_index === undefined) return false
      return fresh(i.title)
    })
    .slice(0, COPILOT_LIMITS.items)
    .map((i) => {
      const vendor_id = i.owner === 'vendor' && i.vendor_index !== undefined ? vendorIds[i.vendor_index] : undefined
      const event_id = i.event_index === undefined ? undefined : eventIds[i.event_index]
      return {
        title: i.title.trim(),
        starts_at: i.starts_at,
        owner: i.owner,
        ...(vendor_id === undefined ? {} : { vendor_id }),
        ...(event_id === undefined ? {} : { event_id }),
      }
    })
  return { tasks, run_of_show }
}

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10)
}
