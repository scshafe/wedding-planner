import type { CsrfGuard } from '../auth/csrf_guard'
import type { OutboxMessage } from '../email/simulated_email_adapter'
import type { ApiRequest } from '../http/api_message'
import type { ProductApi } from '../http/product_api'
import type { Tenant } from '@wedding-planner/shared'

import type { FeedbackSubmission } from '../feedback/feedback_service'
import type { ServerError } from '../operability/error_log'
import {
  renderErrors,
  renderFeedbackList,
  renderOperatorLogin,
  renderOutbox,
  renderTenants,
  type TenantsNotice,
} from './admin_pages'
import { readCookie } from './cookies'
import { ERROR_500 } from './pages'
import { htmlResult, type HttpResult, redirect } from './web_response'

/**
 * @canonical operator_console -- the browser front door of the operator tier (issue #9, ADR 0040).
 *
 * The `/admin` JSON API authenticates a Bearer token. A browser cannot send one, and the operator credential must
 * not live in a cookie, so the console signs in by EXCHANGING the credential for an operator session:
 *
 *   GET  /admin, /admin/login   the sign-in form (or straight to the outbox when already signed in)
 *   POST /admin/login           api `POST /admin/sessions` with the typed credential as Bearer → 201 sets the
 *                               `wp_operator` cookie (HttpOnly, SameSite=Strict, Path=/admin, 12h) and redirects
 *   POST /admin/logout          CSRF-checked; api `DELETE /admin/sessions` revokes it server-side; clears the cookie
 *   GET  /admin/outbox          the outbox page (a request WITH an Authorization header is a script: it gets the
 *                               JSON API instead, so `/admin/outbox` serves both)
 *   POST /admin/outbox/send     CSRF-checked test send, then PRG back to the outbox
 *   GET  /admin/tenants         every tenant (issue #10); JSON for a Bearer request, the page for a browser
 *   POST /admin/tenants/owner   CSRF-checked owner setup (api `POST /admin/tenants/:id/owner`), then PRG back
 *   GET  /admin/feedback        in-app feedback, newest first (issue #12); JSON for a Bearer request
 *   GET  /admin/errors          server errors, newest first (issue #13); JSON for a Bearer request
 *
 * Like the tenant UI, its ONLY data path is `api.handle()`: the cookie is forwarded verbatim as the Bearer and the
 * pipeline's operator gate decides. `csrf` is the operator store narrowed to {@link CsrfGuard} (issue/verify
 * against the console session — it reads no data). Sign-in is the documented CSRF exemption (no session yet;
 * SameSite=Strict, and forging it would need the credential anyway). Any request the console does not own falls
 * through (`undefined`) to the JSON API, so every other `/admin` path keeps its byte-identical 401.
 *
 * related: admin_pages.ts (the pages), operator_credential.ts (the sessions), product_api.ts (/admin routes).
 */

/** The cookie that carries the operator console session. Scoped to /admin. */
const OPERATOR_COOKIE = 'wp_operator'

/** A server-minted token charset guard — never emit a cookie value that could break the header. */
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/

export interface OperatorConsoleDeps {
  readonly api: ProductApi
  readonly csrf: CsrfGuard
}

export class OperatorConsole {
  readonly #api: ProductApi
  readonly #csrf: CsrfGuard

  constructor(deps: OperatorConsoleDeps) {
    this.#api = deps.api
    this.#csrf = deps.csrf
  }

  /** Handle a console request, or `undefined` when the request is not the console's (the JSON API takes it). */
  handle(req: ApiRequest, segments: readonly string[]): HttpResult | undefined {
    if (segments[0] !== 'admin') return undefined
    const page = segments.slice(1).join('/')
    if ((page === '' || page === 'login') && req.method === 'GET') return this.#loginPage(req)
    if (page === 'login' && req.method === 'POST') return this.#login(req)
    if (page === 'logout' && req.method === 'POST') return this.#logout(req)
    if (page === 'outbox' && req.method === 'GET' && req.headers.authorization === undefined) return this.#outbox(req)
    if (page === 'outbox/send' && req.method === 'POST') return this.#outboxSend(req)
    if (page === 'tenants' && req.method === 'GET' && req.headers.authorization === undefined) return this.#tenants(req)
    if (page === 'tenants/owner' && req.method === 'POST') return this.#ownerSetup(req)
    if (page === 'feedback' && req.method === 'GET' && req.headers.authorization === undefined) return this.#feedback(req)
    if (page === 'errors' && req.method === 'GET' && req.headers.authorization === undefined) return this.#errors(req)
    return undefined
  }

