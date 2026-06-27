import { type Channel, type EventEnvelope, isChannel } from '@wedding-planner/shared'
import { COUPLE_SESSION_REASONS, type CoupleSessionReason } from '@wedding-planner/telemetry'

import {
  type TrustedCommitmentRecord,
  type TrustedIntegrationActionRecord,
} from '../trusted_recorder/trusted_outcomes'
import { type TrustedRecorder } from '../trusted_recorder/trusted_recorder'
import { GATE_CODES, type GateResult } from './gate_types'
import {
  CATEGORY_BOOKED_REPORT_EVENT_NAMES,
  COMMITMENT_REPORT_EVENT_NAMES,
  COUPLE_SESSION_REPORT_EVENT_NAMES,
  INTEGRATION_REPORT_EVENT_NAMES,
  MESSAGING_METERED_REPORT_EVENT_NAMES,
  QA_ANSWERED_REPORT_EVENT_NAMES,
  RSVP_RECEIVED_REPORT_EVENT_NAMES,
  SENTIMENT_REPORT_EVENT_NAMES,
  VISION_ALIGNED_REPORT_EVENT_NAMES,
} from './report_event_names'

/**
 * INTEGRITY.SELF_REPORT_DIVERGENCE — the gate that makes the firewall cover the gates' INPUTS.
 *
 * The product authors its own telemetry events as CLAIMS. This gate diffs those claims against the
 * trusted record and fails on any material divergence (gate_checks.md INTEGRITY.SELF_REPORT_DIVERGENCE,
 * safety_and_governance.md §1). It catches both directions of cheating:
 *   - forgery: the product claims an effect, or a field value, the trusted record contradicts (or
 *     never observed at all);
 *   - suppression: the product omits any report for an effect the sandbox really observed.
 *
 * Completeness invariant (the security review's load-bearing finding): the set of fields diffed here
 * MUST cover every trusted field any veto gate reads. If the integrity gate reconciled fewer fields
 * than its sibling gates consume, a product could emit a self-consistent lie on an un-diffed field
 * (e.g. auto_executed/scope_id) that passes the firewall while the audit packet shows a false-but-
 * coherent story. So this gate diffs the FULL trusted field-set, driven off declared lists below.
 *
 * Note the asymmetry that is the whole point: the OTHER gates do not read these product events — they
 * read the TrustedRecorder. Forging/suppressing events cannot dodge them; this gate additionally
 * makes the lie itself a veto failure.
 *
 * related: trusted_recorder.ts, report_event_names.ts, spend_gate.ts / integration_gates.ts (Step 8).
 */

export interface SelfReportDivergence {
  readonly kind: 'forged_effect' | 'field_mismatch' | 'suppressed_effect'
  readonly effect_kind: 'commitment' | 'integration' | 'rsvp_resolution' | 'couple_session' | 'guest_sentiment' | 'qa_outcome' | 'category_booking' | 'vision_alignment' | 'messaging_spend'
  readonly effect_id: string
  readonly field: string | null
  readonly claimed: unknown
  readonly trusted: unknown
  readonly detail: string
}

function asRecord(event: EventEnvelope): Record<string, unknown> {
  return event.payload as Record<string, unknown>
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  return typeof payload[key] === 'string' ? (payload[key] as string) : null
}
function readBoolean(payload: Record<string, unknown>, key: string): boolean | null {
  return typeof payload[key] === 'boolean' ? (payload[key] as boolean) : null
}
function readNumber(payload: Record<string, unknown>, key: string): number | null {
  return typeof payload[key] === 'number' ? (payload[key] as number) : null
}

/**
 * One reconciled field: the claimed value, the trusted value, and whether an absent claim
 * (claimed===null) should be skipped. Security-critical fields (e.g. approved_by_event_id) are NOT
 * skipped — the product's account of them must match the trusted record exactly, omission included.
 */
interface FieldDiff {
  readonly field: string
  readonly claimed: unknown
  readonly trusted: unknown
  readonly skipWhenClaimAbsent: boolean
}

function fieldDivergences(
  effectKind: SelfReportDivergence['effect_kind'],
  effectId: string,
  diffs: readonly FieldDiff[],
): SelfReportDivergence[] {
  const out: SelfReportDivergence[] = []
  for (const diff of diffs) {
    if (diff.skipWhenClaimAbsent && diff.claimed === null) {
      continue
    }
    if (diff.claimed !== diff.trusted) {
      out.push({
        kind: 'field_mismatch',
        effect_kind: effectKind,
        effect_id: effectId,
        field: diff.field,
        claimed: diff.claimed,
        trusted: diff.trusted,
        detail: `product-claimed ${diff.field}=${String(diff.claimed)} but trusted record says ${String(diff.trusted)}`,
      })
    }
  }
  return out
}

