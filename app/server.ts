import { randomUUID } from 'node:crypto'

import { composeProductSurface, createProductWebUiServer } from '@wedding-planner/product'

// The edge-only primitives are imported by RELATIVE PATH on purpose: they are exported from neither the
// shared nor the product barrel, so this entrypoint is the sole place a wall clock + a non-deterministic id
// source enter the system (the determinism rail holds everywhere else by reachability).
import { RandomIdGenerator } from '../product/src/runtime/random_id_generator'
import { SystemClock } from '../product/src/runtime/system_clock'
import { assertTier1Champion, publishedChampion } from './published_champion'
import { buildBootLog, resolveServerConfig } from './server_config'

/**
 * @canonical product_server_main -- the deployable entrypoint: the impure shell of the product surface.
 *
 * This is the ONE place ambient reality enters — `process.env`, the wall clock, crypto-random platform
 * credential tokens (operator + provider-webhook), the listening socket, and OS signals. Everything below
 * `composeProductSurface` stays injected, deterministic, and testable. The image runs this file directly via `tsx` (see the Dockerfile / `npm run
 * serve`); the build emits no JS and the workspace path aliases resolve through tsconfig.
 *
 * Boot is fail-closed: a bad/weak/absent operator credential (per the policy in server_config.ts) aborts
 * with a non-zero exit before any socket is opened. On success it logs ONE allow-listed boot line and serves
 * until SIGTERM/SIGINT, then closes the server and exits 0.
 *
 * related: server_config.ts (the pure policy + boot log), compose.ts (the wiring), web_server.ts (the socket).
 */
function main(): void {
  let config
  try {
    config = resolveServerConfig(process.env, () => randomUUID())
  } catch (error) {
    console.error(`[wedding-planner] refusing to boot: ${(error as Error).message}`)
    process.exit(1)
  }

  // The engine↔surface seam: inject the loop's published champion as a VALUE (the surface imports no loop
  // code). assertTier1Champion re-derives the tier and fail-closes on a non-tier-1 / invalid genome, so a
  // strategy that would need human approval can never be auto-presented as the active default — the throw
  // aborts boot here, before any socket opens (identical discipline to the operator-token policy above).
  let champion
  try {
    champion = assertTier1Champion(publishedChampion)
  } catch (error) {
    console.error(`[wedding-planner] refusing to boot: ${(error as Error).message}`)
    process.exit(1)
  }

  const surface = composeProductSurface({
    clock: new SystemClock(),
    ids: new RandomIdGenerator(),
    operatorToken: config.operatorToken,
    providerWebhookToken: config.providerWebhookToken,
    seedDemo: config.seedDemo,
    demoSlug: config.demoSlug,
    championStrategy: champion,
  })

  const server = createProductWebUiServer(surface.ui)
  server.listen(config.port, config.host, () => {
    console.log(buildBootLog(config, surface.demo))
  })

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[wedding-planner] ${signal} received — closing server`)
    server.close(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main()
