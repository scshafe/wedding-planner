/**
 * @canonical multipart_form -- a bounded `multipart/form-data` parser for the one browser form that sends a file (the
 * document upload, issue #48, ADR 0056).
 *
 * The body is already capped by the edge (the upload route's body limit); this parser bounds everything else and does
 * one forward pass with `Buffer.indexOf`, so its work is linear in the body:
 *   - the boundary is RFC 2046's (1–70 characters of its alphabet), taken from the `content-type` header;
 *   - at most {@link MULTIPART_LIMITS}`.parts` parts, each with a header block of at most `header_bytes`;
 *   - a text field's value is at most `field_bytes`, decoded as UTF-8; the first value of a name wins;
 *   - at most one part carries a file (a `filename` in its Content-Disposition); its bytes are a view of the body, not
 *     a copy.
 * Anything malformed — no boundary, a missing delimiter, an unterminated header block, too many parts, a second file —
 * is `undefined`: the caller answers with one constant refusal, so a parse failure says nothing else.
 *
 * The file part's declared Content-Type is ignored: what a file is gets decided from its bytes (document_service.ts).
 *
 * related: product_web_ui.ts (the upload form handler), document_service.ts (what is done with the file).
 */

/** The parser's bounds. */
export const MULTIPART_LIMITS = Object.freeze({ parts: 12, header_bytes: 1024, field_bytes: 4096 })

export interface MultipartFile {
  /** The form field's name. */
  readonly field: string
  /** The file name the browser sent (may be empty when no file was chosen). */
  readonly filename: string
  readonly bytes: Uint8Array
}

export interface MultipartForm {
  readonly fields: ReadonlyMap<string, string>
  readonly file?: MultipartFile
}

const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/
const CRLF = Buffer.from('\r\n')
const HEADER_END = Buffer.from('\r\n\r\n')

/** The boundary of a `multipart/form-data` content type, or `undefined`. */
export function multipartBoundary(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined
  const [type, ...params] = contentType.split(';')
  if (type?.trim().toLowerCase() !== 'multipart/form-data') return undefined
  for (const param of params) {
    const eq = param.indexOf('=')
    if (eq < 0 || param.slice(0, eq).trim().toLowerCase() !== 'boundary') continue
    let value = param.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    return BOUNDARY.test(value) ? value : undefined
  }
  return undefined
}

/** Parse a multipart body (see the module docstring for its bounds), or `undefined` when it is malformed. */
export function parseMultipartForm(body: Uint8Array, contentType: string | undefined): MultipartForm | undefined {
  const boundary = multipartBoundary(contentType)
  if (boundary === undefined) return undefined
  const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  const delimiter = Buffer.from(`--${boundary}`)
  // Every delimiter after the first follows a CRLF; searching for CRLF + delimiter keeps a boundary-like run inside a
  // file from ending its part early unless it really is the next delimiter.
  const next = Buffer.from(`\r\n--${boundary}`)
  if (buffer.indexOf(delimiter) !== 0) return undefined
  const fields = new Map<string, string>()
  let file: MultipartFile | undefined
  let position = delimiter.length
  for (let parts = 0; ; parts++) {
    // After a delimiter: `--` ends the body; otherwise CRLF and a part follow.
    if (buffer[position] === 0x2d && buffer[position + 1] === 0x2d) break
    if (parts >= MULTIPART_LIMITS.parts || !startsWith(buffer, CRLF, position)) return undefined
    const headerStart = position + CRLF.length
    const headerEnd = buffer.subarray(headerStart, headerStart + MULTIPART_LIMITS.header_bytes + HEADER_END.length).indexOf(HEADER_END)
    if (headerEnd < 0) return undefined
    const headers = buffer.subarray(headerStart, headerStart + headerEnd).toString('utf8')
    const contentStart = headerStart + headerEnd + HEADER_END.length
    const contentEnd = buffer.indexOf(next, contentStart)
    if (contentEnd < 0) return undefined
    const disposition = contentDisposition(headers)
    if (disposition === undefined) return undefined
    const content = buffer.subarray(contentStart, contentEnd)
    if (disposition.filename !== undefined) {
      if (file !== undefined) return undefined
      file = { field: disposition.name, filename: disposition.filename, bytes: content }
    } else {
      if (content.length > MULTIPART_LIMITS.field_bytes) return undefined
      if (!fields.has(disposition.name)) fields.set(disposition.name, content.toString('utf8'))
    }
    position = contentEnd + next.length
  }
  return file === undefined ? { fields } : { fields, file }
}

function startsWith(buffer: Buffer, prefix: Buffer, at: number): boolean {
  return buffer.length >= at + prefix.length && buffer.subarray(at, at + prefix.length).equals(prefix)
}

/**
 * The `name` (and `filename`) of a part's `Content-Disposition: form-data` header, or `undefined`. Browsers quote both
 * and percent-encode a `"`, CR or LF inside them (the HTML standard), so a quoted string without escapes is enough.
 */
function contentDisposition(headers: string): { readonly name: string; readonly filename?: string } | undefined {
  const line = headers.split('\r\n').find((h) => h.toLowerCase().startsWith('content-disposition:'))
  if (line === undefined) return undefined
  const value = line.slice('content-disposition:'.length)
  if (!/^\s*form-data\s*(;|$)/i.test(value)) return undefined
  const name = /;\s*name="([^"]*)"/i.exec(value)?.[1]
  if (name === undefined || name.length === 0) return undefined
  const filename = /;\s*filename="([^"]*)"/i.exec(value)?.[1]
  return filename === undefined ? { name } : { name, filename }
}
