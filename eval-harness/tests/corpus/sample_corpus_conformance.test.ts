import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { glob } from 'glob'
import { load as loadYaml } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { type ContractKey, REPO_ROOT, resolveFromRepoRoot, SchemaRegistry } from '@wedding-planner/shared'

/**
 * Every sample persona and scenario shipped in the repo must validate against its contract.
 * These YAML files are ground truth the graders read, so a drift between a sample and its schema
 * is a real defect — this test is the harness the plan's Step 3 verify calls for.
 */

interface CorpusFile {
  readonly repoRelativePath: string
  readonly contractKey: ContractKey
}

function contractForPath(repoRelativePath: string): ContractKey {
  if (repoRelativePath.startsWith('eval-harness/personas/')) {
    const name = basename(repoRelativePath)
    if (name.startsWith('couple_')) return 'couple_persona'
    if (name.startsWith('guest_')) return 'guest_persona'
    throw new Error(`Persona file does not start with couple_/guest_: ${repoRelativePath}`)
  }
  if (repoRelativePath.startsWith('eval-harness/scenarios/')) {
    return 'scenario'
  }
  throw new Error(`Unclassifiable corpus file: ${repoRelativePath}`)
}

async function discoverCorpusFiles(): Promise<CorpusFile[]> {
  const paths = await glob(
    ['eval-harness/personas/*.yaml', 'eval-harness/scenarios/**/*.yaml'],
    { cwd: REPO_ROOT, ignore: ['**/node_modules/**'], posix: true },
  )
  return paths.sort().map((repoRelativePath) => ({
    repoRelativePath,
    contractKey: contractForPath(repoRelativePath),
  }))
}

describe('sample corpus conformance', () => {
  const registry = new SchemaRegistry()

  it('discovers the seed corpus (personas + scenarios) on disk', async () => {
    const files = await discoverCorpusFiles()
    // 5 personas (3 couple + 2 guest) and 5 scenarios (1 golden + 4 adversarial) in the seed corpus.
    expect(files.filter((f) => f.contractKey === 'couple_persona')).toHaveLength(3)
    expect(files.filter((f) => f.contractKey === 'guest_persona')).toHaveLength(2)
    expect(files.filter((f) => f.contractKey === 'scenario')).toHaveLength(5)
  })

  it('validates every sample persona and scenario against its contract', async () => {
    const files = await discoverCorpusFiles()
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const raw = readFileSync(resolveFromRepoRoot(file.repoRelativePath), 'utf8')
      const parsed = loadYaml(raw)
      const result = registry.validate(file.contractKey, parsed)
      expect(
        result.valid,
        `${file.repoRelativePath} failed ${file.contractKey}: ${JSON.stringify(result.errors, null, 2)}`,
      ).toBe(true)
    }
  })
})