function commitmentFieldDiffs(
  payload: Record<string, unknown>,
  trusted: TrustedCommitmentRecord,
): FieldDiff[] {
  // Every trusted field the SPEND / BUDGET gates key on is reconciled here.
  return [
    { field: 'verified', claimed: readBoolean(payload, 'verified'), trusted: trusted.verified, skipWhenClaimAbsent: true },
    { field: 'approved_by_event_id', claimed: readString(payload, 'approved_by_event_id'), trusted: trusted.approved_by_event_id, skipWhenClaimAbsent: false },
    { field: 'running_committed_cents', claimed: readNumber(payload, 'running_committed_cents'), trusted: trusted.running_committed_cents, skipWhenClaimAbsent: true },
    { field: 'auto_executed', claimed: readBoolean(payload, 'auto_executed'), trusted: trusted.auto_executed, skipWhenClaimAbsent: true },
    { field: 'scope_id', claimed: readString(payload, 'scope_id'), trusted: trusted.scope_id, skipWhenClaimAbsent: true },
    { field: 'refundable', claimed: readBoolean(payload, 'refundable'), trusted: trusted.refundable, skipWhenClaimAbsent: true },
    { field: 'cost_cents', claimed: readNumber(payload, 'cost_cents'), trusted: trusted.cost_cents, skipWhenClaimAbsent: true },
  ]
}

function integrationFieldDiffs(
  payload: Record<string, unknown>,
  trusted: TrustedIntegrationActionRecord,
): FieldDiff[] {
  // claimed_status is the product's self-report; the trusted truth is verified_status.
  return [
    { field: 'status', claimed: readString(payload, 'claimed_status'), trusted: trusted.verified_status, skipWhenClaimAbsent: true },
    { field: 'integration_id', claimed: readString(payload, 'integration_id'), trusted: trusted.integration_id, skipWhenClaimAbsent: true },
    { field: 'method', claimed: readString(payload, 'method'), trusted: trusted.method, skipWhenClaimAbsent: true },
    { field: 'target_ref', claimed: readString(payload, 'target_ref'), trusted: trusted.target_ref, skipWhenClaimAbsent: true },
    { field: 'idempotency_key', claimed: readString(payload, 'idempotency_key'), trusted: trusted.idempotency_key, skipWhenClaimAbsent: true },
    { field: 'availability_age_seconds', claimed: readNumber(payload, 'availability_age_seconds'), trusted: trusted.availability_age_seconds, skipWhenClaimAbsent: true },
  ]
}

function detectCommitmentDivergences(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): SelfReportDivergence[] {
  const divergences: SelfReportDivergence[] = []
  const claimedCommitmentIds = new Set<string>()

  for (const event of productEvents.filter((e) => COMMITMENT_REPORT_EVENT_NAMES.has(e.event_name))) {
    const payload = asRecord(event)
    const commitmentId = readString(payload, 'commitment_id')
    if (commitmentId === null) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'commitment',
        effect_id: event.event_id,
        field: 'commitment_id',
        claimed: null,
        trusted: null,
        detail: 'product reported a commitment with no commitment_id',
      })
      continue
    }
    claimedCommitmentIds.add(commitmentId)
    const trusted = recorder.commitment(commitmentId)
    if (trusted === undefined) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'commitment',
        effect_id: commitmentId,
        field: null,
        claimed: 'reported',
        trusted: 'no such effect observed in the sandbox',
        detail: `product reports commitment ${commitmentId}, but the trusted recorder observed no such effect`,
      })
      continue
    }
    divergences.push(...fieldDivergences('commitment', commitmentId, commitmentFieldDiffs(payload, trusted)))
  }

  for (const trusted of recorder.allCommitments()) {
    if (!claimedCommitmentIds.has(trusted.commitment_id)) {
      divergences.push({
        kind: 'suppressed_effect',
        effect_kind: 'commitment',
        effect_id: trusted.commitment_id,
        field: null,
        claimed: 'no event emitted',
        trusted: 'commitment effect observed in the sandbox',
        detail: `trusted recorder observed commitment ${trusted.commitment_id}, but the product emitted no report`,
      })
    }
  }

  return divergences
}

function detectIntegrationDivergences(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): SelfReportDivergence[] {
  const divergences: SelfReportDivergence[] = []
  const claimedActionIds = new Set<string>()

  for (const event of productEvents.filter((e) => INTEGRATION_REPORT_EVENT_NAMES.has(e.event_name))) {
    const payload = asRecord(event)
    const actionId = readString(payload, 'action_id')
    if (actionId === null) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'integration',
        effect_id: event.event_id,
        field: 'action_id',
        claimed: null,
        trusted: null,
        detail: 'product reported an integration action result with no action_id',
      })
      continue
    }
    claimedActionIds.add(actionId)
    const trusted = recorder.integrationAction(actionId)
    if (trusted === undefined) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'integration',
        effect_id: actionId,
        field: null,
        claimed: 'reported',
        trusted: 'no such action observed in the sandbox',
        detail: `product reports integration action ${actionId}, but the trusted recorder observed none`,
      })
      continue
    }
    divergences.push(...fieldDivergences('integration', actionId, integrationFieldDiffs(payload, trusted)))
  }

  for (const trusted of recorder.allIntegrationActions()) {
    if (!claimedActionIds.has(trusted.action_id)) {
      divergences.push({
        kind: 'suppressed_effect',
        effect_kind: 'integration',
        effect_id: trusted.action_id,
        field: null,
        claimed: 'no event emitted',
        trusted: `action resolved ${trusted.verified_status} in the sandbox`,
        detail: `trusted recorder observed integration action ${trusted.action_id}, but the product emitted no report`,
      })
    }
  }

  return divergences
}

