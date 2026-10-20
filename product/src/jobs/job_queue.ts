import { type Clock, getSchemaRegistry, type IdGenerator, type Job, WeddingPlannerError } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import { GLOBAL_PARTITION, groupedKey, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { TenantContext, TenantContextResolver } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'

/**
 * @canonical job_queue -- work done after the request that asked for it (issue #61, ADR 0058): ADR 0039's outbox
 * dispatcher, one implementation for every kind of job. Model calls are its first use; M5's real email and SMS sends
 * are meant to become kinds here too.
 *
 * A request is synchronous and one transaction; a model call is asynchronous and slow. So a request ENQUEUES a job (a
 * row written in its own transaction: the outbox pattern) and returns; the drain runs the job afterwards:
 *
 *   1. **Claim** (a savepoint per index entry, so one bad entry never stops the drain): among the entries due now —
 *      the index carries each one's due time, so the scan reads no tenant data — the tenant that ran least recently
 *      goes first. A queued job past its backoff, or a running one whose lease expired (a process stopped mid-call),
 *      becomes `running` with a new lease and one more attempt; a lease expiring on the last attempt is a final
 *      failure. A workspace that is suspended keeps its jobs (skipped until it is usable again); one that is gone loses
 *      them.
 *   2. **Run** (no transaction): the kind may decide the job is no longer wanted (`wanted`) — nothing is called —
 *      else its `execute` reads what it needs, fresh, and awaits the model within a deadline.
 *   3. **Complete** (one fresh transaction): only if the job still holds the claim it ran under (same job, status and
 *      attempt), the kind's `complete` writes the result and the job is `done`. A lost claim writes nothing.
 *
 * Failures: only a coded MODEL.UNAVAILABLE (an adapter failure, a missed deadline) is retried, with backoff timed by the
 * injected clock, up to {@link JOB_LIMITS}`.attempts`. Anything else — an invalid output, a programming error — fails at
 * once. Every failure is recorded in the operator's error log (#13); a final one also tells the kind (`failed`).
 *
 * Invariant: every queued or running job has its index entry (`enqueue` puts it back whenever it returns a live job).
 * The rows hold ids only — the facts are read again when the job runs — and the index holds the tenant, the job's key
 * and its due time, never tenant content. One drain runs at a time (`drain` joins the running one), one job at a time;
 * it starts after each response (`ProductApi.runDeferredWork`), at boot, and when the next job falls due (the injected
 * timer).
 *
 * related: model_service.ts (the call it makes), copilot_service.ts (the first kind), ADR 0057 (the requirements).
 */

export const JOB_LIMITS = Object.freeze({
  /** Tries before a retryable failure is final. */
  attempts: 3,
  /** How long one run may take before it counts as unavailable. */
  deadline_ms: 60_000,
  /** How long a claim lasts (twice the deadline): a job still `running` after it may be claimed again. */
  lease_ms: 120_000,
  /** The first retry's wait; each further retry waits twice as long. */
  backoff_ms: 30_000,
})

export type JobLimits = { readonly [K in keyof typeof JOB_LIMITS]: number }

/** What a kind of job does. `execute` runs outside any transaction; `wanted`, `complete` and `failed` inside one. */
export interface JobKind<R> {
  readonly kind: string
  /** A job per event rather than per long-lived subject (one per guest message): its row is removed when it ends. */
  readonly ephemeral?: boolean
  /** Whether the job is still worth running (say, its draft was discarded); `false` ends it without running. */
  wanted?(context: TenantContext, job: Job): boolean
  /** Read what the job needs (fresh) and do the slow part; the checked result. */
  execute(context: TenantContext, job: Job): Promise<R>
  /** Write the result (the job still holds its claim). */
  complete(context: TenantContext, job: Job, result: R): void
  /** The job failed for good: tell whoever is waiting. */
  failed(context: TenantContext, job: Job, code: string): void
}

/** A one-shot timer, injected so the queue keeps no ambient time (compose passes the real one). */
export type DeadlineTimer = (ms: number, onTimeout: () => void) => () => void

/** A live job in the global index: which tenant, the job's key there, and when it is next due. Never tenant content. */
export interface QueuedJob {
  readonly tenant_id: string
  readonly job_key: string
  readonly due_at: string
}

const CODE = /^[A-Z]+\.[A-Z_]+$/

type Claim = { readonly context: TenantContext; readonly job: Job }

export class JobQueue {
  readonly #jobs: TenantScopedRepository<Job>
  readonly #kinds = new Map<string, JobKind<unknown>>()
  /** When each tenant last had a job claimed (in-process): the least recent goes first. */
  readonly #lastRun = new Map<string, number>()
  #claims = 0
  #draining: Promise<number> | undefined
  #cancelWake: (() => void) | undefined

  constructor(
    liveness: TenantLivenessCheck,
    private readonly resolver: Pick<TenantContextResolver, 'resolveById'>,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly store: RecordStore,
    private readonly timer: DeadlineTimer | undefined = undefined,
    private readonly errors: { record(error: unknown, request: { readonly method: string; readonly path: string }): void } | undefined = undefined,
    private readonly limits: JobLimits = JOB_LIMITS,
  ) {
    this.#jobs = new TenantScopedRepository<Job>(liveness, (j) => groupedKey(j.kind, j.subject_id), COLLECTIONS.job, store)
  }

  /** Register a kind of job (at composition). */
  register<R>(kind: JobKind<R>): void {
    if (this.#kinds.has(kind.kind)) throw new ProductError('JOB.DUPLICATE_KIND', `A job kind '${kind.kind}' is registered twice.`, {})
    this.#kinds.set(kind.kind, kind as JobKind<unknown>)
  }

  /**
   * Enqueue a job, inside the caller's request transaction. A live (queued or running) job of the same kind and subject
   * is returned as it is — a second click does not start a second call — with its index entry put back.
   */
  enqueue(context: TenantContext, kind: string, subject_id: string, requested_by: string): Job {
    if (!this.#kinds.has(kind)) throw new ProductError('JOB.UNKNOWN_KIND', `No job kind '${kind}'.`, { context: { kind } })
    const key = groupedKey(kind, subject_id)
    const existing = this.#jobs.read(context, key)
    if (existing !== undefined && (existing.status === 'queued' || existing.status === 'running')) {
      this.#index(context.tenant_id, key, dueAt(existing) ?? this.clock.now())
      return existing
    }
    const job: Job = {
      job_id: this.ids.next('job'),
      tenant_id: context.tenant_id,
      kind,
      subject_id,
      requested_by,
      status: 'queued',
      attempts: 0,
      created_at: this.clock.now(),
    }
    this.#put(context, job)
    this.#index(context.tenant_id, key, job.created_at)
    return job
  }

  /** The job of a kind and subject, if any (a page shows its state). */
  jobFor(context: TenantContext, kind: string, subject_id: string): Job | undefined {
    return this.#jobs.read(context, groupedKey(kind, subject_id))
  }

  /** Run every job that is due, one at a time; joins a drain already running. Resolves with how many ran. Never rejects. */
  drain(): Promise<number> {
    if (this.#draining !== undefined) return this.#draining
    // Started on the next tick: never inside a caller's transaction, and `#draining` is set before any claim runs.
    const run = Promise.resolve()
      .then(() => this.#drainAll())
      .catch((error: unknown) => {
        this.errors?.record(error, { method: 'JOB', path: '/jobs/drain' })
        return 0
      })
      .finally(() => {
        this.#draining = undefined
        this.#armWake()
      })
    this.#draining = run
    return run
  }

  async #drainAll(): Promise<number> {
    let ran = 0
    // Entries that threw while being claimed are passed over for the rest of this drain (they never stop it).
    const passed = new Set<string>()
    for (;;) {
      const claimed = this.store.transaction(() => this.#claim(passed))
      if (claimed === undefined) return ran
      ran += 1
      await this.#run(claimed.context, claimed.job)
    }
  }

  /** Claim the next due job (inside a transaction, each entry in its own savepoint), or nothing. */
  #claim(passed: Set<string>): Claim | undefined {
    const now = this.clock.now()
    const due = this.store
      .list(COLLECTIONS.jobQueue, GLOBAL_PARTITION)
      .filter((entry) => entry.due_at <= now && !passed.has(queueKey(entry.tenant_id, entry.job_key)))
      .sort((a, b) => (this.#lastRun.get(a.tenant_id) ?? -1) - (this.#lastRun.get(b.tenant_id) ?? -1) || (a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : 0))
    for (const entry of due) {
      try {
        const claimed = this.store.transaction(() => this.#claimEntry(entry, now))
        if (claimed !== undefined) {
          this.#claims += 1
          this.#lastRun.set(entry.tenant_id, this.#claims)
          return claimed
        }
      } catch (error) {
        passed.add(queueKey(entry.tenant_id, entry.job_key))
        this.errors?.record(error, { method: 'JOB', path: '/jobs/claim' })
        try {
          // Looked at again after a lease period, not on every wake.
          this.#index(entry.tenant_id, entry.job_key, this.#later(this.limits.lease_ms))
        } catch {
          // The store is failing: the next drain tries again.
        }
      }
    }
    return undefined
  }

  /** One entry: claim its job, end it, or leave it (a suspended workspace). */
  #claimEntry(entry: QueuedJob, now: string): Claim | undefined {
    let context: TenantContext
    try {
      context = this.resolver.resolveById(entry.tenant_id)
    } catch (error) {
      const code = error instanceof WeddingPlannerError ? error.code : undefined
      // Gone: its jobs go. Suspended: they stay, passed over until the workspace is usable again. Anything else is real.
      if (code === 'PRODUCT.UNKNOWN_TENANT') this.#unindex(entry.tenant_id, entry.job_key)
      else if (code === 'PRODUCT.TENANT_NOT_USABLE') this.#index(entry.tenant_id, entry.job_key, this.#later(this.limits.lease_ms))
      else throw error
      return undefined
    }
    const job = this.#jobs.read(context, entry.job_key)
    if (job === undefined || job.status === 'done' || job.status === 'failed') {
      this.#unindex(entry.tenant_id, entry.job_key)
      return undefined
    }
    const due = dueAt(job)
    if (due !== undefined && due > now) {
      this.#index(entry.tenant_id, entry.job_key, due)
      return undefined
    }
    const kind = this.#kinds.get(job.kind)
    if (job.status === 'running' && job.attempts >= this.limits.attempts) {
      // The last attempt's claim ran out (the process stopped mid-call every time): a final failure, not another call.
      this.#finalFailure(context, job, kind, new ProductError('JOB.LEASE_EXPIRED', 'The job outlived its last claim.', { context: { kind: job.kind } }))
      return undefined
    }
    if (kind === undefined) {
      // A kind this build does not have (a rollback): left for a build that does.
      this.#index(entry.tenant_id, entry.job_key, this.#later(this.limits.lease_ms))
      return undefined
    }
    const lease_until = this.#later(this.limits.lease_ms)
    const running: Job = { ...withoutTiming(job), status: 'running', attempts: job.attempts + 1, lease_until, updated_at: now }
    this.#put(context, running)
    this.#index(entry.tenant_id, entry.job_key, lease_until)
    return { context, job: running }
  }

  async #run(context: TenantContext, job: Job): Promise<void> {
    const kind = this.#kinds.get(job.kind)
    try {
      if (kind === undefined) throw new ProductError('JOB.UNKNOWN_KIND', `No job kind '${job.kind}'.`, { context: { kind: job.kind } })
      const wanted = kind.wanted === undefined || this.store.transaction(() => kind.wanted?.(context, job) !== false)
      if (!wanted) {
        this.store.transaction(() => {
          if (this.#holds(context, job)) this.#finish(context, job, 'done')
        })
        return
      }
      const result = await this.#withDeadline(kind.execute(context, job))
      this.store.transaction(() => {
        if (!this.#holds(context, job)) return
        kind.complete(context, job, result)
        this.#finish(context, job, 'done')
      })
    } catch (error) {
      this.errors?.record(error, { method: 'JOB', path: `/jobs/${job.kind}` })
      try {
        this.store.transaction(() => this.#fail(context, job, kind, error))
      } catch (inner) {
        // The job keeps its claim and index entry: when the lease runs out it is claimed again (or ends, on its last try).
        this.errors?.record(inner, { method: 'JOB', path: `/jobs/${job.kind}` })
      }
    }
  }

  /** A failure: retried with backoff when it is a coded MODEL.UNAVAILABLE and attempts remain, final otherwise. */
  #fail(context: TenantContext, job: Job, kind: JobKind<unknown> | undefined, error: unknown): void {
    if (!this.#holds(context, job)) return
    const coded = error instanceof WeddingPlannerError ? error.code : undefined
    if (coded === 'MODEL.UNAVAILABLE' && job.attempts < this.limits.attempts) {
      const not_before = this.#later(this.limits.backoff_ms * 2 ** (job.attempts - 1))
      this.#put(context, { ...withoutTiming(job), status: 'queued', not_before, last_error: coded, updated_at: this.clock.now() })
      this.#index(context.tenant_id, groupedKey(job.kind, job.subject_id), not_before)
      return
    }
    this.#finalFailure(context, job, kind, error)
  }

  /** End a job as failed: the kind is told (in a savepoint, so a throwing hook cannot keep the job alive). */
  #finalFailure(context: TenantContext, job: Job, kind: JobKind<unknown> | undefined, error: unknown): void {
    const code = error instanceof WeddingPlannerError && CODE.test(error.code) ? error.code : 'JOB.INTERNAL_ERROR'
    try {
      this.store.transaction(() => kind?.failed(context, job, code))
    } catch (hook) {
      this.errors?.record(hook, { method: 'JOB', path: `/jobs/${job.kind}` })
    }
    this.#finish(context, job, 'failed', code)
  }

  #finish(context: TenantContext, job: Job, status: 'done' | 'failed', code?: string): void {
    const key = groupedKey(job.kind, job.subject_id)
    // An ephemeral kind's row goes when the job ends (its outcome lives elsewhere: a reply sent, an escalation filed).
    if (this.#kinds.get(job.kind)?.ephemeral === true) this.#jobs.delete(context, key)
    else this.#put(context, { ...withoutTiming(job), status, ...(code === undefined ? {} : { last_error: code }), updated_at: this.clock.now() })
    this.#unindex(context.tenant_id, key)
  }

  /** Whether the stored job is still the claim `job` ran under. */
  #holds(context: TenantContext, job: Job): boolean {
    const current = this.#jobs.read(context, groupedKey(job.kind, job.subject_id))
    return current !== undefined && current.job_id === job.job_id && current.status === 'running' && current.attempts === job.attempts
  }

  /** After a drain: wake when the next job falls due (one timer, replaced each time; none without an injected timer). */
  #armWake(): void {
    this.#cancelWake?.()
    this.#cancelWake = undefined
    if (this.timer === undefined) return
    let next: string | undefined
    try {
      for (const entry of this.store.list(COLLECTIONS.jobQueue, GLOBAL_PARTITION)) if (next === undefined || entry.due_at < next) next = entry.due_at
    } catch (error) {
      this.errors?.record(error, { method: 'JOB', path: '/jobs/wake' })
      return
    }
    if (next === undefined) return
    const wait = Math.max(1000, Date.parse(next) - Date.parse(this.clock.now()))
    this.#cancelWake = this.timer(wait, () => {
      this.#cancelWake = undefined
      void this.drain()
    })
  }

  #withDeadline<R>(work: Promise<R>): Promise<R> {
    const timer = this.timer
    if (timer === undefined) return work
    return new Promise<R>((resolve, reject) => {
      const cancel = timer(this.limits.deadline_ms, () => reject(new ProductError('MODEL.UNAVAILABLE', 'The job did not finish in time.', {})))
      work.then(
        (value) => {
          cancel()
          resolve(value)
        },
        (error: unknown) => {
          cancel()
          reject(error)
        },
      )
    })
  }

  #index(tenant_id: string, job_key: string, due_at: string): void {
    this.store.put(COLLECTIONS.jobQueue, GLOBAL_PARTITION, queueKey(tenant_id, job_key), { tenant_id, job_key, due_at })
  }

  #unindex(tenant_id: string, job_key: string): void {
    this.store.delete(COLLECTIONS.jobQueue, GLOBAL_PARTITION, queueKey(tenant_id, job_key))
  }

  #later(ms: number): string {
    return new Date(Date.parse(this.clock.now()) + ms).toISOString()
  }

  #put(context: TenantContext, job: Job): void {
    getSchemaRegistry().assertValid<Job>('job', job)
    this.#jobs.put(context, job)
  }
}

function queueKey(tenant_id: string, job_key: string): string {
  return `${tenant_id}:${job_key}`
}

/** When a live job is next due: a queued one's backoff, a running one's lease end (undefined: now). */
function dueAt(job: Job): string | undefined {
  return job.status === 'queued' ? job.not_before : job.status === 'running' ? job.lease_until : undefined
}

function withoutTiming(job: Job): Job {
  const copy = { ...job }
  delete copy.not_before
  delete copy.lease_until
  return copy
}
