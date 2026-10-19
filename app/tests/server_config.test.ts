import type { DemoSeed } from '@wedding-planner/product'
import { describe, expect, it } from 'vitest'

import { buildBootLog, type Env, MIN_CREDENTIAL_TOKEN_LENGTH, resolveServerConfig } from '../server_config'

/**
 * Step-4(d) coverage for the entrypoint's two security-load-bearing decisions — the operator-token policy and
 * the boot-log allow-list. These run the PURE `server_config` layer (no socket, no real env) with an injected
 * env map + token generator, locking the doddy trust seam: a credential is injected not baked, never weak,
 * never auto-minted into a non-demo log, and an env-provided token never appears in the boot log.
 */

const STRONG = 'a-strong-operator-token-0123456789'
const STRONG_WEBHOOK = 'a-strong-webhook-token-0123456789abc'
const constGen = (value: string) => (): string => value
/** A generator that returns distinct values per call (the entrypoint now mints TWO credentials per boot). */
const seqGen = (...values: string[]): (() => string) => {
  let i = 0
  return () => values[i++] ?? `gen-${i}`
}

describe('resolveServerConfig — the operator-token policy (fail-closed)', () => {
  it('accepts an env-provided token at/above the length floor and marks it env-provided', () => {
    const env: Env = { WP_OPERATOR_TOKEN: STRONG }
    const config = resolveServerConfig(env, constGen('SHOULD-NOT-BE-USED'))
    expect(config.operatorToken).toBe(STRONG)
    expect(config.tokenSource).toBe('env-provided')
  })

  it('FAILS CLOSED on a provided token below the length floor', () => {
    const env: Env = { WP_OPERATOR_TOKEN: 'x'.repeat(MIN_CREDENTIAL_TOKEN_LENGTH - 1) }
    expect(() => resolveServerConfig(env, constGen('gen'))).toThrow(/at least 16 characters/)
  })

  it('generates a token when unset AND seedDemo (the offline-demo default)', () => {
    const config = resolveServerConfig({}, constGen('GENERATED-DEMO-TOKEN-xyz'))
    expect(config.seedDemo).toBe(true)
    expect(config.operatorToken).toBe('GENERATED-DEMO-TOKEN-xyz')
    expect(config.tokenSource).toBe('generated')
  })

  it('FAILS CLOSED when unset AND seedDemo is false (a non-demo build must not auto-mint a credential)', () => {
    const env: Env = { WP_SEED_DEMO: 'false' }
    expect(() => resolveServerConfig(env, constGen('gen'))).toThrow(/WP_OPERATOR_TOKEN is required/)
  })

  it('an empty/whitespace WP_OPERATOR_TOKEN is treated as unset (generated under demo)', () => {
    const config = resolveServerConfig({ WP_OPERATOR_TOKEN: '   ' }, constGen('GEN-TOKEN-abcdefghij'))
    expect(config.tokenSource).toBe('generated')
  })
})

describe('resolveServerConfig — the provider-webhook-token policy (Phase 19, same fail-closed policy)', () => {
  it('accepts an env-provided webhook token at/above the floor and marks it env-provided', () => {
    const env: Env = { WP_OPERATOR_TOKEN: STRONG, WP_PROVIDER_WEBHOOK_TOKEN: STRONG_WEBHOOK }
    const config = resolveServerConfig(env, constGen('SHOULD-NOT-BE-USED'))
    expect(config.providerWebhookToken).toBe(STRONG_WEBHOOK)
    expect(config.webhookTokenSource).toBe('env-provided')
  })

  it('FAILS CLOSED on a provided webhook token below the length floor', () => {
    const env: Env = { WP_OPERATOR_TOKEN: STRONG, WP_PROVIDER_WEBHOOK_TOKEN: 'short' }
    expect(() => resolveServerConfig(env, constGen('gen'))).toThrow(/WP_PROVIDER_WEBHOOK_TOKEN must be at least 16/)
  })

  it('generates a webhook token when unset AND seedDemo (the offline-demo default)', () => {
    const config = resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG }, constGen('GEN-WH-TOKEN-abcdef'))
    expect(config.providerWebhookToken).toBe('GEN-WH-TOKEN-abcdef')
    expect(config.webhookTokenSource).toBe('generated')
  })

  it('FAILS CLOSED when the webhook token is unset AND seedDemo is false', () => {
    const env: Env = { WP_OPERATOR_TOKEN: STRONG, WP_SEED_DEMO: 'false' }
    expect(() => resolveServerConfig(env, constGen('gen'))).toThrow(/WP_PROVIDER_WEBHOOK_TOKEN is required/)
  })

  it('boot log NEVER echoes an env-provided webhook token, and prints the provenance', () => {
    const config = resolveServerConfig(
      { WP_OPERATOR_TOKEN: STRONG, WP_PROVIDER_WEBHOOK_TOKEN: STRONG_WEBHOOK },
      constGen('g'),
    )
    const line = buildBootLog(config, undefined)
    expect(line).not.toContain(STRONG_WEBHOOK)
    expect(line).toContain('provider webhook token: env-provided')
  })
})