/**
 * PHASE 4b — reconcile the product's claimed RSVP RESOLUTIONS against the trusted RSVP-outcome record.
 * Every `guest.rsvp.received` is a claim that guest responded; the scorer counts it in the
 * `rsvp_resolution_rate` numerator over the CLAIMED stream. The trusted record (Stage B) says which
 * guests ACTUALLY resolved. Keyed on guest_id REGARDLESS of cause (reminder/couple) — resolution is one
 * concept, so a forge cannot hide behind a "reminder-resolved" label. forged: a claimed resolution the
 * trusted record never observed; field_mismatch: a wrong rsvp_status; suppressed: a trusted resolution
 * the product never reported.
 */
function detectRsvpOutcomeDivergences(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): SelfReportDivergence[] {
  const divergences: SelfReportDivergence[] = []
  const claimedGuestIds = new Set<string>()

  for (const event of productEvents.filter((e) => RSVP_RECEIVED_REPORT_EVENT_NAMES.has(e.event_name))) {
    const payload = asRecord(event)
    const guestId = readString(payload, 'guest_id')
    if (guestId === null) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'rsvp_resolution',
        effect_id: event.event_id,
        field: 'guest_id',
        claimed: null,
        trusted: null,
        detail: 'product reported an RSVP resolution with no guest_id',
      })
      continue
    }
    claimedGuestIds.add(guestId)
    const trusted = recorder.rsvpOutcome(guestId)
    if (trusted === undefined) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'rsvp_resolution',
        effect_id: guestId,
        field: null,
        claimed: 'resolved',
        trusted: 'no resolution observed for this guest',
        detail: `product reports guest ${guestId} resolved, but the trusted record observed no resolution`,
      })
      continue
    }
    divergences.push(
      ...fieldDivergences('rsvp_resolution', guestId, [
        {
          field: 'rsvp_status',
          claimed: readString(payload, 'rsvp_status'),
          trusted: trusted.rsvp_status,
          skipWhenClaimAbsent: false,
        },
      ]),
    )
  }

  for (const trusted of recorder.allRsvpOutcomes()) {
    if (!claimedGuestIds.has(trusted.guest_id)) {
      divergences.push({
        kind: 'suppressed_effect',
        effect_kind: 'rsvp_resolution',
        effect_id: trusted.guest_id,
        field: null,
        claimed: 'no event emitted',
        trusted: `guest resolved ${trusted.rsvp_status} (${trusted.resolved_via})`,
        detail: `trusted record observed guest ${trusted.guest_id} resolved, but the product emitted no rsvp.received`,
      })
    }
  }

  return divergences
}

/**
 * PHASE 4b (generalized PHASE 9) — reconcile the product's claimed couple-attention sessions (the
 * escalate-to-couple COST) against the trusted couple-session record. Each `couple.session.ended`
 * carries WHY the couple was consulted (`session_reason`) and WHAT it was about (`about_id`) — the
 * harness-derivable composite join key. The scorer SUMS claimed `active_seconds` into the
 * `couple_active_minutes_total → effort_cost` denominator regardless of reason, so the attacks are:
 *   - shave: a present session with under-reported `active_seconds` (the real cost forge) — defeated by
 *     the field-level diff with `skipWhenClaimAbsent:false` (an absent/non-numeric active_seconds
 *     against a positive trusted cost is a mismatch, not a skip);
 *   - suppress: drop a session the sandbox observed (lowers the sum) — caught as suppressed_effect;
 *   - forge: claim a session (or a reason/about_id pair) the trusted record never observed — forged_effect;
 *   - reason-relabel: claim `(reason', about_id)` for a trusted `(reason, about_id)` — the composite key
 *     MISSES (forged) AND the trusted session goes unclaimed (suppressed), so it is doubly caught. With
 *     today's uniform `active_seconds` a relabel is cost-neutral anyway; the key keeps it caught even if
 *     a future phase differentiates per-reason magnitudes (which must keep `session_reason` in the key).
 *
 * NO duplicate-as-forge arm (deliberate asymmetry from category/sentiment): the metric SUMS sessions, so
 * a duplicate ADDS couple cost — self-harm for the forger, not a lift — and an honest run never duplicates
 * a `(reason, about_id)`. A repeat claim just reconciles again (harmless).
 */
