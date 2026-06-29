import type { EscalationReply, EscalationResolution, GuestEscalation, Tenant, Wedding } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { NEUTRAL_COLOR } from '../../src/web/html'
import type { BillingActivityEntry } from '../../src/billing/billing_activity'
import type { BillingSummary } from '../../src/billing/billing_summary'
import type { AccountOverview } from '../../src/web/pages'
import {
  countOpenEscalations,
  ERROR_500,
  GENERIC_404,
  renderBilling,
  renderConsole,
  renderDetail,
  renderEscalations,
  renderGuests,
  renderHome,
  renderLanding,
  renderLogin,
} from '../../src/web/pages'

/**
 * Step-3 coverage: the pure render functions escape every tenant/user string across the four contexts,
 * and the generic 404/500 are tenant-independent constants (the no-oracle masking carried into HTML).
 */

const SAFE_THEME: Tenant['theme'] = {
  brand_name: 'Acme Weddings',
  primary_color_hex: '#a1b2c3',
  accent_color_hex: '#445566',
  logo_ref: 'asset_logo_1',
}

/** A theme whose every free string + color is a distinct injection payload. */
const EVIL_THEME: Tenant['theme'] = {
  brand_name: '</style><script>alert(1)</script>',
  primary_color_hex: 'red;background:url(//evil/x)',
  accent_color_hex: '#fff;}</style><script>',
  logo_ref: 'javascript:alert(document.cookie)',
}

const EVIL_WEDDING: Wedding = {
  wedding_id: 'w"><img src=x onerror=alert(1)>',
  tenant_id: 'tenant_1',
  couple_display_name: '<script>alert("xss")</script>',
  event_date: '2029-05-05',
  status: 'planning',
  created_at: '2027-01-01T00:00:00.000Z',
}

/**
 * No live markup may survive. User payloads with `<`/`>`/`"` are escaped to entities, so no USER tag or
 * attribute breakout can form: there is no raw `<script`/`<img` and no `javascript:` in a `src`/`href`
 * (the only `<` in the output come from the trusted static template). An escaped substring like
 * `onerror=alert(1)` appearing as inert TEXT (after its `<` became `&lt;`) is harmless and allowed.
 */
function assertNoLiveMarkup(htmlText: string, payloadOwner: string): void {
  const lowered = htmlText.toLowerCase()
  expect(lowered, payloadOwner).not.toContain('<script')
  expect(lowered, payloadOwner).not.toContain('<img')
  expect(lowered, payloadOwner).not.toContain('</style><script')
  expect(lowered, payloadOwner).not.toContain('href="javascript:')
  expect(lowered, payloadOwner).not.toContain('src="javascript:')
}

describe('renderLogin', () => {
  it('renders the simulation label and a role form posting to the validated slug', () => {
    const out = renderLogin(SAFE_THEME, 'acme')
    expect(out).toContain('Simulated login')
    expect(out).toContain('action="/t/acme/login"')
    expect(out).toContain('Acme Weddings')
  })

  it('escapes an injection theme across HTML/CSS/URL contexts', () => {
    const out = renderLogin(EVIL_THEME, 'acme')
    assertNoLiveMarkup(out, 'login/theme')
    // The malformed colors collapse to the neutral constant in the style attribute.
    expect(out).toContain(`--brand:${NEUTRAL_COLOR}`)
    expect(out).toContain(`--accent:${NEUTRAL_COLOR}`)
    // logo_ref appears only as escaped text, never as a usable javascript: scheme.
    expect(out).toContain('logo asset:')
  })
})

