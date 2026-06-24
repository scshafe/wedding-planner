import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WeddingPlannerError } from './errors/wedding_planner_error'

/**
 * @canonical repo_root -- the single anchor for resolving repo-relative paths.
 *
 * The contracts (`* /schemas/*.json`) and the eval corpus (`eval-harness/personas`,
 * `eval-harness/scenarios`) are loaded from disk by absolute path. Anchoring every such
 * resolution here — computed from this module's own location, not from `process.cwd()` —
 * keeps file loading correct regardless of where a process is launched.
 *
 * This file lives at `<repo>/shared/src/repo_root.ts`, so the repo root is two directories up.
 */

const ROOT_PACKAGE_NAME = 'wedding-planner'

function verifyRepoRoot(candidate: string): string {
  const manifestPath = resolve(candidate, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new WeddingPlannerError(
      'SHARED.REPO_ROOT_NOT_FOUND',
      `Could not locate the repo root: no package.json at the computed root '${candidate}'. ` +
        'repo_root.ts may have moved relative to the repository layout.',
      { context: { candidate, manifestPath } },
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
  if (manifest.name !== ROOT_PACKAGE_NAME) {
    throw new WeddingPlannerError(
      'SHARED.REPO_ROOT_MISMATCH',
      `Computed repo root '${candidate}' has package name '${String(manifest.name)}', ` +
        `expected '${ROOT_PACKAGE_NAME}'.`,
      { context: { candidate, foundName: manifest.name } },
    )
  }
  return candidate
}

/** Absolute path to the repository root. Verified at module load (fail-fast). */
export const REPO_ROOT: string = verifyRepoRoot(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
)

/** Resolve a path from the repository root, e.g. `resolveFromRepoRoot('telemetry', 'schemas')`. */
export function resolveFromRepoRoot(...segments: string[]): string {
  return resolve(REPO_ROOT, ...segments)
}
