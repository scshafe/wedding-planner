import type { Clock, IdGenerator } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import type { RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import type { PasswordHash } from './password_hasher'

/**
 * @canonical account_store -- the people who can sign in to a workspace (issue #10, ADR 0041).
 *
 * A `UserAccount` belongs to exactly one tenant (a person in two studios has two accounts) and is reached only
 * through a minted TenantContext — both collections sit behind `TenantScopedRepository`, so isolation is inherited.
 * The account is keyed by `user_id`; a second collection indexes the NORMALIZED email (trimmed, lowercase) to it,
 * keeping email unique per tenant. Both are written in one transaction.
 *
 * Roles: `owner` (the workspace owner; manages members — issue #11), `planner` (staff), `couple` (bound to one
 * wedding — issue #11). An account may exist before it has a password (an owner the operator set up, a pending
 * invitee); `password` is then absent and sign-in fails exactly like a wrong password.
 *
 * Views returned to callers outside this domain go through {@link publicAccountView}, which drops the password hash.
 *
 * related: password_hasher.ts (the hash), account_service.ts (the flows), session_store.ts (the mint).
 */

export type AccountRole = 'owner' | 'planner' | 'couple'

export interface UserAccount {
  readonly user_id: string
  readonly tenant_id: string
  /** Normalized (trimmed, lowercase). */
  readonly email: string
  readonly role: AccountRole
  /** Present iff role === 'couple'. */
  readonly wedding_id?: string
  readonly password?: PasswordHash
  readonly created_at: string
  readonly password_set_at?: string
}

/** The email index entry. */
export interface AccountEmailIndex {
  readonly tenant_id: string
  readonly email: string
  readonly user_id: string
}

/** An account as other domains may see it: everything but the password hash. */
export type PublicAccountView = Omit<UserAccount, 'password'> & { readonly has_password: boolean }

/** Trim and lowercase an email (the uniqueness key). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Drop the password hash; say only whether one is set. */
export function publicAccountView(account: UserAccount): PublicAccountView {
  const { password, ...rest } = account
  return { ...rest, has_password: password !== undefined }
}

export interface CreateAccountInput {
  readonly email: string
  readonly role: AccountRole
  readonly wedding_id?: string
}

export class AccountStore {
  readonly #accounts: TenantScopedRepository<UserAccount>
  readonly #emails: TenantScopedRepository<AccountEmailIndex>
  readonly #store: RecordStore | undefined

  constructor(
    liveness: TenantLivenessCheck,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    store?: RecordStore,
  ) {
    this.#accounts = new TenantScopedRepository<UserAccount>(liveness, (a) => a.user_id, COLLECTIONS.userAccount, store)
    this.#emails = new TenantScopedRepository<AccountEmailIndex>(liveness, (e) => e.email, COLLECTIONS.userEmail, store)
    this.#store = store
  }

  /** Create an account. Throws PRODUCT.ACCOUNT_EXISTS when the (normalized) email is taken in this tenant. */
  create(context: TenantContext, input: CreateAccountInput): UserAccount {
    const email = normalizeEmail(input.email)
    if (this.#emails.read(context, email) !== undefined) {
      throw new ProductError('PRODUCT.ACCOUNT_EXISTS', 'An account with that email already exists in this workspace.', {})
    }
    const account: UserAccount = {
      user_id: this.ids.next('user'),
      tenant_id: context.tenant_id,
      email,
      role: input.role,
      ...(input.role === 'couple' && input.wedding_id !== undefined ? { wedding_id: input.wedding_id } : {}),
      created_at: this.clock.now(),
    }
    this.#atomically(() => {
      this.#accounts.put(context, account)
      this.#emails.put(context, { tenant_id: context.tenant_id, email, user_id: account.user_id })
    })
    return account
  }

  get(context: TenantContext, user_id: string): UserAccount | undefined {
    return this.#accounts.read(context, user_id)
  }

  findByEmail(context: TenantContext, email: string): UserAccount | undefined {
    const index = this.#emails.read(context, normalizeEmail(email))
    return index === undefined ? undefined : this.#accounts.read(context, index.user_id)
  }

  list(context: TenantContext): readonly UserAccount[] {
    return this.#accounts.list(context)
  }

  /** Set (or replace) an account's password hash. Returns the updated account, or undefined if it is gone. */
  setPassword(context: TenantContext, user_id: string, password: PasswordHash): UserAccount | undefined {
    const account = this.#accounts.read(context, user_id)
    if (account === undefined) return undefined
    const updated: UserAccount = { ...account, password, password_set_at: this.clock.now() }
    return this.#accounts.put(context, updated)
  }

  /** Delete an account and its email index entry. Returns whether it existed. */
  remove(context: TenantContext, user_id: string): boolean {
    const account = this.#accounts.read(context, user_id)
    if (account === undefined) return false
    this.#atomically(() => {
      this.#accounts.delete(context, user_id)
      this.#emails.delete(context, account.email)
    })
    return true
  }

  #atomically(fn: () => void): void {
    if (this.#store === undefined) fn()
    else this.#store.transaction(fn)
  }
}