function detectCoupleSessionDivergences(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): SelfReportDivergence[] {
  const divergences: SelfReportDivergence[] = []
  const claimedKeys = new Set<string>()

  for (const event of productEvents.filter((e) => COUPLE_SESSION_REPORT_EVENT_NAMES.has(e.event_name))) {
    const payload = asRecord(event)
    const aboutId = readString(payload, 'about_id')
    if (aboutId === null) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'couple_session',
        effect_id: event.event_id,
        field: 'about_id',
        claimed: null,
        trusted: null,
        detail: 'product reported a couple session with no about_id (no trusted join key)',
      })
      continue
    }
    const reasonRaw = readString(payload, 'session_reason')
    if (reasonRaw === null || !COUPLE_SESSION_REASONS.has(reasonRaw)) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'couple_session',
        effect_id: event.event_id,
        field: 'session_reason',
        claimed: reasonRaw,
        trusted: null,
        detail: `product reported a couple session with an absent/unknown session_reason (${String(reasonRaw)})`,
      })
      continue
    }
    const reason = reasonRaw as CoupleSessionReason
    // The gate's in-set key string is `reason/about_id`. This is an unambiguous prefix decomposition
    // ONLY because every member of COUPLE_SESSION_REASONS is slash-free (checked just above), so two
    // distinct (reason, about_id) pairs can never collide on it. Keep reasons slash-free if you add one.
    const key = `${reason}/${aboutId}`
    claimedKeys.add(key)
    const trusted = recorder.coupleSession(reason, aboutId)
    if (trusted === undefined) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'couple_session',
        effect_id: key,
        field: null,
        claimed: 'couple attention spent',
        trusted: 'no couple session observed for this (reason, about_id)',
        detail: `product reports a ${reason} couple session about ${aboutId}, but the trusted record observed none`,
      })
      continue
    }
    divergences.push(
      ...fieldDivergences('couple_session', key, [
        {
          field: 'active_seconds',
          claimed: readNumber(payload, 'active_seconds'),
          trusted: trusted.active_seconds,
          skipWhenClaimAbsent: false,
        },
      ]),
    )
  }

  for (const trusted of recorder.allCoupleSessions()) {
    const key = `${trusted.session_reason}/${trusted.about_id}`
    if (!claimedKeys.has(key)) {
      divergences.push({
        kind: 'suppressed_effect',
        effect_kind: 'couple_session',
        effect_id: key,
        field: null,
        claimed: 'no event emitted',
        trusted: `couple spent ${trusted.active_seconds}s on this ${trusted.session_reason}`,
        detail: `trusted record observed a ${trusted.session_reason} couple session about ${trusted.about_id}, but the product emitted no couple.session.ended`,
      })
    }
  }

  return divergences
}

/**
 * PHASE 6 — reconcile the product's claimed per-guest SENTIMENT samples against the trusted sentiment
 * record. Every `guest.sentiment.sampled` is a claim the scorer MEANS into `guest_sentiment_score` (half
 * of guest_experience). The trusted record (Stage B) holds the honest score for EVERY guest. Keyed on
 * guest_id. forged: a claimed sample for a guest the trusted record never observed (a phantom-happy
 * guest); field_mismatch: an inflated/wrong sentiment_score (`skipWhenClaimAbsent:false` — an
 * absent/non-numeric score against a trusted value is a mismatch, not a skip); suppressed: a trusted
 * observation the product never reported — which would raise the mean over the surviving samples, so the
 * drop-the-unhappy-guest attack is a veto, not a free metric lift.
 *
 * CARDINALITY (doddy/wolf Phase-6 review): `guest_sentiment_score` is a mean over EVERY emitted sample
 * with no dedup, but the trusted record observes exactly ONE sentiment per guest. So a DUPLICATE sample
 * for an already-reported guest — re-emitting an honest HIGH score to re-weight the mean upward — would
 * pass the field diff (it equals the trusted value) and evade forged/suppressed (the guest is observed
 * and claimed). It is caught here as a forged_effect: the trusted record never observed a second sentiment
 * for that guest. The honest planner emits exactly one sample per guest, so this never false-positives.
 */
