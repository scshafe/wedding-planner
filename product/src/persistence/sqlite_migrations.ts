import type { DatabaseSync } from 'node:sqlite'

/**
 * @canonical sqlite_migrations -- the ordered, versioned schema migrations of the durable store (ADR 0039).
 *
 * `SqliteRecordStore.open` applies every migration the database has not seen yet, in version order, inside one
 * transaction at boot, recording each in `schema_migrations` (version, name, applied_at). The rules:
 *
 *   - APPEND ONLY. A released migration is never edited, renumbered or removed; a change is a new migration.
 *     `open` refuses a database whose applied (version, name) pairs are not a prefix of this list
 *     (PERSISTENCE.MIGRATION_MISMATCH) — a database written by a diverged build is never silently reused.
 *   - FORWARD ONLY. A database migrated by a newer build is refused by an older one
 *     (PERSISTENCE.SCHEMA_TOO_NEW), so rolling the code back past a migration needs the pre-deploy backup. Most
 *     product changes need no migration at all: a new kind of record is a new collection name in the existing
 *     `records` table.
 *   - Data migrations (reshaping the JSON of an existing collection) go here too, as SQL or as code over the
 *     rows, so a record read by the running build always has the shape that build validates on write.
 *
 * related: sqlite_record_store.ts (the runner), record_store.ts (the port the `records` table backs).
 */

export interface SqliteMigration {
  /** 1, 2, 3, … with no gaps. */
  readonly version: number
  /** A short snake_case description, recorded alongside the version. */
  readonly name: string
  /** Apply the migration. Runs inside the boot transaction; throw to abort the boot. */
  readonly up: (db: DatabaseSync) => void
}

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = Object.freeze([
  {
    version: 1,
    name: 'records',
    up: (db: DatabaseSync) => {
      // `seq` is the rowid alias: it orders a partition by first insertion, and an upsert keeps it, which is
      // the port's `list` order. (collection, partition, key) is the record's address.
      db.exec(`
        CREATE TABLE records (
          seq INTEGER PRIMARY KEY,
          collection TEXT NOT NULL,
          partition TEXT NOT NULL,
          key TEXT NOT NULL,
          body TEXT NOT NULL,
          UNIQUE (collection, partition, key)
        ) STRICT
      `)
    },
  },
])
