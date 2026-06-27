import { SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  assertMintedProviderWebhook,
  type ProviderWebhookCredential,
  ProviderWebhookCredentialStore,
} from '@wedding-planner/product'

/**
 * Phase 19 Step 1 coverage for the FOURTH trust tier: the ProviderWebhookCredentialStore is the sole mint of
 * a ProviderWebhookCredential, the token is an opaque server-side handle in a SEPARATE namespace (session /
 * operator / provider-webhook never cross), and the credential carries the unforgeable WeakSet+phantom-brand
 * the inbound-webhook pipeline checks. A near-verbatim mirror of the operator-credential tests.
 */

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

function newStore(tokens: readonly string[] = ['wh-secret-1']): ProviderWebhookCredentialStore {
  return new ProviderWebhookCredentialStore(new SequentialIdGenerator('seedW'), tokens)
}

describe('ProviderWebhookCredentialStore', () => {
  it('resolves a seeded token to a minted credential with an injected id', () => {
    const store = newStore(['wh-secret-1'])
    const credential = store.resolve('wh-secret-1')
    expect(credential).toBeDefined()
    expect(credential?.provider_id).toMatch(/webhook_provider/)
    expect(() => assertMintedProviderWebhook(credential as ProviderWebhookCredential)).not.toThrow()
  })

  it('fails closed for an absent / undefined / foreign token (bare Map.get, no shape gate)', () => {
    const store = newStore(['wh-secret-1'])
    expect(store.resolve(undefined)).toBeUndefined()
    expect(store.resolve('')).toBeUndefined()
    expect(store.resolve('wh-secret-2')).toBeUndefined()
    // Tokens shaped like the OTHER namespaces are just another absent key — no special-casing, no cross-namespace oracle.
    expect(store.resolve('session_0001')).toBeUndefined()
    expect(store.resolve('op-secret-1')).toBeUndefined()
  })

  it('rejects a forged / re-stamped credential (brand is a WeakSet membership, not a reflectable property)', () => {
    const store = newStore(['wh-secret-1'])
    const real = store.resolve('wh-secret-1') as ProviderWebhookCredential
    expect(Object.getOwnPropertySymbols(real)).toHaveLength(0)

    const forged: Record<string | symbol, unknown> = { provider_id: 'webhook_provider_forged' }
    for (const sym of Object.getOwnPropertySymbols(real)) {
      forged[sym] = (real as unknown as Record<symbol, unknown>)[sym]
    }
    expect(codeOfThrow(() => assertMintedProviderWebhook(forged as unknown as ProviderWebhookCredential))).toBe(
      'PRODUCT.FORGED_WEBHOOK_PROVIDER',
    )
  })

  it('mints a distinct credential per seeded token and never leaks a token via serialization', () => {
    const store = newStore(['wh-a', 'wh-b'])
    const a = store.resolve('wh-a')
    const b = store.resolve('wh-b')
    expect(a?.provider_id).not.toBe(b?.provider_id)
    const dumped = JSON.stringify(store)
    expect(dumped).not.toContain('wh-a')
    expect(dumped).not.toContain('wh-b')
  })

  it('rejects an empty or duplicate seed token at construction', () => {
    expect(codeOfThrow(() => newStore([''])).startsWith('PRODUCT.BAD_REQUEST')).toBe(true)
    expect(codeOfThrow(() => newStore(['dup', 'dup']))).toBe('PRODUCT.DUPLICATE_WEBHOOK_TOKEN')
  })

  it('the minted credential is frozen against post-hoc mutation', () => {
    const credential = newStore().resolve('wh-secret-1') as ProviderWebhookCredential
    expect(Object.isFrozen(credential)).toBe(true)
  })
})