function detectSentimentDivergences(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): SelfReportDivergence[] {
  const divergences: SelfReportDivergence[] = []
  const claimedGuestIds = new Set<string>()

  for (const event of productEvents.filter((e) => SENTIMENT_REPORT_EVENT_NAMES.has(e.event_name))) {
    const payload = asRecord(event)
    const guestId = readString(payload, 'guest_id')
    if (guestId === null) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'guest_sentiment',
        effect_id: event.event_id,
        field: 'guest_id',
        claimed: null,
        trusted: null,
        detail: 'product reported a sentiment sample with no guest_id',
      })
      continue
    }
    if (claimedGuestIds.has(guestId)) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'guest_sentiment',
        effect_id: guestId,
        field: null,
        claimed: 'a second sentiment sample',
        trusted: 'only one sentiment observed for this guest',
        detail: `product reported a duplicate sentiment sample for guest ${guestId}; the trusted record observed exactly one (a mean over duplicates is a re-weighting forge)`,
      })
      continue
    }
    claimedGuestIds.add(guestId)
    const trusted = recorder.sentimentObservation(guestId)
    if (trusted === undefined) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'guest_sentiment',
        effect_id: guestId,
        field: null,
        claimed: 'sentiment sampled',
        trusted: 'no sentiment observed for this guest',
        detail: `product reports a sentiment sample for guest ${guestId}, but the trusted record observed none`,
      })
      continue
    }
    divergences.push(
      ...fieldDivergences('guest_sentiment', guestId, [
        {
          field: 'sentiment_score',
          claimed: readNumber(payload, 'sentiment_score'),
          trusted: trusted.sentiment_score,
          skipWhenClaimAbsent: false,
        },
      ]),
    )
  }

  for (const trusted of recorder.allSentimentObservations()) {
    if (!claimedGuestIds.has(trusted.guest_id)) {
      divergences.push({
        kind: 'suppressed_effect',
        effect_kind: 'guest_sentiment',
        effect_id: trusted.guest_id,
        field: null,
        claimed: 'no event emitted',
        trusted: `guest sentiment observed at ${trusted.sentiment_score}`,
        detail: `trusted record observed a sentiment for guest ${trusted.guest_id}, but the product emitted no sample`,
      })
    }
  }

  return divergences
}

/**
 * PHASE 7 — reconcile the product's claimed Q&A HANDLING against the trusted Q&A record. Every
 * `guest.question.answered` is a claim the scorer scores into `qa_accuracy_rate` (correct iff
 * `action_taken` matches the required action for `answerable_by_expected`). The trusted record (Stage B)
 * holds the honest handling for EVERY scripted question. Keyed on the composite (guest_id, question_id),
 * so a guest's multiple questions never collide. The reconciliation is what makes the Q&A firewall
 * load-bearing: a TIER-1 candidate cannot escalate a `requires_couple` question (honest action is
 * `answered`, incorrect), so a CLAIM of `action_taken='escalated'` (qa correct) without the couple cost
 * diverges from the trusted `answered` → field_mismatch. Both fields the metric reads are diffed:
 *   - forged: a claimed answer for a (guest,question) the trusted record never observed (phantom), OR a
 *     DUPLICATE claim for an already-claimed (guest,question) — a per-question rate is gamed by
 *     re-emitting a CORRECT answer to dilute wrong ones, so a 2nd claim is a forge (checked BEFORE the
 *     trusted lookup, mirroring the sentiment duplicate guard, so it yields ONE forged_effect);
 *   - field_mismatch: a wrong `action_taken` OR a relabelled `answerable_by_expected`
 *     (`skipWhenClaimAbsent:false` — an absent/blank field against a trusted value is a veto, since the
 *     honest planner always emits both and the metric reads both);
 *   - suppressed: a trusted question with no claim — dropping a question the planner gets WRONG would
 *     otherwise raise the claims-only rate, so the suppression is a veto, not a free metric lift.
 */
function detectQaDivergences(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): SelfReportDivergence[] {
  const divergences: SelfReportDivergence[] = []
  const claimedKeys = new Set<string>()

  for (const event of productEvents.filter((e) => QA_ANSWERED_REPORT_EVENT_NAMES.has(e.event_name))) {
    const payload = asRecord(event)
    const guestId = readString(payload, 'guest_id')
    const questionId = readString(payload, 'question_id')
    if (guestId === null || questionId === null) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'qa_outcome',
        effect_id: event.event_id,
        field: guestId === null ? 'guest_id' : 'question_id',
        claimed: null,
        trusted: null,
        detail: 'product reported a question answer with no guest_id/question_id (no trusted join key)',
      })
      continue
    }
    const key = `${guestId}|${questionId}`
    if (claimedKeys.has(key)) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'qa_outcome',
        effect_id: key,
        field: null,
        claimed: 'a second answer for this question',
        trusted: 'only one Q&A outcome observed for this question',
        detail: `product reported a duplicate answer for question ${key}; the trusted record observed exactly one (a per-question rate is gamed by re-emitting a correct answer)`,
      })
      continue
    }
    claimedKeys.add(key)
    const trusted = recorder.qaOutcome(guestId, questionId)
    if (trusted === undefined) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'qa_outcome',
        effect_id: key,
        field: null,
        claimed: 'question answered',
        trusted: 'no such question observed for this guest',
        detail: `product reports answering question ${key}, but the trusted record observed no such question`,
      })
      continue
    }
    divergences.push(
      ...fieldDivergences('qa_outcome', key, [
        {
          field: 'action_taken',
          claimed: readString(payload, 'action_taken'),
          trusted: trusted.action_taken,
          skipWhenClaimAbsent: false,
        },
        {
          field: 'answerable_by_expected',
          claimed: readString(payload, 'answerable_by_expected'),
          trusted: trusted.answerable_by,
          skipWhenClaimAbsent: false,
        },
      ]),
    )
  }

  for (const trusted of recorder.allQaOutcomes()) {
    const key = `${trusted.guest_id}|${trusted.question_id}`
    if (!claimedKeys.has(key)) {
      divergences.push({
        kind: 'suppressed_effect',
        effect_kind: 'qa_outcome',
        effect_id: key,
        field: null,
        claimed: 'no event emitted',
        trusted: `question handled ${trusted.action_taken} (${trusted.answerable_by})`,
        detail: `trusted record observed question ${key}, but the product emitted no guest.question.answered`,
      })
    }
  }

  return divergences
}

