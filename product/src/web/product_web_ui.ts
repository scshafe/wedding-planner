import type { Guest, Wedding } from '@wedding-planner/shared'

import type { CsrfGuard } from '../auth/csrf_guard'
import type { ApiRequest } from '../http/api_message'
import { splitPath } from '../http/path'
import type { ProductApi } from '../http/product_api'
import type { StrategyGuidance } from '../strategy/strategy_guidance'
import { normalizeSlugForRoute } from './html'
import {
  ERROR_500,
  GENERIC_404,
  renderConsole,
  renderDetail,
  renderForbidden,
  renderGuests,
  renderLanding,
  renderLogin,
  renderStrategy,
} from './pages'
import type { ThemeResolver } from './theme_resolver'
import { htmlResult, type HttpResult, jsonResultFrom, redirect } from './web_response'

/**
 * @canonical product_web_ui -- the server-rendered HTML front door over the Phase-13 JSON pipeline.
 *
 * Holds `{ api, themes, csrf }` — no resolver, sessionStore, or repository (exactly as the Phase-13
 * dispatch handlers don't). Its only DATA path is `api.handle()`; `themes` is theme-only and `csrf` (Phase
 * 21) is an anti-forgery check that reads NO tenant data — neither is a data path. So the UI inherits BOTH
 * boundaries structurally — it cannot read a tenant's data except through the pipeline that enforces them,
 * and it makes NO independent existence decision (existence + auth + theme are all derived from `api.handle()`
 * calls, by status):
 *
 *   200 -> themed data page (console / detail)   401 -> themed login (active tenant, not yet authed)
 *   403 -> themed forbidden                       404/else -> the constant GENERIC_404 (no theme)
 *
 * The inbound `:slug` is VALIDATED at the edge (normalizeSlugForRoute) before any HTML/header use; a
 * non-match takes the SAME masked GENERIC_404 as an unknown tenant (never a distinct 400 — an oracle).
 * The browser carries the opaque Bearer token in a `wp_session` cookie; the UI forwards it VERBATIM as
 * `Authorization: Bearer <token>` and lets the pipeline's cross-tenant bind veto decide (the cookie adds
 * no new token authority; it is never short-circuited on).
 *
 * The browser MUTATIONS (Phase 21) — `POST /t/:slug/logout`, `/t/:slug/guests/create`, and
 * `/t/:slug/guests/remove` — are the place a cookie becomes a credential (the handler reads `wp_session` and
 * mints an internal Bearer), so each is CSRF-protected: it verifies the per-session `_csrf` token before any
 * mutation, and a forged token returns the masked 403 with NO state change (a forged logout therefore does
 * NOT clear the cookie). The JSON API is Bearer-only and NOT CSRF-reachable, so it carries no token. Login is
 * the documented exemption — no session yet to bind a token to (SameSite=Strict covers it).
 *
 * Routing is an ordered, exact-segment table: the UI owns `/`, `/t/:slug` (2 segs; `?wedding=ID` detail and
 * `?view=guests` management), `/t/:slug/login`, `/t/:slug/logout`, and the 4-seg `/t/:slug/guests/create` +
 * `/t/:slug/guests/remove` form posts; EVERYTHING else delegates to `api.handle()` (wrapped as a JSON
 * HttpResult), so the keystone-protected JSON paths (`/healthz`, `/t/:slug/sessions`, `/t/:slug/weddings...`,
 * the 3-seg `/t/:slug/guests` JSON API) reach the unchanged handler. The web form routes use DISTINCT names
 * from the JSON routes (mirroring `/login` ↔ `/sessions`), so they never collide and the JSON API stays
 * programmatically reachable; queries are stripped from the path before routing.
 *
 * related: pages.ts (the render fns), product_api.ts (the delegated JSON pipeline), theme_resolver.ts,
 * csrf_guard.ts (the anti-forgery boundary).
 */

/** The cookie that carries the opaque session token. */
const SESSION_COOKIE = 'wp_session'

/** A server-minted token charset guard — never emit a cookie value that could break the header. */
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/

export interface ProductWebUiDeps {
  readonly api: ProductApi
  readonly themes: ThemeResolver
  /**
   * Phase 21: the browser-form anti-forgery guard. Narrowed to {@link CsrfGuard} (issue/verify only — NOT the
   * SessionStore), so the UI can check a token but can neither mint nor resolve a principal. Reads no tenant
   * data, so the "only data path is api.handle()" invariant holds.
   */
  readonly csrf: CsrfGuard
}

export class ProductWebUi {
  readonly #api: ProductApi
  readonly #themes: ThemeResolver
  readonly #csrf: CsrfGuard

