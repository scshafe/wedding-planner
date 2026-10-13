import type {
  DashboardView,
  HealthVerdict,
  IssueRecord,
  JournalEntry,
  MilestoneProgress,
  PullRecord,
  RoleHeartbeat,
  RunHealth,
  SpendDay,
} from './dashboard_snapshot'
import { priorityName } from './dashboard_snapshot'

/**
 * @canonical loop_dashboard_render -- the engineering dashboard page, as one self-contained HTML
 * document (published as a claude.ai artifact by the reporter role).
 *
 * Pure: a {@link DashboardView} in, a string out. Every interpolated value is escaped with
 * {@link escapeHtml} (issue titles, labels, summaries and the digest can all come from strangers),
 * and a link is emitted only for an https://github.com/ URL ({@link safeGithubUrl}); anything else
 * renders as plain text. The page is complete at rest: the one script only rewrites UTC times into
 * the viewer's local time.
 *
 * related: dashboard_snapshot.ts (the view), build_dashboard.ts (writes the file).
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escape text for HTML element content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}

/** The URL itself when it is an https link on github.com, else null (rendered without a link). */
export function safeGithubUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' ? parsed.href : null
  } catch {
    return null
  }
}

/** A count or id as text. Numbers from a saved snapshot are not trusted to be numbers. */
function int(value: number): string {
  const n = Number(value)
  return Number.isFinite(n) ? String(Math.trunc(n)) : '0'
}

function link(url: string, text: string, className = ''): string {
  const safe = safeGithubUrl(url)
  const cls = className === '' ? '' : ` class="${className}"`
  return safe === null
    ? `<span${cls}>${escapeHtml(text)}</span>`
    : `<a${cls} href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`
}

/** "3 h ago", "2 d ago": relative to the generation instant, so the page reads right at rest. */
export function relativeTime(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - Date.parse(iso)) / 60_000)
  if (Number.isNaN(minutes)) return ''
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** Dollars for the spend figures: "$0", "<$0.01", "$3.40", "$128". */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString('en-US')}`
}

function utcStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return escapeHtml(iso)
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} ${month}, ${hh}:${mm} UTC`
}

function time(iso: string): string {
  return `<time datetime="${escapeHtml(iso)}">${utcStamp(iso)}</time>`
}

type Tone = 'good' | 'bad' | 'warn' | 'owner' | 'plain'

function chip(text: string, tone: Tone = 'plain'): string {
  return `<span class="chip chip-${tone}">${escapeHtml(text)}</span>`
}

const OUTCOME_TONE: Readonly<Record<string, Tone>> = {
  merged: 'good',
  reported: 'good',
  triaged: 'good',
  filed: 'good',
  'pr-open': 'plain',
  'no-work': 'plain',
  blocked: 'owner',
  failed: 'bad',
  timeout: 'bad',
  unreported: 'warn',
  skipped: 'plain',
}

function outcomeChip(entry: JournalEntry): string {
  const label = entry.outcome === 'skipped' ? `skipped: ${entry.skip_reason ?? 'no reason'}` : entry.outcome
  return chip(label, OUTCOME_TONE[entry.outcome] ?? 'plain')
}

const VERDICT_TEXT: Readonly<Record<HealthVerdict, { label: string; tone: Tone }>> = {
  healthy: { label: 'passing', tone: 'good' },
  failing: { label: 'failing', tone: 'bad' },
  running: { label: 'running', tone: 'warn' },
  unknown: { label: 'no runs yet', tone: 'plain' },
}

function productionPill(deploy: RunHealth): string {
  const text: Record<HealthVerdict, string> = {
    healthy: 'Production healthy',
    failing: 'Last deploy failed',
    running: 'Deploying now',
    unknown: 'No deploy recorded',
  }
  return chip(text[deploy.verdict], VERDICT_TEXT[deploy.verdict].tone)
}

function issueItem(issue: IssueRecord, now: Date): string {
  const priority = priorityName(issue)
  const meta = [
    `<span class="num">#${int(issue.number)}</span>`,
    priority === null ? '' : chip(priority, priority === 'P0' ? 'bad' : 'plain'),
    issue.milestone === null ? '' : `<span>${escapeHtml(issue.milestone)}</span>`,
    `<span>updated ${escapeHtml(relativeTime(issue.updated_at, now))}</span>`,
  ].filter((part) => part !== '')
  return `<li class="item">${link(issue.url, issue.title, 'item-title')}<div class="item-meta">${meta.join('')}</div></li>`
}

