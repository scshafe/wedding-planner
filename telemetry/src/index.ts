/**
 * @wedding-planner/telemetry — the event stream and metrics over it.
 *
 * Public barrel for the telemetry domain. Capabilities are added here as they are built:
 * the runtime-validated event envelope/payloads and the metric engine (metrics as pure
 * functions over events filtered by wedding_id, with no ambient state or clock).
 */

export const TELEMETRY_PACKAGE_NAME = '@wedding-planner/telemetry'