  constructor(deps: ProductWebUiDeps) {
    this.#api = deps.api
    this.#themes = deps.themes
    this.#csrf = deps.csrf
  }

  /** Run a request through the HTML front door. Never throws — any slip becomes the constant 500. */
  handle(req: ApiRequest): HttpResult {
    try {
      return this.#route(req)
    } catch {
      return ERROR_500
    }
  }

  #route(req: ApiRequest): HttpResult {
    const segments = splitPath(req.path)

    // GET / -> the generic, tenant-independent landing.
    if (segments.length === 0) {
      if (req.method === 'GET') return htmlResult(200, renderLanding())
      return this.#delegate(req)
    }

    if (segments[0] === 't' && segments.length >= 2) {
      // The slug is validated to the schema shape BEFORE any HTML/header use; a miss is masked as 404.
      const slug = normalizeSlugForRoute(segments[1] ?? '')

      // /t/:slug (exactly two segments) -> the console (list, or detail via ?wedding=ID).
      if (segments.length === 2 && req.method === 'GET') {
        return slug === undefined ? GENERIC_404 : this.#console(req, slug)
      }

      // /t/:slug/login, /t/:slug/logout, and the read-only /t/:slug/strategy (GET) are the UI routes.
      if (segments.length === 3) {
        if (segments[2] === 'login') return slug === undefined ? GENERIC_404 : this.#login(req, slug)
        if (segments[2] === 'logout') return slug === undefined ? GENERIC_404 : this.#logout(req, slug)
        // GET only — a non-GET /t/:slug/strategy falls through to the JSON pipeline (401/405).
        if (segments[2] === 'strategy' && req.method === 'GET') {
          return slug === undefined ? GENERIC_404 : this.#strategy(req, slug)
        }
      }

      // /t/:slug/guests/{create,remove} (Phase 21) — the browser FORM posts (CSRF-protected). DISTINCT names
      // from the JSON /t/:slug/guests route (3-seg) so they never collide. A malformed slug masks to 404
      // BEFORE any cookie read / CSRF verdict (the CSRF outcome is never a tenant-existence oracle).
      if (segments.length === 4 && segments[2] === 'guests' && req.method === 'POST') {
        if (slug === undefined) return GENERIC_404
        if (segments[3] === 'create') return this.#guestCreate(req, slug)
        if (segments[3] === 'remove') return this.#guestRemove(req, slug)
      }
    }

