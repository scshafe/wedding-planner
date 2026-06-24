import { readFileSync } from 'node:fs'

import {
  type ContractKey,
  type CouplePersona,
  getSchemaRegistry,
  type GuestPersona,
  resolveFromRepoRoot,
  type Scenario,
} from '@wedding-planner/shared'
import { load as loadYaml } from 'js-yaml'

import { EvalHarnessError } from '../eval_harness_error'

/**
 * @canonical corpus_loader -- loads and validates the eval corpus (personas, scenarios) from disk.
 *
 * Personas and scenarios are YAML ground truth the graders read; this loader is the one place they
 * are read and validated against their JSON Schema contract, returning typed objects. A file that
 * does not conform raises EVAL.CORPUS_INVALID rather than flowing a malformed persona into a gate.
 *
 * related: corpus_paths.ts, schema registry, gates/* (consume the loaded personas as ground truth).
 */

function loadAndValidate<T>(contractKey: ContractKey, repoRelativePath: string, label: string): T {
  const raw = readFileSync(resolveFromRepoRoot(repoRelativePath), 'utf8')
  const parsed = loadYaml(raw)
  const result = getSchemaRegistry().validate<T>(contractKey, parsed)
  if (!result.valid) {
    throw new EvalHarnessError(
      'EVAL.CORPUS_INVALID',
      `${label} does not conform to the '${contractKey}' contract.`,
      { context: { repoRelativePath, validationErrors: result.errors } },
    )
  }
  return result.data
}

/** Load a couple persona by id (e.g. 'couple_standard_baseline'). */
export function loadCouplePersona(personaId: string): CouplePersona {
  return loadAndValidate<CouplePersona>(
    'couple_persona',
    `eval-harness/personas/${personaId}.yaml`,
    personaId,
  )
}

/** Load a guest persona by id (e.g. 'guest_multilingual_dietary'). */
export function loadGuestPersona(personaId: string): GuestPersona {
  return loadAndValidate<GuestPersona>(
    'guest_persona',
    `eval-harness/personas/${personaId}.yaml`,
    personaId,
  )
}

/** Load a scenario by id; the golden_/adversarial_ prefix selects the subdirectory. */
export function loadScenario(scenarioId: string): Scenario {
  const subdir = scenarioId.startsWith('golden_') ? 'golden' : 'adversarial'
  return loadAndValidate<Scenario>(
    'scenario',
    `eval-harness/scenarios/${subdir}/${scenarioId}.yaml`,
    scenarioId,
  )
}
