import { describe, expect, it } from 'vitest'

import {
  escapeHtml,
  html,
  isValidSlug,
  NEUTRAL_COLOR,
  normalizeSlugForRoute,
  render,
  safeColor,
  SafeHtml,
} from '../../src/web/html'

/**
 * Step-1 coverage: the injection-safe HTML primitives. These are the whole ballgame for the web edge —
 * every tenant/user string reaches HTML only through here. The corpus pins that no payload survives in
 * any of the four contexts (HTML text, quoted attribute, CSS color, slug-in-header).
 */

describe('escapeHtml', () => {
  it('escapes all five HTML/attribute metacharacters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  it('neutralizes a script tag and an attribute breakout', () => {
    expect(escapeHtml('</style><script>alert(1)</script>')).not.toContain('<script>')
    expect(escapeHtml('" onmouseover="alert(1)')).not.toContain('"')
  })
})

describe('html tagged template', () => {
  it('escapes every interpolation but keeps the trusted static parts', () => {
    const out = render(html`<h1>${'<img onerror=x>'}</h1>`)
    expect(out).toBe('<h1>&lt;img onerror=x&gt;</h1>')
  })

  it('escapes a value placed inside a quoted attribute', () => {
    const evil = 'a" onload="alert(1)'
    const out = render(html`<div title="${evil}"></div>`)
    expect(out).not.toContain('onload="')
    expect(out).toContain('&quot;')
  })

  it('composes nested SafeHtml fragments without double-escaping', () => {
    const row = html`<li>${'Alex & Sam'}</li>`
    const out = render(html`<ul>${[row, row]}</ul>`)
    expect(out).toBe('<ul><li>Alex &amp; Sam</li><li>Alex &amp; Sam</li></ul>')
  })

  it('escapes a non-SafeHtml string even if it looks like markup', () => {
    const out = render(html`${'<b>x</b>'}`)
    expect(out).toBe('&lt;b&gt;x&lt;/b&gt;')
  })

  it('only SafeHtml is emitted raw — there is no public raw-string constructor for it', () => {
    // SafeHtml exists as a type/brand, but the only mint is `html`. A fragment built by `html` is the
    // only thing emitted unescaped; arbitrary strings always route through escapeHtml.
    const frag = html`<span>ok</span>`
    expect(frag).toBeInstanceOf(SafeHtml)
    expect(render(html`${frag}`)).toBe('<span>ok</span>')
  })
})

describe('safeColor (CSS context)', () => {
  it('passes a valid lowercase 6-digit hex through unchanged', () => {
    expect(safeColor('#a1b2c3')).toBe('#a1b2c3')
  })

  it('case-folds an uppercase hex to the lowercase canonical form', () => {
    expect(safeColor('#FFAA00')).toBe('#ffaa00')
  })

  it('falls back to the neutral constant on any CSS-injection payload', () => {
    for (const evil of [
      'red;background:url(//evil/x)',
      '#fff;}</style><script>alert(1)</script>',
      'expression(alert(1))',
      '#fff',
      '#1234567',
      'rgb(0,0,0)',
      '',
    ]) {
      const out = safeColor(evil)
      expect(out).toBe(NEUTRAL_COLOR)
      expect(out).not.toMatch(/[;}<>()]/)
    }
  })
})

describe('slug validation (header/route context)', () => {
  it('accepts a normalized schema-shaped slug', () => {
    expect(isValidSlug('acme-weddings')).toBe(true)
    expect(normalizeSlugForRoute('Acme-Weddings')).toBe('acme-weddings')
  })

  it('rejects CRLF, path-traversal, and markup payloads (returns undefined — caller masks as 404)', () => {
    for (const evil of [
      'a%0d%0aSet-Cookie:x',
      'a\r\nLocation: //evil',
      '..%2f..%2fevil.com',
      '../etc',
      '<script>',
      'a; Domain=evil',
      '-leadinghyphen',
      'trailinghyphen-',
      'has space',
      '',
    ]) {
      expect(isValidSlug(evil.toLowerCase())).toBe(false)
      expect(normalizeSlugForRoute(evil)).toBeUndefined()
    }
  })
})