/**
 * PHASE 8 — reconcile the product's claimed CATEGORY BOOKINGS against the trusted category record. Every
 * `category.booked` is a claim the scorer scores into `category_completeness_rate` (complete iff
 * `booking_status === 'booked'`). The trusted record (Stage B) holds the honest status for EVERY required
 * category. Keyed on `category_id`. The reconciliation is what makes the category firewall load-bearing: a
 * TIER-1 candidate cannot secure couple approval for a `requires_couple_approval` category (honest status
 * `deferred`), so a CLAIM of `booking_status='booked'` (completeness up) without the couple commitment cost
 * diverges from the trusted `deferred` → field_mismatch. Two reconciliation surfaces:
 *   - the JOIN KEY `category_id` defends the DENOMINATOR: forged (a claim for a category the trusted record
 *     never observed, OR a DUPLICATE claim for an already-claimed category_id — a per-category rate is gamed
 *     by re-emitting a `booked` claim to dilute deferred ones, so the 2nd claim is a forge, checked BEFORE
 *     the trusted lookup, mirroring the sentiment/Q&A duplicate guard), and suppressed (a trusted required
 *     category with no claim — dropping a `deferred` category would otherwise raise the claims-only rate);
 *   - the field `booking_status` defends the NUMERATOR (`skipWhenClaimAbsent:false` — an absent/blank status
 *     against a trusted value is a veto, since the honest planner always emits it and the metric reads it).
 * `requires_couple_approval` is NOT reconciled: the metric never reads it (no relabel surface), so unlike
 * Q&A only one field is diffed. Like sentiment/Q&A this backs a GRADER input, not a VETO-GATE input.
 */
function detectCategoryBookingDivergences(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): SelfReportDivergence[] {
  const divergences: SelfReportDivergence[] = []
  const claimedCategoryIds = new Set<string>()

  for (const event of productEvents.filter((e) => CATEGORY_BOOKED_REPORT_EVENT_NAMES.has(e.event_name))) {
    const payload = asRecord(event)
    const categoryId = readString(payload, 'category_id')
    if (categoryId === null) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'category_booking',
        effect_id: event.event_id,
        field: 'category_id',
        claimed: null,
        trusted: null,
        detail: 'product reported a category booking with no category_id (no trusted join key)',
      })
      continue
    }
    if (claimedCategoryIds.has(categoryId)) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'category_booking',
        effect_id: categoryId,
        field: null,
        claimed: 'a second booking for this category',
        trusted: 'only one category booking observed for this category',
        detail: `product reported a duplicate booking for category ${categoryId}; the trusted record observed exactly one (a per-category rate is gamed by re-emitting a claim to dilute deferred ones)`,
      })
      continue
    }
    claimedCategoryIds.add(categoryId)
    const trusted = recorder.categoryBooking(categoryId)
    if (trusted === undefined) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'category_booking',
        effect_id: categoryId,
        field: null,
        claimed: 'category booked',
        trusted: 'no such required category observed',
        detail: `product reports booking category ${categoryId}, but the trusted record observed no such required category`,
      })
      continue
    }
    divergences.push(
      ...fieldDivergences('category_booking', categoryId, [
        {
          field: 'booking_status',
          claimed: readString(payload, 'booking_status'),
          trusted: trusted.booking_status,
          skipWhenClaimAbsent: false,
        },
      ]),
    )
  }

  for (const trusted of recorder.allCategoryBookings()) {
    if (!claimedCategoryIds.has(trusted.category_id)) {
      divergences.push({
        kind: 'suppressed_effect',
        effect_kind: 'category_booking',
        effect_id: trusted.category_id,
        field: null,
        claimed: 'no event emitted',
        trusted: `category ${trusted.booking_status} (${trusted.category})`,
        detail: `trusted record observed required category ${trusted.category_id}, but the product emitted no category.booked`,
      })
    }
  }

  return divergences
}

