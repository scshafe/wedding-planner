import { ManualClock, type RiskSummary, SequentialIdGenerator, type WeddingTask, type WeddingVendor } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type ApiRequest,
  type ApiResponse,
  checkRiskSummary,
  composeProductSurface,
  computeRiskSignals,
  type HttpResult,
  isoWeek,
  renderRiskLine,
  type RiskInputs,
  simulateRiskSummary,
} from '@wedding-planner/product'

/**
 * Issue #62 — the weekly "what is at risk" summary: each signal and its window, the wording from the signals' own data,
 * the simulated judgement, the second check, and the weekly flow through the surface (the planner only).
 */

const task = (title: string, due_date: string, status: 'todo' | 'done' = 'todo') => ({ title, due_date, status }) as unknown as WeddingTask
const vendor = (business_name: string, contract_status: string, installments: { label: string; due_date: string; paid?: boolean }[] = []) =>
  ({ business_name, contract_status, installments: installments.map((i) => ({ amount_cents: 100, paid: false, ...i })) }) as unknown as WeddingVendor

function inputs(over: Partial<RiskInputs> = {}): RiskInputs {
  return { today: '2028-05-20', event_date: '2028-06-10', tasks: [], vendors: [], rsvps_closed: false, unanswered_households: [], unseated_guests: [], ...over }
}

describe('risk signals', () => {
  it('counts what is slipping, each in its own window, the most urgent labels first (at most three)', () => {
    const signals = computeRiskSignals(
      inputs({
        tasks: [task('Book band', '2028-05-01'), task('Order cake', '2028-05-10'), task('Final fitting', '2028-05-25'), task('Done thing', '2028-05-01', 'done'), task('Far off', '2028-06-05')],
        vendors: [
          vendor('Hall', 'signed', [{ label: 'Deposit', due_date: '2028-05-15' }, { label: 'Balance', due_date: '2028-06-01' }, { label: 'Paid one', due_date: '2028-05-01', paid: true }]),
          vendor('Snap', 'sent'),
          vendor('Gone', 'cancelled', [{ label: 'Refund', due_date: '2028-05-01' }]),
        ],
        unanswered_households: ['Rivera', 'Abe', 'Chen', 'Diaz'],
        unseated_guests: ['Zed'],
      }),
    )
    expect(signals.days_to_wedding).toBe(21)
    expect(signals.signals).toEqual([
      { key: 'overdue_tasks', count: 2, items: ['Book band', 'Order cake'] },
      { key: 'tasks_due_soon', count: 1, items: ['Final fitting'] },
      { key: 'payments_overdue', count: 1, items: ['Hall (Deposit)'] },
      { key: 'payments_due_soon', count: 1, items: ['Hall (Balance)'] },
      { key: 'rsvps_missing', count: 4, items: ['Abe', 'Chen', 'Diaz'] },
      { key: 'guests_unseated', count: 1, items: ['Zed'] },
      { key: 'contracts_unsigned', count: 1, items: ['Snap'] },
    ])
  })

  it('RSVPs count only while open and within 45 days; seats within 21; contracts within 90; nothing after the day', () => {
    const far = computeRiskSignals(inputs({ today: '2028-03-01', unanswered_households: ['A'], unseated_guests: ['B'], vendors: [vendor('V', 'none')] }))
    expect(far.signals).toEqual([])
    const closed = computeRiskSignals(inputs({ rsvps_closed: true, unanswered_households: ['A'] }))
    expect(closed.signals.map((s) => s.key)).toEqual([])
    const after = computeRiskSignals(inputs({ today: '2028-06-11', tasks: [task('Late', '2028-05-01')] }))
    expect(after.signals).toEqual([])
  })

  it('words each line from its own data only', () => {
    expect(renderRiskLine({ key: 'overdue_tasks', count: 5, items: ['A', 'B', 'C'] }, 21)).toBe('5 tasks are overdue: A, B, C, and 2 more.')
    expect(renderRiskLine({ key: 'guests_unseated', count: 1, items: ['Zed'] }, 9)).toBe('1 attending guest has no seat, 9 days before the wedding: Zed.')
    expect(renderRiskLine({ key: 'contracts_unsigned', count: 2, items: ['Hall', 'Snap'] }, 50)).toBe('2 vendor contracts are not signed: Hall, Snap.')
  })

  it('names the ISO week, across year boundaries', () => {
    expect(isoWeek('2026-10-20')).toBe('2026-W43')
    expect(isoWeek('2021-01-01')).toBe('2020-W53')
    expect(isoWeek('2024-12-30')).toBe('2025-W01')
    expect(isoWeek('2028-01-03')).toBe('2028-W01')
  })
})

