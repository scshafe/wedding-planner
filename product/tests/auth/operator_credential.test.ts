import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { assertMintedOperator, InMemoryRecordStore, type Operator, OperatorCredentialStore } from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'
import { GLOBAL_PARTITION } from '../../src/persistence/record_store'

/**
 * Step-2 coverage for the platform trust tier: the OperatorCredentialStore is the sole mint of an
 * Operator, the token is an opaque server-side handle (a SEPARATE namespace from session tokens), and
 * the operator carries the unforgeable WeakSet+phantom-brand the /admin pipeline will check.
 */

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

function newStore(tokens: readonly string[] = ['op-secret-1']): OperatorCredentialStore {
  return new OperatorCredentialStore(new SequentialIdGenerator('seedO'), tokens)
}

describe('OperatorCredentialStore', () => {
  it('resolves a seeded token to a minted operator with an injected id', () => {
    const store = newStore(['op-secret-1'])
    const operator = store.resolve('op-secret-1')
    expect(operator).toBeDefined()
    expect(operator?.operator_id).toMatch(/operator/)
    expect(() => assertMintedOperator(operator as Operator)).not.toThrow()
  })

  it('fails closed for an absent / undefined / foreign token (bare Map.get, no shape gate)', () => {
    const store = newStore(['op-secret-1'])
    expect(store.resolve(undefined)).toBeUndefined()
    expect(store.resolve('')).toBeUndefined()
    expect(store.resolve('op-secret-2')).toBeUndefined()
    // A token shaped like a tenant session id is just another absent key — no special-casing.
    expect(store.resolve('session_0001')).toBeUndefined()
  })

  it('rejects a forged / re-stamped operator (brand is a WeakSet membership, not a reflectable property)', () => {
    const store = newStore(['op-secret-1'])
    const real = store.resolve('op-secret-1') as Operator
    expect(Object.getOwnPropertySymbols(real)).toHaveLength(0)

    const forged: Record<string | symbol, unknown> = { operator_id: 'operator_forged' }
    for (const sym of Object.getOwnPropertySymbols(real)) {
      forged[sym] = (real as unknown as Record<symbol, unknown>)[sym]
    }
    expect(codeOfThrow(() => assertMintedOperator(forged as unknown as Operator))).toBe('PRODUCT.FORGED_OPERATOR')
  })

  it('mints a distinct operator per seeded token and never leaks a token via serialization', () => {
    const store = newStore(['op-a', 'op-b'])
    const a = store.resolve('op-a')
    const b = store.resolve('op-b')
    expect(a?.operator_id).not.toBe(b?.operator_id)
    const dumped = JSON.stringify(store)
    expect(dumped).not.toContain('op-a')
    expect(dumped).not.toContain('op-b')
  })

  it('rejects an empty or duplicate seed token at construction', () => {
    expect(codeOfThrow(() => newStore([''])).startsWith('PRODUCT.BAD_REQUEST')).toBe(true)
    expect(codeOfThrow(() => newStore(['dup', 'dup']))).toBe('PRODUCT.DUPLICATE_OPERATOR_TOKEN')
  })

  it('the minted operator is frozen against post-hoc mutation', () => {
    const operator = newStore().resolve('op-secret-1') as Operator
    expect(Object.isFrozen(operator)).toBe(true)
  })
})

describe('OperatorCredentialStore — console sessions (issue #9)', () => {
  function sessionStore(clock = new ManualClock('2027-06-01T00:00:00.000Z')) {
    const backing = new InMemoryRecordStore()
    const store = new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret-1'], { clock, store: backing })
    return { store, backing, clock }
  }

  it('starts a session only from the static credential; the session resolves to a minted operator', () => {
    const { store } = sessionStore()
    const session = store.startSession('op-secret-1')
    expect(session).toBeDefined()
    expect(session?.expires_at).toBe('2027-06-01T12:00:00.000Z')
    const operator = store.resolve(session?.token)
    expect(operator).toBeDefined()
    expect(() => assertMintedOperator(operator as Operator)).not.toThrow()
    // A session cannot mint another session; unknown tokens cannot either.
    expect(store.startSession(session?.token)).toBeUndefined()
    expect(store.startSession('op-secret-2')).toBeUndefined()
    expect(store.startSession(undefined)).toBeUndefined()
  })

  it('a session lapses at expires_at: it then fails like an unknown token and is deleted', () => {
    const { store, backing, clock } = sessionStore()
    const session = store.startSession('op-secret-1')
    clock.advance((12 * 60 * 60 - 1) * 1000)
    expect(store.resolve(session?.token)).toBeDefined()
    clock.advance(1000)
    expect(store.resolve(session?.token)).toBeUndefined()
    expect(store.issueCsrf(session?.token)).toBeUndefined()
    expect(backing.list(COLLECTIONS.operatorSession, GLOBAL_PARTITION)).toEqual([])
    // The static credential is unaffected by session expiry.
    expect(store.resolve('op-secret-1')).toBeDefined()
  })

  it('endSession revokes a session server-side (idempotent)', () => {
    const { store } = sessionStore()
    const session = store.startSession('op-secret-1')
    expect(store.endSession(session?.token)).toBe(true)
    expect(store.resolve(session?.token)).toBeUndefined()
    expect(store.endSession(session?.token)).toBe(false)
    expect(store.endSession('op-secret-1')).toBe(false)
  })

  it('binds a CSRF token to each session; verification is fail-closed', () => {
    const { store } = sessionStore()
    const a = store.startSession('op-secret-1')
    const b = store.startSession('op-secret-1')
    expect(store.issueCsrf(a?.token)).toBe(a?.csrf_token)
    expect(store.verifyCsrf(a?.token, a?.csrf_token)).toBe(true)
    expect(store.verifyCsrf(a?.token, b?.csrf_token)).toBe(false)
    expect(store.verifyCsrf(a?.token, '')).toBe(false)
    expect(store.verifyCsrf(undefined, a?.csrf_token)).toBe(false)
    // The static credential has no console session, so no CSRF token.
    expect(store.issueCsrf('op-secret-1')).toBeUndefined()
  })

  it('persists sessions by token hash: the raw session token is not in the stored record or key', () => {
    const { store, backing } = sessionStore()
    const session = store.startSession('op-secret-1')
    const stored = backing.list(COLLECTIONS.operatorSession, GLOBAL_PARTITION)
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toContain(session?.token as string)
    expect(backing.get(COLLECTIONS.operatorSession, GLOBAL_PARTITION, session?.token as string)).toBeUndefined()
  })

  it('without session options only the static credential works', () => {
    const store = newStore(['op-secret-1'])
    expect(store.startSession('op-secret-1')).toBeUndefined()
    expect(store.issueCsrf('anything')).toBeUndefined()
    expect(store.endSession('anything')).toBe(false)
  })
})
