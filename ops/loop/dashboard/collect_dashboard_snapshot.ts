import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

import type {
  DashboardSnapshot,
  IssueRecord,
  JournalEntry,
  MilestoneRecord,
  PullRecord,
  WorkflowRunRecord,
} from './dashboard_snapshot'
import { LoopDashboardError } from './dashboard_snapshot'

/**
 * @canonical loop_dashboard_collect -- the dashboard's I/O: GitHub (through the `gh` CLI, which
 * gets its short-lived token from the broker) and the loop journal on disk.
 *
 * GitHub's JSON is narrowed into the snapshot's records here, field by field, so a shape change
 * fails loudly (`LOOP.DASHBOARD_BAD_GITHUB_DATA`) instead of rendering nonsense. Journal lines that
 * do not parse are skipped: the journal is append-only and a crashed run can leave a torn line.
 *
 * related: dashboard_snapshot.ts (the records), build_dashboard.ts (the caller).
 */

type Json = Record<string, unknown>

function asObject(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LoopDashboardError('LOOP.DASHBOARD_BAD_GITHUB_DATA', `Expected an object for ${what}.`, {
      context: { what },
    })
  }
  return value as Json
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new LoopDashboardError('LOOP.DASHBOARD_BAD_GITHUB_DATA', `Expected an array for ${what}.`, {
      context: { what },
    })
  }
  return value
}

function str(obj: Json, key: string, what: string): string {
  const value = obj[key]
  if (typeof value !== 'string') {
    throw new LoopDashboardError('LOOP.DASHBOARD_BAD_GITHUB_DATA', `Expected a string at ${what}.${key}.`, {
      context: { what, key },
    })
  }
  return value
}

