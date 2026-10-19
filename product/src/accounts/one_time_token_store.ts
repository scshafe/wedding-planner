import { type Clock, type IdGenerator, sha256Hex } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import type { RecordStore } from '../persistence/record_store'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'

/**
 * @canonical one_time_token_store -- single-use, expiring tokens for links sent by email (issue #10, ADR 0041).
 *
 * A password-reset or account-setup link carries its OWN token, minted for one purpose and one subject (a user
 * id; an invitation id later), never a session token. Each is:
 *   - stored only as sha256(token) — the token store holds nothing a reader could open a link with (while email is
 *     simulated, the outbox keeps the emailed body, link included, until the link lapses; then it is redacted);
 *   - tenant-scoped (the link's tenant comes from its route, and a token minted for one tenant does not exist in
 *     another's partition);
 *   - bound to a purpose (a reset token cannot complete an invitation);
 *   - expiring, and deleted when consumed, so it works exactly once.
 *
 * Issuing a new token for a (subject, purpose) revokes the earlier ones, so only the latest emailed link works.
 * Tokens come from the injected id generator (122 random bits each in production, like session tokens).
 *
 * related: account_service.ts (reset and setup flows), email_port.ts (the message contract).
 */

/** What a token may be used for. `invitation` tokens carry an invitation id as their subject (issue #11). */
export type OneTimeTokenPurpose = 'password_reset' | 'account_setup' | 'invitation'

/** A token as persisted. */
export interface StoredOneTimeToken {
  readonly tenant_id: string
  readonly token_hash: string
  readonly purpose: OneTimeTokenPurpose
  readonly subject: string
  readonly expires_at: string
}

const TOKEN_PREFIX: Readonly<Record<OneTimeTokenPurpose, string>> = Object.freeze({
  password_reset: 'reset',
  account_setup: 'setup',
  invitation: 'invite',
})

export class OneTimeTokenStore {
  readonly #repo: TenantScopedRepository<StoredOneTimeToken>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
  ) {
    this.#repo = new TenantScopedRepository<StoredOneTimeToken>(liveness, (t) => t.token_hash, COLLECTIONS.oneTimeToken, store)
  }

  /** Mint a token for `subject` and `purpose`, valid for `ttlSeconds`; earlier tokens of the pair are revoked. */
  issue(context: TenantContext, purpose: OneTimeTokenPurpose, subject: string, ttlSeconds: number): string {
    this.revoke(context, purpose, subject)
    const token = this.ids.next(TOKEN_PREFIX[purpose])
    const expires_at = new Date(Date.parse(this.clock.now()) + ttlSeconds * 1000).toISOString()
    this.#repo.put(context, { tenant_id: context.tenant_id, token_hash: sha256Hex(token), purpose, subject, expires_at })
    return token
  }

  /**
   * Use a token: its subject when it exists in this tenant, has this purpose and has not expired — and then it is
   * gone. Anything else returns undefined (one indistinguishable failure).
   */
  consume(context: TenantContext, purpose: OneTimeTokenPurpose, token: string): string | undefined {
    if (token.length === 0 || token.length > 256) return undefined
    const key = sha256Hex(token)
    const stored = this.#repo.read(context, key)
    if (stored === undefined || stored.purpose !== purpose) return undefined
    this.#repo.delete(context, key)
    if (Date.parse(stored.expires_at) <= Date.parse(this.clock.now())) return undefined
    return stored.subject
  }

  /**
   * Revoke every outstanding token of `purpose` for `subject` (or of every purpose when omitted). The pass also
   * deletes any expired token of the tenant, so lapsed links do not accumulate.
   */
  revoke(context: TenantContext, purpose: OneTimeTokenPurpose | undefined, subject: string): void {
    const now = Date.parse(this.clock.now())
    for (const stored of this.#repo.list(context)) {
      const revoked = stored.subject === subject && (purpose === undefined || stored.purpose === purpose)
      if (revoked || !(Date.parse(stored.expires_at) > now)) this.#repo.delete(context, stored.token_hash)
    }
  }
}
