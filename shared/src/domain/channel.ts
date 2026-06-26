import type { CommsFactAssertedPayload } from '../contracts/contract_types'

/**
 * @canonical channel -- the single communications-channel enum for the whole system.
 *
 * The medium a message travels over (email / sms / whatsapp / postal / phone). This is the ONE place
 * code names the channel set: `Channel` is DERIVED from the schema-generated `CommsFactAssertedPayload`
 * (`telemetry/schemas/event_payloads_schema.json`), so the JSON Schema contract stays the source of truth
 * and this type cannot drift from it — if the schema's `channel` enum changes, `Channel` changes with it,
 * and the drift-guard test (shared/tests/domain/channel.test.ts) pins it against the OTHER schema that
 * inlines the same set (`guest_persona_schema.json`'s `preferred_channel`) so the two contracts can't
 * silently diverge.
 *
 * Why a derived type rather than a `$ref`'d shared schema definition: the repo deliberately uses
 * SELF-CONTAINED schemas with no cross-file `$ref`, so introducing `$ref` machinery for one enum would
 * fight that convention. Deriving the TS type + a CI drift guard gives a single canonical `Channel` for
 * hand-authored code WITHOUT a third inline copy of the values and without touching the schema-compilation
 * pipeline. The messaging domain references `Channel`; no carrier concepts (SID / E.164 / segments) ever
 * enter here — a channel is a domain value, never a provider concept.
 *
 * related: messaging_port.ts (the provider-agnostic boundary that carries a `Channel`), price_book.ts
 * (per-`Channel` message pricing), event_payloads_schema.json / guest_persona_schema.json (the contracts).
 */
export type Channel = NonNullable<CommsFactAssertedPayload['channel']>

/**
 * The canonical channel values as a runtime tuple — for iteration and (future) edge validation. Pinned
 * EXHAUSTIVE over `Channel` by the drift-guard test, so it cannot fall out of sync with the schema enum.
 * `satisfies` proves every element IS a `Channel` (no stale value); the test proves it covers ALL of them.
 */
export const CHANNELS = ['email', 'sms', 'whatsapp', 'postal', 'phone'] as const satisfies readonly Channel[]
