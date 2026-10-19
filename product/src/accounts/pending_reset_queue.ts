import type { Clock, IdGenerator } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import { GLOBAL_PARTITION, type RecordStore } from '../persistence/record_store'
import type { TenantContext } from '../tenant/tenant_context'

/**
 * @canonical pending_reset_queue -- password-reset requests waiting to be handled (issue #10, ADR 0041).
 *
 * A reset request must cost the same whether or not the email has an account, or its timing tells (a durable write
 * for a known account, none for an unknown one, is a ~20 ms difference on disk). So the request only ENQUEUES —
 * one identical row for every well-formed email — and the account lookup, the link and the email happen after the
 * response has been sent ({@link AccountService.processPendingResets}, run by the server after each response).
 *
 * A platform work queue: the global partition with the tenant as a field (processing mints each tenant's context).
 * A row holds a normalized email for the moment between the request and its processing, then is deleted.
 *
 * related: account_service.ts (enqueue + process), web_server.ts (runs deferred work after the response).
 */

export interface PendingReset {
  readonly request_id: string
  readonly tenant_id: string
  readonly email: string
  readonly created_at: string
}

export class PendingResetQueue {
  readonly #store: RecordStore

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store: RecordStore = new InMemoryRecordStore(),
  ) {
    this.#store = store
  }

  enqueue(context: TenantContext, email: string): void {
    const request: PendingReset = {
      request_id: this.ids.next('resetreq'),
      tenant_id: context.tenant_id,
      email,
      created_at: this.clock.now(),
    }
    this.#store.put(COLLECTIONS.pendingReset, GLOBAL_PARTITION, request.request_id, request)
  }

  /** Remove and return the oldest pending request, if any. */
  take(): PendingReset | undefined {
    const [oldest] = this.#store.list(COLLECTIONS.pendingReset, GLOBAL_PARTITION)
    if (oldest === undefined) return undefined
    this.#store.delete(COLLECTIONS.pendingReset, GLOBAL_PARTITION, oldest.request_id)
    return oldest
  }
}
