/**
 * @canonical contract_manifest -- the authoritative list of the system's JSON Schema contracts.
 *
 * The `* /schemas/*.json` files are the canonical contracts of the system (root README); CONTRACT_COUNT says how many.
 * This manifest names each one (so "the grade_report schema" maps to exactly one entry),
 * records its `$id` (as declared inside the file) and its repo-relative path, and is the single
 * source the schema registry loads from. A test cross-checks this manifest against on-disk glob
 * discovery so a newly-added schema file that is not registered here fails loudly (drift guard).
 *
 * related: schema_registry.ts (loads these), scripts/contracts/generate_contract_types.ts (types).
 */

export type ContractDomain =
  | 'shared'
  | 'telemetry'
  | 'eval-harness'
  | 'loop-orchestrator'
  | 'agent-operations'
  | 'product'

export type ContractKey =
  | 'strategy_genome'
  | 'event_envelope'
  | 'event_payloads'
  | 'couple_persona'
  | 'guest_persona'
  | 'scenario'
  | 'grade_report'
  | 'candidate_change'
  | 'ledger_entry'
  | 'rollout_stage'
  | 'escalation_record'
  | 'oversight_record'
  | 'trusted_feed'
  | 'tenant'
  | 'wedding'
  | 'billing_event'
  | 'inbound_webhook'
  | 'guest'
  | 'guest_escalation'
  | 'escalation_resolution'
  | 'escalation_reply'
  | 'household'
  | 'wedding_guest'
  | 'wedding_event'
  | 'wedding_rsvp'
  | 'rsvp_link'
  | 'wedding_rsvp_settings'
  | 'wedding_task'
  | 'checklist_date_move'
  | 'wedding_vendor'
  | 'budget_category'
  | 'run_of_show_item'
  | 'seating_table'
  | 'seat_assignment'
  | 'wedding_site'
  | 'wedding_site_name'
  | 'wedding_document'
  | 'copilot_draft_output'
  | 'copilot_draft'
  | 'job'
  | 'guest_answer_output'
  | 'pending_guest_question'
  | 'concierge_eval_set'

export interface ContractDefinition {
  /** Stable friendly key, e.g. 'grade_report'. */
  readonly key: ContractKey
  /** The `$id` declared inside the schema file; how ajv keys the compiled validator. */
  readonly schemaId: string
  /** Path from the repo root to the schema file. */
  readonly repoRelativePath: string
  /** Owning domain directory. */
  readonly domain: ContractDomain
}

const SCHEMA_ID_PREFIX = 'https://wedding-planner.eval/schemas'

