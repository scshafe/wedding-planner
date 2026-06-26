import type { DemoSeed } from '@wedding-planner/product'

/**
 * @canonical server_config -- the PURE config + boot-log layer of the deployable entrypoint.
 *
 * Split out from `server.ts` (the impure socket `main`) so the two security-load-bearing decisions — the
 * operator-token policy and what the boot log may print — are unit-testable without binding a port or reading
 * the real environment. `resolveServerConfig` takes the env map and a token generator as ARGUMENTS, so a test
 * drives every branch deterministically.
 *
 * The operator-token policy (the doddy trust seam — a credential is injected, never baked, never weak):
 *   - env-provided token: enforced to a >= MIN_OPERATOR_TOKEN_LENGTH floor; below it -> FAIL CLOSED (throw,
 *     the caller exits non-zero). The OperatorCredentialStore only rejects empty, so the floor lives here.
 *   - unset + seedDemo (the offline demo default): generate a fresh random token and mark it `generated`, so
 *     the boot log prints it exactly once (an ephemeral, regenerated-each-boot demo credential).
 *   - unset + NOT seedDemo (a "real" build): FAIL CLOSED — never silently auto-mint an admin credential into
 *     a production log. The human must inject WP_OPERATOR_TOKEN.
 *
 * related: server.ts (the impure main that injects process.env + a crypto generator), compose.ts.
 */

/** The floor for an operator credential token. Below this, boot fails closed. */
export const MIN_OPERATOR_TOKEN_LENGTH = 16

/** The resolved, validated server configuration. `operatorToken` is always present and policy-checked. */
export interface ServerConfig {
  readonly port: number
  readonly host: string
  readonly seedDemo: boolean
  readonly demoSlug: string
  readonly operatorToken: string
  /** Provenance, so the boot log knows whether it may print the token (only when it generated it). */
  readonly tokenSource: 'env-provided' | 'generated'
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

  const provided = nonEmpty(env.WP_OPERATOR_TOKEN)
  let operatorToken: string
  let tokenSource: ServerConfig['tokenSource']
  if (provided !== undefined) {
    if (provided.length < MIN_OPERATOR_TOKEN_LENGTH) {
      throw new Error(
        `WP_OPERATOR_TOKEN must be at least ${MIN_OPERATOR_TOKEN_LENGTH} characters; refusing to boot with a weak operator credential.`,
      )
    }
    operatorToken = provided
    tokenSource = 'env-provided'
  } else if (seedDemo) {
    operatorToken = generateToken()
    tokenSource = 'generated'
  } else {
    throw new Error(
      'WP_OPERATOR_TOKEN is required when WP_SEED_DEMO is false (a non-demo build must not auto-mint an admin credential). Set WP_OPERATOR_TOKEN and retry.',
    )
  }

  return { port, host, seedDemo, demoSlug, operatorToken, tokenSource }
}

/**
 * Build the single structured boot-log line. Allow-list ONLY: host, port, demo slug + URL, and the operator
 * token provenance — printing the token value ONLY when this process generated it. Never echoes an
 * env-provided token, and never logs an internal tenant_id / operator_id / billing balance.
 */
export function buildBootLog(config: ServerConfig, demo: DemoSeed | undefined): string {
  const parts = [`wedding-planner product surface listening on http://${config.host}:${config.port}`]
  if (demo !== undefined) parts.push(`demo tenant '${demo.slug}' at /t/${demo.slug}`)
  if (config.tokenSource === 'generated') {
    parts.push(`operator token (generated, offline-demo, regenerated each boot): ${config.operatorToken}`)
  } else {
    parts.push('operator token: env-provided')
  }
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