  #loginPage(req: ApiRequest): HttpResult {
    if (this.#csrf.issueCsrf(readCookie(req.headers.cookie, OPERATOR_COOKIE)) !== undefined) {
      return redirect(303, '/admin/outbox')
    }
    return htmlResult(200, renderOperatorLogin())
  }

  #login(req: ApiRequest): HttpResult {
    const credential = new URLSearchParams(req.rawBody ?? '').get('token') ?? ''
    const res = this.#api.handle({
      method: 'POST',
      path: '/admin/sessions',
      headers: credential.length === 0 ? {} : { authorization: `Bearer ${credential}` },
    })
    if (res.status !== 201) return htmlResult(401, renderOperatorLogin(true))
    const session = res.body as { token?: unknown }
    if (typeof session.token !== 'string' || !SAFE_TOKEN.test(session.token)) return ERROR_500
    return redirect(303, '/admin/outbox', {
      'set-cookie': `${OPERATOR_COOKIE}=${session.token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200`,
    })
  }

  #logout(req: ApiRequest): HttpResult {
    const token = readCookie(req.headers.cookie, OPERATOR_COOKIE)
    const form = new URLSearchParams(req.rawBody ?? '')
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return redirect(303, '/admin/login')
    this.#api.handle({ method: 'DELETE', path: '/admin/sessions', headers: { authorization: `Bearer ${token}` } })
    return redirect(303, '/admin/login', {
      'set-cookie': `${OPERATOR_COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`,
    })
  }

  #outbox(req: ApiRequest, status = 200, notice?: 'sent' | 'invalid'): HttpResult {
    const token = readCookie(req.headers.cookie, OPERATOR_COOKIE)
    // `?tenant=<tenant id>` narrows to one workspace (an id-shaped value only; anything else shows every tenant).
    const tenant = queryParam(req.path, 'tenant')
    const tenantId = tenant !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(tenant) ? tenant : undefined
    const res = this.#api.handle({
      method: 'GET',
      path: tenantId === undefined ? '/admin/outbox' : `/admin/outbox?tenant=${tenantId}`,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    })
    if (res.status === 401) return redirect(303, '/admin/login')
    if (res.status !== 200) return ERROR_500
    const csrf = this.#csrf.issueCsrf(token)
    if (csrf === undefined) return redirect(303, '/admin/login')
    const messages = (res.body as { messages?: OutboxMessage[] }).messages ?? []
    const shown = notice ?? (queryParam(req.path, 'sent') === '1' ? 'sent' : undefined)
    return htmlResult(status, renderOutbox(messages, csrf, shown, tenantId))
  }

  #feedback(req: ApiRequest): HttpResult {
    const token = readCookie(req.headers.cookie, OPERATOR_COOKIE)
    const res = this.#api.handle({
      method: 'GET',
      path: '/admin/feedback',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    })
    if (res.status === 401) return redirect(303, '/admin/login')
    if (res.status !== 200) return ERROR_500
    const csrf = this.#csrf.issueCsrf(token)
    if (csrf === undefined) return redirect(303, '/admin/login')
    return htmlResult(200, renderFeedbackList((res.body as { feedback?: FeedbackSubmission[] }).feedback ?? [], csrf))
  }

  #errors(req: ApiRequest): HttpResult {
    const token = readCookie(req.headers.cookie, OPERATOR_COOKIE)
    const res = this.#api.handle({
      method: 'GET',
      path: '/admin/errors',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    })
    if (res.status === 401) return redirect(303, '/admin/login')
    if (res.status !== 200) return ERROR_500
    const csrf = this.#csrf.issueCsrf(token)
    if (csrf === undefined) return redirect(303, '/admin/login')
    return htmlResult(200, renderErrors((res.body as { errors?: ServerError[] }).errors ?? [], csrf))
  }

  #tenants(req: ApiRequest): HttpResult {
    const token = readCookie(req.headers.cookie, OPERATOR_COOKIE)
    const res = this.#api.handle({
      method: 'GET',
      path: '/admin/tenants',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    })
    if (res.status === 401) return redirect(303, '/admin/login')
    if (res.status !== 200) return ERROR_500
    const csrf = this.#csrf.issueCsrf(token)
    if (csrf === undefined) return redirect(303, '/admin/login')
    const tenants = (res.body as { tenants?: Tenant[] }).tenants ?? []
    const raw = queryParam(req.path, 'notice')
    const notice = TENANTS_NOTICE_VALUES.find((value) => value === raw)
    return htmlResult(200, renderTenants(tenants, csrf, notice))
  }

  #ownerSetup(req: ApiRequest): HttpResult {
    const token = readCookie(req.headers.cookie, OPERATOR_COOKIE)
    const form = new URLSearchParams(req.rawBody ?? '')
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return redirect(303, '/admin/login')
    const tenantId = form.get('tenant_id') ?? ''
    const res = this.#api.handle({
      method: 'POST',
      path: `/admin/tenants/${encodeURIComponent(tenantId)}/owner`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      rawBody: JSON.stringify({ email: form.get('email') ?? '' }),
    })
    const notice: TenantsNotice =
      res.status === 201
        ? 'owner_sent'
        : res.status === 409
          ? 'owner_conflict'
          : res.status === 404
            ? 'owner_inactive'
            : 'owner_invalid'
    return redirect(303, `/admin/tenants?notice=${notice}`)
  }

  #outboxSend(req: ApiRequest): HttpResult {
    const token = readCookie(req.headers.cookie, OPERATOR_COOKIE)
    const form = new URLSearchParams(req.rawBody ?? '')
    if (!this.#csrf.verifyCsrf(token, form.get('_csrf') ?? undefined)) return redirect(303, '/admin/login')
    const res = this.#api.handle({
      method: 'POST',
      path: '/admin/outbox',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      rawBody: JSON.stringify({ to: form.get('to') ?? '' }),
    })
    if (res.status === 201) return redirect(303, '/admin/outbox?sent=1')
    return this.#outbox({ ...req, method: 'GET', path: '/admin/outbox' }, 400, 'invalid')
  }
}

const TENANTS_NOTICE_VALUES: readonly TenantsNotice[] = ['owner_sent', 'owner_invalid', 'owner_conflict', 'owner_inactive']

/** Extract a single query parameter value from a path, or undefined. */
function queryParam(path: string, name: string): string | undefined {
  const q = path.indexOf('?')
  if (q === -1) return undefined
  const value = new URLSearchParams(path.slice(q + 1)).get(name)
  return value === null ? undefined : value
}
