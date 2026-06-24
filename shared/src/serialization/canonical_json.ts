/**
 * @canonical canonical_json -- deterministic JSON serialization (sorted keys).
 *
 * A hash chain and a signature are only reproducible if the bytes being hashed are reproducible.
 * JSON.stringify does not guarantee key order, so any value that will be hashed or signed is first
 * passed through here, which recursively sorts object keys. Arrays keep their order (order is
 * meaningful); primitives and null pass through. The output is a stable string for equal inputs.
 *
 * related: crypto/hashing.ts, loop-orchestrator ledger hashing.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValueDeep(value))
}

function sortValueDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValueDeep)
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValueDeep(source[key])
    }
    return sorted
  }
  return value
}
