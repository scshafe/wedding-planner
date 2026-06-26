import { SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { assertMintedOperator, type Operator, OperatorCredentialStore } from '@wedding-planner/product'

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
