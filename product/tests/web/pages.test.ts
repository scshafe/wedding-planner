import type { EscalationResolution, GuestEscalation, Tenant, Wedding } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { NEUTRAL_COLOR } from '../../src/web/html'
import {
  ERROR_500,
  GENERIC_404,
  renderConsole,
  renderDetail,
  renderEscalations,
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
  const ESC_1: GuestEscalation = { escalation_id: 'esc_1', tenant_id: 't1', wedding_id: 'wedding_42', from_ref: 'sms:+1555', text: 'where do I park?', received_at: '2027-05-01T00:00:00.000Z', provider_message_ref: 'pm_1' }

  it('renderEscalations lists an OPEN question with Resolve/Dismiss CSRF forms + a link to the wedding edit page', () => {
    const out = renderEscalations(SAFE_THEME, 'acme', [ESC_1], [], 'csrf-xyz')
    expect(out).toContain('where do I park?')
    expect(out).toContain('sms:+1555')
    expect(out).toContain('/t/acme?wedding=wedding_42')
    // The two action forms post escalation_id + status + the CSRF token to the resolve route.
    expect(out).toContain('action="/t/acme/escalations/resolve"')
    expect(out).toContain('name="escalation_id" value="esc_1"')
    expect(out).toContain('name="status" value="resolved"')
    expect(out).toContain('name="status" value="dismissed"')
    expect(out).toContain('value="csrf-xyz"')
  })

  it('renderEscalations moves a HANDLED question into a Handled section (status badge, no action form)', () => {
    const resolution: EscalationResolution = { resolution_id: 'res_1', tenant_id: 't1', escalation_id: 'esc_1', wedding_id: 'wedding_42', status: 'dismissed', resolved_by: 'planner', resolved_at: '2027-05-02T00:00:00.000Z' }
    const out = renderEscalations(SAFE_THEME, 'acme', [ESC_1], [resolution], 'csrf-xyz')
    expect(out).toContain('Handled')
    expect(out).toContain('Dismissed by planner')
    // A handled row carries NO Resolve/Dismiss form (the only form action on the page is gone when nothing is open).
    expect(out).not.toContain('action="/t/acme/escalations/resolve"')
    expect(out).toContain('No open questions')
  })

  it('renderEscalations renders an empty-state when there are no questions', () => {
    const out = renderEscalations(SAFE_THEME, 'acme', [], [], 'csrf-xyz')
    expect(out).toContain('No open questions')
  })

  it('renderEscalations escapes an UNTRUSTED guest question (no live markup, inert escaped text)', () => {
    const out = renderEscalations(
      SAFE_THEME,
      'acme',
      [{ escalation_id: 'esc_1', tenant_id: 't1', wedding_id: 'w1', from_ref: '"><img src=x onerror=alert(1)>', text: '<script>alert("xss")</script>', received_at: '2027-05-01T00:00:00.000Z', provider_message_ref: 'pm_1' }],
      [],
      'csrf-xyz',
    )
    assertNoLiveMarkup(out, 'escalation/text+from_ref')
    expect(out).toContain('&lt;script&gt;')
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
