import { WeddingPlannerError } from '@wedding-planner/shared'

/**
 * @canonical loop_dashboard_snapshot -- the engineering loop's dashboard data and its derived view.
 *
 * A snapshot is everything the reporter collected at one instant: GitHub issues, PRs, workflow runs
 * and milestones, plus the loop journal (one JSON line per role run, written by
 * `ops/loop/run-role.sh`). {@link deriveDashboardView} is a pure function of a snapshot and an
 * injected `now`: it decides which issue sits in which lane, the health verdict and the spend
 * series, so the renderer only lays out what it is given.
 *
 * Every string here may come from a stranger (the repository is public: anyone can title an
 * issue). The renderer escapes all of it; nothing in this module interprets text as markup.
 *
 * related: render_dashboard.ts (the page), collect_dashboard_snapshot.ts (the I/O),
 * build_dashboard.ts (the CLI), ops/loop/run-role.sh (the journal writer).
 */

export class LoopDashboardError extends WeddingPlannerError {}

export interface IssueRecord {
  readonly number: number
  readonly title: string
  readonly state: 'OPEN' | 'CLOSED'
  readonly labels: readonly string[]
  readonly milestone: string | null
  readonly author: string
  readonly created_at: string
  readonly updated_at: string
  readonly closed_at: string | null
  readonly url: string
}

export interface PullRecord {
  readonly number: number
  readonly title: string
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED'
  readonly labels: readonly string[]
  readonly author: string
  readonly created_at: string
  readonly merged_at: string | null
  readonly url: string
}

export interface WorkflowRunRecord {
  readonly id: number
  readonly workflow: string
  readonly status: string
  readonly conclusion: string | null
  readonly branch: string
  readonly event: string
  readonly sha: string
  readonly title: string
  readonly created_at: string
  readonly url: string
}

export interface MilestoneRecord {
  readonly number: number
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly open_issues: number
  readonly closed_issues: number
  readonly url: string
}

/** One line of the loop journal. Skipped runs are the loop's heartbeat. */
export interface JournalEntry {
  readonly run_id: string
  readonly role: string
  readonly started_at: string
  readonly finished_at: string
  readonly outcome: string
  readonly summary: string
  readonly skip_reason?: string
  readonly model?: string
  readonly cost_usd?: number | null
  readonly num_turns?: number | null
  readonly duration_s?: number | null
  readonly issues?: readonly number[]
  readonly prs?: readonly number[]
}

export interface DashboardSnapshot {
  readonly repo: string
  readonly generated_at: string
  readonly digest: string | null
  readonly issues: readonly IssueRecord[]
  readonly pulls: readonly PullRecord[]
  readonly runs: readonly WorkflowRunRecord[]
  readonly milestones: readonly MilestoneRecord[]
  readonly journal: readonly JournalEntry[]
}

/** The roles run-role.sh knows, in the order the dashboard lists them. */
export const LOOP_ROLES = ['builder', 'sre', 'triage', 'feedback', 'synthetic', 'reporter'] as const

export type HealthVerdict = 'healthy' | 'failing' | 'running' | 'unknown'

export interface RunHealth {
  readonly workflow: string
  readonly verdict: HealthVerdict
  readonly run: WorkflowRunRecord | null
}

export interface RoleHeartbeat {
  readonly role: string
  readonly last: JournalEntry | null
  readonly last_worked: JournalEntry | null
}

export interface SpendDay {
  /** UTC calendar day, YYYY-MM-DD. */
  readonly day: string
  readonly usd: number
  readonly runs: number
}

export interface MilestoneProgress {
  readonly milestone: MilestoneRecord
  readonly total: number
  readonly fraction: number
}