describe('the summary judgement and the second check', () => {
  it('the simulated model: at risk when something is late or close, watch otherwise, on track when nothing; most urgent first', () => {
    const late = computeRiskSignals(inputs({ tasks: [task('Late', '2028-05-01'), task('Soon', '2028-05-22')], vendors: [vendor('V', 'none')] }))
    expect(simulateRiskSummary(late as never)).toEqual({ level: 'at_risk', mention: ['overdue_tasks', 'tasks_due_soon', 'contracts_unsigned'] })
    const soon = computeRiskSignals(inputs({ tasks: [task('Soon', '2028-05-22')] }))
    expect(simulateRiskSummary(soon as never).level).toBe('watch')
    expect(simulateRiskSummary(computeRiskSignals(inputs()) as never)).toEqual({ level: 'on_track', mention: [] })
  })

  it('keeps only signals the job computed and makes the level honest', () => {
    const signals = computeRiskSignals(inputs({ tasks: [task('Soon', '2028-05-22')] }))
    expect(checkRiskSummary(signals, { level: 'at_risk', mention: ['payments_overdue', 'tasks_due_soon', 'tasks_due_soon'] })).toEqual({
      week: '2028-W20',
      level: 'at_risk',
      lines: ['1 task is due this week: Soon.'],
    })
    // On track with a signal is not honest: watch. A mention of nothing real still lists the signals.
    expect(checkRiskSummary(signals, { level: 'on_track', mention: ['guests_unseated'] })).toMatchObject({ level: 'watch', lines: ['1 task is due this week: Soon.'] })
    const none = computeRiskSignals(inputs())
    expect(checkRiskSummary(none, { level: 'at_risk', mention: ['overdue_tasks'] })).toEqual({ week: '2028-W20', level: 'on_track', lines: [] })
  })
})

describe('the weekly summary through the surface', () => {
  function setup() {
    const clock = new ManualClock('2028-05-20T12:00:00.000Z')
    const s = composeProductSurface({
      clock,
      ids: new SequentialIdGenerator('rk'),
      operatorToken: 'rk-operator-token-0123456789',
      providerWebhookToken: 'rk-webhook-token-0123456789',
      demoSlug: 'demo',
      passwordCost: { N: 16, r: 1, p: 1 },
    })
    const api = (method: string, path: string, token?: string, body?: unknown): ApiResponse =>
      s.api.handle({ method, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, rawBody: body === undefined ? undefined : JSON.stringify(body) } as ApiRequest)
    const planner = (api('POST', '/t/demo/sessions', undefined, { role: 'planner' }).body as { token: string }).token
    const wedding = (api('POST', '/t/demo/weddings', planner, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' }).body as { wedding: { wedding_id: string } }).wedding.wedding_id
    const couple = (api('POST', '/t/demo/sessions', undefined, { role: 'couple', wedding_id: wedding }).body as { token: string }).token
    api('POST', `/t/demo/weddings/${wedding}/tasks`, planner, { title: 'Book band', due_date: '2028-05-01', assignee: 'planner' })
    const login = (fields: Record<string, string>): string => {
      const res = s.ui.handle({ method: 'POST', path: '/t/demo/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: new URLSearchParams(fields).toString() })
      return `wp_session=${/wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]}`
    }
    const page = (path: string, cookie: string): HttpResult => s.ui.handle({ method: 'GET', path, headers: { cookie } })
    return { ...s, clock, api, planner, couple, wedding, login, page }
  }

  it("reading asks for this week's summary; the job writes it; a new week asks again", async () => {
    const w = setup()
    expect(w.api('GET', `/t/demo/weddings/${w.wedding}/risk-summary`, w.planner).body).toEqual({ preparing: true })
    await w.drainJobs()
    const ready = w.api('GET', `/t/demo/weddings/${w.wedding}/risk-summary`, w.planner).body as { summary: RiskSummary; preparing: boolean }
    expect(ready.preparing).toBe(false)
    expect(ready.summary).toMatchObject({ week: '2028-W20', level: 'at_risk', lines: ['1 task is overdue: Book band.'] })
    // Saturday 2028-05-20 → Monday 2028-05-22: a new ISO week.
    w.clock.advance(2 * 86_400_000)
    expect(w.api('GET', `/t/demo/weddings/${w.wedding}/risk-summary`, w.planner).body).toEqual({ preparing: true })
  })

  it('the planner sees it on the wedding page and across weddings on the home page; the couple does not', async () => {
    const w = setup()
    const planner = w.login({ role: 'planner' })
    expect(w.page(`/t/demo?wedding=${w.wedding}`, planner).body).toContain("This week's summary is being prepared")
    w.page('/t/demo', planner)
    await w.drainJobs()
    expect(w.page(`/t/demo?wedding=${w.wedding}`, planner).body).toContain('This week: At risk')
    const home = w.page('/t/demo', planner).body
    expect(home).toContain('This week across your weddings')
    expect(home).toContain('1 task is overdue: Book band.')
    // The couple: 403 on the JSON routes (before anything is enqueued), no card on its pages.
    expect(w.api('GET', `/t/demo/weddings/${w.wedding}/risk-summary`, w.couple).status).toBe(403)
    expect(w.api('GET', '/t/demo/risk-summaries', w.couple).status).toBe(403)
    const couple = w.login({ role: 'couple', wedding_id: w.wedding })
    expect(w.page(`/t/demo?wedding=${w.wedding}`, couple).body).not.toContain('This week')
    expect(w.page('/t/demo', couple).body).not.toContain('This week across')
  })
})
