import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ManualClock } from '@wedding-planner/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { InMemoryRecordStore, type RecordStore } from '@wedding-planner/product'

import { collection, GLOBAL_PARTITION, groupedKey, keyPrefixOf } from '../../src/persistence/record_store'
import { SqliteRecordStore } from '../../src/persistence/sqlite_record_store'

/**
 * The RecordStore CONTRACT (issue #8, ADR 0039): the guarantees every product store relies on, run against each
 * adapter — in-memory, SQLite in memory, and SQLite on a real file — so the two adapters cannot drift apart.
 */

interface Note {
  readonly id: string
  readonly text: string
  readonly tags?: readonly string[]
}

const NOTES = collection<Note>('note', 'tenant')
const OTHER = collection<Note>('other_note', 'tenant')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const clock = new ManualClock('2027-01-01T00:00:00.000Z')
const ADAPTERS: readonly (readonly [string, () => RecordStore])[] = [
  ['in-memory', () => new InMemoryRecordStore()],
  ['sqlite :memory:', () => SqliteRecordStore.open({ path: ':memory:', clock })],
  [
    'sqlite file',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'wp-record-store-'))
      dirs.push(dir)
      return SqliteRecordStore.open({ path: join(dir, 'contract.sqlite'), clock })
    },
  ],
]