    // Everything else is the JSON API (keystone-protected) — reached unchanged via the pipeline.
    return this.#delegate(req)
  }

  /** GET /t/:slug — list (or `?wedding=ID` detail / `?view=guests` management), themed strictly by status. */
  #console(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)

    // ?view=guests — the planner-only guest-management page (Phase 21).
    if (queryParam(req.path, 'view') === 'guests') return this.#guestsPage(req, slug)

    const weddingId = queryParam(req.path, 'wedding')

    if (weddingId !== undefined) {
      // Detail: route the id ONLY into the pipeline (encoded so it stays one segment); never reflect it.
      const apiRes = this.#api.handle(bearerGet(`/t/${slug}/weddings/${encodeURIComponent(weddingId)}`, token))
      if (apiRes.status === 200) {
        const theme = this.#themes.resolveActiveTheme(slug)
        const wedding = readWedding(apiRes.body)
        if (theme === undefined || wedding === undefined) return GENERIC_404
        return htmlResult(200, renderDetail(theme, slug, wedding))
      }
      return this.#renderNonData(slug, apiRes.status)
    }

    const apiRes = this.#api.handle(bearerGet(`/t/${slug}/weddings`, token))
    if (apiRes.status === 200) {
      const theme = this.#themes.resolveActiveTheme(slug)
      const weddings = readWeddings(apiRes.body)
      const csrf = this.#csrf.issueCsrf(token)
      // A 200 means the session resolved; its CSRF token must exist (same store). Absent ⇒ invariant break.
      if (theme === undefined || csrf === undefined) return theme === undefined ? GENERIC_404 : ERROR_500
      return htmlResult(200, renderConsole(theme, slug, weddings, csrf))
    }
    return this.#renderNonData(slug, apiRes.status)
  }

  /**
   * GET /t/:slug?view=guests — the planner-only guest-management page (Phase 21). TWO `api.handle()` reads:
   * GUESTS FIRST (planner-only — a couple gets 403 here and never sees the wedding list), then weddings (for
   * the picker). Rendered only on 200/200; if EITHER read is non-200 it takes the SAME `#renderNonData`
   * masking as every other page (no half-page, no distinguishable split). `invalid` re-renders with a generic
   * notice after a failed create (the PRG re-render).
   */
  #guestsPage(req: ApiRequest, slug: string, invalid = false): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const guestsRes = this.#api.handle(bearerGet(`/t/${slug}/guests`, token))
    if (guestsRes.status !== 200) return this.#renderNonData(slug, guestsRes.status)
    const weddingsRes = this.#api.handle(bearerGet(`/t/${slug}/weddings`, token))
    if (weddingsRes.status !== 200) return this.#renderNonData(slug, weddingsRes.status)
    const theme = this.#themes.resolveActiveTheme(slug)
    const csrf = this.#csrf.issueCsrf(token)
    if (theme === undefined || csrf === undefined) return theme === undefined ? GENERIC_404 : ERROR_500
    return htmlResult(
      invalid ? 400 : 200,
      renderGuests(theme, slug, readGuests(guestsRes.body), readWeddings(weddingsRes.body), csrf, invalid),
    )
  }

  /**
   * POST /t/:slug/guests/create — the browser add-guest form. Verify the CSRF token (forged ⇒ masked 403, no
   * mutation) BEFORE translating the cookie to a Bearer and forwarding to the JSON `POST /t/:slug/guests`.
   * 201 ⇒ PRG redirect to the guests page; any failure ⇒ re-render the guests page with a generic notice
   * (which itself masks to 404 if the tenant is unknown — so create-vs-conflict-vs-missing never leaks).
   */
  #guestCreate(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    const body = {
      recipient_ref: form.get('recipient_ref') ?? '',
      wedding_id: form.get('wedding_id') ?? '',
      guest_id: form.get('guest_id') ?? '',
    }
    const apiRes = this.#api.handle(bearerJson('POST', `/t/${slug}/guests`, token, body))
    if (apiRes.status === 201) return redirect(303, `/t/${slug}?view=guests`)
    return this.#guestsPage(req, slug, true)
  }

  /**
   * POST /t/:slug/guests/remove — the browser remove form. Verify CSRF (forged ⇒ masked 403, no mutation),
   * then forward to the JSON `DELETE /t/:slug/guests` (idempotent) and PRG-redirect to the guests page (which
   * masks unknown-tenant/non-owner outcomes on the follow-up GET).
   */
  #guestRemove(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    this.#api.handle(bearerJson('DELETE', `/t/${slug}/guests`, token, { recipient_ref: form.get('recipient_ref') ?? '' }))
    return redirect(303, `/t/${slug}?view=guests`)
  }

  /**
   * GET /t/:slug/strategy — the themed planning-strategy page (Phase 17). Mirrors `#console` exactly: ONE
   * `api.handle()` and themed strictly by the returned status, so the page makes no independent existence
   * decision (200 → page; 401 → themed login; else the constant masked 404).
   */
  #strategy(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
    const apiRes = this.#api.handle(bearerGet(`/t/${slug}/strategy`, token))
    if (apiRes.status === 200) {
      const theme = this.#themes.resolveActiveTheme(slug)
      const guidance = readStrategy(apiRes.body)
      if (theme === undefined || guidance === undefined) return GENERIC_404
      return htmlResult(200, renderStrategy(theme, slug, guidance))
    }
    return this.#renderNonData(slug, apiRes.status)
  }

  /** Map a non-200 API status to a page. 401 -> themed login (active); 403 -> forbidden; else masked 404. */
  #renderNonData(slug: string, status: number): HttpResult {
    if (status === 401) {
      const theme = this.#themes.resolveActiveTheme(slug)
      return theme === undefined ? GENERIC_404 : htmlResult(200, renderLogin(theme, slug))
    }
    if (status === 403) {
      const theme = this.#themes.resolveActiveTheme(slug)
      return theme === undefined ? GENERIC_404 : htmlResult(403, renderForbidden(theme, slug))
    }
    return GENERIC_404
  }

  /** GET shows the themed login form; POST runs the simulated login and sets the session cookie. */
  #login(req: ApiRequest, slug: string): HttpResult {
    if (req.method === 'GET') {
      const theme = this.#themes.resolveActiveTheme(slug)
      return theme === undefined ? GENERIC_404 : htmlResult(200, renderLogin(theme, slug))
    }
    if (req.method !== 'POST') return this.#delegate(req)

    const form = parseForm(req.rawBody)
    const role = form.get('role') ?? ''
    const weddingId = form.get('wedding_id') ?? ''
    const loginBody: Record<string, string> = { role }
    if (weddingId.length > 0) loginBody.wedding_id = weddingId

    const apiRes = this.#api.handle({
      method: 'POST',
      path: `/t/${slug}/sessions`,
      headers: { 'content-type': 'application/json' },
      rawBody: JSON.stringify(loginBody),
    })

    if (apiRes.status === 201) {
      const token = readToken(apiRes.body)
      if (token === undefined || !SAFE_TOKEN.test(token)) return ERROR_500
      // Location + Set-Cookie are built ONLY from the validated slug + the server-minted token.
      return redirect(303, `/t/${slug}`, {
        'set-cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/t/${slug}`,
      })
    }
    if (apiRes.status === 404) return GENERIC_404 // unknown / suspended / onboarding tenant — masked
    // 400 (bad role / missing couple wedding_id): re-render the themed login with a generic notice.
    const theme = this.#themes.resolveActiveTheme(slug)
    return theme === undefined ? GENERIC_404 : htmlResult(400, renderLogin(theme, slug, true))
  }

  /**
   * POST /t/:slug/logout — clear the session cookie and return to the tenant root. CSRF-protected (Phase 21):
   * a forged-token logout returns the masked 403 and does NOT clear the cookie (closing a forced-logout CSRF).
   */
  #logout(req: ApiRequest, slug: string): HttpResult {
    if (req.method !== 'POST') return this.#delegate(req)
    const token = readSessionCookie(req.headers.cookie)
    const form = parseForm(req.rawBody)
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return this.#renderNonData(slug, 403)
    return redirect(303, `/t/${slug}`, {
      'set-cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/t/${slug}; Max-Age=0`,
    })
  }

  /** Delegate to the JSON pipeline and wrap its response — the keystone-protected handler, unchanged. */
  #delegate(req: ApiRequest): HttpResult {
    return jsonResultFrom(this.#api.handle(req))
  }
}