function pullItem(pr: PullRecord, now: Date, when: 'opened' | 'merged'): string {
  const at = when === 'merged' ? (pr.merged_at ?? pr.created_at) : pr.created_at
  return `<li class="item">${link(pr.url, pr.title, 'item-title')}<div class="item-meta"><span class="num">PR #${int(pr.number)}</span><span>${when} ${escapeHtml(relativeTime(at, now))}</span><span>by ${escapeHtml(pr.author)}</span></div></li>`
}

function list(items: readonly string[], empty: string): string {
  return items.length === 0 ? `<p class="empty">${escapeHtml(empty)}</p>` : `<ul class="items">${items.join('')}</ul>`
}

function section(title: string, count: number | null, body: string, className = ''): string {
  const countHtml = count === null ? '' : `<span class="count">${count}</span>`
  const cls = className === '' ? 'block' : `block ${className}`
  return `<section class="${cls}"><h2>${escapeHtml(title)}${countHtml}</h2>${body}</section>`
}

function healthRow(label: string, health: RunHealth, now: Date): string {
  const verdict = VERDICT_TEXT[health.verdict]
  const run = health.run
  const detail =
    run === null
      ? '<span class="faint">Nothing has run on main yet.</span>'
      : `${link(run.url, run.title)}<span class="faint"> · <span class="mono">${escapeHtml(run.sha.slice(0, 7))}</span> · ${escapeHtml(relativeTime(run.created_at, now))}</span>`
  return `<div class="health-row"><span class="health-label">${escapeHtml(label)}</span>${chip(verdict.label, verdict.tone)}<div class="health-detail">${detail}</div></div>`
}

function milestoneRow(progress: MilestoneProgress): string {
  const { milestone, total, fraction } = progress
  const pct = Number(int(fraction * 100))
  const state = milestone.state === 'closed' ? ' · closed' : ''
  return `<li class="milestone"><div class="milestone-head">${link(milestone.url, milestone.title, 'milestone-title')}<span class="mono faint">${int(milestone.closed_issues)}/${int(total)}${state}</span></div><div class="meter" role="img" aria-label="${pct}% of ${int(total)} issues closed"><span style="width:${pct}%"></span></div></li>`
}

function runRow(entry: JournalEntry): string {
  const cost = entry.cost_usd === null || entry.cost_usd === undefined ? '' : formatUsd(entry.cost_usd)
  const minutes =
    entry.duration_s === null || entry.duration_s === undefined ? '' : `${Math.max(1, Math.round(entry.duration_s / 60))} min`
  const facts = [minutes, cost].filter((part) => part !== '').join(' · ')
  return `<li class="run"><time class="run-time mono" datetime="${escapeHtml(entry.started_at)}" data-format="weekday">${utcStamp(entry.started_at)}</time><div class="run-body"><div class="run-head"><span class="role">${escapeHtml(entry.role)}</span>${outcomeChip(entry)}${facts === '' ? '' : `<span class="mono faint">${escapeHtml(facts)}</span>`}</div><p class="run-summary">${escapeHtml(entry.summary)}</p></div></li>`
}

function heartbeatTable(heartbeats: readonly RoleHeartbeat[], now: Date): string {
  const rows = heartbeats
    .map((beat) => {
      const last = beat.last === null ? '<span class="faint">never</span>' : escapeHtml(relativeTime(beat.last.started_at, now))
      const outcome = beat.last === null ? '' : outcomeChip(beat.last)
      const worked =
        beat.last_worked === null ? '<span class="faint">never</span>' : escapeHtml(relativeTime(beat.last_worked.started_at, now))
      return `<tr><th scope="row">${escapeHtml(beat.role)}</th><td>${last}</td><td>${outcome}</td><td>${worked}</td></tr>`
    })
    .join('')
  return `<div class="table-wrap"><table class="beats"><thead><tr><th scope="col">Role</th><th scope="col">Last tick</th><th scope="col">Result</th><th scope="col">Last real run</th></tr></thead><tbody>${rows}</tbody></table></div>`
}

