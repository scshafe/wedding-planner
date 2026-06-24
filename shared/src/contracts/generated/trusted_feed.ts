/* eslint-disable */
/**
 * GENERATED from agent-operations/schemas/trusted_feed_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * The contract for one production out-of-band trusted-evidence feed (trusted_evidence_channel.md): a third-party source a gate / breaker / monitor reads ground truth from, over a VERIFYING path (and principal, and network substrate) that is separate from and un-writable by the agents that act. Pins the gameable properties that DEFEND the L0 floor in production (it cannot be fully constructed outside a sandbox): verifying path/principal/substrate separated from acting, signed liveness AND completeness with fail-closed staleness, source-signed serve handshake, verifiably-independent corroboration for high-severity, decision-signing keys outside every agent process with signed rotation, recursive monitor liveness, and tenant isolation. A source that cannot satisfy these is not eligible to ground a decision (a non-separable source is downgraded to corroborator-only).
 */
export type TrustedFeed = ({
[k: string]: unknown
} & {
/**
 * Stable id, injected (not ambient).
 */
feed_id: string
/**
 * The production third-party source. The live-third-party-feed subset of escalation_record.detected_from / oversight_record.read_from. harness_trusted_record is intentionally absent (eval-only sandbox interceptor); static_diff_analysis / ledger_replay / human_report are not third-party feeds.
 */
source_type: ("out_of_band_payment_processor" | "out_of_band_vendor_confirmation" | "out_of_band_complaint_channel" | "independent_health_check")
/**
 * The decisions / consumer codes this feed grounds, e.g. unauthorized_commit_count, INTEGRITY.SELF_REPORT_DIVERGENCE, COMMS.* harm breakers, deploy health.
 */
grounds?: string[]
/**
 * True when this feed grounds a high-severity determination (money committed, booking verified). High-severity feeds MUST carry a signed completeness aggregate AND verifiably-independent corroboration (allOf below) — no single source grounds a high-severity call alone.
 */
grounds_high_severity: boolean
/**
 * The VERIFYING path — how the monitor reads the source. Separation from the ACTING path must hold at three layers (trusted_evidence_channel.md 'The crux'): our config, the third-party principal, and the network substrate.
 */
channel: {
/**
 * Reference to the source endpoint config (Tier-3 trusted config, human-maintained, outside every agent's write scope).
 */
endpoint_ref: string
/**
 * Reference to the verifying-path credential (Tier-3 config). NOT an acting-path credential; a rotation touching it is INTEGRITY.SCOPE_EXCEEDED.
 */
credential_ref: string
/**
 * Verifying-path config/credentials are outside EVERY agent's write scope (incl. operations_manager / security_agent / reliability_agent), like graders outside the proposer's write scope (safety_and_governance.md §1).
 */
writable_by_agent: false
/**
 * Layer 1: the credentials/endpoints used to VERIFY an effect are separate, in our system, from those used to cause it.
 */
separate_from_acting_path: true
/**
 * Layer 2: the verifying path authenticates to the THIRD PARTY as a distinct least-privilege (read-only) principal, so an agent holding the acting credential cannot reach the vendor's own config plane (webhook/forwarding/notification settings) to degrade the feed. A source that cannot offer this is downgraded to corroborator-only (not a sole high-severity ground).
 */
verifying_principal_distinct_from_acting: true
/**
 * Layer 3: DNS resolution, TLS trust, and egress for the verifying read live in the L0 trust domain (pinned resolvers / pinned source identity / dedicated egress), not the agent-administered network — so an agent controlling resolution/egress cannot redirect the read to a replica.
 */
substrate_in_l0_trust_domain: true
}
/**
 * Liveness: absence of signal is never read as safety.
 */
freshness: {
/**
 * Staleness horizon, tied to the harm's doubling time (safety_and_governance.md §3) — a basis, not a magic number. Stale beyond this => INTEGRITY.TRUSTED_FEED_STALE, contain-first then surface.
 */
horizon_seconds: number
/**
 * True when the feed must emit positive liveness even when quiet (so live-and-quiet is distinguishable from dark).
 */
heartbeat_required: boolean
/**
 * True when the source attaches a monotonic sequence, so dropped events are detectable in-stream.
 */
sequenced: boolean
/**
 * The freshness/sequence assertion is signed by the third party, so an agent cannot fabricate liveness.
 */
signed_by_source: true
/**
 * On staleness/uncertainty the dependent decision is contained/withheld (revert first), never treated as clean.
 */
fail_mode: "closed"
}
/**
 * Completeness: liveness != completeness. A feed can heartbeat fresh while suppressing the one event that matters upstream of sequencing. Required (non-null) for high-severity feeds (allOf). Null only for non-high-severity.
 */
completeness?: ({
/**
 * The source signs an aggregate (running total / balance / Merkle root) independent of the event stream.
 */
aggregate_signed_by_source: true
/**
 * The monitor reconciles the event stream against the signed aggregate; a selectively-suppressed event makes the reconciled total diverge even when the stream looks consistent.
 */
reconciled: true
} | null)
/**
 * Cross-check >=2 sources with VERIFIABLY DISTINCT trust roots. Required (non-null) for high-severity feeds (allOf). Divergence between trusted roots is itself an incident, not a coin-flip.
 */
corroboration?: ({
/**
 * Other trusted_feed ids with distinct signing authorities AND distinct upstreams (NOT two reads of the same processor). One corroborator + the primary = 2 agreeing.
 * 
 * @minItems 1
 */
independent_feed_ids: [string, ...(string)[]]
/**
 * Minimum sources that must agree, counting the primary feed plus its corroborators (so 2 = the primary plus at least one independent corroborator).
 */
min_agreeing: number
/**
 * Independence is verified (distinct trust roots), not assumed. Two 'independent' sources sharing a poisonable upstream are one source wearing two hats.
 */
independence_attested: true
} | null)
/**
 * A read returns a signed receipt (source attests reader+slice+sequence+time), referenced by oversight_record.evidence.receipt_ref — so 'I read trusted evidence' is verifiable. Unresolved => INTEGRITY.EVIDENCE_UNSUBSTANTIATED.
 */
read_receipts_signed: true
/**
 * Where the key that SIGNS a decision grounded on this feed lives. Closes the laundering path where a captured agent signs 'cleared' as a non-agent decider.
 */
decision_key_custody: {
/**
 * L0 mechanism keys live in the L0 substrate outside every agent process; the human (L4) key is human_held / hardware-backed.
 */
location: ("l0_substrate" | "hsm" | "human_held")
/**
 * No agent process can produce the signature. A 'cleared' whose signature fails to verify against the L0/L4 keyring is INTEGRITY.FORGED_CLEAR.
 */
available_to_agent: false
}
/**
 * How the third party's signing key (for freshness/aggregate/handshake/receipts) is established and rotated.
 */
source_key_management: {
/**
 * The initial source-key pin is set in a human-reserved ceremony (Tier-3 setup) — the one place trust-on-first-use is resolved by a person, once, out of band (trusted_evidence_channel.md 'Residual'). Not an agent action.
 */
bootstrap: "human_established_ceremony"
/**
 * A source-key rotation is signed by the prior key (no silent re-pin); the monitor rejects an unsigned re-pin.
 */
rotation_signed_by_prior_key: true
}
/**
 * Recursive liveness: the monitor/breaker/gate reading this feed is itself liveness-asserted — the spec's own discipline applied to the detectors. Bottoms out at the L0 substrate's attested liveness (the same fixed point as the keys), so it does not regress.
 */
monitor_liveness: {
/**
 * If the detector goes dark (INTEGRITY.MONITOR_DARK), the action it guards halts/reverts by default — no silently-unmonitored window, no waiting for a human to notice.
 */
fail_closed_on_monitor_dark: true
}
/**
 * A region/component may not serve until its verifying feed is provably live — and 'live' is the SOURCE's attestation, not an agent's self-report.
 */
provisioning: {
/**
 * An un-provisioned feed after failover fails closed (the region is not 'healthy'), never 'no signal therefore fine'.
 */
provision_before_serve: true
/**
 * Serve-eligibility flips only on a source-signed 'now delivering to monitor M for region R' handshake verified against the L0 keyring — so reliability_agent cannot declare provision-complete falsely.
 */
serve_gated_on_source_signed_handshake: true
}
/**
 * Tenant this feed belongs to (white-label multi-tenancy); null = a shared platform feed. A shared feed is read-only to tenant agents and writable only via the human-reserved Tier-3 path. The per-tenant vs tenant-partitioned L0 architecture and the platform-operator's status are deferred to the white-label thread (white-label-growth-and-agent-strategy-autonomy).
 */
tenant_id: (string | null)
/**
 * One tenant's agents can neither read nor reconfigure another tenant's verifying path; cross-tenant evidence flow is INTEGRITY.CROSS_TENANT (detectable, not merely discouraged).
 */
cross_tenant_access_blocked: true
/**
 * Feeds reference couples/guests/weddings by id only; sensitive free-text is [REDACTED] (telemetry PII discipline).
 */
pii_redacted: true
})
