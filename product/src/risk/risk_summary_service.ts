import { type Clock, getSchemaRegistry, type Job, type RiskSummary, type RiskSummaryOutput } from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import type { ChecklistService } from '../checklist/checklist_service'
import type { GuestDirectory } from '../guests/guest_directory'
import type { JobKind, JobQueue } from '../jobs/job_queue'
import { defineModelTask } from '../model/model_port'
import type { ModelService } from '../model/model_service'
import { COLLECTIONS } from '../persistence/collections'
import type { RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { SeatingService } from '../seating/seating_service'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import type { VendorService } from '../vendors/vendor_service'
import type { WeddingEventService } from '../wedding_events/wedding_event_service'
import { assertWeddingReach } from '../wedding/wedding_reach'
import type { WeddingRepository } from '../wedding/wedding_repository'
import { computeRiskSignals, isoWeek, renderRiskLine, RISK_URGENCY, type RiskSignals } from './risk_signals'

/**
 * @canonical risk_summary_service -- each wedding's weekly "what is at risk" summary (issue #62, ADR 0060), the planner's
 * only.
 *
 * When the planner reads a wedding (or the home page across weddings) and this ISO week has no summary yet, a
 * `risk_summary` job is enqueued — reading a stale summary asks for this week's (idempotent: one live job per wedding).
 * The job reads the wedding fresh and computes its signals (risk_signals.ts); the model ({@link RISK_SUMMARY}) answers
 * with a level and the signals to mention; the second check keeps only signals the job computed and makes the level
 * honest (`on_track` exactly when there is no signal); each line is worded from its signal's own data. So the summary
 * states no fact the signals do not hold. The summary is replaced each week; the couple never sees it.
 *
 * related: risk_signals.ts (the signals and the wording), risk_simulation.ts (the simulated model), job_queue.ts.
 */

/** The summary's task: defined once, here. */
export const RISK_SUMMARY = defineModelTask<RiskSummaryOutput>({
  task: 'risk_summary',
  instructions:
    "You review one wedding's planning signals for the week. Give a level (on_track, watch or at_risk) and the keys of the signals " +
    'worth mentioning, most urgent first (at most four). Mention only signals in the input.',
  output_contract: 'risk_summary_output',
})

/** The job kind's name. */
export const RISK_JOB = 'risk_summary'

/** The most weddings the overview covers (the soonest first). */
export const RISK_OVERVIEW_LIMIT = 50

/** The most lines one summary carries. */
export const MAX_RISK_LINES = 4

/** After a summary fails to be written, how long reads wait before asking again (a failing model is not hammered). */
export const RISK_RETRY_COOLDOWN_MS = 60 * 60_000

export interface RiskView {
  /** This week's summary, once written. */
  readonly summary?: RiskSummary
  /** True while this week's summary is being written. */
  readonly preparing: boolean
  /** True when this week's summary could not be written lately (it is asked for again after a cooldown). */
  readonly unavailable?: boolean
  /** True for a wedding no longer planned (cancelled or completed): nothing is summarized. */
  readonly untracked?: boolean
}

export interface RiskOverview {
  readonly week: string
  readonly weddings: readonly { readonly wedding_id: string; readonly couple_display_name: string; readonly event_date: string; readonly summary?: RiskSummary }[]
  /** Upcoming weddings beyond the {@link RISK_OVERVIEW_LIMIT} soonest, not covered. */
  readonly more: number
}

/** What a job produced, for its completion to store. */
interface WrittenSummary {
  readonly week: string
  readonly level: RiskSummary['level']
  readonly lines: readonly string[]
}

export class RiskSummaryService {
  readonly #summaries: TenantScopedRepository<RiskSummary>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly weddings: WeddingRepository,
    private readonly authorizer: WeddingAuthorizer,
    private readonly checklist: Pick<ChecklistService, 'tasksOf'>,
    private readonly vendors: Pick<VendorService, 'vendorsOf'>,
    private readonly events: Pick<WeddingEventService, 'eventsOf' | 'statusesFor' | 'rsvpsClosed'>,
    private readonly guests: Pick<GuestDirectory, 'guestsOf' | 'householdsOf'>,
    private readonly seating: Pick<SeatingService, 'planOf'>,
    private readonly model: Pick<ModelService, 'run'>,
    private readonly jobs: Pick<JobQueue, 'enqueue' | 'jobFor'>,
    private readonly clock: Clock,
    store?: RecordStore,
  ) {
    this.#summaries = new TenantScopedRepository<RiskSummary>(liveness, (s) => s.wedding_id, COLLECTIONS.riskSummary, store)
  }

  /** A wedding's summary for this week (the planner); a stale one asks for this week's. */
  view(context: TenantContext, principal: Principal, wedding_id: string): RiskView {
    const wedding = assertWeddingReach(this.authorizer, this.weddings, context, principal, wedding_id)
    this.#planner(principal)
    // A wedding no longer planned is not summarized (and costs nothing).
    if (wedding.status !== 'planning' && wedding.status !== 'active') return { preparing: false, untracked: true }
    return this.#current(context, wedding_id, principal.principal_id)
  }

  /** This week's summaries across the workspace's upcoming weddings (the planner), the soonest first. */
  overview(context: TenantContext, principal: Principal): RiskOverview {
    this.#planner(principal)
    const today = this.#today()
    const all = this.weddings
      .list(context)
      .filter((w) => (w.status === 'planning' || w.status === 'active') && w.event_date >= today)
      .sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : a.couple_display_name.localeCompare(b.couple_display_name)))
    const upcoming = all.slice(0, RISK_OVERVIEW_LIMIT)
    return {
      week: isoWeek(today),
      more: all.length - upcoming.length,
      weddings: upcoming.map((w) => {
        const { summary } = this.#current(context, w.wedding_id, principal.principal_id)
        return { wedding_id: w.wedding_id, couple_display_name: w.couple_display_name, event_date: w.event_date, ...(summary === undefined ? {} : { summary }) }
      }),
    }
  }

  /** The wedding's signals now, read fresh (no boundary check: only the job calls it, for a wedding a planner reached). */
  #signalsFor(context: TenantContext, wedding_id: string): RiskSignals | undefined {
    const wedding = this.weddings.get(context, wedding_id)
    if (wedding === undefined) return undefined
    const guests = this.guests.guestsOf(context, wedding_id)
    const households = new Map(this.guests.householdsOf(context, wedding_id).map((h) => [h.household_id, h.name]))
    const waiting = new Set<string>()
    for (const event of this.events.eventsOf(context, wedding_id)) {
      const statuses = this.events.statusesFor(context, wedding_id, event.event_id)
      for (const g of guests) {
        const s = statuses?.get(g.guest_id)
        if (s !== undefined && s.invited && s.status === 'pending') waiting.add(g.household_id)
      }
    }
    return computeRiskSignals({
      today: this.#today(),
      event_date: wedding.event_date,
      tasks: this.checklist.tasksOf(context, wedding_id),
      vendors: this.vendors.vendorsOf(context, wedding_id),
      rsvps_closed: this.events.rsvpsClosed(context, wedding_id),
      unanswered_households: [...waiting].map((id) => households.get(id) ?? 'A household'),
      unseated_guests: this.#unseated(context, wedding_id),
    })
  }

  /** Attending guests without a seat — only for a wedding that uses a seating plan (it has an event and a table). */
  #unseated(context: TenantContext, wedding_id: string): string[] {
    const plan = this.seating.planOf(context, wedding_id)
    return plan.event === undefined || plan.tables.length === 0 ? [] : plan.unseated.map((g) => g.name)
  }

  /** The job kind the queue runs for a summary. */
  jobKind(): JobKind<WrittenSummary | undefined> {
    return {
      kind: RISK_JOB,
      // Written already this week (another request asked first): nothing to do.
      wanted: (context, job) => this.#summaries.read(context, job.subject_id)?.week !== isoWeek(this.#today()),
      execute: (context, job) => this.#write(context, job),
      complete: (context, job, result) => {
        if (result === undefined) return
        const summary: RiskSummary = { tenant_id: context.tenant_id, wedding_id: job.subject_id, ...result, lines: [...result.lines], generated_at: this.clock.now() }
        getSchemaRegistry().assertValid<RiskSummary>('risk_summary', summary)
        this.#summaries.put(context, summary)
      },
      // A summary that could not be written: the next read asks again.
      failed: () => undefined,
    }
  }

  /** Read the signals, ask the model, and keep only what the signals hold. */
  async #write(context: TenantContext, job: Job): Promise<WrittenSummary | undefined> {
    const signals = this.#signalsFor(context, job.subject_id)
    if (signals === undefined) return undefined
    // Nothing slipping: nothing to judge, and no model call.
    if (signals.signals.length === 0) return { week: signals.week, level: 'on_track', lines: [] }
    // The model is sent the days to go and each signal's key and count — never the names behind them (data
    // minimization; a household or guest name a couple typed never reaches a model prompt).
    const output = await this.model.run(context, RISK_SUMMARY, { days_to_wedding: signals.days_to_wedding, signals: signals.signals.map(({ key, count }) => ({ key, count })) })
    return checkRiskSummary(signals, output)
  }

  #current(context: TenantContext, wedding_id: string, requested_by: string): RiskView {
    const stored = this.#summaries.read(context, wedding_id)
    if (stored !== undefined && stored.wedding_id === wedding_id && stored.week === isoWeek(this.#today())) return { summary: stored, preparing: false }
    // A summary that just failed is not asked for again on every read: a failing model is not hammered by refreshes.
    const job = this.jobs.jobFor(context, RISK_JOB, wedding_id)
    if (job?.status === 'failed' && job.updated_at !== undefined && Date.parse(this.clock.now()) - Date.parse(job.updated_at) < RISK_RETRY_COOLDOWN_MS) {
      return { preparing: false, unavailable: true }
    }
    this.jobs.enqueue(context, RISK_JOB, wedding_id, requested_by)
    return { preparing: true }
  }

  #today(): string {
    return this.clock.now().slice(0, 10)
  }

  #planner(principal: Principal): void {
    if (principal.role !== 'planner') throw new ProductError('PRODUCT.FORBIDDEN', 'Only the planner sees the risk summary.', {})
  }
}

/**
 * The second check, pure: mention only signals the job computed (at most {@link MAX_RISK_LINES}), and an honest level —
 * `on_track` exactly when there is no signal. Lines are worded from the signals' own data.
 */
export function checkRiskSummary(signals: RiskSignals, output: RiskSummaryOutput): WrittenSummary {
  const byKey = new Map(signals.signals.map((s) => [s.key, s]))
  // In the product's own order of urgency, whatever order the model gave.
  const chosen = new Set(output.mention)
  const mentioned = RISK_URGENCY.filter((k) => chosen.has(k) && byKey.has(k)).slice(0, MAX_RISK_LINES)
  const level: RiskSummary['level'] = signals.signals.length === 0 ? 'on_track' : output.level === 'on_track' ? 'watch' : output.level
  const shown = mentioned.length > 0 ? mentioned : RISK_URGENCY.filter((k) => byKey.has(k)).slice(0, MAX_RISK_LINES)
  return { week: signals.week, level, lines: shown.map((k) => renderRiskLine(byKey.get(k) as NonNullable<ReturnType<typeof byKey.get>>, signals.days_to_wedding)) }
}
