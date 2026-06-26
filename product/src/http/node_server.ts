import http from 'node:http'

import type { ApiRequest } from './api_message'
import type { ProductApi } from './product_api'

/**
 * @canonical product_api_server -- the thin Node `http` socket adapter for the pure handler.
 *
 * This is the ONLY code in the product surface that touches sockets. It does three mechanical things
 * and no policy: (1) read the request body, (2) build an {@link ApiRequest} (lowercased headers, raw
 * body string), (3) hand it to `ProductApi.handle` and write the returned `ApiResponse` as JSON. All
 * routing, tenant resolution, auth, and authorization live in the pure handler (`product_api.ts`),
 * which is why the keystone can prove the boundary against `handle()` without a socket.
 *
 * A request body larger than {@link MAX_BODY_BYTES} is rejected with `413` before buffering completes
 * (a minimal offline DoS guard; real limits/timeouts are a hardening concern for going-live, which is
 * human-reserved). The adapter never throws to the socket: any internal slip yields a constant `500`.
 *
 * related: product_api.ts (the pure handler), api_message.ts (the value types).
 */

/** Offline body cap — large enough for any wedding/login payload, small enough to bound buffering. */
export const MAX_BODY_BYTES = 1024 * 1024

const JSON_HEADERS = { 'content-type': 'application/json' } as const

/** Build an `http.Server` that serves the given pure handler. Caller owns `listen`/`close`. */
export function createProductApiServer(api: ProductApi): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false

    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        aborted = true
        writeJson(res, 413, { error: 'payload_too_large' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (aborted) return
      try {
        const rawBody = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString('utf8')
        const apiReq: ApiRequest = {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          headers: lowercaseHeaders(req.headers),
          rawBody,
        }
        const response = api.handle(apiReq)
        writeJson(res, response.status, response.body)
      } catch {
        // The pure handler never throws, but the adapter stays fail-closed regardless.
        writeJson(res, 500, { error: 'internal_error' })
      }
    })

    req.on('error', () => {
      if (!aborted) writeJson(res, 400, { error: 'bad_request' })
    })
  })
}

/** Normalize incoming headers to a lowercased single-value map (Node lowercases keys; we coalesce arrays). */
function lowercaseHeaders(headers: http.IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value
  }
  return out
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}
