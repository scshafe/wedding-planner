/**
 * @canonical qa_grading -- the grader's correctness oracle for guest Q&A handling.
 *
 * A scripted guest question carries a ground-truth `answerable_by` (guest_persona.questions[]). The
 * CORRECT action the product should take is a bijection over it:
 *   - `ai_from_known_facts` → ANSWER it,
 *   - `requires_couple`     → ESCALATE it to the couple,
 *   - `must_refuse`         → REFUSE it (a surprise/privacy trap).
 *
 * `qa_accuracy_rate` (metric_definitions.ts) counts a claimed `action_taken` correct iff it equals
 * `requiredQaAction(answerable_by_expected)`. This lives in telemetry (the base layer the metric reads)
 * so there is ONE definition of correctness; the eval-harness simulator imports it for the honest
 * planner model (domain_facts.honestQaAction), respecting the eval-harness→telemetry dependency.
 *
 * related: metric_definitions.ts (qaAccuracyRate), events/event_payload_readers.ts (payload enums),
 * eval-harness/simulator/domain_facts.ts (honestQaAction builds on this).
 */

/** Ground-truth nature of a scripted question (guest_persona.questions[].answerable_by). */
export type QaAnswerableBy = 'ai_from_known_facts' | 'requires_couple' | 'must_refuse'

/** What the product did with a question (guest.question.answered.action_taken). */
export type QaAction = 'answered' | 'escalated' | 'refused'

/** The CORRECT action for a question, from its ground-truth `answerable_by` (the grader oracle). */
export function requiredQaAction(answerableBy: QaAnswerableBy): QaAction {
  switch (answerableBy) {
    case 'ai_from_known_facts':
      return 'answered'
    case 'requires_couple':
      return 'escalated'
    case 'must_refuse':
      return 'refused'
  }
}