describe('renderConsole / renderDetail', () => {
  it('lists weddings with links to the ?wedding= detail route', () => {
    const out = renderConsole(SAFE_THEME, 'acme', [EVIL_WEDDING], 'csrf-token-1')
    expect(out).toContain('href="/t/acme?wedding=')
    assertNoLiveMarkup(out, 'console/wedding')
  })

  it('renders an empty-state when there are no weddings', () => {
    const out = renderConsole(SAFE_THEME, 'acme', [], 'csrf-token-1')
    expect(out).toContain('No weddings to show')
  })

  it('escapes the couple name and id on the detail page', () => {
    const out = renderDetail(SAFE_THEME, 'acme', EVIL_WEDDING, 'csrf-detail-1')
    assertNoLiveMarkup(out, 'detail/wedding')
    expect(out).toContain('← All weddings')
  })

  it('renders the guest-visible logistics facts when set, omits them when unset', () => {
    const bare = renderDetail(SAFE_THEME, 'acme', { ...EVIL_WEDDING, couple_display_name: 'Alex & Sam' }, 'csrf-detail-1')
    expect(bare).not.toContain('Ceremony:')
    expect(bare).not.toContain('Dress code:')

    const full = renderDetail(
      SAFE_THEME,
      'acme',
      {
        wedding_id: 'w1',
        tenant_id: 't1',
        couple_display_name: 'Alex & Sam',
        event_date: '2029-05-05',
        status: 'planning',
        created_at: '2027-01-01T00:00:00.000Z',
        ceremony_time: '16:30',
        venue_name: 'The Grand Hall',
        parking_info: 'Free lot on 5th',
        dress_code: 'Black tie',
      },
      'csrf-detail-1',
    )
    expect(full).toContain('Ceremony:')
    expect(full).toContain('16:30')
    expect(full).toContain('The Grand Hall')
    expect(full).toContain('Black tie')
  })

  it('escapes a malicious logistics value (no double-escape, no live markup)', () => {
    const out = renderDetail(
      SAFE_THEME,
      'acme',
      { ...EVIL_WEDDING, couple_display_name: 'Alex & Sam', venue_name: '<script>alert(1)</script>' },
      'csrf-detail-1',
    )
    assertNoLiveMarkup(out, 'detail/logistics')
    // The escaped form is present as inert text (proves it rendered, escaped, not dropped).
    expect(out).toContain('&lt;script&gt;')
  })

  it('renders the edit form prefilled with the wedding + the CSRF token; status select marks the current value', () => {
    const out = renderDetail(
      SAFE_THEME,
      'acme',
      {
        wedding_id: 'wedding_42',
        tenant_id: 't1',
        couple_display_name: 'Alex & Sam',
        event_date: '2029-05-05',
        status: 'active',
        created_at: '2027-01-01T00:00:00.000Z',
        dress_code: 'Black tie',
      },
      'csrf-edit-tok',
    )
    expect(out).toContain('action="/t/acme/weddings/update"')
    expect(out).toContain('name="_csrf" value="csrf-edit-tok"')
    expect(out).toContain('name="wedding_id" value="wedding_42"')
    // Prefilled values + the selected status option.
    expect(out).toContain('value="2029-05-05"')
    expect(out).toContain('value="Black tie"')
    expect(out).toContain('<option value="active" selected>active</option>')
    expect(out).toContain('<option value="planning">planning</option>')
  })

  it('renders the create form on the console with the CSRF token and an empty status default', () => {
    const out = renderConsole(SAFE_THEME, 'acme', [], 'csrf-create-tok')
    expect(out).toContain('action="/t/acme/weddings/create"')
    expect(out).toContain('name="_csrf" value="csrf-create-tok"')
    // No prefill ⇒ no option carries `selected` (browser defaults to the first, planning).
    expect(out).not.toContain('selected')
  })

  it('shows the generic failure notices when invalid (no leak of why)', () => {
    const createOut = renderConsole(SAFE_THEME, 'acme', [], 'csrf-1', true)
    expect(createOut).toContain('could not be created')
    const editOut = renderDetail(SAFE_THEME, 'acme', EVIL_WEDDING, 'csrf-1', true)
    expect(editOut).toContain('could not be saved')
  })
})