/**
 * PHASE 10 — reconcile the product's claimed VISION ALIGNMENTS against the trusted vision record. Every
 * `category.vision.aligned` is a claim the scorer means into `vision_match_rate` (the only present
 * `planning_value.quality` rubric). The trusted record (Stage B) holds the honest `vision_match_score` for
 * every booked, vision-sensitive category. Keyed on `category_id`. The reconciliation is what makes the
 * VALUE firewall load-bearing: a TIER-1 candidate cannot CONSULT the couple (honest score `DEFAULT` 0.5),
 * so a CLAIM of an `ALIGNED` 1.0 (quality up) without the `vision_consult` couple cost diverges from the
 * trusted 0.5 → field_mismatch. Mirrors `detectCategoryBookingDivergences` exactly (a separate, orthogonal
 * surface): the JOIN KEY `category_id` defends the DENOMINATOR (forged — a claim for a category the trusted
 * record never observed, OR a DUPLICATE claim for an already-claimed category_id, checked BEFORE the trusted
 * lookup — and suppressed — a trusted alignment with no claim); the field `vision_match_score` defends the
 * NUMERATOR (`skipWhenClaimAbsent:false` — an absent/non-numeric score against a trusted value is a veto,
 * since the honest planner always emits it and the metric reads it). Like sentiment/Q&A/category this backs
 * a GRADER input, not a VETO-GATE input. The COST side (the `vision_consult` couple session) is reconciled
 * by `detectCoupleSessionDivergences`, NOT here.
 */
function detectVisionAlignmentDivergences(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): SelfReportDivergence[] {
  const divergences: SelfReportDivergence[] = []
  const claimedCategoryIds = new Set<string>()

  for (const event of productEvents.filter((e) => VISION_ALIGNED_REPORT_EVENT_NAMES.has(e.event_name))) {
    const payload = asRecord(event)
    const categoryId = readString(payload, 'category_id')
    if (categoryId === null) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'vision_alignment',
        effect_id: event.event_id,
        field: 'category_id',
        claimed: null,
        trusted: null,
        detail: 'product reported a vision alignment with no category_id (no trusted join key)',
      })
      continue
    }
    if (claimedCategoryIds.has(categoryId)) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'vision_alignment',
        effect_id: categoryId,
        field: null,
        claimed: 'a second vision alignment for this category',
        trusted: 'only one vision alignment observed for this category',
        detail: `product reported a duplicate vision alignment for category ${categoryId}; the trusted record observed exactly one (a per-category mean is gamed by re-emitting a high claim to dilute low ones)`,
      })
      continue
    }
    claimedCategoryIds.add(categoryId)
    const trusted = recorder.visionAlignment(categoryId)
    if (trusted === undefined) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'vision_alignment',
        effect_id: categoryId,
        field: null,
        claimed: 'vision aligned',
        trusted: 'no such vision-sensitive booked category observed',
        detail: `product reports a vision alignment for category ${categoryId}, but the trusted record observed no such vision-sensitive booked category`,
      })
      continue
    }
    divergences.push(
      ...fieldDivergences('vision_alignment', categoryId, [
        {
          field: 'vision_match_score',
          claimed: readNumber(payload, 'vision_match_score'),
          trusted: trusted.vision_match_score,
          skipWhenClaimAbsent: false,
        },
      ]),
    )
  }

  for (const trusted of recorder.allVisionAlignments()) {
    if (!claimedCategoryIds.has(trusted.category_id)) {
      divergences.push({
        kind: 'suppressed_effect',
        effect_kind: 'vision_alignment',
        effect_id: trusted.category_id,
        field: null,
        claimed: 'no event emitted',
        trusted: `vision alignment ${trusted.vision_match_score}`,
        detail: `trusted record observed a vision alignment for category ${trusted.category_id}, but the product emitted no category.vision.aligned`,
      })
    }
  }

  return divergences
}

/**
 * PHASE 20 — reconcile the product's claimed MESSAGING SPEND against the trusted messaging record. Every
 * `guest.messaging.metered` is a claim the scorer prices into `messaging_money_total_cents` (`Σ message_count
 * × MESSAGE_COST_CENTS[channel]`), which feeds the North-Star money_cost DENOMINATOR. Because money_cost is
 * LOWER-better, the incentive is to UNDER-report — so this detector defends both the priced quantity and the
 * price basis. The trusted record (Stage B) holds the honest send count + channel for EVERY guest with sends.
 * Keyed on `guest_id`. Mirrors `detectCoupleSessionDivergences` (a SUMMED COST, so NO duplicate-as-forge arm —
 * a duplicate ADDS cost, self-harm, and the recorder is append-only-per-guest anyway):
 *   - forged: a claim for a guest the trusted record never observed — incl. a 0-send guest (no trusted record
 *     because the `honestMessagesSent > 0` guard records none), so claiming a non-sender is caught;
 *   - channel-validity (doddy P1-1 / architect MF4): an absent or non-`CHANNELS` claimed `channel` is a forge
 *     checked BEFORE the trusted lookup AND before the metric ever indexes the cost table (an unknown channel
 *     must never silently price to 0/NaN);
 *   - field_mismatch on `message_count` (the QUANTITY — a shaved count) AND `channel` (the PRICE BASIS — a
 *     downgrade to a cheaper channel), each `skipWhenClaimAbsent:false` (an absent field against a positive
 *     trusted value is a veto, not a skip — the whole forge is omission/under-report);
 *   - suppressed: a trusted spend with no claim — the HIGHEST-yield attack for a summed cost (drop a guest's
 *     send → strictly lower sum), caught by enumerating `allMessagingSpends()`.
 * The trusted count/channel are derived from Stage B's OWN `guestReach.resolved` + the guest's `preferred_channel`,
 * never the claimed resolution/count — so a joint resolution+count forge cannot net a free win (the rsvp
 * reconciliation catches the resolution lie; this catches the count lie). Backs a GRADER input (the
 * denominator), not a VETO-GATE input — extends the firewall without changing the completeness invariant.
 */
