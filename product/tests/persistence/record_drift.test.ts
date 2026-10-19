import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type ContractKey, getSchemaRegistry, ManualClock } from '@wedding-planner/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { COLLECTIONS } from '../../src/persistence/collections'
import { SQLITE_MIGRATIONS } from '../../src/persistence/sqlite_migrations'
import { SqliteRecordStore } from '../../src/persistence/sqlite_record_store'

/**
 * Persisted-shape drift (issue #8, ADR 0039). Every test elsewhere starts from an empty store, so nothing else
 * notices when a build changes a record's shape and leaves the records an earlier build wrote behind. Each
 * `fixtures/records_vN.json` is FROZEN: the rows exactly as the build at schema version N wrote them. This test
 * loads each into a database at that version, opens it with TODAY's build (applying today's migrations), and checks:
 *
 *   - every row's collection still exists (a renamed collection needs a migration that moves its rows), and
 *   - every row of a collection with a contract validates against TODAY's schema (a newly required field, or a
 *     tightened constraint, needs a data migration that brings old rows up to it).
 *
 * Never regenerate or edit an existing fixture to make this pass; that hides exactly the bug it exists to catch.
 */

interface Fixture {
  readonly schema_version: number
  readonly rows: readonly { collection: string; partition: string; key: string; body: unknown }[]
}

const FIXTURE_DIR = join(__dirname, 'fixtures')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const fixtures = readdirSync(FIXTURE_DIR)
  .filter((name) => /^records_v\d+\.json$/.test(name))
  .sort()

describe('persisted records written by earlier builds still fit today\'s build', () => {
  it('there is at least one frozen fixture', () => {
    expect(fixtures).toContain('records_v1.json')
  })

  it.each(fixtures)('%s migrates and validates against today\'s collections and schemas', (name) => {
    const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Fixture
    const dir = mkdtempSync(join(tmpdir(), 'wp-drift-'))
    dirs.push(dir)
    const path = join(dir, 'drift.sqlite')
    const clock = new ManualClock('2026-10-19T00:00:00.000Z')

    // A database exactly at the fixture's version, holding its rows.
    SqliteRecordStore.open({ path, clock, migrations: SQLITE_MIGRATIONS.slice(0, fixture.schema_version) }).close()
    const raw = new DatabaseSync(path)
    const insert = raw.prepare('INSERT INTO records (collection, partition, key, body) VALUES (?, ?, ?, ?)')
    for (const row of fixture.rows) insert.run(row.collection, row.partition, row.key, JSON.stringify(row.body))
    raw.close()

    // Today's build migrates it.
    SqliteRecordStore.open({ path, clock }).close()

    const db = new DatabaseSync(path)
    const rows = db.prepare('SELECT collection, body FROM records ORDER BY seq').all() as { collection: string; body: string }[]
    db.close()
    const byName = new Map(Object.values(COLLECTIONS).map((c) => [c.name, c]))
    const registry = getSchemaRegistry()
    for (const row of rows) {
      const known = byName.get(row.collection)
      expect(known, `collection '${row.collection}' no longer exists`).toBeDefined()
      if (known?.schema !== undefined) {
        expect(() => registry.assertValid(known.schema as ContractKey, JSON.parse(row.body))).not.toThrow()
      }
    }
    expect(rows.length).toBeGreaterThan(0)
  })
})