describe('resolveServerConfig — env parsing', () => {
  it('defaults port 8080 / host 0.0.0.0 / seedDemo true / demoSlug demo', () => {
    const config = resolveServerConfig({}, constGen('GEN-TOKEN-abcdefghij'))
    expect(config).toMatchObject({ port: 8080, host: '0.0.0.0', seedDemo: true, demoSlug: 'demo' })
  })

  it('parses an explicit PORT and rejects a non-integer or out-of-range port', () => {
    expect(resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG, PORT: '9090' }, constGen('g')).port).toBe(9090)
    expect(() => resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG, PORT: 'abc' }, constGen('g'))).toThrow(/PORT/)
    expect(() => resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG, PORT: '70000' }, constGen('g'))).toThrow(/PORT/)
  })

  it('treats WP_SEED_DEMO=false/0/no/off (case-insensitive) as false', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'Off']) {
      // unset token + seedDemo false => fail closed, which proves seedDemo parsed false
      expect(() => resolveServerConfig({ WP_SEED_DEMO: v }, constGen('g'))).toThrow(/required/)
    }
  })
})

describe('resolveServerConfig — the storage policy (issue #8, fail-closed)', () => {
  const realTokens: Env = { WP_OPERATOR_TOKEN: STRONG, WP_PROVIDER_WEBHOOK_TOKEN: STRONG_WEBHOOK }

  it('uses WP_DATABASE_PATH when set (demo or not)', () => {
    expect(resolveServerConfig({ ...realTokens, WP_DATABASE_PATH: '/data/wp.sqlite' }, constGen('g')).databasePath).toBe(
      '/data/wp.sqlite',
    )
    expect(
      resolveServerConfig({ ...realTokens, WP_SEED_DEMO: 'false', WP_DATABASE_PATH: ' /data/wp.sqlite ' }, constGen('g'))
        .databasePath,
    ).toBe('/data/wp.sqlite')
  })

  it('falls back to the in-memory store only in demo mode', () => {
    expect(resolveServerConfig(realTokens, constGen('g')).databasePath).toBeUndefined()
    expect(resolveServerConfig({ ...realTokens, WP_DATABASE_PATH: '   ' }, constGen('g')).databasePath).toBeUndefined()
  })

  it('FAILS CLOSED without WP_DATABASE_PATH when WP_REQUIRE_DATABASE is set, even in demo mode', () => {
    expect(() => resolveServerConfig({ ...realTokens, WP_REQUIRE_DATABASE: 'true' }, constGen('g'))).toThrow(
      /WP_REQUIRE_DATABASE/,
    )
    expect(
      resolveServerConfig({ ...realTokens, WP_REQUIRE_DATABASE: 'true', WP_DATABASE_PATH: '/data/wp.sqlite' }, constGen('g'))
        .databasePath,
    ).toBe('/data/wp.sqlite')
    expect(resolveServerConfig({ ...realTokens, WP_REQUIRE_DATABASE: 'false' }, constGen('g')).databasePath).toBeUndefined()
  })

  it('FAILS CLOSED when WP_DATABASE_PATH is unset AND seedDemo is false', () => {
    expect(() => resolveServerConfig({ ...realTokens, WP_SEED_DEMO: 'false' }, constGen('g'))).toThrow(
      /WP_DATABASE_PATH is required/,
    )
  })
})

describe('resolveServerConfig — WP_PUBLIC_URL (issue #10, links in emails)', () => {
  it('accepts an http(s) origin and leaves it unset by default (or when empty, as the stack passes it unset)', () => {
    expect(resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG }, constGen('g')).publicUrl).toBeUndefined()
    expect(resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG, WP_PUBLIC_URL: '' }, constGen('g')).publicUrl).toBeUndefined()
    for (const ok of ['https://planner.example', 'http://localhost:8080', 'https://wedding-planner.tail1234.ts.net']) {
      expect(resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG, WP_PUBLIC_URL: ok }, constGen('g')).publicUrl).toBe(ok)
    }
  })

  it('FAILS CLOSED on a path, a trailing slash, another scheme, or junk', () => {
    for (const bad of ['https://planner.example/', 'https://planner.example/app', 'ftp://planner.example', 'planner.example', 'https://a b']) {
      expect(() => resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG, WP_PUBLIC_URL: bad }, constGen('g'))).toThrow(/WP_PUBLIC_URL/)
    }
  })

  it('the boot log names the link base', () => {
    expect(buildBootLog(resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG }, constGen('g')), undefined)).toContain('email links: site-relative')
    expect(
      buildBootLog(resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG, WP_PUBLIC_URL: 'https://planner.example' }, constGen('g')), undefined),
    ).toContain('email links: https://planner.example')
  })
})