export interface DashboardView {
  readonly repo: string
  readonly generated_at: string
  readonly digest: string | null
  readonly ci: RunHealth
  readonly deploy: RunHealth
  readonly waiting_on_owner: readonly IssueRecord[]
  readonly incidents: readonly IssueRecord[]
  readonly in_progress: readonly IssueRecord[]
  readonly open_loop_prs: readonly PullRecord[]
  readonly next_up: readonly IssueRecord[]
  readonly triage_count: number
  readonly blocked: readonly IssueRecord[]
  readonly feedback_open: readonly IssueRecord[]
  readonly shipped: readonly PullRecord[]
  readonly milestones: readonly MilestoneProgress[]
  readonly recent_runs: readonly JournalEntry[]
  readonly heartbeats: readonly RoleHeartbeat[]
  readonly spend_by_day: readonly SpendDay[]
  readonly spend_7d_usd: number
  readonly runs_7d: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const SHIPPED_WINDOW_DAYS = 7
const SPEND_WINDOW_DAYS = 14
const RECENT_RUNS_LIMIT = 24

const PRIORITY_ORDER: Readonly<Record<string, number>> = {
  'priority:P0': 0,
  'priority:P1': 1,
  'priority:P2': 2,
  'priority:P3': 3,
}

function hasLabel(item: { readonly labels: readonly string[] }, label: string): boolean {
  return item.labels.includes(label)
}

/** The rank of an issue's priority label; unlabeled issues sort last. */
export function priorityRank(issue: IssueRecord): number {
  const ranks = issue.labels.map((label) => PRIORITY_ORDER[label]).filter((rank) => rank !== undefined)
  return ranks.length === 0 ? 9 : Math.min(...ranks)
}

/** The priority label without its prefix ("P1"), or null. */
export function priorityName(issue: IssueRecord): string | null {
  const rank = priorityRank(issue)
  return rank === 9 ? null : `P${rank}`
}

function parseTime(iso: string, field: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new LoopDashboardError('LOOP.DASHBOARD_BAD_TIMESTAMP', `Unparseable timestamp in ${field}.`, {
      context: { field, value: iso },
    })
  }
  return ms
}

function newestFirst<T>(items: readonly T[], at: (item: T) => string): T[] {
  return [...items].sort((a, b) => Date.parse(at(b)) - Date.parse(at(a)))
}

