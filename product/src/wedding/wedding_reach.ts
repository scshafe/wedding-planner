import type { Principal } from '../auth/principal'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import type { WeddingRepository } from './wedding_repository'

/**
 * @canonical wedding_reach -- the boundary of everything that belongs to one wedding (its guest list, events,
 * RSVPs): the principal may read the wedding (`WeddingAuthorizer.authorizeRead`: a planner any wedding of the tenant,
 * a couple only its own) AND the wedding exists. A couple's other wedding and a wedding that does not exist are the
 * same PRODUCT.NOT_FOUND — the masked 404, no existence oracle (ADR 0013, ADR 0046).
 */
export function assertWeddingReach(
  authorizer: WeddingAuthorizer,
  weddings: WeddingRepository,
  context: TenantContext,
  principal: Principal,
  wedding_id: string,
): void {
  if (authorizer.authorizeRead(principal, wedding_id) !== 'allow' || weddings.get(context, wedding_id) === undefined) {
    throw new ProductError('PRODUCT.NOT_FOUND', 'No such wedding.', {})
  }
}