function optStr(obj: Json, key: string): string | null {
  const value = obj[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function num(obj: Json, key: string, what: string): number {
  const value = obj[key]
  if (typeof value !== 'number') {
    throw new LoopDashboardError('LOOP.DASHBOARD_BAD_GITHUB_DATA', `Expected a number at ${what}.${key}.`, {
      context: { what, key },
    })
  }
  return value
}

function labelNames(obj: Json): string[] {
  return asArray(obj.labels ?? [], 'labels').map((label) => str(asObject(label, 'label'), 'name', 'label'))
}

function authorLogin(obj: Json): string {
  const author = obj.author
  return typeof author === 'object' && author !== null && typeof (author as Json).login === 'string'
    ? ((author as Json).login as string)
    : 'unknown'
}

function gh(args: readonly string[]): unknown {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return JSON.parse(out)
  } catch (cause) {
    throw new LoopDashboardError('LOOP.DASHBOARD_GITHUB_UNAVAILABLE', `gh ${args.slice(0, 2).join(' ')} failed.`, {
      context: { command: args.slice(0, 2).join(' ') },
      cause,
    })
  }
}

export function collectIssues(repo: string): IssueRecord[] {
  const raw = gh([
    'issue', 'list', '-R', repo, '--state', 'all', '--limit', '300',
    '--json', 'number,title,state,labels,milestone,author,createdAt,updatedAt,closedAt,url',
  ])
  return asArray(raw, 'issues').map((item) => {
    const o = asObject(item, 'issue')
    const milestone = o.milestone
    const state = str(o, 'state', 'issue')
    return {
      number: num(o, 'number', 'issue'),
      title: str(o, 'title', 'issue'),
      state: state === 'OPEN' ? 'OPEN' : 'CLOSED',
      labels: labelNames(o),
      milestone:
        typeof milestone === 'object' && milestone !== null ? optStr(milestone as Json, 'title') : null,
      author: authorLogin(o),
      created_at: str(o, 'createdAt', 'issue'),
      updated_at: str(o, 'updatedAt', 'issue'),
      closed_at: optStr(o, 'closedAt'),
      url: str(o, 'url', 'issue'),
    }
  })
}

export function collectPulls(repo: string): PullRecord[] {
  const raw = gh([
    'pr', 'list', '-R', repo, '--state', 'all', '--limit', '60',
    '--json', 'number,title,state,labels,author,createdAt,mergedAt,url',
  ])
  return asArray(raw, 'pulls').map((item) => {
    const o = asObject(item, 'pull')
    const state = str(o, 'state', 'pull')
    return {
      number: num(o, 'number', 'pull'),
      title: str(o, 'title', 'pull'),
      state: state === 'MERGED' ? 'MERGED' : state === 'OPEN' ? 'OPEN' : 'CLOSED',
      labels: labelNames(o),
      author: authorLogin(o),
      created_at: str(o, 'createdAt', 'pull'),
      merged_at: optStr(o, 'mergedAt'),
      url: str(o, 'url', 'pull'),
    }
  })
}

export function collectRuns(repo: string): WorkflowRunRecord[] {
  const raw = gh([
    'run', 'list', '-R', repo, '--limit', '60',
    '--json', 'databaseId,workflowName,status,conclusion,headBranch,event,headSha,displayTitle,createdAt,url',
  ])
  return asArray(raw, 'runs').map((item) => {
    const o = asObject(item, 'run')
    return {
      id: num(o, 'databaseId', 'run'),
      workflow: str(o, 'workflowName', 'run'),
      status: str(o, 'status', 'run'),
      conclusion: optStr(o, 'conclusion'),
      branch: str(o, 'headBranch', 'run'),
      event: str(o, 'event', 'run'),
      sha: str(o, 'headSha', 'run'),
      title: str(o, 'displayTitle', 'run'),
      created_at: str(o, 'createdAt', 'run'),
      url: str(o, 'url', 'run'),
    }
  })
}

export function collectMilestones(repo: string): MilestoneRecord[] {
  const raw = gh(['api', `repos/${repo}/milestones?state=all&per_page=100`])
  return asArray(raw, 'milestones').map((item) => {
    const o = asObject(item, 'milestone')
    return {
      number: num(o, 'number', 'milestone'),
      title: str(o, 'title', 'milestone'),
      state: str(o, 'state', 'milestone') === 'closed' ? 'closed' : 'open',
      open_issues: num(o, 'open_issues', 'milestone'),
      closed_issues: num(o, 'closed_issues', 'milestone'),
      url: str(o, 'html_url', 'milestone'),
    }
  })
}

/** Parse journal text: one JSON object per line; torn or foreign lines are skipped. */
export function parseJournal(text: string): JournalEntry[] {
  const entries: JournalEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const o = parsed as Json
    if (
      typeof o.run_id !== 'string' || typeof o.role !== 'string' || typeof o.started_at !== 'string' ||
      typeof o.finished_at !== 'string' || typeof o.outcome !== 'string' || Number.isNaN(Date.parse(o.started_at))
    ) {
      continue
    }
    const numbers = (value: unknown): number[] =>
      Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number') : []
    const nullableNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null)
    entries.push({
      run_id: o.run_id,
      role: o.role,
      started_at: o.started_at,
      finished_at: o.finished_at,
      outcome: o.outcome,
      summary: typeof o.summary === 'string' ? o.summary : '',
      ...(typeof o.skip_reason === 'string' ? { skip_reason: o.skip_reason } : {}),
      ...(typeof o.model === 'string' ? { model: o.model } : {}),
      cost_usd: nullableNumber(o.cost_usd),
      num_turns: nullableNumber(o.num_turns),
      duration_s: nullableNumber(o.duration_s),
      issues: numbers(o.issues),
      prs: numbers(o.prs),
    })
  }
  return entries
}

export function readJournal(path: string, keepLast = 1000): JournalEntry[] {
  if (!existsSync(path)) return []
  return parseJournal(readFileSync(path, 'utf8')).slice(-keepLast)
}

export interface CollectOptions {
  readonly repo: string
  readonly journalPath: string
  readonly digest: string | null
  readonly now: Date
}

export function collectDashboardSnapshot(options: CollectOptions): DashboardSnapshot {
  return {
    repo: options.repo,
    generated_at: options.now.toISOString(),
    digest: options.digest,
    issues: collectIssues(options.repo),
    pulls: collectPulls(options.repo),
    runs: collectRuns(options.repo),
    milestones: collectMilestones(options.repo),
    journal: readJournal(options.journalPath),
  }
}
