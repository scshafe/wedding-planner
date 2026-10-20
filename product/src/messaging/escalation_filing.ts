import type { GuestEscalation } from '@wedding-planner/shared'

import type { TenantContext } from '../tenant/tenant_context'
import type { EscalationLog } from './escalation_log'
import type { EscalationReplyLog } from './escalation_reply_log'
import type { EffectiveEscalationStatus, EscalationResolutionLog } from './escalation_resolution_log'
import type { InboundMessage } from './messaging_port'

/**
 * @canonical escalation_filing -- how a guest's question that the platform will not answer reaches the couple and
 * planner inbox (Phases 26, 35 and 37), moved here unchanged from the inbound edge for the guest concierge (issue #60):
 * the concierge's job files it after the model escalates.
 *
 * related: concierge_service.ts (the caller), escalation_log.ts, escalation_reply_log.ts, escalation_resolution_log.ts.
 */

/** What filing needs: the inbox, the resolution fold (read + reopen), and the thread log. */
export interface EscalationFilingDeps {
  readonly escalations: EscalationLog
  readonly resolutions: Pick<EscalationResolutionLog, 'effectiveStatus' | 'transition'>
  readonly replies: EscalationReplyLog
}

/**
 * File one guest question in the wedding the guest is CURRENTLY bound to (`wedding_id`, from trusted state): thread it
 * into the guest's open conversation, else auto-reopen their latest resolved one and thread into it, else open a fresh
 * escalation. Process-once by the message's provider ref, so a re-delivery is never filed twice.
 */
export function fileGuestEscalation(context: TenantContext, deps: EscalationFilingDeps, wedding_id: string, message: InboundMessage): void {
  // Phase 35/37 — guest-reply → thread correlation, with AUTO-REOPEN. An `escalated` follow-up from a guest
  // who already has a conversation in their CURRENTLY-BOUND wedding lands in THAT escalation's thread (a
  // `sender:'guest'` turn) instead of opening a new one. The target is chosen by EFFECTIVE STATUS, PREFERRING
  // an open conversation, then a RESOLVED one to auto-reopen, else opening fresh:
  //   - effective-OPEN exists  → thread into it (Phase 35);
  //   - else effective-RESOLVED → AUTO-REOPEN it (a `reopened` transition, attributed `resolved_by:'guest'`)
  //                              then thread into it (Phase 37 — the resolved conversation becomes live again);
  //   - else (only effective-DISMISSED, or none) → open a FRESH escalation (Phase 26).
  // DISMISSED is deliberately NOT a reopen candidate (an operator dismissal is a final "no" to the guest —
  // see escalation_resolution_log.ts); the policy lives in the SELECTOR (it only ever returns open/resolved),
  // NOT in `transition()`'s direction rule (which would permit reopening a dismissed one). The target is
  // inferred ENTIRELY from trusted state (the live binding's wedding_id + the registry-vetoed sender_ref),
  // never the inbound body. Every branch is a server-side write invisible to the guest (uniform 202) and
  // carries NO send / NO charge — a guest turn (and the reopen it may trigger) is a RECEIVED message we file
  // into the conversation; only an OPERATOR console reply bills.
  //
  // PROCESS-ONCE gate (§B0): the split routing makes a per-thread ref-scan insufficient, because the
  // selector's output can change between provider re-deliveries (a freshly-recorded escalation is OPEN, so a
  // re-delivery of the SAME message would otherwise thread into it; a since-resolved escalation would drop a
  // re-delivered follow-up to a fresh escalation; and now a since-AUTO-REOPENED escalation would re-select a
  // different tier — open instead of resolved). So gate on TWO "already processed?" reads BEFORE routing:
  const ref = message.provider_message_ref
  if (
    deps.escalations.getByProviderRef(context, ref) === undefined && // (1) ref didn't already CREATE an escalation
    deps.replies.guestTurnByProviderRef(context, ref) === undefined // (2) ref didn't already land as a guest turn
  ) {
    // OPEN is strictly preferred over RESOLVED (the `??`), never compared by recency across tiers — so the
    // operator-manual-reopen "two opens" case threads into the most-recent open and opens nothing new.
    const openTarget = mostRecentEscalationForGuest(context, deps, wedding_id, message.sender_ref, 'open')
    const target =
      openTarget ?? mostRecentEscalationForGuest(context, deps, wedding_id, message.sender_ref, 'resolved')
    if (target !== undefined) {
      // Phase 37: if we fell through to a RESOLVED target (no open conversation), AUTO-REOPEN it FIRST so it
      // returns to the Open inbox and the Phase-28/36 reply gate (`effectiveStatus !== 'open'`) re-admits
      // billed operator replies — THEN thread the guest turn into it. The reopen-BEFORE-thread order is
      // load-bearing: a threaded guest turn is never observed on a still-effective-resolved escalation, and
      // the two writes are inseparable inside this one §B0-gated, synchronous critical section. escalation_id/
      // wedding_id are COPIED from the live `target` (never the body); `by:'guest'` is a server literal — the
      // honest provenance of the follow-up. `transition()` is directional-idempotent (a second `reopened`
      // from effective-open is a no-op) and contract-valid (the enum now includes `guest`), so it can neither
      // double-append nor throw a 400 — the 202 stays uniform.
      if (openTarget === undefined) {
        deps.resolutions.transition(context, {
          escalation_id: target.escalation_id,
          wedding_id: target.wedding_id,
          status: 'reopened',
          by: 'guest',
        })
      }
      // Thread the follow-up. recordGuestReply allocates the slot above the thread's high-water mark and dedups
      // by ref; the schema body has no maxLength so a long guest message can never fail validation here (no 500
      // oracle), exactly as escalation.record cannot.
      deps.replies.recordGuestReply(context, {
        escalation_id: target.escalation_id,
        wedding_id: target.wedding_id,
        provider_message_ref: ref,
        body: message.body,
      })
    } else {
      // A new conversation (no open or resolved escalation to continue — only dismissed, or none): record the
      // unanswerable question for the couple/planner inbox (Phase 26). Idempotent by provider_message_ref;
      // sourced from TRUSTED state + the validated message ONLY, never the raw body. NOT swallowed to 202:
      // record() cannot be provoked to throw by guest input that passed the inbound edge (its `text`
      // constraint matches inbound_webhook.text), so a throw is a genuine bug.
      deps.escalations.record(context, {
        wedding_id: wedding_id,
        from_ref: message.sender_ref,
        text: message.body,
        received_at: message.received_at,
        provider_message_ref: ref,
        channel: message.channel, // Phase 28: the reply-routing snapshot — a console reply sends back over this.
      })
    }
  }
}

