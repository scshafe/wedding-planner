/**
 * @canonical web_html -- the injection-safe HTML primitives. The whole ballgame for the web edge.
 *
 * The web UI renders tenant- and user-controlled strings (brand_name, logo_ref, couple_display_name,
 * slug, wedding ids) into HTML. A single text-escaper is NOT sufficient: HTML text, CSS color, URL, and
 * the slug-in-a-header are four distinct injection contexts (doddy P0-1/P0-2/P0-3). This module is the
 * SOLE way to build HTML and the sole place each context's encoder lives:
 *
 *   - {@link html} — a tagged template whose EVERY `${}` interpolation is HTML-escaped by construction.
 *     The static template parts are developer source (trusted); only interpolations are escaped. There
 *     is NO raw-string bypass: the only value inserted unescaped is a {@link SafeHtml}, and the ONLY way
 *     to mint a SafeHtml is `html` itself (it is module-private — pages compose fragments, never wrap a
 *     raw user string). So a user string can never reach the output unescaped.
 *   - {@link safeColor} — CSS context. Re-validates `#rrggbb` AT RENDER TIME (never trusts the stored
 *     value) and falls back to a neutral constant. Injected only as a custom-property value in a quoted
 *     `style` attribute — never into `<style>` text — so no CSS metacharacter can break out.
 *   - {@link isValidSlug} / {@link normalizeSlugForRoute} — the inbound `:slug` is attacker-controlled
 *     (the resolver only lowercases it). Validate against the schema pattern at the web edge BEFORE any
 *     use in HTML, a redirect `Location`, or a `Set-Cookie` `Path`, so no CRLF/attribute injection is
 *     possible. logo_ref (a free string) is rendered as escaped TEXT only — never into a `src`/`href`.
 *
 * related: pages.ts (composes fragments), product_web_ui.ts (validates slug, builds headers).
 */

/**
 * A fragment of already-escaped, safe-to-emit HTML. The brand is a private field, so a SafeHtml can be
 * produced ONLY by {@link html} below (no public constructor, no `unsafeHtml(str)`). This is what makes
 * "no raw bypass" structural: composing pages can only pass SafeHtml fragments they built via `html`.
 */
export class SafeHtml {
  /** @internal The escaped HTML string. Constructed only by `html`. */
  readonly #value: string
  constructor(value: string) {
    this.#value = value
  }
  /** The raw escaped HTML. Used only by `html` (nesting) and `render` (final output). */
  toString(): string {
    return this.#value
  }
}

/** HTML-escape a string for text AND quoted-attribute contexts (all five metacharacters). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render one interpolated value to a safe HTML string. A {@link SafeHtml} is emitted as-is (it was built
 * by `html`, already escaped); an array is each-element-rendered and concatenated; anything else is
 * coerced to a string and HTML-escaped. There is deliberately no path that emits an arbitrary string raw.
 */
function renderValue(value: unknown): string {
  if (value instanceof SafeHtml) return value.toString()
  if (Array.isArray(value)) return value.map(renderValue).join('')
  return escapeHtml(String(value))
}

/**
 * The tagged template for building HTML. Static parts are trusted developer source; every `${}` is
 * escaped (or, if a SafeHtml/array of SafeHtml, composed). Returns a SafeHtml so fragments nest.
 *
 *   html`<h1>${brandName}</h1>${rows}`   // brandName escaped; rows = SafeHtml[] composed
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? ''
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + (strings[i + 1] ?? '')
  }
  return new SafeHtml(out)
}

/** Produce the final HTML string for a response body from a built {@link SafeHtml} document. */
export function render(document: SafeHtml): string {
  return document.toString()
}

/** The neutral fallback color for any value that is not a valid lowercase 6-digit hex (constant — never tenant-distinguishing). */
export const NEUTRAL_COLOR = '#444444'

const HEX_COLOR = /^#[0-9a-f]{6}$/

/**
 * CSS-context sanitizer for a brand color. Re-validates `#rrggbb` (case-folded) at render time —
 * independent of the create-time schema — and returns the neutral constant on any miss, so a malformed
 * or attacker-controlled color can never carry a CSS metacharacter (`;`, `}`, `url(`, `</style>`) into
 * the output. The result is always exactly `#` + six lowercase hex digits.
 */
export function safeColor(value: string): string {
  const lowered = value.toLowerCase()
  return HEX_COLOR.test(lowered) ? lowered : NEUTRAL_COLOR
}

/** The tenant slug schema pattern (mirrors product/schemas/tenant_schema.json `slug.pattern`). */
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** Whether a (already-normalized) slug matches the schema's safe shape. */
export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug)
}

/**
 * Normalize an inbound `:slug` route segment to its canonical form (lowercase, as the store does) and
 * validate it against the schema pattern. Returns the safe slug, or `undefined` if it does not match —
 * the caller maps a non-match to the SAME masked generic 404 as an unknown tenant (never a distinct
 * 400 — that would be an oracle). Only a returned (validated) slug is ever placed in HTML or a header.
 */
export function normalizeSlugForRoute(raw: string): string | undefined {
  const normalized = raw.toLowerCase()
  return isValidSlug(normalized) ? normalized : undefined
}
