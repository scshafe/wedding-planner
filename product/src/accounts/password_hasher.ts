import { scryptSync, timingSafeEqual } from 'node:crypto'

import type { IdGenerator } from '@wedding-planner/shared'

import { ProductError } from '../product_error'

/**
 * @canonical password_hasher -- slow, salted password hashing with scrypt (issue #10, ADR 0041).
 *
 * A password is stored ONLY as `{ algorithm, N, r, p, salt, hash }` — never in plaintext, never in a log, an error
 * context or a response. The cost parameters travel with each hash, so raising the production cost later leaves
 * existing hashes verifiable (and they can be re-hashed at the next sign-in).
 *
 * `verify` is constant-work: an unknown account is checked against a dummy hash (computed once, on first need)
 * with the same cost, so a sign-in for an email with no account takes as long as a wrong password for a real one (no
 * timing oracle for account existence). The comparison itself is `timingSafeEqual`.
 *
 * Salts come from the injected `IdGenerator` (the determinism rail): in production it is the edge
 * `RandomIdGenerator`, so a salt carries 122 random bits — uniqueness is what a salt needs. Tests inject a cheap
 * cost and a sequential generator.
 *
 * related: account_service.ts (sign-in, reset), account_store.ts (where the hash is kept).
 */

/** scrypt cost parameters. */
export interface ScryptCost {
  readonly N: number
  readonly r: number
  readonly p: number
}

/** The production cost: N=2^15, r=8, p=1 (~32 MiB, ~100 ms per hash on the deploy host). */
export const PRODUCTION_SCRYPT_COST: ScryptCost = Object.freeze({ N: 2 ** 15, r: 8, p: 1 })

/** Password length bounds. The upper bound keeps one hash request from being a CPU lever. */
export const PASSWORD_LIMITS = Object.freeze({ min: 10, max: 128 })

/** A stored password hash. */
export interface PasswordHash {
  readonly algorithm: 'scrypt'
  readonly N: number
  readonly r: number
  readonly p: number
  readonly salt: string
  /** hex */
  readonly hash: string
}

const KEY_LENGTH = 32

export class PasswordHasher {
  /** The hash an unknown account is checked against — computed on first need, so construction stays cheap. */
  #dummy: PasswordHash | undefined

  constructor(
    private readonly cost: ScryptCost,
    private readonly ids: IdGenerator,
  ) {}

  /** Hash a password with a fresh salt at the configured cost. */
  hash(password: string): PasswordHash {
    const salt = this.ids.next('salt')
    const { N, r, p } = this.cost
    return { algorithm: 'scrypt', N, r, p, salt, hash: derive(password, salt, this.cost).toString('hex') }
  }

  /**
   * Whether `password` matches `stored`. An absent hash (unknown account, or an account with no password yet) is
   * checked against the dummy hash so it costs the same, and always fails.
   */
  verify(password: string, stored: PasswordHash | undefined): boolean {
    const target = stored ?? (this.#dummy ??= this.hash('dummy-password-for-unknown-accounts'))
    const expected = Buffer.from(target.hash, 'hex')
    const actual = derive(password, target.salt, target)
    return expected.length === actual.length && timingSafeEqual(expected, actual) && stored !== undefined
  }
}

/** Refuse a password outside the length bounds (PRODUCT.WEAK_PASSWORD). Checked before any token is consumed. */
export function assertAcceptablePassword(password: string): void {
  if (password.length < PASSWORD_LIMITS.min || password.length > PASSWORD_LIMITS.max) {
    throw new ProductError(
      'PRODUCT.WEAK_PASSWORD',
      `A password must be ${PASSWORD_LIMITS.min} to ${PASSWORD_LIMITS.max} characters.`,
      {},
    )
  }
}

function derive(password: string, salt: string, cost: ScryptCost): Buffer {
  // maxmem: scrypt needs 128 * N * r bytes; leave headroom above that.
  return scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: cost.N,
    r: cost.r,
    p: cost.p,
    maxmem: 256 * cost.N * cost.r,
  })
}
