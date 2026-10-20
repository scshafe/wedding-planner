/* eslint-disable */
/**
 * GENERATED from product/schemas/guest_answer_output_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * What the model returns for a guest's question (issue #60, ADR 0059): answer with some of the concierge's fact keys, or escalate. Untrusted model output: it never carries text — the reply is worded from the trusted values of keys the projection holds, and an answer naming any other key is escalated. The count is bounded in code.
 */
export interface GuestAnswerOutput {
action: ("answer" | "escalate")
facts: string[]
}