// ---------------------------------- request helpers (pure) ----------------------------------

/** Build a `GET` ApiRequest carrying the session token as a Bearer header (omitted when absent). */
function bearerGet(path: string, token: string | undefined): ApiRequest {
  return {
    method: 'GET',
    path,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  }
}

/**
 * Build a mutating ApiRequest (POST/DELETE) translating the cookie session token into a Bearer + a JSON body
 * (Phase 21). This is the SOLE cookie→Bearer translation for a mutation — it runs only AFTER the CSRF token
 * verified, so a forged cross-site form never reaches it.
 */
function bearerJson(method: string, path: string, token: string | undefined, body: unknown): ApiRequest {
  const headers: Record<string, string | undefined> = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  return { method, path, headers, rawBody: JSON.stringify(body) }
}

/** Read the `wp_session` token from a Cookie header, or undefined. */
function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = pair.slice(eq + 1).trim()
      return value.length === 0 ? undefined : value
    }
  }
  return undefined
}

/** Extract a single query parameter value from a path, or undefined. */
function queryParam(path: string, name: string): string | undefined {
  const q = path.indexOf('?')
  if (q === -1) return undefined
  const value = new URLSearchParams(path.slice(q + 1)).get(name)
  return value === null ? undefined : value
}

/** Parse a urlencoded form body into a params map (empty when absent). */
function parseForm(rawBody: string | undefined): URLSearchParams {
  return new URLSearchParams(rawBody ?? '')
}

/** Read the opaque token from a login (201) JSON body. */
function readToken(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const token = (body as { token?: unknown }).token
  return typeof token === 'string' ? token : undefined
}

/** Read the weddings array from a list (200) JSON body (tolerant — never throws on an odd shape). */
function readWeddings(body: unknown): readonly Wedding[] {
  if (typeof body !== 'object' || body === null) return []
  const weddings = (body as { weddings?: unknown }).weddings
  return Array.isArray(weddings) ? (weddings as Wedding[]) : []
}

/** Read the guests array from a list (200) JSON body (tolerant — never throws on an odd shape). */
function readGuests(body: unknown): readonly Guest[] {
  if (typeof body !== 'object' || body === null) return []
  const guests = (body as { guests?: unknown }).guests
  return Array.isArray(guests) ? (guests as Guest[]) : []
}

/** Read the single wedding from a detail (200) JSON body, or undefined. */
function readWedding(body: unknown): Wedding | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const wedding = (body as { wedding?: unknown }).wedding
  return typeof wedding === 'object' && wedding !== null ? (wedding as Wedding) : undefined
}

/** Read the strategy guidance from a strategy (200) JSON body, or undefined (tolerant — never throws). */
function readStrategy(body: unknown): StrategyGuidance | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const strategy = (body as { strategy?: unknown }).strategy
  return typeof strategy === 'object' && strategy !== null ? (strategy as StrategyGuidance) : undefined
}
