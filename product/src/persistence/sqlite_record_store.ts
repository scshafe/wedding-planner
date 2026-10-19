import { DatabaseSync, type StatementSync } from 'node:sqlite'

import type { Clock } from '@wedding-planner/shared'

import { ProductError } from '../product_error'
import { assertSynchronousResult, type Collection, type RecordStore } from './record_store'
import { SQLITE_MIGRATIONS, type SqliteMigration } from './sqlite_migrations'

/**
 * @canonical sqlite_record_store -- the durable {@link RecordStore}: one SQLite file (issue #8, ADR 0039).
 *
 * Built on Node's built-in `node:sqlite` (no native dependency to compile into the image) through its
 * SYNCHRONOUS API, which keeps the port synchronous and a request one critical section. Every record is a row of
 * the `records` table (sqlite_migrations.ts), its JSON in `body`; reads decode a fresh copy each time, so there
 * is no cache to go stale and a rolled-back transaction leaves nothing behind in memory.
 *
 * Durability and backups: the database runs in rollback-journal mode (`journal_mode=DELETE`) with
 * `synchronous=FULL`. Between transactions the single database file IS the whole state (no `-wal` file holding
 * committed data), so the stack's file-level backup of `state/app` copies a complete database unless a write
 * happens during the copy. `busy_timeout` lets a second process (an overlapping container during a deploy) wait
 * for the lock instead of failing.
 *
 * Opening is fail-closed: an unopenable file, a schema newer than this build, or a migration history that
 * diverges from `SQLITE_MIGRATIONS` throws a `PERSISTENCE.*` ProductError, and the entrypoint refuses to boot.
 * `applied_at` comes from the injected clock (the determinism rail: no ambient time here).
 *
 * related: record_store.ts (the port), sqlite_migrations.ts (the schema), in_memory_record_store.ts (the twin).
 */

export interface OpenSqliteRecordStoreOptions {
  /** The database file (created if missing), or `':memory:'` for a throwaway database. */
  readonly path: string
  /** Stamps `schema_migrations.applied_at`. */
  readonly clock: Clock
  /** Override the migration list (tests only). */
  readonly migrations?: readonly SqliteMigration[]
}

interface BodyRow {
  readonly body: string
}

export class SqliteRecordStore implements RecordStore {
  readonly #db: DatabaseSync
  readonly #get: StatementSync
  readonly #list: StatementSync
  readonly #put: StatementSync
  readonly #delete: StatementSync
  readonly #any: StatementSync
  #depth = 0

  private constructor(db: DatabaseSync) {
    this.#db = db
    this.#get = db.prepare('SELECT body FROM records WHERE collection = ? AND partition = ? AND key = ?')
    this.#list = db.prepare('SELECT body FROM records WHERE collection = ? AND partition = ? ORDER BY seq')
    this.#put = db.prepare(
      'INSERT INTO records (collection, partition, key, body) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (collection, partition, key) DO UPDATE SET body = excluded.body',
    )
    this.#delete = db.prepare('DELETE FROM records WHERE collection = ? AND partition = ? AND key = ?')
    this.#any = db.prepare('SELECT 1 AS found FROM records WHERE collection = ? LIMIT 1')
  }

  /** Open (creating if needed) the database at `path` and bring its schema up to date. */
  static open(options: OpenSqliteRecordStoreOptions): SqliteRecordStore {
    let db: DatabaseSync
    try {
      db = new DatabaseSync(options.path)
      db.exec('PRAGMA journal_mode = DELETE')
      db.exec('PRAGMA synchronous = FULL')
      db.exec('PRAGMA busy_timeout = 5000')
    } catch (error) {
      throw new ProductError('PERSISTENCE.OPEN_FAILED', 'Could not open the database file.', {
        context: { path: options.path },
        cause: error,
      })
    }
    try {
      migrate(db, options.migrations ?? SQLITE_MIGRATIONS, options.clock)
      return new SqliteRecordStore(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  get<T>(collection: Collection<T>, partition: string, key: string): T | undefined {
    const row = this.#get.get(collection.name, partition, key) as BodyRow | undefined
    return row === undefined ? undefined : (JSON.parse(row.body) as T)
  }

  list<T>(collection: Collection<T>, partition: string): T[] {
    const rows = this.#list.all(collection.name, partition) as unknown as BodyRow[]
    return rows.map((row) => JSON.parse(row.body) as T)
  }

  put<T>(collection: Collection<T>, partition: string, key: string, record: T): void {
    this.#put.run(collection.name, partition, key, JSON.stringify(record))
  }

  delete<T>(collection: Collection<T>, partition: string, key: string): boolean {
    return Number(this.#delete.run(collection.name, partition, key).changes) > 0
  }

  isEmpty<T>(collection: Collection<T>): boolean {
    return this.#any.get(collection.name) === undefined
  }

  transaction<R>(fn: () => R): R {
    const outermost = this.#depth === 0
    const savepoint = `sp_${this.#depth}`
    this.#db.exec(outermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    this.#depth += 1
    let result: R
    try {
      result = fn()
      assertSynchronousResult(result)
    } catch (error) {
      this.#depth -= 1
      this.#db.exec(outermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
      throw error
    }
    this.#depth -= 1
    try {
      this.#db.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`)
    } catch (error) {
      if (outermost) rollbackQuietly(this.#db)
      throw error
    }
    return result
  }

  /** Close the database (shutdown and tests). The store is unusable afterwards. */
  close(): void {
    this.#db.close()
  }
}

/** Apply the pending migrations in one transaction, or refuse a database this build does not understand. */
function migrate(db: DatabaseSync, migrations: readonly SqliteMigration[], clock: Clock): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error('SQLITE_MIGRATIONS must be numbered 1, 2, 3, … with no gaps.')
  })
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT',
    )
    const applied = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as unknown as {
      version: number
      name: string
    }[]
    if (applied.length > migrations.length) {
      throw new ProductError(
        'PERSISTENCE.SCHEMA_TOO_NEW',
        'The database was migrated by a newer build than this one; restore the pre-deploy backup to roll back.',
        { context: { database_version: applied.length, build_version: migrations.length } },
      )
    }
    applied.forEach((row, index) => {
      const known = migrations[index]
      if (known === undefined || row.version !== known.version || row.name !== known.name) {
        throw new ProductError('PERSISTENCE.MIGRATION_MISMATCH', 'The database migration history does not match this build.', {
          context: { version: row.version },
        })
      }
    })
    const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    for (const migration of migrations.slice(applied.length)) {
      migration.up(db)
      record.run(migration.version, migration.name, clock.now())
    }
    db.exec('COMMIT')
  } catch (error) {
    rollbackQuietly(db)
    throw error
  }
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK')
  } catch {
    // No transaction was open (it never began, or SQLite already rolled it back).
  }
}
