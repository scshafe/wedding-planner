import { describe, expect, it } from 'vitest'

import { SHARED_PACKAGE_NAME } from '@wedding-planner/shared'

/**
 * Scaffold smoke test: proves the toolchain end-to-end — vitest runs TypeScript source,
 * the `@wedding-planner/*` workspace alias resolves to the package barrel, and the suite is
 * non-empty so `npm test` exercises a real path. Replaced by real coverage as capabilities land.
 */
describe('workspace scaffold', () => {
  it('resolves the shared package barrel through its workspace alias', () => {
    expect(SHARED_PACKAGE_NAME).toBe('@wedding-planner/shared')
  })
})
