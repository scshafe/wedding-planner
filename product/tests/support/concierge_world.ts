import { type Clock, SequentialIdGenerator } from '@wedding-planner/shared'

import {
  ConciergeService,
  type EscalationLog,
  type EscalationReplyLog,
  type EscalationResolutionLog,
  type GuestRegistry,
  type InboundReceiptLog,
  InMemoryRecordStore,
  JobQueue,
  type MessagingService,
  ModelService,
  SIMULATED_MODEL_TASKS,
  SimulatedModelAdapter,
  type SiteService,
  type TenantContextResolver,
  type TenantStore,
  type WeddingRepository,
} from '@wedding-planner/product'

/**
 * Issue #60 — the guest concierge for a test that builds the product API by hand: the concierge over the simulated model
 * and a job queue, and `drain` to run the jobs an inbound message queued (what the web adapter does after a response).
 */
export interface ConciergeWorldDeps {
  readonly tenants: TenantStore
  readonly resolver: TenantContextResolver
  readonly clock: Clock
  readonly weddings: WeddingRepository
  readonly registry: GuestRegistry
  readonly receipts: InboundReceiptLog
  readonly service: MessagingService
  readonly escalations: EscalationLog
  readonly resolutions: EscalationResolutionLog
  readonly replies: EscalationReplyLog
  readonly sites?: SiteService
}

export function conciergeWorld(deps: ConciergeWorldDeps): { readonly concierge: ConciergeService; readonly drain: () => Promise<number> } {
  const store = new InMemoryRecordStore()
  const model = new ModelService(deps.tenants, new SimulatedModelAdapter(SIMULATED_MODEL_TASKS), deps.clock, store)
  // A job that fails is recorded here, and draining then throws: a test can never pass because a job failed silently.
  const errors: unknown[] = []
  const jobs = new JobQueue(deps.tenants, deps.resolver, deps.clock, new SequentialIdGenerator('job'), store, undefined, { record: (error) => errors.push(error) })
  const concierge = new ConciergeService(
    deps.tenants,
    deps.registry,
    deps.weddings,
    deps.sites,
    model,
    jobs,
    deps.receipts,
    deps.service,
    { escalations: deps.escalations, resolutions: deps.resolutions, replies: deps.replies },
    store,
  )
  jobs.register(concierge.jobKind())
  const drain = async (): Promise<number> => {
    const ran = await jobs.drain()
    if (errors.length > 0) throw new Error(`A concierge job failed: ${String(errors[0])}`)
    return ran
  }
  return { concierge, drain }
}
