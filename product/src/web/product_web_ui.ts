import type { Wedding } from '@wedding-planner/shared'

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
  renderLanding,
  renderLogin,
  renderStrategy,
} from './pages'
import type { ThemeResolver } from './theme_resolver'
import { htmlResult, type HttpResult, jsonResultFrom, redirect } from './web_response'

/**
 * @canonical product_web_ui -- the server-rendered HTML front door over the Phase-13 JSON pipeline.
 *
 * Holds ONLY `{ api, themes }` — no resolver, sessionStore, or repository (exactly as the Phase-13
 * dispatch handlers don't). Its ONLY data path is `api.handle()`; the only extra capability is the
 * theme-only `ThemeResolver`. So the UI inherits BOTH boundaries structurally — it cannot read a
 * tenant's data except through the pipeline that enforces them, and it makes NO independent existence
 * decision (existence + auth + theme are all derived from ONE `api.handle()` call per page, by status):
 *
 *   200 -> themed data page (console / detail)   401 -> themed login (active tenant, not yet authed)
 *   403 -> themed forbidden                       404/else -> the constant GENERIC_404 (no theme)
 *
 * The inbound `:slug` is VALIDATED at the edge (normalizeSlugForRoute) before any HTML/header use; a
 * non-match takes the SAME masked GENERIC_404 as an unknown tenant (never a distinct 400 — an oracle).
 * The browser carries the opaque Bearer token in a `wp_session` cookie; the UI forwards it VERBATIM as
 * `Authorization: Bearer <token>` and lets the pipeline's cross-tenant bind veto decide (the cookie adds
 * no new token authority; it is never short-circuited on). Login/logout are the only state-changing HTML
 * routes; HTML create/update forms are deferred.
 *
 * Routing is an ordered, exact-segment table: the UI owns `/`, `/t/:slug` (2 segs), `/t/:slug/login`,
 * `/t/:slug/logout`; EVERYTHING else delegates to `api.handle()` (wrapped as a JSON HttpResult), so the
 * keystone-protected JSON paths (`/healthz`, `/t/:slug/sessions`, `/t/:slug/weddings...`) reach the
 * unchanged handler. `/t/:slug?wedding=ID` is the detail page — the query is stripped from the path, so
 * it never collides with the JSON `/t/:slug/weddings/:id`.
 *
 * related: pages.ts (the render fns), product_api.ts (the delegated JSON pipeline), theme_resolver.ts.
 */

/** The cookie that carries the opaque session token. */
const SESSION_COOKIE = 'wp_session'

/** A server-minted token charset guard — never emit a cookie value that could break the header. */
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/

export interface ProductWebUiDeps {
  readonly api: ProductApi
  readonly themes: ThemeResolver
}

export class ProductWebUi {
  readonly #api: ProductApi
  readonly #themes: ThemeResolver

  constructor(deps: ProductWebUiDeps) {
    this.#api = deps.api
    this.#themes = deps.themes
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
    }

    // Everything else is the JSON API (keystone-protected) — reached unchanged via the pipeline.
    return this.#delegate(req)
  }

  /** GET /t/:slug — list (or `?wedding=ID` detail), themed strictly by the status `api.handle()` returns. */
  #console(req: ApiRequest, slug: string): HttpResult {
    const token = readSessionCookie(req.headers.cookie)
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
      if (theme === undefined) return GENERIC_404
      return htmlResult(200, renderConsole(theme, slug, weddings))
    }
    return this.#renderNonData(slug, apiRes.status)
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

  /** POST /t/:slug/logout — clear the session cookie and return to the tenant root. */
  #logout(req: ApiRequest, slug: string): HttpResult {
    if (req.method !== 'POST') return this.#delegate(req)
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
