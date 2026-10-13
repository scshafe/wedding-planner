import { describe, expect, it } from 'vitest'

import { parseJournal } from '../collect_dashboard_snapshot'
import type { DashboardSnapshot, IssueRecord, JournalEntry, PullRecord, WorkflowRunRecord } from '../dashboard_snapshot'
import { deriveDashboardView, LoopDashboardError, priorityRank } from '../dashboard_snapshot'
import { escapeHtml, formatUsd, relativeTime, renderDashboard, safeGithubUrl, spendChart } from '../render_dashboard'

const NOW = new Date('2026-10-13T19:40:00Z')
const REPO = 'scshafe/wedding-planner'

function issue(number: number, labels: string[], extra: Partial<IssueRecord> = {}): IssueRecord {
  return {
    number,
    title: `Issue ${number}`,
    state: 'OPEN',
    labels,
    milestone: null,
    author: 'scshafe',
    created_at: '2026-10-10T12:00:00Z',
    updated_at: '2026-10-13T12:00:00Z',
    closed_at: null,
    url: `https://github.com/${REPO}/issues/${number}`,
    ...extra,
  }
}

function pull(number: number, extra: Partial<PullRecord> = {}): PullRecord {
  return {
    number,
    title: `PR ${number}`,
    state: 'MERGED',
    labels: [],
    author: 'app/scshafe-agent',
    created_at: '2026-10-12T10:00:00Z',
    merged_at: '2026-10-12T11:00:00Z',
    url: `https://github.com/${REPO}/pull/${number}`,
    ...extra,
  }
}

function run(id: number, workflow: string, conclusion: string | null, created_at: string, status = 'completed'): WorkflowRunRecord {
  return {
    id,
    workflow,
    status,
    conclusion,
    branch: 'main',
    event: 'push',
    sha: 'f293228aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    title: `run ${id}`,
    created_at,
    url: `https://github.com/${REPO}/actions/runs/${id}`,
  }
}

function entry(role: string, started_at: string, outcome: string, cost_usd: number | null = null): JournalEntry {
  return { run_id: `${role}-${started_at}`, role, started_at, finished_at: started_at, outcome, summary: `${role} ${outcome}`, cost_usd }
}

function snapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    repo: REPO,
    generated_at: NOW.toISOString(),
    digest: null,
    issues: [],
    pulls: [],
    runs: [],
    milestones: [],
    journal: [],
    ...overrides,
  }
}