/** A 14-day bar chart of recorded loop spend: one series, one scale, rounded data-ends. */
export function spendChart(days: readonly SpendDay[]): string {
  const max = Math.max(0, ...days.map((day) => day.usd))
  if (max === 0) return '<p class="empty">No spend recorded in the last 14 days.</p>'
  const width = 280
  const height = 96
  const top = 14
  const base = 78
  const slot = width / days.length
  const barWidth = Math.max(4, slot - 6)
  const bars = days
    .map((day, index) => {
      const h = (day.usd / max) * (base - top)
      const x = index * slot + (slot - barWidth) / 2
      const label = `${day.day}: ${formatUsd(day.usd)} across ${day.runs} run${day.runs === 1 ? '' : 's'}`
      if (h <= 0) return `<rect class="bar-hit" x="${x.toFixed(1)}" y="${top}" width="${barWidth.toFixed(1)}" height="${base - top}"><title>${escapeHtml(label)}</title></rect>`
      const r = Math.min(4, h, barWidth / 2)
      const y = base - h
      const path = `M${x.toFixed(1)},${base} V${(y + r).toFixed(1)} Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)} H${(x + barWidth - r).toFixed(1)} Q${(x + barWidth).toFixed(1)},${y.toFixed(1)} ${(x + barWidth).toFixed(1)},${(y + r).toFixed(1)} V${base} Z`
      return `<g><rect class="bar-hit" x="${x.toFixed(1)}" y="${top}" width="${barWidth.toFixed(1)}" height="${base - top}"></rect><path class="bar" d="${path}"></path><title>${escapeHtml(label)}</title></g>`
    })
    .join('')
  const first = days[0]?.day.slice(5) ?? ''
  const last = days[days.length - 1]?.day.slice(5) ?? ''
  return `<svg class="spend" viewBox="0 0 ${width} ${height}" role="img" aria-label="Loop spend per day for the last ${days.length} days; the highest day was ${escapeHtml(formatUsd(max))}"><line class="grid" x1="0" x2="${width}" y1="${top}" y2="${top}"></line><text class="axis" x="0" y="${top - 4}">${escapeHtml(formatUsd(max))}</text><line class="baseline" x1="0" x2="${width}" y1="${base}" y2="${base}"></line>${bars}<text class="axis" x="0" y="${height - 2}">${escapeHtml(first)}</text><text class="axis" x="${width}" y="${height - 2}" text-anchor="end">${escapeHtml(last)}</text></svg>`
}

function figure(value: string, label: string, tone: Tone | null): string {
  const cls = tone === null ? 'figure' : `figure figure-${tone}`
  return `<div class="${cls}"><span class="figure-value">${escapeHtml(value)}</span><span class="figure-label">${escapeHtml(label)}</span></div>`
}

function digestBlock(digest: string | null): string {
  if (digest === null || digest.trim() === '') return ''
  const paragraphs = digest
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.replace(/\s*\n\s*/g, ' '))}</p>`)
    .join('')
  return `<section class="digest" aria-label="Reporter's note"><h2 class="eyebrow">Reporter's note</h2>${paragraphs}</section>`
}