/**
 * Phase 35/37 — the guest-reply correlation selector. Returns the guest's MOST-RECENT escalation with the given
 * EFFECTIVE `status` in their CURRENTLY-BOUND wedding, or `undefined` if none. Called twice by the inbound edge:
 * with `'open'` (thread into an active conversation — Phase 35) and, on a miss, with `'resolved'` (the
 * auto-reopen candidate — Phase 37). DISMISSED is never passed (an operator dismissal is final to the guest), so
 * the reopen-candidate policy is enforced HERE, not in `transition()`'s permissive direction rule.
 *
 * The DUAL match (from_ref AND wedding_id) is the cross-wedding mis-segmentation defense (doddy): a
 * `recipient_ref` re-bound from wedding A to B carries stale A-escalations, but filtering candidates by
 * `binding.wedding_id` (the CURRENT trusted binding) excludes them, so a re-bound guest's message can only ever
 * reach an escalation in their current wedding. Both axes are TRUSTED state (the live binding + the recorded
 * escalation), never the inbound body. Effective status is the same fold the inbox uses. All reads are
 * tenant-scoped by the minted context.
 *
 * The `received_at` max-by pick breaks ties on `escalation_id`. For the `'open'` tier the choice is immaterial
 * (all candidates are that guest's open conversation). For the `'resolved'` tier the pick IS the conversation
 * being reopened — recency selects the guest's latest resolved thread to continue (still deterministic; ties
 * remain immaterial).
 */
function mostRecentEscalationForGuest(
  context: TenantContext,
  deps: EscalationFilingDeps,
  wedding_id: string,
  from_ref: string,
  status: EffectiveEscalationStatus,
): GuestEscalation | undefined {
  const candidates = deps.escalations
    .listForWedding(context, wedding_id)
    .filter((escalation) => escalation.from_ref === from_ref)
    .filter((escalation) => deps.resolutions.effectiveStatus(context, escalation.escalation_id) === status)
  let best: GuestEscalation | undefined
  for (const escalation of candidates) {
    if (
      best === undefined ||
      escalation.received_at > best.received_at ||
      (escalation.received_at === best.received_at && escalation.escalation_id > best.escalation_id)
    ) {
      best = escalation
    }
  }
  return best
}
