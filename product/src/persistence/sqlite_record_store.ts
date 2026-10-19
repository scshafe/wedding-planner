import { chmodSync, existsSync } from 'node:fs'
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
 * happens during the copy. `busy_timeout` is set FIRST, so a second process (an overlapping container during a
 * deploy) waits for the lock instead of failing the open.
 *
 * Hardening: `secure_delete` overwrites deleted content (a removed guest does not linger in the file or its
 * backups); `max_page_count` caps the file (default 1 GiB), so a runaway writer fails its own requests instead of
 * filling the host disk; the file is made owner-only (0600).
 *
 * Opening is fail-closed (PERSISTENCE.* codes; the entrypoint refuses to boot): an unopenable file, a migration
 * history that diverges from `SQLITE_MIGRATIONS`, or a database migrated by a newer build with a migration that
 * older builds cannot read. A newer database whose extra migrations are all `olderBuildsCanRead` opens normally,
 * so rolling a deploy back across an additive migration works. Before applying migrations to an existing
 * database, `open` writes a consistent snapshot next to it (`VACUUM INTO`), the restore point for a migration
 * that turns out wrong. `applied_at` comes from the injected clock (the determinism rail: no ambient time here).
 *
 * Runtime failures (disk full, I/O, a lock held too long) surface as PERSISTENCE.STORAGE_FAILED with the SQLite
 * error as `cause`; the request's transaction rolls back and the client gets the constant 500.
 *
 * related: record_store.ts (the port), sqlite_migrations.ts (the schema), in_memory_record_store.ts (the twin).
 */

/** The default size cap of the database file. */
export const DEFAULT_MAX_DATABASE_BYTES = 1024 * 1024 * 1024

export interface OpenSqliteRecordStoreOptions {
  /** The database file (created if missing), or `':memory:'` for a throwaway database. */
  readonly path: string
  /** Stamps `schema_migrations.applied_at`. */
  readonly clock: Clock
  /** Override the migration list (tests only). */
  readonly migrations?: readonly SqliteMigration[]
  /** Override the size cap (tests only). */
  readonly maxDatabaseBytes?: number
}

interface BodyRow {
  readonly body: string
}