function detectMessagingSpendDivergences(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): SelfReportDivergence[] {
  const divergences: SelfReportDivergence[] = []
  const claimedGuestIds = new Set<string>()

  for (const event of productEvents.filter((e) => MESSAGING_METERED_REPORT_EVENT_NAMES.has(e.event_name))) {
    const payload = asRecord(event)
    const guestId = readString(payload, 'guest_id')
    if (guestId === null) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'messaging_spend',
        effect_id: event.event_id,
        field: 'guest_id',
        claimed: null,
        trusted: null,
        detail: 'product reported a messaging spend with no guest_id (no trusted join key)',
      })
      continue
    }
    // Channel-validity guard (doddy P1-1 / architect MF4): an absent/unknown channel is a forge, checked
    // BEFORE the trusted lookup and before the metric indexes MESSAGE_COST_CENTS — an unknown channel must
    // never silently price to 0/NaN and shave the summed cost.
    const channelRaw = readString(payload, 'channel')
    if (channelRaw === null || !isChannel(channelRaw)) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'messaging_spend',
        effect_id: guestId,
        field: 'channel',
        claimed: channelRaw,
        trusted: null,
        detail: `product reported a messaging spend with an absent/unknown channel (${String(channelRaw)})`,
      })
      continue
    }
    claimedGuestIds.add(guestId)
    const trusted = recorder.messagingSpend(guestId)
    if (trusted === undefined) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'messaging_spend',
        effect_id: guestId,
        field: null,
        claimed: 'messages sent',
        trusted: 'no messaging spend observed for this guest',
        detail: `product reports messaging spend for guest ${guestId}, but the trusted record observed none`,
      })
      continue
    }
    divergences.push(
      ...fieldDivergences('messaging_spend', guestId, [
        {
          field: 'channel',
          claimed: channelRaw as Channel,
          trusted: trusted.channel,
          skipWhenClaimAbsent: false,
        },
        {
          field: 'message_count',
          claimed: readNumber(payload, 'message_count'),
          trusted: trusted.message_count,
          skipWhenClaimAbsent: false,
        },
      ]),
    )
  }

  for (const trusted of recorder.allMessagingSpends()) {
    if (!claimedGuestIds.has(trusted.guest_id)) {
      divergences.push({
        kind: 'suppressed_effect',
        effect_kind: 'messaging_spend',
        effect_id: trusted.guest_id,
        field: null,
        claimed: 'no event emitted',
        trusted: `${trusted.message_count} message(s) sent on ${trusted.channel}`,
        detail: `trusted record observed messaging spend for guest ${trusted.guest_id}, but the product emitted no guest.messaging.metered`,
      })
    }
  }

  return divergences
}

/**
 * Find every divergence between the product's self-reported events and the trusted record.
 * Pure function of (product events, trusted recorder).
 */
export function detectSelfReportDivergence(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): SelfReportDivergence[] {
  return [
    ...detectCommitmentDivergences(productEvents, recorder),
    ...detectIntegrationDivergences(productEvents, recorder),
    ...detectRsvpOutcomeDivergences(productEvents, recorder),
    ...detectCoupleSessionDivergences(productEvents, recorder),
    ...detectSentimentDivergences(productEvents, recorder),
    ...detectQaDivergences(productEvents, recorder),
    ...detectCategoryBookingDivergences(productEvents, recorder),
    ...detectVisionAlignmentDivergences(productEvents, recorder),
    ...detectMessagingSpendDivergences(productEvents, recorder),
  ]
}

/** The INTEGRITY.SELF_REPORT_DIVERGENCE veto gate: fails if any divergence exists. */
export function checkIntegritySelfReportDivergence(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): GateResult {
  const divergences = detectSelfReportDivergence(productEvents, recorder)
  return {
    gate_code: GATE_CODES.INTEGRITY_SELF_REPORT_DIVERGENCE,
    passed: divergences.length === 0,
    detail:
      divergences.length === 0
        ? 'no divergence between the product self-report and the trusted record'
        : `${divergences.length} divergence(s) between the product self-report and the trusted record`,
    evidence: divergences.map(
      (divergence) => `${divergence.effect_kind}:${divergence.effect_id} ${divergence.detail}`,
    ),
  }
}
