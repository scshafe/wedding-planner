import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { COLLECTIONS } from '../../src/persistence/collections'

/**
 * The collection census stays complete (issue #8, ADR 0039). A store that defined its own collection inline AND
 * was built in compose.ts without the shared store would write nothing to the database and be expected by no
 * census entry — invisible to the restart test. So `collection(...)` may be called only in collections.ts.
 */

const SRC = join(__dirname, '..', '..', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

describe('the collection census', () => {
  it('collection(...) is called only in persistence/collections.ts', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => !path.endsWith(join('persistence', 'collections.ts')))
      .filter((path) => !path.endsWith(join('persistence', 'record_store.ts'))) // the definition itself
      .filter((path) => /\bcollection(<[^>]*>)?\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path))
    expect(offenders).toEqual([])
  })

  it('names are unique and every collection declares a scope', () => {
    const all = Object.values(COLLECTIONS)
    expect(new Set(all.map((c) => c.name)).size).toBe(all.length)
    for (const c of all) expect(['tenant', 'global']).toContain(c.scope)
  })
})
