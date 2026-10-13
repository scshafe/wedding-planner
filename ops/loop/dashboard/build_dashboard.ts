import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { collectDashboardSnapshot } from './collect_dashboard_snapshot'
import type { DashboardSnapshot } from './dashboard_snapshot'
import { deriveDashboardView } from './dashboard_snapshot'
import { renderDashboard } from './render_dashboard'

/**
 * @canonical loop_dashboard_build -- the reporter's command: collect a snapshot, derive the view,
 * write `data.json` and `index.html`. The one imperative shell of the dashboard (it reads the
 * wall clock, the environment and the disk; everything it calls is pure or does GitHub I/O).
 *
 *   npx tsx ops/loop/dashboard/build_dashboard.ts [--out DIR] [--journal FILE] [--digest FILE]
 *                                                 [--repo OWNER/NAME] [--from-snapshot FILE]
 *
 * `--from-snapshot` re-renders a saved `data.json` without calling GitHub (offline previews).
 */

const loopHome = process.env.WP_LOOP_HOME ?? join(homedir(), '.wedding-planner-loop')
const { values } = parseArgs({
  options: {
    out: { type: 'string', default: join(loopHome, 'dashboard') },
    journal: { type: 'string', default: join(loopHome, 'journal.jsonl') },
    digest: { type: 'string' },
    repo: { type: 'string', default: 'scshafe/wedding-planner' },
    'from-snapshot': { type: 'string' },
  },
})

const now = new Date()
const digest = values.digest === undefined ? null : readFileSync(values.digest, 'utf8')
const snapshot: DashboardSnapshot =
  values['from-snapshot'] === undefined
    ? collectDashboardSnapshot({ repo: values.repo, journalPath: values.journal, digest, now })
    : { ...(JSON.parse(readFileSync(values['from-snapshot'], 'utf8')) as DashboardSnapshot), digest }
const generatedAt = new Date(snapshot.generated_at)

mkdirSync(values.out, { recursive: true })
writeFileSync(join(values.out, 'data.json'), `${JSON.stringify(snapshot, null, 2)}\n`)
writeFileSync(join(values.out, 'index.html'), renderDashboard(deriveDashboardView(snapshot, generatedAt), generatedAt))
process.stdout.write(`dashboard written to ${join(values.out, 'index.html')}\n`)
