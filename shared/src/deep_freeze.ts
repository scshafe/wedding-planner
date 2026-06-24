/**
 * @canonical deep_freeze -- recursively freeze a value so it is immutable in depth.
 *
 * Object.freeze is shallow: it protects only the top-level properties. Append-only records (the
 * trusted recorder's effect records) use this so the immutability guarantee does not silently rest
 * on "every field stays primitive" — a hardening the security review flagged. Freezing in depth means
 * a nested field added later cannot be mutated after the record is sealed.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}
