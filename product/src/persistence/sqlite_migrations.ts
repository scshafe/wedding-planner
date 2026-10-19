import type { DatabaseSync } from 'node:sqlite'

/**
 * @canonical sqlite_migrations -- the ordered, versioned schema migrations of the durable store (ADR 0039).
 *
 * `SqliteRecordStore.open` applies every migration the database has not seen yet, in version order, inside one
 * transaction at boot, recording each in `schema_migrations` (version, name, applied_at, older_builds_can_read).
 * The rules:
 *
 *   - APPEND ONLY. A released migration is never edited, renumbered or removed; a change is a new migration.
 *     `open` refuses a database whose applied (version, name) pairs are not a prefix of this list
 *     (PERSISTENCE.MIGRATION_MISMATCH) — a database written by a diverged build is never silently reused.
 *   - ROLLBACK-SAFE BY DEFAULT. Each migration declares `olderBuildsCanRead`: true when a build that predates it
 *     can still run correctly on the migrated database (an added table or index, an added optional field its
 *     validators accept). An older build opens a newer database only when every migration it does not know is
 *     readable by it; otherwise it refuses (PERSISTENCE.SCHEMA_TOO_NEW) and the restore point is the
 *     `.pre-vN.sqlite` snapshot `open` writes before migrating, or the pre-deploy backup. A migration with
 *     `olderBuildsCanRead: false` breaks the host's automatic rollback, so it needs an expand step deployed
 *     first and an owner sign-off (a `status:needs-owner` issue) before it merges (ADR 0039, "Rollback").
 *   - Most product changes need no migration at all: a new kind of record is a new collection name in the
 *     existing `records` table. A NEW FIELD on an existing record ships expand-then-contract: first the schema
 *     that accepts it (deployed), then the code that writes it — because every product schema is
 *     `additionalProperties: false`, an older build re-validating a record that carries an unknown field fails.
 *   - Data migrations (reshaping the JSON of an existing collection) go here too, as SQL or as code over the
 *     rows, so a record read by the running build always has the shape that build validates on write. The drift
 *     test (tests/persistence/record_drift.test.ts) migrates a fixture written by an earlier build and
 *     validates every row against today's schemas, so a required field added without its data migration fails CI.
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
  /** Whether a build that predates this migration still runs correctly on the migrated database. */
  readonly olderBuildsCanRead: boolean
}

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = Object.freeze([
  {
    version: 1,
    name: 'records',
    // Irrelevant for the first migration (no older build reads a database), and false to be safe.
    olderBuildsCanRead: false,
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