const STYLES = `
:root {
  /* Layout: a two-lane board. The work (what is waiting, moving, next, shipped) on the left; the system (health, milestones, the run of show) on the right. One lane under 60rem. */
  --paper: #f4f6f9;
  --surface: #ffffff;
  --ink: #18202e;
  --ink-soft: #465066;
  --ink-faint: #616b7f;
  --rule: #dce1e9;
  --accent: #2c4a7c;
  --accent-wash: #e7edf7;
  --good: #1e7048;
  --good-wash: #e2f1e8;
  --warn: #855600;
  --warn-wash: #faefd7;
  --bad: #b0261e;
  --bad-wash: #fae5e3;
  --owner: #5a3c94;
  --owner-wash: #efe9f8;
  --font-display: "Libre Caslon Text", "Iowan Old Style", Georgia, serif;
  --font-body: "Public Sans", "Segoe UI", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  --step--1: 0.75rem;
  --step-0: 0.875rem;
  --step-1: 1rem;
  --step-2: 1.25rem;
  --step-3: 1.75rem;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --paper: #0f131a; --surface: #161c26; --ink: #e5e9f0; --ink-soft: #b0b8c6; --ink-faint: #8a94a6;
    --rule: #283040; --accent: #9bb4e4; --accent-wash: #1c2840; --good: #6fcb98; --good-wash: #13281d;
    --warn: #e3b65e; --warn-wash: #2b2311; --bad: #f28b80; --bad-wash: #331917; --owner: #bda6ec; --owner-wash: #251c37;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --paper: #0f131a; --surface: #161c26; --ink: #e5e9f0; --ink-soft: #b0b8c6; --ink-faint: #8a94a6;
  --rule: #283040; --accent: #9bb4e4; --accent-wash: #1c2840; --good: #6fcb98; --good-wash: #13281d;
  --warn: #e3b65e; --warn-wash: #2b2311; --bad: #f28b80; --bad-wash: #331917; --owner: #bda6ec; --owner-wash: #251c37;
}
body { background: var(--paper); color: var(--ink); font-family: var(--font-body); font-size: var(--step-0); line-height: 1.5; }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
.page { max-width: 76rem; margin: 0 auto; padding-inline: max(16px, 3vw); padding-block: 1.75rem 3rem; display: flex; flex-direction: column; gap: 1.75rem; }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.faint { color: var(--ink-faint); }
.eyebrow { font-family: var(--font-body); font-size: var(--step--1); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); margin: 0; }
.masthead { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 0.75rem 2rem; border-bottom: 1px solid var(--rule); padding-bottom: 1rem; }
.masthead h1 { font-family: var(--font-display); font-weight: 400; font-size: var(--step-3); line-height: 1.15; margin: 0.25rem 0 0; text-wrap: balance; }
.masthead-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; color: var(--ink-soft); }
.digest { max-width: 65ch; display: flex; flex-direction: column; gap: 0.4rem; }
.digest p { margin: 0; font-size: var(--step-1); color: var(--ink); }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); border-radius: 6px; overflow: hidden; }
.figure { background: var(--surface); padding: 0.85rem 1rem; display: flex; flex-direction: column; gap: 0.15rem; }
.figure-value { font-family: var(--font-display); font-size: var(--step-3); line-height: 1.1; font-variant-numeric: tabular-nums lining-nums; }
.figure-label { font-size: var(--step--1); color: var(--ink-soft); }
.figure-owner { background: var(--owner-wash); }
.figure-owner .figure-value { color: var(--owner); }
.figure-bad { background: var(--bad-wash); }
.figure-bad .figure-value { color: var(--bad); }
.board { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 2.5rem; align-items: start; }
.lane { display: flex; flex-direction: column; gap: 2rem; min-width: 0; }
.block h2 { font-family: var(--font-display); font-weight: 400; font-size: var(--step-2); line-height: 1.25; margin: 0 0 0.5rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--rule); display: flex; align-items: baseline; gap: 0.6rem; text-wrap: balance; }
.count { font-family: var(--font-mono); font-size: var(--step--1); color: var(--ink-faint); }
.block-owner { background: var(--owner-wash); border-radius: 6px; padding: 0.9rem 1rem 0.4rem; }
.block-owner h2 { border-bottom-color: color-mix(in srgb, var(--owner) 30%, transparent); }
.block-incident { background: var(--bad-wash); border-radius: 6px; padding: 0.9rem 1rem 0.4rem; }
.items, .runs, .milestones { list-style: none; margin: 0; padding: 0; }
.item { padding: 0.55rem 0; display: flex; flex-direction: column; gap: 0.2rem; }
.item + .item { border-top: 1px solid var(--rule); }
.item-title { font-weight: 500; overflow-wrap: anywhere; }
.item-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.75rem; color: var(--ink-faint); font-size: var(--step--1); }
.num { font-family: var(--font-mono); }
.chip { display: inline-flex; align-items: center; padding: 0.05rem 0.45rem; border-radius: 999px; font-size: var(--step--1); font-weight: 600; line-height: 1.5; white-space: nowrap; background: var(--accent-wash); color: var(--accent); }
.chip-good { background: var(--good-wash); color: var(--good); }
.chip-bad { background: var(--bad-wash); color: var(--bad); }
.chip-warn { background: var(--warn-wash); color: var(--warn); }
.chip-owner { background: var(--owner-wash); color: var(--owner); }
.block-owner .chip-plain, .block-incident .chip-plain { background: var(--surface); }
.empty { margin: 0.4rem 0; color: var(--ink-faint); }
.health-row { display: grid; grid-template-columns: 4.5rem auto minmax(0, 1fr); align-items: baseline; gap: 0.5rem; padding: 0.45rem 0; }
.health-row + .health-row { border-top: 1px solid var(--rule); }
.health-label { font-weight: 600; }
.health-row .chip { justify-self: start; }
.health-detail { min-width: 0; overflow-wrap: anywhere; }
.milestone { padding: 0.45rem 0; display: flex; flex-direction: column; gap: 0.35rem; }
.milestone-head { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
.milestone-title { font-weight: 500; }
.meter { height: 6px; border-radius: 3px; background: var(--accent-wash); overflow: hidden; }
.meter span { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
.run { display: grid; grid-template-columns: 6.5rem minmax(0, 1fr); gap: 0.75rem; padding: 0.55rem 0; }
.run + .run { border-top: 1px solid var(--rule); }
.run-time { font-size: var(--step--1); color: var(--ink-soft); padding-top: 0.1rem; }
.run-body { min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.run-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.6rem; }
.role { font-weight: 600; }
.run-summary { margin: 0; color: var(--ink-soft); overflow-wrap: anywhere; }
.table-wrap { overflow-x: auto; }
.beats { width: 100%; border-collapse: collapse; font-size: var(--step--1); }
.beats th, .beats td { text-align: left; padding: 0.4rem 0.5rem 0.4rem 0; border-bottom: 1px solid var(--rule); white-space: nowrap; }
.beats thead th { color: var(--ink-faint); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.beats tbody th { font-weight: 600; }
.spend { width: 100%; height: auto; max-width: 100%; display: block; }
.spend .bar { fill: var(--accent); }
.spend .bar-hit { fill: transparent; }
.spend g:hover .bar { fill: var(--ink); }
.spend .grid { stroke: var(--rule); stroke-width: 1; stroke-dasharray: 2 3; }
.spend .baseline { stroke: var(--ink-faint); stroke-width: 1; }
.spend .axis { fill: var(--ink-faint); font-family: var(--font-mono); font-size: 9px; }
.spend-total { display: flex; justify-content: space-between; gap: 1rem; color: var(--ink-soft); margin-top: 0.35rem; }
footer { border-top: 1px solid var(--rule); padding-top: 1rem; color: var(--ink-faint); font-size: var(--step--1); max-width: 80ch; }
footer p { margin: 0 0 0.35rem; }
code { font-family: var(--font-mono); font-size: 0.95em; }
@media (max-width: 60rem) { .board { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 26rem) { .run { grid-template-columns: minmax(0, 1fr); gap: 0.15rem; } .health-row { grid-template-columns: auto minmax(0, 1fr); } .health-detail { grid-column: 1 / -1; } }
`