function runHealth(runs: readonly WorkflowRunRecord[], workflowFile: string): RunHealth {
  // gh reports the workflow's display name ("CI", "deploy"); match on either the name or the file.
  // Only runs main itself triggered: a fork's pull request from its own branch named "main" also
  // reports branch "main", and must not be able to paint production red (or green).
  const wanted = workflowFile.replace(/\.ya?ml$/, '').toLowerCase()
  const onMain = newestFirst(
    runs.filter(
      (run) =>
        run.workflow.toLowerCase() === wanted &&
        run.branch === 'main' &&
        (run.event === 'push' || run.event === 'workflow_dispatch'),
    ),
    (run) => run.created_at,
  )
  const latest = onMain[0] ?? null
  if (latest === null) return { workflow: workflowFile, verdict: 'unknown', run: null }
  if (latest.status !== 'completed') {
    // While one runs, the verdict is the last completed run's, but say it is running.
    return { workflow: workflowFile, verdict: 'running', run: latest }
  }
  const decided = onMain.find(
    (run) => run.status === 'completed' && run.conclusion !== 'cancelled' && run.conclusion !== 'skipped',
  )
  if (decided === undefined) return { workflow: workflowFile, verdict: 'unknown', run: latest }
  return { workflow: workflowFile, verdict: decided.conclusion === 'success' ? 'healthy' : 'failing', run: decided }
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Derive the dashboard's lanes from a snapshot. Pure: `now` is injected (the generation instant),
 * so the same snapshot always yields the same view.
 */
export function deriveDashboardView(snapshot: DashboardSnapshot, now: Date): DashboardView {
  const nowMs = now.getTime()
  const open = snapshot.issues.filter((issue) => issue.state === 'OPEN')
  const byPriority = (a: IssueRecord, b: IssueRecord): number =>
    priorityRank(a) - priorityRank(b) || a.number - b.number

  const shippedSince = nowMs - SHIPPED_WINDOW_DAYS * DAY_MS
  const shipped = newestFirst(
    snapshot.pulls.filter(
      (pr) => pr.state === 'MERGED' && pr.merged_at !== null && parseTime(pr.merged_at, 'merged_at') >= shippedSince,
    ),
    (pr) => pr.merged_at ?? pr.created_at,
  )

  const milestones = [...snapshot.milestones]
    .filter((m) => m.state === 'open' || m.closed_issues > 0)
    .sort((a, b) => a.number - b.number)
    .map((milestone) => {
      const total = milestone.open_issues + milestone.closed_issues
      return { milestone, total, fraction: total === 0 ? 0 : milestone.closed_issues / total }
    })

  const journal = newestFirst(snapshot.journal, (entry) => entry.started_at)
  const worked = journal.filter((entry) => entry.outcome !== 'skipped')
  const heartbeats = LOOP_ROLES.map((role) => ({
    role,
    last: journal.find((entry) => entry.role === role) ?? null,
    last_worked: worked.find((entry) => entry.role === role) ?? null,
  }))

  const spendByDay = new Map<string, { usd: number; runs: number }>()
  for (let offset = SPEND_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    spendByDay.set(utcDay(nowMs - offset * DAY_MS), { usd: 0, runs: 0 })
  }
  for (const entry of worked) {
    const bucket = spendByDay.get(utcDay(parseTime(entry.started_at, 'journal.started_at')))
    if (bucket === undefined) continue
    bucket.usd += entry.cost_usd ?? 0
    bucket.runs += 1
  }
  const spend_by_day = [...spendByDay.entries()].map(([day, bucket]) => ({ day, ...bucket }))
  const lastWeek = spend_by_day.slice(-SHIPPED_WINDOW_DAYS)

  return {
    repo: snapshot.repo,
    generated_at: snapshot.generated_at,
    digest: snapshot.digest,
    ci: runHealth(snapshot.runs, 'ci.yml'),
    deploy: runHealth(snapshot.runs, 'deploy.yml'),
    waiting_on_owner: open.filter((i) => hasLabel(i, 'status:needs-owner')).sort(byPriority),
    incidents: open.filter((i) => hasLabel(i, 'type:incident')).sort(byPriority),
    in_progress: open.filter((i) => hasLabel(i, 'status:in-progress')).sort(byPriority),
    // The loop's PRs only (only the owner and the bot can apply loop:pr); strangers' PRs are not work in progress.
    open_loop_prs: snapshot.pulls.filter((pr) => pr.state === 'OPEN' && hasLabel(pr, 'loop:pr')),
    next_up: open
      .filter((i) => hasLabel(i, 'status:ready') && !hasLabel(i, 'type:feedback'))
      .sort((a, b) => priorityRank(a) - priorityRank(b) || milestoneOrder(a, b) || a.number - b.number),
    triage_count: open.filter((i) => hasLabel(i, 'status:triage') && !hasLabel(i, 'type:feedback')).length,
    blocked: open.filter((i) => hasLabel(i, 'status:blocked')).sort(byPriority),
    feedback_open: newestFirst(
      open.filter((i) => hasLabel(i, 'type:feedback')),
      (i) => i.created_at,
    ),
    shipped,
    milestones,
    recent_runs: worked.slice(0, RECENT_RUNS_LIMIT),
    heartbeats,
    spend_by_day,
    spend_7d_usd: lastWeek.reduce((sum, day) => sum + day.usd, 0),
    runs_7d: lastWeek.reduce((sum, day) => sum + day.runs, 0),
  }

  function milestoneOrder(a: IssueRecord, b: IssueRecord): number {
    const rank = (issue: IssueRecord): number =>
      snapshot.milestones.find((m) => m.title === issue.milestone)?.number ?? Number.MAX_SAFE_INTEGER
    return rank(a) - rank(b)
  }
}
