import type { Clock, IdGenerator } from '@wedding-planner/shared'

import type { RateLimiter, RateLimitRule } from '../accounts/rate_limiter'
import type { Principal } from '../auth/principal'
import { COLLECTIONS } from '../persistence/collections'
import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import { GLOBAL_PARTITION, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'

/**
 * @canonical feedback_service -- "Send feedback" from inside the product (issue #12, ADR 0043).
 *
 * A signed-in planner or couple tells us what they were trying to do and what happened, optionally naming the page
 * they came from. A submission records exactly that, plus the tenant (id and slug), the submitter's ROLE and the time
 * — no user id, and nothing copied from the workspace (no guest data, no wedding details): only what the person
 * typed. The page is a KEY from the closed {@link FEEDBACK_PAGES} list, never a page title or free text (a wedding
 * page's title is the couple's names). Text is trimmed and length-limited; submissions are rate-limited per
 * principal and per tenant.
 *
 * Feedback is a PLATFORM log the operator reads at `/admin/feedback` (global partition, tenant as a field), bounded
 * PER TENANT at {@link FEEDBACK_RETENTION} — so one workspace (say, scripted sessions on the demo tenant) can never
 * push another workspace's feedback out. How it leaves production to reach the agents is an owner decision (the repository
 * and its issues are public; the agents cannot reach production): until then the operator page is the only reader.
 *
 * related: rate_limiter.ts, product_api.ts (POST /t/:slug/feedback, GET /admin/feedback), operator_console.ts.
 */

/** Length limits (characters, after trimming). */
export const FEEDBACK_LIMITS = Object.freeze({ trying: 1000, happened: 4000 })

/** How many submissions are kept per tenant (that tenant's oldest beyond this are deleted). */
export const FEEDBACK_RETENTION = 500

/** The pages a submission may name: fixed keys and their labels (the footer link passes a key). */
export const FEEDBACK_PAGES = Object.freeze({
  home: 'Home',
  weddings: 'Weddings',
  wedding: 'A wedding',
  guests: 'Guests',
  questions: 'Guest questions',
  conversation: 'A guest conversation',
  billing: 'Billing',
  team: 'Team',
  strategy: 'Planning strategy',
  other: 'Somewhere else',
})

/** A page key. */
export type FeedbackPage = keyof typeof FEEDBACK_PAGES

/** Whether a value is a page key. */
export function isFeedbackPage(value: string): value is FeedbackPage {
  return Object.prototype.hasOwnProperty.call(FEEDBACK_PAGES, value)
}

/** Submission rate limits. */
export const FEEDBACK_RATE_LIMITS = Object.freeze({
  perPrincipal: { limit: 10, windowSeconds: 60 * 60 },
  perTenant: { limit: 100, windowSeconds: 60 * 60 },
} satisfies Record<string, RateLimitRule>)

export interface FeedbackSubmission {
  readonly feedback_id: string
  readonly tenant_id: string
  readonly tenant_slug: string
  readonly role: Principal['role']
  readonly trying: string
  readonly happened: string
  readonly page?: FeedbackPage
  readonly created_at: string
}

export interface SubmitFeedbackInput {
  readonly trying: string
  readonly happened: string
  readonly page?: string
}

export class FeedbackService {
  readonly #store: RecordStore

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly limiter: RateLimiter,
    store: RecordStore = new InMemoryRecordStore(),
    private readonly retention: number = FEEDBACK_RETENTION,
  ) {
    this.#store = store
  }

  /** Record a submission. Throws PRODUCT.BAD_REQUEST (empty / too long) or PRODUCT.RATE_LIMITED. */
  submit(context: TenantContext, principal: Principal, input: SubmitFeedbackInput): FeedbackSubmission {
    const trying = input.trying.trim()
    const happened = input.happened.trim()
    const page = input.page === undefined || input.page.length === 0 ? undefined : input.page
    if (
      trying.length === 0 ||
      trying.length > FEEDBACK_LIMITS.trying ||
      happened.length === 0 ||
      happened.length > FEEDBACK_LIMITS.happened ||
      (page !== undefined && !isFeedbackPage(page))
    ) {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'Feedback must say what you were doing and what happened, within the length limits.', {})
    }
    if (
      !this.limiter.attempt(`feedback:${context.tenant_id}:${principal.principal_id}`, FEEDBACK_RATE_LIMITS.perPrincipal) ||
      !this.limiter.attempt(`feedback:${context.tenant_id}`, FEEDBACK_RATE_LIMITS.perTenant)
    ) {
      throw new ProductError('PRODUCT.RATE_LIMITED', 'Too much feedback at once; try again later.', {})
    }
    const submission: FeedbackSubmission = {
      feedback_id: this.ids.next('feedback'),
      tenant_id: context.tenant_id,
      tenant_slug: context.slug,
      role: principal.role,
      trying,
      happened,
      ...(page === undefined ? {} : { page }),
      created_at: this.clock.now(),
    }
    this.#store.put(COLLECTIONS.feedback, GLOBAL_PARTITION, submission.feedback_id, submission)
    const ofTenant = this.#store.list(COLLECTIONS.feedback, GLOBAL_PARTITION).filter((f) => f.tenant_id === context.tenant_id)
    for (const old of ofTenant.slice(0, Math.max(0, ofTenant.length - this.retention))) {
      this.#store.delete(COLLECTIONS.feedback, GLOBAL_PARTITION, old.feedback_id)
    }
    return submission
  }

  /** The most recent submissions, newest first, at most `limit` (the operator page). */
  recent(limit: number): readonly FeedbackSubmission[] {
    return this.#store.list(COLLECTIONS.feedback, GLOBAL_PARTITION).reverse().slice(0, Math.max(0, limit))
  }
}
