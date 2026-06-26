import type { DemoSeed } from '@wedding-planner/product'
import { describe, expect, it } from 'vitest'

import { buildBootLog, type Env, MIN_OPERATOR_TOKEN_LENGTH, resolveServerConfig } from '../server_config'

/**
 * Step-4(d) coverage for the entrypoint's two security-load-bearing decisions — the operator-token policy and
 * the boot-log allow-list. These run the PURE `server_config` layer (no socket, no real env) with an injected
 * env map + token generator, locking the doddy trust seam: a credential is injected not baked, never weak,
 * never auto-minted into a non-demo log, and an env-provided token never appears in the boot log.
 */

const STRONG = 'a-strong-operator-token-0123456789'
const constGen = (value: string) => (): string => value

describe('resolveServerConfig — the operator-token policy (fail-closed)', () => {
  it('accepts an env-provided token at/above the length floor and marks it env-provided', () => {
    const env: Env = { WP_OPERATOR_TOKEN: STRONG }
    const config = resolveServerConfig(env, constGen('SHOULD-NOT-BE-USED'))
    expect(config.operatorToken).toBe(STRONG)
    expect(config.tokenSource).toBe('env-provided')
  })

  it('FAILS CLOSED on a provided token below the length floor', () => {
    const env: Env = { WP_OPERATOR_TOKEN: 'x'.repeat(MIN_OPERATOR_TOKEN_LENGTH - 1) }
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

describe('buildBootLog — the disclosure allow-list', () => {
  const demo: DemoSeed = { slug: 'demo', tenantId: 'tenant_secret_internal_id', weddingId: 'wedding_secret_id' }

  it('NEVER echoes an env-provided token', () => {
    const config = resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG }, constGen('g'))
    const line = buildBootLog(config, demo)
    expect(line).not.toContain(STRONG)
    expect(line).toContain('operator token: env-provided')
  })

  it('prints a generated token exactly once', () => {
    const config = resolveServerConfig({}, constGen('GENERATED-DEMO-TOKEN-xyz'))
    const line = buildBootLog(config, demo)
    const occurrences = line.split('GENERATED-DEMO-TOKEN-xyz').length - 1
    expect(occurrences).toBe(1)
  })

  it('never leaks an internal tenant_id / wedding_id', () => {
    const config = resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG }, constGen('g'))
    const line = buildBootLog(config, demo)
    expect(line).not.toContain('tenant_secret_internal_id')
    expect(line).not.toContain('wedding_secret_id')
    expect(line).toContain("demo tenant 'demo' at /t/demo")
  })

  it('omits the demo line when there is no demo seed', () => {
    const config = resolveServerConfig({ WP_OPERATOR_TOKEN: STRONG, WP_SEED_DEMO: 'false' }, constGen('g'))
    expect(buildBootLog(config, undefined)).not.toContain('demo tenant')
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
