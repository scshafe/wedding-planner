import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * @canonical hashing -- the system's hashing and HMAC signing primitives.
 *
 * Used by the ledger's tamper-evident hash chain (sha256) and its decided_by signatures (HMAC), and
 * later by the production trusted-evidence channel. Pure functions of their inputs — deterministic,
 * which is what makes the ledger chain reproducible and verifiable.
 *
 * related: serialization/canonical_json.ts, loop-orchestrator ledger.
 */

/** SHA-256 of a UTF-8 string, hex-encoded. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** HMAC-SHA-256 of a UTF-8 string under a key, hex-encoded. */
export function hmacSha256Hex(key: string, input: string): string {
  return createHmac('sha256', key).update(input, 'utf8').digest('hex')
}

/** Constant-time equality for two hex strings (e.g. comparing a signature). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  const bufferA = Buffer.from(a, 'hex')
  const bufferB = Buffer.from(b, 'hex')
  if (bufferA.length !== bufferB.length) {
    return false
  }
  return timingSafeEqual(bufferA, bufferB)
}
