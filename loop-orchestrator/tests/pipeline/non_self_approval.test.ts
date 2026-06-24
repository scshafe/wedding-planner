import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveFromRepoRoot } from '@wedding-planner/shared'
import { ApprovalStore } from '@wedding-planner/loop-orchestrator'
import { describe, expect, it } from 'vitest'

/**
 * Phase 4a Step 4 — THE NON-SELF-APPROVAL RAIL (doddy). "Approval as an exogenous injected input,
 * absent => park" is an honest model of a human gate ONLY if the loop provably cannot author an
 * approval that satisfies the gate. These are structural guards over that invariant: approvals enter
 * exclusively through the injected `config.approvals` input, the ApprovalStore is a READER, and no
 * production code mints a `human_gate` / `reviewed_by: 'human'` record. (The production hardening is L4
 * key custody — a loop-forged human record fails signature verification, INTEGRITY.FORGED_CLEAR; offline
 * the structural rail is the honest stand-in. See memory tier2-promotion-gate-is-load-bearing.)
 */

function allSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...allSourceFiles(full))
    } else if (entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('the non-self-approval rail (Phase 4a Step 4)', () => {
  it('no loop PRODUCTION code authors an approval — it may only type and validate injected records', () => {
    const srcRoot = resolveFromRepoRoot('loop-orchestrator/src')
    const files = allSourceFiles(srcRoot)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      // Authoring an approval means assigning the gate fields as object literals. The loop READS them
      // (valid.reviewed_by !== 'human') and TYPES them (OversightRecord['human_gate']) but never builds
      // one. A literal `human_gate:` or `reviewed_by: 'human'` in production is the rail breach.
      expect(text, `${file} must not construct a human_gate literal`).not.toMatch(/human_gate\s*:/)
      expect(text, `${file} must not author reviewed_by: 'human'`).not.toMatch(/reviewed_by\s*:\s*['"]human['"]/)
    }
  })

  it('ApprovalStore exposes only read/consume operations — no authoring method', () => {
    // The store is constructed once from injected records (the only ingress) and exposes exactly find
    // (read) + markSpent (record consumption). No add / authorize / approve / grant: an approval cannot
    // be created after construction, so the loop cannot mint one mid-run.
    const methods = Object.getOwnPropertyNames(ApprovalStore.prototype).filter((m) => m !== 'constructor')
    expect(methods.sort()).toEqual(['find', 'markSpent'])
  })
})
