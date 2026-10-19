import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ManualClock } from '@wedding-planner/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { collection, SQLITE_MIGRATIONS, type SqliteMigration, SqliteRecordStore } from '@wedding-planner/product'

/**
 * The durable adapter's own behavior (issue #8, ADR 0039): data survives closing and reopening the file, the
 * migrations run once and are recorded, and opening is fail-closed on a database this build does not understand.
 */

const NOTES = collection<{ readonly text: string }>('note')
const clock = new ManualClock('2027-05-01T12:00:00.000Z')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp-sqlite-'))
  dirs.push(dir)
  return join(dir, 'wedding-planner.sqlite')
}

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  throw new Error('expected the operation to throw, but it did not')
}

describe('SqliteRecordStore', () => {
  it('data written before close is read back after reopening the same file', () => {
    const path = tempDb()
    const first = SqliteRecordStore.open({ path, clock })
    first.put(NOTES, 'p', 'a', { text: 'kept' })
    first.transaction(() => first.put(NOTES, 'p', 'b', { text: 'kept too' }))
    first.close()

    const second = SqliteRecordStore.open({ path, clock })
    expect(second.list(NOTES, 'p')).toEqual([{ text: 'kept' }, { text: 'kept too' }])
    second.close()
  })

  it('a rolled-back transaction leaves nothing in the file', () => {
    const path = tempDb()
    const store = SqliteRecordStore.open({ path, clock })
    expect(() =>
      store.transaction(() => {
        store.put(NOTES, 'p', 'a', { text: 'x' })
        throw new Error('fail')
      }),
    ).toThrow('fail')
    store.close()
    const reopened = SqliteRecordStore.open({ path, clock })
    expect(reopened.isEmpty(NOTES)).toBe(true)
    reopened.close()
  })

  it('applies the migrations once, recording version, name and the injected clock time', () => {
    const path = tempDb()
    SqliteRecordStore.open({ path, clock }).close()
    SqliteRecordStore.open({ path, clock: new ManualClock('2030-01-01T00:00:00.000Z') }).close()

    const db = new DatabaseSync(path)
    const rows = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all()
    db.close()
    expect(rows).toEqual(
      SQLITE_MIGRATIONS.map((m) => ({ version: m.version, name: m.name, applied_at: '2027-05-01T12:00:00.000Z' })),
    )
  })

  it('runs the journal in rollback mode, so the database file alone holds every committed write', () => {
    const path = tempDb()
    const store = SqliteRecordStore.open({ path, clock })
    store.put(NOTES, 'p', 'a', { text: 'x' })
    store.close()
    const db = new DatabaseSync(path)
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    db.close()
  })

  it('refuses a database migrated by a newer build (PERSISTENCE.SCHEMA_TOO_NEW)', () => {
    const path = tempDb()
    const newer: SqliteMigration[] = [
      ...SQLITE_MIGRATIONS,
      { version: SQLITE_MIGRATIONS.length + 1, name: 'from_the_future', up: () => {} },
    ]
    SqliteRecordStore.open({ path, clock, migrations: newer }).close()
    expect(codeOfThrow(() => SqliteRecordStore.open({ path, clock }))).toBe('PERSISTENCE.SCHEMA_TOO_NEW')
  })

  it('refuses a database whose migration history diverges from this build (PERSISTENCE.MIGRATION_MISMATCH)', () => {
    const path = tempDb()
    // Same schema as this build's v1, recorded under a different name (a diverged branch's database).
    const diverged: SqliteMigration[] = [{ version: 1, name: 'something_else', up: (db) => SQLITE_MIGRATIONS[0]?.up(db) }]
    SqliteRecordStore.open({ path, clock, migrations: diverged }).close()
    expect(codeOfThrow(() => SqliteRecordStore.open({ path, clock }))).toBe('PERSISTENCE.MIGRATION_MISMATCH')
  })

  it('a migration that throws aborts the open and leaves no partial schema behind', () => {
    const path = tempDb()
    const failing: SqliteMigration[] = [
      ...SQLITE_MIGRATIONS,
      {
        version: SQLITE_MIGRATIONS.length + 1,
        name: 'half_done',
        up: (db) => {
          db.exec('CREATE TABLE half (x TEXT)')
          throw new Error('migration failed')
        },
      },
    ]
    expect(() => SqliteRecordStore.open({ path, clock, migrations: failing })).toThrow('migration failed')
    const db = new DatabaseSync(path)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    db.close()
    expect(tables).toEqual([])
  })

  it('an unopenable path fails closed (PERSISTENCE.OPEN_FAILED)', () => {
    const missingDir = join(tempDb(), 'no', 'such', 'dir', 'db.sqlite')
    expect(codeOfThrow(() => SqliteRecordStore.open({ path: missingDir, clock }))).toBe('PERSISTENCE.OPEN_FAILED')
  })

  it('refuses a migration list with a gap (a programming error, caught at boot)', () => {
    const gappy: SqliteMigration[] = [{ version: 2, name: 'gap', up: () => {} }]
    expect(() => SqliteRecordStore.open({ path: ':memory:', clock, migrations: gappy })).toThrow(/no gaps/)
  })
})