describe('generic constants', () => {
  const ESC_1: GuestEscalation = { escalation_id: 'esc_1', tenant_id: 't1', wedding_id: 'wedding_42', from_ref: 'sms:+1555', text: 'where do I park?', received_at: '2027-05-01T00:00:00.000Z', provider_message_ref: 'pm_1', channel: 'sms' }

  it('renderEscalations lists an OPEN question with Resolve/Dismiss CSRF forms + a link to the wedding edit page', () => {
    const out = renderEscalations(SAFE_THEME, 'acme', [ESC_1], [], [], 'csrf-xyz')
    expect(out).toContain('where do I park?')
    expect(out).toContain('sms:+1555')
    expect(out).toContain('/t/acme?wedding=wedding_42')
    // The two action forms post escalation_id + status + the CSRF token to the resolve route.
    expect(out).toContain('action="/t/acme/escalations/resolve"')
    expect(out).toContain('name="escalation_id" value="esc_1"')
    expect(out).toContain('name="status" value="resolved"')
    expect(out).toContain('name="status" value="dismissed"')
    expect(out).toContain('value="csrf-xyz"')
    // Phase 28/34: the OPEN row also carries a Reply form (textarea) posting to the 4-seg reply route, with the
    // hidden seq = current thread length (0 with no replies yet) — the double-submit key.
    expect(out).toContain('action="/t/acme/escalations/reply"')
    expect(out).toContain('name="reply_text"')
    expect(out).toContain('name="seq" value="0"')
    expect(out).toContain('via sms') // the channel is shown so the operator knows how the reply goes out
  })

  it('renderEscalations moves a HANDLED question into a Handled section (status badge + a Reopen form, no Resolve/Dismiss)', () => {
    const resolution: EscalationResolution = { resolution_id: 'res_1', tenant_id: 't1', escalation_id: 'esc_1', wedding_id: 'wedding_42', seq: 0, status: 'dismissed', resolved_by: 'planner', resolved_at: '2027-05-02T00:00:00.000Z' }
    const out = renderEscalations(SAFE_THEME, 'acme', [ESC_1], [resolution], [], 'csrf-xyz')
    expect(out).toContain('Handled')
    expect(out).toContain('Dismissed by planner')
    // Phase 36: a handled row carries a Reopen form (status=reopened, no reply_text → routes to resolve, not reply)
    // but NO Resolve/Dismiss buttons (those only appear on open rows).
    expect(out).toContain('action="/t/acme/escalations/resolve"')
    expect(out).toContain('value="reopened"')
    expect(out).toContain('>Reopen<')
    expect(out).not.toContain('value="resolved"')
    expect(out).not.toContain('value="dismissed"')
    expect(out).not.toContain('action="/t/acme/escalations/reply"') // a handled row offers no reply form
    expect(out).toContain('No open questions')
  })

  it('Phase 36: a resolved-then-reopened escalation renders in the OPEN column (effective-open, max-seq reopened)', () => {
    const resolved: EscalationResolution = { resolution_id: 'res_0', tenant_id: 't1', escalation_id: 'esc_1', wedding_id: 'wedding_42', seq: 0, status: 'resolved', resolved_by: 'planner', resolved_at: '2027-05-02T00:00:00.000Z' }
    const reopened: EscalationResolution = { resolution_id: 'res_1', tenant_id: 't1', escalation_id: 'esc_1', wedding_id: 'wedding_42', seq: 1, status: 'reopened', resolved_by: 'planner', resolved_at: '2027-05-02T00:01:00.000Z' }
    // Pass out-of-seq-order to prove the fold uses MAX-seq, not last-in-array.
    const out = renderEscalations(SAFE_THEME, 'acme', [ESC_1], [reopened, resolved], [], 'csrf-xyz')
    // Effective-open → an open row with Resolve/Dismiss + Reply forms, NOT a handled row / badge.
    expect(out).toContain('value="resolved"')
    expect(out).toContain('value="dismissed"')
    expect(out).toContain('action="/t/acme/escalations/reply"')
    expect(out).not.toContain('Handled') // no handled section
    expect(out).not.toContain('Reopen') // no reopen affordance on an already-open row
  })

  it('Phase 36: a resolved→reopened→dismissed escalation renders HANDLED (max-seq dismissed)', () => {
    const mk = (seq: number, status: EscalationResolution['status']): EscalationResolution => ({ resolution_id: `res_${seq}`, tenant_id: 't1', escalation_id: 'esc_1', wedding_id: 'wedding_42', seq, status, resolved_by: 'planner', resolved_at: '2027-05-02T00:00:00.000Z' })
    const out = renderEscalations(SAFE_THEME, 'acme', [ESC_1], [mk(0, 'resolved'), mk(1, 'reopened'), mk(2, 'dismissed')], [], 'csrf-xyz')
    expect(out).toContain('Handled')
    expect(out).toContain('Dismissed by planner')
    expect(out).toContain('>Reopen<') // a Reopen affordance on the handled row
  })

  it('Phase 34: an OPEN row renders its reply THREAD and the form seq = thread length (multi-turn)', () => {
    const r0: EscalationReply = { reply_id: 'rep_0', tenant_id: 't1', escalation_id: 'esc_1', wedding_id: 'wedding_42', seq: 0, sender: 'couple', body: 'Parking is in lot B.', sent_at: '2027-05-02T00:00:00.000Z' }
    const r1: EscalationReply = { reply_id: 'rep_1', tenant_id: 't1', escalation_id: 'esc_1', wedding_id: 'wedding_42', seq: 1, sender: 'planner', body: 'By the oak tree.', sent_at: '2027-05-02T00:01:00.000Z' }
    // Pass out-of-order to prove the render sorts NUMERICALLY by seq, not insertion/lexicographic.
    const out = renderEscalations(SAFE_THEME, 'acme', [ESC_1], [], [r1, r0], 'csrf-xyz')
    expect(out).toContain('Couple: “Parking is in lot B.”')
    expect(out).toContain('Planner: “By the oak tree.”')
    expect(out.indexOf('Parking is in lot B.')).toBeLessThan(out.indexOf('By the oak tree.')) // seq 0 before seq 1
    // The next reply form carries seq = 2 (two replies already in the thread).
    expect(out).toContain('name="seq" value="2"')
  })

  it('Phase 34: a HANDLED row shows the full reply thread as the question→answer transcript', () => {
    const resolution: EscalationResolution = { resolution_id: 'res_1', tenant_id: 't1', escalation_id: 'esc_1', wedding_id: 'wedding_42', seq: 0, status: 'resolved', resolved_by: 'couple', resolved_at: '2027-05-02T00:02:00.000Z' }
    const reply: EscalationReply = { reply_id: 'rep_0', tenant_id: 't1', escalation_id: 'esc_1', wedding_id: 'wedding_42', seq: 0, sender: 'couple', body: 'Parking is in lot B.', sent_at: '2027-05-02T00:00:00.000Z' }
    const out = renderEscalations(SAFE_THEME, 'acme', [ESC_1], [resolution], [reply], 'csrf-xyz')
    expect(out).toContain('Handled')
    expect(out).toContain('Couple: “Parking is in lot B.”')
  })

  it('Phase 34: an XSS payload in a reply body is escaped (text-context render, no live markup)', () => {
    const evil: EscalationReply = { reply_id: 'rep_x', tenant_id: 't1', escalation_id: 'esc_1', wedding_id: 'wedding_42', seq: 0, sender: 'couple', body: '<script>alert("xss")</script>', sent_at: '2027-05-02T00:00:00.000Z' }
    const out = renderEscalations(SAFE_THEME, 'acme', [ESC_1], [], [evil], 'csrf-xyz')
    assertNoLiveMarkup(out, 'reply/body')
    expect(out).toContain('&lt;script&gt;')
  })

  it('renderEscalations renders an empty-state when there are no questions', () => {
    const out = renderEscalations(SAFE_THEME, 'acme', [], [], [], 'csrf-xyz')
    expect(out).toContain('No open questions')
  })

  it('renderEscalations escapes an UNTRUSTED guest question (no live markup, inert escaped text)', () => {
    const out = renderEscalations(
      SAFE_THEME,
      'acme',
      [{ escalation_id: 'esc_1', tenant_id: 't1', wedding_id: 'w1', from_ref: '"><img src=x onerror=alert(1)>', text: '<script>alert("xss")</script>', received_at: '2027-05-01T00:00:00.000Z', provider_message_ref: 'pm_1', channel: 'sms' }],
      [],
      [],
      'csrf-xyz',
    )
    assertNoLiveMarkup(out, 'escalation/text+from_ref')
    expect(out).toContain('&lt;script&gt;')
  })

  it('countOpenEscalations counts only escalations with no resolution (folds both arrays)', () => {
    const esc2: GuestEscalation = { ...ESC_1, escalation_id: 'esc_2', provider_message_ref: 'pm_2' }
    const resolution: EscalationResolution = { resolution_id: 'res_1', tenant_id: 't1', escalation_id: 'esc_1', wedding_id: 'wedding_42', seq: 0, status: 'resolved', resolved_by: 'planner', resolved_at: '2027-05-02T00:00:00.000Z' }
    expect(countOpenEscalations([ESC_1, esc2], [])).toBe(2)
    expect(countOpenEscalations([ESC_1, esc2], [resolution])).toBe(1) // esc_1 handled → only esc_2 open
    expect(countOpenEscalations([], [])).toBe(0)
    // Phase 36: a reopened escalation (max-seq reopened) counts as OPEN again — the fold uses max-seq.
    const reopened: EscalationResolution = { ...resolution, resolution_id: 'res_2', seq: 1, status: 'reopened' }
    expect(countOpenEscalations([ESC_1, esc2], [resolution, reopened])).toBe(2) // esc_1 reopened → open again
  })

  it('renderLanding is tenant-independent (no theme)', () => {
    const out = renderLanding()
    expect(out).toContain('white-label')
    expect(out).not.toContain('Acme')
  })

  it('GENERIC_404 is a frozen 404 with security headers and no theme', () => {
    expect(GENERIC_404.status).toBe(404)
    expect(GENERIC_404.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(GENERIC_404.headers['content-security-policy']).toContain("script-src 'none'")
    expect(GENERIC_404.body).not.toContain('Acme')
    expect(Object.isFrozen(GENERIC_404)).toBe(true)
  })

  it('ERROR_500 is a constant with no internal detail', () => {
    expect(ERROR_500.status).toBe(500)
    expect(ERROR_500.body).not.toMatch(/PRODUCT\./)
    expect(ERROR_500.body).not.toContain('stack')
  })
})

describe('renderBilling (Phase 30)', () => {
  const SUMMARY: BillingSummary = {
    plan_tier: 'studio',
    monthly_price_cents: 9900,
    messages_sent: 3,
    messaging_spend_cents: 15,
    subscription_charges_cents: 9900,
    payments_cents: 9900,
    balance_cents: 15,
  }
  const ACTIVITY: BillingActivityEntry[] = [
    { kind: 'payment', amount_cents: 9900, occurred_at: '2027-03-02T00:00:00.000Z' },
    { kind: 'usage_charge', amount_cents: 15, occurred_at: '2027-03-01T00:00:00.000Z' },
    { kind: 'charge', amount_cents: 9900, occurred_at: '2027-03-01T00:00:00.000Z' },
  ]

  it('shows the plan, monthly price, usage, and owed balance in dollars', () => {
    const out = renderBilling(SAFE_THEME, 'acme', SUMMARY, ACTIVITY, 'csrf-tok')
    expect(out).toContain('studio')
    expect(out).toContain('$99.00 / month')
    expect(out).toContain('3 message(s) sent')
    expect(out).toContain('$0.15 in metered messaging')
    expect(out).toContain('$0.15 owed')
    // The reconciliation note makes the balance transparent (subscription + messaging − payments).
    expect(out).toContain('Subscription $99.00 + messaging $0.15 − payments $99.00')
  })

  it('escapes the themed brand even on the billing page (no live markup)', () => {
    const out = renderBilling(EVIL_THEME, 'acme', SUMMARY, ACTIVITY, 'csrf-tok')
    assertNoLiveMarkup(out, 'billing theme')
  })

  it('Phase 31: carries a CSRF-gated Pay form posting the owed amount when a balance is owed', () => {
    const out = renderBilling(SAFE_THEME, 'acme', SUMMARY, ACTIVITY, 'csrf-tok')
    expect(out).toContain('action="/t/acme/billing/pay"')
    expect(out).toContain('name="_csrf" value="csrf-tok"')
    expect(out).toContain('Pay $0.15 owed (simulated)')
    // The form carries NO amount field — the server settles the trusted balance.
    expect(out).not.toContain('name="amount')
  })

  it('Phase 31: shows a settled note and NO Pay form when nothing is owed', () => {
    const settled: BillingSummary = { ...SUMMARY, balance_cents: 0 }
    const out = renderBilling(SAFE_THEME, 'acme', settled, ACTIVITY, 'csrf-tok')
    expect(out).toContain('Settled — nothing owed.')
    expect(out).not.toContain('/billing/pay')
  })

  it('Phase 32: lists each activity line with its human label, amount, and time', () => {
    const out = renderBilling(SAFE_THEME, 'acme', SUMMARY, ACTIVITY, 'csrf-tok')
    expect(out).toContain('<h2>Activity</h2>')
    expect(out).toContain('Payment')
    expect(out).toContain('Subscription charge')
    expect(out).toContain('Messaging usage')
    expect(out).toContain('2027-03-02T00:00:00.000Z')
    // The newest-first order: Payment ($99.00) appears before the Subscription charge in the rendered list.
    expect(out.indexOf('Payment')).toBeLessThan(out.indexOf('Subscription charge'))
  })

  it('Phase 32: shows a "No activity yet." note for an empty list', () => {
    const out = renderBilling(SAFE_THEME, 'acme', SUMMARY, [], 'csrf-tok')
    expect(out).toContain('<h2>Activity</h2>')
    expect(out).toContain('No activity yet.')
  })

  it('Phase 32: escapes a hostile occurred_at and an unexpected kind (defense-in-depth, never throws)', () => {
    const hostile: BillingActivityEntry[] = [
      // A kind outside the known set falls back to the raw (escaped) kind; an injection-shaped time is escaped.
      { kind: '<script>x</script>' as BillingActivityEntry['kind'], amount_cents: 1, occurred_at: '<img src=x>' },
    ]
    const out = renderBilling(SAFE_THEME, 'acme', SUMMARY, hostile, 'csrf-tok')
    assertNoLiveMarkup(out, 'billing activity')
  })
})

describe('renderHome (Phase 33)', () => {
  const PLANNER_OVERVIEW = {
    weddingsCount: 2,
    openQuestionsCount: 3,
    guestsCount: 5,
    billing: { balanceCents: 1500, planTier: 'studio' },
  } as const

  it('shows the weddings/guests/open-questions counts with deep links into each view', () => {
    const out = renderHome(SAFE_THEME, 'acme', PLANNER_OVERVIEW, 'csrf-home')
    expect(out).toContain('2 wedding(s)')
    expect(out).toContain('5 registered guest(s)')
    expect(out).toContain('3 need attention')
    expect(out).toContain('/t/acme?view=escalations')
    expect(out).toContain('/t/acme?view=weddings')
    expect(out).toContain('/t/acme?view=guests')
    expect(out).toContain('/t/acme/strategy')
    // Carries the Sign-out form with the CSRF token (an authenticated page).
    expect(out).toContain('action="/t/acme/logout"')
    expect(out).toContain('name="_csrf" value="csrf-home"')
  })

  it('renders the planner-only billing card (owed balance + plan) when overview.billing is present', () => {
    const out = renderHome(SAFE_THEME, 'acme', PLANNER_OVERVIEW, 'csrf-home')
    expect(out).toContain('/t/acme?view=billing')
    expect(out).toContain('$15.00 owed')
    expect(out).toContain('studio')
  })

  it('OMITS the billing card entirely for a couple (overview.billing absent) — an affordance, not a masked value', () => {
    const coupleOverview: AccountOverview = { weddingsCount: 1, openQuestionsCount: 0, guestsCount: 4 }
    const out = renderHome(SAFE_THEME, 'acme', coupleOverview, 'csrf-home')
    expect(out).not.toContain('?view=billing')
    expect(out).not.toContain('owed')
    // Still a complete page with the other cards.
    expect(out).toContain('1 wedding(s)')
    expect(out).toContain('4 registered guest(s)')
  })

  it('shows an "All caught up" note (no highlight) when there are no open questions', () => {
    const calm: AccountOverview = { weddingsCount: 1, openQuestionsCount: 0, guestsCount: 0 }
    const out = renderHome(SAFE_THEME, 'acme', calm, 'csrf-home')
    expect(out).toContain('All caught up')
    expect(out).not.toContain('need attention')
  })

  it('the spoke pages link back to the home, and the home links to every spoke (hub-and-spoke nav)', () => {
    const csrf = 'csrf-nav'
    // The home is the hub: it links to all four spokes + strategy.
    const home = renderHome(SAFE_THEME, 'acme', PLANNER_OVERVIEW, csrf)
    for (const spoke of ['?view=escalations', '?view=weddings', '?view=guests', '?view=billing', '/t/acme/strategy']) {
      expect(home, `home → ${spoke}`).toContain(spoke)
    }
    // Each management spoke links back to the home (← Home → /t/acme).
    const zeroSummary: BillingSummary = { plan_tier: 'solo', monthly_price_cents: 2900, messages_sent: 0, messaging_spend_cents: 0, subscription_charges_cents: 0, payments_cents: 0, balance_cents: 0 }
    expect(renderGuests(SAFE_THEME, 'acme', [], [], csrf)).toContain('← Home')
    expect(renderEscalations(SAFE_THEME, 'acme', [], [], [], csrf)).toContain('← Home')
    expect(renderBilling(SAFE_THEME, 'acme', zeroSummary, [], csrf)).toContain('← Home')
    // The wedding list (a spoke) also offers a ← Home link in its nav strip.
    expect(renderConsole(SAFE_THEME, 'acme', [], csrf)).toContain('← Home')
  })

  it('escapes the themed brand AND a hostile plan tier on the home (no live markup, defense-in-depth)', () => {
    const evilOverview: AccountOverview = {
      weddingsCount: 1,
      openQuestionsCount: 1,
      guestsCount: 1,
      billing: { balanceCents: 100, planTier: '<script>alert(1)</script>' },
    }
    const out = renderHome(EVIL_THEME, 'acme', evilOverview, 'csrf-home')
    assertNoLiveMarkup(out, 'home/theme+plan_tier')
    expect(out).toContain('&lt;script&gt;')
  })
})
