import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type ApiRequest,
  type ApiResponse,
  attachmentDisposition,
  composeProductSurface,
  DOCUMENT_UPLOAD_MAX_BODY_BYTES,
  type HttpResult,
  MAX_BODY_BYTES,
} from '@wedding-planner/product'

/**
 * Issue #48 through the surface: the documents page, the multipart upload (CSRF first), the download's headers, what
 * the couple may have, the masked not-found, and the body limit the edge applies before reading an upload.
 */

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
const BOUNDARY = '----FormBoundaryDocs48'

function setup() {
  const clock = new ManualClock('2028-01-10T12:00:00.000Z')
  const s = composeProductSurface({
    clock,
    ids: new SequentialIdGenerator('wd'),
    operatorToken: 'wd-operator-token-0123456789',
    providerWebhookToken: 'wd-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const api = (method: string, path: string, token?: string, body?: unknown): ApiResponse =>
    s.api.handle({ method, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, rawBody: body === undefined ? undefined : JSON.stringify(body) } as ApiRequest)
  const login = (fields: Record<string, string>): string => {
    const res = s.ui.handle(form('/t/demo/login', fields))
    return `wp_session=${/wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]}`
  }
  const ours = s.demo?.weddingId as string
  const bearer = (api('POST', '/t/demo/sessions', undefined, { role: 'planner' }).body as { token: string }).token
  const theirs = (api('POST', '/t/demo/weddings', bearer, { couple_display_name: 'Sam & Kit', event_date: '2028-07-10' }).body as { wedding: { wedding_id: string } }).wedding.wedding_id
  return { ...s, clock, api, login, ours, theirs, bearer }
}

const get = (path: string, cookie?: string): ApiRequest => ({ method: 'GET', path, headers: cookie === undefined ? {} : { cookie } })
function form(path: string, fields: Record<string, string>, cookie?: string): ApiRequest {
  return { method: 'POST', path, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) }, rawBody: new URLSearchParams(fields).toString() }
}
/** A browser's multipart upload: the fields, then the file. */
function upload(fields: Record<string, string>, file: { name: string; bytes: Buffer } | undefined, cookie: string): ApiRequest {
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  if (file !== undefined) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/html\r\n\r\n`), file.bytes, Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  const bytes = Buffer.concat(chunks)
  return { method: 'POST', path: '/t/demo/documents/upload', headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, cookie }, rawBody: bytes.toString('utf8'), bodyBytes: bytes }
}
const csrfOf = (page: HttpResult): string => /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string
const documentIds = (page: HttpResult): string[] => [...page.body.matchAll(/doc=(doc_[A-Za-z0-9_]+)/g)].map((m) => m[1] as string)

describe('documents', () => {
  it('the planner uploads through the form; the file downloads as an attachment with safe headers', () => {
    const w = setup()
    const planner = w.login({ role: 'planner' })
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=documents`, planner))
    expect(page.status).toBe(200)
    expect(page.body).toContain('enctype="multipart/form-data"')
    const csrf = csrfOf(page)
    const res = w.ui.handle(upload({ _csrf: csrf, wedding_id: w.ours, title: 'Hall "final" contract', kind: 'contract', shared_with_couple: 'true' }, { name: 'contract.pdf', bytes: PDF }, planner))
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe(`/t/demo?wedding=${w.ours}&tab=documents&notice=uploaded`)
    const listed = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=documents&notice=uploaded`, planner))
    expect(listed.body).toContain('Uploaded.')
    expect(listed.body).toContain('Hall &quot;final&quot; contract')
    const [id] = documentIds(listed)
    const file = w.ui.handle(get(`/t/demo/documents/download?wedding=${w.ours}&doc=${id}`, planner))
    expect(file.status).toBe(200)
    expect(Buffer.from(file.bytes ?? []).equals(PDF)).toBe(true)
    expect(file.headers).toEqual({
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="Hall _final_ contract.pdf"; filename*=UTF-8''Hall%20%22final%22%20contract.pdf`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
    })
  })

  it('CSRF first: a forged or malformed upload stores nothing; a file that is not what its name says is refused', () => {
    const w = setup()
    const planner = w.login({ role: 'planner' })
    const csrf = csrfOf(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=documents`, planner)))
    const fields = { wedding_id: w.ours, title: 'T', kind: 'other' }
    expect(w.ui.handle(upload({ ...fields, _csrf: 'forged' }, { name: 'a.pdf', bytes: PDF }, planner)).status).toBe(403)
    expect(w.ui.handle({ ...upload({ ...fields, _csrf: csrf }, { name: 'a.pdf', bytes: PDF }, planner), headers: { 'content-type': 'multipart/form-data', cookie: planner } }).status).toBe(403)
    expect(w.ui.handle(form('/t/demo/documents/upload', { ...fields, _csrf: csrf }, planner)).status).toBe(403)
    const html = Buffer.from('<html><script>alert(1)</script></html>')
    expect(w.ui.handle(upload({ ...fields, _csrf: csrf }, { name: 'a.pdf', bytes: html }, planner)).headers.location).toContain('notice=unsupported')
    expect(w.ui.handle(upload({ ...fields, _csrf: csrf }, undefined, planner)).headers.location).toContain('notice=invalid')
    expect(w.ui.handle(upload({ ...fields, _csrf: csrf }, { name: 'big.pdf', bytes: Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]) }, planner)).headers.location).toContain('notice=too_large')
    expect((w.api('GET', `/t/demo/weddings/${w.ours}/documents`, w.bearer).body as { documents: unknown[] }).documents).toEqual([])
  })

  it('the couple downloads only what is shared and manages nothing; another wedding is the masked not-found', () => {
    const w = setup()
    const pdf = PDF.toString('base64')
    const add = (title: string, shared: boolean) =>
      (w.api('POST', `/t/demo/weddings/${w.ours}/documents`, w.bearer, { title, kind: 'quote', filename: 'q.pdf', content_base64: pdf, shared_with_couple: shared }).body as { document: { document_id: string } }).document.document_id
    const shared = add('Shared quote', true)
    const unshared = add('Private quote', false)
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    const page = w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=documents`, couple))
    expect(page.body).toContain('Shared quote')
    expect(page.body).not.toContain('Private quote')
    expect(page.body).not.toContain('enctype="multipart/form-data"')
    expect(w.ui.handle(get(`/t/demo/documents/download?wedding=${w.ours}&doc=${shared}`, couple)).status).toBe(200)
    const unknown = w.ui.handle(get(`/t/demo/documents/download?wedding=${w.ours}&doc=doc_nope`, couple))
    expect(unknown.status).toBe(404)
    const hidden = w.ui.handle(get(`/t/demo/documents/download?wedding=${w.ours}&doc=${unshared}`, couple))
    expect([hidden.status, hidden.body]).toEqual([unknown.status, unknown.body])
    expect(w.ui.handle(get(`/t/demo/documents/download?wedding=${w.theirs}&doc=${shared}`, couple)).status).toBe(404)
    expect(w.ui.handle(get(`/t/demo/documents/download?wedding=${w.ours}`, couple)).status).toBe(404)
    // Signed out: the download is not served.
    expect(w.ui.handle(get(`/t/demo/documents/download?wedding=${w.ours}&doc=${shared}`)).bytes).toBeUndefined()
    // The couple's forms are refused by the JSON route.
    // (The couple's documents page has no forms; any page's token is the session's.)
    const csrf = csrfOf(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=site`, couple)))
    const removed = w.ui.handle(form('/t/demo/documents/doc-remove', { _csrf: csrf, wedding_id: w.ours, document_id: shared }, couple))
    expect(removed.headers.location).toContain('notice=forbidden')
    // The planner shares it; now the couple has it.
    const planner = w.login({ role: 'planner' })
    const pcsrf = csrfOf(w.ui.handle(get(`/t/demo?wedding=${w.ours}&tab=documents&doc=${unshared}`, planner)))
    const saved = w.ui.handle(form('/t/demo/documents/doc-save', { _csrf: pcsrf, wedding_id: w.ours, document_id: unshared, title: 'Quote v2', kind: 'quote', shared_with_couple: 'true' }, planner))
    expect(saved.headers.location).toContain('notice=saved')
    expect(w.ui.handle(get(`/t/demo/documents/download?wedding=${w.ours}&doc=${unshared}`, couple)).headers['content-disposition']).toContain('Quote v2.pdf')
    expect(w.ui.handle(form('/t/demo/documents/doc-remove', { _csrf: pcsrf, wedding_id: w.ours, document_id: unshared }, planner)).headers.location).toContain('notice=removed')
    expect(w.ui.handle(get(`/t/demo/documents/download?wedding=${w.ours}&doc=${unshared}`, planner)).status).toBe(404)
  })

  it("the larger body limit is only for the upload form, with a live planner session of the slug's workspace", () => {
    const w = setup()
    const planner = w.login({ role: 'planner' })
    const couple = w.login({ role: 'couple', wedding_id: w.ours })
    // Another workspace: the demo planner's session is not its planner.
    expect(w.api('POST', '/admin/tenants', 'wd-operator-token-0123456789', { slug: 'acme', display_name: 'Acme', plan_tier: 'solo', theme: { brand_name: 'A', primary_color_hex: '#123456', accent_color_hex: '#654321', logo_ref: 'l' } }).status).toBe(201)
    const upload = '/t/demo/documents/upload'
    expect(w.ui.bodyLimit('POST', upload, { cookie: planner })).toBe(DOCUMENT_UPLOAD_MAX_BODY_BYTES)
    for (const [method, path, headers] of [
      ['POST', upload, {}],
      ['POST', upload, { cookie: couple }],
      ['POST', upload, { cookie: 'wp_session=made-up-token' }],
      ['POST', upload, { authorization: `Bearer ${w.bearer}` }],
      ['POST', '/t/acme/documents/upload', { cookie: planner }],
      ['POST', '/t/BAD_SLUG/documents/upload', { cookie: planner }],
      ['POST', `/t/demo/weddings/${w.ours}/documents`, { authorization: `Bearer ${w.bearer}` }],
      ['PUT', upload, { cookie: planner }],
      ['POST', '/t/demo/guests/create', { cookie: planner }],
    ] as const) {
      expect(w.ui.bodyLimit(method, path, headers)).toBe(MAX_BODY_BYTES)
    }
    // Signed out, the session's limit goes with it.
    const csrf = csrfOf(w.ui.handle(get('/t/demo', planner)))
    w.ui.handle(form('/t/demo/logout', { _csrf: csrf }, planner))
    expect(w.ui.bodyLimit('POST', upload, { cookie: planner })).toBe(MAX_BODY_BYTES)
  })

  it('a download is refused, before anything is read, while the large-response budget is full; downloads per session are limited', () => {
    const w = setup()
    const id = (w.api('POST', `/t/demo/weddings/${w.ours}/documents`, w.bearer, { title: 'T', kind: 'other', filename: 't.pdf', content_base64: PDF.toString('base64') }).body as { document: { document_id: string } }).document.document_id
    const planner = w.login({ role: 'planner' })
    const path = `/t/demo/documents/download?wedding=${w.ours}&doc=${id}`
    const release = w.ui.transfers.hold(w.ui.transfers.limits.in_flight_bytes)
    const busy = w.ui.handle(get(path, planner))
    expect([busy.status, busy.headers['retry-after'], busy.bytes]).toEqual([503, '5', undefined])
    release?.()
    expect(w.ui.handle(get(path, planner)).status).toBe(200)
    for (let i = 1; i < 60; i++) w.ui.handle(get(path, planner))
    const limited = w.ui.handle(get(path, planner))
    expect([limited.status, limited.headers['retry-after']]).toEqual([429, '60'])
    // Another session has its own allowance.
    expect(w.ui.handle(get(path, w.login({ role: 'planner' }))).status).toBe(200)
  })

  it('the download name keeps the header safe whatever the title holds', () => {
    expect(attachmentDisposition('Plan; v2\r\nX: y.pdf')).toBe(`attachment; filename="Plan_ v2__X_ y.pdf"; filename*=UTF-8''Plan%3B%20v2%0D%0AX%3A%20y.pdf`)
    expect(attachmentDisposition("Ma'am (draft)*.png")).toBe(`attachment; filename="Ma_am (draft)_.png"; filename*=UTF-8''Ma%27am%20%28draft%29%2A.png`)
    expect(attachmentDisposition('Café.pdf')).toBe(`attachment; filename="Caf_.pdf"; filename*=UTF-8''Caf%C3%A9.pdf`)
    // A lone surrogate (refused in titles anyway) cannot make the header throw.
    expect(attachmentDisposition('a\uD800.pdf')).toBe(`attachment; filename="a_.pdf"; filename*=UTF-8''a%EF%BF%BD.pdf`)
  })
})
