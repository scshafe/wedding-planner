import type { DemoSeed } from '@wedding-planner/product'

/**
 * @canonical server_config -- the PURE config + boot-log layer of the deployable entrypoint.
 *
 * Split out from `server.ts` (the impure socket `main`) so the two security-load-bearing decisions — the
 * operator-token policy and what the boot log may print — are unit-testable without binding a port or reading
 * the real environment. `resolveServerConfig` takes the env map and a token generator as ARGUMENTS, so a test
 * drives every branch deterministically.
 *
 * The credential-token policy (the doddy trust seam — a credential is injected, never baked, never weak). The
 * SAME policy governs every platform credential (the operator token and, Phase 19, the provider-webhook token):
 *   - env-provided token: enforced to a >= MIN_CREDENTIAL_TOKEN_LENGTH floor; below it -> FAIL CLOSED (throw,
 *     the caller exits non-zero). The credential stores only reject empty, so the floor lives here.
 *   - unset + seedDemo (the offline demo default): generate a fresh random token and mark it `generated`, so
 *     the boot log prints it exactly once (an ephemeral, regenerated-each-boot demo credential).
 *   - unset + NOT seedDemo (a "real" build): FAIL CLOSED — never silently auto-mint a platform credential into
 *     a production log. The human must inject the token.
 *
 * related: server.ts (the impure main that injects process.env + a crypto generator), compose.ts.
 */

/** The floor for a platform credential token (operator + provider-webhook). Below this, boot fails closed. */
export const MIN_CREDENTIAL_TOKEN_LENGTH = 16

/** Where a resolved credential token came from — gates whether the boot log may print its value. */
export type TokenSource = 'env-provided' | 'generated'

/** The resolved, validated server configuration. Both credential tokens are present and policy-checked. */
export interface ServerConfig {
  readonly port: number
  readonly host: string
  readonly seedDemo: boolean
  readonly demoSlug: string
  readonly operatorToken: string
  /** Provenance, so the boot log knows whether it may print the operator token (only when generated). */
  readonly tokenSource: TokenSource
  /** Phase 19: the provider-webhook secret (the inbound-messaging tier), under the SAME credential policy. */
  readonly providerWebhookToken: string
  /** Provenance for the webhook token (only a generated demo token may be printed). */
  readonly webhookTokenSource: TokenSource
}

/** A readonly view of the process environment (just the subset the entrypoint reads). */
export type Env = Record<string, string | undefined>

/**
 * Resolve + validate the server config from the environment. `generateToken` supplies a fresh random token
 * for the demo default (injected so tests are deterministic). Throws on any fail-closed condition.
 */
export function resolveServerConfig(env: Env, generateToken: () => string): ServerConfig {
  const port = parsePort(env.PORT)
  const host = nonEmpty(env.HOST) ?? '0.0.0.0'
  const seedDemo = parseBool(env.WP_SEED_DEMO, true)
  const demoSlug = nonEmpty(env.WP_DEMO_SLUG) ?? 'demo'

  const operator = resolveCredentialToken({
    provided: nonEmpty(env.WP_OPERATOR_TOKEN),
    envVar: 'WP_OPERATOR_TOKEN',
    label: 'operator',
    seedDemo,
    generateToken,
  })
  const webhook = resolveCredentialToken({
    provided: nonEmpty(env.WP_PROVIDER_WEBHOOK_TOKEN),
    envVar: 'WP_PROVIDER_WEBHOOK_TOKEN',
    label: 'provider-webhook',
    seedDemo,
    generateToken,
  })

  return {
    port,
    host,
    seedDemo,
    demoSlug,
    operatorToken: operator.token,
    tokenSource: operator.source,
    providerWebhookToken: webhook.token,
    webhookTokenSource: webhook.source,
  }
}

/**
 * Resolve one platform credential token under the single shared policy (see the file docstring): env-provided
 * is enforced to the length floor; unset+demo is generated (printable once); unset+non-demo fails closed. One
 * implementation governs both the operator and the provider-webhook credential so they cannot drift.
 */
function resolveCredentialToken(input: {
  readonly provided: string | undefined
  readonly envVar: string
  readonly label: string
  readonly seedDemo: boolean
  readonly generateToken: () => string
}): { token: string; source: TokenSource } {
  const { provided, envVar, label, seedDemo, generateToken } = input
  if (provided !== undefined) {
    if (provided.length < MIN_CREDENTIAL_TOKEN_LENGTH) {
      throw new Error(
        `${envVar} must be at least ${MIN_CREDENTIAL_TOKEN_LENGTH} characters; refusing to boot with a weak ${label} credential.`,
      )
    }
    return { token: provided, source: 'env-provided' }
  }
  if (seedDemo) return { token: generateToken(), source: 'generated' }
  throw new Error(
    `${envVar} is required when WP_SEED_DEMO is false (a non-demo build must not auto-mint a ${label} credential). Set ${envVar} and retry.`,
  )
}

/**
 * Build the single structured boot-log line. Allow-list ONLY: host, port, demo slug + URL, the operator token
 * provenance — printing the token value ONLY when this process generated it — and a bare `strategy: published`
 * provenance token (Phase 17). Never echoes an env-provided token, never logs an internal tenant_id /
 * operator_id / billing balance, and NEVER logs the champion genome internals (id, hash, or knob values).
 */
export function buildBootLog(config: ServerConfig, demo: DemoSeed | undefined): string {
  const parts = [`wedding-planner product surface listening on http://${config.host}:${config.port}`]
  if (demo !== undefined) parts.push(`demo tenant '${demo.slug}' at /t/${demo.slug}`)
  if (config.tokenSource === 'generated') {
    parts.push(`operator token (generated, offline-demo, regenerated each boot): ${config.operatorToken}`)
  } else {
    parts.push('operator token: env-provided')
  }
  if (config.webhookTokenSource === 'generated') {
    parts.push(`provider webhook token (generated, offline-demo, regenerated each boot): ${config.providerWebhookToken}`)
  } else {
    parts.push('provider webhook token: env-provided')
  }
  parts.push('strategy: published')
  return parts.join(' | ')
}

/** Parse PORT: unset -> 8080; set must be an integer in [1, 65535], else fail closed. */
function parsePort(raw: string | undefined): number {
  const value = nonEmpty(raw)
  if (value === undefined) return 8080
  if (!/^\d+$/.test(value)) throw new Error(`PORT must be a positive integer, got '${value}'.`)
  const port = Number(value)
  if (port < 1 || port > 65535) throw new Error(`PORT must be in [1, 65535], got ${port}.`)
  return port
}

/** Parse a boolean env flag: 'false'/'0'/'no'/'off' (case-insensitive) -> false; absent -> default; else true. */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const value = nonEmpty(raw)
  if (value === undefined) return fallback
  return !['false', '0', 'no', 'off'].includes(value.toLowerCase())
}

/** Trim and collapse an empty/whitespace value to undefined. */
function nonEmpty(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}