describe.each(ADAPTERS)('RecordStore contract (%s)', (_adapter, makeStore) => {
  it('get returns what put stored, and undefined for an absent key', () => {
    const store = makeStore()
    store.put(NOTES, 'p1', 'a', { id: 'a', text: 'hello', tags: ['x'] })
    expect(store.get(NOTES, 'p1', 'a')).toEqual({ id: 'a', text: 'hello', tags: ['x'] })
    expect(store.get(NOTES, 'p1', 'missing')).toBeUndefined()
  })

  it('partitions and collections are separate address spaces (no cross-partition read)', () => {
    const store = makeStore()
    store.put(NOTES, 'tenant_a', 'k', { id: 'k', text: 'A' })
    store.put(NOTES, 'tenant_b', 'k', { id: 'k', text: 'B' })
    store.put(OTHER, 'tenant_a', 'k', { id: 'k', text: 'other' })
    expect(store.get(NOTES, 'tenant_a', 'k')?.text).toBe('A')
    expect(store.get(NOTES, 'tenant_b', 'k')?.text).toBe('B')
    expect(store.get(OTHER, 'tenant_a', 'k')?.text).toBe('other')
    expect(store.list(NOTES, 'tenant_a')).toEqual([{ id: 'k', text: 'A' }])
    expect(store.get(NOTES, GLOBAL_PARTITION, 'k')).toBeUndefined()
    expect(store.delete(NOTES, 'tenant_c', 'k')).toBe(false)
    expect(store.get(NOTES, 'tenant_b', 'k')?.text).toBe('B')
  })

  it('list is first-insertion order; a replace keeps its position; delete-then-put moves to the end', () => {
    const store = makeStore()
    for (const id of ['c', 'a', 'b']) store.put(NOTES, 'p', id, { id, text: id })
    store.put(NOTES, 'p', 'c', { id: 'c', text: 'c2' })
    expect(store.list(NOTES, 'p').map((n) => `${n.id}:${n.text}`)).toEqual(['c:c2', 'a:a', 'b:b'])
    expect(store.delete(NOTES, 'p', 'a')).toBe(true)
    store.put(NOTES, 'p', 'a', { id: 'a', text: 'back' })
    expect(store.list(NOTES, 'p').map((n) => n.id)).toEqual(['c', 'b', 'a'])
    expect(store.list(NOTES, 'empty')).toEqual([])
  })

  it('listByKeyPrefix returns one group in first-insertion order, never a sibling group or another partition', () => {
    const store = makeStore()
    store.put(NOTES, 'p', 'w1/b', { id: 'b', text: 'w1 b' })
    store.put(NOTES, 'p', 'w10/a', { id: 'a', text: 'w10 a' }) // `w1/` must not match `w10/`
    store.put(NOTES, 'p', 'w1/a', { id: 'a', text: 'w1 a' })
    store.put(NOTES, 'p', 'w1', { id: 'w1', text: 'no slash' })
    store.put(NOTES, 'p', 'w1.a', { id: 'w1.a', text: 'just below the slash' })
    store.put(NOTES, 'p', 'w10', { id: 'w10', text: 'the range end itself' })
    store.put(NOTES, 'p', 'w1/', { id: '', text: 'empty id' })
    store.put(NOTES, 'q', 'w1/c', { id: 'c', text: 'other partition' })
    store.put(OTHER, 'p', 'w1/d', { id: 'd', text: 'other collection' })
    store.put(NOTES, 'p', 'w1/b', { id: 'b', text: 'w1 b replaced' }) // a replace keeps its position
    expect(store.listByKeyPrefix(NOTES, 'p', 'w1/').map((n) => n.text)).toEqual(['w1 b replaced', 'w1 a', 'empty id'])
    expect(store.listByKeyPrefix(NOTES, 'p', 'w10/').map((n) => n.text)).toEqual(['w10 a'])
    expect(store.listByKeyPrefix(NOTES, 'p', 'w2/')).toEqual([])
    expect(store.listByKeyPrefix(NOTES, 'empty', 'w1/')).toEqual([])
    store.delete(NOTES, 'p', 'w1/b')
    expect(store.listByKeyPrefix(NOTES, 'p', 'w1/').map((n) => n.text)).toEqual(['w1 a', 'empty id'])
    store.put(NOTES, 'p', 'w1/b', { id: 'b', text: 'w1 b again' }) // delete-then-put moves to the group's end
    expect(store.listByKeyPrefix(NOTES, 'p', 'w1/').map((n) => n.text)).toEqual(['w1 a', 'empty id', 'w1 b again'])
  })

  it('listByKeyPrefix reads a nested group, and sees a transaction\'s own writes and none of a rolled-back one', () => {
    const store = makeStore()
    store.put(NOTES, 'p', 'w1/e1/a', { id: 'a', text: 'nested' })
    store.put(NOTES, 'p', 'w1/e2/a', { id: 'a', text: 'other event' })
    expect(store.listByKeyPrefix(NOTES, 'p', 'w1/e1/').map((n) => n.text)).toEqual(['nested'])
    expect(store.listByKeyPrefix(NOTES, 'p', 'w1/')).toHaveLength(2)
    store.transaction(() => {
      store.put(NOTES, 'p', 'g/in', { id: 'in', text: 'inside' })
      expect(store.listByKeyPrefix(NOTES, 'p', 'g/').map((n) => n.text)).toEqual(['inside'])
    })
    expect(() =>
      store.transaction(() => {
        store.put(NOTES, 'p', 'g/gone', { id: 'gone', text: 'rolled back' })
        throw new Error('fail')
      }),
    ).toThrow('fail')
    expect(store.listByKeyPrefix(NOTES, 'p', 'g/').map((n) => n.text)).toEqual(['inside'])
  })

  it('listByKeyPrefix matches non-ASCII group ids exactly', () => {
    const store = makeStore()
    store.put(NOTES, 'p', 'é/1', { id: '1', text: 'e-acute' })
    store.put(NOTES, 'p', 'é0/1', { id: '1', text: 'e-acute zero' })
    store.put(NOTES, 'p', 'e/1', { id: '1', text: 'plain e' })
    expect(store.listByKeyPrefix(NOTES, 'p', 'é/').map((n) => n.text)).toEqual(['e-acute'])
  })

  it('listByKeyPrefix refuses a prefix that is empty or does not end with / (PERSISTENCE.INVALID_KEY_PREFIX)', () => {
    const store = makeStore()
    for (const bad of ['', '/', 'w1', 'w1/x']) {
      expect(() => store.listByKeyPrefix(NOTES, 'p', bad)).toThrow(expect.objectContaining({ code: 'PERSISTENCE.INVALID_KEY_PREFIX' }))
    }
  })

  it('listByKeyPrefix reads fresh copies', () => {
    const store = makeStore()
    store.put(NOTES, 'p', 'g/a', { id: 'a', text: 'kept', tags: ['x'] })
    const [first] = store.listByKeyPrefix(NOTES, 'p', 'g/') as Note[]
    ;(first?.tags as string[]).push('mutated')
    expect(store.get(NOTES, 'p', 'g/a')).toEqual({ id: 'a', text: 'kept', tags: ['x'] })
  })

  it('delete reports whether a record existed', () => {
    const store = makeStore()
    store.put(NOTES, 'p', 'a', { id: 'a', text: 'x' })
    expect(store.delete(NOTES, 'p', 'a')).toBe(true)
    expect(store.delete(NOTES, 'p', 'a')).toBe(false)
    expect(store.get(NOTES, 'p', 'a')).toBeUndefined()
  })

  it('reads are fresh copies: mutating a returned record never changes the store', () => {
    const store = makeStore()
    store.put(NOTES, 'p', 'a', { id: 'a', text: 'original', tags: ['t'] })
    // Cast away readonly to try what a careless caller might do.
    const read = store.get(NOTES, 'p', 'a') as unknown as { text: string; tags: string[] }
    read.text = 'mutated'
    read.tags.push('extra')
    const listed = store.list(NOTES, 'p') as unknown as { text: string }[]
    ;(listed[0] as { text: string }).text = 'mutated too'
    expect(store.get(NOTES, 'p', 'a')).toEqual({ id: 'a', text: 'original', tags: ['t'] })
  })

  it('records hold JSON values only: an undefined-valued key is dropped, not stored', () => {
    const store = makeStore()
    store.put(NOTES, 'p', 'a', { id: 'a', text: 'x', tags: undefined })
    expect(Object.keys(store.get(NOTES, 'p', 'a') ?? {})).toEqual(['id', 'text'])
  })

  it('isEmpty looks across every partition of one collection', () => {
    const store = makeStore()
    expect(store.isEmpty(NOTES)).toBe(true)
    store.put(OTHER, 'p', 'a', { id: 'a', text: 'x' })
    expect(store.isEmpty(NOTES)).toBe(true)
    store.put(NOTES, 'some_tenant', 'a', { id: 'a', text: 'x' })
    expect(store.isEmpty(NOTES)).toBe(false)
    store.delete(NOTES, 'some_tenant', 'a')
    expect(store.isEmpty(NOTES)).toBe(true)
  })

  it('a transaction commits every write together and returns the body result', () => {
    const store = makeStore()
    const result = store.transaction(() => {
      store.put(NOTES, 'p', 'a', { id: 'a', text: '1' })
      store.put(NOTES, 'p', 'b', { id: 'b', text: '2' })
      return 'done'
    })
    expect(result).toBe('done')
    expect(store.list(NOTES, 'p').map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('a throwing transaction rolls back every write (puts, replaces and deletes) and rethrows', () => {
    const store = makeStore()
    store.put(NOTES, 'p', 'keep', { id: 'keep', text: 'before' })
    store.put(NOTES, 'p', 'gone', { id: 'gone', text: 'before' })
    const boom = new Error('boom')
    expect(() =>
      store.transaction(() => {
        store.put(NOTES, 'p', 'new', { id: 'new', text: 'x' })
        store.put(NOTES, 'p', 'keep', { id: 'keep', text: 'after' })
        store.delete(NOTES, 'p', 'gone')
        throw boom
      }),
    ).toThrow(boom)
    expect(store.list(NOTES, 'p')).toEqual([
      { id: 'keep', text: 'before' },
      { id: 'gone', text: 'before' },
    ])
  })

  it('a nested transaction is a savepoint: its failure undoes only its own writes', () => {
    const store = makeStore()
    store.transaction(() => {
      store.put(NOTES, 'p', 'outer', { id: 'outer', text: 'x' })
      try {
        store.transaction(() => {
          store.put(NOTES, 'p', 'inner', { id: 'inner', text: 'x' })
          throw new Error('inner fails')
        })
      } catch {
        // The outer body carries on.
      }
      store.transaction(() => store.put(NOTES, 'p', 'inner2', { id: 'inner2', text: 'x' }))
    })
    expect(store.list(NOTES, 'p').map((n) => n.id)).toEqual(['outer', 'inner2'])
  })

  it('an outer failure rolls back writes a nested transaction had already released', () => {
    const store = makeStore()
    expect(() =>
      store.transaction(() => {
        store.transaction(() => store.put(NOTES, 'p', 'inner', { id: 'inner', text: 'x' }))
        throw new Error('outer fails')
      }),
    ).toThrow('outer fails')
    expect(store.list(NOTES, 'p')).toEqual([])
  })

  it('a transaction body that returns a promise is refused and rolled back', () => {
    const store = makeStore()
    expect(() =>
      store.transaction(() => {
        store.put(NOTES, 'p', 'a', { id: 'a', text: 'x' })
        return Promise.resolve()
      }),
    ).toThrow(expect.objectContaining({ code: 'PERSISTENCE.ASYNC_TRANSACTION' }))
    expect(store.get(NOTES, 'p', 'a')).toBeUndefined()
  })

  it('the store does not enumerate its records', () => {
    const store = makeStore()
    store.put(NOTES, 'p', 'a', { id: 'a', text: 'secret-text' })
    expect(JSON.stringify(store)).not.toContain('secret-text')
    expect(JSON.stringify({ ...store })).not.toContain('secret-text')
  })
})

describe('groupedKey / keyPrefixOf', () => {
  it('build `<group>/<id>` and its prefix, refusing an empty group or one holding / (PERSISTENCE.INVALID_KEY_PREFIX)', () => {
    expect(groupedKey('wedding_1', 'guest_2')).toBe('wedding_1/guest_2')
    expect(keyPrefixOf('wedding_1')).toBe('wedding_1/')
    for (const bad of ['', 'a/b', '/']) {
      expect(() => keyPrefixOf(bad)).toThrow(expect.objectContaining({ code: 'PERSISTENCE.INVALID_KEY_PREFIX' }))
      expect(() => groupedKey(bad, 'x')).toThrow(expect.objectContaining({ code: 'PERSISTENCE.INVALID_KEY_PREFIX' }))
    }
  })
})

describe('collection', () => {
  it('accepts snake_case names and rejects anything else (PERSISTENCE.INVALID_COLLECTION)', () => {
    expect(collection('guest_escalation', 'tenant')).toEqual({ name: 'guest_escalation', scope: 'tenant' })
    expect(collection('tenant', 'global', 'tenant')).toEqual({ name: 'tenant', scope: 'global', schema: 'tenant' })
    for (const bad of ['Guest', 'a b', '', '1st']) {
      expect(() => collection(bad, 'tenant')).toThrow(expect.objectContaining({ code: 'PERSISTENCE.INVALID_COLLECTION' }))
    }
  })
})