describe('deriveDashboardView', () => {
  it('sorts issues into lanes by their status labels', () => {
    const view = deriveDashboardView(
      snapshot({
        issues: [
          issue(1, ['status:needs-owner', 'priority:P2']),
          issue(2, ['status:needs-owner', 'priority:P0']),
          issue(3, ['type:incident', 'priority:P0']),
          issue(4, ['status:in-progress']),
          issue(5, ['status:triage']),
          issue(6, ['status:triage', 'type:feedback']),
          issue(7, ['status:blocked']),
          issue(8, ['status:ready'], { state: 'CLOSED' }),
        ],
      }),
      NOW,
    )
    expect(view.waiting_on_owner.map((i) => i.number)).toEqual([2, 1])
    expect(view.incidents.map((i) => i.number)).toEqual([3])
    expect(view.in_progress.map((i) => i.number)).toEqual([4])
    expect(view.triage_count).toBe(1)
    expect(view.feedback_open.map((i) => i.number)).toEqual([6])
    expect(view.blocked.map((i) => i.number)).toEqual([7])
    expect(view.next_up).toEqual([])
  })

  it('ranks the ready queue by priority, then milestone order, then age', () => {
    const view = deriveDashboardView(
      snapshot({
        milestones: [
          { number: 1, title: 'M1', state: 'open', open_issues: 3, closed_issues: 0, url: 'https://github.com/x/y/milestone/1' },
          { number: 2, title: 'M2', state: 'open', open_issues: 1, closed_issues: 0, url: 'https://github.com/x/y/milestone/2' },
        ],
        issues: [
          issue(10, ['status:ready', 'priority:P2'], { milestone: 'M2' }),
          issue(11, ['status:ready', 'priority:P2'], { milestone: 'M1' }),
          issue(12, ['status:ready', 'priority:P1'], { milestone: 'M2' }),
          issue(13, ['status:ready']),
          issue(9, ['status:ready', 'priority:P2'], { milestone: 'M1' }),
        ],
      }),
      NOW,
    )
    expect(view.next_up.map((i) => i.number)).toEqual([12, 9, 11, 10, 13])
  })

  it('counts only merges inside the last 7 days as shipped', () => {
    const view = deriveDashboardView(
      snapshot({
        pulls: [
          pull(1, { merged_at: '2026-10-13T08:00:00Z' }),
          pull(2, { merged_at: '2026-10-01T08:00:00Z' }),
          pull(3, { state: 'OPEN', merged_at: null, labels: ['loop:pr'] }),
          pull(4, { state: 'CLOSED', merged_at: null }),
          pull(5, { state: 'OPEN', merged_at: null, author: 'stranger' }),
        ],
      }),
      NOW,
    )
    expect(view.shipped.map((p) => p.number)).toEqual([1])
    expect(view.open_loop_prs.map((p) => p.number)).toEqual([3])
  })

  it("ignores a fork pull request whose branch is also called main", () => {
    const view = deriveDashboardView(
      snapshot({
        runs: [
          run(1, 'CI', 'success', '2026-10-13T09:00:00Z'),
          { ...run(2, 'CI', 'failure', '2026-10-13T10:00:00Z'), event: 'pull_request' },
        ],
      }),
      NOW,
    )
    expect(view.ci.verdict).toBe('healthy')
    expect(view.ci.run?.id).toBe(1)
  })

  it('takes the health verdict from the latest decided run on main', () => {
    const view = deriveDashboardView(
      snapshot({
        runs: [
          run(1, 'CI', 'failure', '2026-10-13T10:00:00Z'),
          run(2, 'CI', 'cancelled', '2026-10-13T11:00:00Z'),
          run(3, 'deploy', 'success', '2026-10-13T09:00:00Z'),
          run(4, 'deploy', null, '2026-10-13T12:00:00Z', 'in_progress'),
        ],
      }),
      NOW,
    )
    expect(view.ci.verdict).toBe('failing')
    expect(view.ci.run?.id).toBe(1)
    expect(view.deploy.verdict).toBe('running')
    expect(deriveDashboardView(snapshot(), NOW).deploy.verdict).toBe('unknown')
  })

  it('keeps skips out of the run of show but in the heartbeats, and buckets spend by UTC day', () => {
    const view = deriveDashboardView(
      snapshot({
        journal: [
          entry('builder', '2026-10-13T15:15:00Z', 'merged', 4.5),
          entry('sre', '2026-10-13T15:45:00Z', 'skipped'),
          entry('builder', '2026-10-12T15:15:00Z', 'failed', 1.25),
          entry('triage', '2026-09-01T07:00:00Z', 'triaged', 9),
        ],
      }),
      NOW,
    )
    expect(view.recent_runs.map((r) => r.outcome)).toEqual(['merged', 'failed', 'triaged'])
    const sre = view.heartbeats.find((b) => b.role === 'sre')
    expect(sre?.last?.outcome).toBe('skipped')
    expect(sre?.last_worked).toBeNull()
    expect(view.spend_by_day).toHaveLength(14)
    expect(view.spend_by_day.at(-1)).toEqual({ day: '2026-10-13', usd: 4.5, runs: 1 })
    expect(view.spend_7d_usd).toBeCloseTo(5.75)
    expect(view.runs_7d).toBe(2)
  })

  it('fails loudly on an unparseable merge timestamp', () => {
    expect(() => deriveDashboardView(snapshot({ pulls: [pull(1, { merged_at: 'yesterday' })] }), NOW)).toThrow(
      LoopDashboardError,
    )
  })

  it('treats a missing priority as lowest', () => {
    expect(priorityRank(issue(1, []))).toBe(9)
    expect(priorityRank(issue(1, ['priority:P3', 'priority:P1']))).toBe(1)
  })
})

