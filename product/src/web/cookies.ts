/**
 * @canonical web_cookies -- reading a named cookie from a Cookie header (the web edge's one cookie parser).
 *
 * Returns the trimmed value of the FIRST pair named `name`, or `undefined` when the header is absent, the cookie
 * is missing, or its value is empty. No decoding: the server only ever sets opaque `[A-Za-z0-9_-]` token values.
 *
 * related: product_web_ui.ts (`wp_session`), operator_console.ts (`wp_operator`).
 */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined) return undefined
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() === name) {
      const value = pair.slice(eq + 1).trim()
      return value.length === 0 ? undefined : value
    }
  }
  return undefined
}