describe('resolveServerConfig — the build commit (issue #13)', () => {
  it('prefers WP_BUILD_COMMIT, then the tag of WP_IMAGE_REF, else unknown — and only ever a hex commit id', () => {
    const at = (env: Env) => resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG, ...env }, constGen('g')).buildCommit
    expect(at({})).toBe('unknown')
    expect(at({ WP_BUILD_COMMIT: '2AA8F45A76B92CDC3D5E798E8D8B929350B9A9B9' })).toBe('2aa8f45a76b92cdc3d5e798e8d8b929350b9a9b9')
    expect(at({ WP_IMAGE_REF: 'wedding-planner:2aa8f45' })).toBe('2aa8f45')
    expect(at({ WP_BUILD_COMMIT: 'unknown', WP_IMAGE_REF: 'wedding-planner:2aa8f45' })).toBe('2aa8f45')
    expect(at({ WP_IMAGE_REF: 'wedding-planner:latest' })).toBe('unknown')
    expect(at({ WP_BUILD_COMMIT: '<script>' })).toBe('unknown')
  })

  it('the boot log names the build', () => {
    expect(buildBootLog(resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG, WP_IMAGE_REF: 'x:abcdef1' }, constGen('g')), undefined)).toContain(
      'build: abcdef1',
    )
  })
})

describe('buildBootLog — the disclosure allow-list', () => {
  const demo: DemoSeed = {
    slug: 'demo',
    tenantId: 'tenant_secret_internal_id',
    weddingId: 'wedding_secret_id',
    guestRecipientRef: 'sms:+15550100',
  }

  it('NEVER echoes an env-provided token', () => {
    const config = resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG }, constGen('g'))
    const line = buildBootLog(config, demo)
    expect(line).not.toContain(STRONG)
    expect(line).toContain('operator token: env-provided')
  })

  it('prints each generated token exactly once', () => {
    const config = resolveServerConfig({}, seqGen('GENERATED-OP-TOKEN-xyz', 'GENERATED-WH-TOKEN-xyz'))
    const line = buildBootLog(config, demo)
    expect(line.split('GENERATED-OP-TOKEN-xyz').length - 1).toBe(1)
    expect(line.split('GENERATED-WH-TOKEN-xyz').length - 1).toBe(1)
  })

  it('never leaks an internal tenant_id / wedding_id', () => {
    const config = resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG }, constGen('g'))
    const line = buildBootLog(config, demo)
    expect(line).not.toContain('tenant_secret_internal_id')
    expect(line).not.toContain('wedding_secret_id')
    expect(line).toContain("demo tenant 'demo' at /t/demo")
  })

  it('omits the demo line when there is no demo seed', () => {
    const config = resolveServerConfig(
      {
        WP_OPERATOR_TOKEN: STRONG,
        WP_PROVIDER_WEBHOOK_TOKEN: STRONG_WEBHOOK,
        WP_SEED_DEMO: 'false',
        WP_DATABASE_PATH: '/data/wp.sqlite',
      },
      constGen('g'),
    )
    const line = buildBootLog(config, undefined)
    expect(line).not.toContain('demo tenant')
    expect(line).not.toContain('demo seed skipped')
  })

  it('names the storage: the sqlite path, or a warning that the in-memory store resets on restart', () => {
    const durable = resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG, WP_DATABASE_PATH: '/data/wp.sqlite' }, constGen('g'))
    expect(buildBootLog(durable, demo)).toContain('storage: sqlite at /data/wp.sqlite')
    const memory = resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG }, constGen('g'))
    expect(buildBootLog(memory, demo)).toContain('storage: in-memory (offline demo; every restart resets to the demo seed)')
  })

  it('notes a skipped demo seed (demo mode over a store that already holds data)', () => {
    const config = resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG, WP_DATABASE_PATH: '/data/wp.sqlite' }, constGen('g'))
    const line = buildBootLog(config, undefined)
    expect(line).toContain('demo seed skipped: the store already holds data')
    expect(line).not.toContain('demo tenant')
  })

  it('logs a bare strategy provenance token — never the champion genome internals', () => {
    const config = resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG }, constGen('g'))
    const line = buildBootLog(config, demo)
    expect(line).toContain('strategy: published')
    // No genome id, content hash, or knob names ever reach the boot log.
    expect(line).not.toContain('published_champion_v1')
    expect(line).not.toContain('genome:')
    expect(line).not.toMatch(/rsvp_reminder_cadence|reminder_spacing|reminder_batching/)
  })
})
