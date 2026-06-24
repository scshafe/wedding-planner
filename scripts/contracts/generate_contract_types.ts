/**
 * Generate TypeScript types from the 13 JSON Schema contracts.
 *
 * What: reads each contract named in shared/src/contracts/contract_manifest.ts and emits a
 *   TypeScript module under shared/src/contracts/generated/<key>.ts via json-schema-to-typescript.
 * Inputs: none (the manifest is the source of truth). Side effects: writes generated/*.ts.
 * Idempotent: yes — same schemas in, same types out; safe to re-run.
 * Run: `npm run gen:types`.
 *
 * The schema files stay the single source of truth (root README): types are DERIVED here, never
 * hand-authored. The generated directory is eslint-ignored and must not be hand-edited.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'

import { compile, type JSONSchema } from 'json-schema-to-typescript'

import { CONTRACT_DEFINITIONS, type ContractKey } from '../../shared/src/contracts/contract_manifest'
import { resolveFromRepoRoot } from '../../shared/src/repo_root'

const GENERATED_DIR = 'shared/src/contracts/generated'

/** Map a snake_case contract key to the PascalCase root type name, e.g. event_envelope -> EventEnvelope. */
function pascalCase(key: ContractKey): string {
  return key
    .split('_')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('')
}

function bannerFor(repoRelativePath: string): string {
  return [
    '/* eslint-disable */',
    '/**',
    ` * GENERATED from ${repoRelativePath} — DO NOT EDIT BY HAND.`,
    ' * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types',
    ' */',
  ].join('\n')
}

async function main(): Promise<void> {
  mkdirSync(resolveFromRepoRoot(GENERATED_DIR), { recursive: true })

  for (const definition of CONTRACT_DEFINITIONS) {
    const schemaPath = resolveFromRepoRoot(definition.repoRelativePath)
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as JSONSchema
    const rootName = pascalCase(definition.key)

    const generated = await compile(schema, rootName, {
      bannerComment: bannerFor(definition.repoRelativePath),
      additionalProperties: false,
      // Emit interfaces for $defs that aren't $ref'd from a root (event_payloads is all $defs).
      unreachableDefinitions: true,
      declareExternallyReferenced: true,
      // Skip prettier formatting to avoid an extra runtime dependency; output is still valid TS.
      format: false,
      enableConstEnums: false,
    })

    const outPath = resolveFromRepoRoot(GENERATED_DIR, `${definition.key}.ts`)
    writeFileSync(outPath, generated, 'utf8')
    process.stdout.write(`generated ${GENERATED_DIR}/${definition.key}.ts (root: ${rootName})\n`)
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`gen:types failed: ${String(error)}\n`)
  process.exitCode = 1
})