export const CONTRACT_DEFINITIONS: readonly ContractDefinition[] = [
  // shared (cross-domain: authored by the loop-orchestrator proposer, consumed by the eval-harness simulator)
  {
    key: 'strategy_genome',
    schemaId: `${SCHEMA_ID_PREFIX}/strategy_genome.json`,
    repoRelativePath: 'shared/schemas/strategy_genome_schema.json',
    domain: 'shared',
  },
  // telemetry
  {
    key: 'event_envelope',
    schemaId: `${SCHEMA_ID_PREFIX}/event_envelope.json`,
    repoRelativePath: 'telemetry/schemas/event_envelope_schema.json',
    domain: 'telemetry',
  },
  {
    key: 'event_payloads',
    schemaId: `${SCHEMA_ID_PREFIX}/event_payloads.json`,
    repoRelativePath: 'telemetry/schemas/event_payloads_schema.json',
    domain: 'telemetry',
  },
  // eval-harness
  {
    key: 'couple_persona',
    schemaId: `${SCHEMA_ID_PREFIX}/couple_persona.json`,
    repoRelativePath: 'eval-harness/schemas/couple_persona_schema.json',
    domain: 'eval-harness',
  },
  {
    key: 'guest_persona',
    schemaId: `${SCHEMA_ID_PREFIX}/guest_persona.json`,
    repoRelativePath: 'eval-harness/schemas/guest_persona_schema.json',
    domain: 'eval-harness',
  },
  {
    key: 'scenario',
    schemaId: `${SCHEMA_ID_PREFIX}/scenario.json`,
    repoRelativePath: 'eval-harness/schemas/scenario_schema.json',
    domain: 'eval-harness',
  },
  {
    key: 'grade_report',
    schemaId: `${SCHEMA_ID_PREFIX}/grade_report.json`,
    repoRelativePath: 'eval-harness/schemas/grade_report_schema.json',
    domain: 'eval-harness',
  },
  // loop-orchestrator
  {
    key: 'candidate_change',
    schemaId: `${SCHEMA_ID_PREFIX}/candidate_change.json`,
    repoRelativePath: 'loop-orchestrator/schemas/candidate_change_schema.json',
    domain: 'loop-orchestrator',
  },
  {
    key: 'ledger_entry',
    schemaId: `${SCHEMA_ID_PREFIX}/ledger_entry.json`,
    repoRelativePath: 'loop-orchestrator/schemas/ledger_entry_schema.json',
    domain: 'loop-orchestrator',
  },
  {
    key: 'rollout_stage',
    schemaId: `${SCHEMA_ID_PREFIX}/rollout_stage.json`,
    repoRelativePath: 'loop-orchestrator/schemas/rollout_stage_schema.json',
    domain: 'loop-orchestrator',
  },
  // agent-operations
  {
    key: 'escalation_record',
    schemaId: `${SCHEMA_ID_PREFIX}/escalation_record.json`,
    repoRelativePath: 'agent-operations/schemas/escalation_record_schema.json',
    domain: 'agent-operations',
  },
  {
    key: 'oversight_record',
    schemaId: `${SCHEMA_ID_PREFIX}/oversight_record.json`,
    repoRelativePath: 'agent-operations/schemas/oversight_record_schema.json',
    domain: 'agent-operations',
  },
  {
    key: 'trusted_feed',
    schemaId: `${SCHEMA_ID_PREFIX}/trusted_feed.json`,
    repoRelativePath: 'agent-operations/schemas/trusted_feed_schema.json',
    domain: 'agent-operations',
  },
  // product (the customer-facing surface: the multi-tenant aggregates)
  {
    key: 'tenant',
    schemaId: `${SCHEMA_ID_PREFIX}/tenant.json`,
    repoRelativePath: 'product/schemas/tenant_schema.json',
    domain: 'product',
  },
  {
    key: 'wedding',
    schemaId: `${SCHEMA_ID_PREFIX}/wedding.json`,
    repoRelativePath: 'product/schemas/wedding_schema.json',
    domain: 'product',
  },
  {
    key: 'billing_event',
    schemaId: `${SCHEMA_ID_PREFIX}/billing_event.json`,
    repoRelativePath: 'product/schemas/billing_event_schema.json',
    domain: 'product',
  },
  {
    key: 'inbound_webhook',
    schemaId: `${SCHEMA_ID_PREFIX}/inbound_webhook.json`,
    repoRelativePath: 'product/schemas/inbound_webhook_schema.json',
    domain: 'product',
  },
  {
    key: 'guest',
    schemaId: `${SCHEMA_ID_PREFIX}/guest.json`,
    repoRelativePath: 'product/schemas/guest_schema.json',
    domain: 'product',
  },
  {
    key: 'guest_escalation',
    schemaId: `${SCHEMA_ID_PREFIX}/guest_escalation.json`,
    repoRelativePath: 'product/schemas/guest_escalation_schema.json',
    domain: 'product',
  },
  {
    key: 'escalation_resolution',
    schemaId: `${SCHEMA_ID_PREFIX}/escalation_resolution.json`,
    repoRelativePath: 'product/schemas/escalation_resolution_schema.json',
    domain: 'product',
  },
  {
    key: 'escalation_reply',
    schemaId: `${SCHEMA_ID_PREFIX}/escalation_reply.json`,
    repoRelativePath: 'product/schemas/escalation_reply_schema.json',
    domain: 'product',
  },
  {
    key: 'household',
    schemaId: `${SCHEMA_ID_PREFIX}/household.json`,
    repoRelativePath: 'product/schemas/household_schema.json',
    domain: 'product',
  },
  {
    key: 'wedding_guest',
    schemaId: `${SCHEMA_ID_PREFIX}/wedding_guest.json`,
    repoRelativePath: 'product/schemas/wedding_guest_schema.json',
    domain: 'product',
  },
  {
    key: 'wedding_event',
    schemaId: `${SCHEMA_ID_PREFIX}/wedding_event.json`,
    repoRelativePath: 'product/schemas/wedding_event_schema.json',
    domain: 'product',
  },
  {
    key: 'wedding_rsvp',
    schemaId: `${SCHEMA_ID_PREFIX}/wedding_rsvp.json`,
    repoRelativePath: 'product/schemas/wedding_rsvp_schema.json',
    domain: 'product',
  },
  {
    key: 'rsvp_link',
    schemaId: `${SCHEMA_ID_PREFIX}/rsvp_link.json`,
    repoRelativePath: 'product/schemas/rsvp_link_schema.json',
    domain: 'product',
  },
  {
    key: 'wedding_rsvp_settings',
    schemaId: `${SCHEMA_ID_PREFIX}/wedding_rsvp_settings.json`,
    repoRelativePath: 'product/schemas/wedding_rsvp_settings_schema.json',
    domain: 'product',
  },
  {
    key: 'wedding_task',
    schemaId: `${SCHEMA_ID_PREFIX}/wedding_task.json`,
    repoRelativePath: 'product/schemas/wedding_task_schema.json',
    domain: 'product',
  },
  {
    key: 'checklist_date_move',
    schemaId: `${SCHEMA_ID_PREFIX}/checklist_date_move.json`,
    repoRelativePath: 'product/schemas/checklist_date_move_schema.json',
    domain: 'product',
  },
  {
    key: 'wedding_vendor',
    schemaId: `${SCHEMA_ID_PREFIX}/wedding_vendor.json`,
    repoRelativePath: 'product/schemas/wedding_vendor_schema.json',
    domain: 'product',
  },
  {
    key: 'budget_category',
    schemaId: `${SCHEMA_ID_PREFIX}/budget_category.json`,
    repoRelativePath: 'product/schemas/budget_category_schema.json',
    domain: 'product',
  },
  {
    key: 'run_of_show_item',
    schemaId: `${SCHEMA_ID_PREFIX}/run_of_show_item.json`,
    repoRelativePath: 'product/schemas/run_of_show_item_schema.json',
    domain: 'product',
  },
  {
    key: 'seating_table',
    schemaId: `${SCHEMA_ID_PREFIX}/seating_table.json`,
    repoRelativePath: 'product/schemas/seating_table_schema.json',
    domain: 'product',
  },
  {
    key: 'seat_assignment',
    schemaId: `${SCHEMA_ID_PREFIX}/seat_assignment.json`,
    repoRelativePath: 'product/schemas/seat_assignment_schema.json',
    domain: 'product',
  },
  {
    key: 'wedding_site',
    schemaId: `${SCHEMA_ID_PREFIX}/wedding_site.json`,
    repoRelativePath: 'product/schemas/wedding_site_schema.json',
    domain: 'product',
  },
  {
    key: 'wedding_site_name',
    schemaId: `${SCHEMA_ID_PREFIX}/wedding_site_name.json`,
    repoRelativePath: 'product/schemas/wedding_site_name_schema.json',
    domain: 'product',
  },
  {
    key: 'wedding_document',
    schemaId: `${SCHEMA_ID_PREFIX}/wedding_document.json`,
    repoRelativePath: 'product/schemas/wedding_document_schema.json',
    domain: 'product',
  },
  {
    key: 'copilot_draft_output',
    schemaId: `${SCHEMA_ID_PREFIX}/copilot_draft_output.json`,
    repoRelativePath: 'product/schemas/copilot_draft_output_schema.json',
    domain: 'product',
  },
  {
    key: 'copilot_draft',
    schemaId: `${SCHEMA_ID_PREFIX}/copilot_draft.json`,
    repoRelativePath: 'product/schemas/copilot_draft_schema.json',
    domain: 'product',
  },
  {
    key: 'job',
    schemaId: `${SCHEMA_ID_PREFIX}/job.json`,
    repoRelativePath: 'product/schemas/job_schema.json',
    domain: 'product',
  },
  {
    key: 'guest_answer_output',
    schemaId: `${SCHEMA_ID_PREFIX}/guest_answer_output.json`,
    repoRelativePath: 'product/schemas/guest_answer_output_schema.json',
    domain: 'product',
  },
  {
    key: 'pending_guest_question',
    schemaId: `${SCHEMA_ID_PREFIX}/pending_guest_question.json`,
    repoRelativePath: 'product/schemas/pending_guest_question_schema.json',
    domain: 'product',
  },
  {
    key: 'concierge_eval_set',
    schemaId: `${SCHEMA_ID_PREFIX}/concierge_eval_set.json`,
    repoRelativePath: 'eval-harness/schemas/concierge_eval_set_schema.json',
    domain: 'eval-harness',
  },
] as const

/** The number of canonical contracts. The drift-guard test asserts on-disk discovery matches. */
export const CONTRACT_COUNT = CONTRACT_DEFINITIONS.length

const DEFINITIONS_BY_KEY: ReadonlyMap<ContractKey, ContractDefinition> = new Map(
  CONTRACT_DEFINITIONS.map((definition) => [definition.key, definition]),
)

/** Look up a contract definition by its friendly key, or throw if unknown. */
export function getContractDefinition(key: ContractKey): ContractDefinition {
  const definition = DEFINITIONS_BY_KEY.get(key)
  if (definition === undefined) {
    // Unreachable for a ContractKey-typed argument; guards against a stale cast at a call site.
    throw new Error(`Unknown contract key: ${String(key)}`)
  }
  return definition
}
