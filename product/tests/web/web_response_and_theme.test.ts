import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { TenantStore } from '../../src/tenant/tenant_store'
import { ThemeResolver } from '../../src/web/theme_resolver'
import { htmlResult, jsonResultFrom, redirect } from '../../src/web/web_response'

/**
 * Step-2 coverage: the response helpers stamp the security headers on every HTML result, and the theme
 * resolver gates branding on the SAME usability predicate as the context resolver (so theme-presence is
 * never an absent-vs-suspended oracle).
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Acme Weddings',
  primary_color_hex: '#a1b2c3',
  accent_color_hex: '#445566',
  logo_ref: 'asset_logo_1',
}

describe('web_response helpers', () => {
  it('htmlResult stamps content-type, nosniff, and a script-less CSP', () => {
    const res = htmlResult(200, '<!doctype html><p>hi</p>')
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toContain("script-src 'none'")
    expect(res.body).toContain('<p>hi</p>')
  })

  it('redirect carries the location verbatim and an empty body', () => {
    const res = redirect(303, '/t/acme', { 'set-cookie': 'wp_session=tok; HttpOnly' })
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe('/t/acme')
    expect(res.headers['set-cookie']).toContain('HttpOnly')
    expect(res.body).toBe('')
  })

  it('jsonResultFrom serializes an ApiResponse body once with a json content-type', () => {
    const res = jsonResultFrom({ status: 404, body: { error: 'not_found' } })
    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toBe('application/json')
    expect(res.body).toBe('{"error":"not_found"}')
  })
})

describe('ThemeResolver.resolveActiveTheme', () => {
  function makeStore(lifecycle: Tenant['lifecycle_status']): TenantStore {
    const store = new TenantStore(new ManualClock('2027-01-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
    store.create({ slug: 'acme', display_name: 'Acme', theme: THEME, plan_tier: 'solo', lifecycle_status: lifecycle })
    return store
  }

  it('returns the theme for an active tenant', () => {
    const themes = new ThemeResolver(makeStore('active'))
    expect(themes.resolveActiveTheme('acme')).toEqual(THEME)
  })

  it('returns undefined for an unknown slug', () => {
    const themes = new ThemeResolver(makeStore('active'))
    expect(themes.resolveActiveTheme('nope')).toBeUndefined()
  })

  it('returns undefined for suspended and onboarding (no absent-vs-suspended oracle)', () => {
    expect(new ThemeResolver(makeStore('suspended')).resolveActiveTheme('acme')).toBeUndefined()
    expect(new ThemeResolver(makeStore('onboarding')).resolveActiveTheme('acme')).toBeUndefined()
  })
})
