import { randomUUID } from 'node:crypto'

import { composeProductSurface, createProductWebUiServer, InMemoryRecordStore, type RecordStore } from '@wedding-planner/product'

// The edge-only primitives are imported by RELATIVE PATH on purpose: they are exported from neither the
// shared nor the product barrel, so this entrypoint is the sole place a wall clock + a non-deterministic id
// source (and, since issue #8, the database file) enter the system (the rails hold everywhere else by
// reachability).
import { SqliteRecordStore } from '../product/src/persistence/sqlite_record_store'
import { RandomIdGenerator } from '../product/src/runtime/random_id_generator'
import { SystemClock } from '../product/src/runtime/system_clock'
import { assertTier1Champion, publishedChampion } from './published_champion'
import { buildBootLog, resolveServerConfig } from './server_config'

/**
 * @canonical product_server_main -- the deployable entrypoint: the impure shell of the product surface.
 *
 * This is the ONE place ambient reality enters — `process.env`, the wall clock, crypto-random platform
 * credential tokens (operator + provider-webhook), the database file (issue #8), the listening socket, and OS
 * signals. Everything below
 * `composeProductSurface` stays injected, deterministic, and testable. The image runs this file directly via `tsx` (see the Dockerfile / `npm run
 * serve`); the build emits no JS and the workspace path aliases resolve through tsconfig.
 *
 * Boot is fail-closed: a bad/weak/absent operator credential (per the policy in server_config.ts), or a database
 * that cannot be opened or was migrated by a newer build, aborts with a non-zero exit before any socket is opened. On success it logs ONE allow-listed boot line and serves
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

  // Issue #8: the durable store when WP_DATABASE_PATH is set (migrated at open), else the in-memory demo store.
  const clock = new SystemClock()
  let store: RecordStore
  try {
    store =
      config.databasePath === undefined
        ? new InMemoryRecordStore()
        : SqliteRecordStore.open({ path: config.databasePath, clock })
  } catch (error) {
    const code = (error as { code?: string }).code
    console.error(`[wedding-planner] refusing to boot: ${code === undefined ? '' : `${code}: `}${(error as Error).message}`)
    process.exit(1)
  }

  const surface = composeProductSurface({
    clock,
    ids: new RandomIdGenerator(),
    operatorToken: config.operatorToken,
    providerWebhookToken: config.providerWebhookToken,
    seedDemo: config.seedDemo,
    demoSlug: config.demoSlug,
    championStrategy: champion,
    store,
    ...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
    buildCommit: config.buildCommit,
    // Issue #61: a model job's run is bounded by a real timer (unref'd: it never keeps the process alive).
    jobTimer: (ms, onTimeout) => {
      const timer = setTimeout(onTimeout, ms)
      timer.unref()
      return () => clearTimeout(timer)
    },
    // Issue #60: a turn of the event loop between jobs, so a burst of guest questions never starves requests.
    jobYield: () => new Promise((resolve) => setImmediate(resolve)),
  })

  // Precompute the dummy password hash so no request pays for it (uniform sign-in timing from the first request).
  surface.warmUp()
  // Issue #13: one structured JSON line per request on stdout (the route pattern only; see request_log.ts).
  const server = createProductWebUiServer(surface.ui, {
    write: (line) => console.log(line),
    clock,
    elapsedMs: () => performance.now(),
  })
  server.listen(config.port, config.host, () => {
    console.log(buildBootLog(config, surface.demo))
    // Issue #61: jobs left by a restart (queued, or claimed by a process that stopped) run at boot too.
    void surface.drainJobs().catch(() => undefined)
  })

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[wedding-planner] ${signal} received — closing server`)
    server.close(() => {
      if (store instanceof SqliteRecordStore) store.close()
      process.exit(0)
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main()
