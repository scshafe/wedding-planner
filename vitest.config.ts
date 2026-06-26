import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Resolve a path relative to this config file to an absolute filesystem path.
 * Used to alias each workspace package name to its TypeScript source barrel so
 * tests run against source without an emitting build (see ADR 0001).
 */
const fromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url))

export default defineConfig({
  test: {
    include: ['**/tests/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@wedding-planner/shared': fromRoot('./shared/src/index.ts'),
      '@wedding-planner/telemetry': fromRoot('./telemetry/src/index.ts'),
      '@wedding-planner/eval-harness': fromRoot('./eval-harness/src/index.ts'),
      '@wedding-planner/loop-orchestrator': fromRoot('./loop-orchestrator/src/index.ts'),
      '@wedding-planner/agent-operations': fromRoot('./agent-operations/src/index.ts'),
      '@wedding-planner/product': fromRoot('./product/src/index.ts'),
    },
  },
})
