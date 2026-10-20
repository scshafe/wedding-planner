import type { SimulatedTask } from './simulated_model_adapter'

/**
 * @canonical simulated_model_tasks -- the tasks the simulated model answers (issue #59, ADR 0057): one deterministic
 * function per task the product asks for. Each M4 feature adds its own task here, next to the contract its output
 * must satisfy.
 */
export const SIMULATED_MODEL_TASKS: Readonly<Record<string, SimulatedTask>> = Object.freeze({})
