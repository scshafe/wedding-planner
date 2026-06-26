import type { Tenant, Wedding } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { NEUTRAL_COLOR } from '../../src/web/html'
import {
  ERROR_500,
  GENERIC_404,
  renderConsole,
  renderDetail,
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
    const out = renderConsole(SAFE_THEME, 'acme', [EVIL_WEDDING])
    expect(out).toContain('href="/t/acme?wedding=')
    assertNoLiveMarkup(out, 'console/wedding')
  })

  it('renders an empty-state when there are no weddings', () => {
    const out = renderConsole(SAFE_THEME, 'acme', [])
    expect(out).toContain('No weddings to show')
  })

  it('escapes the couple name and id on the detail page', () => {
    const out = renderDetail(SAFE_THEME, 'acme', EVIL_WEDDING)
    assertNoLiveMarkup(out, 'detail/wedding')
    expect(out).toContain('← All weddings')
  })
})

describe('generic constants', () => {
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