const LOCAL_TIME_SCRIPT = `
(function () {
  var weekday = { weekday: 'short', hour: 'numeric', minute: '2-digit' };
  var full = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  document.querySelectorAll('time[datetime]').forEach(function (el) {
    var d = new Date(el.getAttribute('datetime'));
    if (isNaN(d.getTime())) return;
    el.title = d.toISOString();
    el.textContent = d.toLocaleString(undefined, el.getAttribute('data-format') === 'weekday' ? weekday : full);
  });
})();
`

/** Render the whole dashboard page. `now` is the generation instant (relative times read from it). */
export function renderDashboard(view: DashboardView, now: Date): string {
  const repoUrl = `https://github.com/${view.repo}`
  const owner = view.waiting_on_owner.map((issue) => issueItem(issue, now))
  const inProgress = [
    ...view.in_progress.map((issue) => issueItem(issue, now)),
    ...view.open_loop_prs.map((pr) => pullItem(pr, now, 'opened')),
  ]

  const work = [
    section('Waiting on you', view.waiting_on_owner.length, list(owner, 'Nothing is waiting on you.'), 'block-owner'),
    view.incidents.length === 0
      ? ''
      : section('Incidents', view.incidents.length, list(view.incidents.map((i) => issueItem(i, now)), ''), 'block-incident'),
    section('In progress', inProgress.length, list(inProgress, 'Nothing is being built right now.')),
    section(
      'Next up',
      view.next_up.length,
      list(
        view.next_up.slice(0, 8).map((issue) => issueItem(issue, now)),
        'The ready queue is empty. The triage agent fills it from the roadmap each morning.',
      ) + (view.triage_count > 0 ? `<p class="empty">${view.triage_count} more waiting for triage.</p>` : ''),
    ),
    view.blocked.length === 0
      ? ''
      : section('Blocked', view.blocked.length, list(view.blocked.map((i) => issueItem(i, now)), '')),
    section(
      'Shipped this week',
      view.shipped.length,
      list(
        view.shipped.map((pr) => pullItem(pr, now, 'merged')),
        'Nothing merged in the last 7 days.',
      ),
    ),
  ]

  const system = [
    section(
      'Production and CI',
      null,
      healthRow('Deploy', view.deploy, now) + healthRow('CI', view.ci, now),
    ),
    section(
      'Milestones',
      null,
      view.milestones.length === 0
        ? '<p class="empty">No milestones yet.</p>'
        : `<ul class="milestones">${view.milestones.map(milestoneRow).join('')}</ul>`,
    ),
    section(
      'Run of show',
      view.recent_runs.length,
      view.recent_runs.length === 0
        ? '<p class="empty">No loop runs recorded yet. Runs appear here once the timers are installed.</p>'
        : `<ul class="runs">${view.recent_runs.map(runRow).join('')}</ul>`,
    ),
    section('Roles', null, heartbeatTable(view.heartbeats, now)),
    section(
      'Loop spend',
      null,
      spendChart(view.spend_by_day) +
        `<div class="spend-total"><span>Last 7 days</span><span class="mono">${escapeHtml(formatUsd(view.spend_7d_usd))} · ${view.runs_7d} run${view.runs_7d === 1 ? '' : 's'}</span></div>`,
    ),
    section(
      'Feedback inbox',
      view.feedback_open.length,
      list(
        view.feedback_open.slice(0, 6).map((issue) => issueItem(issue, now)),
        'No unprocessed feedback.',
      ),
    ),
  ]

  const figures = [
    figure(String(view.waiting_on_owner.length), 'Waiting on you', view.waiting_on_owner.length > 0 ? 'owner' : null),
    figure(String(view.incidents.length), 'Open incidents', view.incidents.length > 0 ? 'bad' : null),
    figure(String(view.in_progress.length), 'In progress', null),
    figure(String(view.next_up.length), 'Ready to build', null),
    figure(String(view.shipped.length), 'Shipped, 7 days', null),
    figure(formatUsd(view.spend_7d_usd), 'Loop spend, 7 days', null),
  ]

  return `<title>Wedding Planner Engineering</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Libre+Caslon+Text:wght@400;700&family=Public+Sans:wght@400;500;600&display=swap">
<style>${STYLES}</style>
<div class="page">
<header class="masthead">
<div><p class="eyebrow">${link(repoUrl, view.repo)} · engineering loop</p><h1>Wedding Planner Engineering</h1></div>
<div class="masthead-meta">${productionPill(view.deploy)}<span>Updated ${time(view.generated_at)}</span></div>
</header>
${digestBlock(view.digest)}
<section class="summary" aria-label="At a glance">${figures.join('')}</section>
<div class="board">
<div class="lane">${work.join('')}</div>
<div class="lane">${system.join('')}</div>
</div>
<footer>
<p>Built from GitHub issues, pull requests and Actions runs, plus the loop journal. The reporter republishes it twice a day.</p>
<p>To pause every agent, open any issue on ${link(repoUrl, view.repo)} with the label <code>loop:paused</code>; close it to resume.</p>
</footer>
</div>
<script>${LOCAL_TIME_SCRIPT}</script>
`
}