interface AppliedMigrationRow {
  readonly version: number
  readonly name: string
  readonly older_builds_can_read: number
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
    const migrations = options.migrations ?? SQLITE_MIGRATIONS
    assertWellFormed(migrations)
    const onDisk = options.path !== ':memory:'
    let db: DatabaseSync
    try {
      db = new DatabaseSync(options.path)
      // busy_timeout FIRST: the PRAGMAs below take locks, and must wait for (not fail on) another process.
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('PRAGMA journal_mode = DELETE')
      db.exec('PRAGMA synchronous = FULL')
      db.exec('PRAGMA secure_delete = ON')
      const pageSize = Number((db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)
      const maxBytes = options.maxDatabaseBytes ?? DEFAULT_MAX_DATABASE_BYTES
      db.exec(`PRAGMA max_page_count = ${Math.max(1, Math.floor(maxBytes / pageSize))}`)
    } catch (error) {
      throw new ProductError('PERSISTENCE.OPEN_FAILED', 'Could not open the database file.', {
        context: { path: options.path },
        cause: error,
      })
    }
    try {
      if (onDisk) ownerOnly(options.path)
      migrate(db, migrations, options.clock, onDisk ? options.path : undefined)
      return new SqliteRecordStore(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  get<T>(collection: Collection<T>, partition: string, key: string): T | undefined {
    const row = storage(() => this.#get.get(collection.name, partition, key)) as BodyRow | undefined
    return row === undefined ? undefined : (JSON.parse(row.body) as T)
  }

  list<T>(collection: Collection<T>, partition: string): T[] {
    const rows = storage(() => this.#list.all(collection.name, partition)) as unknown as BodyRow[]
    return rows.map((row) => JSON.parse(row.body) as T)
  }

  put<T>(collection: Collection<T>, partition: string, key: string, record: T): void {
    const body = JSON.stringify(record)
    storage(() => this.#put.run(collection.name, partition, key, body))
  }

  delete<T>(collection: Collection<T>, partition: string, key: string): boolean {
    return Number(storage(() => this.#delete.run(collection.name, partition, key)).changes) > 0
  }

  isEmpty<T>(collection: Collection<T>): boolean {
    return storage(() => this.#any.get(collection.name)) === undefined
  }

  transaction<R>(fn: () => R): R {
    const outermost = this.#depth === 0
    const savepoint = `sp_${this.#depth}`
    storage(() => this.#db.exec(outermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`))
    this.#depth += 1
    let result: R
    try {
      result = fn()
      assertSynchronousResult(result)
    } catch (error) {
      this.#depth -= 1
      // Quietly: SQLite may already have rolled back on its own (disk full, I/O), and a failing ROLLBACK must
      // never replace the error that actually happened.
      if (outermost) execQuietly(this.#db, 'ROLLBACK')
      else execQuietly(this.#db, `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
      throw error
    }
    this.#depth -= 1
    try {
      storage(() => this.#db.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`))
    } catch (error) {
      if (outermost) execQuietly(this.#db, 'ROLLBACK')
      throw error
    }
    return result
  }

  /** Close the database (shutdown and tests). The store is unusable afterwards. */
  close(): void {
    this.#db.close()
  }
}

/** Refuse a malformed migration list (a programming error, caught at boot). */
function assertWellFormed(migrations: readonly SqliteMigration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new ProductError('PERSISTENCE.INVALID_MIGRATIONS', 'SQLITE_MIGRATIONS must be numbered 1, 2, 3, … with no gaps.', {
        context: { index, version: migration.version },
      })
    }
  })
}

/**
 * Bring the schema up to date in one transaction, or refuse a database this build does not understand.
 * `databasePath` (when on disk) is where the pre-migration snapshot is written beside.
 */
function migrate(db: DatabaseSync, migrations: readonly SqliteMigration[], clock: Clock, databasePath: string | undefined): void {
  const readApplied = (): AppliedMigrationRow[] => {
    const exists = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
    if (exists === undefined) return []
    return db
      .prepare('SELECT version, name, older_builds_can_read FROM schema_migrations ORDER BY version')
      .all() as unknown as AppliedMigrationRow[]
  }

  // The restore point: an existing database about to be migrated gets a consistent copy first. VACUUM INTO cannot
  // run inside a transaction, so this happens before BEGIN; an existing snapshot for the same step is kept.
  const before = readApplied()
  if (databasePath !== undefined && before.length > 0 && before.length < migrations.length) {
    const snapshot = `${databasePath}.pre-v${before.length + 1}.sqlite`
    if (!existsSync(snapshot)) {
      db.prepare('VACUUM INTO ?').run(snapshot)
      ownerOnly(snapshot)
    }
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (' +
        'version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, older_builds_can_read INTEGER NOT NULL' +
        ') STRICT',
    )
    // Re-read under the lock: another process may have migrated meanwhile.
    const applied = readApplied()
    applied.slice(0, migrations.length).forEach((row, index) => {
      const known = migrations[index]
      if (known === undefined || row.version !== known.version || row.name !== known.name) {
        throw new ProductError('PERSISTENCE.MIGRATION_MISMATCH', 'The database migration history does not match this build.', {
          context: { version: row.version },
        })
      }
    })
    const unknown = applied.slice(migrations.length)
    if (unknown.some((row) => row.older_builds_can_read !== 1)) {
      throw new ProductError(
        'PERSISTENCE.SCHEMA_TOO_NEW',
        'The database was migrated by a newer build with a change this build cannot read; restore the pre-migration snapshot or backup to roll back.',
        { context: { database_version: applied.length, build_version: migrations.length } },
      )
    }
    const record = db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at, older_builds_can_read) VALUES (?, ?, ?, ?)',
    )
    for (const migration of migrations.slice(applied.length)) {
      migration.up(db)
      record.run(migration.version, migration.name, clock.now(), migration.olderBuildsCanRead ? 1 : 0)
    }
    db.exec('COMMIT')
  } catch (error) {
    execQuietly(db, 'ROLLBACK')
    throw error
  }
}

/** Run a storage operation, surfacing a SQLite failure as PERSISTENCE.STORAGE_FAILED (the cause preserved). */
function storage<R>(operation: () => R): R {
  try {
    return operation()
  } catch (error) {
    if (error instanceof ProductError) throw error
    throw new ProductError('PERSISTENCE.STORAGE_FAILED', 'A database operation failed.', { cause: error })
  }
}

/** Make a database file readable and writable by its owner only. Best effort: hardening, never a boot blocker. */
function ownerOnly(path: string): void {
  try {
    chmodSync(path, 0o600)
  } catch {
    // A filesystem that does not support modes (or a path we do not own) keeps its defaults.
  }
}

function execQuietly(db: DatabaseSync, sql: string): void {
  try {
    db.exec(sql)
  } catch {
    // Nothing to undo (SQLite already rolled back, or no transaction was open).
  }
}
