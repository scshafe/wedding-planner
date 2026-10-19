import { assertSynchronousResult, type Collection, type RecordStore } from './record_store'

/**
 * @canonical in_memory_record_store -- the in-memory {@link RecordStore}: the test adapter and the demo default.
 *
 * Records are held as their JSON text, so this adapter behaves like the durable one: every read decodes a fresh
 * copy (a caller mutating a returned record cannot change the store) and a value that does not survive JSON
 * (an `undefined` key, a Date) is caught here, in the fast tests, rather than only against SQLite.
 *
 * Ordering is the backing `Map`'s insertion order, which is exactly the port's contract (replace keeps the
 * position; delete-then-put moves to the end). A transaction snapshots the maps when it begins and restores the
 * snapshot if `fn` throws. The snapshot copies only the map structure (the values are immutable strings), which
 * is cheap at test and demo scale.
 *
 * The backing map is `#`-private: it never enumerates, so a store does not leak through `JSON.stringify`.
 *
 * related: record_store.ts (the port and its guarantees), sqlite_record_store.ts (the durable twin).
 */

/** collection -> partition -> key -> record JSON. */
type Tables = Map<string, Map<string, Map<string, string>>>

export class InMemoryRecordStore implements RecordStore {
  #tables: Tables = new Map()

  get<T>(collection: Collection<T>, partition: string, key: string): T | undefined {
    const text = this.#tables.get(collection.name)?.get(partition)?.get(key)
    return text === undefined ? undefined : (JSON.parse(text) as T)
  }

  list<T>(collection: Collection<T>, partition: string): T[] {
    const rows = this.#tables.get(collection.name)?.get(partition)
    if (rows === undefined) return []
    return [...rows.values()].map((text) => JSON.parse(text) as T)
  }

  put<T>(collection: Collection<T>, partition: string, key: string, record: T): void {
    const text = JSON.stringify(record)
    let partitions = this.#tables.get(collection.name)
    if (partitions === undefined) {
      partitions = new Map()
      this.#tables.set(collection.name, partitions)
    }
    let rows = partitions.get(partition)
    if (rows === undefined) {
      rows = new Map()
      partitions.set(partition, rows)
    }
    rows.set(key, text)
  }

  delete<T>(collection: Collection<T>, partition: string, key: string): boolean {
    return this.#tables.get(collection.name)?.get(partition)?.delete(key) ?? false
  }

  isEmpty<T>(collection: Collection<T>): boolean {
    const partitions = this.#tables.get(collection.name)
    if (partitions === undefined) return true
    for (const rows of partitions.values()) if (rows.size > 0) return false
    return true
  }

  transaction<R>(fn: () => R): R {
    // Every level snapshots (the savepoint analogue), so a nested call that throws undoes only its own writes,
    // even when the outer call catches the error and carries on.
    const snapshot = copyTables(this.#tables)
    try {
      const result = fn()
      assertSynchronousResult(result)
      return result
    } catch (error) {
      this.#tables = snapshot
      throw error
    }
  }
}

function copyTables(tables: Tables): Tables {
  const copy: Tables = new Map()
  for (const [name, partitions] of tables) {
    const partitionsCopy = new Map<string, Map<string, string>>()
    for (const [partition, rows] of partitions) partitionsCopy.set(partition, new Map(rows))
    copy.set(name, partitionsCopy)
  }
  return copy
}