describe('renderDashboard', () => {
  it('escapes every stranger-controlled string', () => {
    const hostile = '<script>alert(1)</script>'
    const html = renderDashboard(
      deriveDashboardView(
        snapshot({
          digest: `Shipped ${hostile}`,
          issues: [issue(1, ['status:needs-owner'], { title: hostile, milestone: hostile })],
          journal: [{ ...entry('builder', '2026-10-13T15:15:00Z', 'merged'), summary: hostile }],
        }),
        NOW,
      ),
      NOW,
    )
    expect(html).not.toContain(hostile)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // The page's own script is the only one.
    expect(html.match(/<script>/g)).toHaveLength(1)
  })

  it('links only https URLs on github.com', () => {
    expect(safeGithubUrl('https://github.com/scshafe/wedding-planner/issues/1')).toBe(
      'https://github.com/scshafe/wedding-planner/issues/1',
    )
    expect(safeGithubUrl('javascript:alert(1)')).toBeNull()
    expect(safeGithubUrl('https://github.com.evil.example/x')).toBeNull()
    expect(safeGithubUrl('http://github.com/x')).toBeNull()
    const html = renderDashboard(
      deriveDashboardView(snapshot({ issues: [issue(1, ['status:in-progress'], { url: 'javascript:alert(1)' })] }), NOW),
      NOW,
    )
    expect(html).not.toContain('javascript:')
    expect(html).toContain('<span class="item-title">Issue 1</span>')
  })

  it('renders numbers from an untrusted snapshot as numbers only', () => {
    const forged = issue(1, ['status:in-progress'], { number: '<b>1</b>' as unknown as number })
    const html = renderDashboard(deriveDashboardView(snapshot({ issues: [forged] }), NOW), NOW)
    expect(html).not.toContain('<b>1</b>')
    expect(html).toContain('<span class="num">#0</span>')
  })

  it('renders a complete page at rest with empty states', () => {
    const html = renderDashboard(deriveDashboardView(snapshot(), NOW), NOW)
    expect(html.startsWith('<title>Wedding Planner Engineering</title>')).toBe(true)
    expect(html).toContain('Nothing is waiting on you.')
    expect(html).toContain('No loop runs recorded yet.')
    expect(html).toContain('No deploy recorded')
    expect(html).toContain('13 Oct, 19:40 UTC')
  })
})

describe('formatting helpers', () => {
  it('formats spend and relative time', () => {
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(0.004)).toBe('<$0.01')
    expect(formatUsd(3.4)).toBe('$3.40')
    expect(formatUsd(1280.4)).toBe('$1,280')
    expect(relativeTime('2026-10-13T19:10:00Z', NOW)).toBe('30 min ago')
    expect(relativeTime('2026-10-13T16:40:00Z', NOW)).toBe('3 h ago')
    expect(relativeTime('2026-10-10T19:40:00Z', NOW)).toBe('3 d ago')
    expect(escapeHtml(`a&b"c'`)).toBe('a&amp;b&quot;c&#39;')
  })

  it('draws no bars when nothing was spent', () => {
    expect(spendChart([{ day: '2026-10-13', usd: 0, runs: 0 }])).toContain('No spend recorded')
    expect(spendChart([{ day: '2026-10-13', usd: 2, runs: 1 }])).toContain('<path class="bar"')
  })
})

describe('parseJournal', () => {
  it('skips torn and foreign lines', () => {
    const good = JSON.stringify(entry('sre', '2026-10-13T15:45:00Z', 'skipped'))
    const parsed = parseJournal(`${good}\n{"run_id":"torn\nnot json\n{"role":"x"}\n\n${good}\n`)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.role).toBe('sre')
  })
})
